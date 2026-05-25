const fmt = {
  bytes: b => b > 1e9 ? (b/1e9).toFixed(1)+'GB' : b > 1e6 ? (b/1e6).toFixed(0)+'MB' : (b/1e3).toFixed(0)+'KB',
  ts:    t => t ? new Date(t*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}) : '--',
};

// ── Status (system KPIs + pipeline chip) ─────────────
let _lastThreads = {};

async function loadStatus() {
  const d = await fetch('/api/settings/status',{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));

  // Disk KPI
  if (d.disk) {
    document.getElementById('diskFree').textContent  = fmt.bytes(d.disk.free);
    const pct = Math.round(d.disk.used / d.disk.total * 100);
    document.getElementById('diskUsedPct').textContent = `of ${fmt.bytes(d.disk.total)} · ${pct}% used`;
  }

  // Footage KPI
  const total = Object.values(d.source_sizes||{}).reduce((a,b)=>a+b,0);
  document.getElementById('videoSize').textContent = fmt.bytes(total);
  document.getElementById('segCount').textContent  = (d.segments||0).toLocaleString();

  // Pipeline KPI + chip
  const threads   = d.recording_threads || {};
  const deadCams  = Object.entries(threads).filter(([,alive])=>!alive).map(([id])=>id);
  const yoloOk    = d.yolo_connected;
  const bfDone    = d.backfill_pending === 0;
  const anyDead   = deadCams.length > 0;

  const healthEl  = document.getElementById('pipelineHealth');
  const subEl     = document.getElementById('pipelineSub');
  const chipEl    = document.getElementById('pipelineChip');
  const chipTxt   = document.getElementById('pipelineText');

  let healthClass, healthText, subText, chipClass;
  if (anyDead) {
    healthClass = 'dead'; healthText = `${deadCams.length} cam offline`;
    subText = deadCams.join(', ');
    chipClass = 'dead'; chipTxt.textContent = `${deadCams.length} cam offline`;
  } else if (!yoloOk) {
    healthClass = 'warn'; healthText = 'Detection offline';
    subText = 'AI detection paused — check logs';
    chipClass = 'warn'; chipTxt.textContent = 'Detection offline';
  } else if (!bfDone && d.backfill_pending > 0) {
    healthClass = 'warn'; healthText = 'Processing';
    subText = `${d.backfill_pending} clips queued for detection · last event ${fmt.ts(d.latest_event_ts)}`;
    chipClass = 'warn'; chipTxt.textContent = `Processing: ${d.backfill_pending} clips`;
  } else {
    healthClass = 'ok'; healthText = 'Healthy';
    subText = `Detection active · all clips tagged · last event ${fmt.ts(d.latest_event_ts)}`;
    chipClass = ''; chipTxt.textContent = 'All systems healthy';
  }

  healthEl.textContent = healthText;
  healthEl.className   = 's-kpi-value ' + healthClass;
  subEl.textContent    = subText;
  chipEl.hidden = false;
  chipEl.className = 's-pipeline-chip ' + chipClass;

  // Per-camera disk bars
  const sizes = document.getElementById('sourceSizes');
  sizes.innerHTML = '';
  for (const [src, bytes] of Object.entries(d.source_sizes||{}).sort((a,b)=>b[1]-a[1])) {
    const row = document.createElement('div');
    row.className = 's-source-row';
    const pct = d.disk?.total ? Math.round(bytes/d.disk.total*100) : 0;
    row.innerHTML = `<span class="s-source-name">${src}</span>
      <div class="s-source-bar"><div class="s-source-fill" style="width:${pct}%"></div></div>
      <span class="s-source-bytes">${fmt.bytes(bytes)}</span>`;
    sizes.appendChild(row);
  }

  _lastThreads = threads;
  // Refresh camera status dots without full reload
  document.querySelectorAll('[data-cam-dot]').forEach(dot => {
    const id    = dot.dataset.camDot;
    const alive = threads[id];
    dot.className = 's-cam-dot' + (alive === true ? ' live' : alive === false ? ' dead' : '');
  });
}

