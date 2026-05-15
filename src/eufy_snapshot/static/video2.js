// ── Constants ─────────────────────────────────────
const V2_DENSITY = [
  { intervalSec: 300, label: "½H"  },
  { intervalSec:  60, label: "10M" },
  { intervalSec:  30, label: "ALL" },
  { intervalSec:  15, label: "LG"  },
  { intervalSec:   5, label: "XL"  },
];

const V2_SPEEDS = [
  { label: "½×",  rate: 0.5 },
  { label: "1×",  rate: 1.0 },
  { label: "2×",  rate: 2.0 },
  { label: "4×",  rate: 4.0 },
];

const V2_BOX_COLORS = {
  person:"#2aac6a",bird:"#20c0b0",cat:"#20c0b0",dog:"#20c0b0",
  car:"#c08020",truck:"#c08020",bus:"#c08020",motorcycle:"#c08020",bicycle:"#c08020",
};
const V2_MOBILE = new Set(["person","bird","cat","dog","bus","truck","motorcycle","bicycle"]);
const V2_ANIMAL = new Set(["bird","cat","dog"]);

// ── State ─────────────────────────────────────────
const v2 = {
  segments:    [],
  events:      [],
  detections:  {},   // segmentId -> [{ts_offset, boxes, classes}]
  sources:     [],
  source:      "all",
  date:        "",
  cls:         "all",
  density:     parseInt(localStorage.getItem("v2density") || "3", 10),
  speed:       parseInt(localStorage.getItem("v2speed") || "1", 10),
  live:        false,
  showBoxes:   localStorage.getItem("v2boxes") !== "0",
  loop:        true,
  curSeg:      null,   // current segment object
  curOff:      0,      // current offset in segment (seconds)
  playing:     false,
  classes:     {},
};

// ── Elements ──────────────────────────────────────
const v2el = {
  player:    document.getElementById("v2Player"),
  boxCanvas: document.getElementById("v2BoxCanvas"),
  empty:     document.getElementById("v2Empty"),
  filmstrip: document.getElementById("v2Filmstrip"),
  timestamp: document.getElementById("v2Timestamp"),
  hudSource: document.getElementById("v2HudSource"),
  hudTime:   document.getElementById("v2HudTime"),
  sourceCtrl:document.getElementById("v2SourceCtrl"),
  dateCtrl:  document.getElementById("v2DateCtrl"),
  classCtrl: document.getElementById("v2ClassCtrl"),
  classField:document.getElementById("v2ClassField"),
  playBtn:   document.getElementById("v2PlayBtn"),
  prev:      document.getElementById("v2Prev"),
  next:      document.getElementById("v2Next"),
  speedPills:document.getElementById("v2SpeedPills"),
  loopBtn:   document.getElementById("v2LoopBtn"),
  timeDisp:  document.getElementById("v2TimeDisp"),
  speedDisp: document.getElementById("v2SpeedDisp"),
  boxToggle: document.getElementById("v2BoxToggle"),
  densityBtns:document.getElementById("v2DensityBtns"),
  jumpLatest:document.getElementById("v2JumpLatest"),
  liveBtn:   document.getElementById("v2LiveBtn"),
  goLiveBtn: document.getElementById("v2GoLiveBtn"),
  refresh:   document.getElementById("v2RefreshStatus"),
};

// ── Filmstrip frame map ───────────────────────────
// Maps: {segId}_{t} -> DOM element
const v2FrameMap = new Map();
let v2ActiveFrameEl = null;
let v2NewSegCount   = 0; // count of new segments not yet scrolled to
const v2Observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const img = e.target.querySelector("img");
      if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
      v2Observer.unobserve(e.target);
    }
  });
}, { rootMargin: "200px" });

// ── Init ──────────────────────────────────────────
async function v2Init() {
  const r = await fetch("/api/sources", { cache: "no-store" });
  if (r.ok) v2.sources = (await r.json()).sources || [];
  v2BuildDensityBtns(); v2ApplyDensity(v2.density);
  v2BuildSpeedPills();
  v2RenderSourceCtrl();
  await v2LoadTimeline();
  setInterval(async () => {
    if (v2el.refresh) v2el.refresh.textContent = "SYNC";
    await v2LoadTimeline(true);
    if (v2el.refresh) v2el.refresh.textContent = "AUTO";
  }, 10000);
}

