/* ═══════════════════════════════════════════════════════════════
   Stash — Camera window controller (self-contained)
   Live preview, record/pause/stop, store to StashDB, download / Drive.
   ═══════════════════════════════════════════════════════════════ */

var els = {
  video:   document.getElementById('cam-video'),
  badge:   document.getElementById('cam-badge'),
  badgeLbl:document.getElementById('cam-badge-lbl'),
  close:   document.getElementById('cam-close'),
  status:  document.getElementById('cam-status'),
  pause:   document.getElementById('cam-pause'),
  record:  document.getElementById('cam-record'),
  timer:   document.getElementById('cam-timer')
};

var stream = null, recorder = null, chunks = [];
var recording = false, paused = false;
var startTs = 0, pausedMs = 0, pauseStart = 0, timerIv = null;
var output = { format: 'webm', mimeType: 'video/webm', warning: null };
var ctx = { recordingId: null, settings: {} };
var notifiedStop = false;

/* ── Init: get settings + the recordingId reserved by background ─ */

(async function init() {
  try {
    var info = await chrome.runtime.sendMessage({ type: 'CAMERA_INIT' });
    ctx.recordingId = (info && info.recordingId) || ('cam_' + Date.now());
    ctx.settings    = (info && info.settings) || {};
  } catch (e) {
    ctx.recordingId = 'cam_' + Date.now();
    ctx.settings    = {};
  }
  output = stashPickMime(ctx.settings.outputFormat || 'mp4');
  await openCamera();
})();

async function openCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: ctx.settings.includeMic !== false
    });
    els.video.srcObject = stream;
    setStatus('Ready', 'ready');
    els.record.disabled = false;
  } catch (err) {
    setStatus('Camera access blocked', 'err');
    chrome.runtime.sendMessage({ type: 'CAMERA_CANCELLED' });
    els.record.disabled = true;
  }
}

/* ── Controls ───────────────────────────────────────────────── */

els.record.onclick = function() { if (recording) stop(); else start(); };
els.pause.onclick  = function() { if (!recording) return; paused ? resume() : pause(); };
els.close.onclick  = function() { if (recording) stop(); else cancelAndClose(); };
window.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { if (recording) stop(); else cancelAndClose(); }
});
window.addEventListener('beforeunload', function() {
  if (!recording && !notifiedStop) chrome.runtime.sendMessage({ type: 'CAMERA_CANCELLED' });
});

// Long-recording check-in: background asks us to stop & save
chrome.runtime.onMessage.addListener(function(m) {
  if (m && m.type === 'CAMERA_STOP_REQUEST' && recording) stop();
});

function start() {
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: output.mimeType, videoBitsPerSecond: 6000000 });
  recorder.ondataavailable = function(e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = finalize;
  recorder.start(1000);

  recording = true; paused = false; startTs = Date.now(); pausedMs = 0;
  els.record.classList.add('on');
  els.record.setAttribute('aria-label', 'Stop recording');
  els.pause.classList.remove('hidden');
  els.badge.classList.remove('hidden');
  setStatus('Recording', 'rec');
  startTimer();

  chrome.runtime.sendMessage({ type: 'CAMERA_STARTED' });
  if (output.warning) setStatus(output.warning, 'rec');
}

function pause() {
  if (!recorder || recorder.state !== 'recording') return;
  recorder.pause(); paused = true; pauseStart = Date.now();
  els.badge.classList.add('paused'); els.badgeLbl.textContent = 'PAUSED';
  els.pause.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  clearInterval(timerIv);
}

function resume() {
  if (!recorder || recorder.state !== 'paused') return;
  recorder.resume(); paused = false; pausedMs += Date.now() - pauseStart;
  els.badge.classList.remove('paused'); els.badgeLbl.textContent = 'REC';
  els.pause.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  startTimer();
}

function stop() {
  if (!recorder || recorder.state === 'inactive') { cancelAndClose(); return; }
  els.record.classList.remove('on');
  els.pause.classList.add('hidden');
  clearInterval(timerIv);
  setStatus('Saving…', 'ready');
  recorder.stop();
}

async function finalize() {
  recording = false;
  var duration = Date.now() - startTs - pausedMs;
  var blob = new Blob(chunks, { type: output.mimeType });
  if (stream) stream.getTracks().forEach(function(t) { t.stop(); });

  var title = 'Camera ' + new Date().toLocaleString();
  var meta  = {
    id: ctx.recordingId, title: title, duration: Math.max(0, duration),
    format: output.format, timestamp: Date.now(), size: blob.size
  };

  try {
    await stashStoreBlob(ctx.recordingId, blob);
    await addToLibrary(meta);

    if (ctx.settings.saveTo === 'cloud') {
      setStatus('Uploading to Drive…', 'ready');
      var up = await chrome.runtime.sendMessage({ type: 'UPLOAD_TO_DRIVE', recording: meta });
      setStatus(up && up.success ? 'Uploaded ✓' : 'Drive upload failed', up && up.success ? 'ready' : 'err');
    } else {
      stashDownloadBlob(blob, stashSafeName(title) + '.' + output.format);
      setStatus('Saved ✓', 'ready');
    }
  } catch (e) {
    setStatus('Save failed', 'err');
  }

  notifiedStop = true;
  chrome.runtime.sendMessage({ type: 'CAMERA_STOPPED' });
  els.badge.classList.add('hidden');
  setTimeout(function() { window.close(); }, 1400);
}

async function addToLibrary(meta) {
  var data = await chrome.storage.local.get('recordings');
  var recs = data.recordings || [];
  recs.unshift(meta);
  await chrome.storage.local.set({ recordings: recs });
}

function cancelAndClose() {
  notifiedStop = true;
  if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
  chrome.runtime.sendMessage({ type: 'CAMERA_CANCELLED' });
  window.close();
}

/* ── Timer + status ─────────────────────────────────────────── */

function startTimer() {
  clearInterval(timerIv);
  tick();
  timerIv = setInterval(tick, 250);
}
function tick() {
  var ms = paused ? (pauseStart - startTs - pausedMs) : (Date.now() - startTs - pausedMs);
  var s = Math.floor(Math.max(0, ms) / 1000), sec = s % 60, min = Math.floor(s / 60) % 60, hr = Math.floor(s / 3600);
  els.timer.textContent = hr > 0
    ? hr + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
    : String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}
function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = 'cam-status' + (cls ? ' ' + cls : '');
}
