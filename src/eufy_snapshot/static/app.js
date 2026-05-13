// ── Constants ─────────────────────────────────────────────

const DENSITY = [
  { w: 38,  h: 22, sampleMinutes: 30, label: "½H"  },
  { w: 56,  h: 32, sampleMinutes: 10, label: "10M" },
  { w: 78,  h: 44, sampleMinutes:  0, label: "ALL" },
  { w: 100, h: 56, sampleMinutes:  0, label: "LG"  },
  { w: 130, h: 73, sampleMinutes:  0, label: "XL"  },
];

const SPEEDS = [
  { label: "SLOW",   ms: 200 },
  { label: "NORM",   ms: 50  },
  { label: "FAST",   ms: 16  },
];

// ── State ─────────────────────────────────────────────────

const state = {
  images:             [],
  sources:            [],
  source:             "all",
  selected:           -1,
  date:               "",
  autoRefreshSeconds: 30,
  dbEnabled:          false,
  detectionEnabled:   false,
  humansOnly:         localStorage.getItem("humansOnly") === "1",
  live:               false,
  humanCount:         parseInt(localStorage.getItem("humanCount") || "6", 10),
  inPoint:            null,
  outPoint:           null,
  density:            parseInt(localStorage.getItem("density") || "3", 10),
  playSpeed:          parseInt(localStorage.getItem("playSpeed") || "1", 10),
  playing:            false,
  loop:               true,
  visibleIndices:     [],
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
  densityBtns:       document.getElementById("densityBtns"),
  speedPills:        document.getElementById("speedPills"),
  loopBtn:           document.getElementById("loopBtn"),
  frameCounter:      document.getElementById("frameCounter"),
  fpsDisplay:        document.getElementById("fpsDisplay"),
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
  humansOnlyBtn:     document.getElementById("humansOnlyBtn"),
  humansOnlyField:   document.getElementById("humansOnlyField"),
  liveBtn:           document.getElementById("liveBtn"),
  humansPanel:       document.getElementById("humansPanel"),
  exportField:       document.getElementById("exportField"),
  inBtn:             document.getElementById("inBtn"),
  outBtn:            document.getElementById("outBtn"),
  clearRangeBtn:     document.getElementById("clearRangeBtn"),
  exportBtn:         document.getElementById("exportBtn"),
};

// Calendar display state (persists across re-renders)
const calState = { year: new Date().getFullYear(), month: new Date().getMonth() };

// Preload cache: keeps Image objects alive so browser caches responses
const preloadCache = new Map(); // url → HTMLImageElement
// 5 preload + 1 active = 6 = browser HTTP/1.1 per-origin connection limit.
// Exceeding 6 forces new TCP handshakes (~15ms each on LAN).
const PRELOAD_AHEAD = 5;
const PRELOAD_MAX   = 40;

function preloadAhead(queue, pos) {
  for (let i = 1; i <= PRELOAD_AHEAD; i++) {
    const idx = queue[(pos + i) % queue.length];
    const img = state.images[idx];
    if (!img || preloadCache.has(img.url)) continue;
    const el = new Image();
    el.src = img.url;
    preloadCache.set(img.url, el);
  }
  // Evict oldest entries beyond cap
  if (preloadCache.size > PRELOAD_MAX) {
    for (const k of [...preloadCache.keys()].slice(0, preloadCache.size - PRELOAD_MAX)) {
      preloadCache.delete(k);
    }
  }
}

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
  // Update button active states
  if (els.densityBtns) {
    Array.from(els.densityBtns.children).forEach((btn, i) => {
      btn.classList.toggle("active", i + 1 === level);
    });
  }
  // Full filmstrip rebuild
  for (const [, s] of stripState) s.stripEl.remove();
  stripState.clear();
  frameElMap.clear();
  currentSelectedEl = null;
  renderFilmstrip();
}