// ── Density ───────────────────────────────────────
function v2BuildDensityBtns() {
  v2el.densityBtns.innerHTML = "";
  V2_DENSITY.forEach((d, i) => {
    const btn = document.createElement("button");
    btn.className = "density-btn" + (i + 1 === v2.density ? " active" : "");
    btn.textContent = d.label;
    btn.title = `1 thumb per ${d.intervalSec}s`;
    btn.addEventListener("click", () => v2ApplyDensity(i + 1));
    v2el.densityBtns.appendChild(btn);
  });
}

function v2ApplyDensity(level) {
  v2.density = level; localStorage.setItem("v2density", level);
  document.documentElement.style.setProperty("--frame-w", `${[38,56,78,100,130][level-1]}px`);
  document.documentElement.style.setProperty("--frame-h", `${[22,32,44,56,73][level-1]}px`);
  Array.from(v2el.densityBtns.children).forEach((b, i) =>
    b.classList.toggle("active", i + 1 === level));
  v2RenderFilmstrip();
}

// ── Speed ─────────────────────────────────────────
function v2BuildSpeedPills() {
  v2el.speedPills.innerHTML = "";
  V2_SPEEDS.forEach((s, i) => {
    const btn = document.createElement("button");
    btn.className = "speed-pill" + (i === v2.speed ? " active" : "");
    btn.textContent = s.label;
    btn.addEventListener("click", () => {
      v2.speed = i; localStorage.setItem("v2speed", i);
      v2el.player.playbackRate = V2_SPEEDS[i].rate;
      v2BuildSpeedPills();
    });
    v2el.speedPills.appendChild(btn);
  });
}

// ── Source selector ───────────────────────────────
function v2RenderSourceCtrl() {
  v2el.sourceCtrl.innerHTML = "";
  const sources = v2.sources.filter(s => s.type === "rtsp");
  if (!sources.length) { v2el.sourceCtrl.closest(".field").style.display = "none"; return; }
  const pills = document.createElement("div"); pills.className = "source-pills";
  [{ id: "all", name: "ALL" }, ...sources].forEach(s => {
    const btn = document.createElement("button");
    btn.className = "source-pill" + (v2.source === s.id ? " active" : "");
    btn.textContent = s.name || s.id;
    btn.addEventListener("click", () => {
      v2.source = s.id; v2.date = "";
      v2RenderSourceCtrl(); v2LoadTimeline();
    });
    pills.appendChild(btn);
  });
  v2el.sourceCtrl.appendChild(pills);
}

// ── Load timeline ─────────────────────────────────
const v2NewBadge = document.getElementById("v2NewBadge");
if (v2NewBadge) v2NewBadge.addEventListener("click", () => {
  v2NewBadge.hidden = true;
  if (v2.segments.length) {
    const latest = v2.segments[0];
    v2LoadSegment(latest, Math.max(0, (latest.end_ts||0) - latest.start_ts - 5));
  }
});

async function v2LoadTimeline(incremental = false) {
  const prevCount = v2.segments.length;
  const p = new URLSearchParams();
  if (v2.source !== "all") p.set("source", v2.source);
  const r = await fetch(`/api/video2/timeline?${p}`, { cache: "no-store" });
  if (!r.ok) return;
  const { segments } = await r.json();
  const newCount = segments.length - prevCount;
  v2.segments = segments;

  // Show new-frames badge if new segments arrived and user isn't in LIVE mode
  if (incremental && newCount > 0 && !v2.live && v2NewBadge) {
    v2NewBadge.textContent = `↓ ${newCount} NEW`;
    v2NewBadge.hidden = false;
  }

  // Load events for class filter
  const ep = new URLSearchParams({ limit: "500" });
  if (v2.source !== "all") ep.set("source", v2.source);
  const er = await fetch(`/api/video/events?${ep}`, { cache: "no-store" });
  if (er.ok) v2.events = (await er.json()).events || [];

  // Class counts
  const cp = new URLSearchParams();
  if (v2.source !== "all") cp.set("source", v2.source);
  const cr = await fetch(`/api/video/classes?${cp}`, { cache: "no-store" });
  if (cr.ok) v2.classes = (await cr.json()).classes || {};

  v2RenderDateCtrl();
  v2RenderClassCtrl();
  v2RenderFilmstrip();

  if (!incremental && v2.segments.length && !v2.curSeg) {
    // Auto-load most recent segment
    const latest = v2.segments[0];
    if (latest?.end_ts) v2LoadSegment(latest, Math.max(0, (latest.end_ts - latest.start_ts) - 5));
    else if (latest) v2LoadSegment(latest, 0);
  }

  // LIVE: jump to newest
  if (v2.live && v2.segments.length) {
    const latest = v2.segments[0];
    if (latest && v2.curSeg?.id !== latest.id) v2LoadSegment(latest, 0);
  }

  if (v2el.jumpLatest) {
    const isAtLatest = v2.curSeg?.id === v2.segments[0]?.id;
    v2el.jumpLatest.hidden = isAtLatest || !v2.segments.length;
  }
}

