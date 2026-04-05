/* ═══════════════════════════════════════════════════════════════
   Stash v2 — Offscreen Recording Engine + Image Processing
   ═══════════════════════════════════════════════════════════════ */

var mediaRecorder = null, displayStream = null, webcamStream = null;
var audioContext = null, mixedStream = null;
var recordedChunks = [], currentRecordingId = null, chunkIndex = 0;
var currentOutput = { format: 'webm', mimeType: 'video/webm', warning: null };

var DB_NAME = 'StashDB', DB_VER = 1, CHUNKS = 'chunks', BLOBS = 'blobs';

/* ── IndexedDB ──────────────────────────────────────────────── */

function openDB() {
  return new Promise(function(ok, no) {
    var r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = function(e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['recordingId', 'index'] });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
    };
    r.onsuccess = function() { ok(r.result); };
    r.onerror = function() { no(r.error); };
  });
}

async function storeChunk(rid, idx, data) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).put({ recordingId: rid, index: idx, data: data });
    tx.oncomplete = ok; tx.onerror = function() { no(tx.error); };
  });
}

async function getAllChunks(rid) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(CHUNKS, 'readonly');
    var arr = [], req = tx.objectStore(CHUNKS).openCursor();
    req.onsuccess = function(e) {
      var c = e.target.result;
      if (c) { if (c.value.recordingId === rid) arr.push(c.value); c.continue(); }
      else { arr.sort(function(a,b){return a.index-b.index;}); ok(arr.map(function(x){return x.data;})); }
    };
    req.onerror = function() { no(req.error); };
  });
}

async function clearChunks(rid) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(CHUNKS, 'readwrite');
    var req = tx.objectStore(CHUNKS).openCursor();
    req.onsuccess = function(e) {
      var c = e.target.result;
      if (c) { if (c.value.recordingId === rid) c.delete(); c.continue(); } else ok();
    };
    req.onerror = function() { no(req.error); };
  });
}

async function storeBlob(rid, blob) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(BLOBS, 'readwrite');
    tx.objectStore(BLOBS).put({ id: rid, blob: blob, ts: Date.now() });
    tx.oncomplete = ok; tx.onerror = function() { no(tx.error); };
  });
}

async function getBlob(rid) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(BLOBS, 'readonly');
    var r = tx.objectStore(BLOBS).get(rid);
    r.onsuccess = function() { ok(r.result ? r.result.blob : null); };
    r.onerror = function() { no(r.error); };
  });
}

async function deleteBlob(rid) {
  var db = await openDB();
  return new Promise(function(ok, no) {
    var tx = db.transaction(BLOBS, 'readwrite');
    tx.objectStore(BLOBS).delete(rid);
    tx.oncomplete = ok; tx.onerror = function() { no(tx.error); };
  });
}

/* ── Recording Engine ───────────────────────────────────────── */

async function startRecording(settings, rid, streamId) {
  try {
    currentRecordingId = rid;
    recordedChunks = [];
    chunkIndex = 0;
    currentOutput = getRecorderOutput(settings.outputFormat);

    var isCameraOnly = (settings.captureMode === 'camera');

    // 1. Get video stream
    if (isCameraOnly) {
      // Camera only — webcam video + optional mic audio
      displayStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: settings.includeMic
      });
    } else if (streamId) {
      // Tab capture
      displayStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
      });
    } else {
      // Screen/window capture
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: settings.resolution === '1080p' ? 1920 : 1280 },
                 height: { ideal: settings.resolution === '1080p' ? 1080 : 720 }, frameRate: { ideal: 30 } },
        audio: settings.includeSystemAudio
      });
    }

    // 2. Build track list
    var tracks = Array.from(displayStream.getVideoTracks());
    audioContext = new AudioContext();
    var dest = audioContext.createMediaStreamDestination();
    var hasAudio = false;

    if (isCameraOnly) {
      // For camera only, audio is already in displayStream if mic was requested
      var camAudio = displayStream.getAudioTracks();
      if (camAudio.length > 0) {
        var camSrc = audioContext.createMediaStreamSource(new MediaStream(camAudio));
        camSrc.connect(dest);
        hasAudio = true;
      }
    } else {
      // Screen/tab — system audio loopback + mic
      var aTracks = displayStream.getAudioTracks();
      if (aTracks.length > 0) {
        var src = audioContext.createMediaStreamSource(new MediaStream(aTracks));
        src.connect(dest);
        src.connect(audioContext.destination); // loopback to speakers
        hasAudio = true;
      }
      if (settings.includeMic) {
        try {
          var mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          audioContext.createMediaStreamSource(mic).connect(dest);
          hasAudio = true;
        } catch (e) { /* mic unavailable in offscreen */ }
      }
    }

    if (hasAudio) Array.from(dest.stream.getAudioTracks()).forEach(function(t) { tracks.push(t); });
    mixedStream = new MediaStream(tracks);

    var mime = currentOutput.mimeType;

    mediaRecorder = new MediaRecorder(mixedStream, {
      mimeType: mime,
      videoBitsPerSecond: settings.resolution === '1080p' ? 5000000 : 2500000
    });

    mediaRecorder.ondataavailable = async function(e) {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
        await storeChunk(currentRecordingId, chunkIndex++, e.data);
      }
    };

    displayStream.getVideoTracks()[0].addEventListener('ended', function() {
      chrome.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    });

    mediaRecorder.start(1000);
    return { success: true, actualFormat: currentOutput.format, warning: currentOutput.warning };
  } catch (e) { cleanup(); return { error: e.message }; }
}