function buildDensityBtns() {
  if (!els.densityBtns) return;
  els.densityBtns.innerHTML = "";
  DENSITY.forEach((d, i) => {
    const btn = document.createElement("button");
    btn.className = "density-btn" + (i + 1 === state.density ? " active" : "");
    btn.textContent = d.label;
    btn.title = d.sampleMinutes > 0 ? `1 frame per ${d.sampleMinutes} min` : "All frames";
    btn.addEventListener("click", () => applyDensity(i + 1));
    els.densityBtns.appendChild(btn);
  });
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

async function loadImages(preserveSelection = true, incremental = false) {
  const params = new URLSearchParams();
  if (state.source && state.source !== "all") params.set("source", state.source);
  if (state.date) params.set("date", state.date);
  if (state.humansOnly) params.set("humans_only", "1");
  // Incremental: only fetch images added since last load
  if (incremental && state.images.length > 0) params.set("offset", state.images.length);

  const response = await fetch(`/api/images${params.size ? `?${params}` : ""}`, { cache: "no-store" });
  const payload  = await response.json();

  renderDateSelector(payload.dates || []);

  if (incremental && state.images.length > 0) {
    const newImages = payload.images || [];
    if (newImages.length === 0) return; // nothing new
    state.images = [...state.images, ...newImages];
    if (state.live) state.selected = state.images.length - 1;
    render();
    renderHumansGrid();
    return;
  }

  // Full load
  const previousPath = preserveSelection ? state.images[state.selected]?.path : null;
  state.images = payload.images || [];
  if (preserveSelection && previousPath) {
    state.selected = state.images.findIndex(img => img.path === previousPath);
  }
  if (state.selected < 0 || state.selected >= state.images.length) {
    state.selected = state.images.length - 1;
  }
  render();
  renderHumansGrid();
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

  if (dates.length === 0) { els.dateField.style.display = "none"; return; }
  els.dateField.style.display = "";

  if (dates.length === 1) {
    const div = document.createElement("div");
    div.className = "date-static";
    div.textContent = formatDateLabel(dates[0]);
    els.dateCtrl.appendChild(div);
    if (state.date !== dates[0]) state.date = dates[0];
    return;
  }

  if (dates.length <= 7) {
    // Scrollable chips for up to a week
    const row = document.createElement("div");
    row.className = "date-chips";
    row.appendChild(makeDateChip("", "ALL"));
    for (const d of dates) row.appendChild(makeDateChip(d, formatDateLabel(d)));
    els.dateCtrl.appendChild(row);
    requestAnimationFrame(() => {
      const active = row.querySelector(".date-chip.active");
      if (active) active.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
    return;
  }

  // Calendar grid for 8+ dates
  const dateSet = new Set(dates);
  // Sync calState to selected date's month if set
  if (state.date) {
    const d = new Date(state.date + "T12:00:00");
    calState.year  = d.getFullYear();
    calState.month = d.getMonth();
  } else {
    // Default to month of latest date
    const latest = dates[dates.length - 1];
    const d = new Date(latest + "T12:00:00");
    calState.year  = d.getFullYear();
    calState.month = d.getMonth();
  }
  els.dateCtrl.appendChild(buildCalendar(dateSet));
}

function buildCalendar(dateSet) {
  const { year, month } = calState;
  const today      = new Date().toISOString().slice(0, 10);
  const firstDay   = new Date(year, month, 1).getDay();
  const daysInMonth= new Date(year, month + 1, 0).getDate();
  const monthLabel = new Date(year, month).toLocaleDateString(undefined, { month: "short", year: "numeric" });

  const container = document.createElement("div");
  container.className = "date-calendar";

  // Header
  const header = document.createElement("div");
  header.className = "cal-header";

  const prevBtn = document.createElement("button");
  prevBtn.className = "cal-nav"; prevBtn.textContent = "‹";
  prevBtn.addEventListener("click", () => {
    calState.month--;
    if (calState.month < 0) { calState.month = 11; calState.year--; }
    els.dateCtrl.innerHTML = "";
    els.dateCtrl.appendChild(buildCalendar(dateSet));
  });

  const nextBtn = document.createElement("button");
  nextBtn.className = "cal-nav"; nextBtn.textContent = "›";
  // Disable next if already at current month
  const now = new Date();
  if (year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth())) {
    nextBtn.disabled = true;
  }
  nextBtn.addEventListener("click", () => {
    calState.month++;
    if (calState.month > 11) { calState.month = 0; calState.year++; }
    els.dateCtrl.innerHTML = "";
    els.dateCtrl.appendChild(buildCalendar(dateSet));
  });

  const label = document.createElement("span");
  label.className = "cal-month-label"; label.textContent = monthLabel;

  header.appendChild(prevBtn); header.appendChild(label); header.appendChild(nextBtn);
  container.appendChild(header);

  // Day-of-week labels
  const labelsRow = document.createElement("div");
  labelsRow.className = "cal-grid";
  for (const l of ["S","M","T","W","T","F","S"]) {
    const cell = document.createElement("div");
    cell.className = "cal-day-label"; cell.textContent = l;
    labelsRow.appendChild(cell);
  }
  container.appendChild(labelsRow);

  // Day cells
  const grid = document.createElement("div");
  grid.className = "cal-grid";

  // Empty leading cells
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty"; grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell    = document.createElement("div");
    const hasData = dateSet.has(dateStr);
    cell.className = "cal-day"
      + (hasData     ? " has-data" : "")
      + (dateStr === state.date ? " active"  : "")
      + (dateStr === today      ? " today"   : "");
    cell.textContent = String(day);
    if (hasData) {
      cell.addEventListener("click", () => {
        stopPlay();
        state.date = dateStr;
        state.selected = -1;
        loadImages(false);
      });
    }
    grid.appendChild(cell);
  }

  container.appendChild(grid);
  return container;
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

function setMainSrc(url) {
  els.snapshot.src = url;
}

function render() {
  const hasImages = state.images.length > 0;
  els.snapshot.style.display = hasImages ? "block" : "none";
  els.empty.style.display    = hasImages ? "none"  : "block";
  els.prev.disabled = !hasImages || (!state.loop && state.selected <= 0);
  els.next.disabled = !hasImages || (!state.loop && state.selected >= state.images.length - 1);

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
  setMainSrc(image.url);
  els.timestamp.textContent = `${image.source_name} · ${formatTimestamp(image.timestamp)}`;
  if (els.hudSource)    els.hudSource.textContent = image.source_name.toUpperCase();
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(image.timestamp);
  renderFilmstrip();
  renderHumansGrid();
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

      // Drag-to-scroll
      let _dragX = 0, _dragScroll = 0, _dragging = false;
      framesEl.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        _dragging = true; _dragX = e.pageX; _dragScroll = framesEl.scrollLeft;
        framesEl.classList.add("dragging");
        e.preventDefault();
      });
      document.addEventListener("mousemove", e => {
        if (!_dragging) return;
        framesEl.scrollLeft = _dragScroll - (e.pageX - _dragX);
      });
      document.addEventListener("mouseup", () => {
        if (!_dragging) return;
        _dragging = false; framesEl.classList.remove("dragging");
      });

      // Hover preview (suppressed while dragging)
      framesEl.addEventListener("mousemove", e => {
        if (_dragging) return;
        if (els.snapshot.style.display === "none") return;
        const strip = stripState.get(sourceId);
        if (!strip?.srcImages?.length) return;
        const rect = framesEl.getBoundingClientRect();
        const x = framesEl.scrollLeft + (e.clientX - rect.left);
        const ratio = Math.min(1, Math.max(0, x / Math.max(1, framesEl.scrollWidth)));
        const img = strip.srcImages[Math.min(strip.srcImages.length - 1, Math.floor(ratio * strip.srcImages.length))];
        if (img) showPreview(img);
      });
      framesEl.addEventListener("wheel", e => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // already horizontal scroll
        e.preventDefault();
        framesEl.scrollLeft += e.deltaY;
      }, { passive: false });

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
  const selectedSrcId = state.images[state.selected]?.source_id;
  if (currentSelectedEl !== frameElMap.get(selectedPath)) {
    if (currentSelectedEl) currentSelectedEl.classList.remove("selected");
    currentSelectedEl = frameElMap.get(selectedPath) || null;
    if (currentSelectedEl) currentSelectedEl.classList.add("selected");
  }
  if (currentSelectedEl) {
    _centerFrame(currentSelectedEl, false);
  }

  // Highlight active strip
  for (const [sourceId, strip] of stripState) {
    strip.stripEl.classList.toggle("strip--active", sourceId === selectedSrcId);
  }

  // Range highlight
  const inIdx  = state.inPoint  ? pathIndex.get(state.inPoint)  : null;
  const outIdx = state.outPoint ? pathIndex.get(state.outPoint) : null;
  const lo = (inIdx != null && outIdx != null) ? Math.min(inIdx, outIdx) : (inIdx ?? outIdx);
  const hi = (inIdx != null && outIdx != null) ? Math.max(inIdx, outIdx) : (inIdx ?? outIdx);
  for (const [p, el] of frameElMap) {
    const idx = pathIndex.get(p);
    el.classList.toggle("frame--in-range",  idx != null && lo != null && hi != null && idx >= lo && idx <= hi);
    el.classList.toggle("frame--in-point",  idx != null && idx === inIdx);
    el.classList.toggle("frame--out-point", idx != null && idx === outIdx);
  }
  updateExportBtn();
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
    if (idx !== undefined) { setLive(false); stopPlay(); state.selected = idx; render(); }
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