// ── Date selector ─────────────────────────────────
function v2RenderDateCtrl() {
  const dates = [...new Set(v2.segments.map(s =>
    new Date(s.start_ts * 1000).toLocaleDateString("sv")
  ))].sort().reverse();
  v2el.dateCtrl.innerHTML = "";
  if (!dates.length) { v2el.dateCtrl.closest(".field").style.display = "none"; return; }
  v2el.dateCtrl.closest(".field").style.display = "";
  const chips = document.createElement("div"); chips.className = "date-chips";
  const mk = (d, label) => {
    const b = document.createElement("button");
    b.className = "date-chip" + (v2.date === d ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => { v2.date = d; v2RenderDateCtrl(); v2RenderFilmstrip(); });
    chips.appendChild(b);
  };
  mk("", "ALL"); dates.forEach(d => mk(d, v2FmtDate(d)));
  v2el.dateCtrl.appendChild(chips);
}

function v2FmtDate(d) {
  const today = new Date().toLocaleDateString("sv");
  const yest  = new Date(Date.now()-86400000).toLocaleDateString("sv");
  if (d === today) return "TODAY";
  if (d === yest)  return "YESTERDAY";
  return new Date(d+"T12:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"});
}

// ── Class chips ───────────────────────────────────
function v2RenderClassCtrl() {
  v2el.classCtrl.innerHTML = "";
  const entries = [["all","ALL"], ...Object.entries(v2.classes).sort((a,b)=>b[1]-a[1])];
  if (entries.length <= 1) { v2el.classField.hidden = true; return; }
  v2el.classField.hidden = false;
  entries.forEach(([c, count]) => {
    const btn = document.createElement("button");
    btn.className = "class-chip" + (v2.cls === c ? " active" : "");
    btn.textContent = c === "all" ? "ALL" : `${c} ×${count}`;
    btn.addEventListener("click", () => { v2.cls = c; v2RenderClassCtrl(); v2RenderFilmstrip(); });
    v2el.classCtrl.appendChild(btn);
  });
}

// ── Filmstrip ─────────────────────────────────────
function v2FilteredSegments() {
  let segs = v2.segments;
  if (v2.date) segs = segs.filter(s => new Date(s.start_ts*1000).toLocaleDateString("sv") === v2.date);
  if (v2.cls !== "all") segs = segs.filter(s => s.classes?.[v2.cls] > 0);
  return segs.slice().reverse(); // oldest first for filmstrip
}

