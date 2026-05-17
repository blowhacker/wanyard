// ═══════════════════════════════════════════════════════
// V2Player — transparent segment-aware video playback
// ═══════════════════════════════════════════════════════
class V2Player {
  constructor(videoEl) {
    this._v    = videoEl;
    this._segs = [];        // sorted by start_ts
    this._clips  = [];      // [[start_ts, end_ts], ...]
    this._clipIdx = -1;
    this._watchFn = null;

    // Callbacks (set externally)
    this.onTimeUpdate  = null;
    this.onClipEnd     = null;
    this.onPlay        = null;
    this.onPause       = null;

    this._v.addEventListener("timeupdate", () => {
      this._checkClipEnd();
      this.onTimeUpdate?.();
    });
    this._v.addEventListener("play",  () => this.onPlay?.());
    this._v.addEventListener("pause", () => this.onPause?.());
    this._v.addEventListener("ended", () => this._advance());
  }

  setSegments(segments) {
    this._segs = [...segments].sort((a, b) => a.start_ts - b.start_ts);
  }

  // Find segment containing unix_ts
  segmentFor(ts, srcId = null) {
    const pool = srcId ? this._segs.filter(s => s.source_id === srcId) : this._segs;
    return pool.find(s => s.start_ts <= ts && (s.end_ts ?? Infinity) > ts);
  }

  get currentTs() {
    const seg = this._curSeg();
    return seg ? seg.start_ts + this._v.currentTime : null;
  }

  get paused() { return this._v.paused; }

  _curSeg() {
    return this._segs.find(s => `/video/files/${s.path}` === this._v.dataset.src);
  }

  // ── Core seek ────────────────────────────────────────
  seek(unix_ts, srcId = null) {
    // Cancel any stacked pending seek
    if (this._pendingSeek) {
      this._v.removeEventListener("loadedmetadata", this._pendingSeek);
      this._pendingSeek = null;
    }

    let seg = this.segmentFor(unix_ts, srcId);
    if (!seg) {
      const pool = srcId ? this._segs.filter(s => s.source_id === srcId) : this._segs;
      seg = pool.reduce((best, s) =>
        Math.abs(s.start_ts - unix_ts) < Math.abs((best?.start_ts ?? Infinity) - unix_ts) ? s : best,
      null);
    }
    if (!seg) return false;

    const offset = Math.max(0, unix_ts - seg.start_ts);
    const url    = `/video/files/${seg.path}`;
    const doSeek = () => { this._v.currentTime = offset; };

    if (this._v.dataset.src !== url) {
      this._v.src = url;
      this._v.dataset.src = url;
      this._v.load();
    }

    if (this._v.readyState >= 1) {  // HAVE_METADATA
      doSeek();
    } else {
      this._pendingSeek = () => { doSeek(); this._pendingSeek = null; };
      this._v.addEventListener("loadedmetadata", this._pendingSeek, { once: true });
    }
    return true;
  }

  play()  { this._v.play().catch(() => {}); }
  pause() { this._v.pause(); }

  setRate(rate) { this._v.playbackRate = rate; }

  rewind(secs = 10) {
    this._v.currentTime = Math.max(0, this._v.currentTime - secs);
  }

  // ── Clip playlist ─────────────────────────────────────
  // clips: [[start_ts, end_ts], ...] — play each range in sequence
  playClips(clips, startIdx = 0) {
    this._clips   = clips;
    this._clipIdx = startIdx;
    this._playClip(startIdx);
  }

  get clipIdx()   { return this._clipIdx; }
  get clipCount() { return this._clips.length; }

  next() {
    if (this._clipIdx + 1 < this._clips.length) this._playClip(this._clipIdx + 1);
    else this.onClipEnd?.();
  }

  prev() {
    if (this._clipIdx > 0) this._playClip(this._clipIdx - 1);
  }

  _playClip(idx) {
    if (idx < 0 || idx >= this._clips.length) return;
    this._clipIdx = idx;
    const [start] = this._clips[idx];
    if (this.seek(start)) {
      this._v.addEventListener("loadedmetadata", () => this.play(), { once: true });
      if (this._v.readyState >= 2) this.play();
    }
  }