function _centerFrame(el, smooth) {
  const framesEl = el.closest(".frames");
  if (!framesEl) return;
  const target = el.offsetLeft - framesEl.clientWidth / 2 + el.offsetWidth / 2;
  framesEl.scrollTo({ left: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
}

function showPreview(img) {
  els.snapshot.src = img.url;
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(img.timestamp);
  if (els.hudSource)    els.hudSource.textContent = img.source_name.toUpperCase();
}

function restoreSelected() {
  const sel = state.images[state.selected];
  if (!sel) return;
  els.snapshot.src = sel.url;
  if (els.hudTimestamp) els.hudTimestamp.textContent = formatTimestamp(sel.timestamp);
  if (els.hudSource)    els.hudSource.textContent = sel.source_name.toUpperCase();
}

// ── Playback ──────────────────────────────────────────────

let _playId  = 0;
const _statBuf = []; // { wall: ms, imgTs: ms } for rolling fps + footage speed

function _updatePlayStats() {
  const imgTs = new Date(state.images[state.selected]?.timestamp).getTime();
  if (isNaN(imgTs)) return;
  _statBuf.push({ wall: performance.now(), imgTs });
  if (_statBuf.length > 14) _statBuf.shift();
  if (_statBuf.length < 2 || !els.fpsDisplay) return;

  const wallMs    = _statBuf.at(-1).wall  - _statBuf[0].wall;
  const footageMs = _statBuf.at(-1).imgTs - _statBuf[0].imgTs;
  const fps       = (_statBuf.length - 1) / (wallMs / 1000);
  const secPerSec = footageMs / wallMs; // ms/ms = s/s, no conversion needed

  els.fpsDisplay.textContent = `${Math.round(fps)} fps · ${_fmtSpeed(secPerSec)}`;
}

function _fmtSpeed(secPerSec) {
  const v = Math.abs(secPerSec);
  if (v < 60)   return `${Math.round(v)}s/s`;
  if (v < 3600) { const m = v / 60;   return `${m < 10 ? m.toFixed(1) : Math.round(m)}m/s`; }
                  const h = v / 3600; return `${h < 10 ? h.toFixed(1) : Math.round(h)}h/s`;
}

function startPlay() {
  const srcId = state.images[state.selected]?.source_id;
  let queue = srcId
    ? state.visibleIndices.filter(i => state.images[i]?.source_id === srcId)
    : state.visibleIndices;
  if (state.inPoint || state.outPoint) {
    const inIdx  = state.inPoint  ? (pathIndex.get(state.inPoint)  ?? 0) : 0;
    const outIdx = state.outPoint ? (pathIndex.get(state.outPoint) ?? state.images.length - 1) : state.images.length - 1;
    const lo = Math.min(inIdx, outIdx), hi = Math.max(inIdx, outIdx);
    queue = queue.filter(i => i >= lo && i <= hi);
  }
  if (!queue.length) return;

  state.playing = true;
  els.playBtn.textContent = "■";
  els.playBtn.classList.add("playing");

  const id  = ++_playId;
  let   pos = Math.max(0, queue.indexOf(state.selected));
  const ms  = SPEEDS[state.playSpeed].ms;

  preloadAhead(queue, pos);

  (async () => {
    while (state.playing && _playId === id) {
      const t0 = performance.now();

      const next = pos + 1;
      if (next >= queue.length) {
        if (!state.loop) { stopPlay(); break; }
        _statBuf.length = 0; // timestamps jump on wrap — reset rolling window
      }
      pos = next % queue.length;
      state.selected = queue[pos];
      preloadAhead(queue, pos);
      render();

      // Wait until the browser has decoded the frame before advancing.
      // Prevents src reassignment cancelling the in-flight decode.
      try { await els.snapshot.decode(); } catch { /* src changed or error */ }
      _updatePlayStats();

      // Honour target fps: sleep for any remaining budget
      const wait = ms - (performance.now() - t0);
      if (wait > 1) await new Promise(r => setTimeout(r, wait));
    }
  })();
}

function stopPlay() {
  state.playing = false;
  els.playBtn.textContent = "▶";
  els.playBtn.classList.remove("playing");
  _statBuf.length = 0;
  if (els.fpsDisplay) els.fpsDisplay.textContent = "";
}

function togglePlay() { state.playing ? stopPlay() : startPlay(); }

// ── Staleness ─────────────────────────────────────────────

function updateStaleness(latestTimestamp) {
  const ageMs = Date.now() - new Date(latestTimestamp).getTime();
  els.refreshStatus.classList.toggle("stale", ageMs > 5 * 60 * 1000);
}

// ── Controls ──────────────────────────────────────────────

function stepFrame(delta) {
  if (!state.images.length) return;
  const srcId = state.images[state.selected]?.source_id;
  let queue = srcId
    ? state.visibleIndices.filter(i => state.images[i]?.source_id === srcId)
    : state.visibleIndices;
  if (state.inPoint || state.outPoint) {
    const inIdx  = state.inPoint  ? (pathIndex.get(state.inPoint)  ?? 0) : 0;
    const outIdx = state.outPoint ? (pathIndex.get(state.outPoint) ?? state.images.length - 1) : state.images.length - 1;
    const lo = Math.min(inIdx, outIdx), hi = Math.max(inIdx, outIdx);
    queue = queue.filter(i => i >= lo && i <= hi);
  }
  if (!queue.length) return;
  const pos = Math.max(0, queue.indexOf(state.selected));
  const next = state.loop
    ? (pos + delta + queue.length) % queue.length
    : Math.max(0, Math.min(queue.length - 1, pos + delta));
  state.selected = queue[next];
  render();
}

// Single click on image → toggle play/pause
els.snapshot.addEventListener("click", togglePlay);

// Double-click on image → fullscreen (dblclick fires after two clicks,
// the two single-clicks cancel each other: pause then play → no net change)
els.snapshot.addEventListener("dblclick", () => {
  const stage = document.querySelector(".image-stage");
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen().catch(() => {});
});

els.prev.addEventListener("click", () => { stopPlay(); stepFrame(-1); });
els.next.addEventListener("click", () => { stopPlay(); stepFrame(+1); });
els.playBtn.addEventListener("click", togglePlay);
els.loopBtn.addEventListener("click", () => {
  state.loop = !state.loop;
  els.loopBtn.classList.toggle("active", state.loop);
});
els.jumpLatest.addEventListener("click", () => {
  const srcId = state.images[state.selected]?.source_id;
  const idx = srcId
    ? [...state.images].map((img, i) => ({ img, i })).filter(({ img }) => img.source_id === srcId).at(-1)?.i
    : state.images.length - 1;
  if (idx != null) { state.selected = idx; render(); }
});


// ── LIVE ──────────────────────────────────────────────────

function setLive(on) {
  state.live = on;
  if (els.liveBtn) {
    els.liveBtn.classList.toggle("active", on);
    els.liveBtn.textContent = on ? "● LIVE" : "LIVE";
  }
  if (on) { state.selected = state.images.length - 1; render(); }
}

// ── Humans panel ──────────────────────────────────────────

function humanThumbStyle(img, box) {
  // Cell ~133×78px (2-col in 300px panel). Image source 2304×1296 (AR 1.778).
  // Show a fixed VIEW_H fraction of frame height, derive VIEW_W to match cell AR.
  const CELL_AR  = 133 / 78;
  const IMG_AR   = 2304 / 1296;
  const VIEW_H   = Math.max(0.12, Math.min(0.35, (box.y2 - box.y1) * 2)); // ~2x box height, clamped
  const VIEW_W   = Math.min(1, VIEW_H * CELL_AR / IMG_AR); // match cell aspect ratio
  const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
  const vx1 = Math.max(0, Math.min(1 - VIEW_W, cx - VIEW_W / 2));
  const vy1 = Math.max(0, Math.min(1 - VIEW_H, cy - VIEW_H / 2));
  const bpx = VIEW_W >= 1 ? 50 : (vx1 / (1 - VIEW_W)) * 100;
  const bpy = VIEW_H >= 1 ? 50 : (vy1 / (1 - VIEW_H)) * 100;
  return `background-image:url('${img.url}');background-size:${(1/VIEW_W*100).toFixed(1)}%;background-position:${bpx.toFixed(1)}% ${bpy.toFixed(1)}%;background-repeat:no-repeat`;
}

function renderHumansGrid() {
  if (!els.humansPanel) return;
  const selTs = new Date(state.images[state.selected]?.timestamp).getTime();
  if (!selTs) { els.humansPanel.hidden = true; return; }

  // One section per source
  const sections = [];
  for (const src of state.sources) {
    const humans = state.images
      .map((img, i) => ({ img, dist: Math.abs(i - state.selected) }))
      .filter(({ img }) => img.has_human && img.boxes?.length && img.source_id === src.id)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, state.humanCount)
      .sort((a, b) => state.images.indexOf(a.img) - state.images.indexOf(b.img))
      .map(h => h.img);
    if (humans.length) sections.push({ src, humans });
  }

  if (!sections.length) { els.humansPanel.hidden = true; return; }
  els.humansPanel.hidden = false;
  els.humansPanel.innerHTML = "";

  // Shared header with count pills
  const sharedHead = document.createElement("div");
  sharedHead.className = "humans-panel-head";
  const sharedLabel = document.createElement("span");
  sharedLabel.textContent = "RECENT HUMANS";
  sharedHead.appendChild(sharedLabel);
  const pills = document.createElement("div");
  pills.className = "human-count-pills";
  for (const n of [4, 6, 12]) {
    const btn = document.createElement("button");
    btn.className = "human-count-btn" + (state.humanCount === n ? " active" : "");
    btn.textContent = n;
    btn.addEventListener("click", () => {
      state.humanCount = n;
      localStorage.setItem("humanCount", n);
      renderHumansGrid();
    });
    pills.appendChild(btn);
  }
  sharedHead.appendChild(pills);
  els.humansPanel.appendChild(sharedHead);

  for (const { src, humans: allH } of sections) {
    const humans = allH.slice(0, state.humanCount);
    const head = document.createElement("div");
    head.className = "humans-panel-source-label";
    head.textContent = src.name;
    els.humansPanel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "human-grid";
    for (const img of humans) {
      const box  = img.boxes[0];
      const cell = document.createElement("div");
      cell.className = "human-cell";
      cell.style.cssText = humanThumbStyle(img, box);
      const ts = document.createElement("div");
      ts.className = "human-cell-ts";
      ts.textContent = formatTime(img.timestamp);
      cell.appendChild(ts);
      cell.addEventListener("mouseenter", () => showPreview(img));
      cell.addEventListener("mouseleave", restoreSelected);
      cell.addEventListener("click", () => {
        const idx = state.images.findIndex(i => i.path === img.path);
        if (idx >= 0) { setLive(false); stopPlay(); state.selected = idx; render(); }
      });
      grid.appendChild(cell);
    }
    els.humansPanel.appendChild(grid);
  }
}

// ── Range / Export ────────────────────────────────────────

function setInPoint() {
  const img = state.images[state.selected];
  if (!img) return;
  state.inPoint = state.inPoint === img.path ? null : img.path;
  renderFilmstrip();
}

function setOutPoint() {
  const img = state.images[state.selected];
  if (!img) return;
  state.outPoint = state.outPoint === img.path ? null : img.path;
  renderFilmstrip();
}

function clearRange() {
  state.inPoint = null;
  state.outPoint = null;
  renderFilmstrip();
}

function updateExportBtn() {
  if (!els.exportBtn) return;
  const hasAny = state.inPoint || state.outPoint;
  const ready  = state.inPoint && state.outPoint;
  els.exportBtn.disabled = !ready;
  if (els.inBtn)         els.inBtn.classList.toggle("active",  !!state.inPoint);
  if (els.outBtn)        els.outBtn.classList.toggle("active", !!state.outPoint);
  if (els.clearRangeBtn) els.clearRangeBtn.hidden = !hasAny;
  updateRangeOverlay();
}

function updateRangeOverlay() {
  // Remove all existing overlays
  for (const el of document.querySelectorAll(".range-overlay")) el.remove();
  if (!state.inPoint || !state.outPoint) return;

  const inEl  = frameElMap.get(state.inPoint);
  const outEl = frameElMap.get(state.outPoint);
  if (!inEl || !outEl) return;

  const framesEl = inEl.closest(".frames");
  if (!framesEl || outEl.closest(".frames") !== framesEl) return;

  const lo = Math.min(inEl.offsetLeft,  outEl.offsetLeft);
  const hi = Math.max(inEl.offsetLeft  + inEl.offsetWidth,
                      outEl.offsetLeft + outEl.offsetWidth);

  const overlay = document.createElement("div");
  overlay.className = "range-overlay";
  overlay.style.left   = `${lo}px`;
  overlay.style.top    = `${inEl.offsetTop}px`;
  overlay.style.width  = `${hi - lo}px`;
  overlay.style.height = `${inEl.offsetHeight}px`;
  framesEl.appendChild(overlay);
}

async function exportRange() {
  if (!state.inPoint || !state.outPoint) return;

  // Build the exact same frame queue play would use
  const srcId = state.images[state.selected]?.source_id;
  const inIdx  = pathIndex.get(state.inPoint);
  const outIdx = pathIndex.get(state.outPoint);
  if (inIdx == null || outIdx == null) return;
  const lo = Math.min(inIdx, outIdx), hi = Math.max(inIdx, outIdx);
  const frames = state.visibleIndices
    .filter(i => state.images[i]?.source_id === srcId && i >= lo && i <= hi)
    .map(i => state.images[i]);

  if (!frames.length) { alert("No frames in range"); return; }

  const fps        = Math.min(60, Math.round(1000 / SPEEDS[state.playSpeed].ms));
  const sourceName = frames[0]?.source_name || srcId || "export";
  const fmtTs = ts => ts ? ts.slice(0, 19).replace("T", "_").replaceAll(":", "-") : "";
  const startTs    = fmtTs(frames[0]?.timestamp);
  const endTs      = fmtTs(frames[frames.length - 1]?.timestamp);

  els.exportBtn.disabled = true;
  els.exportBtn.classList.add("exporting");
  els.exportBtn.textContent = "EXPORTING";
  try {
    const resp = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths:       frames.map(f => f.path),
        fps,
        source_name: sourceName,
        start_ts:    startTs,
        end_ts:      endTs,
        humans_only: state.humansOnly,
      }),
    });
    if (!resp.ok) {
      const p = await resp.json().catch(() => ({}));
      alert(p.error || "Export failed");
      return;
    }
    const blob     = await resp.blob();
    const url      = URL.createObjectURL(blob);
    const srcSlug  = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const humanTag = state.humansOnly ? "-human" : "";
    const fname    = `${srcSlug}_${startTs}_${endTs}${humanTag}.mp4`;
    const a        = document.createElement("a");
    a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  } finally {
    els.exportBtn.classList.remove("exporting");
    els.exportBtn.disabled = !state.inPoint || !state.outPoint;
    els.exportBtn.textContent = "MP4";
  }
}

