const state = {
  images: [],
  selected: -1,
  date: "",
  autoRefreshSeconds: 10,
};

const els = {
  snapshot: document.getElementById("snapshot"),
  empty: document.getElementById("empty"),
  timestamp: document.getElementById("timestamp"),
  refreshStatus: document.getElementById("refreshStatus"),
  timeline: document.getElementById("timeline"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  dateSelect: document.getElementById("dateSelect"),
  thumbs: document.getElementById("thumbs"),
};

async function loadImages(preserveSelection = true) {
  const query = state.date ? `?date=${encodeURIComponent(state.date)}` : "";
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
  els.timestamp.textContent = formatTimestamp(image.timestamp);
  renderThumbs();
}

function renderThumbs() {
  els.thumbs.innerHTML = "";
  const start = Math.max(0, state.images.length - 48);
  state.images.slice(start).forEach((image, offset) => {
    const index = start + offset;
    const button = document.createElement("button");
    button.className = `thumb${index === state.selected ? " selected" : ""}`;
    button.title = formatTimestamp(image.timestamp);
    button.addEventListener("click", () => {
      state.selected = index;
      render();
    });
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = formatTimestamp(image.timestamp);
    button.appendChild(img);
    els.thumbs.appendChild(button);
  });
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

let refreshTimer = null;

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    els.refreshStatus.textContent = "Sync";
    loadImages(true).finally(() => {
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
}

loadHealth().finally(() => {
  startAutoRefresh();
  loadImages(false);
});