  _checkClipEnd() {
    if (this._clipIdx < 0 || !this._clips.length) return;
    const [, end] = this._clips[this._clipIdx];
    if (end != null && this.currentTs != null && this.currentTs >= end) {
      this._advance();
    }
  }

  _advance() {
    if (this._clipIdx + 1 < this._clips.length) {
      this._playClip(this._clipIdx + 1);
    } else {
      this.onClipEnd?.();
    }
  }
}

// ═══════════════════════════════════════════════════════
// V2Timeline — proportional canvas timeline
// ═══════════════════════════════════════════════════════
const BOX_COLORS = {
  person:"#2aac6a",bird:"#20c0b0",cat:"#20c0b0",dog:"#20c0b0",
  car:"#c08020",truck:"#c08020",bus:"#c08020",motorcycle:"#c08020",bicycle:"#c08020",
};

class V2Timeline {
  constructor(canvasEl, thumbPreview) {
    this._c    = canvasEl;
    this._prev = thumbPreview;
    this._ctx  = canvasEl.getContext("2d");
    this._segs = [];
    this._evts = [];
    this._from = Date.now() / 1000 - 6 * 3600;  // 6h ago
    this._to   = Date.now() / 1000;
    this._head = null;   // playhead unix_ts

    this.onSeek    = null;  // callback(unix_ts)
    this.onHover   = null;  // callback(unix_ts | null)

    this._bindEvents();
  }

  setData(segments, events) {
    this._segs = segments;
    this._evts = events;
    this.draw();
  }

  setWindow(from_ts, to_ts) {
    this._from = from_ts;
    this._to   = to_ts;
    this.draw();
  }

  extendBack(hours = 6) {
    this._from -= hours * 3600;
    this.draw();
    return this._from;
  }

  setPlayhead(unix_ts) {
    this._head = unix_ts;
    this.draw();
  }

  // Map timestamp to canvas x
  _tsToX(ts) {
    return ((ts - this._from) / (this._to - this._from)) * this._c.width;
  }

  _xToTs(x) {
    const SRC_W = 60;
    const drawW = this._c.clientWidth - SRC_W;
    const drawX = Math.max(0, x - SRC_W);
    return this._from + (drawX / drawW) * (this._to - this._from);
  }

