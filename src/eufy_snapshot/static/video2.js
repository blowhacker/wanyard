// ═══════════════════════════════════════════════════════
// V2Player — transparent, segment-aware, async seek
// ═══════════════════════════════════════════════════════
class V2Player {
  #v;
  #segs = [];
  #abort = null;
  #activeSeg = null;
  #lastSeek = null;
  #rate = 1;
  #intendedTs = null;  // display target while async seek/load is in flight
  #listeners = { timeupdate: new Set(), play: new Set(), pause: new Set(), ended: new Set() };

  constructor(videoEl) {
    this.#v = videoEl;
    this.#v.addEventListener("timeupdate", () => this.#emit("timeupdate"));
    this.#v.addEventListener("play",       () => this.#emit("play"));
    this.#v.addEventListener("pause",      () => this.#emit("pause"));
    this.#v.addEventListener("ended",      () => this.#emit("ended"));
  }

  setSegments(segs) {
    this.#segs = [...segs].sort((a, b) => a.start_ts - b.start_ts);
    if (this.#activeSeg) {
      this.#activeSeg = this.#segs.find(s => s.id === this.#activeSeg.id) ?? this.#activeSeg;
    }
  }

  // ── Seek ──────────────────────────────────────────────
  // direction: "backward" | "forward" | null — hints gap resolution
  async seek(unix_ts, srcId = null, direction = null) {
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    const segDirect = this.#segFor(unix_ts, srcId);
    const seg = segDirect ?? this.#resolve(unix_ts, srcId, direction);
    if (!seg) {
      if (this.#abort?.signal === signal) this.#intendedTs = null;
      return null;
    }

    // Clamp offset to within segment duration — prevents snapping past end
    const maxOff = seg.end_ts ? Math.max(0, seg.end_ts - seg.start_ts - 0.5) : Infinity;
    const offset = Math.max(0, Math.min(unix_ts - seg.start_ts, maxOff));
    const url    = `/video/files/${seg.path}`;
    const actualTs = seg.start_ts + offset;
    const landing = {
      requestedTs: unix_ts,
      actualTs,
      offsetSecs: offset,
      remainingSecs: seg.end_ts == null ? Infinity : Math.max(0, seg.end_ts - actualTs),
      reason: segDirect ? "direct" : (direction ? `gap-${direction}` : "gap-nearest"),
      sourceId: seg.source_id,
      segmentId: seg.id,
      segment: seg,
    };

    this.#intendedTs = actualTs;

    try {
      if (this.#v.dataset.src !== url) {
        this.#v.src         = url;
        this.#v.dataset.src = url;
        this.#applyRate();
        this.#v.load();
        await this.#waitFor("loadedmetadata", signal);
        this.#applyRate();
      }

      if (signal.aborted) return null;

      this.#activeSeg = seg;
      if (Math.abs((this.#v.currentTime || 0) - offset) > 0.05) {
        const seeked = this.#waitFor("seeked", signal);
        this.#v.currentTime = offset;
        await seeked;
      } else {
        this.#v.currentTime = offset;
      }
    } catch {
      if (this.#abort?.signal === signal && this.#intendedTs === actualTs) this.#intendedTs = null;
      return null;
    }

    if (signal.aborted) return null;
    if (this.#intendedTs === actualTs) this.#intendedTs = null;
    this.#lastSeek = landing;
    this.#emit("timeupdate");
    return landing;
  }

  // ── Playback ──────────────────────────────────────────
  play()         { this.#applyRate(); return this.#v.play().catch(() => {}); }
  pause()        { this.#v.pause(); }
  setRate(rate)  { this.#rate = rate; this.#applyRate(); }
  get ended()    { return this.#v.ended; }
  // nextSegment: for app to call when 'ended' fires
  nextSegment(srcId) {
    const cur = this.currentSeg;
    if (!cur) return null;
    const src = srcId ?? cur.source_id;
    return this.#segs
      .filter(s => s.end_ts != null && s.source_id === src && s.start_ts >= (cur.end_ts ?? cur.start_ts))
      .sort((a, b) => a.start_ts - b.start_ts)[0] ?? null;
  }
  get paused()      { return this.#v.paused; }
  get intendedTs()  { return this.#intendedTs; }
  get displayTs()   { return this.#intendedTs ?? this.currentTs; }
  /** Backwards-compatible alias for the UI's display clock. */
  get reliableTs()  { return this.displayTs; }
  get mediaTs()     { return this.currentTs; }
  get lastSeek()    { return this.#lastSeek; }
  get duration() { return this.#v.duration || 0; }
  get remainingSecs() {
    if (this.#v.ended) return 0;
    const seg = this.currentSeg, ts = this.currentTs;
    if (!seg || seg.end_ts == null || ts == null) return null;
    return Math.max(0, seg.end_ts - ts);
  }
  get nearSegmentEnd() {
    const rem = this.remainingSecs;
    return this.#v.ended || (rem != null && rem <= 1.25);
  }

  // ── Current timestamp ─────────────────────────────────
  get currentTs() {
    return this.#activeSeg ? this.#activeSeg.start_ts + this.#v.currentTime : null;
  }

  get currentSeg() {
    return this.#activeSeg;
  }

  // ── Clip playlist — returns PlaylistHandle ────────────
  playClips(clips, startIdx = 0) {
    const handle = new PlaylistHandle(this, clips, startIdx);
    handle._start();
    return handle;
  }

  // ── Events ────────────────────────────────────────────
  on(event, fn)  { this.#listeners[event]?.add(fn); }
  off(event, fn) { this.#listeners[event]?.delete(fn); }
  #emit(event)   { this.#listeners[event]?.forEach(fn => fn()); }

  #applyRate() {
    this.#v.defaultPlaybackRate = this.#rate;
    this.#v.playbackRate = this.#rate;
  }

  // ── Private helpers ───────────────────────────────────
  #segFor(ts, srcId) {
    // Only closed segments (end_ts set) are playable; open files lack moov atom
    const pool = (srcId ? this.#segs.filter(s => s.source_id === srcId) : this.#segs)
      .filter(s => s.end_ts != null);
    return pool.find(s => s.start_ts <= ts && s.end_ts > ts) ?? null;
  }

  #resolve(ts, srcId, direction) {
    const pool = (srcId ? this.#segs.filter(s => s.source_id === srcId) : this.#segs)
      .filter(s => s.end_ts != null);
    if (!pool.length) return null;
    if (direction === "backward")
      // Latest segment ending at or before ts
      return pool.filter(s => s.end_ts <= ts).sort((a, b) => b.end_ts - a.end_ts)[0] ?? null;
    if (direction === "forward")
      // Earliest segment starting at or after ts
      return pool.filter(s => s.start_ts >= ts).sort((a, b) => a.start_ts - b.start_ts)[0] ?? null;
    // No direction hint: nearest edge
    const dist = s => Math.max(0, s.start_ts - ts, ts - s.end_ts);
    return pool.reduce((best, s) => !best || dist(s) < dist(best) ? s : best, null);
  }

  #waitFor(event, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException("aborted")); return; }
      const onEvent = () => { signal.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => { this.#v.removeEventListener(event, onEvent); reject(new DOMException("aborted")); };
      this.#v.addEventListener(event, onEvent, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ═══════════════════════════════════════════════════════
// PlaylistHandle — caller-owned clip sequence
// ═══════════════════════════════════════════════════════
class PlaylistHandle {
  #player;
  #clips;   // [[start_ts, end_ts], ...]
  #idx = 0;
  #active = false;
  #check;
  onEnd = null;

  constructor(player, clips, startIdx = 0) {
    this.#player = player;
    this.#clips  = clips;
    this.#idx    = Math.max(0, Math.min(clips.length - 1, startIdx));
    this.#check  = () => this.#watchEnd();
  }

  _start() {
    if (this.#active) return;
    if (this.#idx >= this.#clips.length) this.#idx = 0;
    this.#active = true;
    this.#player.on("timeupdate", this.#check);
    this.#player.on("ended",      this.#check); // catch segment file end
    this.#seekCurrent();
  }

  async #seekCurrent() {
    if (!this.#active || this.#idx >= this.#clips.length) return;
    const [start] = this.#clips[this.#idx];
    const landing = await this.#player.seek(start);
    if (!this.#active) return;  // cancelled during seek
    if (!landing) return;
    this.#player.play();
  }

  #watchEnd() {
    if (!this.#active) return;
    const [start, end] = this.#clips[this.#idx] ?? [];
    const ts = this.#player.currentTs;
    if (end != null && ts != null && ts >= end) { this.#advance(); return; }

    if (this.#player.ended && end != null) {
      const next = this.#player.nextSegment();
      if (next && next.start_ts < end) {
        this.#player.seek(Math.max(next.start_ts, start), next.source_id, "forward")
          .then(landing => { if (this.#active && landing) this.#player.play(); });
      } else {
        this.#advance();
      }
    }
  }

  #advance() {
    this.#idx++;
    if (this.#idx < this.#clips.length) {
      this.#seekCurrent();
    } else {
      this.cancel();
      this.onEnd?.();
    }
  }

  next() { if (this.#active) { this.#idx = Math.min(this.#clips.length - 1, this.#idx + 1); this.#seekCurrent(); } }
  prev() { if (this.#active) { this.#idx = Math.max(0, this.#idx - 1); this.#seekCurrent(); } }
  get clipIdx()   { return this.#idx; }
  get clipCount() { return this.#clips.length; }

  restart() {
    this.cancel();
    this.#idx = 0;
    this._start();
  }

  cancel() {
    this.#active = false;
    this.#player.off("timeupdate", this.#check);
    this.#player.off("ended",      this.#check);
  }
}

// ═══════════════════════════════════════════════════════
// AppMode — explicit state machine, owns PlaylistHandle
// ═══════════════════════════════════════════════════════
class AppMode {
  #player;
  #handle = null;
  #mode = "seek";   // "seek" | "playlist" | "live"
  #op = 0;
  onModeChange = null;

  constructor(player) { this.#player = player; }

  get current() { return this.#mode; }

  seekTo(unix_ts, srcId = null, direction = null, options = {}) {
    this.#cancel();
    this.#mode = "seek";
    this.onModeChange?.("seek");
    const op = ++this.#op;
    const autoplay = options.autoplay !== false;
    this.#player.seek(unix_ts, srcId, direction).then(landing => {
      if (op !== this.#op || !landing) return;
      const shortBackwardGap = landing.reason === "gap-backward" && landing.remainingSecs <= 1.25;
      if (autoplay && !shortBackwardGap) this.#player.play();
    });
  }

  playEventPlaylist(events, loop = true, startIdx = 0) {
    if (!events.length) return;
    this.#cancel();
    this.#mode = "playlist";
    this.onModeChange?.("playlist");
    const POST = 10;
    const clips = events.map(e => [e.abs_ts, e.abs_ts + (e.end_off - e.start_off) + POST]);
    this.#handle = this.#player.playClips(clips, startIdx);
    this.#handle.onEnd = () => {
      if (loop && this.#mode === "playlist") this.#handle.restart();
      else { this.#mode = "seek"; this.onModeChange?.("seek"); }
    };
    return this.#handle;
  }

  goLive(srcId, segments) {
    this.#cancel();
    this.#mode = "live";
    this.onModeChange?.("live");
    const op = ++this.#op;
    const latest = [...segments].sort((a, b) => b.start_ts - a.start_ts)
      .find(s => (s.source_id === srcId || !srcId) && s.end_ts != null);
    if (latest) this.#player.seek(Math.max(latest.start_ts, latest.end_ts - 1), latest.source_id, "backward")
      .then(landing => { if (op === this.#op && landing) this.#player.play(); });
  }

  enterLive() {
    this.#cancel();
    this.#mode = "live";
    this.onModeChange?.("live");
  }

  stopLive() {
    if (this.#mode !== "live") return;
    this.#op++;
    this.#mode = "seek";
    this.onModeChange?.("seek");
  }

  stop() {
    this.#cancel();
    this.#mode = "seek";
    this.onModeChange?.("seek");
  }

  playFromCurrent(srcId = null) {
    if (this.#mode === "playlist") {
      this.#player.play();
      return;
    }
    const seg = this.#player.currentSeg;
    if (seg && this.#player.nearSegmentEnd) {
      const next = this.#player.nextSegment(srcId ?? seg.source_id);
      if (next) {
        this.seekTo(next.start_ts, next.source_id, "forward");
        return;
      }
      if (this.#player.ended) {
        const dur = (seg.end_ts ?? (seg.start_ts + this.#player.duration)) - seg.start_ts;
        this.seekTo(seg.start_ts + Math.max(0, dur - 30), seg.source_id);
        return;
      }
    }
    this.#player.play();
  }

  handleEnded(srcId = null) {
    if (this.#mode === "playlist") return;
    const seg = this.#player.currentSeg;
    const next = this.#player.nextSegment(srcId ?? seg?.source_id ?? null);
    if (next) this.seekTo(next.start_ts, next.source_id, "forward");
  }

  #cancel() {
    this.#op++;
    this.#handle?.cancel();
    this.#handle = null;
  }

  get handle() { return this.#handle; }
}

// ═══════════════════════════════════════════════════════
// V2Timeline — pure renderer + decode(x,y) helper
// ═══════════════════════════════════════════════════════
const EVENT_COLORS = {
  person:"#2aac6a",bird:"#20c0b0",cat:"#20c0b0",dog:"#20c0b0",
  car:"#c08020",truck:"#c08020",bus:"#c08020",motorcycle:"#c08020",bicycle:"#c08020",
};

class V2Timeline {
  #c; #ctx;
  #segs = []; #evts = []; #srcNames = {};
  #from = 0; #to = 0;
  #head = null;
  #SRC_W = 64;
  #eventsFrom = 0; #eventsTo = 0;

  constructor(canvasEl) {
    this.#c   = canvasEl;
    this.#ctx = canvasEl.getContext("2d");
  }

  setWindow(from, to) { this.#from = from; this.#to = to; this.draw(); }
  setEventsWindow(from, to) { this.#eventsFrom = from; this.#eventsTo = to; this.draw(); }
  setPlayhead(ts)     { this.#head = ts; this.draw(); }
  setSrcNames(map)    { this.#srcNames = map; }

  setData(segs, evts) {
    this.#segs = segs;
    this.#evts = evts;
    this.draw();
  }

  extendBack(hours) {
    this.#from -= hours * 3600;
    this.draw();
    return this.#from;
  }

  // ── Pure decode — returns null or {ts, srcId, snapEvent} ─
  decode(x, y) {
    const W = this.#c.clientWidth, H = this.#c.clientHeight;
    if (x < this.#SRC_W || x > W || y < 0 || y > H - 20) return null;

    const srcIds = this.#uniqueSrcs();
    if (!srcIds.length) return null;

    const LANE_H = Math.floor((H - 20) / srcIds.length);
    const row    = Math.min(srcIds.length - 1, Math.floor(y / LANE_H));
    const srcId  = srcIds[row];
    const ts     = this.#xToTs(x);

    // Snap to nearest event within 8px
    const SNAP = 8;
    let snapEvent = null, best = Infinity;
    for (const e of this.#evts.filter(e => e.source_id === srcId)) {
      const ex   = this.#tsToX(e.abs_ts);
      const dist = Math.abs(ex - x);
      if (dist < SNAP && dist < best) { best = dist; snapEvent = e; }
    }

    return { ts, srcId, snapEvent };
  }

  // ── Renderer ──────────────────────────────────────────
  draw() {
    const c = this.#c, ctx = this.#ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    if (!W || !H) return;

    const srcIds  = this.#uniqueSrcs();
    if (!srcIds.length) return;
    const LABEL_H = 20;
    const LANE_H  = Math.floor((H - LABEL_H) / srcIds.length);

    srcIds.forEach((srcId, row) => {
      const top = row * LANE_H + 2, bot = top + LANE_H - 4, mid = (top + bot) / 2;

      // Source label
      ctx.fillStyle = "rgba(107,122,140,0.9)";
      ctx.font = "9px 'IBM Plex Mono',monospace";
      ctx.textAlign = "right";
      ctx.fillText((this.#srcNames[srcId] || srcId).slice(0, 12), this.#SRC_W - 4, mid + 3);

      // Lane divider
      if (row > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(this.#SRC_W, top - 2, W - this.#SRC_W, 1);
      }

      // Segment bands
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      this.#segs.filter(s => s.source_id === srcId).forEach(s => {
        const x1 = this.#tsToX(s.start_ts), x2 = this.#tsToX(s.end_ts ?? this.#to);
        if (x2 < this.#SRC_W || x1 > W) return;
        ctx.fillRect(Math.max(this.#SRC_W, x1), top, Math.min(W, x2) - Math.max(this.#SRC_W, x1), bot - top);
      });

      // Event dots
      this.#evts.filter(e => e.source_id === srcId).forEach(e => {
        const x = this.#tsToX(e.abs_ts);
        if (x < this.#SRC_W || x > W) return;
        ctx.fillStyle = EVENT_COLORS[e.class] || "#ccd8e4";
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x, mid, 3.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    });

    // Time labels
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(74,94,110,0.9)";
    ctx.font = "9px 'IBM Plex Mono',monospace";
    const interval = this.#labelInterval();
    let t0 = Math.ceil(this.#from / interval) * interval;
    while (t0 <= this.#to) {
      const x = this.#tsToX(t0);
      if (x >= this.#SRC_W && x <= W) {
        ctx.fillText(new Date(t0*1000).toLocaleTimeString(undefined,
          { hour:"2-digit", minute:"2-digit" }), x, H - 5);
        ctx.fillStyle = "rgba(74,94,110,0.12)";
        ctx.fillRect(x, 0, 1, H - 20);
        ctx.fillStyle = "rgba(74,94,110,0.9)";
      }
      t0 += interval;
    }

    // Events-loaded range indicator — thin green line above time labels
    if (this.#eventsFrom < this.#eventsTo) {
      const ex1 = Math.max(this.#SRC_W, this.#tsToX(this.#eventsFrom));
      const ex2 = Math.min(W, this.#tsToX(this.#eventsTo));
      if (ex2 > ex1) {
        ctx.fillStyle = "rgba(42,172,106,0.55)";
        ctx.fillRect(ex1, H - 22, ex2 - ex1, 2);
      }
    }

    // Playhead
    if (this.#head != null) {
      const x = this.#tsToX(this.#head);
      if (x >= this.#SRC_W && x <= W) {
        ctx.fillStyle = "#c08020";
        ctx.fillRect(x - 1, 0, 2, H - 20);
        ctx.beginPath();
        ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,8);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  #tsToX(ts) { return this.#SRC_W + ((ts-this.#from)/(this.#to-this.#from))*(this.#c.clientWidth-this.#SRC_W); }
  #xToTs(x)  { return this.#from + ((x-this.#SRC_W)/(this.#c.clientWidth-this.#SRC_W))*(this.#to-this.#from); }
  #uniqueSrcs() { return [...new Set(this.#segs.map(s => s.source_id))]; }
  #labelInterval() {
    const span = this.#to - this.#from;
    if (span > 20*3600) return 4*3600;
    if (span > 8*3600)  return 2*3600;
    if (span > 3*3600)  return 3600;
    if (span > 90*60)   return 30*60;
    return 15*60;
  }
}

// ═══════════════════════════════════════════════════════
// App — thin wiring layer
// ═══════════════════════════════════════════════════════
const V2_SPEEDS    = [{label:"½×",rate:.5},{label:"1×",rate:1},{label:"2×",rate:2},{label:"4×",rate:4}];
const POST_BUFFER  = 10;
const LIVE_OPEN_MAX_AGE = 3600;

// ── DOM ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  video:   $("v2Video"),
  liveVideo:$("v2LiveVideo"),
  canvas:  $("v2BoxCanvas"),
  tlCanvas:$("v2Timeline"),
  thumb:   $("v2ThumbPreview"),
  empty:   $("v2Empty"),
  hudSrc:  $("v2HudSource"),
  hudTs:   $("v2HudTs"),
  tsDisp:  $("v2Timestamp"),
  srcCtrl: $("v2SourceCtrl"),
  clsField:$("v2ClassField"),
  clsCtrl: $("v2ClassCtrl"),
  nearScope:$("v2NearScope"),
  eventThumbs:$("v2EventThumbs"),
  play:    $("v2Play"),
  prev:    $("v2Prev"),
  next:    $("v2Next"),
  rewind:  $("v2Rewind"),
  speeds:  $("v2Speeds"),
  loop:    $("v2Loop"),
  timeDisp:$("v2TimeDisp"),
  boxes:   $("v2Boxes"),
  status:  $("v2Status"),
  liveBtn: $("v2LiveBtn"),
};

// ── Core instances ────────────────────────────────────
const player   = new V2Player(el.video);
const timeline = new V2Timeline(el.tlCanvas);
const mode     = new AppMode(player);

// ── App state ─────────────────────────────────────────
const st = {
  segments: [],
  events:   [],
  classes:  {},
  sources:  [],
  source:   "all",
  cls:      new Set(),
  window:   { from: 0, to: 0 },
  speed:    parseInt(localStorage.getItem("v2speed") || "1"),
  loop:     true,
  showBoxes:localStorage.getItem("v2boxes") !== "0",
  dets:     {},  // segId → [{ts_offset, boxes, classes}]
  initDone: false,
  classSearchSeq: 0,
};

const liveTail = {
  hls: null,
  active: false,
  srcId: null,
  pollTimer: null,
  clockTimer: null,
  latestDet: null,
};

// ── Derived views ─────────────────────────────────────
// All segments for source — used for timeline bands (always show coverage)
function allSegsForSrc() {
  return st.source === "all" ? st.segments : st.segments.filter(s => s.source_id === st.source);
}

function filteredSegs() {
  let s = st.segments;
  if (st.source !== "all") s = s.filter(x => x.source_id === st.source);
  return s;
}

function filteredEvts() {
  let e = st.events;
  if (st.source !== "all") e = e.filter(x => x.source_id === st.source);
  if (st.cls.size > 0)     e = e.filter(x => st.cls.has(x.class));
  return e;
}

// ── Nearby event widget ───────────────────────────────
const NEAR_EVENT_LIMIT = 10;
const NEAR_EVENT_REFRESH_MS = 1500;

function nearbyClassSet() {
  if (st.cls.size > 0) return new Set(st.cls);
  return new Set(["person"]);
}

function nearbyScopeLabel() {
  const classes = [...nearbyClassSet()];
  return classes.join(", ");
}

function renderNearScope() {
  if (el.nearScope) el.nearScope.textContent = nearbyScopeLabel();
}

function nearestEvents(baseTs) {
  let evts = st.events;
  if (st.source !== "all") evts = evts.filter(e => e.source_id === st.source);
  const classes = nearbyClassSet();
  evts = evts.filter(e => classes.has(e.class));
  return evts
    .map(e => ({ event: e, dist: Math.abs(e.abs_ts - baseTs) }))
    .sort((a, b) => a.dist - b.dist || a.event.abs_ts - b.event.abs_ts)
    .slice(0, NEAR_EVENT_LIMIT)
    .map(x => x.event)
    .sort((a, b) => a.abs_ts - b.abs_ts);  // stable display order — prevents sig churn
}

function classFilteredEvents(classes = st.cls) {
  let evts = st.events;
  if (st.source !== "all") evts = evts.filter(e => e.source_id === st.source);
  if (classes.size > 0) evts = evts.filter(e => classes.has(e.class));
  return evts;
}

function setStatus(text) {
  if (el.status) el.status.textContent = text;
}

function centerWindowOn(ts) {
  const span = st.window.to - st.window.from;
  st.window.from = ts - span * 0.4;
  st.window.to   = ts + span * 0.6;
  timeline.setWindow(st.window.from, st.window.to);
}

async function fetchNearestEvents(classes, around, limit = 20) {
  const p = new URLSearchParams();
  if (st.source !== "all") p.set("source", st.source);
  if (classes.size > 0) p.set("classes", [...classes].join(","));
  p.set("around", Math.floor(around));
  p.set("limit", String(limit));
  const r = await fetch(`/api/video/events?${p}`, { cache:"no-store" });
  if (!r.ok) return [];
  const data = await r.json();
  return data.events || [];
}

function mergeEvents(events) {
  if (!events.length) return;
  const byId = new Map(st.events.map(e => [e.id, e]));
  events.forEach(e => byId.set(e.id, e));
  st.events = [...byId.values()].sort((a, b) => b.abs_ts - a.abs_ts);
}

function replaceProvisionalEvents(events, srcId = null) {
  st.events = st.events.filter(e =>
    !e.provisional || (srcId && e.source_id !== srcId)
  );
  mergeEvents(events);
}

function mergeSegments(segments) {
  if (!segments?.length) return;
  const byId = new Map(st.segments.map(s => [s.id, s]));
  segments.forEach(s => byId.set(s.id, { ...(byId.get(s.id) || {}), ...s }));
  st.segments = [...byId.values()].sort((a, b) => b.start_ts - a.start_ts);
  player.setSegments(st.segments);
}

function mergeClassCounts(events) {
  const counts = {};
  events.forEach(e => { counts[e.class] = (counts[e.class] || 0) + 1; });
  Object.entries(counts).forEach(([cls, n]) => {
    st.classes[cls] = Math.max(st.classes[cls] || 0, n);
  });
}

async function handleClassSelectionChanged(classes) {
  const seq = ++st.classSearchSeq;
  renderClsCtrl();
  renderNearScope();
  timeline.setData(allSegsForSrc(), filteredEvts());
  scheduleNearestEvents(true);

  if (!classes.size) {
    if (!liveTail.active) mode.stop();
    setStatus(liveTail.active ? "LIVE" : "AUTO");
    return;
  }

  const baseTs = player.displayTs ?? Date.now() / 1000;
  let evts = classFilteredEvents(classes);
  if (!evts.length) {
    setStatus("SEARCH");
    evts = await fetchNearestEvents(classes, baseTs, 20);
    if (seq !== st.classSearchSeq) return;
    mergeEvents(evts);
  }

  if (!evts.length) {
    setStatus("NONE");
    setTimeout(() => { if (seq === st.classSearchSeq) setStatus("AUTO"); }, 1800);
    timeline.setData(allSegsForSrc(), filteredEvts());
    scheduleNearestEvents(true);
    return;
  }

  evts = [...evts].sort((a, b) =>
    Math.abs(a.abs_ts - baseTs) - Math.abs(b.abs_ts - baseTs) || a.abs_ts - b.abs_ts
  );
  const target = evts[0];
  if (target.provisional) {
    centerWindowOn(target.abs_ts);
    timeline.setData(allSegsForSrc(), filteredEvts());
    scrollTimelineToTs(target.abs_ts);
    startLiveTail(target.source_id);
    setStatus("LIVE");
    return;
  }

  stopLiveTail(false);
  centerWindowOn(target.abs_ts);
  await load();
  if (seq !== st.classSearchSeq) return;

  const playlist = classFilteredEvents(classes).sort((a, b) => a.abs_ts - b.abs_ts);
  const startIdx = Math.max(0, playlist.findIndex(e => e.id === target.id));
  if (playlist.length) mode.playEventPlaylist(playlist, st.loop, startIdx);
  scrollTimelineToTs(target.abs_ts);
  scheduleNearestEvents(true);
  setStatus("AUTO");
}

function relEventLabel(ts, baseTs) {
  const delta = Math.round(ts - baseTs);
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (abs < 60) return `${sign}${abs}s`;
  if (abs < 3600) return `${sign}${Math.round(abs / 60)}m`;
  return `${sign}${Math.round(abs / 3600)}h`;
}

function eventLocalTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined,
    { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function sourceLabel(srcId) {
  return st.sources.find(s => s.id === srcId)?.name || srcId;
}

function eventSeekTs(evt) {
  const seg = st.segments.find(s => s.id === evt.segment_id);
  const start = seg?.start_ts ?? evt.seg_start_ts ?? evt.abs_ts;
  return Math.max(start, evt.abs_ts - 1);
}

function isEventActive(evt, ts) {
  if (ts == null) return false;
  if (evt.provisional) {
    return liveTail.active && liveTail.srcId === evt.source_id && Math.abs(ts - evt.abs_ts) <= 3;
  }
  if (player.currentSeg?.id !== evt.segment_id) return false;
  const dur = Math.max(1, (evt.end_off ?? 0) - (evt.start_off ?? 0));
  return ts >= evt.abs_ts - 1 && ts <= evt.abs_ts + dur + 1;
}

function renderNearestEvents() {
  if (!el.eventThumbs) return;
  renderNearScope();
  const baseTs = player.displayTs ?? st.events[0]?.abs_ts ?? Date.now() / 1000;
  const evts = nearestEvents(baseTs);
  const scope = nearbyScopeLabel();
  const sig = `${st.source}|${scope}|${evts.map(e => e.id).join(",") || "empty"}`;

  if (!evts.length) {
    if (_nearListSig === sig) return;
    _nearListSig = sig;
    el.eventThumbs.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "v2-event-thumbs-empty";
    empty.textContent = `No ${scope} events`;
    el.eventThumbs.appendChild(empty);
    return;
  }

  if (_nearListSig === sig) {
    _updateThumbNodes(evts, baseTs);
    return;
  }

  _nearListSig = sig;
  _reconcileThumbNodes(evts, baseTs);
}

function _makeThumbNode(evt, baseTs) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "v2-event-thumb"
    + (evt.provisional ? " provisional" : "")
    + (isEventActive(evt, baseTs) ? " active" : "");
  btn.dataset.eventId = String(evt.id);
  btn.title = `${evt.class} ${eventLocalTime(evt.abs_ts)} ${sourceLabel(evt.source_id)}`;
  btn.addEventListener("click", () => {
    if (evt.provisional) {
      startLiveTail(evt.source_id);
      scrollTimelineToTs(evt.abs_ts);
      return;
    }
    stopLiveTail();
    mode.seekTo(eventSeekTs(evt), evt.source_id); pushState();
    scrollTimelineToTs(evt.abs_ts);
  });

  let media;
  if (evt.provisional) {
    media = document.createElement("div");
    media.className = "v2-event-thumb-live";
    media.textContent = "LIVE";
  } else {
    media = document.createElement("img");
    media.loading = "lazy";
    media.alt = "";
    media.src = `/api/video/event-thumb/${evt.id}`;
  }

  const klass = document.createElement("div");
  klass.className = "v2-event-thumb-class";
  klass.textContent = evt.class;

  const meta = document.createElement("div");
  meta.className = "v2-event-thumb-meta";
  const t = document.createElement("span");
  t.textContent = eventLocalTime(evt.abs_ts);
  const d = document.createElement("span");
  d.dataset.nearDist = "1";
  d.textContent = relEventLabel(evt.abs_ts, baseTs);
  meta.append(t, d);

  btn.append(media, klass, meta);
  return btn;
}

function _updateThumbNode(btn, evt, baseTs) {
  btn.classList.toggle("active", isEventActive(evt, baseTs));
  const dist = btn.querySelector("[data-near-dist]");
  const label = relEventLabel(evt.abs_ts, baseTs);
  if (dist && dist.textContent !== label) dist.textContent = label;
}

function _updateThumbNodes(evts, baseTs) {
  const nodes = el.eventThumbs.querySelectorAll(".v2-event-thumb");
  evts.forEach((evt, i) => {
    const btn = nodes[i];
    if (!btn || btn.dataset.eventId !== String(evt.id)) return;
    _updateThumbNode(btn, evt, baseTs);
  });
}

function _reconcileThumbNodes(evts, baseTs) {
  // Keyed reconciliation: reuse existing nodes, freeze hovered node in place
  const existing = new Map(
    [...el.eventThumbs.querySelectorAll(".v2-event-thumb")]
      .map(n => [n.dataset.eventId, n])
  );
  const hoveredId = el.eventThumbs.querySelector(".v2-event-thumb:hover")?.dataset.eventId;
  const newIds = new Set(evts.map(e => String(e.id)));

  // Remove stale nodes — except the hovered one
  for (const [id, node] of existing) {
    if (!newIds.has(id) && id !== hoveredId) node.remove();
  }

  const fragment = document.createDocumentFragment();
  for (const evt of evts) {
    const key = String(evt.id);
    if (key === hoveredId) {
      // Hovered: update labels only, leave it where it is in the DOM
      const node = existing.get(key);
      if (node) _updateThumbNode(node, evt, baseTs);
      continue;
    }
    let btn = existing.get(key);
    if (btn) _updateThumbNode(btn, evt, baseTs);
    else btn = _makeThumbNode(evt, baseTs);
    fragment.appendChild(btn);
  }

  el.eventThumbs.appendChild(fragment);
}

let _nearRenderPending = false;
let _lastNearRender = 0;
let _nearListSig = "";
function scheduleNearestEvents(force = false) {
  const now = performance.now();
  if (!force && now - _lastNearRender < NEAR_EVENT_REFRESH_MS) return;
  _lastNearRender = now;
  if (_nearRenderPending) return;
  _nearRenderPending = true;
  requestAnimationFrame(() => {
    _nearRenderPending = false;
    renderNearestEvents();
  });
}

// ── Data loading ──────────────────────────────────────
const _loadBar = document.getElementById("v2LoadBar");
let _loadCount = 0;
function _loadStart() { _loadCount++; _loadBar?.classList.add("loading"); }
function _loadEnd()   { if (--_loadCount <= 0) { _loadCount = 0; _loadBar?.classList.remove("loading"); } }

async function load() {
  _loadStart();
  const p = new URLSearchParams();
  if (st.source !== "all") p.set("source", st.source);

  const [sr, er, cr] = await Promise.all([
    fetch(`/api/video2/timeline?${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
    fetch(`/api/video/events?limit=10000&since=${Math.floor(st.window.from)}&until=${Math.ceil(st.window.to)}&${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
    fetch(`/api/video/classes?${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
  ]);

  st.segments = sr.segments || [];
  st.events   = er.events   || [];
  st.classes  = cr.classes  || {};
  timeline.setEventsWindow(st.window.from, st.window.to);

  // Keep window right-edge at now+10min so ongoing recordings are reachable
  const nowTs = Date.now() / 1000;
  if (nowTs > st.window.to - 60) {
    st.window.to = nowTs + 600; // 10 min headroom
    timeline.setWindow(st.window.from, st.window.to);
  }

  player.setSegments(st.segments);

  const srcNames = {};
  st.sources.forEach(s => srcNames[s.id] = s.name || s.id);
  timeline.setSrcNames(srcNames);
  timeline.setData(allSegsForSrc(), filteredEvts());

  renderSrcCtrl();
  renderClsCtrl();
  renderNearScope();
  scheduleNearestEvents(true);

  if (!liveTail.active && !st.initDone && st.segments.length) {
    st.initDone = true;
    const latest = st.segments.find(s => s.end_ts != null);
    if (latest) {
      el.empty.style.display = "none";
      el.video.style.display = "block";
      mode.seekTo(Math.max(latest.start_ts, latest.end_ts - 1), latest.source_id, "backward");
    }
  }
  _loadEnd();
}

// ── Source control ────────────────────────────────────
function renderSrcCtrl() {
  el.srcCtrl.innerHTML = "";
  const rtsp = st.sources.filter(s => s.type === "rtsp");
  if (!rtsp.length) return;
  const pills = document.createElement("div"); pills.className = "source-pills";
  [{ id:"all", name:"ALL" }, ...rtsp].forEach(s => {
    const b = document.createElement("button");
    b.className = "source-pill" + (st.source === s.id ? " active" : "");
    b.textContent = s.name || s.id;
    b.addEventListener("click", () => {
      stopLiveTail();
      st.source = s.id; st.initDone = false;
      renderSrcCtrl(); load().then(pushState);
    });
    pills.appendChild(b);
  });
  el.srcCtrl.appendChild(pills);
}

// ── Class filter ──────────────────────────────────────
function renderClsCtrl() {
  el.clsCtrl.innerHTML = "";
  const entries = Object.entries(st.classes).sort((a,b) => b[1]-a[1]);
  if (!entries.length) { el.clsField.hidden = true; return; }
  el.clsField.hidden = false;

  const allBtn = document.createElement("button");
  allBtn.className = "class-chip" + (st.cls.size === 0 ? " active" : "");
  allBtn.textContent = "ALL";
  allBtn.addEventListener("click", () => {
    st.cls.clear();
    handleClassSelectionChanged(new Set());
  });
  el.clsCtrl.appendChild(allBtn);

  entries.forEach(([c, n]) => {
    const b = document.createElement("button");
    b.className = "class-chip" + (st.cls.has(c) ? " active" : "");
    b.textContent = `${c} ×${n}`;
    b.addEventListener("click", () => {
      st.cls.has(c) ? st.cls.delete(c) : st.cls.add(c);
      pushState();
      handleClassSelectionChanged(new Set(st.cls));
    });
    el.clsCtrl.appendChild(b);
  });
}

// ── Timeline interactions ─────────────────────────────
el.tlCanvas.addEventListener("click", e => {
  const rect = el.tlCanvas.getBoundingClientRect();
  const hit  = timeline.decode(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  if (hit.snapEvent) {
    if (hit.snapEvent.provisional) {
      startLiveTail(hit.snapEvent.source_id);
      scrollTimelineToTs(hit.snapEvent.abs_ts);
      return;
    }
    // Snap to exact event timestamp
    stopLiveTail(false);
    mode.seekTo(hit.snapEvent.abs_ts, hit.snapEvent.source_id); pushState();
  } else {
    stopLiveTail(false);
    mode.seekTo(hit.ts, hit.srcId); pushState();
  }
  el.empty.style.display = "none";
  el.video.style.display = "block";
});

// Timeline scroll — shift window, clamp to data bounds
let _fetchDebounce = null;
el.tlCanvas.addEventListener("wheel", e => {
  e.preventDefault();
  const rect     = el.tlCanvas.getBoundingClientRect();
  const span     = st.window.to - st.window.from;
  const pxPerSec = (rect.width - 64) / span;
  const delta    = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const shift    = delta / pxPerSec;

  // Clamp: keep at least some data visible
  const oldest = st.segments.length
    ? st.segments.reduce((m,s) => Math.min(m, s.start_ts), Infinity) - 1800
    : st.window.from;
  const newest = Date.now() / 1000 + 600;

  let newFrom = st.window.from + shift;
  let newTo   = st.window.to   + shift;
  if (newFrom < oldest)           { newFrom = oldest; newTo = oldest + span; }
  if (newTo   > newest)           { newTo = newest;   newFrom = newest - span; }
  if (newFrom < oldest)             newFrom = oldest;  // clamp both after adj

  st.window.from = newFrom;
  st.window.to   = newTo;
  timeline.setWindow(st.window.from, st.window.to);

  // Fetch events for newly-visible area after scroll settles
  clearTimeout(_fetchDebounce);
  _fetchDebounce = setTimeout(() => load(), 400);
}, { passive: false });

// Hover → thumbnail preview
let hoverTimer = null;
el.tlCanvas.addEventListener("mousemove", e => {
  const rect = el.tlCanvas.getBoundingClientRect();
  const hit  = timeline.decode(e.clientX - rect.left, e.clientY - rect.top);
  clearTimeout(hoverTimer);
  if (!hit) { el.thumb.hidden = true; return; }
  hoverTimer = setTimeout(() => {
    // Only closed segments are playable
    const seg = filteredSegs().find(s => s.source_id === hit.srcId &&
      s.end_ts != null && s.start_ts <= hit.ts && s.end_ts > hit.ts);
    if (!seg) { el.thumb.hidden = true; return; }
    const off = Math.max(0, hit.ts - seg.start_ts);
    const img = el.thumb.querySelector("img");
    const ts  = el.thumb.querySelector(".v2-thumb-ts");
    img.src  = `/api/thumb?path=${encodeURIComponent(seg.path)}&t=${off.toFixed(1)}`;
    ts.textContent = new Date(hit.ts * 1000).toLocaleTimeString(undefined,
      { hour:"2-digit", minute:"2-digit", second:"2-digit" });
    const THUMB_W = 164;
    const L = Math.max(0, Math.min(rect.width - THUMB_W, e.clientX - rect.left - THUMB_W / 2));
    el.thumb.style.left = `${L}px`;
    el.thumb.hidden = false;
  }, 80);
});
el.tlCanvas.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); el.thumb.hidden = true; });

// ── Event navigation ──────────────────────────────────
function scrollTimelineToTs(ts) {
  const span = st.window.to - st.window.from;
  if (ts < st.window.from + span * 0.1 || ts > st.window.to - span * 0.1) {
    st.window.from = ts - span * 0.4;
    st.window.to   = ts + span * 0.6;
    timeline.setWindow(st.window.from, st.window.to);
  }
}

function navPrev() {
  const ts = liveTail.active ? (liveTail.latestDet?.abs_ts ?? Date.now() / 1000) : player.reliableTs;
  if (ts == null) return;
  const evts = filteredEvts().filter(e => e.abs_ts < ts - 1).sort((a,b) => b.abs_ts - a.abs_ts);
  const evt  = evts[0];
  if (!evt) return;
  if (evt.provisional) { startLiveTail(evt.source_id); scrollTimelineToTs(evt.abs_ts); return; }
  stopLiveTail(false);
  mode.seekTo(evt.abs_ts, evt.source_id); pushState();
  scrollTimelineToTs(evt.abs_ts);
}

function navNext() {
  const ts = liveTail.active ? (liveTail.latestDet?.abs_ts ?? Date.now() / 1000) : player.reliableTs;
  if (ts == null) return;
  const evts = filteredEvts().filter(e => e.abs_ts > ts + 1).sort((a,b) => a.abs_ts - b.abs_ts);
  const evt  = evts[0];
  if (!evt) return;
  if (evt.provisional) { startLiveTail(evt.source_id); scrollTimelineToTs(evt.abs_ts); return; }
  stopLiveTail(false);
  mode.seekTo(evt.abs_ts, evt.source_id); pushState();
  scrollTimelineToTs(evt.abs_ts);
}

// ── Live tail ──────────────────────────────────────────
function latestOpenSegment(srcId = null) {
  const cutoff = Date.now() / 1000 - LIVE_OPEN_MAX_AGE;
  return [...st.segments]
    .filter(s => s.end_ts == null && s.start_ts >= cutoff && (!srcId || s.source_id === srcId))
    .sort((a, b) => b.start_ts - a.start_ts)[0] ?? null;
}

function chooseLiveSource(srcId = null) {
  if (srcId && srcId !== "all") return srcId;
  const selected = st.source !== "all" ? st.source : null;
  return latestOpenSegment(selected)?.source_id
    ?? selected
    ?? player.currentSeg?.source_id
    ?? latestOpenSegment()?.source_id
    ?? st.segments[0]?.source_id
    ?? null;
}

async function startLiveTail(srcId = null) {
  const chosen = chooseLiveSource(srcId);
  if (!chosen) return;
  if (liveTail.active && liveTail.srcId === chosen) return;
  stopLiveTail(false);

  liveTail.active = true;
  liveTail.srcId = chosen;
  liveTail.latestDet = null;
  mode.enterLive();
  player.pause();

  el.video.style.display = "none";
  el.empty.style.display = "none";
  el.liveVideo.style.display = "block";
  el.liveBtn.textContent = "● LIVE";
  el.liveBtn.classList.add("active");
  el.play.textContent = "■";
  el.play.classList.add("playing");
  setStatus("LIVE");
  history.replaceState(null, "", `${location.pathname}?source=${encodeURIComponent(chosen)}&live=1`);

  const hlsUrl = `/video/live/${encodeURIComponent(chosen)}/live.m3u8`;

  el.liveVideo.onerror = e => {
    const err = el.liveVideo.error;
    console.error("liveVideo error:", err?.code, err?.message, hlsUrl);
    setStatus("LIVE ERR");
  };

  async function _attachHls() {
    // Clear any stale srcObject before setting src
    if (el.liveVideo.srcObject) { el.liveVideo.srcObject = null; }
    const canNative = el.liveVideo.canPlayType("application/vnd.apple.mpegurl");
    console.log("HLS attach:", hlsUrl, "native:", !!canNative);
    if (canNative) {
      // Safari — native HLS: wait for metadata before playing
      el.liveVideo.src = hlsUrl;
      el.liveVideo.load();
      el.liveVideo.addEventListener("loadedmetadata", () => {
        el.liveVideo.play().catch(e => console.warn("play() failed:", e));
      }, { once: true });
    } else {
      // Chrome/Firefox — load hls.js lazily
      if (!window.Hls) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      if (liveTail.hls) { liveTail.hls.destroy(); liveTail.hls = null; }
      const hls = new Hls({ lowLatencyMode: true });
      liveTail.hls = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(el.liveVideo);
      hls.on(Hls.Events.MANIFEST_PARSED, () => el.liveVideo.play().catch(() => {}));
    }
  }

  try {
    await _attachHls();
    await pollLiveTail();
    liveTail.pollTimer = setInterval(pollLiveTail, 1500);
    liveTail.clockTimer = setInterval(updateLiveTailClock, 500);
  } catch (err) {
    console.error("live HLS:", err);
    stopLiveTail();
    setStatus("LIVE ERR");
  }
}

function stopLiveTail(updateMode = true) {
  clearInterval(liveTail.pollTimer);
  clearInterval(liveTail.clockTimer);
  liveTail.pollTimer = null;
  liveTail.clockTimer = null;
  if (liveTail.hls) { liveTail.hls.destroy(); liveTail.hls = null; }
  if (el.liveVideo) { el.liveVideo.pause(); el.liveVideo.src = ""; }
  if (el.liveVideo) el.liveVideo.style.display = "none";
  liveTail.active = false;
  liveTail.srcId = null;
  liveTail.latestDet = null;
  // Restore URL: remove live=1 and ts params
  const _p = new URLSearchParams(location.search);
  _p.delete("live"); _p.delete("ts");
  history.replaceState(null, "", `${location.pathname}${_p.size ? "?" + _p : ""}`);
  el.liveBtn.textContent = "LIVE";
  el.liveBtn.classList.remove("active");
  el.play.textContent = player.paused ? "▶" : "■";
  el.play.classList.toggle("playing", !player.paused);
  drawBoxList(el.video, []);
  if (updateMode) mode.stopLive();
  if (el.video.dataset.src) el.video.style.display = "block";
  else el.empty.style.display = "block";
  setStatus("AUTO");
}

async function pollLiveTail() {
  if (!liveTail.active || !liveTail.srcId) return;
  const p = new URLSearchParams({ source: liveTail.srcId });
  const r = await fetch(`/api/video/live?${p}`, { cache:"no-store" }).catch(() => null);
  if (!r?.ok) return;
  const data = await r.json();
  mergeSegments(data.segments || []);
  replaceProvisionalEvents(data.events || [], liveTail.srcId);
  mergeClassCounts(data.events || []);
  liveTail.latestDet = (data.detections || []).find(d => d.source_id === liveTail.srcId) ?? liveTail.latestDet;
  renderClsCtrl();
  timeline.setData(allSegsForSrc(), filteredEvts());
  scheduleNearestEvents(true);
  updateLiveTailClock();
}

function updateLiveTailClock() {
  if (!liveTail.active) return;
  const ts = liveTail.latestDet?.abs_ts ?? Date.now() / 1000;
  timeline.setPlayhead(ts);
  el.timeDisp.textContent = fmtTs(ts);
  if (el.hudTs) el.hudTs.textContent = new Date(ts * 1000).toLocaleTimeString(undefined,
    { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  if (el.tsDisp) {
    const src = st.sources.find(s => s.id === liveTail.srcId);
    el.tsDisp.textContent = `${src?.name || liveTail.srcId} · LIVE · ${new Date(ts * 1000).toLocaleString(undefined,
      { dateStyle:"short", timeStyle:"medium" })}`;
  }
  drawLiveBoxes();
}

// ── Player controls ───────────────────────────────────
function togglePlayback() {
  if (liveTail.active) {
    if (el.liveVideo.paused) el.liveVideo.play().catch(() => {});
    else el.liveVideo.pause();
    el.play.textContent = el.liveVideo.paused ? "▶" : "■";
    el.play.classList.toggle("playing", !el.liveVideo.paused);
    return;
  }
  if (!player.paused) { player.pause(); return; }
  mode.playFromCurrent(st.source !== "all" ? st.source : null);
}

el.play.addEventListener("click", togglePlayback);
el.prev.addEventListener("click", navPrev);
el.next.addEventListener("click", navNext);
el.rewind.addEventListener("click", () => {
  const wasLive = liveTail.active;
  const ts  = wasLive ? (liveTail.latestDet?.abs_ts ?? Date.now() / 1000) : player.reliableTs;
  const src = wasLive ? liveTail.srcId : (player.currentSeg?.source_id ?? null);
  if (wasLive) stopLiveTail(false);
  if (ts != null) {
    const target = ts - 10;
    mode.seekTo(target, src, "backward"); pushState();
  }
});
el.loop.addEventListener("click",   () => { st.loop = !st.loop; el.loop.classList.toggle("active", st.loop); });
el.boxes.addEventListener("click",  () => {
  st.showBoxes = !st.showBoxes;
  localStorage.setItem("v2boxes", st.showBoxes ? "1" : "0");
  el.boxes.classList.toggle("active", st.showBoxes);
});
el.boxes.classList.toggle("active", st.showBoxes);
el.liveBtn.addEventListener("click", () => {
  if (liveTail.active) stopLiveTail();
  else startLiveTail(st.source !== "all" ? st.source : null);
});

// Speed pills
function buildSpeedPills() {
  el.speeds.innerHTML = "";
  V2_SPEEDS.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "speed-pill" + (i === st.speed ? " active" : "");
    b.textContent = s.label;
    b.addEventListener("click", () => { st.speed = i; localStorage.setItem("v2speed", i); player.setRate(s.rate); buildSpeedPills(); });
    el.speeds.appendChild(b);
  });
}

// Keyboard
document.addEventListener("keydown", e => {
  if (["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
  if (e.key === " ")           { e.preventDefault(); togglePlayback(); }
  if (e.key === "ArrowLeft")  { e.preventDefault(); navPrev(); }
  if (e.key === "ArrowRight") { e.preventDefault(); navNext(); }
});
el.video.addEventListener("click",    togglePlayback);
el.liveVideo.addEventListener("click", togglePlayback);
el.video.addEventListener("dblclick", () => {
  const s = document.querySelector(".v2-stage");
  document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen().catch(()=>{});
});
el.liveVideo.addEventListener("dblclick", () => {
  const s = document.querySelector(".v2-stage");
  document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen().catch(()=>{});
});

// ── Player events → UI ────────────────────────────────
player.on("play",  () => { if (!liveTail.active) { el.play.textContent = "■"; el.play.classList.add("playing"); } });
player.on("pause", () => { if (!liveTail.active) { el.play.textContent = "▶"; el.play.classList.remove("playing"); } });
player.on("ended", () => { mode.handleEnded(st.source !== "all" ? st.source : null); });

player.on("timeupdate", () => {
  const ts = player.currentTs;
  if (ts == null) return;
  timeline.setPlayhead(ts);
  el.timeDisp.textContent = fmtTs(ts);
  if (el.hudTs) el.hudTs.textContent = new Date(ts*1000).toLocaleTimeString(undefined,
    { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  if (el.tsDisp) {
    const src = st.sources.find(s => s.id === (player.currentSeg?.source_id));
    el.tsDisp.textContent = `${src?.name || ""} · ${new Date(ts*1000).toLocaleString(undefined,
      {dateStyle:"short",timeStyle:"medium"})}`;
  }
  drawBoxes(ts);
  scheduleNearestEvents();
});

// ── Box overlay ───────────────────────────────────────
async function loadDets(segId) {
  if (st.dets[segId] != null) return;
  st.dets[segId] = [];  // mark as loading
  const r = await fetch(`/api/video/detections?segment_id=${segId}`, { cache:"no-store" });
  if (r.ok) st.dets[segId] = (await r.json()).detections || [];
}

function drawBoxes(ts) {
  if (liveTail.active) return;
  const v = el.video;
  const seg = player.currentSeg;
  if (!seg) { drawBoxList(v, []); return; }
  if (!st.dets[seg.id]) { loadDets(seg.id); drawBoxList(v, []); return; }

  const off = ts - seg.start_ts;
  const nearest = (st.dets[seg.id] || []).reduce((best, d) =>
    Math.abs(d.ts_offset - off) < Math.abs((best?.ts_offset ?? Infinity) - off) ? d : best, null);
  if (!nearest || Math.abs(nearest.ts_offset - off) > 1.5) { drawBoxList(v, []); return; }

  drawBoxList(v, nearest.boxes || []);
}

function drawLiveBoxes() {
  drawBoxList(el.liveVideo, liveTail.latestDet?.boxes || []);
}

function drawBoxList(v, boxes) {
  const c = el.canvas;
  c.width = c.clientWidth; c.height = c.clientHeight;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!st.showBoxes || !v.videoWidth) return;
  if (!boxes.length) return;
  const cw = c.width, ch = c.height;
  const iw = v.videoWidth, ih = v.videoHeight;
  const scale = Math.min(cw/iw, ch/ih);
  const rw = iw*scale, rh = ih*scale;
  const ox = (cw-rw)/2, oy = (ch-rh)/2;

  boxes.forEach(box => {
    const primary = st.cls.size === 0 || st.cls.has(box.cls);
    const color   = EVENT_COLORS[box.cls] || "#ccd8e4";
    const x = ox+box.x1*rw, y = oy+box.y1*rh;
    const w = (box.x2-box.x1)*rw, h = (box.y2-box.y1)*rh;
    ctx.globalAlpha = primary ? 1 : 0.55;
    ctx.strokeStyle = color; ctx.lineWidth = primary ? 2.5 : 1;
    ctx.strokeRect(x,y,w,h);
    if (primary) {
      const lbl = `${box.cls} ${Math.round(box.conf*100)}%`;
      ctx.font = "bold 11px 'IBM Plex Mono',monospace";
      const tw = ctx.measureText(lbl).width+6;
      const ty = y>18?y-18:y+h;
      ctx.fillStyle=color; ctx.fillRect(x-1,ty,tw,16);
      ctx.globalAlpha=1; ctx.fillStyle="#050709";
      ctx.fillText(lbl,x+2,ty+11);
    }
  });
  ctx.globalAlpha=1;
}

function fmtTs(ts) {
  const d = new Date(ts * 1000);
  const day = d.toLocaleDateString(undefined, { day:"numeric", month:"short" });
  const t   = d.toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit", second:"2-digit" });
  return `${day} ${t}`;
}

// ── Auto-refresh ──────────────────────────────────────
setInterval(async () => {
  el.status.textContent = liveTail.active ? "LIVE" : "SYNC";
  st.window.to = Date.now() / 1000;
  timeline.setWindow(st.window.from, st.window.to);
  await load();
  el.status.textContent = liveTail.active ? "LIVE" : "AUTO";
}, 15000);

window.addEventListener("resize", () => timeline.draw());

// ── Deep links ────────────────────────────────────────
function pushState() {
  const p = new URLSearchParams();
  if (st.source !== "all")    p.set("source", st.source);
  const ts = liveTail.active ? liveTail.latestDet?.abs_ts : player.reliableTs;
  if (ts)                     p.set("ts",     Math.floor(ts));
  if (st.cls.size > 0)        p.set("cls",    [...st.cls].join(","));
  history.replaceState(null, "", `${location.pathname}${p.size ? "?" + p : ""}`);
}

function readState() {
  const p = new URLSearchParams(location.search);
  if (p.has("source")) st.source = p.get("source");
  if (p.has("cls"))    p.get("cls").split(",").filter(Boolean).forEach(c => st.cls.add(c));
  return { ts: p.has("ts") ? parseFloat(p.get("ts")) : null, live: p.get("live") === "1" };
}

// ── Boot ──────────────────────────────────────────────
async function init() {
  const r = await fetch("/api/sources", { cache:"no-store" });
  if (r.ok) st.sources = (await r.json()).sources || [];
  buildSpeedPills();
  player.setRate(V2_SPEEDS[st.speed].rate);

  const { ts: urlTs, live: urlLive } = readState();
  if (urlTs || urlLive) st.initDone = true;
  renderSrcCtrl();

  const now = Date.now() / 1000;
  const anchor = urlTs ?? now;
  st.window.from = anchor - 3 * 3600;
  st.window.to   = anchor + 3 * 3600 + 600;
  timeline.setWindow(st.window.from, st.window.to);

  if (urlLive) {
    // Direct live URL: load data in background, immediately enter live
    load();
    startLiveTail(st.source !== "all" ? st.source : null);
  } else if (urlTs) {
    // Fast path: start video immediately, load timeline in background
    const srcParam = st.source !== "all" ? `&source=${encodeURIComponent(st.source)}` : "";
    fetch(`/api/video/segment-at?ts=${urlTs}${srcParam}`, { cache:"no-store" })
      .then(r => r.json())
      .then(({ segment }) => {
        if (!segment) return;
        player.setSegments([segment]);
        el.empty.style.display = "none";
        el.video.style.display = "block";
        mode.seekTo(urlTs, segment.source_id);
      });
    load();
  } else {
    await load();
  }
}

init();
