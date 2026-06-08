/* ═══════════════════════════════════════════════════════════════
   Stash — Offscreen: tab/screen recording engine + image processing
   Persistence + codec helpers come from ../db.js (stash* globals).
   ═══════════════════════════════════════════════════════════════ */

var mediaRecorder = null, displayStream = null, mixedStream = null, audioContext = null;
var recordedChunks = [], currentRecordingId = null, chunkIndex = 0;
var currentOutput = { format: 'webm', mimeType: 'video/webm', warning: null };

/* ── Recording Engine ───────────────────────────────────────── */

async function startRecording(settings, rid, streamId) {
  try {
    currentRecordingId = rid;
    recordedChunks     = [];
    chunkIndex         = 0;
    currentOutput      = stashPickMime(settings.outputFormat);

    var isTabCapture = !!streamId;

    // 1. Acquire the video stream
    if (isTabCapture) {
      displayStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      });
    } else {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width:     { ideal: settings.resolution === '1080p' ? 1920 : 1280 },
          height:    { ideal: settings.resolution === '1080p' ? 1080 : 720 },
          frameRate: { ideal: 30 }
        },
        audio: !!settings.includeSystemAudio
      });
    }

    // 2. Mix audio (system/tab + optional mic) into a single track
    var tracks   = Array.from(displayStream.getVideoTracks());
    audioContext = new AudioContext();
    var dest     = audioContext.createMediaStreamDestination();
    var hasAudio = false;

    var aTracks = displayStream.getAudioTracks();
    if (aTracks.length > 0) {
      var src = audioContext.createMediaStreamSource(new MediaStream(aTracks));
      src.connect(dest);
      // Tab capture mutes the tab while capturing, so route audio back to the
      // speakers. Screen capture audio still plays normally — looping it back
      // would double the audio / cause echo, so only loop back for tab capture.
      if (isTabCapture) src.connect(audioContext.destination);
      hasAudio = true;
    }

    if (settings.includeMic) {
      try {
        var mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioContext.createMediaStreamSource(mic).connect(dest);
        hasAudio = true;
      } catch (e) { /* mic unavailable — continue silently */ }
    }

    if (hasAudio) Array.from(dest.stream.getAudioTracks()).forEach(function(t) { tracks.push(t); });
    mixedStream = new MediaStream(tracks);

    // 3. Record
    mediaRecorder = new MediaRecorder(mixedStream, {
      mimeType: currentOutput.mimeType,
      videoBitsPerSecond: settings.resolution === '1080p' ? 8000000 : 4000000
    });

    mediaRecorder.ondataavailable = async function(e) {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
        try { await stashStoreChunk(currentRecordingId, chunkIndex++, e.data); } catch (err) {}
      }
    };

    // Auto-stop when the user ends capture via Chrome's native sharing UI
    displayStream.getVideoTracks()[0].addEventListener('ended', function() {
      chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    });

    mediaRecorder.start(1000);
    return { success: true, actualFormat: currentOutput.format, warning: currentOutput.warning };
  } catch (e) {
    cleanup();
    return { error: e.message || 'Could not start recording' };
  }
}

function stopRecording(rid) {
  return new Promise(function(resolve) {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve({ error: 'Recorder inactive' }); return; }
    mediaRecorder.onstop = async function() {
      try {
        var all  = recordedChunks.length > 0 ? recordedChunks : await stashGetAllChunks(rid);
        var blob = new Blob(all, { type: currentOutput.mimeType });
        await stashStoreBlob(rid, blob);
        await stashClearChunks(rid);
        var out = { success: true, size: blob.size, actualFormat: currentOutput.format, warning: currentOutput.warning };
        cleanup();
        resolve(out);
      } catch (e) {
        cleanup();
        resolve({ error: e.message });
      }
    };
    mediaRecorder.stop();
  });
}

