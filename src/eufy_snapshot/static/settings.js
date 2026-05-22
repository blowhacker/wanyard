const fmt = {
  bytes: b => b > 1e9 ? (b/1e9).toFixed(1)+'GB' : b > 1e6 ? (b/1e6).toFixed(0)+'MB' : (b/1e3).toFixed(0)+'KB',
  ts:    t => t ? new Date(t*1000).toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'}) : '--',
};

async function loadStatus() {
  const d = await fetch('/api/settings/status',{cache:'no-store'}).then(r=>r.json()).catch(()=>({}));
  if (d.disk) {
    document.getElementById('diskFree').textContent  = fmt.bytes(d.disk.free);
    const total = Object.values(d.source_sizes||{}).reduce((a,b)=>a+b,0);
    document.getElementById('videoSize').textContent = fmt.bytes(total);
  }
  document.getElementById('segCount').textContent      = (d.segments||0).toLocaleString();
  // Backfill: show pending count + thread alive status
  const bfPending = d.backfill_pending > 0 ? d.backfill_pending+' pending' : 'done';
  const bfAlive   = d.backfill_alive === false ? ' ⚠ stopped' : '';
  document.getElementById('backfillStatus').textContent = bfPending + bfAlive;
  document.getElementById('backfillStatus').className   = 's-stat-value'+(bfAlive?' s-red':'');
  // YOLO: connected + recording threads
  const threads = d.recording_threads || {};
  const deadCams = Object.entries(threads).filter(([,alive])=>!alive).map(([id])=>id);
  const yoloText = d.yolo_connected ? '● connected' : '○ offline';
  const recText  = deadCams.length ? ` ⚠ ${deadCams.join(',')} dead` : '';
  document.getElementById('yoloStatus').textContent    = yoloText + recText;
  document.getElementById('yoloStatus').className      = 's-stat-value '+(d.yolo_connected&&!deadCams.length?'s-green':deadCams.length?'s-red':'s-dim');
  document.getElementById('lastEvent').textContent     = fmt.ts(d.latest_event_ts);

  const sizes = document.getElementById('sourceSizes');
  sizes.innerHTML = '';
  for (const [src, bytes] of Object.entries(d.source_sizes||{}).sort((a,b)=>b[1]-a[1])) {
    const row = document.createElement('div');
    row.className = 's-source-row';
    const pct = d.disk?.used ? Math.round(bytes/d.disk.total*100) : 0;
    row.innerHTML = `<span class="s-source-name">${src}</span><div class="s-source-bar"><div class="s-source-fill" style="width:${pct}%"></div></div><span class="s-source-bytes">${fmt.bytes(bytes)}</span>`;
    sizes.appendChild(row);
  }
}

async function loadCameras() {
  const d = await fetch('/api/sources',{cache:'no-store'}).then(r=>r.json()).catch(()=>({sources:[]}));
  const list = document.getElementById('cameraList');
  const cleanupSel = document.getElementById('cleanupSource');
  list.innerHTML = '';
  cleanupSel.innerHTML = '<option value="">All cameras</option>';

  for (const s of (d.sources||[])) {
    const row = document.createElement('div');
    row.className = 's-camera-row';
    row.innerHTML = `
      <div class="s-cam-info">
        <span class="s-cam-name">${s.name||s.id}</span>
        <span class="s-cam-id">${s.id}</span>
      </div>
      <div class="s-cam-actions">
        ${s.mutable ? `<button class="s-btn s-btn-danger s-btn-sm" data-del="${s.id}">REMOVE</button>` : '<span class="s-cam-fixed">built-in</span>'}
      </div>`;
    list.appendChild(row);
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name || s.id;
    cleanupSel.appendChild(opt);
  }

  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove '+btn.dataset.del+'?')) return;
      await fetch('/api/sources/'+btn.dataset.del,{method:'DELETE'});
      loadCameras();
    });
  });
}

// Camera test
document.getElementById('testBtn').addEventListener('click', async () => {
  const url = document.getElementById('newUrl').value.trim();
  const msg = document.getElementById('testMsg');
  const thumb = document.getElementById('testThumb');
  const addBtn = document.getElementById('addBtn');
  if (!url) { msg.textContent = 'enter a URL first'; return; }
  msg.textContent = 'connecting…';
  thumb.hidden = true;
  addBtn.disabled = true;
  try {
    const r = await fetch('/api/settings/camera/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    if (r.ok) {
      const blob = await r.blob();
      thumb.src = URL.createObjectURL(blob);
      thumb.hidden = false;
      msg.textContent = '✓ connected';
      msg.className = 's-test-msg s-green';
      addBtn.disabled = false;
    } else {
      const e = await r.json().catch(()=>({}));
      msg.textContent = '✗ '+(e.error||r.status);
      msg.className = 's-test-msg s-red';
    }
  } catch { msg.textContent = '✗ network error'; msg.className='s-test-msg s-red'; }
});

// Add camera
document.getElementById('addBtn').addEventListener('click', async () => {
  const name = document.getElementById('newName').value.trim();
  const url  = document.getElementById('newUrl').value.trim();
  if (!name || !url) return;
  const r = await fetch('/api/sources',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,url})});
  if (r.ok) {
    document.getElementById('newName').value = '';
    document.getElementById('newUrl').value  = '';
    document.getElementById('testThumb').hidden = true;
    document.getElementById('testMsg').textContent = '';
    document.getElementById('addBtn').disabled = true;
    loadCameras();
  }
});

// Cleanup
document.getElementById('cleanupBtn').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('cleanupDays').value);
  const src  = document.getElementById('cleanupSource').value || undefined;
  const msg  = document.getElementById('cleanupMsg');
  if (!confirm(`Delete all footage older than ${days} days${src?' for '+src:''}? This cannot be undone.`)) return;
  msg.textContent = 'deleting…';
  const r = await fetch('/api/settings/cleanup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days,source_id:src})});
  const d = await r.json();
  if (r.ok) {
    msg.textContent = `deleted ${d.deleted_segments} segments, freed ${fmt.bytes(d.freed_bytes)}`;
    msg.className = 's-test-msg s-green';
    loadStatus();
  } else {
    msg.textContent = '✗ '+(d.error||r.status);
    msg.className = 's-test-msg s-red';
  }
});

async function loadCleanupConfig() {
  const d = await fetch('/api/settings/cleanup-config').then(r=>r.json()).catch(()=>({}));
  const daysEl = document.getElementById('autoDays');
  const gbEl   = document.getElementById('autoGb');
  if (daysEl) daysEl.value = d.cleanup_days ?? '';
  if (gbEl)   gbEl.value   = d.cleanup_max_gb ?? '';
}

document.getElementById('autoSaveBtn')?.addEventListener('click', async () => {
  const days = document.getElementById('autoDays').value.trim();
  const gb   = document.getElementById('autoGb').value.trim();
  const msg  = document.getElementById('autoMsg');
  msg.textContent = 'saving…';
  const r = await fetch('/api/settings/cleanup-config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      cleanup_days:   days  ? parseFloat(days)  : null,
      cleanup_max_gb: gb    ? parseFloat(gb)    : null,
    })
  });
  const d = await r.json();
  if (r.ok) {
    msg.textContent = `saved — ${d.cleanup_days ?? '∞'} days / ${d.cleanup_max_gb ?? '∞'} GB`;
    msg.className = 's-test-msg s-green';
  } else {
    msg.textContent = '✗ ' + (d.error || r.status);
    msg.className = 's-test-msg s-red';
  }
});

loadStatus();
loadCameras();
loadCleanupConfig();
