/* ═══════════════════════════════════════════════════════════════
   Stash v2 — Popup Controller
   ═══════════════════════════════════════════════════════════════ */

var isRec = false, isPaused = false, timerIv = null;
var syncedElapsed = 0, syncedAt = 0, settings = {};

function $(s) { return document.querySelector(s); }
var views = { main: $('#view-main'), library: $('#view-library'), settings: $('#view-settings') };
var el = {
  recSt: $('#rec-status'), recTm: $('#rec-timer'), recBtn: $('#btn-record'),
  recLbl: $('#rec-btn-label'), actCtrls: $('#active-ctrls'),
  pauseBtn: $('#btn-pause'), stopBtn: $('#btn-stop'),
  libList: $('#lib-list'), empty: $('#empty-state'), count: $('#rec-count')
};

/* ── Navigation ─────────────────────────────────────────────── */

function showView(v) { Object.values(views).forEach(function(x){x.classList.remove('active');}); views[v].classList.add('active'); }
$('#btn-library').onclick = function() { showView('library'); loadLib(); };
$('#btn-settings').onclick = function() { showView('settings'); };
$('#btn-back-lib').onclick = $('#btn-back-set').onclick = function() { showView('main'); };

/* ── Tabs ───────────────────────────────────────────────────── */

$('#tab-capture').onclick = function() { swTab('capture'); };
$('#tab-record').onclick = function() { swTab('record'); };
function swTab(n) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  $('#tab-'+n).classList.add('active'); $('#tab-'+n).setAttribute('aria-selected','true');
  $('#p-'+n).classList.add('active');
}

/* ── Record Mode Cards ──────────────────────────────────────── */

document.querySelectorAll('#p-record .mode-card[data-mode]').forEach(function(c) {
  c.onclick = function() {
    document.querySelectorAll('#p-record .mode-card[data-mode]').forEach(function(x) { x.classList.remove('active'); x.setAttribute('aria-checked','false'); });
    c.classList.add('active'); c.setAttribute('aria-checked','true');
    settings.captureMode = c.dataset.mode; save();
  };
});

/* ── Audio Toggles ──────────────────────────────────────────── */

$('#opt-mic').onclick = function() { this.classList.toggle('off'); settings.includeMic = !this.classList.contains('off'); save(); };
$('#opt-audio').onclick = function() { this.classList.toggle('off'); settings.includeSystemAudio = !this.classList.contains('off'); save(); };

/* ── Dropdowns ──────────────────────────────────────────────── */

function ddToggle(btnId, ddId) {
  $(btnId).onclick = function(e) {
    e.stopPropagation();
    var open = !$(ddId).classList.contains('hidden');
    closeAllDd();
    if (!open) $(ddId).classList.remove('hidden');
  };
}
function closeAllDd() { document.querySelectorAll('.dd').forEach(function(d){d.classList.add('hidden');}); }
document.addEventListener('click', closeAllDd);

ddToggle('#opt-format','#dd-format');
ddToggle('#opt-res','#dd-res');
ddToggle('#opt-save','#dd-save');

function ddBind(ddId, lblId, key) {
  $(ddId).querySelectorAll('.dd-item').forEach(function(it) {
    it.onclick = function(e) {
      e.stopPropagation();
      $(ddId).querySelectorAll('.dd-item').forEach(function(x){x.classList.remove('active');});
      it.classList.add('active');
      $(lblId).textContent = it.dataset.v.toUpperCase();
      settings[key] = it.dataset.v;
      $(ddId).classList.add('hidden');
      save();
    };
  });
}
ddBind('#dd-format','#lbl-format','outputFormat');
ddBind('#dd-res','#lbl-res','resolution');

// Save destination — special handling for cloud
$('#dd-save').querySelectorAll('.dd-item').forEach(function(it) {
  it.onclick = async function(e) {
    e.stopPropagation();
    $('#dd-save').classList.add('hidden');

    if (it.dataset.v === 'cloud') {
      var check = await chrome.runtime.sendMessage({ type: 'CHECK_DRIVE_AUTH' });
      if (!check || !check.connected) {
        // Drive not connected — don't change setting, show toast, go to settings
        toast('Drive not connected', 'err');
        showView('settings');
        return;
      }
    }
    // Only update if we reach here (local always, or cloud when connected)
    $('#dd-save').querySelectorAll('.dd-item').forEach(function(x){x.classList.remove('active');});
    it.classList.add('active');
    $('#lbl-save').textContent = it.dataset.v === 'cloud' ? 'Drive' : 'Local';
    settings.saveTo = it.dataset.v;
    save();
  };
});

/* ── Settings ───────────────────────────────────────────────── */

function save() { chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: cleanSettings(settings) }); }

async function loadState() {
  try {
    var s = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!s) return;
    isRec = s.isRecording || false; isPaused = s.isPaused || false;
    settings = s.settings || {};
    settings._activeMode = s.mode || null;
    syncElapsed(s.elapsed || 0);
    applyUI();
    updateRecUI();
    if (isRec) { swTab('record'); startTimer(); }
  } catch(e) {}
}