// ── Cameras ───────────────────────────────────────────
async function loadCameras() {
  const d = await fetch('/api/sources',{cache:'no-store'}).then(r=>r.json()).catch(()=>({sources:[]}));
  const list = document.getElementById('cameraList');
  const cleanupSel = document.getElementById('cleanupSource');
  list.innerHTML = '';
  cleanupSel.innerHTML = '<option value="">All cameras</option>';

  for (const s of (d.sources||[])) {
    const alive  = _lastThreads[s.id];
    const dotCls = alive === true ? 'live' : alive === false ? 'dead' : '';

    const row = document.createElement('div');
    row.className = 's-cam-row';
    row.innerHTML = `
      <span class="s-cam-dot ${dotCls}" data-cam-dot="${s.id}"></span>
      <div class="s-cam-info">
        <div class="s-cam-name">${s.name||s.id}</div>
        <div class="s-cam-meta">${s.id}</div>
      </div>
      ${s.mutable
        ? `<button class="s-cam-remove" data-del="${s.id}" title="Remove ${s.name||s.id}" type="button" aria-label="Remove camera">
             <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 2.5l9 9M11.5 2.5l-9 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
           </button>`
        : '<span></span>'}`;
    list.appendChild(row);

    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name || s.id;
    cleanupSel.appendChild(opt);
  }

  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${btn.dataset.del}? This cannot be undone.`)) return;
      await fetch('/api/sources/'+btn.dataset.del,{method:'DELETE'});
      loadCameras();
    });
  });
}

// ── Add camera drawer ─────────────────────────────────
const showAddBtn   = document.getElementById('showAddBtn');
const cancelAddBtn = document.getElementById('cancelAddBtn');
const drawer       = document.getElementById('addCameraDrawer');

function openDrawer()  { drawer.hidden = false; showAddBtn.hidden = true; }
function closeDrawer() {
  drawer.hidden = true;
  showAddBtn.hidden = false;
  document.getElementById('newName').value = '';
  document.getElementById('newUrl').value  = '';
  document.getElementById('testThumb').hidden = true;
  document.getElementById('testMsg').textContent = '';
  document.getElementById('testMsg').className = 's-test-msg';
  document.getElementById('addBtn').disabled = true;
}

showAddBtn.addEventListener('click', openDrawer);
cancelAddBtn.addEventListener('click', closeDrawer);

// Test
document.getElementById('testBtn').addEventListener('click', async () => {
  const url = document.getElementById('newUrl').value.trim();
  const msg = document.getElementById('testMsg');
  const thumb = document.getElementById('testThumb');
  const addBtn = document.getElementById('addBtn');
  if (!url) { msg.textContent = 'Enter a URL first'; msg.className = 's-test-msg err'; return; }
  msg.textContent = 'Connecting…'; msg.className = 's-test-msg';
  thumb.hidden = true; addBtn.disabled = true;
  try {
    const r = await fetch('/api/settings/camera/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    if (r.ok) {
      const blob = await r.blob();
      thumb.src = URL.createObjectURL(blob); thumb.hidden = false;
      msg.textContent = 'Connection OK'; msg.className = 's-test-msg ok';
      addBtn.disabled = false;
    } else {
      const e = await r.json().catch(()=>({}));
      msg.textContent = e.error || `Error ${r.status}`; msg.className = 's-test-msg err';
    }
  } catch { msg.textContent = 'Network error'; msg.className = 's-test-msg err'; }
});

// Add
document.getElementById('addBtn').addEventListener('click', async () => {
  const name = document.getElementById('newName').value.trim();
  const url  = document.getElementById('newUrl').value.trim();
  if (!name || !url) return;
  const r = await fetch('/api/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,url})});
  if (r.ok) { closeDrawer(); loadCameras(); }
});

// ── Auto-cleanup ──────────────────────────────────────
async function loadCleanupConfig() {
  const d = await fetch('/api/settings/cleanup-config').then(r=>r.json()).catch(()=>({}));
  const daysEl = document.getElementById('autoDays');
  const gbEl   = document.getElementById('autoGb');
  if (daysEl) daysEl.value = d.cleanup_days ?? '';
  if (gbEl)   gbEl.value   = d.cleanup_max_gb ?? '';
}

document.getElementById('autoSaveBtn').addEventListener('click', async () => {
  const days = document.getElementById('autoDays').value.trim();
  const gb   = document.getElementById('autoGb').value.trim();
  const msg  = document.getElementById('autoMsg');
  msg.textContent = 'Saving…'; msg.className = 's-save-msg';
  const r = await fetch('/api/settings/cleanup-config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      cleanup_days:   days ? parseFloat(days) : null,
      cleanup_max_gb: gb   ? parseFloat(gb)   : null,
    })
  });
  const d = await r.json();
  if (r.ok) {
    msg.textContent = `Saved — ${d.cleanup_days ?? '∞'} days / ${d.cleanup_max_gb ?? '∞'} GB`;
    msg.className = 's-save-msg ok';
  } else {
    msg.textContent = d.error || `Error ${r.status}`;
    msg.className = 's-save-msg err';
  }
});

// ── Manual delete ─────────────────────────────────────
document.getElementById('cleanupBtn').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('cleanupDays').value);
  const src  = document.getElementById('cleanupSource').value || undefined;
  const msg  = document.getElementById('cleanupMsg');
  const cameraLabel = src || 'all cameras';
  if (!confirm(`Delete all footage older than ${days} days from ${cameraLabel}? This cannot be undone.`)) return;
  msg.textContent = 'Deleting…'; msg.className = 's-save-msg';
  const r = await fetch('/api/settings/cleanup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,source_id:src})});
  const d = await r.json();
  if (r.ok) {
    msg.textContent = `Deleted ${d.deleted_segments} clips, freed ${fmt.bytes(d.freed_bytes)}`;
    msg.className = 's-save-msg ok';
    loadStatus();
  } else {
    msg.textContent = d.error || `Error ${r.status}`;
    msg.className = 's-save-msg err';
  }
});

// ── Sidebar scroll-spy ────────────────────────────────
const sideLinks = document.querySelectorAll('.s-side-link');
const sections  = ['system','cameras','storage'].map(id => document.getElementById(id)).filter(Boolean);

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.id;
      sideLinks.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#'+id);
      });
    }
  });
}, { threshold: 0.2, rootMargin: '-48px 0px -60% 0px' });

sections.forEach(s => observer.observe(s));

// ── Init ──────────────────────────────────────────────
loadStatus();
loadCameras();
loadCleanupConfig();