async function stopRecording(rid) {
  return new Promise(async function(resolve) {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve({ error: 'Inactive' }); return; }
    mediaRecorder.onstop = async function() {
      try {
        var all = recordedChunks.length > 0 ? recordedChunks : await getAllChunks(rid);
        var blob = new Blob(all, { type: currentOutput.mimeType });
        await storeBlob(rid, blob);
        await clearChunks(rid);
        cleanup();
        resolve({ success: true, size: blob.size, actualFormat: currentOutput.format, warning: currentOutput.warning });
      } catch (e) { cleanup(); resolve({ error: e.message }); }
    };
    mediaRecorder.stop();
  });
}

function getRecorderOutput(requestedFormat) {
  var want = requestedFormat || 'webm';
  var mp4Mime = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
  if (want === 'mp4' && MediaRecorder.isTypeSupported(mp4Mime)) {
    return { format: 'mp4', mimeType: mp4Mime, warning: null };
  }
  if (want === 'mp4') {
    return {
      format: 'webm',
      mimeType: getBestWebmMime(),
      warning: 'Chrome does not support MP4 recording here, so the file was saved as WEBM.'
    };
  }
  if (want === 'mp3') {
    return {
      format: 'webm',
      mimeType: getBestWebmMime(),
      warning: 'Chrome does not support MP3 export here, so the file was saved as WEBM.'
    };
  }
  return { format: 'webm', mimeType: getBestWebmMime(), warning: null };
}

function getBestWebmMime() {
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm;codecs=vp8,opus';
}

function cleanup() {
  [displayStream, webcamStream, mixedStream].forEach(function(s) { if (s) s.getTracks().forEach(function(t){t.stop();}); });
  displayStream = webcamStream = mixedStream = null;
  if (audioContext) { audioContext.close().catch(function(){}); audioContext = null; }
  mediaRecorder = null; recordedChunks = []; chunkIndex = 0;
  currentOutput = { format: 'webm', mimeType: 'video/webm', warning: null };
}

/* ── Blob / Image Helpers ───────────────────────────────────── */

async function getBlobBase64(rid) {
  var b = await getBlob(rid);
  if (!b) return null;
  return new Promise(function(ok) {
    var r = new FileReader();
    r.onloadend = function() { ok(r.result.split(',')[1]); };
    r.readAsDataURL(b);
  });
}

function loadImage(url) {
  return new Promise(function(ok) { var i = new Image(); i.onload = function() { ok(i); }; i.src = url; });
}

/* ── Message Handler ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.target !== 'offscreen') return false;
  (async function() {
    switch (msg.type) {
    case 'START_RECORDING': sendResponse(await startRecording(msg.settings, msg.recordingId, msg.streamId)); break;
    case 'PAUSE_RECORDING': if (mediaRecorder && mediaRecorder.state==='recording') mediaRecorder.pause(); sendResponse({success:true}); break;
    case 'RESUME_RECORDING': if (mediaRecorder && mediaRecorder.state==='paused') mediaRecorder.resume(); sendResponse({success:true}); break;
    case 'STOP_RECORDING': sendResponse(await stopRecording(msg.recordingId)); break;
    case 'GET_BLOB_DATA': sendResponse({ base64: await getBlobBase64(msg.recordingId) }); break;
    case 'DELETE_BLOB': await deleteBlob(msg.recordingId); await clearChunks(msg.recordingId); sendResponse({success:true}); break;

    case 'STITCH_SCREENSHOTS': {
      try {
        var c = document.getElementById('composite');
        c.width = msg.totalWidth; c.height = msg.totalHeight;
        var ctx = c.getContext('2d');
        for (var i = 0; i < msg.chunks.length; i++) {
          var img = await loadImage(msg.chunks[i].dataUrl);
          var dy = i * msg.chunkHeight;
          var rem = msg.totalHeight - dy;
          if (rem < msg.chunkHeight) { ctx.drawImage(img, 0, msg.chunkHeight - rem, img.width, rem, 0, dy, img.width, rem); }
          else { ctx.drawImage(img, 0, dy); }
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
