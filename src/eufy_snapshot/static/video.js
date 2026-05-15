// ── State ─────────────────────────────────────────
const vs = {
  sources:   [],
  source:    "all",
  date:      "",
  cls:       "all",
  events:    [],
  eventIdx:  -1,   // index into vs.events of current event
  classes:   {},
};

const BOX_COLORS = {
  person: "#2aac6a", bird: "#20c0b0", cat: "#20c0b0", dog: "#20c0b0",
  car: "#c08020", truck: "#c08020", bus: "#c08020",
  motorcycle: "#c08020", bicycle: "#c08020",
};

// ── Elements ──────────────────────────────────────
const $ = id => document.getElementById(id);
const vEls = {
  player:    $("videoPlayer"),
  boxCanvas: $("videoBoxCanvas"),
  empty:     $("videoEmpty"),
  sourceCtrl:$("videoSourceCtrl"),
  dateCtrl:  $("videoDateCtrl"),
  classCtrl: $("videoClassCtrl"),
  eventList: $("videoEventList"),
  scrubber:  $("videoScrubber"),
  progress:  $("videoProgress"),
  head:      $("videoHead"),
  scrubLabels:$("videoScrubLabels"),
  hudSource: $("videoHudSource"),
  hudTime:   $("videoHudTime"),
  playBtn:   $("videoPlay"),
  prevBtn:   $("videoPrev"),
  nextBtn:   $("videoNext"),
  timeDisp:  $("videoTime"),
  fullBtn:   $("videoFull"),
  liveBadge: $("videoLive"),
};

// ── Init ──────────────────────────────────────────
async function init() {
  const r = await fetch("/api/sources", { cache: "no-store" });
  if (r.ok) vs.sources = (await r.json()).sources || [];
  renderSourceCtrl();
  await refresh();
  setInterval(refresh, 10000);
}

async function refresh() {
  await Promise.all([loadClasses(), loadEvents()]);
}

// ── Data loading ──────────────────────────────────
async function loadClasses() {
  const p = new URLSearchParams();
  if (vs.source !== "all") p.set("source", vs.source);
  const r = await fetch(`/api/video/classes?${p}`, { cache: "no-store" });
  if (r.ok) vs.classes = (await r.json()).classes || {};
  renderClassCtrl();
}

async function loadEvents() {
  const p = new URLSearchParams({ limit: "200" });
  if (vs.source !== "all") p.set("source", vs.source);
  if (vs.cls    !== "all") p.set("class",  vs.cls);
  if (vs.date)              p.set("date",   vs.date);
  const r = await fetch(`/api/video/events?${p}`, { cache: "no-store" });
  if (!r.ok) return;
  const fresh = (await r.json()).events || [];

  const prevLen = vs.events.length;
  vs.events = fresh;

  renderDateCtrl();
  renderEventList();

  // Auto-load most recent on first load
  if (prevLen === 0 && vs.events.length > 0 && vs.eventIdx < 0) {
    loadEvent(0);
  }
}

// ── Source selector ───────────────────────────────
function renderSourceCtrl() {
  vEls.sourceCtrl.innerHTML = "";
  const sources = vs.sources.filter(s => s.type === "rtsp");
  [{ id: "all", name: "ALL" }, ...sources].forEach(s => {
    const btn = document.createElement("button");
    btn.className = "source-pill" + (vs.source === s.id ? " active" : "");
    btn.textContent = s.name || s.id;
    btn.addEventListener("click", () => {
      vs.source = s.id; vs.cls = "all"; vs.date = "";
      renderSourceCtrl(); refresh();
    });
    vEls.sourceCtrl.appendChild(btn);
  });
}

// ── Date selector ─────────────────────────────────
function renderDateCtrl() {
  const dates = [...new Set(vs.events.map(e =>
    new Date(e.abs_ts * 1000).toLocaleDateString("sv")
  ))].sort().reverse();

  vEls.dateCtrl.innerHTML = "";
  if (!dates.length) return;

  const chip = (d, label) => {
    const b = document.createElement("button");
    b.className = "date-chip" + (vs.date === d ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => { vs.date = d; refresh(); });
    vEls.dateCtrl.appendChild(b);
  };
  chip("", "ALL");
  dates.forEach(d => chip(d, fmtDateLabel(d)));
}

