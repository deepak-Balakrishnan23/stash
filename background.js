/* ═══════════════════════════════════════════════════════════════
   Stash — Background Service Worker
   ═══════════════════════════════════════════════════════════════ */

var STATE = {
  isRecording: false,
  isPaused:    false,
  isPending:   false,    // camera window opening, or recording handshake in flight
  startTime:   0,
  pausedDuration: 0,
  pauseStart:  0,
  recordingId: null,
  toolbarTabId: null,
  cameraWindowId: null,
  mode: null,            // 'screen' | 'tab' | 'camera'
  settings: {
    captureMode: 'tab',
    includeMic: true,
    includeSystemAudio: true,
    resolution: '1080p',
    outputFormat: 'mp4',   // MP4 is the default output
    saveTo: 'local'
  }
};

var ALLOWED_FORMATS = ['mp4', 'webm'];
var DRIVE_MIME = { mp4: 'video/mp4', webm: 'video/webm' };

/* ── Offscreen Document ─────────────────────────────────────── */

async function ensureOffscreen() {
  if (typeof chrome.runtime.getContexts === 'function') {
    var ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
    });
    if (ctx.length > 0) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
      justification: 'Media recording and image processing'
    });
  } catch (e) {
    if (e.message && e.message.includes('single offscreen')) return; // race-safe
    throw e;
  }
}

function sendToOffscreen(msg) {
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage(Object.assign({}, msg, { target: 'offscreen' }), function(res) {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res);
    });
  });
}

/* ── Settings ───────────────────────────────────────────────── */

async function loadSettings() {
  var data = await chrome.storage.local.get(['settings', 'formatMigratedV2']);
  if (data.settings) Object.assign(STATE.settings, sanitizeSettings(data.settings));

  // One-time v2 migration: the old build defaulted to WebM and never offered a
  // working MP4 path. Promote existing users to the new MP4 default once.
  if (!data.formatMigratedV2) {
    STATE.settings.outputFormat = 'mp4';
    await chrome.storage.local.set({ settings: STATE.settings, formatMigratedV2: true });
  }

  if (ALLOWED_FORMATS.indexOf(STATE.settings.outputFormat) === -1) STATE.settings.outputFormat = 'mp4';
  if (!STATE.settings.saveTo) STATE.settings.saveTo = 'local';
  return STATE.settings;
}

async function saveSettings(s) {
  Object.assign(STATE.settings, sanitizeSettings(s));
  await chrome.storage.local.set({ settings: STATE.settings });
  return STATE.settings;
}

function sanitizeSettings(s) {
  var next = {};
  if (!s || typeof s !== 'object') return next;
  ['captureMode', 'includeMic', 'includeSystemAudio', 'resolution', 'outputFormat', 'saveTo'].forEach(function(key) {
    if (Object.prototype.hasOwnProperty.call(s, key)) next[key] = s[key];
  });
  if (next.outputFormat && ALLOWED_FORMATS.indexOf(next.outputFormat) === -1) next.outputFormat = 'mp4';
  return next;
}

/* ── Recordings Library ─────────────────────────────────────── */

async function getRecordings() {
  return ((await chrome.storage.local.get('recordings')).recordings || []);
}

async function addRecording(meta) {
  var recs = await getRecordings();
  recs.unshift(meta);
  await chrome.storage.local.set({ recordings: recs });
  return recs;
}

async function deleteRecording(id) {
  var recs = (await getRecordings()).filter(function(r) { return r.id !== id; });
  await chrome.storage.local.set({ recordings: recs });
  try {
    await ensureOffscreen();
    await sendToOffscreen({ type: 'DELETE_BLOB', recordingId: id });
  } catch (e) { /* non-fatal — cleaned up on next startup */ }
  return recs;
}

/* ── Save / Download ────────────────────────────────────────── */
//
// All video downloads go through the offscreen document, which performs a
// real anchor-click download from a persistent context. This avoids the
// chrome.downloads + data:/blob: URL failures that previously produced the
// "Check Internet connection" error and silently dropped files.

