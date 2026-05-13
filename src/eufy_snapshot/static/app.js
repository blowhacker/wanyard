const state = {
  images: [],
  sources: [],
  source: "all",
  selected: -1,
  date: "",
  autoRefreshSeconds: 30,
  dbEnabled: false,
};

const els = {
  snapshot:         document.getElementById("snapshot"),
  empty:            document.getElementById("empty"),
  timestamp:        document.getElementById("timestamp"),
  refreshStatus:    document.getElementById("refreshStatus"),
  prev:             document.getElementById("prev"),
  next:             document.getElementById("next"),
  sourceSelect:     document.getElementById("sourceSelect"),
  sourceMeta:       document.getElementById("sourceMeta"),
  dateSelect:       document.getElementById("dateSelect"),
  filmstrip:        document.getElementById("filmstrip"),
  rtspPanel:        document.getElementById("rtspPanel"),
  dbSourceList:     document.getElementById("dbSourceList"),
  addSourceForm:    document.getElementById("addSourceForm"),
  newSourceName:    document.getElementById("newSourceName"),
  newSourceUrl:     document.getElementById("newSourceUrl"),
  newSourceInterval:document.getElementById("newSourceInterval"),
  newSourceTransport:document.getElementById("newSourceTransport"),
  addSourceError:   document.getElementById("addSourceError"),
  hudSource:        document.getElementById("hudSource"),
  hudTimestamp:     document.getElementById("hudTimestamp"),
};

// Tracks paths currently rendered in the filmstrip, in order.
// Lets us do append-only updates without touching existing DOM nodes.
let filmstripPaths = [];

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

function renderSources() {
  const current = els.sourceSelect.value || state.source;
  els.sourceSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All sources";
  els.sourceSelect.appendChild(all);
  for (const source of state.sources) {
    const opt = document.createElement("option");
    opt.value = source.id;
    opt.textContent = source.name;
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
  const source = state.sources.find((s) => s.id === state.source);
  els.sourceMeta.textContent = source ? `${source.type} · every ${formatInterval(source.interval_seconds)}` : "";
}

function renderDbSources() {
  if (!state.dbEnabled) return;
  const dbSources = state.sources.filter((s) => s.mutable);
  els.dbSourceList.innerHTML = "";
  for (const source of dbSources) {
    const item = document.createElement("div");
    item.className = "db-source-item";
    const name = document.createElement("span");
    name.className = "db-source-name";
    name.textContent = source.name;
    name.title = source.name;
    const btn = document.createElement("button");
    btn.className = "btn-delete";
    btn.textContent = "×";
    btn.title = `Delete ${source.name}`;
    btn.addEventListener("click", () => deleteSource(source.id, source.name));
    item.appendChild(name);
    item.appendChild(btn);
    els.dbSourceList.appendChild(item);
  }
}

async function deleteSource(sourceId, sourceName) {
  if (!confirm(`Delete source "${sourceName}"?`)) return;
  const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    alert(payload.error || "Delete failed");
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
  for (const date of dates) {
    const opt = document.createElement("option");
    opt.value = date;
    opt.textContent = date;
    els.dateSelect.appendChild(opt);
  }
  els.dateSelect.value = dates.includes(current) ? current : "";
  state.date = els.dateSelect.value;
}

function render() {
  const hasImages = state.images.length > 0;
  els.snapshot.style.display = hasImages ? "block" : "none";
  els.empty.style.display = hasImages ? "none" : "block";
  els.prev.disabled = !hasImages || state.selected <= 0;
  els.next.disabled = !hasImages || state.selected >= state.images.length - 1;

  if (!hasImages) {
    els.timestamp.textContent = "--";
    els.snapshot.removeAttribute("src");
    if (els.hudSource) els.hudSource.textContent = "";
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

function renderFilmstrip() {
  const images = state.images;

  // Detect append-only: existing rendered paths are a prefix of the new list
  const isAppendOnly =
    images.length >= filmstripPaths.length &&
    filmstripPaths.every((path, i) => images[i].path === path);

  if (!isAppendOnly) {
    // Filter changed or images removed — full rebuild
    els.filmstrip.innerHTML = "";
    filmstripPaths = [];
  }

  // Append only the new frames (no-op if nothing new)
  for (let i = filmstripPaths.length; i < images.length; i++) {
    els.filmstrip.appendChild(buildFrame(images[i], i));
    filmstripPaths.push(images[i].path);
  }

  // Update selected highlight (class toggle only — no DOM creation)
  const frames = els.filmstrip.children;
  for (let i = 0; i < frames.length; i++) {
    frames[i].classList.toggle("selected", i === state.selected);
  }

  // Scroll selected frame into view without disrupting manual scrolling
  if (state.selected >= 0 && state.selected < frames.length) {
    frames[state.selected].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function buildFrame(image, index) {
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
    state.selected = index;
    render();
  });
  return frame;
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

// ── Controls ──────────────────────────────────────────────

els.prev.addEventListener("click", () => {
  state.selected = Math.max(0, state.selected - 1);
  render();
});

els.next.addEventListener("click", () => {
  state.selected = Math.min(state.images.length - 1, state.selected + 1);
  render();
});

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowLeft") {
    state.selected = Math.max(0, state.selected - 1);
    render();
  } else if (e.key === "ArrowRight") {
    state.selected = Math.min(state.images.length - 1, state.selected + 1);
    render();
  }
});

els.dateSelect.addEventListener("change", () => {
  state.date = els.dateSelect.value;
  state.selected = -1;
  loadImages(false);
});

els.sourceSelect.addEventListener("change", () => {
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
  const url = els.newSourceUrl.value.trim();
  const intervalRaw = els.newSourceInterval.value.trim();
  const body = { name, url, rtsp_transport: els.newSourceTransport.value };
  if (intervalRaw) body.interval_seconds = Number(intervalRaw);
  const response = await fetch("/api/sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    els.addSourceError.textContent = payload.error || "Failed to add source";
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
  const response = await fetch("/api/health", { cache: "no-store" });
  if (!response.ok) return;
  const payload = await response.json();
  if (payload.auto_refresh_seconds) state.autoRefreshSeconds = payload.auto_refresh_seconds;
  if (payload.db_enabled) {
    state.dbEnabled = true;
    els.rtspPanel.hidden = false;
  }
}

loadHealth().finally(() => {
  loadSources().then(() => loadImages(false)).finally(startAutoRefresh);
});
