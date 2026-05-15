// ── State ─────────────────────────────────────────

const vState = {
  sources:     [],
  source:      "all",
  segments:    [],
  segment:     null,      // currently loaded segment object
  detections:  [],        // for current segment
  date:        "",
};

const BOX_COLORS = {
  person: "#2aac6a", bird: "#20c0b0", cat: "#20c0b0", dog: "#20c0b0",
  car: "#c08020", truck: "#c08020", bus: "#c08020", motorcycle: "#c08020", bicycle: "#c08020",
};
const VEHICLE_CLS = new Set(["car","truck","bus","motorcycle","bicycle"]);
const ANIMAL_CLS  = new Set(["bird","cat","dog"]);

// ── Elements ──────────────────────────────────────

const vEls = {
  player:       document.getElementById("videoPlayer"),
  boxCanvas:    document.getElementById("videoBoxCanvas"),
  empty:        document.getElementById("videoEmpty"),
  sourceCtrl:   document.getElementById("videoSourceCtrl"),
  segList:      document.getElementById("videoSegmentList"),
  scrubber:     document.getElementById("videoScrubber"),
  scrubBar:     document.getElementById("videoScrubberBar"),
  scrubHead:    document.getElementById("videoScrubberHead"),
  thumbCanvas:  document.getElementById("videoThumbCanvas"),
  scrubLabels:  document.getElementById("videoScrubberLabels"),
  hudSource:    document.getElementById("videoHudSource"),
  hudTime:      document.getElementById("videoHudTime"),
  dateCtrl:     document.getElementById("videoDateCtrl"),
};

// ── Load data ─────────────────────────────────────

async function init() {
  const sr = await fetch("/api/sources", { cache: "no-store" });
  if (sr.ok) {
    const d = await sr.json();
    vState.sources = d.sources || [];
  }
  renderSourceSelector();
  await loadSegments();
}

async function loadSegments() {
  const params = new URLSearchParams();
  if (vState.source && vState.source !== "all") params.set("source", vState.source);
  const r = await fetch(`/api/video/segments?${params}`, { cache: "no-store" });
  if (!r.ok) return;
  const d = await r.json();
  vState.segments = d.segments || [];
  renderDateSelector();
  renderSegmentList();
}

async function loadDetections(segmentId) {
  const r = await fetch(`/api/video/detections?segment_id=${segmentId}`, { cache: "no-store" });
  if (!r.ok) return;
  const d = await r.json();
  vState.detections = d.detections || [];
  renderScrubberTicks();
}

// ── Render source selector ─────────────────────────

function renderSourceSelector() {
  vEls.sourceCtrl.innerHTML = "";
  const sources = vState.sources.filter(s => s.type === "rtsp" || s.type === "rtsp");
  const all = makeSourceBtn("all", "ALL");
  vEls.sourceCtrl.appendChild(all);
  for (const s of sources) {
    vEls.sourceCtrl.appendChild(makeSourceBtn(s.id, s.name));
  }
}

function makeSourceBtn(id, label) {
  const btn = document.createElement("button");
  btn.className = "source-pill" + (vState.source === id ? " active" : "");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    vState.source = id;
    renderSourceSelector();
    loadSegments();
  });
  return btn;
}

// ── Date selector ─────────────────────────────────

function renderDateSelector() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dates = [...new Set(vState.segments.map(s =>
    new Date(s.start_ts * 1000).toLocaleDateString("sv") // YYYY-MM-DD
  ))].sort().reverse();

  vEls.dateCtrl.innerHTML = "";
  if (!dates.length) return;

  if (!vState.date || !dates.includes(vState.date)) vState.date = dates[0];

  const chips = document.createElement("div");
  chips.className = "date-chips";
  const allChip = document.createElement("button");
  allChip.className = "date-chip" + (!vState.date ? " active" : "");
  allChip.textContent = "ALL";
  allChip.addEventListener("click", () => { vState.date = ""; renderDateSelector(); renderSegmentList(); });
  chips.appendChild(allChip);

  for (const d of dates) {
    const btn = document.createElement("button");
    btn.className = "date-chip" + (vState.date === d ? " active" : "");
    btn.textContent = formatDateLabel(d);
    btn.addEventListener("click", () => { vState.date = d; renderDateSelector(); renderSegmentList(); });
    chips.appendChild(btn);
  }
  vEls.dateCtrl.appendChild(chips);
}