function cleanSettings(source) {
  var clean = {};
  ['captureMode', 'includeMic', 'includeSystemAudio', 'resolution', 'outputFormat', 'saveTo'].forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(source, key)) clean[key] = source[key];
  });
  return clean;
}

function applyUI() {
  document.querySelectorAll('#p-record .mode-card[data-mode]').forEach(function(c) {
    var on = c.dataset.mode === (settings.captureMode || 'tab');
    c.classList.toggle('active', on); c.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  $('#opt-mic').classList.toggle('off', settings.includeMic === false);
  $('#opt-audio').classList.toggle('off', settings.includeSystemAudio === false);
  $('#lbl-format').textContent = (settings.outputFormat || 'webm').toUpperCase();
  $('#lbl-res').textContent = settings.resolution || '1080p';
  $('#lbl-save').textContent = settings.saveTo === 'cloud' ? 'Drive' : 'Local';

  // Sync dropdown active states
  $('#dd-format').querySelectorAll('.dd-item').forEach(function(i){i.classList.toggle('active',i.dataset.v===(settings.outputFormat||'webm'));});
  $('#dd-res').querySelectorAll('.dd-item').forEach(function(i){i.classList.toggle('active',i.dataset.v===(settings.resolution||'1080p'));});
  $('#dd-save').querySelectorAll('.dd-item').forEach(function(i){i.classList.toggle('active',i.dataset.v===(settings.saveTo||'local'));});
}

/* ── Timer ──────────────────────────────────────────────────── */

function elapsed() {
  if (!isRec) return 0;
  return isPaused ? syncedElapsed : syncedElapsed + (Date.now() - syncedAt);
}

function syncElapsed(ms) {
  syncedElapsed = Math.max(0, ms || 0);
  syncedAt = Date.now();
}
function startTimer() {
  clearInterval(timerIv);
  el.recTm.textContent = fmtTime(elapsed());
  timerIv = setInterval(function() { if (!isRec){clearInterval(timerIv);return;} el.recTm.textContent = fmtTime(elapsed()); }, 250);
}
function fmtTime(ms) {
  var s = Math.floor(ms/1000), sec=s%60, min=Math.floor(s/60)%60, hr=Math.floor(s/3600);
  if (hr>0) return hr+':'+String(min).padStart(2,'0')+':'+String(sec).padStart(2,'0');
  return String(min).padStart(2,'0')+':'+String(sec).padStart(2,'0');
}

/* ── Recording Controls ─────────────────────────────────────── */

el.recBtn.onclick = async function() { if (isRec) await doStop(); else await doStart(); };
el.pauseBtn.onclick = async function() {
  if (!isRec) return;
  if (isPaused) {
    var r = await chrome.runtime.sendMessage({type:'RESUME_RECORDING'});
    if (r&&r.success){var currentElapsed = elapsed(); isPaused=false; syncElapsed(currentElapsed); updateRecUI(); startTimer();}
  } else {
    var r2 = await chrome.runtime.sendMessage({type:'PAUSE_RECORDING'});
    if (r2&&r2.success){syncElapsed(elapsed());isPaused=true;updateRecUI();}
  }
};
el.stopBtn.onclick = async function() { await doStop(); };

async function doStart() {
  el.recBtn.style.pointerEvents='none'; el.recLbl.textContent='Starting...';
  try {
    var r = await chrome.runtime.sendMessage({type:'START_RECORDING'});
    if (r&&r.error){toast(r.error,'err');el.recLbl.textContent='Start Recording';el.recBtn.style.pointerEvents='';return;}

    if (r&&r.pending) {
      // Camera mode — popup closes, camera overlay handles everything
      el.recLbl.textContent='Opening camera...';
      el.recBtn.style.pointerEvents='';
      return;
    }

    isRec=true;isPaused=false;settings._activeMode = (r && r.mode) || settings.captureMode || null; syncElapsed((r && r.elapsed) || 0);
    updateRecUI(); startTimer();
    if (r && r.warning) toast(r.warning, '');
  } catch(e){toast('Failed','err');el.recLbl.textContent='Start Recording';}
  el.recBtn.style.pointerEvents='';
}
async function doStop() {
  if (!isRec) return;
  el.stopBtn.style.pointerEvents='none';
  try {
    var r = await chrome.runtime.sendMessage({type:'STOP_RECORDING'});
    if (r && r.error) { toast(r.error, 'err'); return; }
    isRec=false;isPaused=false;clearInterval(timerIv);updateRecUI();
    syncElapsed(0);
    if (r&&r.recording) toast(r.warning || 'Saved successfully', 'ok');
  } catch(e){toast('Stop failed','err');}
  finally { el.stopBtn.style.pointerEvents=''; }
}

function updateRecUI() {
  var isCam = (settings._activeMode === 'camera');
  if (isRec) {
    el.recSt.classList.remove('hidden'); el.recBtn.classList.add('on');
    el.recLbl.textContent = isCam ? 'Camera active...' : 'Recording...';
    // Camera has its own pause/stop in the overlay — hide popup controls
    if (isCam) {
      el.actCtrls.classList.add('hidden');
    } else {
      el.actCtrls.classList.remove('hidden');
    }
    if (isPaused && !isCam) {
      el.recSt.classList.add('paused'); el.recSt.querySelector('.rec-lbl').textContent='Paused';
      el.pauseBtn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    } else {
      el.recSt.classList.remove('paused'); el.recSt.querySelector('.rec-lbl').textContent = isCam ? 'Camera' : 'Recording';
      el.pauseBtn.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    }
  } else {
    el.recSt.classList.add('hidden'); el.recSt.classList.remove('paused');
    el.recBtn.classList.remove('on'); el.actCtrls.classList.add('hidden');
    el.recLbl.textContent='Start Recording'; el.recTm.textContent='00:00';
  }
}

/* ── Screenshots ────────────────────────────────────────────── */

$('#btn-ss-visible').onclick = async function() {
  toast('Capturing...','');
  var res = await chrome.runtime.sendMessage({type:'SCREENSHOT_VISIBLE'});
  if (res && res.error) toast(res.error, 'err');
};
$('#btn-ss-full').onclick = async function() {
  toast('Capturing full page...','');
  var res = await chrome.runtime.sendMessage({type:'SCREENSHOT_FULL'});
  if (res && res.error) toast(res.error, 'err');
};
$('#btn-ss-area').onclick = function() { chrome.runtime.sendMessage({type:'START_AREA_SELECT'}); window.close(); };

/* ── Library ────────────────────────────────────────────────── */

async function loadLib() {
  try {
    var recs = (await chrome.runtime.sendMessage({type:'GET_RECORDINGS'})) || [];
    el.count.textContent = recs.length;
    el.libList.querySelectorAll('.lib-item').forEach(function(x){x.remove();});
    if (!recs.length) { el.empty.style.display='flex'; return; }
    el.empty.style.display='none';
    recs.forEach(function(rec) {
      var d = document.createElement('div'); d.className='lib-item'; d.setAttribute('role','listitem');
      d.innerHTML='<div class="lib-ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>'+
        '<div class="lib-info"><div class="lib-title">'+esc(rec.title)+'</div><div class="lib-meta"><span>'+fmtDur(rec.duration)+'</span><span>'+(rec.format||'webm').toUpperCase()+'</span><span>'+fmtSize(rec.size)+'</span></div></div>'+
        '<div class="lib-actions"><button class="lib-act dl" title="Download" aria-label="Download"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>'+
        '<button class="lib-act del" title="Delete" aria-label="Delete"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button></div>';
      d.querySelector('.dl').onclick=function(){chrome.runtime.sendMessage({type:'DOWNLOAD_RECORDING',recordingId:rec.id,recording:rec});};
      d.querySelector('.del').onclick=function(){chrome.runtime.sendMessage({type:'DELETE_RECORDING',recordingId:rec.id});toast('Deleted','');loadLib();};
      el.libList.appendChild(d);
    });
  } catch(e){}
}
function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
function fmtDur(ms){var s=Math.floor((ms||0)/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m';return Math.floor(m/60)+'h';}
function fmtSize(b){if(!b)return'0 B';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(1)+' GB';}

/* ── Drive Auth ─────────────────────────────────────────────── */

$('#btn-drive-auth').onclick = function() {
  chrome.identity.getAuthToken({interactive:true}, function(tok) {
    if (chrome.runtime.lastError) {
      var m = chrome.runtime.lastError.message||'';
      toast(m.indexOf('OAuth2')!==-1||m.indexOf('client')!==-1 ? 'Set Client ID in manifest.json first' : 'Auth failed: '+m, 'err');
    } else if (tok) {
      toast('Connected to Drive!','ok');
      $('#btn-drive-auth').textContent='Connected \u2713';
      $('#btn-drive-auth').style.color='var(--green)';
      $('#btn-drive-auth').style.borderColor='var(--green)';
    }
  });
};

/* ── Toast ──────────────────────────────────────────────────── */

var toastTm;
function toast(msg, type) {
  var t = document.querySelector('.toast');
  if (!t) { t=document.createElement('div'); t.className='toast'; document.body.appendChild(t); }
  t.textContent=msg; t.className='toast'+(type?' '+type:'');
  clearTimeout(toastTm);
  requestAnimationFrame(function(){t.classList.add('show');toastTm=setTimeout(function(){t.classList.remove('show');},2500);});
}

/* ── State Sync ─────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(m) {
  if (m.type==='STATE_UPDATE'){
    isRec=m.isRecording; isPaused=m.isPaused;
    syncElapsed(m.elapsed || 0);
    if(isRec) el.recTm.textContent=fmtTime(m.elapsed || 0);
    // Track mode for UI decisions
    if (m.mode) settings._activeMode = m.mode;
    if (!isRec) settings._activeMode = null;
    if (isRec) startTimer(); else clearInterval(timerIv);
    updateRecUI();
  }
});

function keepAlive(){try{var p=chrome.runtime.connect({name:'keepAlive'});p.onDisconnect.addListener(function(){setTimeout(keepAlive,1000);});}catch(e){setTimeout(keepAlive,2000);}}

loadState(); keepAlive();