function v2RenderFilmstrip() {
  v2el.filmstrip.innerHTML = "";
  v2FrameMap.clear(); v2ActiveFrameEl = null;
  const segs = v2FilteredSegments();
  if (!segs.length) return;

  // Group by source
  const groups = new Map();
  segs.forEach(s => {
    if (!groups.has(s.source_id)) groups.set(s.source_id, []);
    groups.get(s.source_id).push(s);
  });

  const interval = V2_DENSITY[v2.density - 1].intervalSec;

  for (const [srcId, srcSegs] of groups) {
    const src = v2.sources.find(s => s.id === srcId);
    const stripEl = document.createElement("div"); stripEl.className = "strip";
    const labelEl = document.createElement("div"); labelEl.className = "strip-label";
    labelEl.textContent = src?.name || srcId; labelEl.title = src?.name || srcId;
    const framesEl = document.createElement("div"); framesEl.className = "frames";

    // Drag to scroll
    let _dx=0,_ds=0,_drag=false;
    framesEl.addEventListener("mousedown",e=>{if(e.button)return;_drag=true;_dx=e.pageX;_ds=framesEl.scrollLeft;framesEl.classList.add("dragging");e.preventDefault();});
    document.addEventListener("mousemove",e=>{if(_drag)framesEl.scrollLeft=_ds-(e.pageX-_dx);});
    document.addEventListener("mouseup",()=>{if(!_drag)return;_drag=false;framesEl.classList.remove("dragging");});
    framesEl.addEventListener("wheel",e=>{if(Math.abs(e.deltaX)>Math.abs(e.deltaY))return;e.preventDefault();framesEl.scrollLeft+=e.deltaY;},{passive:false});

    let lastHour = null;
    srcSegs.forEach(seg => {
      const dur = seg.end_ts ? (seg.end_ts - seg.start_ts) : 0;
      // Hour markers
      const segHour = Math.floor(seg.start_ts / 3600);
      if (lastHour !== null && segHour > lastHour) {
        for (let h = lastHour + 1; h <= segHour; h++) {
          const m = document.createElement("div"); m.className = "hour-mark";
          const ml = document.createElement("span"); ml.className = "hour-mark-label";
          ml.textContent = new Date(h * 3600000).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"});
          m.appendChild(ml); framesEl.appendChild(m);
        }
      }
      lastHour = Math.floor((seg.start_ts + dur) / 3600);

      // Thumbnails for this segment
      const steps = dur > 0 ? Math.max(1, Math.ceil(dur / interval)) : 1;
      for (let i = 0; i < steps; i++) {
        const t = Math.min(i * interval, Math.max(0, dur - 1)); // clamp to valid range
        if (i > 0 && t >= dur && dur > 0) break;
        const absTs = seg.start_ts + t;
        const frameEl = v2BuildFrame(seg, t, absTs);
        framesEl.appendChild(frameEl);
        v2FrameMap.set(`${seg.id}_${t}`, frameEl);
        v2Observer.observe(frameEl);
      }
    });

    stripEl.appendChild(labelEl); stripEl.appendChild(framesEl);
    v2el.filmstrip.appendChild(stripEl);
  }

  v2HighlightActiveFrame();
}

function v2BuildFrame(seg, t, absTs) {
  const frame = document.createElement("div");
  frame.className = "v2-frame";

  const img = document.createElement("img");
  img.alt = ""; img.loading = "lazy";
  img.dataset.src = `/api/thumb?path=${encodeURIComponent(seg.path)}&t=${t.toFixed(1)}`;
  img.onerror = () => frame.classList.add("v2-loading");

  const ts = document.createElement("div");
  ts.className = "v2-frame-ts";
  ts.textContent = new Date(absTs * 1000).toLocaleTimeString(undefined,
    {hour:"2-digit",minute:"2-digit",second:"2-digit"});

  frame.appendChild(img); frame.appendChild(ts);

  // Detection ticks at this timestamp region
  const dur = V2_DENSITY[v2.density - 1].intervalSec;
  const evtsHere = v2.events.filter(e =>
    e.source_id === seg.source_id && e.abs_ts >= absTs && e.abs_ts < absTs + dur
  );
  evtsHere.slice(0, 8).forEach(e => {
    const tick = document.createElement("div");
    const cls = V2_MOBILE.has(e.class) ? (V2_ANIMAL.has(e.class) ? "v2-tick-animal" : e.class === "person" ? "v2-tick-person" : "v2-tick-vehicle") : "v2-tick-vehicle";
    tick.className = `v2-det-tick ${cls}`;
    tick.style.left = `${((e.abs_ts - absTs) / dur) * 100}%`;
    frame.appendChild(tick);
  });

  frame.addEventListener("click", () => { v2LoadSegment(seg, t); });
  return frame;
}

// ── Load segment ──────────────────────────────────
function v2LoadSegment(seg, offset) {
  v2.curSeg = seg; v2.curOff = offset;
  const url = `/video/files/${seg.path}`;

  v2el.empty.style.display  = "none";
  v2el.player.style.display = "block";

  if (v2el.player.dataset.src !== url) {
    v2el.player.src = url;
    v2el.player.dataset.src = url;
    v2el.player.load();
    v2el.player.addEventListener("loadedmetadata", () => {
      v2el.player.currentTime = offset;
      if (v2.playing) v2el.player.play().catch(()=>{});
    }, { once: true });
  } else {
    v2el.player.currentTime = offset;
    if (v2.playing) v2el.player.play().catch(()=>{});
  }

  v2el.player.playbackRate = V2_SPEEDS[v2.speed].rate;

  // Load detections for this segment
  if (!v2.detections[seg.id]) {
    fetch(`/api/video/detections?segment_id=${seg.id}`, { cache: "no-store" })
      .then(r => r.json())
      .then(d => { v2.detections[seg.id] = d.detections || []; })
      .catch(() => {});
  }

  const src = v2.sources.find(s => s.id === seg.source_id);
  if (v2el.hudSource) v2el.hudSource.textContent = (src?.name || seg.source_id).toUpperCase();

  v2HighlightActiveFrame(true); // scroll on explicit load
}

