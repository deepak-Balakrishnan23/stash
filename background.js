/* ═══════════════════════════════════════════════════════════════
   Stash v2 — Background Service Worker (Production)
   ═══════════════════════════════════════════════════════════════ */

var STATE = {
  isRecording: false,
  isPaused: false,
  startTime: 0,
  pausedDuration: 0,
  pauseStart: 0,
  recordingId: null,
  toolbarTabId: null,
  mode: null, // 'screen' | 'tab' | 'camera' — tracks active recording type
  settings: {
    captureMode: 'tab',
    includeMic: true,
    includeSystemAudio: true,
    resolution: '1080p',
    outputFormat: 'webm',
    saveTo: 'local'
  }
};

/* ── Offscreen Document ─────────────────────────────────────── */

async function ensureOffscreen() {
  if (typeof chrome.runtime.getContexts === 'function') {
    var ctx = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
    });
    if (ctx.length > 0) return;
  } else {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
        justification: 'Media recording and image processing'
      });
      return;
    } catch (e) {
      if (e.message && e.message.indexOf('single offscreen') !== -1) return;
      throw e;
    }
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
    justification: 'Media recording and image processing'
  });
}

/* ── Settings ───────────────────────────────────────────────── */

async function loadSettings() {
  var data = await chrome.storage.local.get('settings');
  if (data.settings) Object.assign(STATE.settings, sanitizeSettings(data.settings));
  if (STATE.settings.outputFormat === 'gif') STATE.settings.outputFormat = 'webm';
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
  sendToOffscreen({ target: 'offscreen', type: 'DELETE_BLOB', recordingId: id });
  return recs;
}

/* ── Offscreen Messaging ────────────────────────────────────── */

function sendToOffscreen(msg) {
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage(
      Object.assign({}, msg, { target: 'offscreen' }),
      function(res) { resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res); }
    );
  });
}

/* ── Save File ──────────────────────────────────────────────── */

