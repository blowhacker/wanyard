// ═══════════════════════════════════════════════════════
// V2Player — transparent, segment-aware, async seek
// ═══════════════════════════════════════════════════════
class V2Player {
  #v;            // HTMLVideoElement
  #segs = [];    // sorted [{path, start_ts, end_ts, source_id}]
  #abort = null; // AbortController for pending seek
  #listeners = { timeupdate: new Set(), play: new Set(), pause: new Set() };

  constructor(videoEl) {
    this.#v = videoEl;
    this.#v.addEventListener("timeupdate", () => this.#emit("timeupdate"));
    this.#v.addEventListener("play",       () => this.#emit("play"));
    this.#v.addEventListener("pause",      () => this.#emit("pause"));
    this.#v.addEventListener("ended",      () => this.#emit("ended"));
  }

  setSegments(segs) {
    this.#segs = [...segs].sort((a, b) => a.start_ts - b.start_ts);
  }

  // ── Seek ──────────────────────────────────────────────
  async seek(unix_ts, srcId = null) {
    // Cancel any in-flight seek
    this.#abort?.abort();
    this.#abort = new AbortController();
    const { signal } = this.#abort;

    const seg = this.#segFor(unix_ts, srcId) ?? this.#nearest(unix_ts, srcId);
    if (!seg) return false;

    const offset = Math.max(0, unix_ts - seg.start_ts);
    const url    = `/video/files/${seg.path}`;

    if (this.#v.dataset.src !== url) {
      this.#v.src         = url;
      this.#v.dataset.src = url;
      this.#v.load();
      try { await this.#waitFor("loadedmetadata", signal); }
      catch { return false; }
    }

    if (!signal.aborted) this.#v.currentTime = offset;
    return !signal.aborted;
  }

  // ── Playback ──────────────────────────────────────────
  play()         { return this.#v.play().catch(() => {}); }
  pause()        { this.#v.pause(); }
  setRate(rate)  { this.#v.playbackRate = rate; }
  rewind(secs)   { this.#v.currentTime = Math.max(0, this.#v.currentTime - secs); }
  get paused()   { return this.#v.paused; }
  get duration() { return this.#v.duration || 0; }

  // ── Current timestamp ─────────────────────────────────
  get currentTs() {
    const seg = this.#segs.find(s => `/video/files/${s.path}` === this.#v.dataset.src);
    return seg ? seg.start_ts + this.#v.currentTime : null;
  }

  get currentSeg() {
    return this.#segs.find(s => `/video/files/${s.path}` === this.#v.dataset.src) ?? null;
  }

  // ── Clip playlist — returns PlaylistHandle ────────────
  playClips(clips) {
    const handle = new PlaylistHandle(this, clips);
    handle._start();
    return handle;
  }

  // ── Events ────────────────────────────────────────────
  on(event, fn)  { this.#listeners[event]?.add(fn); }
  off(event, fn) { this.#listeners[event]?.delete(fn); }
  #emit(event)   { this.#listeners[event]?.forEach(fn => fn()); }

  // ── Private helpers ───────────────────────────────────
  #segFor(ts, srcId) {
    const pool = srcId ? this.#segs.filter(s => s.source_id === srcId) : this.#segs;
    return pool.find(s => s.start_ts <= ts && (s.end_ts ?? Infinity) > ts) ?? null;
  }

  #nearest(ts, srcId) {
    const pool = srcId ? this.#segs.filter(s => s.source_id === srcId) : this.#segs;
    return pool.reduce((best, s) =>
      !best || Math.abs(s.start_ts - ts) < Math.abs(best.start_ts - ts) ? s : best, null);
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

  constructor(player, clips) {
    this.#player = player;
    this.#clips  = clips;
    this.#check  = () => this.#watchEnd();
  }

  _start() {
    this.#active = true;
    this.#player.on("timeupdate", this.#check);
    this.#seekCurrent();
  }

  async #seekCurrent() {
    if (!this.#active || this.#idx >= this.#clips.length) return;
    const [start] = this.#clips[this.#idx];
    await this.#player.seek(start);
    if (this.#active) this.#player.play();
  }

  #watchEnd() {
    if (!this.#active) return;
    const [, end] = this.#clips[this.#idx] ?? [];
    const ts = this.#player.currentTs;
    if (end != null && ts != null && ts >= end) this.#advance();
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

  cancel() {
    this.#active = false;
    this.#player.off("timeupdate", this.#check);
  }
}

// ═══════════════════════════════════════════════════════
// AppMode — explicit state machine, owns PlaylistHandle
// ═══════════════════════════════════════════════════════
class AppMode {
  #player;
  #handle = null;
  #mode = "seek";   // "seek" | "playlist" | "live"
  onModeChange = null;

  constructor(player) { this.#player = player; }

  get current() { return this.#mode; }

  seekTo(unix_ts, srcId = null) {
    this.#cancel();
    this.#mode = "seek";
    this.onModeChange?.("seek");
    this.#player.seek(unix_ts, srcId).then(() => this.#player.play());
  }

  playEventPlaylist(events, loop = true) {
    if (!events.length) return;
    this.#cancel();
    this.#mode = "playlist";
    this.onModeChange?.("playlist");
    const POST = 10;
    const clips = events.map(e => [e.abs_ts, e.abs_ts + (e.end_off - e.start_off) + POST]);
    this.#handle = this.#player.playClips(clips);
    this.#handle.onEnd = () => {
      if (loop) this.#handle._start?.() ?? this.playEventPlaylist(events, loop);
      else { this.#mode = "seek"; this.onModeChange?.("seek"); }
    };
    return this.#handle;
  }

  goLive(srcId, segments) {
    this.#cancel();
    this.#mode = "live";
    this.onModeChange?.("live");
    const latest = [...segments].sort((a, b) => b.start_ts - a.start_ts)
      .find(s => s.source_id === srcId || !srcId);
    if (latest) this.#player.seek(latest.end_ts ?? latest.start_ts + 1, srcId)
      .then(() => this.#player.play());
  }

  stopLive() {
    if (this.#mode !== "live") return;
    this.#mode = "seek";
    this.onModeChange?.("seek");
  }

  #cancel() {
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

  constructor(canvasEl) {
    this.#c   = canvasEl;
    this.#ctx = canvasEl.getContext("2d");
  }

  setWindow(from, to) { this.#from = from; this.#to = to; this.draw(); }
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

// ── DOM ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  video:   $("v2Video"),
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
  play:    $("v2Play"),
  prev:    $("v2Prev"),
  next:    $("v2Next"),
  rewind:  $("v2Rewind"),
  speeds:  $("v2Speeds"),
  loop:    $("v2Loop"),
  timeDisp:$("v2TimeDisp"),
  boxes:   $("v2Boxes"),
  loadMore:$("v2LoadMore"),
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
};

// ── Derived views ─────────────────────────────────────
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

// ── Data loading ──────────────────────────────────────
async function load() {
  const p = new URLSearchParams();
  if (st.source !== "all") p.set("source", st.source);

  const [sr, er, cr] = await Promise.all([
    fetch(`/api/video2/timeline?${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
    fetch(`/api/video/events?limit=2000&${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
    fetch(`/api/video/classes?${p}`, { cache:"no-store" }).then(r=>r.json()).catch(()=>({})),
  ]);

  st.segments = sr.segments || [];
  st.events   = er.events   || [];
  st.classes  = cr.classes  || {};

  player.setSegments(st.segments);

  const srcNames = {};
  st.sources.forEach(s => srcNames[s.id] = s.name || s.id);
  timeline.setSrcNames(srcNames);
  timeline.setData(filteredSegs(), filteredEvts());

  renderSrcCtrl();
  renderClsCtrl();

  if (!st.initDone && st.segments.length) {
    st.initDone = true;
    const latest = st.segments[0];
    if (latest) {
      el.empty.style.display = "none";
      el.video.style.display = "block";
      mode.seekTo(latest.end_ts ?? latest.start_ts + 1, latest.source_id);
    }
  }
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
      st.source = s.id; st.initDone = false;
      renderSrcCtrl(); load();
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
    st.cls.clear(); mode.stopLive();
    renderClsCtrl(); timeline.setData(filteredSegs(), filteredEvts());
  });
  el.clsCtrl.appendChild(allBtn);

  entries.forEach(([c, n]) => {
    const b = document.createElement("button");
    b.className = "class-chip" + (st.cls.has(c) ? " active" : "");
    b.textContent = `${c} ×${n}`;
    b.addEventListener("click", () => {
      st.cls.has(c) ? st.cls.delete(c) : st.cls.add(c);
      renderClsCtrl();
      timeline.setData(filteredSegs(), filteredEvts());
      if (st.cls.size > 0) {
        const evts = filteredEvts().sort((a,b) => a.abs_ts - b.abs_ts);
        mode.playEventPlaylist(evts, st.loop);
      }
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
    // Snap to exact event timestamp
    mode.seekTo(hit.snapEvent.abs_ts, hit.snapEvent.source_id);
  } else {
    mode.seekTo(hit.ts, hit.srcId);
  }
  el.empty.style.display = "none";
  el.video.style.display = "block";
});

// Hover → thumbnail preview
let hoverTimer = null;
el.tlCanvas.addEventListener("mousemove", e => {
  const rect = el.tlCanvas.getBoundingClientRect();
  const hit  = timeline.decode(e.clientX - rect.left, e.clientY - rect.top);
  clearTimeout(hoverTimer);
  if (!hit) { el.thumb.hidden = true; return; }
  hoverTimer = setTimeout(() => {
    const seg = filteredSegs().find(s => s.source_id === hit.srcId &&
      s.start_ts <= hit.ts && (s.end_ts ?? Infinity) > hit.ts);
    if (!seg) { el.thumb.hidden = true; return; }
    const off = Math.max(0, hit.ts - seg.start_ts);
    const img = el.thumb.querySelector("img");
    const ts  = el.thumb.querySelector(".v2-thumb-ts");
    img.src  = `/api/thumb?path=${encodeURIComponent(seg.path)}&t=${off.toFixed(1)}`;
    ts.textContent = new Date(hit.ts * 1000).toLocaleTimeString(undefined,
      { hour:"2-digit", minute:"2-digit", second:"2-digit" });
    const L = Math.max(0, e.clientX - rect.left - 80);
    el.thumb.style.left = `${L}px`;
    el.thumb.hidden = false;
  }, 80);
});
el.tlCanvas.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); el.thumb.hidden = true; });

// ── Player controls ───────────────────────────────────
el.play.addEventListener("click", () => { player.paused ? player.play() : player.pause(); });
el.prev.addEventListener("click", () => {
  const h = mode.handle;
  if (h) h.prev(); else player.seek(Math.max(0, (player.currentTs ?? 0) - 30));
});
el.next.addEventListener("click", () => {
  const h = mode.handle;
  if (h) h.next(); else player.seek((player.currentTs ?? 0) + 30);
});
el.rewind.addEventListener("click", () => player.rewind(10));
el.loop.addEventListener("click",   () => { st.loop = !st.loop; el.loop.classList.toggle("active", st.loop); });
el.boxes.addEventListener("click",  () => {
  st.showBoxes = !st.showBoxes;
  localStorage.setItem("v2boxes", st.showBoxes ? "1" : "0");
  el.boxes.classList.toggle("active", st.showBoxes);
});
el.boxes.classList.toggle("active", st.showBoxes);
el.loadMore.addEventListener("click", () => { timeline.extendBack(6); load(); });
el.liveBtn.addEventListener("click", () => {
  if (mode.current === "live") { mode.stopLive(); el.liveBtn.textContent = "LIVE"; el.liveBtn.classList.remove("active"); }
  else { mode.goLive(st.source !== "all" ? st.source : null, st.segments); el.liveBtn.textContent = "● LIVE"; el.liveBtn.classList.add("active"); }
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
  if (e.key === " ")  { e.preventDefault(); player.paused ? player.play() : player.pause(); }
  if (e.key === "ArrowLeft")  player.rewind(5);
  if (e.key === "ArrowRight") player.seek((player.currentTs ?? 0) + 5);
  if (e.key === "ArrowUp")    mode.handle?.prev();
  if (e.key === "ArrowDown")  mode.handle?.next();
});
el.video.addEventListener("click",    () => { player.paused ? player.play() : player.pause(); });
el.video.addEventListener("dblclick", () => {
  const s = document.querySelector(".v2-stage");
  document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen().catch(()=>{});
});

// ── Player events → UI ────────────────────────────────
player.on("play",  () => { el.play.textContent = "■"; el.play.classList.add("playing"); });
player.on("pause", () => { el.play.textContent = "▶"; el.play.classList.remove("playing"); });
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
});

// ── Box overlay ───────────────────────────────────────
async function loadDets(segId) {
  if (st.dets[segId] != null) return;
  st.dets[segId] = [];  // mark as loading
  const r = await fetch(`/api/video/detections?segment_id=${segId}`, { cache:"no-store" });
  if (r.ok) st.dets[segId] = (await r.json()).detections || [];
}

function drawBoxes(ts) {
  const c = el.canvas, v = el.video;
  c.width = c.clientWidth; c.height = c.clientHeight;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!st.showBoxes || !v.videoWidth) return;

  const seg = player.currentSeg;
  if (!seg) return;
  if (!st.dets[seg.id]) { loadDets(seg.id); return; }

  const off = ts - seg.start_ts;
  const nearest = (st.dets[seg.id] || []).reduce((best, d) =>
    Math.abs(d.ts_offset - off) < Math.abs((best?.ts_offset ?? Infinity) - off) ? d : best, null);
  if (!nearest || Math.abs(nearest.ts_offset - off) > 1.5) return;

  const boxes = nearest.boxes || [];
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
  return new Date(ts*1000).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

// ── Auto-refresh ──────────────────────────────────────
setInterval(async () => {
  el.status.textContent = "SYNC";
  st.window.to = Date.now() / 1000;
  timeline.setWindow(st.window.from, st.window.to);
  await load();
  el.status.textContent = "AUTO";
}, 15000);

window.addEventListener("resize", () => timeline.draw());

// ── Boot ──────────────────────────────────────────────
async function init() {
  const r = await fetch("/api/sources", { cache:"no-store" });
  if (r.ok) st.sources = (await r.json()).sources || [];
  buildSpeedPills();
  player.setRate(V2_SPEEDS[st.speed].rate);
  st.window.to   = Date.now() / 1000;
  st.window.from = st.window.to - 6 * 3600;
  timeline.setWindow(st.window.from, st.window.to);
  renderSrcCtrl();
  await load();
}

init();
