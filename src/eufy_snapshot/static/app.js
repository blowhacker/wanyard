// Density levels: frame size + time subsampling
// sampleMinutes=0 → show every frame
const DENSITY = [
  { w: 38, h: 22, sampleMinutes: 30 },  // 1 – overview,  ~1 frame/30 min
  { w: 56, h: 32, sampleMinutes: 10 },  // 2 – coarse,    ~1 frame/10 min
  { w: 78, h: 44, sampleMinutes:  0 },  // 3 – default,   every frame
  { w: 100, h: 56, sampleMinutes: 0 },  // 4 – detail
  { w: 130, h: 73, sampleMinutes: 0 },  // 5 – large
];

const state = {
  images: [],
  sources: [],
  source: "all",
  selected: -1,
  date: "",
  autoRefreshSeconds: 30,
  dbEnabled: false,
  density: parseInt(localStorage.getItem("density") || "3", 10),
  playing: false,
  playTimer: null,
  visibleIndices: [],   // global indices of currently rendered frames
};

const els = {
  snapshot:          document.getElementById("snapshot"),
  empty:             document.getElementById("empty"),
  timestamp:         document.getElementById("timestamp"),
  refreshStatus:     document.getElementById("refreshStatus"),
  prev:              document.getElementById("prev"),
  playBtn:           document.getElementById("playBtn"),
  next:              document.getElementById("next"),
  densitySlider:     document.getElementById("densitySlider"),
  sourceSelect:      document.getElementById("sourceSelect"),
  sourceMeta:        document.getElementById("sourceMeta"),
  dateSelect:        document.getElementById("dateSelect"),
  filmstrip:         document.getElementById("filmstrip"),
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

// Per-source strip state: sourceId → { paths, framesEl, stripEl, lastTs }
const stripState = new Map();
// path → globalIndex in state.images
const pathIndex = new Map();

// ── Density ───────────────────────────────────────────────

function applyDensity(level) {
  const d = DENSITY[level - 1];
  const root = document.documentElement;
  root.style.setProperty("--frame-w", `${d.w}px`);
  root.style.setProperty("--frame-h", `${d.h}px`);
  state.density = level;
  localStorage.setItem("density", level);
  // Full filmstrip rebuild at new density
  for (const [, s] of stripState) s.stripEl.remove();
  stripState.clear();
  renderFilmstrip();
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
  renderDates(payload.dates || []);
  if (preserveSelection && previousPath) {
    state.selected = state.images.findIndex((img) => img.path === previousPath);
  }
  if (state.selected < 0 || state.selected >= state.images.length) {
    state.selected = state.images.length - 1;
  }
  render();
}

async function loadSources() {
  const response = await fetch("/api/sources", { cache: "no-store" });
  if (!response.ok) return;
  const payload = await response.json();
  state.sources = payload.sources || [];
  if (!state.sources.some((s) => s.id === state.source)) state.source = "all";
  renderSources();
  renderDbSources();
}

// ── Panel renders ─────────────────────────────────────────

function renderSources() {
  const current = els.sourceSelect.value || state.source;
  els.sourceSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All sources";
  els.sourceSelect.appendChild(all);
  for (const s of state.sources) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    els.sourceSelect.appendChild(opt);
  }
  els.sourceSelect.value = state.sources.some((s) => s.id === current) ? current : "all";
  state.source = els.sourceSelect.value;
  renderSourceMeta();
}

function renderSourceMeta() {
  if (state.source === "all") {
    els.sourceMeta.textContent = `${state.sources.filter((s) => s.enabled).length} sources`;
    return;
  }
  const s = state.sources.find((s) => s.id === state.source);
  els.sourceMeta.textContent = s ? `${s.type} · every ${formatInterval(s.interval_seconds)}` : "";
}

function renderDbSources() {
  if (!state.dbEnabled) return;
  els.dbSourceList.innerHTML = "";
  for (const s of state.sources.filter((s) => s.mutable)) {
    const item = document.createElement("div");
    item.className = "db-source-item";
    const name = document.createElement("span");
    name.className = "db-source-name";
    name.textContent = s.name;
    name.title = s.name;
    const btn = document.createElement("button");
    btn.className = "btn-delete";
    btn.textContent = "×";
    btn.title = `Delete ${s.name}`;
    btn.addEventListener("click", () => deleteSource(s.id, s.name));
    item.appendChild(name);
    item.appendChild(btn);
    els.dbSourceList.appendChild(item);
  }
}

