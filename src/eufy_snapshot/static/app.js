// ── Constants ─────────────────────────────────────────────

const DENSITY = [
  { w: 38,  h: 22, sampleMinutes: 30, desc: "1 FRAME · 30 MIN" },
  { w: 56,  h: 32, sampleMinutes: 10, desc: "1 FRAME · 10 MIN" },
  { w: 78,  h: 44, sampleMinutes:  0, desc: "ALL FRAMES"       },
  { w: 100, h: 56, sampleMinutes:  0, desc: "ALL FRAMES · LG"  },
  { w: 130, h: 73, sampleMinutes:  0, desc: "ALL FRAMES · XL"  },
];

const SPEEDS = [
  { label: "SLOW",   ms: 200 },
  { label: "NORM",   ms: 50  },
  { label: "FAST",   ms: 16  },
];

// ── State ─────────────────────────────────────────────────

const state = {
  images:           [],
  sources:          [],
  source:           "all",
  selected:         -1,
  date:             "",
  autoRefreshSeconds: 30,
  dbEnabled:        false,
  density:          parseInt(localStorage.getItem("density") || "3", 10),
  playSpeed:        parseInt(localStorage.getItem("playSpeed") || "1", 10),
  playing:          false,
  playTimer:        null,
  visibleIndices:   [],
};

// ── Elements ──────────────────────────────────────────────

const els = {
  snapshot:          document.getElementById("snapshot"),
  empty:             document.getElementById("empty"),
  timestamp:         document.getElementById("timestamp"),
  refreshStatus:     document.getElementById("refreshStatus"),
  prev:              document.getElementById("prev"),
  playBtn:           document.getElementById("playBtn"),
  next:              document.getElementById("next"),
  densitySlider:     document.getElementById("densitySlider"),
  densityDesc:       document.getElementById("densityDesc"),
  speedPills:        document.getElementById("speedPills"),
  frameCounter:      document.getElementById("frameCounter"),
  sourceField:       document.getElementById("sourceField"),
  sourceCtrl:        document.getElementById("sourceCtrl"),
  sourceMeta:        document.getElementById("sourceMeta"),
  dateField:         document.getElementById("dateField"),
  dateCtrl:          document.getElementById("dateCtrl"),
  filmstrip:         document.getElementById("filmstrip"),
  jumpLatest:        document.getElementById("jumpLatest"),
  rtspPanel:         document.getElementById("rtspPanel"),
  dbSourceList:      document.getElementById("dbSourceList"),
  addSourceForm:     document.getElementById("addSourceForm"),
  newSourceName:     document.getElementById("newSourceName"),
  newSourceUrl:      document.getElementById("newSourceUrl"),
  newSourceInterval: document.getElementById("newSourceInterval"),
  newSourceTransport:document.getElementById("newSourceTransport"),
  addSourceError:    document.getElementById("addSourceError"),
  hudSource:         document.getElementById("hudSource"),
  hudTimestamp:      document.getElementById("hudTimestamp"),
};

// ── Filmstrip internal state ──────────────────────────────

const stripState  = new Map();  // sourceId → { paths, framesEl, stripEl, lastTs, srcImages }
const pathIndex   = new Map();  // path → globalIndex
const frameElMap  = new Map();  // path → DOM frame element
let currentSelectedEl = null;

// ── Density & Speed init ──────────────────────────────────

function applyDensity(level) {
  const d = DENSITY[level - 1];
  document.documentElement.style.setProperty("--frame-w", `${d.w}px`);
  document.documentElement.style.setProperty("--frame-h", `${d.h}px`);
  state.density = level;
  localStorage.setItem("density", level);
  els.densitySlider.value = level;
  els.densityDesc.textContent = d.desc;
  // Full rebuild
  for (const [, s] of stripState) s.stripEl.remove();
  stripState.clear();
  frameElMap.clear();
  currentSelectedEl = null;
  renderFilmstrip();
}

function buildSpeedPills() {
  els.speedPills.innerHTML = "";
  SPEEDS.forEach((sp, i) => {
    const btn = document.createElement("button");
    btn.className = "speed-pill" + (i === state.playSpeed ? " active" : "");
    btn.textContent = sp.label;
    btn.addEventListener("click", () => {
      state.playSpeed = i;
      localStorage.setItem("playSpeed", i);
      buildSpeedPills();
      // Restart play at new speed if currently playing
      if (state.playing) { stopPlay(); startPlay(); }
    });
    els.speedPills.appendChild(btn);
  });
}

// ── Data loading ──────────────────────────────────────────