async function downloadRecording(recordingId, title, format) {
  var fmt  = ALLOWED_FORMATS.indexOf(format) !== -1 ? format : 'webm';
  var name = (title || 'recording').replace(/[<>:"\/\\|?*]/g, '_') + '.' + fmt;

  if (STATE.settings.saveTo === 'cloud') {
    return await uploadToDrive(recordingId, name, DRIVE_MIME[fmt] || 'video/webm');
  }
  try {
    await ensureOffscreen();
    var r = await sendToOffscreen({ type: 'DOWNLOAD_FROM_IDB', recordingId: recordingId, filename: name });
    if (r && r.error) return { error: r.error };
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

/* ── Google Drive (optional) ────────────────────────────────── */

async function getDriveToken() {
  var has = await new Promise(function(res) { chrome.permissions.contains({ permissions: ['identity'] }, res); });
  if (!has) throw new Error('Google Drive not connected — enable it in Settings first.');
  return new Promise(function(resolve, reject) {
    chrome.identity.getAuthToken({ interactive: true }, function(tok) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tok);
    });
  });
}

async function uploadToDrive(recordingId, filename, mimeType) {
  try {
    var token = await getDriveToken();
    var blob  = await sendToOffscreen({ type: 'GET_BLOB_DATA', recordingId: recordingId });
    if (!blob || !blob.base64) throw new Error('Recording data not found');
    var base64Data = blob.base64;

    var searchRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=name%3D'Stash'+and+mimeType%3D'application/vnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id)",
      { headers: { Authorization: 'Bearer ' + token } });
    if (!searchRes.ok) throw new Error('Failed to access Google Drive');
    var search = await searchRes.json();
    var folderId;
    if (search.files && search.files.length > 0) {
      folderId = search.files[0].id;
    } else {
      var cf = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Stash', mimeType: 'application/vnd.google-apps.folder' })
      });
      if (!cf.ok) throw new Error('Failed to create Stash folder in Drive');
      folderId = (await cf.json()).id;
    }

    var boundary = '---StashBoundary';
    var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: filename, mimeType: mimeType, parents: [folderId] }) +
      '\r\n--' + boundary + '\r\nContent-Type: ' + mimeType + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      base64Data + '\r\n--' + boundary + '--';

    var up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body });
    if (!up.ok) throw new Error('Upload to Drive failed');
    return { success: true, file: await up.json() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* ── State Helpers ──────────────────────────────────────────── */

function resetState() {
  STATE.isRecording = false; STATE.isPaused = false; STATE.isPending = false;
  STATE.startTime = 0; STATE.pausedDuration = 0; STATE.pauseStart = 0;
  STATE.recordingId = null; STATE.toolbarTabId = null; STATE.cameraWindowId = null;
  STATE.mode = null;
  chrome.action.setBadgeText({ text: '' });
  clearRecLimit();
}

function getElapsed() {
  if (!STATE.isRecording) return 0;
  var e = Date.now() - STATE.startTime - STATE.pausedDuration;
  if (STATE.isPaused) e -= (Date.now() - STATE.pauseStart);
  return Math.max(0, e);
}

/* Stop the active tab/screen recording, save it, and reset. Reused by the
   STOP_RECORDING message and the long-recording notification. */
async function stopTabScreen() {
  if (!STATE.isRecording || STATE.mode === 'camera') return { error: 'Not recording' };
  var dur = getElapsed();
  var sr  = await sendToOffscreen({ type: 'STOP_RECORDING', recordingId: STATE.recordingId });
  if (!sr || sr.error) return { error: (sr && sr.error) || 'Failed to stop recording' };

  var saveTo = STATE.settings.saveTo;
  var meta = {
    id: STATE.recordingId, title: 'Recording ' + new Date().toLocaleString(),
    duration: dur, format: sr.actualFormat || STATE.settings.outputFormat,
    timestamp: Date.now(), size: sr.size || 0
  };
  var toolbarTabId = STATE.toolbarTabId;
  await addRecording(meta);
  if (toolbarTabId) chrome.tabs.sendMessage(toolbarTabId, { type: 'HIDE_TOOLBAR' }).catch(function() {});
  resetState();
  broadcastState();

  var saveResult = await downloadRecording(meta.id, meta.title, meta.format);
  if (saveResult && saveResult.error) return { error: saveResult.error, recording: meta, warning: sr.warning || null };
  return { success: true, recording: meta, warning: sr.warning || null, saveTo: saveTo };
}

/* ── Long-recording check-in ────────────────────────────────── */
var REC_LIMIT_NOTIF = 'stash-rec-limit';

function armRecLimitAlarm() {
  // Fire at 10 min, then every 10 min, so the user is never recording
  // unknowingly for a long time.
  chrome.alarms.create('recLimit', { delayInMinutes: 10, periodInMinutes: 10 });
}
function clearRecLimit() {
  chrome.alarms.clear('recLimit');
  chrome.notifications.clear(REC_LIMIT_NOTIF);
}

function warnLongRecording() {
  if (!STATE.isRecording) { clearRecLimit(); return; }
  var mins = Math.max(1, Math.round(getElapsed() / 60000));
  chrome.notifications.create(REC_LIMIT_NOTIF, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Stash is still recording',
    message: 'You’ve been recording for about ' + mins + ' minutes. Keep going?',
    buttons: [{ title: 'Keep Recording' }, { title: 'Stop & Save' }],
    requireInteraction: true,
    priority: 2
  });
}