async function deleteSource(id, name) {
  if (!confirm(`Delete source "${name}"?`)) return;
  const r = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) {
    const p = await r.json().catch(() => ({}));
    alert(p.error || "Delete failed");
    return;
  }
  await loadSources();
  await loadImages(false);
}

function renderDates(dates) {
  const current = els.dateSelect.value || state.date;
  els.dateSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All dates";
  els.dateSelect.appendChild(all);
  for (const d of dates) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    els.dateSelect.appendChild(opt);
  }
  els.dateSelect.value = dates.includes(current) ? current : "";
  state.date = els.dateSelect.value;
}

// ── Main render ───────────────────────────────────────────

function render() {
  const hasImages = state.images.length > 0;
  els.snapshot.style.display = hasImages ? "block" : "none";
  els.empty.style.display    = hasImages ? "none"  : "block";
  els.prev.disabled = !hasImages || state.selected <= 0;
  els.next.disabled = !hasImages || state.selected >= state.images.length - 1;

  if (!hasImages) {
    els.timestamp.textContent = "--";
    els.snapshot.removeAttribute("src");
    if (els.hudSource)    els.hudSource.textContent = "";
    if (els.hudTimestamp) els.hudTimestamp.textContent = "";
    renderFilmstrip();
    return;
  }

  const image = state.images[state.selected];
  els.snapshot.src = `${image.url}?t=${encodeURIComponent(image.timestamp)}`;
  els.timestamp.textContent = `${image.source_name} · ${formatTimestamp(image.timestamp)}`;
  if (els.hudSource)    els.hudSource.textContent = image.source_name.toUpperCase();
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(image.timestamp);
  renderFilmstrip();
}