async function loadImages(preserveSelection = true) {
  const params = new URLSearchParams();
  if (state.source && state.source !== "all") params.set("source", state.source);
  if (state.date) params.set("date", state.date);
  const query = params.toString() ? `?${params}` : "";
  const response = await fetch(`/api/images${query}`, { cache: "no-store" });
  const payload = await response.json();
  const previousPath = state.images[state.selected]?.path;
  state.images = payload.images || [];
  renderDateSelector(payload.dates || []);
  if (preserveSelection && previousPath) {
    state.selected = state.images.findIndex(img => img.path === previousPath);
  }
  if (state.selected < 0 || state.selected >= state.images.length) {
    state.selected = state.images.length - 1;
  }
  render();
}

async function loadSources() {
  const r = await fetch("/api/sources", { cache: "no-store" });
  if (!r.ok) return;
  const payload = await r.json();
  state.sources = payload.sources || [];
  if (!state.sources.some(s => s.id === state.source)) state.source = "all";
  renderSourceSelector();
  renderSourceMeta();
  renderDbSources();
  // Staleness check
  const latest = state.images[state.images.length - 1]?.timestamp;
  if (latest) updateStaleness(latest);
}

// ── Adaptive selectors ────────────────────────────────────

function renderSourceSelector() {
  els.sourceCtrl.innerHTML = "";

  if (state.sources.length === 0) {
    els.sourceField.style.display = "none";
    return;
  }
  els.sourceField.style.display = "";

  if (state.sources.length === 1) {
    const s = state.sources[0];
    const div = document.createElement("div");
    div.className = "source-static";
    div.textContent = s.name;
    els.sourceCtrl.appendChild(div);
    // Auto-select the only source
    if (state.source !== s.id) {
      state.source = "all";
    }
    return;
  }

  if (state.sources.length <= 5) {
    const pills = document.createElement("div");
    pills.className = "source-pills";
    // "All" pill
    pills.appendChild(makeSourcePill("all", "ALL"));
    for (const s of state.sources) {
      pills.appendChild(makeSourcePill(s.id, s.name));
    }
    els.sourceCtrl.appendChild(pills);
    return;
  }

  // Dropdown for 6+ sources
  const sel = document.createElement("select");
  const allOpt = document.createElement("option");
  allOpt.value = "all"; allOpt.textContent = "All sources";
  sel.appendChild(allOpt);
  for (const s of state.sources) {
    const opt = document.createElement("option");
    opt.value = s.id; opt.textContent = s.name;
    sel.appendChild(opt);
  }
  sel.value = state.source;
  sel.addEventListener("change", () => {
    stopPlay();
    state.source = sel.value;
    state.date = "";
    state.selected = -1;
    renderSourceMeta();
    loadImages(false);
  });
  els.sourceCtrl.appendChild(sel);
}

function makeSourcePill(id, label) {
  const btn = document.createElement("button");
  btn.className = "source-pill" + (state.source === id ? " active" : "");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    stopPlay();
    state.source = id;
    state.date = "";
    state.selected = -1;
    renderSourceSelector();
    renderSourceMeta();
    loadImages(false);
  });
  return btn;
}

function renderSourceMeta() {
  if (state.source === "all") {
    els.sourceMeta.textContent = `${state.sources.filter(s => s.enabled).length} sources`;
    return;
  }
  const s = state.sources.find(s => s.id === state.source);
  els.sourceMeta.textContent = s ? `${s.type} · every ${formatInterval(s.interval_seconds)}` : "";
}