function v2HighlightActiveFrame(forceScroll = false) {
  if (v2ActiveFrameEl) v2ActiveFrameEl.classList.remove("v2-active");
  v2ActiveFrameEl = null;
  if (!v2.curSeg) return;

  const interval = V2_DENSITY[v2.density - 1].intervalSec;
  const nearestT = Math.round(v2.curOff / interval) * interval;
  const key = `${v2.curSeg.id}_${nearestT}`;
  const el = v2FrameMap.get(key);
  if (el) {
    el.classList.add("v2-active");
    v2ActiveFrameEl = el;
    // Only scroll if user explicitly navigated or in LIVE mode
    if (forceScroll || v2.live) {
      const framesEl = el.closest(".frames");
      if (framesEl) framesEl.scrollTo({
        left: el.offsetLeft - framesEl.clientWidth / 2 + el.offsetWidth / 2,
        behavior: "smooth"
      });
    }
  }
}

// ── Player events ─────────────────────────────────
v2el.player.addEventListener("timeupdate", () => {
  const t = v2el.player.currentTime;
  const dur = v2el.player.duration || 1;
  v2.curOff = t;

  // Time display
  if (v2el.timeDisp) v2el.timeDisp.textContent = `${v2FmtSecs(t)} / ${v2FmtSecs(dur)}`;

  // HUD time
  if (v2el.hudTime && v2.curSeg) {
    const abs = v2.curSeg.start_ts + t;
    v2el.hudTime.textContent = new Date(abs * 1000).toLocaleTimeString(undefined,
      {hour:"2-digit",minute:"2-digit",second:"2-digit"});
  }

  // Timestamp in panel
  if (v2el.timestamp && v2.curSeg) {
    const src = v2.sources.find(s => s.id === v2.curSeg.source_id);
    const abs = v2.curSeg.start_ts + t;
    v2el.timestamp.textContent = `${src?.name || v2.curSeg.source_id} · ${new Date(abs*1000).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"medium"})}`;
  }

  // Update filmstrip highlight every ~5s
  if (Math.abs(t - (v2FrameMap._lastHighlightT || -999)) > V2_DENSITY[v2.density-1].intervalSec / 2) {
    v2FrameMap._lastHighlightT = t;
    v2HighlightActiveFrame();
  }

  v2DrawBoxes(t);
});

v2el.player.addEventListener("play",  () => { v2.playing = true;  v2el.playBtn.textContent = "■"; v2el.playBtn.classList.add("playing"); });
v2el.player.addEventListener("pause", () => { v2.playing = false; v2el.playBtn.textContent = "▶"; v2el.playBtn.classList.remove("playing"); });
v2el.player.addEventListener("ended", () => {
  // Auto-advance to next segment
  if (v2.curSeg) {
    const segs = v2FilteredSegments();
    const idx  = segs.findIndex(s => s.id === v2.curSeg.id);
    const next = segs[idx + 1];
    if (next) { v2LoadSegment(next, 0); if (v2.playing) v2el.player.play().catch(()=>{}); }
    else if (v2.loop && segs.length) { v2LoadSegment(segs[0], 0); if (v2.playing) v2el.player.play().catch(()=>{}); }
  }
});

// ── Box overlay ───────────────────────────────────
function v2DrawBoxes(t) {
  const canvas = v2el.boxCanvas;
  const video  = v2el.player;
  if (!canvas || !video.videoWidth || !v2.showBoxes) {
    if (canvas) { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight;
      canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height); }
    return;
  }
  canvas.width  = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const dets = v2.curSeg ? (v2.detections[v2.curSeg.id] || []) : [];
  if (!dets.length) return;

  const nearest = dets.reduce((best, d) =>
    Math.abs(d.ts_offset - t) < Math.abs((best?.ts_offset ?? Infinity) - t) ? d : best, null);
  if (!nearest || Math.abs(nearest.ts_offset - t) > 1.5) return;
  const boxes = nearest.boxes || [];
  if (!boxes.length) return;

  const cw = canvas.width, ch = canvas.height;
  const iw = video.videoWidth, ih = video.videoHeight;
  const scale = Math.min(cw/iw, ch/ih);
  const rw = iw*scale, rh = ih*scale;
  const ox = (cw-rw)/2, oy = (ch-rh)/2;
  const evtClass = v2.cls !== "all" ? v2.cls : null;

  boxes.forEach(box => {
    const isPrimary = !evtClass || box.cls === evtClass;
    const color = V2_BOX_COLORS[box.cls] || "#ccd8e4";
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
      ctx.globalAlpha = 1.0;
      ctx.fillStyle = "#050709"; ctx.fillText(label, x+2, ty+11);
    }
  });
  ctx.globalAlpha = 1.0;
}

