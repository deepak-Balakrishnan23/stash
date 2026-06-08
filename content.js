/* Stash v2 — Content Script: Recording Toolbar */

var toolbar = null, timerEl = null, recDot = null, timerIv = null;
var elSync = 0, syncT = 0, paused = false;

function createToolbar(elapsed) {
  if (toolbar) {
    // Already shown — just re-sync the timer
    if (elapsed > 0) { elSync = elapsed; syncT = Date.now(); if (timerEl) timerEl.textContent = fmt(elapsed); }
    return;
  }
  elSync = elapsed > 0 ? elapsed : 0;
  syncT  = Date.now();

  toolbar = document.createElement('div');
  toolbar.id = 'stash-toolbar';

  // Build with textContent/createElement where possible to avoid innerHTML on dynamic data.
  // Static SVG markup is safe here (no user data interpolated).
  toolbar.innerHTML =
    '<div class="ll-rec-dot"></div>' +
    '<div class="ll-timer">' + fmt(elSync) + '</div>' +
    '<div class="ll-divider"></div>' +
    '<button class="ll-btn ll-pause" title="Pause">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' +
    '</button>' +
    '<button class="ll-btn ll-stop" title="Stop">' +
      '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' +
    '</button>' +
    '<div class="ll-divider"></div>' +
    '<span class="ll-brand">' +
      '<svg class="ll-mark" width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="6" fill="url(#stashGtb)"/><circle cx="12" cy="12" r="4.4" fill="#fff"/><defs><linearGradient id="stashGtb" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#6E56F0"/><stop offset="1" stop-color="#5B6EF5"/></linearGradient></defs></svg>' +
      'STASH' +
    '</span>';

  document.body.appendChild(toolbar);
  timerEl = toolbar.querySelector('.ll-timer');
  recDot  = toolbar.querySelector('.ll-rec-dot');
  toolbar.querySelector('.ll-pause').onclick = doPause;
  toolbar.querySelector('.ll-stop').onclick  = doStop;
  makeDrag(toolbar);

  requestAnimationFrame(function() {
    requestAnimationFrame(function() { toolbar.classList.add('visible'); });
  });
  startTm();
}

function removeToolbar() {
  if (!toolbar) return;
  clearInterval(timerIv);
  toolbar.classList.remove('visible');
  var r = toolbar;
  setTimeout(function() { if (r && r.parentNode) r.parentNode.removeChild(r); }, 400);
  toolbar = timerEl = recDot = null;
  paused  = false;
}

function getEl() { return paused ? elSync : elSync + (Date.now() - syncT); }
function startTm() {
  clearInterval(timerIv);
  timerIv = setInterval(function() { if (timerEl && !paused) timerEl.textContent = fmt(getEl()); }, 250);
}
function fmt(ms) {
  var s   = Math.floor(Math.max(0, ms) / 1000);
  var sec = s % 60, min = Math.floor(s / 60) % 60, hr = Math.floor(s / 3600);
  if (hr > 0) return hr + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function doPause() {
  if (!toolbar) return;
  var b = toolbar.querySelector('.ll-pause');
  if (paused) {
    elSync = getEl(); syncT = Date.now(); paused = false;
    recDot.classList.remove('paused');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    chrome.runtime.sendMessage({ target: 'background', type: 'RESUME_RECORDING' });
  } else {
    elSync = getEl(); syncT = Date.now(); paused = true;
    recDot.classList.add('paused');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    chrome.runtime.sendMessage({ target: 'background', type: 'PAUSE_RECORDING' });
  }
}

function doStop() {
  chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
  removeToolbar();
}

function makeDrag(el) {
  var drag = false, ox = 0, oy = 0;
  el.addEventListener('mousedown', function(e) {
    if (e.target.closest('.ll-btn')) return;
    drag = true;
    var r = el.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    el.classList.add('dragging'); e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!drag) return;
    el.style.left      = (e.clientX - ox) + 'px';
    el.style.right     = 'auto';
    el.style.bottom    = 'auto';
    el.style.top       = (e.clientY - oy) + 'px';
    el.style.transform = 'none';
  });
  document.addEventListener('mouseup', function() {
    if (drag) { drag = false; el.classList.remove('dragging'); }
  });
}

chrome.runtime.onMessage.addListener(function(m, s, respond) {
  switch (m.type) {

  case 'SHOW_TOOLBAR':
    // elapsed is now passed directly in the message — no extra GET_STATE round-trip needed
    createToolbar(m.elapsed || 0);
    respond({ success: true });
    break;

  case 'HIDE_TOOLBAR':
    removeToolbar();
    respond({ success: true });
    break;

  case 'STATE_UPDATE':
    if (m.isRecording && !toolbar) {
      createToolbar(m.elapsed || 0);
    } else if (m.isRecording && toolbar) {
      elSync  = typeof m.elapsed === 'number' ? m.elapsed : elSync;
      syncT   = Date.now();
      paused  = !!m.isPaused;
      if (recDot) recDot.classList.toggle('paused', paused);
      var pb = toolbar.querySelector('.ll-pause');
      if (pb) {
        pb.innerHTML = paused
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
      }
      if (timerEl) timerEl.textContent = fmt(getEl());
    } else if (!m.isRecording && toolbar) {
      removeToolbar();
    }
    break;
  }
  return true;
});