async function saveFile(recordingId, filename, format) {
  var mimeMap = { mp4: 'video/mp4', mp3: 'audio/mpeg', webm: 'video/webm', png: 'image/png' };
  var mime = mimeMap[format] || 'application/octet-stream';
  var safeName = filename.replace(/[<>:"\/\\|?*]/g, '_');

  var blob = await sendToOffscreen({ target: 'offscreen', type: 'GET_BLOB_DATA', recordingId: recordingId });
  if (!blob || !blob.base64) return { error: 'Data not found' };

  if (STATE.settings.saveTo === 'cloud') {
    return await uploadToDrive(null, safeName + '.' + format, mime, blob.base64);
  }

  try {
    await chrome.downloads.download({
      url: 'data:' + mime + ';base64,' + blob.base64,
      filename: 'Stash/' + safeName + '.' + format,
      saveAs: true
    });
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
}

/* Save base64 data directly (for camera recordings that aren't in IndexedDB) */
async function saveBase64(filename, format, base64) {
  var mimeMap = { mp4: 'video/mp4', mp3: 'audio/mpeg', webm: 'video/webm' };
  var mime = mimeMap[format] || 'video/webm';
  var safeName = filename.replace(/[<>:"\/\\|?*]/g, '_');

  if (STATE.settings.saveTo === 'cloud') {
    return await uploadToDrive(null, safeName + '.' + format, mime, base64);
  }

  await chrome.downloads.download({
    url: 'data:' + mime + ';base64,' + base64,
    filename: 'Stash/' + safeName + '.' + format,
    saveAs: true
  });
  return { success: true };
}

/* ── Google Drive ───────────────────────────────────────────── */

async function getDriveToken() {
  return new Promise(function(resolve, reject) {
    chrome.identity.getAuthToken({ interactive: true }, function(tok) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tok);
    });
  });
}

async function uploadToDrive(recordingId, filename, mimeType, base64Data) {
  try {
    var token = await getDriveToken();
    if (!base64Data && recordingId) {
      var blob = await sendToOffscreen({ target: 'offscreen', type: 'GET_BLOB_DATA', recordingId: recordingId });
      if (!blob || !blob.base64) throw new Error('No data');
      base64Data = blob.base64;
    }
    if (!base64Data) throw new Error('No data to upload');

    var searchRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?q=name%3D'Stash'+and+mimeType%3D'application/vnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id)",
      { headers: { Authorization: 'Bearer ' + token } }
    );
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
      if (!cf.ok) throw new Error('Failed to create Stash folder in Google Drive');
      folderId = (await cf.json()).id;
    }

    var boundary = '---StashBoundary';
    var body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify({ name: filename, mimeType: mimeType, parents: [folderId] }) +
      '\r\n--' + boundary + '\r\nContent-Type: ' + mimeType + '\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      base64Data + '\r\n--' + boundary + '--';

    var up = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body }
    );
    if (!up.ok) throw new Error('Upload to Google Drive failed');
    return { success: true, file: await up.json() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/* ── State Helpers ──────────────────────────────────────────── */

function resetState() {
  STATE.isRecording = false;
  STATE.isPaused = false;
  STATE.startTime = 0;
  STATE.pausedDuration = 0;
  STATE.pauseStart = 0;
  STATE.recordingId = null;
  STATE.toolbarTabId = null;
  STATE.mode = null;
  chrome.action.setBadgeText({ text: '' });
}

function broadcastState() {
  var elapsed = 0;
  if (STATE.isRecording) {
    elapsed = Date.now() - STATE.startTime - STATE.pausedDuration;
    if (STATE.isPaused) elapsed -= (Date.now() - STATE.pauseStart);
  }
  var message = {
    target: 'popup', type: 'STATE_UPDATE',
    isRecording: STATE.isRecording, isPaused: STATE.isPaused, elapsed: elapsed,
    mode: STATE.mode
  };
  chrome.runtime.sendMessage(message).catch(function() {});
  if (STATE.toolbarTabId) {
    chrome.tabs.sendMessage(STATE.toolbarTabId, message).catch(function() {});
  }
}

/* ── Message Router ─────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.target === 'offscreen') return false;
  handleMessage(msg).then(sendResponse).catch(function(e) { sendResponse({ error: e.message }); });
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {

  case 'GET_STATE':
    await loadSettings();
    var el = 0;
    if (STATE.isRecording) {
      el = Date.now() - STATE.startTime - STATE.pausedDuration;
      if (STATE.isPaused) el -= (Date.now() - STATE.pauseStart);
    }
    return { isRecording: STATE.isRecording, isPaused: STATE.isPaused, settings: STATE.settings,
             elapsed: el, startTime: STATE.startTime, pausedDuration: STATE.pausedDuration,
             pauseStart: STATE.pauseStart, mode: STATE.mode };

  case 'UPDATE_SETTINGS':
    return await saveSettings(msg.settings);

  case 'CHECK_DRIVE_AUTH':
    try { await getDriveToken(); return { connected: true }; }
    catch (e) { return { connected: false, error: e.message }; }

  /* ══ Recording ══════════════════════════════════════════════ */

  case 'START_RECORDING': {
    if (STATE.isRecording) return { error: 'Already recording' };
    await loadSettings();

    STATE.recordingId = 'rec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

    /* ── Camera mode: inject overlay into tab ─────────────── */
    if (STATE.settings.captureMode === 'camera') {
      var camTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!camTab || !camTab.id) return { error: 'No active tab' };

      STATE.mode = 'camera';
      STATE.toolbarTabId = camTab.id;

      await chrome.scripting.executeScript({
        target: { tabId: camTab.id },
        args: [STATE.settings.includeMic],
        func: function(includeMic) {
          if (document.getElementById('stash-cam-overlay')) return;
          var ov = document.createElement('div');
          ov.id = 'stash-cam-overlay';
          ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;';

          var vid = document.createElement('video');
          vid.autoplay=true; vid.muted=true; vid.playsInline=true;
          vid.style.cssText = 'width:540px;height:400px;border-radius:12px;object-fit:cover;transform:scaleX(-1);background:#000;border:2px solid #2e2e26;';
          ov.appendChild(vid);

          var bar = document.createElement('div');
          bar.style.cssText = 'display:flex;align-items:center;gap:16px;margin-top:16px;';
          var st = document.createElement('span');
          st.textContent = 'Requesting camera...';
          st.style.cssText = 'font-size:12px;color:#9a9880;min-width:100px;text-align:center;font-family:monospace;';
          var rb = document.createElement('button');
          rb.style.cssText = 'width:52px;height:52px;border-radius:50%;border:2px solid #3e3e34;background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .25s;opacity:0.3;pointer-events:none;';
          var dt = document.createElement('div');
          dt.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#e85d04;transition:all .3s;';
          rb.appendChild(dt);
          var tm = document.createElement('span');
          tm.textContent='00:00';
          tm.style.cssText = 'font-size:16px;color:#ededed;min-width:60px;text-align:center;font-family:monospace;font-weight:300;';
          var cb = document.createElement('button');
          cb.textContent='\u2715';
          cb.style.cssText = 'position:absolute;top:16px;right:20px;width:36px;height:36px;border-radius:50%;border:1px solid #3e3e34;background:rgba(0,0,0,0.5);color:#ededed;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;';
          bar.appendChild(st); bar.appendChild(rb); bar.appendChild(tm);
          ov.appendChild(bar); ov.appendChild(cb);
          document.body.appendChild(ov);

          var stream=null,rec=null,chunks=[],on=false,t0=0,iv=null;
          function die(){clearInterval(iv);if(stream)stream.getTracks().forEach(function(t){t.stop();});if(ov.parentNode)ov.parentNode.removeChild(ov);}

          cb.onclick=function(){if(on&&rec){rec.stop();}else{chrome.runtime.sendMessage({type:'CAMERA_CLOSED'});die();}};

          navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},audio:includeMic})
          .then(function(s){
            stream=s; vid.srcObject=s;
            st.textContent='READY'; st.style.color='#4a9c6d';
            rb.style.opacity='1'; rb.style.pointerEvents='auto';
            chrome.runtime.sendMessage({type:'CAMERA_READY'});

            rb.onclick=function(){
              if(on){
                rec.stop(); on=false;
                dt.style.cssText='width:22px;height:22px;border-radius:50%;background:#e85d04;transition:all .3s;';
                rb.style.borderColor='#3e3e34';
                st.textContent='SAVING...'; st.style.color='#9a9880';
                clearInterval(iv);
              } else {
                chunks=[];
                var mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')?'video/webm;codecs=vp9,opus':'video/webm;codecs=vp8,opus';
                rec=new MediaRecorder(s,{mimeType:mime,videoBitsPerSecond:2500000});
                rec.ondataavailable=function(e){if(e.data&&e.data.size>0)chunks.push(e.data);};
                rec.onstop=function(){
                  var blob=new Blob(chunks,{type:'video/webm'});
                  var rd=new FileReader();
                  rd.onloadend=function(){
                    chrome.runtime.sendMessage({type:'CAMERA_RECORDING_DONE',base64:rd.result.split(',')[1],duration:Date.now()-t0,size:blob.size});
                    st.textContent='SAVED'; st.style.color='#4a9c6d';
                    setTimeout(die,1200);
                  };
                  rd.readAsDataURL(blob);
                };
                rec.start(1000); on=true; t0=Date.now();
                chrome.runtime.sendMessage({type:'CAMERA_RECORDING_STARTED'});
                dt.style.cssText='width:16px;height:16px;border-radius:3px;background:#d44333;transition:all .3s;';
                rb.style.borderColor='#d44333';
                st.textContent='REC'; st.style.color='#d44333';
                iv=setInterval(function(){var sec=Math.floor((Date.now()-t0)/1000);tm.textContent=String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0');},250);
              }
            };
          })
          .catch(function(err){
            st.textContent='Camera permission denied'; st.style.color='#d44333'; vid.style.display='none';
            var em=document.createElement('div');
            em.style.cssText='color:#d44333;font-size:14px;text-align:center;max-width:320px;line-height:1.6;margin-bottom:16px;';
            em.innerHTML='Camera access was blocked.<br><span style="font-size:11px;color:#706e58;">Allow camera in browser settings and try again.</span>';
            ov.insertBefore(em,bar);
            chrome.runtime.sendMessage({type:'CAMERA_FAILED',error:err.message||'Permission denied'});
            setTimeout(die,4000);
          });

          document.addEventListener('keydown',function esc(e){
            if(e.key==='Escape'){if(on&&rec)rec.stop();else{chrome.runtime.sendMessage({type:'CAMERA_CLOSED'});die();}document.removeEventListener('keydown',esc);}
          });
        }
      });

      // Don't set isRecording until the overlay actually starts recording
      return { success: true, pending: true };
    }

    /* ── Screen/Tab mode: use offscreen ───────────────────── */
    STATE.mode = STATE.settings.captureMode; // 'screen' or 'tab'
    await ensureOffscreen();

    STATE.startTime = Date.now();
    STATE.pausedDuration = 0;
    STATE.pauseStart = 0;

    var streamId = null;
    var targetTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    STATE.toolbarTabId = targetTab && targetTab.id ? targetTab.id : null;
    if (STATE.settings.captureMode === 'tab') {
      if (targetTab) {
        streamId = await new Promise(function(res, rej) {
          chrome.tabCapture.getMediaStreamId({ targetTabId: targetTab.id }, function(id) {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message)); else res(id);
          });
        });
      }
    }

    var r = await sendToOffscreen({
      target: 'offscreen', type: 'START_RECORDING',
      settings: STATE.settings, recordingId: STATE.recordingId, streamId: streamId
    });

    if (r && r.error) { STATE.recordingId = null; STATE.mode = null; return { error: r.error }; }

    STATE.isRecording = true;
    STATE.isPaused = false;
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85d04' });
    broadcastState();

    if (STATE.toolbarTabId) chrome.tabs.sendMessage(STATE.toolbarTabId, { type: 'SHOW_TOOLBAR' }).catch(function() {});
    return {
      success: true,
      recordingId: STATE.recordingId,
      mode: STATE.mode,
      elapsed: 0,
      actualFormat: r.actualFormat || STATE.settings.outputFormat,
      warning: r.warning || null
    };
  }

  /* ── Camera lifecycle messages (from injected script) ───── */

  case 'CAMERA_READY':
    return { success: true };

  case 'CAMERA_RECORDING_STARTED':
    STATE.isRecording = true;
    STATE.isPaused = false;
    STATE.startTime = Date.now();
    STATE.pausedDuration = 0;
    STATE.pauseStart = 0;
    chrome.action.setBadgeText({ text: 'CAM' });
    chrome.action.setBadgeBackgroundColor({ color: '#e85d04' });
    broadcastState();
    return { success: true };

  case 'CAMERA_FAILED':
    resetState();
    broadcastState();
    return { error: msg.error || 'Camera permission denied' };

  case 'CAMERA_CLOSED':
    resetState();
    broadcastState();
    return { success: true };

  case 'CAMERA_RECORDING_DONE': {
    var camTitle = 'Camera ' + new Date().toLocaleString();
    var camMeta = {
      id: STATE.recordingId || ('cam_' + Date.now()),
      title: camTitle,
      duration: msg.duration || 0,
      format: msg.actualFormat || 'webm',
      timestamp: Date.now(),
      size: msg.size || 0
    };
    await addRecording(camMeta);
    resetState();
    broadcastState();

    if (msg.base64) {
      await saveBase64(camTitle, 'webm', msg.base64);
    }
    return { success: true };
  }

  /* ── Pause / Resume (screen/tab only — camera has own UI) ─ */

  case 'PAUSE_RECORDING':
    if (!STATE.isRecording || STATE.isPaused) return { success: false };
    if (STATE.mode === 'camera') return { success: false }; // camera handles its own pause
    STATE.isPaused = true;
    STATE.pauseStart = Date.now();
    await sendToOffscreen({ target: 'offscreen', type: 'PAUSE_RECORDING' });
    chrome.action.setBadgeText({ text: '||' });
    broadcastState();
    return { success: true };

  case 'RESUME_RECORDING':
    if (!STATE.isRecording || !STATE.isPaused) return { success: false };
    if (STATE.mode === 'camera') return { success: false };
    STATE.pausedDuration += Date.now() - STATE.pauseStart;
    STATE.isPaused = false;
    STATE.pauseStart = 0;
    await sendToOffscreen({ target: 'offscreen', type: 'RESUME_RECORDING' });
    chrome.action.setBadgeText({ text: 'REC' });
    broadcastState();
    return { success: true };

  /* ── Stop (screen/tab only — camera stops via own UI) ───── */

  case 'STOP_RECORDING': {
    if (!STATE.isRecording) return { error: 'Not recording' };
    if (STATE.mode === 'camera') return { error: 'Use camera overlay to stop' };

    var dur = Date.now() - STATE.startTime - STATE.pausedDuration;
    var sr = await sendToOffscreen({ target: 'offscreen', type: 'STOP_RECORDING', recordingId: STATE.recordingId });
    if (!sr || sr.error) return { error: (sr && sr.error) || 'Failed to stop recording' };

    var meta = {
      id: STATE.recordingId,
      title: 'Recording ' + new Date().toLocaleString(),
      duration: dur,
      format: sr.actualFormat || STATE.settings.outputFormat,
      timestamp: Date.now(),
      size: sr ? (sr.size || 0) : 0
    };
    var toolbarTabId = STATE.toolbarTabId;
    await addRecording(meta);
    if (toolbarTabId) chrome.tabs.sendMessage(toolbarTabId, { type: 'HIDE_TOOLBAR' }).catch(function() {});
    resetState();
    broadcastState();

    var saveResult = await saveFile(meta.id, meta.title, meta.format);
    if (saveResult && saveResult.error) {
      return { error: saveResult.error, recording: meta, warning: sr.warning || null };
    }
    return { success: true, recording: meta, warning: sr.warning || null };
  }

  case 'DOWNLOAD_RECORDING':
    var dr = msg.recording || {};
    return await saveFile(msg.recordingId, dr.title || 'recording', dr.format || 'webm');

  case 'UPLOAD_TO_DRIVE': {
    var ur = msg.recording;
    if (!ur) return { error: 'No recording' };
    var uf = ur.format || 'webm';
    var um = { mp4: 'video/mp4', mp3: 'audio/mpeg', webm: 'video/webm' };
    return await uploadToDrive(ur.id, ur.title + '.' + uf, um[uf] || 'video/webm');
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
        ht.textContent = 'Drag to select \u00b7 ESC to cancel';
        ht.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);font:13px/1 -apple-system,sans-serif;color:#fff;background:rgba(0,0,0,0.75);padding:8px 18px;border-radius:6px;z-index:2147483647;pointer-events:none;';
        ov.appendChild(ht);
        var sx=0,sy=0,on=false;
        ov.addEventListener('mousedown',function(e){sx=e.clientX;sy=e.clientY;on=true;bx.style.display='block';bx.style.left=sx+'px';bx.style.top=sy+'px';bx.style.width='0';bx.style.height='0';ht.style.display='none';e.preventDefault();});
        ov.addEventListener('mousemove',function(e){if(!on)return;var x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy);bx.style.left=x+'px';bx.style.top=y+'px';bx.style.width=Math.abs(e.clientX-sx)+'px';bx.style.height=Math.abs(e.clientY-sy)+'px';});
        ov.addEventListener('mouseup',function(e){if(!on)return;on=false;var r={x:Math.min(e.clientX,sx),y:Math.min(e.clientY,sy),w:Math.abs(e.clientX-sx),h:Math.abs(e.clientY-sy)};ov.remove();if(r.w>5&&r.h>5){setTimeout(function(){chrome.runtime.sendMessage({target:'background',type:'SCREENSHOT_AREA',rect:r,dpr:window.devicePixelRatio||1});},200);}});
        document.addEventListener('keydown',function esc(e){if(e.key==='Escape'){ov.remove();document.removeEventListener('keydown',esc);}});
        document.body.appendChild(ov);
      }
    });
    return { success: true };
  }

  case 'SCREENSHOT_VISIBLE': {
    var vt = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!vt) return { error: 'No tab' };
    var vd = await chrome.tabs.captureVisibleTab(vt.windowId, { format: 'png' });
    chrome.downloads.download({ url: vd, filename: 'Stash/Screenshot_' + Date.now() + '.png', saveAs: true });
    return { success: true };
  }

  case 'SCREENSHOT_FULL': {
    var ft = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!ft) return { error: 'No tab' };
    var dm = (await chrome.scripting.executeScript({
      target: { tabId: ft.id },
      func: function() {
        return { sh: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
                 vw: window.innerWidth, vh: window.innerHeight, sy: window.scrollY, dpr: window.devicePixelRatio || 1 };
      }
    }))[0].result;

    var chunks = [], pos = [];
    for (var y = 0; y < dm.sh; y += dm.vh) pos.push(y);
    for (var i = 0; i < pos.length; i++) {
      await chrome.scripting.executeScript({ target: { tabId: ft.id }, func: function(s) { window.scrollTo(0, s); }, args: [pos[i]] });
      await new Promise(function(r) { setTimeout(r, 500); });
      chunks.push({ dataUrl: await chrome.tabs.captureVisibleTab(ft.windowId, { format: 'png' }), scrollY: pos[i] });
    }
    await chrome.scripting.executeScript({ target: { tabId: ft.id }, func: function(s) { window.scrollTo(0, s); }, args: [dm.sy] });

    if (chunks.length === 1) {
      chrome.downloads.download({ url: chunks[0].dataUrl, filename: 'Stash/Screenshot_Full_' + Date.now() + '.png', saveAs: true });
      return { success: true };
    }

    await ensureOffscreen();
    var st2 = await sendToOffscreen({ target: 'offscreen', type: 'STITCH_SCREENSHOTS', chunks: chunks,
      totalWidth: dm.vw * dm.dpr, totalHeight: dm.sh * dm.dpr, chunkHeight: dm.vh * dm.dpr });
    if (st2 && st2.dataUrl) {
      chrome.downloads.download({ url: st2.dataUrl, filename: 'Stash/Screenshot_Full_' + Date.now() + '.png', saveAs: true });
      return { success: true };
    }
    return { error: 'Stitch failed' };
  }

  case 'SCREENSHOT_AREA': {
    var at2 = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!at2) return { error: 'No tab' };
    var fc = await chrome.tabs.captureVisibleTab(at2.windowId, { format: 'png' });
    await ensureOffscreen();
    var cr = await sendToOffscreen({ target: 'offscreen', type: 'CROP_SCREENSHOT', dataUrl: fc,
      x: Math.round(msg.rect.x * msg.dpr), y: Math.round(msg.rect.y * msg.dpr),
      w: Math.round(msg.rect.w * msg.dpr), h: Math.round(msg.rect.h * msg.dpr) });
    if (cr && cr.dataUrl) {
      chrome.downloads.download({ url: cr.dataUrl, filename: 'Stash/Screenshot_Area_' + Date.now() + '.png', saveAs: true });
      return { success: true };
    }
    return { error: 'Crop failed' };
  }

  default: return {};
  }
}

/* ── Lifecycle ──────────────────────────────────────────────── */

async function cleanupOldRecordings() {
  var CUT = Date.now() - (3 * 86400000);
  var recs = await getRecordings();
  var kept = recs.filter(function(r) {
    if (r.timestamp && r.timestamp < CUT) {
      sendToOffscreen({ target: 'offscreen', type: 'DELETE_BLOB', recordingId: r.id });
      return false;
    }
    return true;
  });
  if (kept.length !== recs.length) await chrome.storage.local.set({ recordings: kept });
}

chrome.runtime.onInstalled.addListener(async function() {
  await loadSettings();
  chrome.action.setBadgeText({ text: '' });
});

chrome.runtime.onStartup.addListener(function() { cleanupOldRecordings(); });

chrome.runtime.onConnect.addListener(function(port) {
  if (port.name === 'keepAlive') {
    var iv = setInterval(function() { port.postMessage({ ping: 1 }); }, 25000);
    port.onDisconnect.addListener(function() { clearInterval(iv); });
  }
});