function formatDateLabel(dateStr) {
  const today = new Date().toLocaleDateString("sv");
  const yest  = new Date(Date.now() - 86400000).toLocaleDateString("sv");
  if (dateStr === today) return "TODAY";
  if (dateStr === yest)  return "YESTERDAY";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Segment list ──────────────────────────────────

function renderSegmentList() {
  vEls.segList.innerHTML = "";
  let segs = vState.segments;
  if (vState.date) {
    segs = segs.filter(s =>
      new Date(s.start_ts * 1000).toLocaleDateString("sv") === vState.date
    );
  }
  if (!segs.length) {
    vEls.segList.innerHTML = '<div style="padding:12px;font-size:.58rem;color:var(--text-lo)">No segments</div>';
    return;
  }
  for (const seg of segs) {
    vEls.segList.appendChild(makeSegmentItem(seg));
  }
}

function makeSegmentItem(seg) {
  const el = document.createElement("div");
  el.className = "video-segment-item" + (vState.segment?.id === seg.id ? " active" : "");

  const start = new Date(seg.start_ts * 1000);
  const dur   = seg.end_ts ? Math.round(seg.end_ts - seg.start_ts) : null;

  const t = document.createElement("div");
  t.className = "vseg-time";
  t.textContent = start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const m = document.createElement("div");
  m.className = "vseg-meta";
  m.textContent = dur ? `${Math.floor(dur/60)}m${dur%60}s` : "recording…";

  el.appendChild(t);
  el.appendChild(m);

  el.addEventListener("click", () => loadSegment(seg));
  return el;
}

// ── Load segment into player ──────────────────────

async function loadSegment(seg) {
  vState.segment = seg;
  vState.detections = [];
  renderSegmentList();

  const url = `/video/files/${seg.path}`;
  vEls.player.src = url;
  vEls.player.load();

  // WebVTT trickplay
  for (const t of Array.from(vEls.player.textTracks)) {
    vEls.player.removeChild(t.track?.owner);
  }
  if (seg.webvtt) {
    const track = document.createElement("track");
    track.kind    = "metadata";
    track.src     = `/video/files/${seg.webvtt}`;
    track.default = true;
    vEls.player.appendChild(track);
  }

  vEls.empty.style.display  = "none";
  vEls.player.style.display = "block";

  if (vState.segment.id) await loadDetections(seg.id);

  const dur = seg.end_ts ? seg.end_ts - seg.start_ts : 300;
  renderScrubberLabels(seg.start_ts, dur);

  if (vEls.hudSource) {
    const src = vState.sources.find(s => s.id === seg.source_id);
    vEls.hudSource.textContent = (src?.name || seg.source_id).toUpperCase();
  }
}

// ── Scrubber ──────────────────────────────────────

function renderScrubberTicks() {
  // Remove old ticks
  for (const el of vEls.scrubber.querySelectorAll(".vtick")) el.remove();
  if (!vState.segment) return;

  const dur = vState.segment.end_ts
    ? vState.segment.end_ts - vState.segment.start_ts
    : 300;

  for (const det of vState.detections) {
    const pct = (det.ts_offset / dur) * 100;
    const tick = document.createElement("div");
    tick.className = "vtick " + tickClass(det.classes);
    tick.style.left = `${pct}%`;
    vEls.scrubber.appendChild(tick);
  }
}

function tickClass(classes) {
  if (!classes?.length) return "vtick-vehicle";
  if (classes.some(c => c === "person")) return "vtick-person";
  if (classes.some(c => ANIMAL_CLS.has(c))) return "vtick-animal";
  return "vtick-vehicle";
}

function renderScrubberLabels(startTs, dur) {
  vEls.scrubLabels.innerHTML = "";
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const t = startTs + (dur * i / n);
    const d = new Date(t * 1000);
    const span = document.createElement("span");
    span.textContent = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    vEls.scrubLabels.appendChild(span);
  }
}

// Scrubber click/drag → seek
let _scrubDragging = false;

function scrubSeek(e) {
  if (!vState.segment) return;
  const rect = vEls.scrubber.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const dur = vState.segment.end_ts
    ? vState.segment.end_ts - vState.segment.start_ts : 300;
  vEls.player.currentTime = ratio * dur;
}

vEls.scrubber.addEventListener("mousedown", e => { _scrubDragging = true; scrubSeek(e); e.preventDefault(); });
document.addEventListener("mousemove", e => { if (_scrubDragging) scrubSeek(e); });
document.addEventListener("mouseup",   () => { _scrubDragging = false; });