  draw() {
    const c = this._c, ctx = this._ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // Unique sources from segments
    const srcIds = [...new Set(this._segs.map(s => s.source_id))];
    if (!srcIds.length) return;

    const LABEL_AREA = 20;            // bottom labels
    const LANE_H = Math.floor((H - LABEL_AREA) / srcIds.length);
    const SRC_W  = 60;                // left label column
    const DRAW_W = W - SRC_W;

    const tsToX = ts => SRC_W + ((ts - this._from) / (this._to - this._from)) * DRAW_W;

    // ── Per-source lanes ──────────────────────────────
    srcIds.forEach((srcId, row) => {
      const TOP = row * LANE_H + 2;
      const BOT = TOP + LANE_H - 4;
      const MID = (TOP + BOT) / 2;
      const LH  = BOT - TOP;

      // Source label
      ctx.fillStyle = "rgba(107,120,137,0.9)";
      ctx.font = `9px 'IBM Plex Mono',monospace`;
      ctx.textAlign = "right";
      const label = this._srcName?.[srcId] || srcId.replace(/tapo-?/i,"");
      ctx.fillText(label.slice(0,10), SRC_W - 4, MID + 3.5);

      // Lane separator
      if (row > 0) {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(SRC_W, TOP - 2, DRAW_W, 1);
      }

      // Segment bands
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      for (const s of this._segs.filter(x => x.source_id === srcId)) {
        const x1 = tsToX(s.start_ts), x2 = tsToX(s.end_ts ?? this._to);
        if (x2 < SRC_W || x1 > W) continue;
        ctx.fillRect(Math.max(SRC_W, x1), TOP, Math.min(W, x2) - Math.max(SRC_W, x1), LH);
      }

      // Event dots
      for (const e of this._evts.filter(x => x.source_id === srcId)) {
        const x = tsToX(e.abs_ts);
        if (x < SRC_W || x > W) continue;
        ctx.fillStyle = BOX_COLORS[e.class] || "#ccd8e4";
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x, MID, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    // ── Hour labels ────────────────────────────────────
    const LABEL_Y = H - 5;
    ctx.fillStyle = "rgba(74,94,110,0.8)";
    ctx.font = `9px 'IBM Plex Mono',monospace`;
    ctx.textAlign = "center";
    const interval = this._labelInterval();
    let t0 = Math.ceil(this._from / interval) * interval;
    while (t0 <= this._to) {
      const x = tsToX(t0);
      if (x >= SRC_W && x <= W) {
        ctx.fillText(new Date(t0*1000).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"}), x, LABEL_Y);
        ctx.fillStyle = "rgba(74,94,110,0.15)";
        ctx.fillRect(x, 0, 1, H - LABEL_AREA);
        ctx.fillStyle = "rgba(74,94,110,0.8)";
      }
      t0 += interval;
    }

    // ── Playhead (spans all lanes) ────────────────────
    if (this._head != null) {
      const x = tsToX(this._head);
      if (x >= SRC_W && x <= W) {
        ctx.fillStyle = "#c08020";
        ctx.fillRect(x - 1, 0, 2, H - LABEL_AREA);
        ctx.beginPath();
        ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,7);
        ctx.closePath(); ctx.fill();
      }
    }
  }

  setSrcNames(map) { this._srcName = map; }

  _labelInterval() {
    const span = this._to - this._from;
    if (span > 20 * 3600) return 4 * 3600;
    if (span > 8  * 3600) return 2 * 3600;
    if (span > 3  * 3600) return 3600;
    if (span > 90 * 60)  return 30 * 60;
    return 15 * 60;
  }

  _srcAtY(y, H) {
    const srcIds = [...new Set(this._segs.map(s => s.source_id))];
    if (!srcIds.length) return null;
    const LANE_H = Math.floor((H - 20) / srcIds.length);
    const row = Math.min(srcIds.length - 1, Math.floor(y / LANE_H));
    return srcIds[row] ?? null;
  }

  _bindEvents() {
    let hoverTimer = null;
    const c = this._c;

    c.addEventListener("click", e => {
      const rect = c.getBoundingClientRect();
      const ts  = this._xToTs(e.clientX - rect.left);
      const src = this._srcAtY(e.clientY - rect.top, rect.height);
      this.onSeek?.(ts, src);
    });

    c.addEventListener("mousemove", e => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ts = this._xToTs(x);
      this.onHover?.(ts, e.clientX);

      // Thumbnail preview
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        this._showThumb(ts, e.clientX, rect);
      }, 80);
    });

    c.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      this._prev.hidden = true;
      this.onHover?.(null);
    });
  }

  _showThumb(ts, clientX, canvasRect) {
    // Find segment for this ts
    const seg = this._segs.find(s => s.start_ts <= ts && (s.end_ts ?? Infinity) > ts);
    if (!seg) { this._prev.hidden = true; return; }
    const offset = Math.max(0, ts - seg.start_ts);
    const img = this._prev.querySelector("img");
    const tsEl = this._prev.querySelector(".v2-thumb-ts");
    img.src = `/api/thumb?path=${encodeURIComponent(seg.path)}&t=${offset.toFixed(1)}`;
    tsEl.textContent = new Date(ts * 1000).toLocaleTimeString(undefined,
      { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const left = Math.max(0, Math.min(clientX - canvasRect.left - 80, canvasRect.width - 164));
    this._prev.style.left = `${left}px`;
    this._prev.hidden = false;
  }
}

// ═══════════════════════════════════════════════════════
// App state & init
// ═══════════════════════════════════════════════════════
const V2_SPEEDS = [
  { label: "½×", rate: 0.5 },
  { label: "1×", rate: 1.0 },
  { label: "2×", rate: 2.0 },
  { label: "4×", rate: 4.0 },
];
const V2_POST_BUFFER = 10;

const st = {
  sources:  [],
  source:   "all",
  cls:      new Set(),   // empty = ALL
  classes:  {},
  segments: [],
  events:   [],
  dets:     {},     // segId → [{ts_offset, boxes, classes}]
  speed:    parseInt(localStorage.getItem("v2speed") || "1", 10),
  loop:     true,
  showBoxes:localStorage.getItem("v2boxes") !== "0",
  live:     false,
};

const $ = id => document.getElementById(id);
const el = {
  video:    $("v2Video"),
  canvas:   $("v2BoxCanvas"),
  empty:    $("v2Empty"),
  timeline: $("v2Timeline"),
  thumb:    $("v2ThumbPreview"),
  hudSrc:   $("v2HudSource"),
  hudTs:    $("v2HudTs"),
  ts:       $("v2Timestamp"),
  srcCtrl:  $("v2SourceCtrl"),
  clsField: $("v2ClassField"),
  clsCtrl:  $("v2ClassCtrl"),
  play:     $("v2Play"),
  prev:     $("v2Prev"),
  next:     $("v2Next"),
  rewind:   $("v2Rewind"),
  speeds:   $("v2Speeds"),
  loop:     $("v2Loop"),
  timeDisp: $("v2TimeDisp"),
  boxes:    $("v2Boxes"),
  loadMore: $("v2LoadMore"),
  status:   $("v2Status"),
  liveBtn:  $("v2LiveBtn"),
  goLive:   $("v2GoLive"),
};

const player   = new V2Player(el.video);
const timeline = new V2Timeline(el.timeline, el.thumb);

// ── Player callbacks ──────────────────────────────────
player.onTimeUpdate = () => {
  const ts = player.currentTs;
  if (!ts) return;
  timeline.setPlayhead(ts);
  el.timeDisp.textContent = fmtTs(ts);
  if (el.hudTs) el.hudTs.textContent = new Date(ts * 1000).toLocaleTimeString(undefined,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (el.ts) {
    const src = st.sources.find(s => s.id === st.source) || st.sources[0];
    el.ts.textContent = `${src?.name || st.source} · ${new Date(ts*1000).toLocaleString(undefined,{dateStyle:"short",timeStyle:"medium"})}`;
  }
  drawBoxes(ts);
};
player.onPlay  = () => { el.play.textContent = "■"; el.play.classList.add("playing"); };
player.onPause = () => { el.play.textContent = "▶"; el.play.classList.remove("playing"); };
player.onClipEnd = () => {
  if (st.loop && player.clipCount > 0) {
    player.playClips(player._clips, 0);
  } else {
    player.pause();
  }
};

// ── Timeline callbacks ────────────────────────────────
timeline.onSeek = (ts, srcId) => {
  setLive(false);
  if (srcId && srcId !== st.source) {
    st.source = srcId;
    renderSourceCtrl();
    // Update HUD source label
    const src = st.sources.find(s => s.id === srcId);
    if (el.hudSrc) el.hudSrc.textContent = (src?.name || srcId).toUpperCase();
  }
  player.seek(ts, srcId);
  player.play();
  el.empty.style.display = "none";
  el.video.style.display = "block";
};

// ── Data loading ──────────────────────────────────────
async function load() {
  const p = new URLSearchParams();
  if (st.source !== "all") p.set("source", st.source);
  const [sr, er, cr] = await Promise.all([
    fetch(`/api/video2/timeline?${p}`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
    fetch(`/api/video/events?limit=2000&${p}`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
    fetch(`/api/video/classes?${p}`, { cache: "no-store" }).then(r => r.json()).catch(() => ({})),
  ]);

  const newSegs = sr.segments || [];
  const newEvts = er.events   || [];

  const prevLen = st.segments.length;
  st.segments = newSegs;
  st.events   = newEvts;
  st.classes  = cr.classes || {};

  player.setSegments(newSegs);
  // Pass source name lookup for lane labels
  const srcNames = {};
  st.sources.forEach(s => srcNames[s.id] = s.name || s.id);
  timeline.setSrcNames(srcNames);
  timeline.setData(filteredSegs(), filteredEvts());

  renderClassCtrl();

  // Auto-seek to latest on first load
  if (prevLen === 0 && newSegs.length) {
    const latest = newSegs[0];
    if (latest?.end_ts) {
      player.seek(Math.max(latest.start_ts, latest.end_ts - 5));
    } else if (latest) {
      player.seek(latest.start_ts);
    }
    el.empty.style.display  = "none";
    el.video.style.display  = "block";
  }

  if (st.live && newSegs.length) {
    const latest = newSegs[0];
    if (latest) player.seek(latest.end_ts ?? latest.start_ts);
  }
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

// ── Clip playlist from events ─────────────────────────
function playEventPlaylist() {
  const evts = filteredEvts().sort((a, b) => a.abs_ts - b.abs_ts);
  if (!evts.length) return;
  const clips = evts.map(e => [e.abs_ts, e.abs_ts + Math.max(1, e.end_off - e.start_off) + V2_POST_BUFFER]);
  player.playClips(clips, 0);
  el.empty.style.display = "none";
  el.video.style.display = "block";
}

// ── Class filter ──────────────────────────────────────
function renderClassCtrl() {
  el.clsCtrl.innerHTML = "";
  const entries = Object.entries(st.classes).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.clsField.hidden = true; return; }
  el.clsField.hidden = false;

  // ALL chip — clears selection
  const allBtn = document.createElement("button");
  allBtn.className = "class-chip" + (st.cls.size === 0 ? " active" : "");
  allBtn.textContent = "ALL";
  allBtn.addEventListener("click", () => {
    st.cls.clear();
    renderClassCtrl();
    timeline.setData(filteredSegs(), filteredEvts());
  });
  el.clsCtrl.appendChild(allBtn);

  entries.forEach(([c, count]) => {
    const btn = document.createElement("button");
    const active = st.cls.has(c);
    btn.className = "class-chip" + (active ? " active" : "");
    btn.textContent = `${c} ×${count}`;
    btn.addEventListener("click", () => {
      if (st.cls.has(c)) st.cls.delete(c);
      else               st.cls.add(c);
      renderClassCtrl();
      timeline.setData(filteredSegs(), filteredEvts());
      if (st.cls.size > 0) playEventPlaylist();
    });
    el.clsCtrl.appendChild(btn);
  });
}

// ── Source selector ───────────────────────────────────
function renderSourceCtrl() {
  el.srcCtrl.innerHTML = "";
  const sources = st.sources.filter(s => s.type === "rtsp");
  if (!sources.length) return;
  const pills = document.createElement("div"); pills.className = "source-pills";
  [{ id: "all", name: "ALL" }, ...sources].forEach(s => {
    const btn = document.createElement("button");
    btn.className = "source-pill" + (st.source === s.id ? " active" : "");
    btn.textContent = s.name || s.id;
    btn.addEventListener("click", () => {
      st.source = s.id;
      if (el.hudSrc) el.hudSrc.textContent = (s.name || s.id).toUpperCase();
      renderSourceCtrl(); load();
    });
    pills.appendChild(btn);
  });
  el.srcCtrl.appendChild(pills);
}

// ── Controls ──────────────────────────────────────────
el.play.addEventListener("click", () => { player.paused ? player.play() : player.pause(); });
el.prev.addEventListener("click", () => { setLive(false); player.prev(); });
el.next.addEventListener("click", () => { setLive(false); player.next(); });
el.rewind.addEventListener("click", () => { player.rewind(10); });
el.loop.addEventListener("click", () => {
  st.loop = !st.loop;
  el.loop.classList.toggle("active", st.loop);
});
el.boxes.addEventListener("click", () => {
  st.showBoxes = !st.showBoxes;
  localStorage.setItem("v2boxes", st.showBoxes ? "1" : "0");
  el.boxes.classList.toggle("active", st.showBoxes);
});
el.boxes.classList.toggle("active", st.showBoxes);

el.loadMore.addEventListener("click", () => {
  const newFrom = timeline.extendBack(6);
  // Load more events for extended window if needed
  load();
});

el.liveBtn.addEventListener("click", () => setLive(!st.live));

function setLive(on) {
  st.live = on;
  el.liveBtn.textContent = on ? "● LIVE" : "LIVE";
  el.liveBtn.classList.toggle("active", on);
  if (on && st.segments.length) {
    const latest = st.segments[0];
    if (latest) player.seek(latest.end_ts ?? latest.start_ts);
    player.play();
  }
}

// Speed pills
function buildSpeedPills() {
  el.speeds.innerHTML = "";
  V2_SPEEDS.forEach((s, i) => {
    const btn = document.createElement("button");
    btn.className = "speed-pill" + (i === st.speed ? " active" : "");
    btn.textContent = s.label;
    btn.addEventListener("click", () => {
      st.speed = i; localStorage.setItem("v2speed", i);
      player.setRate(s.rate); buildSpeedPills();
    });
    el.speeds.appendChild(btn);
  });
}

// Keyboard
document.addEventListener("keydown", e => {
  if (["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
  if (e.key === " ")           { e.preventDefault(); player.paused ? player.play() : player.pause(); }
  else if (e.key === "ArrowLeft")  { player.rewind(5); }
  else if (e.key === "ArrowRight") { el.video.currentTime += 5; }
  else if (e.key === "ArrowUp")    { player.prev(); }
  else if (e.key === "ArrowDown")  { player.next(); }
});

// Click video to toggle play
el.video.addEventListener("click", () => { player.paused ? player.play() : player.pause(); });
el.video.addEventListener("dblclick", () => {
  const stage = document.querySelector(".v2-stage");
  document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen().catch(()=>{});
});

// ── Box overlay ───────────────────────────────────────
async function loadDets(segId) {
  if (st.dets[segId]) return;
  const r = await fetch(`/api/video/detections?segment_id=${segId}`, { cache: "no-store" });
  if (r.ok) st.dets[segId] = (await r.json()).detections || [];
}

function drawBoxes(ts) {
  const canvas = el.canvas, video = el.video;
  canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!st.showBoxes || !video.videoWidth) return;

  const curSeg = player._curSeg();
  if (!curSeg) return;
  if (!st.dets[curSeg.id]) { loadDets(curSeg.id); return; }

  const off = ts - curSeg.start_ts;
  const dets = st.dets[curSeg.id] || [];
  const nearest = dets.reduce((best, d) =>
    Math.abs(d.ts_offset - off) < Math.abs((best?.ts_offset ?? Infinity) - off) ? d : best, null);
  if (!nearest || Math.abs(nearest.ts_offset - off) > 1.5) return;

  const boxes = nearest.boxes || [];
  if (!boxes.length) return;
  const cw = canvas.width, ch = canvas.height;
  const iw = video.videoWidth, ih = video.videoHeight;
  const scale = Math.min(cw / iw, ch / ih);
  const rw = iw * scale, rh = ih * scale;
  const ox = (cw - rw) / 2, oy = (ch - rh) / 2;

  boxes.forEach(box => {
    const isPrimary = st.cls.size === 0 || st.cls.has(box.cls);
    const color = BOX_COLORS[box.cls] || "#ccd8e4";
    const x = ox + box.x1*rw, y = oy + box.y1*rh;
    const w = (box.x2-box.x1)*rw, h = (box.y2-box.y1)*rh;
    ctx.globalAlpha = isPrimary ? 1.0 : 0.65;
    ctx.strokeStyle = color; ctx.lineWidth = isPrimary ? 2.5 : 1;
    ctx.strokeRect(x, y, w, h);
    if (isPrimary) {
      const label = `${box.cls} ${Math.round(box.conf*100)}%`;
      ctx.font = "bold 11px 'IBM Plex Mono',monospace";
      const tw = ctx.measureText(label).width + 6;
      const ty = y > 18 ? y-18 : y+h;
      ctx.fillStyle = color; ctx.fillRect(x-1, ty, tw, 16);
      ctx.globalAlpha = 1; ctx.fillStyle = "#050709";
      ctx.fillText(label, x+2, ty+11);
    }
  });
  ctx.globalAlpha = 1;
}

// ── Utils ─────────────────────────────────────────────
function fmtTs(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ── Timeline window ───────────────────────────────────
function resetWindow() {
  const now = Date.now() / 1000;
  timeline.setWindow(now - 6 * 3600, now);
}

// ── Auto-refresh ──────────────────────────────────────
setInterval(async () => {
  el.status.textContent = "SYNC";
  // Extend timeline window to now
  const now = Date.now() / 1000;
  timeline._to = now;
  await load();
  el.status.textContent = "AUTO";
  // Redraw timeline with current window
  timeline.setData(filteredSegs(), filteredEvts());
}, 15000);

// ── Window resize ─────────────────────────────────────
window.addEventListener("resize", () => timeline.draw());

// ── Boot ──────────────────────────────────────────────
async function init() {
  const r = await fetch("/api/sources", { cache: "no-store" });
  if (r.ok) st.sources = (await r.json()).sources || [];
  buildSpeedPills();
  renderSourceCtrl();
  resetWindow();
  await load();
}

init();
