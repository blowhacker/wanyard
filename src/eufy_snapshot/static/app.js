const state = {
  images: [],
  sources: [],
  source: "all",
  selected: -1,
  date: "",
  autoRefreshSeconds: 10,
  dbEnabled: false,
};

const els = {
  snapshot: document.getElementById("snapshot"),
  empty: document.getElementById("empty"),
  timestamp: document.getElementById("timestamp"),
  refreshStatus: document.getElementById("refreshStatus"),
  timeline: document.getElementById("timeline"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  sourceSelect: document.getElementById("sourceSelect"),
  sourceMeta: document.getElementById("sourceMeta"),
  dateSelect: document.getElementById("dateSelect"),
  thumbs: document.getElementById("thumbs"),
  rtspPanel: document.getElementById("rtspPanel"),
  dbSourceList: document.getElementById("dbSourceList"),
  addSourceForm: document.getElementById("addSourceForm"),
  newSourceName: document.getElementById("newSourceName"),
  newSourceUrl: document.getElementById("newSourceUrl"),
  newSourceInterval: document.getElementById("newSourceInterval"),
  newSourceTransport: document.getElementById("newSourceTransport"),
  addSourceError: document.getElementById("addSourceError"),
};

async function loadImages(preserveSelection = true) {
  const params = new URLSearchParams();
  if (state.source && state.source !== "all") {
    params.set("source", state.source);
  }
  if (state.date) {
    params.set("date", state.date);
  }
  const query = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`/api/images${query}`, { cache: "no-store" });
  const payload = await response.json();
  const previousPath = state.images[state.selected]?.path;
  state.images = payload.images || [];
  renderDates(payload.dates || []);
  if (preserveSelection && previousPath) {
    state.selected = state.images.findIndex((image) => image.path === previousPath);
  }
  if (state.selected < 0 || state.selected >= state.images.length) {
    state.selected = state.images.length - 1;
  }
  render();
}

async function loadSources() {
  const response = await fetch("/api/sources", { cache: "no-store" });
  if (!response.ok) {
    return;
  }
  const payload = await response.json();
  state.sources = payload.sources || [];
  if (!state.sources.some((source) => source.id === state.source)) {
    state.source = "all";
  }
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
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    els.sourceSelect.appendChild(option);
  }
  els.sourceSelect.value = state.sources.some((source) => source.id === current) ? current : "all";
  state.source = els.sourceSelect.value;
  renderSourceMeta();
}

function renderSourceMeta() {
  if (state.source === "all") {
    const enabledCount = state.sources.filter((source) => source.enabled).length;
    els.sourceMeta.textContent = `${enabledCount} sources`;
    return;
  }
  const source = state.sources.find((item) => item.id === state.source);
  if (!source) {
    els.sourceMeta.textContent = "";
    return;
  }
  els.sourceMeta.textContent = `${source.type} · every ${formatInterval(source.interval_seconds)}`;
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
    const option = document.createElement("option");
    option.value = date;
    option.textContent = date;
    els.dateSelect.appendChild(option);
  }
  els.dateSelect.value = dates.includes(current) ? current : "";
  state.date = els.dateSelect.value;
}

function render() {
  const hasImages = state.images.length > 0;
  els.snapshot.style.display = hasImages ? "block" : "none";
  els.empty.style.display = hasImages ? "none" : "block";
  els.timeline.max = Math.max(0, state.images.length - 1).toString();
  els.timeline.value = Math.max(0, state.selected).toString();
  els.prev.disabled = !hasImages || state.selected <= 0;
  els.next.disabled = !hasImages || state.selected >= state.images.length - 1;

  if (!hasImages) {
    els.timestamp.textContent = "--";
    els.snapshot.removeAttribute("src");
    els.thumbs.innerHTML = "";
    return;
  }

  const image = state.images[state.selected];
  els.snapshot.src = `${image.url}?t=${encodeURIComponent(image.timestamp)}`;
  els.timestamp.textContent = `${image.source_name} · ${formatTimestamp(image.timestamp)}`;
  renderThumbs();
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  const start = Math.max(0, state.images.length - 48);
  state.images.slice(start).forEach((image, offset) => {
    const index = start + offset;
    const button = document.createElement("button");
    button.className = `thumb${index === state.selected ? " selected" : ""}`;
    button.title = `${image.source_name} · ${formatTimestamp(image.timestamp)}`;
    button.addEventListener("click", () => {
      state.selected = index;
      render();
    });
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = button.title;
    button.appendChild(img);
    els.thumbs.appendChild(button);
  });
}

function formatInterval(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return "--";
  }
  if (value < 60) {
    return `${Number.isInteger(value) ? value : value.toFixed(1)}s`;
  }
  const minutes = value / 60;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

els.prev.addEventListener("click", () => {
  state.selected = Math.max(0, state.selected - 1);
  render();
});

els.next.addEventListener("click", () => {
  state.selected = Math.min(state.images.length - 1, state.selected + 1);
  render();
});

els.timeline.addEventListener("input", () => {
  state.selected = Number.parseInt(els.timeline.value, 10);
  render();
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
  const body = {
    name,
    url,
    rtsp_transport: els.newSourceTransport.value,
  };
  if (intervalRaw) {
    body.interval_seconds = Number(intervalRaw);
  }
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

let refreshTimer = null;

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    els.refreshStatus.textContent = "Sync";
    Promise.all([loadSources(), loadImages(true)]).finally(() => {
      els.refreshStatus.textContent = "Auto";
    });
  }, state.autoRefreshSeconds * 1000);
}

async function loadHealth() {
  const response = await fetch("/api/health", { cache: "no-store" });
  if (!response.ok) {
    return;
  }
  const payload = await response.json();
  if (payload.auto_refresh_seconds) {
    state.autoRefreshSeconds = payload.auto_refresh_seconds;
  }
  if (payload.db_enabled) {
    state.dbEnabled = true;
    els.rtspPanel.hidden = false;
  }
}

loadHealth().finally(() => {
  loadSources()
    .then(() => loadImages(false))
    .finally(startAutoRefresh);
});