// Scrubber hover → trickplay thumbnail
vEls.scrubber.addEventListener("mousemove", e => {
  if (!vState.segment?.spritesheet) { vEls.thumbCanvas.style.display = "none"; return; }
  const rect = vEls.scrubber.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const dur = vState.segment.end_ts
    ? vState.segment.end_ts - vState.segment.start_ts : 300;
  const ts_offset = ratio * dur;
  drawSpriteThumbnail(ts_offset, e.clientX - rect.left);
});
vEls.scrubber.addEventListener("mouseleave", () => { vEls.thumbCanvas.style.display = "none"; });

const _spriteCache = {};

function drawSpriteThumbnail(tsOffset, xPos) {
  const seg = vState.segment;
  if (!seg?.spritesheet) return;
  const spriteUrl = `/video/files/${seg.spritesheet}`;
  const INTERVAL = 5, W = 160, H = 90, COLS = 10;
  const tileIdx = Math.floor(tsOffset / INTERVAL);
  const col = tileIdx % COLS, row = Math.floor(tileIdx / COLS);

  const tc = vEls.thumbCanvas;
  tc.width = W; tc.height = H;
  tc.style.display = "block";
  tc.style.left = `${Math.max(0, xPos - W/2)}px`;

  const ctx = tc.getContext("2d");

  const draw = (img) => {
    ctx.drawImage(img, col * W, row * H, W, H, 0, 0, W, H);
    // Overlay bounding boxes for nearest detection
    const nearest = vState.detections.reduce((best, d) =>
      Math.abs(d.ts_offset - tsOffset) < Math.abs((best?.ts_offset ?? Infinity) - tsOffset) ? d : best,
    null);
    if (nearest?.boxes) drawBoxesOnThumb(ctx, nearest.boxes, W, H);
  };

  if (_spriteCache[spriteUrl]) { draw(_spriteCache[spriteUrl]); return; }
  const img = new Image();
  img.onload = () => { _spriteCache[spriteUrl] = img; draw(img); };
  img.src = spriteUrl;
}

function drawBoxesOnThumb(ctx, boxes, w, h) {
  for (const box of boxes) {
    const color = BOX_COLORS[box.cls] || "#ccd8e4";
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x1 * w, box.y1 * h, (box.x2 - box.x1) * w, (box.y2 - box.y1) * h);
  }
}

// ── Video player events ───────────────────────────

vEls.player.addEventListener("timeupdate", () => {
  const t = vEls.player.currentTime;
  const seg = vState.segment;
  if (!seg) return;
  const dur = vEls.player.duration || (seg.end_ts ? seg.end_ts - seg.start_ts : 300);

  // Update scrubber bar + head
  const pct = dur ? (t / dur) * 100 : 0;
  vEls.scrubBar.style.width = `${pct}%`;
  vEls.scrubHead.style.left = `${pct}%`;

  // HUD time
  const absTs = seg.start_ts + t;
  if (vEls.hudTime) vEls.hudTime.textContent = new Date(absTs * 1000).toLocaleTimeString();

  // Box overlay
  drawVideoBoxes(t);
});

function drawVideoBoxes(currentTime) {
  const canvas = vEls.boxCanvas;
  if (!canvas) return;
  const video = vEls.player;

  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!vState.detections.length || !video.videoWidth) return;

  // Find nearest detection within 0.6s
  const nearest = vState.detections.reduce((best, d) =>
    Math.abs(d.ts_offset - currentTime) < Math.abs((best?.ts_offset ?? Infinity) - currentTime) ? d : best,
  null);
  if (!nearest || Math.abs(nearest.ts_offset - currentTime) > 0.6) return;
  if (!nearest.boxes?.length) return;

  const cw = canvas.width, ch = canvas.height;
  const iw = video.videoWidth, ih = video.videoHeight;
  const scale = Math.min(cw / iw, ch / ih);
  const rw = iw * scale, rh = ih * scale;
  const ox = (cw - rw) / 2, oy = (ch - rh) / 2;

  for (const box of nearest.boxes) {
    const x = ox + box.x1 * rw, y = oy + box.y1 * rh;
    const w = (box.x2 - box.x1) * rw, h = (box.y2 - box.y1) * rh;
    const color = BOX_COLORS[box.cls] || "#ccd8e4";
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    const label = `${box.cls} ${Math.round(box.conf * 100)}%`;
    ctx.font = "bold 11px 'IBM Plex Mono', monospace";
    const tw = ctx.measureText(label).width + 6;
    const ty = y > 18 ? y - 18 : y + h;
    ctx.fillStyle = color; ctx.fillRect(x - 1, ty, tw, 16);
    ctx.fillStyle = "#050709"; ctx.fillText(label, x + 2, ty + 11);
  }
}

// ── Init ──────────────────────────────────────────

init();
