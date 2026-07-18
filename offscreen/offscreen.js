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
    var dim = resDims(settings.resolution);

    // 1. Acquire the video stream
    if (isTabCapture) {
      displayStream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        // Tab capture is capped by the tab's own pixel size, but request the
        // target ceiling so higher tiers (1440p/4K) aren't downscaled needlessly.
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
                 maxWidth: dim.w, maxHeight: dim.h, maxFrameRate: 30 } }
      });
    } else {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width:     { ideal: dim.w },
          height:    { ideal: dim.h },
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
      videoBitsPerSecond: dim.bps
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

/* ── Resolution → capture dimensions + video bitrate ────────── */

function resDims(r) {
  switch (r) {
    case '720p':  return { w: 1280, h: 720,  bps: 4000000 };
    case '1440p': return { w: 2560, h: 1440, bps: 14000000 };
    case '2160p': return { w: 3840, h: 2160, bps: 24000000 };
    case '1080p':
    default:      return { w: 1920, h: 1080, bps: 8000000 };
  }
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

/* ── PDF export (high-quality single-image PDF) ─────────────── */

function u8ToBase64(u8) {
  var out = '', CH = 0x8000;
  for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(out);
}

/* Render a PNG dataUrl into a PDF, embedding the screenshot at full
   resolution. Page is fit to A4 width so it opens/prints cleanly, but the
   image stays full-res so zooming in stays sharp. Returns base64 PDF bytes. */
async function buildPdf(dataUrl) {
  var img = await loadImage(dataUrl);
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;

  var c = document.getElementById('composite');
  c.width = iw; c.height = ih;
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, iw, ih); // flatten transparency on white
  ctx.drawImage(img, 0, 0);
  var jpegUrl = c.toDataURL('image/jpeg', 0.98);          // visually lossless, keeps size sane
  c.width = 0; c.height = 0;

  var b64 = jpegUrl.split(',')[1], bin = atob(b64), jpeg = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);

  return { base64: pdfFromJpeg(jpeg, iw, ih) };
}

function pdfFromJpeg(jpeg, iw, ih) {
  var pageW = 595.28;              // A4 width in points
  var pageH = pageW * ih / iw;     // one tall page, aspect preserved
  var enc = new TextEncoder();
  var parts = [], offsets = [], length = 0;
  function push(u8) { parts.push(u8); length += u8.length; }
  function str(s)   { push(enc.encode(s)); }
  function obj()    { offsets.push(length); }

  str('%PDF-1.4\n');
  obj(); str('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj(); str('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  obj(); str('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageW.toFixed(2) + ' ' + pageH.toFixed(2) +
             '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  obj(); str('4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + iw + ' /Height ' + ih +
             ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
  push(jpeg);
  str('\nendstream\nendobj\n');
  var content = 'q ' + pageW.toFixed(2) + ' 0 0 ' + pageH.toFixed(2) + ' 0 0 cm /Im0 Do Q\n';
  obj(); str('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\nendobj\n');

  var xrefAt = length;
  var xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (var i = 0; i < offsets.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  str(xref);
  str('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF');

  var out = new Uint8Array(length), o = 0;
  for (var j = 0; j < parts.length; j++) { out.set(parts[j], o); o += parts[j].length; }
  return u8ToBase64(out);
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

    case 'MAKE_PDF':
      try { sendResponse(await buildPdf(msg.dataUrl)); }
      catch (e) { sendResponse({ error: e.message }); }
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