// ── Filmstrip ─────────────────────────────────────────────

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

  // Rebuild path→globalIndex
  pathIndex.clear();
  state.images.forEach((img, i) => pathIndex.set(img.path, i));

  // Group images by source in timestamp order
  const groups = new Map();
  for (let i = 0; i < state.images.length; i++) {
    const img = state.images[i];
    if (!groups.has(img.source_id)) {
      groups.set(img.source_id, { sourceName: img.source_name, items: [] });
    }
    groups.get(img.source_id).items.push(img);
  }

  // Remove strips for sources no longer present
  for (const [id, s] of stripState) {
    if (!groups.has(id)) { s.stripEl.remove(); stripState.delete(id); }
  }

  // Collect visible indices for playback
  state.visibleIndices = [];

  for (const [sourceId, group] of groups) {
    // Create strip if needed
    if (!stripState.has(sourceId)) {
      const stripEl = document.createElement("div");
      stripEl.className = "strip";
      const label = document.createElement("div");
      label.className = "strip-label";
      label.textContent = group.sourceName;
      label.title = group.sourceName;
      const framesEl = document.createElement("div");
      framesEl.className = "frames";

      // Pixel-position scrub: x offset → proportional index into full image list
      framesEl.addEventListener("mousemove", (e) => {
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

    // Keep srcImages up to date (all frames for this source, unsampled)
    stripState.get(sourceId).srcImages = group.items;

    const strip = stripState.get(sourceId);
    const sampled = d.sampleMinutes > 0
      ? subsample(group.items, d.sampleMinutes)
      : group.items;

    // Append-only check
    const isAppend =
      sampled.length >= strip.paths.length &&
      strip.paths.every((p, i) => sampled[i].path === p);

    if (!isAppend) {
      strip.framesEl.innerHTML = "";
      strip.paths = [];
      strip.lastTs = null;
    }

    // Append new frames (with hour markers)
    for (let i = strip.paths.length; i < sampled.length; i++) {
      const img = sampled[i];
      const ts = new Date(img.timestamp);

      if (strip.lastTs !== null) {
        const prevHourStart = Math.floor(strip.lastTs.getTime() / 3600000);
        const thisHourStart = Math.floor(ts.getTime() / 3600000);
        for (let h = prevHourStart + 1; h <= thisHourStart; h++) {
          strip.framesEl.appendChild(buildHourMarker(new Date(h * 3600000)));
        }
      }

      strip.framesEl.appendChild(buildFrame(img));
      strip.paths.push(img.path);
      strip.lastTs = ts;
    }

    // Collect visible indices
    for (const path of strip.paths) {
      const idx = pathIndex.get(path);
      if (idx !== undefined) state.visibleIndices.push(idx);
    }
  }

  // Sort visible indices (multiple sources may interleave)
  state.visibleIndices.sort((a, b) => a - b);

  // Update selected highlight
  const selectedPath = state.images[state.selected]?.path;
  let selectedEl = null;
  for (const [, strip] of stripState) {
    const frameEls = strip.framesEl.querySelectorAll(".frame");
    frameEls.forEach((el, i) => {
      const isSelected = strip.paths[i] === selectedPath;
      el.classList.toggle("selected", isSelected);
      if (isSelected) selectedEl = el;
    });
  }
  if (selectedEl) {
    selectedEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function buildFrame(image) {
  const frame = document.createElement("div");
  frame.className = "frame";

  const img = document.createElement("img");
  img.src = image.url;
  img.alt = "";
  img.loading = "lazy";

  const ts = document.createElement("div");
  ts.className = "frame-ts";
  ts.textContent = formatTime(image.timestamp);

  frame.appendChild(img);
  frame.appendChild(ts);

  frame.addEventListener("click", () => {
    const idx = pathIndex.get(image.path);
    if (idx !== undefined) { state.selected = idx; render(); }
  });

  return frame;
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

function buildHourMarker(date) {
  const el = document.createElement("div");
  el.className = "hour-mark";
  const label = document.createElement("span");
  label.className = "hour-mark-label";
  label.textContent = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  el.appendChild(label);
  return el;
}

// ── Playback ──────────────────────────────────────────────

function startPlay() {
  if (!state.visibleIndices.length) return;
  state.playing = true;
  els.playBtn.textContent = "■";
  els.playBtn.classList.add("playing");

  state.playTimer = setInterval(() => {
    const vis = state.visibleIndices;
    if (!vis.length) return;
    const pos = vis.indexOf(state.selected);
    state.selected = vis[pos < 0 ? 0 : (pos + 1) % vis.length];  // loops
    render();
  }, 50); // 20fps
}

function stopPlay() {
  clearInterval(state.playTimer);
  state.playTimer = null;
  state.playing = false;
  els.playBtn.textContent = "▶";
  els.playBtn.classList.remove("playing");
}

function togglePlay() {
  if (state.playing) stopPlay(); else startPlay();
}

// ── Controls ──────────────────────────────────────────────

els.prev.addEventListener("click", () => {
  stopPlay();
  state.selected = Math.max(0, state.selected - 1);
  render();
});

els.next.addEventListener("click", () => {
  stopPlay();
  state.selected = Math.min(state.images.length - 1, state.selected + 1);
  render();
});

els.playBtn.addEventListener("click", togglePlay);

els.densitySlider.value = state.density;
els.densitySlider.addEventListener("input", () => {
  applyDensity(parseInt(els.densitySlider.value, 10));
});

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft")  { stopPlay(); state.selected = Math.max(0, state.selected - 1); render(); }
  else if (e.key === "ArrowRight") { stopPlay(); state.selected = Math.min(state.images.length - 1, state.selected + 1); render(); }
});

els.dateSelect.addEventListener("change", () => {
  stopPlay();
  state.date = els.dateSelect.value;
  state.selected = -1;
  loadImages(false);
});

els.sourceSelect.addEventListener("change", () => {
  stopPlay();
  state.source = els.sourceSelect.value;
  state.date = "";
  state.selected = -1;
  renderSourceMeta();
  loadImages(false);
});

els.addSourceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.addSourceError.hidden = true;
  const name = els.newSourceName.value.trim();
  const url  = els.newSourceUrl.value.trim();
  const iv   = els.newSourceInterval.value.trim();
  const body = { name, url, rtsp_transport: els.newSourceTransport.value };
  if (iv) body.interval_seconds = Number(iv);
  const r = await fetch("/api/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const p = await r.json().catch(() => ({}));
  if (!r.ok) {
    els.addSourceError.textContent = p.error || "Failed to add source";
    els.addSourceError.hidden = false;
    return;
  }
  els.addSourceForm.reset();
  await loadSources();
  await loadImages(false);
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

applyDensity(state.density);  // apply stored density on load

loadHealth().finally(() => {
  loadSources().then(() => loadImages(false)).finally(startAutoRefresh);
});