async function stopFromNotification() {
  if (!STATE.isRecording) return;
  if (STATE.mode === 'camera') {
    // The camera window owns its recorder — ask it to stop & save
    chrome.runtime.sendMessage({ type: 'CAMERA_STOP_REQUEST' }).catch(function() {});
  } else {
    await stopTabScreen();
  }
}

function broadcastState() {
  var message = {
    target: 'popup', type: 'STATE_UPDATE',
    isRecording: STATE.isRecording, isPaused: STATE.isPaused,
    elapsed: getElapsed(), mode: STATE.mode
  };
  chrome.runtime.sendMessage(message).catch(function() {});
  if (STATE.toolbarTabId) chrome.tabs.sendMessage(STATE.toolbarTabId, message).catch(function() {});
}

/* ── Message Router ─────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.target === 'offscreen') return false;
  handleMessage(msg, sender).then(sendResponse).catch(function(e) { sendResponse({ error: e.message }); });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

  case 'GET_STATE':
    await loadSettings();
    return {
      isRecording: STATE.isRecording, isPaused: STATE.isPaused, settings: STATE.settings,
      elapsed: getElapsed(), mode: STATE.mode
    };

  case 'UPDATE_SETTINGS':
    return await saveSettings(msg.settings);

  case 'CHECK_DRIVE_AUTH':
    try { await getDriveToken(); return { connected: true }; }
    catch (e) { return { connected: false, error: e.message }; }

  /* ══ Recording ══════════════════════════════════════════════ */

  case 'START_RECORDING': {
    if (STATE.isRecording || STATE.isPending) return { error: 'Already recording' };
    await loadSettings();
    STATE.recordingId = 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    /* ── Camera → dedicated window ────────────────────────── */
    if (STATE.settings.captureMode === 'camera') {
      STATE.mode = 'camera';
      STATE.isPending = true;
      var win = await chrome.windows.create({
        url: chrome.runtime.getURL('camera.html'),
        type: 'popup', width: 760, height: 680, focused: true
      });
      STATE.cameraWindowId = win.id;
      return { success: true, pending: true, camera: true };
    }

    /* ── Tab / Screen → offscreen ─────────────────────────── */
    STATE.mode = STATE.settings.captureMode; // 'screen' | 'tab'
    await ensureOffscreen();
    STATE.startTime = Date.now(); STATE.pausedDuration = 0; STATE.pauseStart = 0;

    var streamId  = null;
    var targetTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    STATE.toolbarTabId = targetTab && targetTab.id ? targetTab.id : null;

    if (STATE.settings.captureMode === 'tab' && targetTab) {
      streamId = await new Promise(function(res, rej) {
        chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, function(id) {
          if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(id);
        });
      });
    }

    var r = await sendToOffscreen({ type: 'START_RECORDING', settings: STATE.settings, recordingId: STATE.recordingId, streamId: streamId });
    if (r && r.error) { STATE.recordingId = null; STATE.mode = null; return { error: r.error }; }

    STATE.isRecording = true; STATE.isPaused = false;
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85d04' });
    armRecLimitAlarm();
    broadcastState();
    if (STATE.toolbarTabId) chrome.tabs.sendMessage(STATE.toolbarTabId, { type: 'SHOW_TOOLBAR', elapsed: 0 }).catch(function() {});

    return { success: true, recordingId: STATE.recordingId, mode: STATE.mode, elapsed: 0,
             actualFormat: r.actualFormat || STATE.settings.outputFormat, warning: r.warning || null };
  }

  /* ── Camera window lifecycle ────────────────────────────── */

  case 'CAMERA_INIT':   // camera.html requesting its reserved id + settings
    return { recordingId: STATE.recordingId || ('cam_' + Date.now()), settings: STATE.settings };

  case 'CAMERA_STARTED':
    STATE.isRecording = true; STATE.isPaused = false; STATE.isPending = false;
    STATE.startTime = Date.now(); STATE.pausedDuration = 0; STATE.pauseStart = 0;
    chrome.action.setBadgeText({ text: 'CAM' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85d04' });
    armRecLimitAlarm();
    broadcastState();
    return { success: true };

  case 'CAMERA_STOPPED':
  case 'CAMERA_CANCELLED':
    resetState();
    broadcastState();
    return { success: true };

  case 'FOCUS_CAMERA':
    if (STATE.cameraWindowId != null) {
      try { await chrome.windows.update(STATE.cameraWindowId, { focused: true }); } catch (e) {}
    }
    return { success: true };

  /* ── Pause / Resume (tab/screen) ────────────────────────── */

  case 'PAUSE_RECORDING':
    if (!STATE.isRecording || STATE.isPaused || STATE.mode === 'camera') return { success: false };
    STATE.isPaused = true; STATE.pauseStart = Date.now();
    await sendToOffscreen({ type: 'PAUSE_RECORDING' });
    chrome.action.setBadgeText({ text: '❚❚' });
    broadcastState();
    return { success: true };

  case 'RESUME_RECORDING':
    if (!STATE.isRecording || !STATE.isPaused || STATE.mode === 'camera') return { success: false };
    STATE.pausedDuration += Date.now() - STATE.pauseStart;
    STATE.isPaused = false; STATE.pauseStart = 0;
    await sendToOffscreen({ type: 'RESUME_RECORDING' });
    chrome.action.setBadgeText({ text: 'REC' });
    broadcastState();
    return { success: true };

  /* ── Stop (tab/screen) ──────────────────────────────────── */

  case 'STOP_RECORDING': {
    if (!STATE.isRecording) return { error: 'Not recording' };
    if (STATE.mode === 'camera') return { error: 'Use the camera window to stop' };
    return await stopTabScreen();
  }

  case 'DOWNLOAD_RECORDING': {
    var dr = msg.recording || {};
    return await downloadRecording(msg.recordingId, dr.title || 'recording', dr.format || 'webm');
  }

  case 'UPLOAD_TO_DRIVE': {
    var ur = msg.recording;
    if (!ur) return { error: 'No recording' };
    var uf = ALLOWED_FORMATS.indexOf(ur.format) !== -1 ? ur.format : 'webm';
    return await uploadToDrive(ur.id, (ur.title || 'recording') + '.' + uf, DRIVE_MIME[uf] || 'video/webm');
  }

  case 'GET_RECORDINGS':
    return await getRecordings();

  case 'DELETE_RECORDING':
    return await deleteRecording(msg.recordingId);

  /* ══ Screenshots ════════════════════════════════════════════ */

  case 'START_AREA_SELECT': {
    var sat = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!sat || !sat.id) return { error: 'No tab' };
    await chrome.scripting.executeScript({
      target: { tabId: sat.id },
      func: function() {
        var old = document.getElementById('stash-area-overlay'); if (old) old.remove();
        var ov = document.createElement('div'); ov.id = 'stash-area-overlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.3);';
        var bx = document.createElement('div');
        bx.style.cssText = 'position:absolute;border:2px dashed #e85d04;background:rgba(232,93,4,0.06);display:none;pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,0.35);';
        ov.appendChild(bx);
        var ht = document.createElement('div');
        ht.textContent = 'Drag to select · ESC to cancel';
        ht.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);font:13px/1 -apple-system,sans-serif;color:#fff;background:rgba(0,0,0,0.75);padding:8px 18px;border-radius:6px;z-index:2147483647;pointer-events:none;';
        ov.appendChild(ht);
        var sx = 0, sy = 0, on = false;
        ov.addEventListener('mousedown', function(e) { sx = e.clientX; sy = e.clientY; on = true; bx.style.display = 'block'; bx.style.left = sx + 'px'; bx.style.top = sy + 'px'; bx.style.width = '0'; bx.style.height = '0'; ht.style.display = 'none'; e.preventDefault(); });
        ov.addEventListener('mousemove', function(e) { if (!on) return; var x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy); bx.style.left = x + 'px'; bx.style.top = y + 'px'; bx.style.width = Math.abs(e.clientX - sx) + 'px'; bx.style.height = Math.abs(e.clientY - sy) + 'px'; });
        ov.addEventListener('mouseup', function(e) { if (!on) return; on = false; var r = { x: Math.min(e.clientX, sx), y: Math.min(e.clientY, sy), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) }; ov.remove(); if (r.w > 5 && r.h > 5) { setTimeout(function() { chrome.runtime.sendMessage({ target: 'background', type: 'SCREENSHOT_AREA', rect: r, dpr: window.devicePixelRatio || 1 }); }, 200); } });
        document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } });
        document.body.appendChild(ov);
      }
    });
    return { success: true };
  }

  case 'SCREENSHOT_VISIBLE': {
    var vt = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!vt) return { error: 'No tab' };
    try {
      var vd = await chrome.tabs.captureVisibleTab(vt.windowId, { format: 'png' });
      await chrome.downloads.download({ url: vd, filename: 'Screenshot_' + Date.now() + '.png', saveAs: false });
      return { success: true };
    } catch (e) { return { error: e.message }; }
  }

  case 'SCREENSHOT_FULL': {
    var ft = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!ft) return { error: 'No tab' };
    var dm = (await chrome.scripting.executeScript({
      target: { tabId: ft.id },
      func: function() {
        return { sh: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
                 vw: window.innerWidth, vh: Math.max(window.innerHeight, 1), sy: window.scrollY, dpr: window.devicePixelRatio || 1 };
      }
    }))[0].result;

    var chunks = [], positions = [];
    for (var y = 0; y < dm.sh; y += dm.vh) positions.push(y);

    try {
      for (var i = 0; i < positions.length; i++) {
        await chrome.scripting.executeScript({ target: { tabId: ft.id }, func: function(s) { window.scrollTo(0, s); }, args: [positions[i]] });
        await new Promise(function(r) { setTimeout(r, 450); });
        var actualY = (await chrome.scripting.executeScript({ target: { tabId: ft.id }, func: function() { return window.scrollY; } }))[0].result;
        chunks.push({ dataUrl: await chrome.tabs.captureVisibleTab(ft.windowId, { format: 'png' }), scrollY: actualY });
      }
      await chrome.scripting.executeScript({ target: { tabId: ft.id }, func: function(s) { window.scrollTo(0, s); }, args: [dm.sy] });

      if (chunks.length === 1) {
        await chrome.downloads.download({ url: chunks[0].dataUrl, filename: 'Screenshot_Full_' + Date.now() + '.png', saveAs: false });
        return { success: true };
      }
      await ensureOffscreen();
      var st2 = await sendToOffscreen({ type: 'STITCH_SCREENSHOTS', chunks: chunks,
        totalWidth: dm.vw * dm.dpr, totalHeight: dm.sh * dm.dpr, dpr: dm.dpr });
      if (st2 && st2.dataUrl) {
        await chrome.downloads.download({ url: st2.dataUrl, filename: 'Screenshot_Full_' + Date.now() + '.png', saveAs: false });
        return { success: true };
      }
      return { error: 'Stitch failed' };
    } catch (e) { return { error: e.message }; }
  }

  case 'SCREENSHOT_AREA': {
    var at2 = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!at2) return { error: 'No tab' };
    var rect = msg.rect || {}, dpr = msg.dpr || 1;
    if (typeof rect.x !== 'number' || typeof rect.y !== 'number' || typeof rect.w !== 'number' || typeof rect.h !== 'number' || rect.w <= 0 || rect.h <= 0)
      return { error: 'Invalid selection' };
    try {
      var fc = await chrome.tabs.captureVisibleTab(at2.windowId, { format: 'png' });
      await ensureOffscreen();
      var cr = await sendToOffscreen({ type: 'CROP_SCREENSHOT', dataUrl: fc,
        x: Math.round(rect.x * dpr), y: Math.round(rect.y * dpr), w: Math.round(rect.w * dpr), h: Math.round(rect.h * dpr) });
      if (cr && cr.dataUrl) {
        await chrome.downloads.download({ url: cr.dataUrl, filename: 'Screenshot_Area_' + Date.now() + '.png', saveAs: false });
        return { success: true };
      }
      return { error: 'Crop failed' };
    } catch (e) { return { error: e.message }; }
  }

  default: return {};
  }
}