function renderDateSelector(dates) {
  els.dateCtrl.innerHTML = "";

  if (dates.length === 0) {
    els.dateField.style.display = "none";
    return;
  }
  els.dateField.style.display = "";

  if (dates.length === 1) {
    const div = document.createElement("div");
    div.className = "date-static";
    div.textContent = formatDateLabel(dates[0]);
    els.dateCtrl.appendChild(div);
    if (state.date !== dates[0]) state.date = dates[0];
    return;
  }

  // Chips for any number of dates (horizontally scrollable)
  const row = document.createElement("div");
  row.className = "date-chips";

  // "ALL" chip
  row.appendChild(makeDateChip("", "ALL"));
  for (const d of dates) row.appendChild(makeDateChip(d, formatDateLabel(d)));

  els.dateCtrl.appendChild(row);

  // Scroll active chip into view
  requestAnimationFrame(() => {
    const active = row.querySelector(".date-chip.active");
    if (active) active.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
}

function makeDateChip(date, label) {
  const btn = document.createElement("button");
  const isActive = (date === "" && !state.date) || date === state.date;
  btn.className = "date-chip" + (isActive ? " active" : "");
  btn.textContent = label;
  btn.addEventListener("click", () => {
    stopPlay();
    state.date = date;
    state.selected = -1;
    loadImages(false);
  });
  return btn;
}

function formatDateLabel(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  const yest  = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (dateStr === today) return "TODAY";
  if (dateStr === yest)  return "YESTERDAY";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderDbSources() {
  if (!state.dbEnabled) return;
  els.dbSourceList.innerHTML = "";
  for (const s of state.sources.filter(s => s.mutable)) {
    const item = document.createElement("div");
    item.className = "db-source-item";
    const name = document.createElement("span");
    name.className = "db-source-name";
    name.textContent = s.name; name.title = s.name;
    const btn = document.createElement("button");
    btn.className = "btn-delete"; btn.textContent = "×"; btn.title = `Delete ${s.name}`;
    btn.addEventListener("click", () => deleteSource(s.id, s.name));
    item.appendChild(name); item.appendChild(btn);
    els.dbSourceList.appendChild(item);
  }
}

async function deleteSource(id, name) {
  if (!confirm(`Delete source "${name}"?`)) return;
  const r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) { const p = await r.json().catch(() => ({})); alert(p.error || "Delete failed"); return; }
  await loadSources(); await loadImages(false);
}

// ── Main render ───────────────────────────────────────────

let fadeTimer = null;

function setMainSrc(url, animate) {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  const img = els.snapshot;
  if (!animate || state.playing) {
    img.classList.remove("fading");
    img.src = url;
    return;
  }
  img.classList.add("fading");
  fadeTimer = setTimeout(() => {
    img.src = url;
    img.classList.remove("fading");
    fadeTimer = null;
  }, 85);
}

function render(animate = true) {
  const hasImages = state.images.length > 0;
  els.snapshot.style.display = hasImages ? "block" : "none";
  els.empty.style.display    = hasImages ? "none"  : "block";
  els.prev.disabled = !hasImages || state.selected <= 0;
  els.next.disabled = !hasImages || state.selected >= state.images.length - 1;

  // Frame counter
  if (els.frameCounter) {
    els.frameCounter.textContent = hasImages
      ? `${state.selected + 1} / ${state.images.length}`
      : "";
  }

  // Jump to latest
  if (els.jumpLatest) {
    els.jumpLatest.hidden = !hasImages || state.selected >= state.images.length - 1;
  }

  if (!hasImages) {
    els.timestamp.textContent = "--";
    els.snapshot.removeAttribute("src");
    if (els.hudSource)    els.hudSource.textContent = "";
    if (els.hudTimestamp) els.hudTimestamp.textContent = "";
    renderFilmstrip();
    return;
  }

  const image = state.images[state.selected];
  setMainSrc(`${image.url}?t=${encodeURIComponent(image.timestamp)}`, animate);
  els.timestamp.textContent = `${image.source_name} · ${formatTimestamp(image.timestamp)}`;
  if (els.hudSource)    els.hudSource.textContent = image.source_name.toUpperCase();
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(image.timestamp);
  renderFilmstrip();
}

// ── Filmstrip ─────────────────────────────────────────────

function countsBetween(allItems, sampledItems) {
  const counts = new Array(sampledItems.length).fill(0);
  const sampledTs = sampledItems.map(img => new Date(img.timestamp).getTime());
  let si = 0;
  for (const img of allItems) {
    const t = new Date(img.timestamp).getTime();
    while (si + 1 < sampledTs.length && sampledTs[si + 1] <= t) si++;
    counts[si]++;
  }
  return counts;
}

function subsample(images, sampleMinutes) {
  const threshold = sampleMinutes * 60000;
  const result = [];
  let lastTs = -Infinity;
  for (const img of images) {
    const ts = new Date(img.timestamp).getTime();
    if (ts - lastTs >= threshold) { result.push(img); lastTs = ts; }
  }
  return result;
}

function renderFilmstrip() {
  const d = DENSITY[state.density - 1];
  pathIndex.clear();
  state.images.forEach((img, i) => pathIndex.set(img.path, i));

  const groups = new Map();
  for (let i = 0; i < state.images.length; i++) {
    const img = state.images[i];
    if (!groups.has(img.source_id)) {
      groups.set(img.source_id, { sourceName: img.source_name, items: [] });
    }
    groups.get(img.source_id).items.push(img);
  }

  for (const [id, s] of stripState) {
    if (!groups.has(id)) {
      for (const p of s.paths) frameElMap.delete(p);
      s.stripEl.remove(); stripState.delete(id);
    }
  }

  state.visibleIndices = [];

  for (const [sourceId, group] of groups) {
    if (!stripState.has(sourceId)) {
      const stripEl   = document.createElement("div");
      stripEl.className = "strip";
      const label     = document.createElement("div");
      label.className = "strip-label";
      label.textContent = group.sourceName; label.title = group.sourceName;
      const framesEl  = document.createElement("div");
      framesEl.className = "frames";

      framesEl.addEventListener("mousemove", e => {
        if (els.snapshot.style.display === "none") return;
        const strip = stripState.get(sourceId);
        if (!strip?.srcImages?.length) return;
        const rect = framesEl.getBoundingClientRect();
        const x = framesEl.scrollLeft + (e.clientX - rect.left);
        const ratio = Math.min(1, Math.max(0, x / Math.max(1, framesEl.scrollWidth)));
        const img = strip.srcImages[Math.min(strip.srcImages.length - 1, Math.floor(ratio * strip.srcImages.length))];
        if (img) showPreview(img);
      });
      framesEl.addEventListener("mouseleave", restoreSelected);

      stripEl.appendChild(label);
      stripEl.appendChild(framesEl);
      els.filmstrip.appendChild(stripEl);
      stripState.set(sourceId, { paths: [], framesEl, stripEl, lastTs: null, srcImages: [] });
    }

    const strip   = stripState.get(sourceId);
    strip.srcImages = group.items;

    const sampled = d.sampleMinutes > 0 ? subsample(group.items, d.sampleMinutes) : group.items;
    const counts  = d.sampleMinutes > 0 ? countsBetween(group.items, sampled) : null;

    const isAppend =
      sampled.length >= strip.paths.length &&
      strip.paths.every((p, i) => sampled[i].path === p);

    if (!isAppend) {
      for (const p of strip.paths) frameElMap.delete(p);
      strip.framesEl.innerHTML = "";
      strip.paths   = [];
      strip.lastTs  = null;
    }

    for (let i = strip.paths.length; i < sampled.length; i++) {
      const img = sampled[i];
      const ts  = new Date(img.timestamp);
      if (strip.lastTs !== null) {
        const ph = Math.floor(strip.lastTs.getTime() / 3600000);
        const th = Math.floor(ts.getTime() / 3600000);
        for (let h = ph + 1; h <= th; h++) {
          strip.framesEl.appendChild(buildHourMarker(new Date(h * 3600000)));
        }
      }
      strip.framesEl.appendChild(buildFrame(img, counts ? counts[i] : 1));
      strip.paths.push(img.path);
      strip.lastTs = ts;
    }

    for (const path of strip.paths) {
      const idx = pathIndex.get(path);
      if (idx !== undefined) state.visibleIndices.push(idx);
    }
  }

  state.visibleIndices.sort((a, b) => a - b);

  // O(1) highlight update
  const selectedPath = state.images[state.selected]?.path;
  if (currentSelectedEl !== frameElMap.get(selectedPath)) {
    if (currentSelectedEl) currentSelectedEl.classList.remove("selected");
    currentSelectedEl = frameElMap.get(selectedPath) || null;
    if (currentSelectedEl) currentSelectedEl.classList.add("selected");
  }
  if (currentSelectedEl) {
    currentSelectedEl.scrollIntoView({
      behavior: state.playing ? "instant" : "smooth",
      block: "nearest", inline: "nearest",
    });
  }
}

function buildFrame(image, frameCount = 1) {
  const frame = document.createElement("div");
  frame.className = "frame";
  if (frameCount > 1) {
    frame.dataset.stacks = String(frameCount <= 8 ? 1 : frameCount <= 40 ? 2 : 3);
    frame.title = `~${frameCount} frames`;
  }

  const img = document.createElement("img");
  img.src = image.url.replace("/images/", "/thumbs/");
  img.alt = ""; img.loading = "lazy";

  const ts = document.createElement("div");
  ts.className = "frame-ts";
  ts.textContent = formatTime(image.timestamp);

  frame.appendChild(img);
  frame.appendChild(ts);
  frameElMap.set(image.path, frame);

  frame.addEventListener("click", () => {
    const idx = pathIndex.get(image.path);
    if (idx !== undefined) { state.selected = idx; render(); }
  });

  return frame;
}

function buildHourMarker(date) {
  const el    = document.createElement("div");
  el.className = "hour-mark";
  const label  = document.createElement("span");
  label.className = "hour-mark-label";
  label.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  el.appendChild(label);
  return el;
}

function showPreview(img) {
  els.snapshot.src = img.url;
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(img.timestamp);
  if (els.hudSource)    els.hudSource.textContent = img.source_name.toUpperCase();
}

function restoreSelected() {
  const sel = state.images[state.selected];
  if (!sel) return;
  els.snapshot.src = `${sel.url}?t=${encodeURIComponent(sel.timestamp)}`;
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(sel.timestamp);
  if (els.hudSource)    els.hudSource.textContent = sel.source_name.toUpperCase();
}

// ── Playback ──────────────────────────────────────────────

function startPlay() {
  const srcId = state.images[state.selected]?.source_id;
  const queue = srcId
    ? state.visibleIndices.filter(i => state.images[i]?.source_id === srcId)
    : state.visibleIndices;
  if (!queue.length) return;

  state.playing = true;
  els.playBtn.textContent = "■";
  els.playBtn.classList.add("playing");

  let pos = Math.max(0, queue.indexOf(state.selected));
  const ms = SPEEDS[state.playSpeed].ms;

  state.playTimer = setInterval(() => {
    pos = (pos + 1) % queue.length;
    state.selected = queue[pos];
    render(false); // no crossfade during play
  }, ms);
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  state.playing = false;
  els.playBtn.textContent = "▶";
  els.playBtn.classList.remove("playing");
}

function togglePlay() { state.playing ? stopPlay() : startPlay(); }

// ── Staleness ─────────────────────────────────────────────

function updateStaleness(latestTimestamp) {
  const ageMs = Date.now() - new Date(latestTimestamp).getTime();
  els.refreshStatus.classList.toggle("stale", ageMs > 5 * 60 * 1000);
}

// ── Controls ──────────────────────────────────────────────

els.prev.addEventListener("click", () => {
  stopPlay(); state.selected = Math.max(0, state.selected - 1); render();
});
els.next.addEventListener("click", () => {
  stopPlay(); state.selected = Math.min(state.images.length - 1, state.selected + 1); render();
});
els.playBtn.addEventListener("click", togglePlay);
els.jumpLatest.addEventListener("click", () => {
  state.selected = state.images.length - 1; render();
});

els.densitySlider.value = state.density;
els.densitySlider.addEventListener("input", () => {
  applyDensity(parseInt(els.densitySlider.value, 10));
});

document.addEventListener("keydown", e => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === " ")           { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft")  { stopPlay(); state.selected = Math.max(0, state.selected - 1); render(); }
  else if (e.key === "ArrowRight") { stopPlay(); state.selected = Math.min(state.images.length - 1, state.selected + 1); render(); }
});

els.addSourceForm.addEventListener("submit", async e => {
  e.preventDefault();
  els.addSourceError.hidden = true;
  const name = els.newSourceName.value.trim();
  const url  = els.newSourceUrl.value.trim();
  const iv   = els.newSourceInterval.value.trim();
  const body = { name, url, rtsp_transport: els.newSourceTransport.value };
  if (iv) body.interval_seconds = Number(iv);
  const r = await fetch("/api/sources", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) { els.addSourceError.textContent = p.error || "Failed to add source"; els.addSourceError.hidden = false; return; }
  els.addSourceForm.reset();
  await loadSources(); await loadImages(false);
});

// ── Auto-refresh ──────────────────────────────────────────

let refreshTimer = null;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    els.refreshStatus.textContent = "SYNC";
    Promise.all([loadSources(), loadImages(true)]).finally(() => {
      els.refreshStatus.textContent = "AUTO";
    });
  }, state.autoRefreshSeconds * 1000);
}

async function loadHealth() {
  const r = await fetch("/api/health", { cache: "no-store" });
  if (!r.ok) return;
  const p = await r.json();
  if (p.auto_refresh_seconds) state.autoRefreshSeconds = p.auto_refresh_seconds;
  if (p.db_enabled) { state.dbEnabled = true; els.rtspPanel.hidden = false; }
  if (p.latest?.timestamp) updateStaleness(p.latest.timestamp);
}

// ── Formatters ────────────────────────────────────────────

function formatTime(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatInterval(seconds) {
  const v = Number(seconds);
  if (!Number.isFinite(v)) return "--";
  if (v < 60) return `${Number.isInteger(v) ? v : v.toFixed(1)}s`;
  const m = v / 60;
  return Number.isInteger(m) ? `${m}m` : `${m.toFixed(1)}m`;
}

function formatTimestamp(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(d);
}

// ── Init ──────────────────────────────────────────────────

applyDensity(state.density);
buildSpeedPills();

loadHealth().finally(() => {
  loadSources().then(() => loadImages(false)).finally(startAutoRefresh);
});