document.addEventListener("keydown", e => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === " ")            { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft")  { stopPlay(); stepFrame(-1); }
  else if (e.key === "ArrowRight") { stopPlay(); stepFrame(+1); }
  else if (e.key === "i" || e.key === "I") { setInPoint(); }
  else if (e.key === "o" || e.key === "O") { setOutPoint(); }
  else if (e.key === "Escape")  { clearRange(); }
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
    Promise.all([loadSources(), loadImages(true, true)]).finally(() => {
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
  if (p.detection_enabled) {
    state.detectionEnabled = true;
    els.humansOnlyField.hidden = false;
    els.humansOnlyBtn.classList.toggle("active", state.humansOnly);
    els.humansOnlyBtn.addEventListener("click", () => {
      state.humansOnly = !state.humansOnly;
      localStorage.setItem("humansOnly", state.humansOnly ? "1" : "0");
      els.humansOnlyBtn.classList.toggle("active", state.humansOnly);
      stopPlay();
      state.selected = -1;
      loadImages(false);
    });
  }
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

buildDensityBtns();
applyDensity(state.density);
buildSpeedPills();

if (els.liveBtn)      els.liveBtn.addEventListener("click", () => setLive(!state.live));
if (els.inBtn)        els.inBtn.addEventListener("click",  setInPoint);
if (els.outBtn)       els.outBtn.addEventListener("click",  setOutPoint);
if (els.clearRangeBtn) els.clearRangeBtn.addEventListener("click", clearRange);
if (els.exportBtn)    els.exportBtn.addEventListener("click", exportRange);

loadHealth().finally(() => {
  loadSources().then(() => loadImages(false)).finally(startAutoRefresh);
});