/* ── Lifecycle listeners ────────────────────────────────────── */

// Camera window closed without a clean stop → reset state
chrome.windows.onRemoved.addListener(function(windowId) {
  if (STATE.cameraWindowId === windowId) { resetState(); broadcastState(); }
});

async function cleanupOldRecordings() {
  var CUT  = Date.now() - (3 * 86400000);
  var recs = await getRecordings();
  var stale = recs.filter(function(r) { return r.timestamp && r.timestamp < CUT; });
  if (stale.length === 0) return;
  try {
    await ensureOffscreen();
    for (var i = 0; i < stale.length; i++) await sendToOffscreen({ type: 'DELETE_BLOB', recordingId: stale[i].id });
  } catch (e) {}
  var kept = recs.filter(function(r) { return !(r.timestamp && r.timestamp < CUT); });
  await chrome.storage.local.set({ recordings: kept });
}

chrome.runtime.onInstalled.addListener(async function() {
  await loadSettings();
  chrome.action.setBadgeText({ text: '' });
  chrome.alarms.create('dailyCleanup', { periodInMinutes: 1440 });
});

chrome.runtime.onStartup.addListener(function() { cleanupOldRecordings(); });

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'dailyCleanup') cleanupOldRecordings();
  else if (alarm.name === 'recLimit') warnLongRecording();
});

chrome.notifications.onButtonClicked.addListener(function(id, btnIdx) {
  if (id !== REC_LIMIT_NOTIF) return;
  chrome.notifications.clear(REC_LIMIT_NOTIF);
  if (btnIdx === 1) stopFromNotification();   // "Stop & Save"
  // btnIdx 0 ("Keep Recording"): do nothing — the alarm re-fires in 10 min
});

chrome.notifications.onClicked.addListener(function(id) {
  if (id === REC_LIMIT_NOTIF) chrome.notifications.clear(REC_LIMIT_NOTIF);
});

chrome.runtime.onConnect.addListener(function(port) {
  if (port.name === 'keepAlive') {
    var iv = setInterval(function() { try { port.postMessage({ ping: 1 }); } catch (e) {} }, 25000);
    port.onDisconnect.addListener(function() { clearInterval(iv); });
  }
});