function fmtDateLabel(d) {
  const today = new Date().toLocaleDateString("sv");
  const yest  = new Date(Date.now()-86400000).toLocaleDateString("sv");
  if (d === today) return "TODAY";
  if (d === yest)  return "YESTERDAY";
  return new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Class chips ───────────────────────────────────
function renderClassCtrl() {
  vEls.classCtrl.innerHTML = "";
  const entries = [["all", "ALL"], ...Object.entries(vs.classes).sort((a,b) => b[1]-a[1])];
  entries.forEach(([c, count]) => {
    const btn = document.createElement("button");
    btn.className = "class-chip" + (vs.cls === c ? " active" : "");
    btn.textContent = c === "all" ? "ALL" : `${c} ×${count}`;
    btn.addEventListener("click", () => { vs.cls = c; loadEvents(); });
    vEls.classCtrl.appendChild(btn);
  });
}

// ── Event list ────────────────────────────────────
function renderEventList() {
  vEls.eventList.innerHTML = "";
  if (!vs.events.length) {
    vEls.eventList.innerHTML = '<div class="video-empty-state">No events yet</div>';
    return;
  }
  vs.events.forEach((evt, i) => {
    vEls.eventList.appendChild(makeEventItem(evt, i));
  });
}

function makeEventItem(evt, idx) {
  const el = document.createElement("div");
  el.className = "video-event-item" + (vs.eventIdx === idx ? " active" : "");

  // Thumbnail from spritesheet
  const thumb = document.createElement("div");
  thumb.className = "vei-thumb";
  if (evt.spritesheet) {
    thumb.style.cssText = spriteCss(evt);
  }
  el.appendChild(thumb);

  const meta = document.createElement("div");
  meta.className = "vei-meta";

  const cls = document.createElement("div");
  cls.className = `vei-class vei-class-${evt.class}`;
  cls.textContent = evt.class.toUpperCase();

  const t = document.createElement("div");
  t.className = "vei-time";
  t.textContent = new Date(evt.abs_ts * 1000).toLocaleTimeString(undefined,
    { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const src = document.createElement("div");
  src.className = "vei-dur";
  const dur = Math.round(evt.end_off - evt.start_off);
  const srcName = vs.sources.find(s => s.id === evt.source_id)?.name || evt.source_id;
  src.textContent = `${srcName} · ${dur > 0 ? dur + "s" : "<1s"}`;

  meta.appendChild(cls); meta.appendChild(t); meta.appendChild(src);
  el.appendChild(meta);
  el.addEventListener("click", () => loadEvent(idx));
  return el;
}

function spriteCss(evt) {
  const INTERVAL = 5, W = 160, H = 90, COLS = 10;
  const tile = Math.floor(evt.start_off / INTERVAL);
  const col = tile % COLS, row = Math.floor(tile / COLS);
  const url = `/video/files/${evt.spritesheet}`;
  const scale = 1 / (W / 64); // thumb width = 64px
  return `background-image:url('${url}');background-size:${COLS*W*scale}px auto;` +
         `background-position:-${col*W*scale}px -${row*H*scale}px;background-repeat:no-repeat`;
}

// ── Load event into player ────────────────────────
const PRE_BUFFER = 5; // seconds before event to start playback

function loadEvent(idx) {
  const evt = vs.events[idx];
  if (!evt) return;
  vs.eventIdx = idx;

  // Update list highlight
  for (const el of vEls.eventList.querySelectorAll(".video-event-item")) {
    el.classList.remove("active");
  }
  vEls.eventList.children[idx]?.classList.add("active");
  vEls.eventList.children[idx]?.scrollIntoView({ block: "nearest" });

  // Load video
  const url = `/video/files/${evt.seg_path}`;
  if (vEls.player.dataset.src !== url) {
    vEls.player.src = url;
    vEls.player.dataset.src = url;
    vEls.player.load();
  }

  vEls.empty.style.display  = "none";
  vEls.player.style.display = "block";

  const seekTo = Math.max(0, evt.start_off - PRE_BUFFER);
  vEls.player.addEventListener("loadedmetadata", function onMeta() {
    vEls.player.removeEventListener("loadedmetadata", onMeta);
    vEls.player.currentTime = seekTo;
    vEls.player.play().catch(() => {});
  }, { once: true });

  // HUD
  const srcName = vs.sources.find(s => s.id === evt.source_id)?.name || evt.source_id;
  if (vEls.hudSource) vEls.hudSource.textContent = srcName.toUpperCase();

  renderScrubLabels(evt);
  updateNavBtns();
}

function renderScrubLabels(evt) {
  vEls.scrubLabels.innerHTML = "";
  const dur = vEls.player.duration || (evt.end_off + 30);
  [0, 0.25, 0.5, 0.75, 1].forEach(r => {
    const s = document.createElement("span");
    const t = r * dur;
    s.textContent = fmtSecs(t);
    vEls.scrubLabels.appendChild(s);
  });
}

// ── Player events ─────────────────────────────────
vEls.player.addEventListener("timeupdate", () => {
  const t = vEls.player.currentTime;
  const dur = vEls.player.duration || 1;
  const pct = (t / dur) * 100;
  vEls.progress.style.width = `${pct}%`;
  vEls.head.style.left      = `${pct}%`;
  vEls.timeDisp.textContent = `${fmtSecs(t)} / ${fmtSecs(dur)}`;
  if (vEls.hudTime) {
    const evt = vs.events[vs.eventIdx];
    if (evt) vEls.hudTime.textContent =
      new Date((evt.abs_ts - evt.start_off + t) * 1000).toLocaleTimeString();
  }
  drawBoxes(t);
});

vEls.player.addEventListener("play",  () => { vEls.playBtn.textContent = "■"; });
vEls.player.addEventListener("pause", () => { vEls.playBtn.textContent = "▶"; });

// Scrubber
vEls.scrubber.addEventListener("click", e => {
  const rect = vEls.scrubber.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  vEls.player.currentTime = ratio * (vEls.player.duration || 0);
});

// Controls
vEls.playBtn.addEventListener("click", () => {
  vEls.player.paused ? vEls.player.play() : vEls.player.pause();
});
vEls.prevBtn.addEventListener("click", () => {
  if (vs.eventIdx < vs.events.length - 1) loadEvent(vs.eventIdx + 1);
});
vEls.nextBtn.addEventListener("click", () => {
  if (vs.eventIdx > 0) loadEvent(vs.eventIdx - 1);
});
vEls.fullBtn.addEventListener("click", () => {
  const stage = document.querySelector(".video-stage");
  document.fullscreenElement ? document.exitFullscreen()
    : stage.requestFullscreen().catch(() => {});
});

function updateNavBtns() {
  vEls.prevBtn.disabled = vs.eventIdx >= vs.events.length - 1;
  vEls.nextBtn.disabled = vs.eventIdx <= 0;
}

// ── Box overlay ───────────────────────────────────
function drawBoxes(t) {
  const canvas = vEls.boxCanvas;
  const video  = vEls.player;
  const evt    = vs.events[vs.eventIdx];
  if (!canvas || !evt) return;

  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!video.videoWidth) return;

  // Show boxes only within the event window
  const off = t;
  if (off < evt.start_off - PRE_BUFFER - 0.5 || off > evt.end_off + 1) return;

  const boxes = evt.boxes_json ? JSON.parse(evt.boxes_json) : [];
  if (!boxes.length) return;

  const cw = canvas.width, ch = canvas.height;
  const iw = video.videoWidth, ih = video.videoHeight;
  const scale = Math.min(cw / iw, ch / ih);
  const rw = iw*scale, rh = ih*scale;
  const ox = (cw-rw)/2, oy = (ch-rh)/2;

  for (const box of boxes) {
    const color = BOX_COLORS[box.cls] || "#ccd8e4";
    const x = ox + box.x1*rw, y = oy + box.y1*rh;
    const w = (box.x2-box.x1)*rw, h = (box.y2-box.y1)*rh;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    const label = `${box.cls} ${Math.round(box.conf*100)}%`;
    ctx.font = "bold 11px 'IBM Plex Mono',monospace";
    const tw = ctx.measureText(label).width + 6;
    const ty = y > 18 ? y-18 : y+h;
    ctx.fillStyle = color; ctx.fillRect(x-1, ty, tw, 16);
    ctx.fillStyle = "#050709"; ctx.fillText(label, x+2, ty+11);
  }
}

// ── Utils ─────────────────────────────────────────
function fmtSecs(s) {
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${String(sec).padStart(2,"0")}`;
}

// ── Boot ──────────────────────────────────────────
init();