// ── Controls ──────────────────────────────────────
v2el.playBtn.addEventListener("click", () => {
  v2.playing ? v2el.player.pause() : v2el.player.play().catch(()=>{});
});

v2el.prev.addEventListener("click", () => {
  // Seek to previous event or start of previous segment
  const evts = v2.events.filter(e => !v2.curSeg || e.source_id === v2.curSeg.source_id);
  const curAbs = v2.curSeg ? v2.curSeg.start_ts + v2el.player.currentTime : 0;
  const prev = evts.slice().reverse().find(e => e.abs_ts < curAbs - 2);
  if (prev) v2SeekToAbs(prev.abs_ts - 3);
});

v2el.next.addEventListener("click", () => {
  const evts = v2.events.filter(e => !v2.curSeg || e.source_id === v2.curSeg.source_id);
  const curAbs = v2.curSeg ? v2.curSeg.start_ts + v2el.player.currentTime : 0;
  const next = evts.find(e => e.abs_ts > curAbs + 2);
  if (next) v2SeekToAbs(next.abs_ts - 3);
});

function v2SeekToAbs(absTs) {
  const seg = v2.segments.find(s => s.start_ts <= absTs && (s.end_ts || Infinity) > absTs);
  if (!seg) return;
  const off = Math.max(0, absTs - seg.start_ts);
  v2LoadSegment(seg, off);
}

v2el.loopBtn.addEventListener("click", () => {
  v2.loop = !v2.loop;
  v2el.loopBtn.classList.toggle("active", v2.loop);
});

v2el.boxToggle.addEventListener("click", () => {
  v2.showBoxes = !v2.showBoxes;
  localStorage.setItem("v2boxes", v2.showBoxes ? "1" : "0");
  v2el.boxToggle.classList.toggle("active", v2.showBoxes);
  v2DrawBoxes(v2el.player.currentTime);
});
v2el.boxToggle.classList.toggle("active", v2.showBoxes);

v2el.liveBtn.addEventListener("click", () => {
  v2.live = !v2.live;
  v2el.liveBtn.classList.toggle("active", v2.live);
  v2el.liveBtn.textContent = v2.live ? "● LIVE" : "LIVE";
  if (v2.live && v2.segments.length) {
    const latest = v2.segments[0];
    v2LoadSegment(latest, Math.max(0, (latest.end_ts||0) - latest.start_ts - 3));
  }
});

v2el.jumpLatest.addEventListener("click", () => {
  if (v2.segments.length) {
    const latest = v2.segments[0];
    v2LoadSegment(latest, Math.max(0, (latest.end_ts||0) - latest.start_ts - 5));
  }
});

// Keyboard
document.addEventListener("keydown", e => {
  if (["INPUT","TEXTAREA","SELECT"].includes(e.target.tagName)) return;
  if (e.key === " ")           { e.preventDefault(); v2.playing ? v2el.player.pause() : v2el.player.play().catch(()=>{}); }
  else if (e.key === "ArrowLeft")  { v2el.player.currentTime = Math.max(0, v2el.player.currentTime - 5); }
  else if (e.key === "ArrowRight") { v2el.player.currentTime = Math.min(v2el.player.duration||999, v2el.player.currentTime + 5); }
});

// Click image to toggle play
v2el.player.addEventListener("click", () => {
  v2.playing ? v2el.player.pause() : v2el.player.play().catch(()=>{});
});
v2el.player.addEventListener("dblclick", () => {
  const stage = document.querySelector(".v2-stage");
  document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen().catch(()=>{});
});

// ── Utils ─────────────────────────────────────────
function v2FmtSecs(s) {
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return `${m}:${String(sec).padStart(2,"0")}`;
}

// ── Boot ──────────────────────────────────────────
v2Init();