function cleanup() {
  [displayStream, mixedStream].forEach(function(s) { if (s) s.getTracks().forEach(function(t) { t.stop(); }); });
  displayStream = mixedStream = null;
  if (audioContext) { audioContext.close().catch(function() {}); audioContext = null; }
  mediaRecorder  = null;
  recordedChunks = [];
  chunkIndex     = 0;
  currentOutput  = { format: 'webm', mimeType: 'video/webm', warning: null };
}

/* ── Downloads (anchor click — works from this persistent context) ── */

async function downloadFromIDB(rid, filename) {
  var blob = await stashGetBlob(rid);
  if (!blob) return { error: 'Recording data not found' };
  stashDownloadBlob(blob, filename);
  return { success: true };
}

/* Base64 of a stored blob — only for the Google Drive multipart upload path */
async function getBlobBase64(rid) {
  var b = await stashGetBlob(rid);
  if (!b) return null;
  return new Promise(function(ok) {
    var r = new FileReader();
    r.onloadend = function() { ok(r.result.split(',')[1]); };
    r.readAsDataURL(b);
  });
}

/* ── Image helpers ──────────────────────────────────────────── */

function loadImage(url) {
  return new Promise(function(ok, no) {
    var i = new Image();
    i.onload  = function() { ok(i); };
    i.onerror = function() { no(new Error('Failed to load image')); };
    i.src = url;
  });
}

/* ── Message Handler ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.target !== 'offscreen') return false;
  (async function() {
    switch (msg.type) {

    case 'START_RECORDING':
      sendResponse(await startRecording(msg.settings, msg.recordingId, msg.streamId));
      break;

    case 'PAUSE_RECORDING':
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.pause();
      sendResponse({ success: true });
      break;

    case 'RESUME_RECORDING':
      if (mediaRecorder && mediaRecorder.state === 'paused') mediaRecorder.resume();
      sendResponse({ success: true });
      break;

    case 'STOP_RECORDING':
      sendResponse(await stopRecording(msg.recordingId));
      break;

    case 'DOWNLOAD_FROM_IDB':
      sendResponse(await downloadFromIDB(msg.recordingId, msg.filename));
      break;

    case 'GET_BLOB_DATA':
      sendResponse({ base64: await getBlobBase64(msg.recordingId) });
      break;

    case 'DELETE_BLOB':
      try { await stashDeleteBlob(msg.recordingId); await stashClearChunks(msg.recordingId); } catch (e) {}
      sendResponse({ success: true });
      break;

    case 'STITCH_SCREENSHOTS': {
      try {
        var c = document.getElementById('composite');
        c.width = msg.totalWidth; c.height = msg.totalHeight;
        var ctx = c.getContext('2d');
        for (var i = 0; i < msg.chunks.length; i++) {
          var img = await loadImage(msg.chunks[i].dataUrl);
          var dy  = Math.round(msg.chunks[i].scrollY * msg.dpr);
          var rem = msg.totalHeight - dy;
          if (rem <= 0) break;
          if (rem < img.naturalHeight) ctx.drawImage(img, 0, 0, img.naturalWidth, rem, 0, dy, img.naturalWidth, rem);
          else ctx.drawImage(img, 0, dy);
        }
        sendResponse({ dataUrl: c.toDataURL('image/png') });
        c.width = 0; c.height = 0;
      } catch (e) { sendResponse({ error: e.message }); }
      break;
    }

    case 'CROP_SCREENSHOT': {
      try {
        var cc = document.getElementById('composite');
        cc.width = msg.w; cc.height = msg.h;
        var cx = cc.getContext('2d');
        var im = await loadImage(msg.dataUrl);
        cx.drawImage(im, msg.x, msg.y, msg.w, msg.h, 0, 0, msg.w, msg.h);
        sendResponse({ dataUrl: cc.toDataURL('image/png') });
        cc.width = 0; cc.height = 0;
      } catch (e) { sendResponse({ error: e.message }); }
      break;
    }

    default: break;
    }
  })();
  return true;
});
