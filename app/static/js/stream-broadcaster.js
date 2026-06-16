// Broadcaster: browser camera/mic → MediaRecorder → Socket.IO chunks.
//
// We pick the first WebM codec the browser supports and roll 250ms
// timeslices so the server can fan out chunks to viewers with low
// latency. The very first chunk holds the WebM init segment (the EBML
// header, segment info, and Tracks), so the server caches it for any
// viewer who joins after the broadcast has started.
(function () {
  'use strict';

  // One shared connection across chat/stream/info so server handlers that
  // key off request.sid see a single sid for this browser. See
  // static/js/socket.js.
  var socket = window.vbsSocket();

  var els = {
    wsStatus:    document.getElementById('ws-status'),
    videoWrap:   document.querySelector('.card--video .video-wrap'),
    preview:     document.getElementById('preview'),
    overlay:     document.getElementById('preview-overlay'),
    previewBtn:  document.getElementById('preview-btn'),
    stopPreviewBtn: document.getElementById('stop-preview-btn'),
    liveBtn:     document.getElementById('live-btn'),
    liveBtnLabel:document.querySelector('#live-btn .live-btn-label'),
    micBtn:      document.getElementById('toggle-mic-btn'),
    camBtn:      document.getElementById('toggle-cam-btn'),
    talkMicBtn:  document.getElementById('talk-mic-btn'),
    monitorMuteBtn: document.getElementById('monitor-mute-btn'),
    cameraSel:   document.getElementById('camera-select'),
    micSel:      document.getElementById('mic-select'),
    qualitySel:  document.getElementById('quality-select'),
    fpsSel:      document.getElementById('fps-select'),
    bitrateSlider: document.getElementById('bitrate-slider'),
    bitrateOut:    document.getElementById('bitrate-out'),
    bitrateAuto:   document.getElementById('bitrate-auto'),
    fileInput:    document.getElementById('file-input'),
    filePickText: document.getElementById('file-picker-text'),
    fileResumeHint: document.getElementById('file-resume-hint'),
    fileTransport:document.getElementById('file-transport'),
    fileSeek:     document.getElementById('file-seek'),
    fileTime:     document.getElementById('file-time'),
    fileLoop:     document.getElementById('file-loop'),
    filePaused:   document.getElementById('file-paused-overlay'),
    fileTranscoding: document.getElementById('file-transcoding'),
    fileTranscodingBar: document.getElementById('file-transcoding-bar'),
    fileTranscodingPct: document.getElementById('file-transcoding-pct'),
    lockToggle:   document.getElementById('lock-toggle'),
    reactionsToggle: document.getElementById('reactions-toggle'),
    reactionControl: document.getElementById('reaction-control'),
    reactionBtn:    document.getElementById('reaction-btn'),
    reactionPalette: document.getElementById('reaction-palette'),
    reactionLayer:  document.getElementById('video-reactions'),
    reactionSender: document.getElementById('reaction-sender'),
    alertInput:     document.getElementById('alert-input'),
    alertShowBtn:   document.getElementById('alert-show-btn'),
    alertClearBtn:  document.getElementById('alert-clear-btn'),
    alertStatus:    document.getElementById('alert-status'),
    alertBanner:    document.getElementById('video-alert'),
    alertText:      document.getElementById('video-alert-text'),
    lockCode:     document.getElementById('lock-code'),
    lockRandomize: document.getElementById('lock-randomize'),
    lockTip:      document.getElementById('lock-tip'),
    chatModToggle: document.getElementById('chat-mod-toggle'),
    chatModCount: document.getElementById('chat-mod-count'),
    chatModRoster:document.getElementById('chat-mod-roster'),
    chatModEmpty: document.getElementById('chat-mod-empty'),
    chatModClear: document.getElementById('chat-mod-clear'),
    infoForm:        document.getElementById('info-form'),
    infoPosterImg:   document.getElementById('info-poster-img'),
    infoPosterPh:    document.getElementById('info-poster-placeholder'),
    infoPosterFile:  document.getElementById('info-poster-file'),
    infoPosterClear: document.getElementById('info-poster-clear'),
    infoTitleInput:  document.getElementById('info-title-input'),
    infoDescInput:   document.getElementById('info-desc-input'),
    infoImdbInput:   document.getElementById('info-imdb-input'),
    infoTrailerInput:document.getElementById('info-trailer-input'),
    infoSaveBtn:     document.getElementById('info-save-btn'),
    infoClearBtn:    document.getElementById('info-clear-btn'),
    infoFormStatus:  document.getElementById('info-form-status'),
    liveDot:     document.getElementById('live-dot'),
    liveLabel:   document.getElementById('live-label'),
    viewerCount: document.getElementById('viewer-count'),
    codecOut:    document.getElementById('codec-out'),
    bytesOut:    document.getElementById('bytes-out'),
    elapsedOut:  document.getElementById('elapsed-out'),
    kickBtn:     document.getElementById('kick-btn'),
  };

  var state = {
    stream: null,
    recorder: null,
    mime: null,
    bytes: 0,
    startedAt: 0,
    tickHandle: null,
    isLive: false,
    // File-mode "talk over" mic: the admin can mix their microphone into
    // the file's audio track. Audio-only — the video is the file's own
    // capture track (no canvas), so there's no framerate cost. `mixer`
    // holds the Web Audio graph; see the "File audio mixer" section.
    talkOn: false,            // admin mic captured + unmuted
    fileMuted: false,         // "Mute File Stream" — file audio gain 0
    fileLocalMuted: false,    // monitor mute — silence the file on THIS device
                              // only; the stream still carries the audio
    fileBlank: false,         // "Blank File Stream" — broadcast a black frame
    mixer: null,
    micStream: null,
    fileBlackTrack: null,
  };

  // ── Helpers ──────────────────────────────────────────────────────────
  function setStatus(state, label) {
    if (!els.wsStatus) return;
    els.wsStatus.dataset.state = state;
    els.wsStatus.textContent = label;
  }
  function setLive(live) {
    state.isLive = live;
    els.liveDot.classList.toggle('is-live', live);
    els.liveLabel.textContent = live ? 'Live' : 'Offline';
    refreshControls();
  }

  // Single source of truth for which buttons are visible / enabled.
  // Called whenever state.stream, state.isLive, or state.source changes.
  function refreshControls() {
    var hasStream = !!state.stream;
    var live = !!state.isLive;
    var fileMode = state.source === 'file';

    // Primary button. In camera mode it's the Start/Stop Stream toggle.
    // In file mode it doubles as the file's Play/Pause control — going
    // live happens implicitly on the first Play, and pausing keeps the
    // broadcast live (viewers see the Paused overlay).
    if (fileMode) {
      var fileReady = !!(state.fileEl && state.fileEl.duration);
      var playing = fileReady && !state.fileEl.paused && !state.fileEl.ended;
      els.liveBtn.disabled = !fileReady;
      els.liveBtn.classList.toggle('is-live', playing);
      els.liveBtn.classList.toggle('btn-primary', !playing);
      els.liveBtnLabel.textContent = playing ? 'Pause' : 'Play';
      els.liveBtn.title = playing ? 'Pause the file' : 'Play the file';
    } else {
      els.liveBtn.disabled = !hasStream;
      els.liveBtn.classList.toggle('is-live', live);
      els.liveBtn.classList.toggle('btn-primary', !live);
      els.liveBtnLabel.textContent = live ? 'Stop Stream' : 'Start Stream';
      els.liveBtn.title = live ? 'End the broadcast' : 'Start broadcasting';
    }

    // Camera-mode preview buttons. In file mode the file picker IS the
    // way to start, so the camera Start/Stop Preview buttons just get
    // out of the way.
    els.previewBtn.textContent = hasStream ? 'Restart preview' : 'Start preview';
    els.previewBtn.hidden    = live || fileMode;
    els.stopPreviewBtn.hidden = !hasStream || live || fileMode;

    // Mic-mute / cam-blank toggles — these are camera-mode controls only.
    // In file mode they're hidden entirely (the file's own audio/video is
    // managed via the talk-over mic and local monitor-mute instead).
    setHidden(els.micBtn, fileMode);
    setHidden(els.camBtn, fileMode);
    els.micBtn.disabled = !hasStream;
    els.camBtn.disabled = !hasStream;

    // Talk-over mic — only meaningful when broadcasting a video file,
    // and only usable once a file is actually loaded.
    if (els.talkMicBtn) {
      setHidden(els.talkMicBtn, !fileMode);
      els.talkMicBtn.disabled = !(fileMode && hasStream);
    }
    // Local monitor mute — silence the file on this device only. File
    // mode only; usable once a file is loaded.
    if (els.monitorMuteBtn) {
      setHidden(els.monitorMuteBtn, !fileMode);
      els.monitorMuteBtn.disabled = !(fileMode && hasStream);
    }

    // Video-file timeline scrubber — always shown in file mode, but greyed
    // out until a file is actually loaded.
    if (els.fileTransport) {
      setHidden(els.fileTransport, !fileMode);
      var fileLoaded = !!(state.fileEl && state.fileEl.duration);
      els.fileSeek.disabled = !(fileMode && fileLoaded);
    }

    // Red border + LIVE chip on the preview frame.
    if (els.videoWrap) els.videoWrap.classList.toggle('is-live', live);
  }

  // True when the file audio mixer is the active broadcast audio source
  // (file mode with a built mixer). The file-stream mute and talk-over
  // mic act through the mixer's gains.
  function mixerActive() {
    return !!(state.mixer && state.source === 'file');
  }

  // SVG elements don't reliably implement the `hidden` IDL property
  // across browsers, so `el.hidden = true` may not reflect to the
  // attribute (and our CSS [hidden]{display:none} rule won't fire).
  // setAttribute / removeAttribute are spec-mandated to work on every
  // Element regardless of namespace.
  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else      el.removeAttribute('hidden');
  }

  function setMicMuted(muted) {
    var fileMode = state.source === 'file';
    var text = els.micBtn.querySelector('.btn-toggle-text');
    var iconOn = els.micBtn.querySelector('.ico-on');
    var iconOff = els.micBtn.querySelector('.ico-off');
    if (fileMode) {
      // Source is a video file — the underlying audio track is the
      // file's audio. Trade the microphone glyph for a clear text
      // label so it reads as a file-stream toggle, distinct from the
      // talk-over mic icon button beside it.
      setHidden(iconOn, true);
      setHidden(iconOff, true);
      setHidden(text, false);
      text.textContent = muted ? 'Unmute File Stream' : 'Mute File Stream';
      els.micBtn.classList.add('is-text');
    } else {
      setHidden(iconOn, muted);
      setHidden(iconOff, !muted);
      setHidden(text, true);
      els.micBtn.classList.remove('is-text');
    }
    els.micBtn.classList.toggle('is-off', muted);
    els.micBtn.setAttribute('aria-pressed', String(muted));
    var label = fileMode
      ? (muted ? 'Unmute file stream audio' : 'Mute file stream audio')
      : (muted ? 'Unmute microphone' : 'Mute microphone');
    els.micBtn.title = label;
    els.micBtn.setAttribute('aria-label', label);
  }

  function setCamOff(off) {
    var fileMode = state.source === 'file';
    var text = els.camBtn.querySelector('.btn-toggle-text');
    if (fileMode) {
      // Match the mic button: a text label ("Blank File Stream") reads
      // more clearly than a camera glyph next to the talk-over mic.
      setHidden(els.camBtn.querySelector('.ico-on'),  true);
      setHidden(els.camBtn.querySelector('.ico-off'), true);
      setHidden(text, false);
      text.textContent = off ? 'Show File Stream' : 'Blank File Stream';
      els.camBtn.classList.add('is-text');
    } else {
      setHidden(els.camBtn.querySelector('.ico-on'),  off);
      setHidden(els.camBtn.querySelector('.ico-off'), !off);
      setHidden(text, true);
      els.camBtn.classList.remove('is-text');
    }
    els.camBtn.classList.toggle('is-off', off);
    els.camBtn.setAttribute('aria-pressed', String(off));
    var label = fileMode
      ? (off ? 'Show file stream video' : 'Blank file stream video')
      : (off ? 'Enable camera' : 'Disable camera');
    els.camBtn.title = label;
    els.camBtn.setAttribute('aria-label', label);
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function formatElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var mm = String(Math.floor(s / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function pickMime() {
    var candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  // 16:9 width matched to each target height so the camera can negotiate
  // a sensible aspect ratio rather than landing on whatever default it
  // picks (some cameras default to 4:3 if you only constrain height).
  var QUALITY_PROFILES = {
    1080: { w: 1920, h: 1080 },
    720:  { w: 1280, h: 720  },
    480:  { w: 854,  h: 480  },
    360:  { w: 640,  h: 360  },
  };

  function targetProfile() {
    var q = parseInt(els.qualitySel.value, 10) || 720;
    return QUALITY_PROFILES[q] || QUALITY_PROFILES[720];
  }
  function targetFps() {
    return parseInt(els.fpsSel.value, 10) || 30;
  }

  function getConstraints() {
    var p = targetProfile();
    var fps = targetFps();
    var cam = els.cameraSel.value;
    var mic = els.micSel.value;
    return {
      video: {
        deviceId: cam ? { exact: cam } : undefined,
        width:     { ideal: p.w },
        height:    { ideal: p.h },
        frameRate: { ideal: fps, max: fps },
      },
      audio: {
        deviceId: mic ? { exact: mic } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
      },
    };
  }

  // ── Device list ──────────────────────────────────────────────────────
  function populateDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      var mics = devices.filter(function (d) { return d.kind === 'audioinput'; });
      fillSelect(els.cameraSel, cams, 'Camera');
      fillSelect(els.micSel, mics, 'Microphone');
    });
  }
  function fillSelect(sel, devices, kind) {
    var prev = sel.value;
    sel.innerHTML = '';
    if (!devices.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No ' + kind.toLowerCase() + ' found';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    devices.forEach(function (d, i) {
      var opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || (kind + ' ' + (i + 1));
      sel.appendChild(opt);
    });
    sel.disabled = false;
    // Preserve selection across re-enumerations when the device is still there.
    if (prev && devices.some(function (d) { return d.deviceId === prev; })) {
      sel.value = prev;
    }
  }

  // ── Preview / capture ────────────────────────────────────────────────
  function stopStream() {
    // Tear down the file audio mixer + talk-over mic if active.
    teardownFileAudio();
    // Drop the canvas-blank broadcast stream if active.
    if (state.blackBroadcastStream) {
      state.blackBroadcastStream.getVideoTracks().forEach(function (t) {
        try { t.stop(); } catch (_) {}
      });
      state.blackBroadcastStream = null;
    }
    state.usingBlackVideo = false;
    if (state.cameraHolderEl) state.cameraHolderEl.srcObject = null;
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
      state.stream = null;
    }
    els.preview.srcObject = null;
    if (els.overlay) els.overlay.hidden = false;
    if (els.filePaused) setHidden(els.filePaused, true);
    refreshControls();
  }

  function applyStream(stream) {
    state.stream = stream;
    // Drop any prior canvas-blanking state — a fresh getUserMedia
    // resolves with real tracks, so the broadcast stream is just the
    // raw stream again.
    if (state.blackBroadcastStream) {
      state.blackBroadcastStream.getVideoTracks().forEach(function (t) {
        try { t.stop(); } catch (_) {}
      });
      state.blackBroadcastStream = null;
    }
    if (state.cameraHolderEl) state.cameraHolderEl.srcObject = null;
    state.usingBlackVideo = false;
    els.preview.srcObject = stream;
    els.overlay.hidden = true;
    // Reset toggle indicators — new tracks always start enabled.
    // New source starts unmuted / unblanked.
    state.fileMuted = false;
    state.fileBlank = false;
    if (state.fileBlackTrack) {
      try { state.fileBlackTrack.stop(); } catch (_) {}
      state.fileBlackTrack = null;
    }
    els.preview.style.opacity = '';
    setMicMuted(false);
    setCamOff(false);
    refreshControls();
    populateDevices();
    // In file mode, (re)build the audio mixer so the admin can talk over
    // the file. The preview/broadcast video is the file's own track.
    if (state.source === 'file') {
      ensureFileMixer();
      // Reflect the file's resolution class in the (disabled) Quality
      // dropdown so it reads e.g. "1080p" for a 1920-wide movie.
      if (state.fileEl && state.fileEl.videoWidth) {
        var cls = qualityFromDims(state.fileEl.videoWidth, state.fileEl.videoHeight);
        els.qualitySel.value = dropdownValueForClass(cls);
      }
    }
    // Refresh the auto-bitrate readout — it now depends on the source's
    // actual resolution (e.g. a 1080p file should show its 1080p tier).
    syncBitrateUI();
  }

  // ── Camera "blank" via canvas-backed broadcast stream ────────────────
  //
  // Goals:
  //   1. The camera LED stays ON while muted (visual + UX cue).
  //   2. Toggling back is instant (no permission prompt, no flicker).
  //   3. The broadcast keeps flowing — viewers see steady black.
  //
  // Approach: `state.stream` (the real camera+mic from getUserMedia) is
  // NEVER mutated. We only swap what MediaRecorder records:
  //
  //   - Normal:  MediaRecorder records `state.stream` directly.
  //   - Muted:   MediaRecorder records `state.blackBroadcastStream`,
  //              built as (canvas-black-video + state.stream audio).
  //
  // To keep the device held by the browser while the preview is showing
  // the black canvas, we park `state.stream` on a hidden <video> element
  // so it remains an active consumer. Camera LED stays on.
  function createBlackVideoTrack(w, h, fps) {
    var canvas = document.createElement('canvas');
    canvas.width  = w || 1280;
    canvas.height = h || 720;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var stream = canvas.captureStream(fps || 30);
    var track = stream.getVideoTracks()[0];
    // captureStream only emits a frame when the canvas is redrawn —
    // poke it on a timer so MediaRecorder keeps getting input.
    var period = Math.max(16, Math.round(1000 / (fps || 30)));
    var handle = setInterval(function () {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 1, 1);
    }, period);
    var origStop = track.stop.bind(track);
    track.stop = function () {
      clearInterval(handle);
      origStop();
    };
    return track;
  }

  function ensureCameraHolder() {
    if (state.cameraHolderEl) return state.cameraHolderEl;
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    // Off-screen but rendered so the browser keeps the camera active.
    v.style.cssText =
      'position:fixed;width:1px;height:1px;left:-2px;top:-2px;' +
      'opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    state.cameraHolderEl = v;
    return v;
  }

  function blankCameraVideo() {
    if (state.usingBlackVideo) return;
    var camTrack = state.stream.getVideoTracks()[0];
    if (!camTrack) return;
    var s = camTrack.getSettings() || {};

    // Park the real stream on a hidden <video> so the browser keeps the
    // camera open (LED stays on, no permission round-trip on restore).
    var holder = ensureCameraHolder();
    holder.srcObject = state.stream;
    holder.play().catch(function () {});

    // Build the broadcast-only stream: canvas black video + real audio.
    var bs = new MediaStream();
    bs.addTrack(createBlackVideoTrack(s.width, s.height, s.frameRate));
    state.stream.getAudioTracks().forEach(function (t) { bs.addTrack(t); });
    state.blackBroadcastStream = bs;

    // Preview now shows the broadcast stream — broadcaster sees the
    // exact same black frame their viewers see.
    els.preview.srcObject = bs;
    state.usingBlackVideo = true;
  }

  function restoreCameraVideo() {
    if (!state.usingBlackVideo) return;
    // Stop the canvas video track (clears its frame-pump interval too).
    if (state.blackBroadcastStream) {
      state.blackBroadcastStream.getVideoTracks().forEach(function (t) {
        try { t.stop(); } catch (_) {}
      });
      state.blackBroadcastStream = null;
    }
    // Hand the real camera back to the preview, release the holder.
    els.preview.srcObject = state.stream;
    if (state.cameraHolderEl) state.cameraHolderEl.srcObject = null;
    state.usingBlackVideo = false;
  }

  // What MediaRecorder should record from right now.
  function getBroadcastStream() {
    // Camera mode (incl. its canvas-blank path) — unchanged behavior.
    if (state.source !== 'file') {
      return state.usingBlackVideo && state.blackBroadcastStream
        ? state.blackBroadcastStream
        : state.stream;
    }
    // File mode: video is the file's own capture track (native resolution,
    // no canvas → no framerate cost), swapped for a black track when
    // "Blank File Stream" is on. Audio is the mixer output (file audio +
    // optional talk-over mic), or the raw file audio if no mixer yet.
    var ms = new MediaStream();
    var vtrack = state.fileBlank && state.fileBlackTrack
      ? state.fileBlackTrack
      : (state.stream && state.stream.getVideoTracks()[0]);
    if (vtrack) ms.addTrack(vtrack);
    var atrack = mixerActive() && state.mixer.dest
      ? state.mixer.dest.stream.getAudioTracks()[0]
      : (state.stream && state.stream.getAudioTracks()[0]);
    if (atrack) ms.addTrack(atrack);
    return ms;
  }

  // ── File audio mixer + talk-over mic ─────────────────────────────────
  //
  // When broadcasting a video file the admin can mix their microphone
  // into the file's audio so they can talk over it. This is audio-only:
  // the broadcast video stays the file's own capture track (no canvas,
  // no re-encode resize), so there is no framerate cost. The mixer is a
  // small Web Audio graph whose single output track stays stable, which
  // is why muting the file or toggling the mic is seamless — it never
  // swaps the recorded audio track, so the live broadcast isn't cut.
  //
  //   file audio ─► fileGain ─┐
  //                           ├─► dest (one mixed track → broadcast)
  //   admin mic  ─► micGain  ─┘
  //
  // Neither gain is routed to audioCtx.destination: the operator already
  // hears the file from the hidden file element, and monitoring their own
  // mic would echo.

  function buildFileMixer() {
    if (state.mixer) return state.mixer;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    var audioCtx = new AC();
    if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (_) {} }
    var dest = audioCtx.createMediaStreamDestination();
    var fileGain = audioCtx.createGain();
    var micGain  = audioCtx.createGain();
    fileGain.connect(dest);
    micGain.connect(dest);
    state.mixer = {
      audioCtx: audioCtx, dest: dest,
      fileGain: fileGain, micGain: micGain,
      fileSrc: null, micSrc: null,
    };
    connectMixerFileAudio();
    if (state.micStream) connectMixerMicAudio();
    applyMixerGains();
    return state.mixer;
  }

  function teardownFileMixer() {
    var m = state.mixer;
    if (!m) return;
    try { if (m.fileSrc) m.fileSrc.disconnect(); } catch (_) {}
    try { if (m.micSrc)  m.micSrc.disconnect();  } catch (_) {}
    try { m.audioCtx.close(); } catch (_) {}
    state.mixer = null;
  }

  function connectMixerFileAudio() {
    var m = state.mixer;
    if (!m) return;
    if (m.fileSrc) { try { m.fileSrc.disconnect(); } catch (_) {} m.fileSrc = null; }
    var atrack = state.stream && state.stream.getAudioTracks()[0];
    if (!atrack) return;
    m.fileSrc = m.audioCtx.createMediaStreamSource(new MediaStream([atrack]));
    m.fileSrc.connect(m.fileGain);
  }

  function connectMixerMicAudio() {
    var m = state.mixer;
    if (!m) return;
    if (m.micSrc) { try { m.micSrc.disconnect(); } catch (_) {} m.micSrc = null; }
    var atrack = state.micStream && state.micStream.getAudioTracks()[0];
    if (!atrack) return;
    m.micSrc = m.audioCtx.createMediaStreamSource(new MediaStream([atrack]));
    m.micSrc.connect(m.micGain);
  }

  function applyMixerGains() {
    var m = state.mixer;
    if (!m) return;
    m.fileGain.gain.value = state.fileMuted ? 0 : 1;
    m.micGain.gain.value  = state.talkOn ? 1 : 0;
  }

  // Local monitor mute: mute the file's audio on the broadcaster's own
  // machine only. This sets the hidden <video> element's `muted` flag,
  // which silences local playback but does NOT affect the captureStream
  // audio track the mixer broadcasts — so viewers keep hearing the file.
  function setFileLocalMute(muted) {
    state.fileLocalMuted = !!muted;
    if (state.fileEl) state.fileEl.muted = state.fileLocalMuted;
    syncMonitorBtn();
  }
  function syncMonitorBtn() {
    if (!els.monitorMuteBtn) return;
    var m = state.fileLocalMuted;
    els.monitorMuteBtn.classList.toggle('is-off', m);
    setHidden(els.monitorMuteBtn.querySelector('.ico-on'),  m);
    setHidden(els.monitorMuteBtn.querySelector('.ico-off'), !m);
    els.monitorMuteBtn.setAttribute('aria-pressed', String(m));
    els.monitorMuteBtn.title = m
      ? 'Unmute file audio on this device'
      : 'Mute file audio on this device (viewers still hear it)';
    els.monitorMuteBtn.setAttribute('aria-label', els.monitorMuteBtn.title);
  }

  // Capture the talk-over mic. AEC / noise-suppression / AGC are OFF on
  // purpose: enabling echo cancellation re-binds the audio OUTPUT device
  // for AEC, which briefly glitches the file's playback (and therefore
  // the broadcast). The broadcaster is talking over a file, not on a
  // call, so none of that processing is needed. Use headphones to avoid
  // the mic picking up the file's audio from speakers.
  function acquireTalkMic() {
    var mic = els.micSel.value;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: mic ? { exact: mic } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  }

  // Capture the mic up front (muted) so it's hot and ready before the
  // user ever unmutes. Calling getUserMedia mid-playback can stall the
  // decoding file element (and thus the broadcast video) for a beat —
  // doing it now, fire-and-forget, keeps the unmute itself instant.
  // Best-effort: if it fails/denied, toggleTalk lazily acquires later.
  function prewarmTalkMic() {
    if (state.micStream || state.source !== 'file') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    acquireTalkMic().then(function (ms) {
      if (state.source !== 'file' || state.micStream) {
        ms.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
        return;
      }
      state.micStream = ms;
      buildFileMixer();                 // no-op if already built
      connectMixerMicAudio();
      applyMixerGains();                // talkOn is false → mic stays muted
      syncTalkBtn();
    }).catch(function () { /* denied — toggleTalk will prompt on first click */ });
  }

  // The talk-over mic toggle. The broadcast audio is ALWAYS the mixer's
  // output track, so muting/unmuting is only a gain change — it never
  // swaps the recorded track, restarts the encoder, or calls getUserMedia
  // (once the mic is captured), so it can't interrupt the stream.
  function toggleTalk() {
    if (state.source !== 'file') return;

    if (state.talkOn) {                 // → mute (keep the mic captured)
      state.talkOn = false;
      applyMixerGains();
      syncTalkBtn();
      return;
    }
    if (state.micStream) {              // → unmute, mic already hot: pure gain
      state.talkOn = true;
      applyMixerGains();
      syncTalkBtn();
      return;
    }
    // Mic not pre-warmed yet (e.g. unmuting during preview before going
    // live, or permission not yet granted). Acquire it now — this one
    // call may stall briefly; every unmute afterwards is a pure gain flip.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('This browser cannot access the microphone.');
      return;
    }
    els.talkMicBtn.disabled = true;     // guard against double-click mid-acquire
    acquireTalkMic().then(function (ms) {
      els.talkMicBtn.disabled = false;
      if (state.source !== 'file') {    // source changed while prompt was open
        ms.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
        return;
      }
      state.micStream = ms;
      buildFileMixer();                 // no-op if already built
      connectMixerMicAudio();
      state.talkOn = true;
      applyMixerGains();
      syncTalkBtn();
    }).catch(function (err) {
      els.talkMicBtn.disabled = false;
      handleAcquireError(err);
    });
  }

  function syncTalkBtn() {
    if (!els.talkMicBtn) return;
    var on = state.talkOn;
    els.talkMicBtn.classList.toggle('is-on', on);
    setHidden(els.talkMicBtn.querySelector('.ico-on'),  !on);
    setHidden(els.talkMicBtn.querySelector('.ico-off'),  on);
    els.talkMicBtn.setAttribute('aria-pressed', String(on));
    els.talkMicBtn.title = on
      ? 'Stop talking over file (mute mic)'
      : 'Talk over file (unmute mic)';
    els.talkMicBtn.setAttribute('aria-label', els.talkMicBtn.title);
  }

  // Blank / unblank the file video for the broadcast (preview dims too).
  // Swaps the broadcast video track, so it does restart the encoder.
  function setFileBlank(blank) {
    state.fileBlank = blank;
    if (blank) {
      if (!state.fileBlackTrack) {
        var fe = state.fileEl;
        state.fileBlackTrack = createBlackVideoTrack(
          (fe && fe.videoWidth) || 1280, (fe && fe.videoHeight) || 720, 30);
      }
    } else if (state.fileBlackTrack) {
      try { state.fileBlackTrack.stop(); } catch (_) {}
      state.fileBlackTrack = null;
    }
    // Give the operator local feedback: dim the preview to black.
    if (els.preview) els.preview.style.opacity = blank ? '0' : '';
    setCamOff(blank);
    scheduleEncoderRestart();
  }

  // Build / refresh the file mixer for the current file. Called when a
  // file is applied as the source.
  function ensureFileMixer() {
    if (state.source !== 'file') return;
    if (!state.mixer) buildFileMixer();
    else connectMixerFileAudio();
    applyMixerGains();
  }

  // Tear down all file-mode audio (mixer + mic) and blank state. Used
  // when stopping the stream or switching away from the file source.
  function teardownFileAudio() {
    state.talkOn = false;
    if (state.micStream) {
      state.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      state.micStream = null;
    }
    teardownFileMixer();
    if (state.fileBlackTrack) {
      try { state.fileBlackTrack.stop(); } catch (_) {}
      state.fileBlackTrack = null;
    }
    state.fileMuted = false;
    state.fileBlank = false;
    if (els.preview) els.preview.style.opacity = '';
    syncTalkBtn();
  }

  // ── File source ──────────────────────────────────────────────────────
  //
  // The "Video file" tab loads a local file via a <input type=file>,
  // plays it through a hidden <video>, and exposes that element's
  // MediaStream (via captureStream()) as `state.stream`. Everything
  // downstream — preview, MediaRecorder, the late-joiner buffer,
  // mic/cam mute, the quality chip — works unchanged because the
  // captureStream tracks behave like getUserMedia tracks.
  //
  // captureStream's tracks go inert when the source pauses (the
  // preview can blank, MediaRecorder stops getting frames). We handle
  // that with: (a) a large "Paused" overlay on the preview while the
  // file is paused, so the broadcaster has clear feedback; and (b) a
  // full encoder restart on every file `play` event — refresh the
  // captureStream + scheduleEncoderRestart — which gives MediaRecorder
  // a fresh, active stream and viewers a clean MSE re-init.
  state.source = 'file';   // 'camera' | 'file' — default to the video-file source
  state.fileEl = null;
  state.fileUrl = null;

  function ensureFileEl() {
    if (state.fileEl) return state.fileEl;
    var v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    // Off-screen but rendered so captureStream produces frames.
    v.style.cssText =
      'position:fixed;left:-2px;top:-2px;width:1px;height:1px;' +
      'opacity:0;pointer-events:none;';
    document.body.appendChild(v);
    state.fileEl = v;

    v.addEventListener('timeupdate', updateFileTransport);
    v.addEventListener('loadedmetadata', updateFileTransport);
    // Pause / play handling. captureStream's tracks go inert when the
    // source pauses and don't recover via MediaRecorder.resume(), so
    // every play does a full encoder restart against a freshly-
    // captured stream. The preview's pause overlay covers the brief
    // window where the preview's <video> may render nothing.
    v.addEventListener('play', function () {
      refreshControls();                // sync the Play/Pause button label
      togglePausedOverlay();
      refreshFileCapture();             // fresh, active tracks
      // captureStream's video track changes on every play, so restart the
      // encoder to pick it up (the mixer's audio track is stable across
      // this, so talk-over survives the restart).
      if (state.isLive) {
        scheduleEncoderRestart();
        socket.emit('bcast:paused', { paused: false });   // viewers: hide overlay
      }
    });
    v.addEventListener('pause', function () {
      refreshControls();                // sync the Play/Pause button label
      togglePausedOverlay();
      // Halt the encoder cleanly so it doesn't emit malformed chunks
      // from the now-frozen source. The matching 'play' event does a
      // full restart, so MediaRecorder.resume() is not used.
      if (state.isLive && state.recorder && state.recorder.state === 'recording') {
        try { state.recorder.pause(); } catch (_) {}
      }
      if (state.isLive) socket.emit('bcast:paused', { paused: true });   // viewers: show overlay
    });
    v.addEventListener('ended', function () {
      refreshControls();                // sync the Play/Pause button label
      togglePausedOverlay();
      if (state.isLive && state.recorder && state.recorder.state === 'recording') {
        try { state.recorder.pause(); } catch (_) {}
      }
      if (state.isLive) socket.emit('bcast:paused', { paused: true });   // viewers: show overlay
    });
    return v;
  }

  function loadFile(file) {
    if (!file) return Promise.reject(new Error('No file'));
    var v = ensureFileEl();

    // Tear down whatever the previous source was (camera or other file)
    // without nuking the file <video> element itself.
    var prevStream = state.stream;
    state.stream = null;
    if (state.blackBroadcastStream) {
      state.blackBroadcastStream.getVideoTracks().forEach(function (t) {
        try { t.stop(); } catch (_) {}
      });
      state.blackBroadcastStream = null;
    }
    state.usingBlackVideo = false;
    if (state.cameraHolderEl) state.cameraHolderEl.srcObject = null;
    if (prevStream) {
      prevStream.getTracks().forEach(function (t) {
        // Stop camera tracks; never stop the file element's underlying
        // captureStream tracks (they belong to v, not to us).
        try { t.stop(); } catch (_) {}
      });
    }

    if (state.fileUrl) {
      try { URL.revokeObjectURL(state.fileUrl); } catch (_) {}
    }
    state.fileUrl = URL.createObjectURL(file);
    v.src = state.fileUrl;
    v.loop = !!els.fileLoop.checked;
    v.muted = state.fileLocalMuted;   // honor the local monitor-mute choice
    els.filePickText.textContent = file.name;
    els.filePickText.title = file.name;

    return new Promise(function (resolve, reject) {
      // 'loadeddata' fires once the first frame is decoded — captureStream
      // can then emit that frame so the preview shows a still of the
      // file's opening frame instead of black, even though we don't
      // start playback.
      var onLoaded = function () {
        v.removeEventListener('loadeddata', onLoaded);
        v.removeEventListener('error', onError);
        var stream;
        try {
          stream = v.captureStream ? v.captureStream() :
                   v.mozCaptureStream ? v.mozCaptureStream() : null;
        } catch (e) { return reject(e); }
        if (!stream) return reject(new Error('captureStream is not supported in this browser.'));
        applyStream(stream);   // calls refreshControls → enables the transport
        updateFileTransport();
        togglePausedOverlay();        // file loaded paused → show overlay
        resolve(stream);
      };
      var onError = function () {
        v.removeEventListener('loadeddata', onLoaded);
        v.removeEventListener('error', onError);
        reject(new Error('Could not decode that file. Try MP4 (H.264/AAC) or WebM (VP8/VP9/Opus).'));
      };
      v.addEventListener('loadeddata', onLoaded);
      v.addEventListener('error', onError);
      v.load();
    });
  }

  // Re-capture the file element's stream so we pick up fresh, active
  // tracks. captureStream's tracks go inert when the source pauses and
  // don't reliably wake back up — calling it again gives us a stream
  // with currently-active tracks. Also the audio track is only
  // populated by the browser after the source has actually played
  // audio, so this needs re-running after the first play().
  function refreshFileCapture() {
    if (state.source !== 'file' || !state.fileEl) return;
    try {
      var fresh = state.fileEl.captureStream();
      state.stream = fresh;
      // Rebind the mixer's file-audio source to the fresh capture track.
      if (mixerActive()) connectMixerFileAudio();
      // Keep the preview on the file (unless the cam-blank canvas path is
      // showing for camera mode, which never applies in file mode).
      // Reassigning srcObject does NOT re-fire the element's autoplay, so
      // after a pause→play cycle the preview would otherwise stay frozen
      // on its last frame even though viewers get the fresh stream — kick
      // it back into playback explicitly. (It's muted, so no autoplay
      // policy block.)
      if (!state.usingBlackVideo && !state.fileBlank) {
        els.preview.srcObject = fresh;
        var p = els.preview.play();
        if (p && p.catch) p.catch(function () {});
      }
    } catch (_) {}
  }

  function togglePausedOverlay() {
    if (!els.filePaused) return;
    var show = state.source === 'file' && state.fileEl &&
               (state.fileEl.paused || state.fileEl.ended) &&
               !!state.stream &&   // only when we actually have a preview to overlay
               !state.fileBlank;   // already showing a black frame
    setHidden(els.filePaused, !show);
  }

  function teardownFileSource() {
    if (state.fileEl) {
      try { state.fileEl.pause(); } catch (_) {}
      state.fileEl.removeAttribute('src');
      try { state.fileEl.load(); } catch (_) {}
    }
    if (state.fileUrl) {
      try { URL.revokeObjectURL(state.fileUrl); } catch (_) {}
      state.fileUrl = null;
    }
    els.filePickText.textContent = 'Choose file…';
    if (els.fileInput) els.fileInput.value = '';
    refreshControls();   // grey out the transport (file mode) or hide it (camera)
    togglePausedOverlay();
  }

  function formatClock(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' + sec : String(sec));
  }
  function updateFileTransport() {
    var v = state.fileEl;
    if (!v) return;
    var cur = v.currentTime, dur = v.duration || 0;
    if (dur > 0) {
      els.fileSeek.value = String(Math.round((cur / dur) * 1000));
    }
    els.fileTime.textContent = formatClock(cur) + ' / ' + formatClock(dur);
  }

  // ── Source-mode switching ────────────────────────────────────────────
  function setSource(mode) {
    if (mode !== 'camera' && mode !== 'file') return;
    if (mode === state.source) return;
    state.source = mode;

    document.querySelectorAll('.source-tab').forEach(function (b) {
      var active = b.dataset.sourceTab === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('[data-source-panel]').forEach(function (p) {
      p.hidden = p.dataset.sourcePanel !== mode;
    });

    // Quality / FPS dropdowns dictate camera capture only — they have
    // no effect on a pre-recorded file (the file's native res/fps are
    // what captureStream produces). Disable them in file mode so the
    // UI stays honest.
    els.qualitySel.disabled = (mode !== 'camera');
    els.fpsSel    .disabled = (mode !== 'camera');

    // Switching away from a source: tear down its underlying media.
    if (mode === 'camera') {
      teardownFileSource();
      stopStream();
    } else {
      // Switching to file mode: stop the camera but leave any
      // previously-loaded file alone (so you can re-pick if needed).
      stopStream();
      // If we had a file loaded before, re-attach the captureStream
      // without resuming playback. The file stays paused at its
      // current position until the user clicks Play or Go Live.
      if (state.fileEl && state.fileEl.duration) {
        try {
          var s = state.fileEl.captureStream();
          applyStream(s);
          updateFileTransport();
          togglePausedOverlay();
        } catch (_) {}
      }
    }
    refreshControls();
    // Re-render the track toggles so they switch between icon mode
    // (camera) and "…File Stream" text mode (file). Right after a source
    // swap applyStream already reset the muted/blank state to false.
    setMicMuted(false);
    setCamOff(false);
    syncTalkBtn();
  }

  // Single entry point for getUserMedia. Used by both the manual Start
  // Preview button and the automatic reconfigure path. Falls back to
  // looser constraints if the camera can't satisfy the requested ones
  // (e.g. asking for 1080p60 on a webcam that only does 720p30).
  function acquireMedia() {
    stopStream();
    return navigator.mediaDevices.getUserMedia(getConstraints())
      .then(applyStream)
      .catch(function (err) {
        var retryable = err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError');
        if (!retryable) throw err;
        var p = targetProfile();
        return navigator.mediaDevices.getUserMedia({
          video: { height: { ideal: p.h } },
          audio: true,
        }).then(applyStream);
      });
  }

  function startPreview() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert(
        'Your browser cannot access camera/microphone.\n\n' +
        'This usually means the page is being served over plain HTTP ' +
        'from a non-localhost origin. Use https://… instead.'
      );
      return;
    }
    acquireMedia().catch(handleAcquireError);
  }

  function handleAcquireError(err) {
    console.error(err);
    var msg = err && err.name === 'NotAllowedError'
      ? 'Camera/microphone access was denied. Open the site permissions in your browser and set Camera + Microphone to "Allow".'
      : err && err.name === 'NotReadableError'
        ? 'Camera or microphone is busy. Close other apps (Zoom, Meet, OBS) and try again.'
        : ('Could not access camera/microphone: ' + (err && err.message ? err.message : err));
    alert(msg);
  }

  // Re-acquire the camera with whatever the dropdowns currently say,
  // and if we're already live, transparently restart the broadcast at
  // the new resolution / frame rate / device. Viewers get a fresh
  // stream:init and re-initialize MSE for the new format.
  var reconfigureGen = 0;
  function reconfigure() {
    if (!state.stream) return;            // nothing to reconfigure
    if (state.reconfiguring) return;      // already in flight
    state.reconfiguring = true;
    var gen = ++reconfigureGen;
    var wasLive = state.isLive;

    // Tear down the current recorder WITHOUT sending bcast:stop — the
    // server treats the next bcast:start (same sid) as a reset.
    if (state.recorder && state.recorder.state !== 'inactive') {
      try { state.recorder.stop(); } catch (_) {}
    }
    state.recorder = null;
    if (state.tickHandle) { clearInterval(state.tickHandle); state.tickHandle = null; }

    acquireMedia()
      .then(function () {
        if (gen !== reconfigureGen) return;  // a newer reconfigure superseded us
        if (wasLive) {
          // Tell the server to reset its late-joiner buffer and notify
          // viewers. beginRecorder() will run when bcast:started arrives.
          socket.emit('bcast:start', { mime: state.mime, meta: trackMeta(), lock: lockPayload() });
        }
      })
      .catch(function (err) {
        handleAcquireError(err);
        if (wasLive) stopLive();
      })
      .then(function () { state.reconfiguring = false; },
            function () { state.reconfiguring = false; });
  }

  // Debounce rapid dropdown changes so we don't fire three reconfigures
  // when the user opens a select and the change event repeats.
  var reconfigureTimer = null;
  function scheduleReconfigure() {
    if (!state.stream) return;
    if (reconfigureTimer) clearTimeout(reconfigureTimer);
    reconfigureTimer = setTimeout(function () {
      reconfigureTimer = null;
      reconfigure();
    }, 200);
  }

  // Fast path for bitrate-only changes: same camera stream, just stop
  // and restart the MediaRecorder so the new videoBitsPerSecond takes
  // effect. No effect at all if we're not actively broadcasting since
  // bitrate doesn't change the preview.
  var encoderTimer = null;
  function scheduleEncoderRestart() {
    if (!state.isLive) return;
    if (encoderTimer) clearTimeout(encoderTimer);
    encoderTimer = setTimeout(function () {
      encoderTimer = null;
      if (state.recorder && state.recorder.state !== 'inactive') {
        try { state.recorder.stop(); } catch (_) {}
      }
      state.recorder = null;
      if (state.tickHandle) { clearInterval(state.tickHandle); state.tickHandle = null; }
      socket.emit('bcast:start', { mime: state.mime, meta: trackMeta(), lock: lockPayload() });
    }, 200);
  }

  // ── Broadcasting ─────────────────────────────────────────────────────
  // Map a frame size to a standard quality class. We anchor on the
  // LARGER dimension so a widescreen movie (e.g. 1920×818) is correctly
  // "1080p" — it's the 1920-wide horizontal resolution that defines the
  // class, not the letterboxed height. Thresholds sit a little below
  // each standard width so slightly-under sources (e.g. 1900) still
  // round up. Works for portrait too (max dimension drives it).
  function qualityFromDims(w, h) {
    var d = Math.max(w || 0, h || 0);
    if (!d) return null;
    if (d >= 3000) return '4K';
    if (d >= 2200) return '1440p';
    if (d >= 1700) return '1080p';
    if (d >= 1100) return '720p';
    if (d >=  760) return '480p';
    if (d >=  560) return '360p';
    return d + 'p';
  }

  // Which Quality-dropdown <option> best matches a quality class. The
  // dropdown tops out at 1080p, so 1440p/4K sources clamp to 1080.
  function dropdownValueForClass(cls) {
    if (cls === '4K' || cls === '1440p' || cls === '1080p') return '1080';
    if (cls === '720p') return '720';
    if (cls === '480p') return '480';
    return '360';
  }

  function trackMeta() {
    // Read the actual settings the camera negotiated for us. These can
    // be smaller than what we requested (e.g. a laptop cam capped at
    // 720p will give us 720p even if we asked for 1080p).
    var meta = { width: 0, height: 0, frameRate: 0, bitrate: 0, quality: null };
    if (!state.stream) return meta;
    var video = state.stream.getVideoTracks()[0];
    if (!video) return meta;
    var s = video.getSettings ? video.getSettings() : {};
    meta.width  = s.width  || 0;
    meta.height = s.height || 0;
    // A file's captureStream track reports its dimensions late/unreliably
    // (often 0 or a stale value right at go-live), which mislabels the
    // quality. The <video> element's intrinsic size is accurate once the
    // file's metadata has loaded, so prefer it in file mode.
    if (state.source === 'file' && state.fileEl && state.fileEl.videoWidth) {
      meta.width  = state.fileEl.videoWidth;
      meta.height = state.fileEl.videoHeight;
    }
    meta.frameRate = Math.round(s.frameRate || 0);
    meta.bitrate   = effectiveBitrate();
    // Label by the frame's larger dimension (see qualityFromDims).
    meta.quality   = qualityFromDims(meta.width, meta.height);
    return meta;
  }

  function goLive() {
    if (!state.stream) return;
    var mime = pickMime();
    if (!mime) {
      alert('This browser does not support MediaRecorder with WebM. Try Chrome, Edge, or Firefox.');
      return;
    }
    state.mime = mime;
    state.bytes = 0;
    state.startedAt = Date.now();
    els.codecOut.textContent = mime;
    els.bytesOut.textContent = '0 B';
    els.elapsedOut.textContent = '00:00';

    // In file mode, broadcasting a paused file would stream a frozen
    // frame. Resume from the current position so Go Live really means
    // "start sending what's playing now."
    //
    // Order matters here: the captureStream's audio track is only
    // populated once playback actually starts, so we must play() AND
    // re-capture the stream BEFORE telling the server to start, so
    // MediaRecorder is constructed against a stream that contains both
    // video and audio tracks. Otherwise viewers get a silent broadcast.
    if (state.source === 'file' && state.fileEl) {
      var v = state.fileEl;
      // Make sure the broadcast audio is the mixer's (stable) track from
      // the first frame, so a later talk-over unmute is just a gain flip.
      ensureFileMixer();
      // Pre-warm the mic now (file still paused → getUserMedia won't stall
      // playback) so unmuting later never has to call getUserMedia.
      prewarmTalkMic();
      var send = function () {
        // After play(), splice the audio track into the combined stream
        // so MediaRecorder (about to be constructed by the bcast:started
        // response) sees both video (canvas) and audio (file) tracks.
        refreshFileCapture();
        refreshControls();   // flip the primary button to "Pause"
        socket.emit('bcast:start', { mime: mime, meta: trackMeta(), lock: lockPayload() });
      };
      if (v.paused || v.ended) {
        if (v.ended && v.duration) try { v.currentTime = 0; } catch (_) {}
        v.play().then(send).catch(function (err) {
          console.error('file auto-resume on Go Live failed:', err);
          send();  // attempt broadcast anyway so the user sees feedback
        });
      } else {
        send();
      }
      return;
    }

    socket.emit('bcast:start', { mime: mime, meta: trackMeta(), lock: lockPayload() });
  }

  function autoBitrate() {
    // Bitrate ladder roughly aligned with YouTube live recommendations
    // for VP8/VP9, keyed off the quality CLASS (so a 1920-wide cinematic
    // file gets the 1080p bitrate, not a 720p one). 60fps tiers get ~1.5×.
    //
    // In file mode the Quality dropdown is disabled and irrelevant, so we
    // read the file's real resolution instead of the dropdown.
    var w, h, fps;
    if (state.source === 'file' && state.fileEl && state.fileEl.videoWidth) {
      w = state.fileEl.videoWidth;
      h = state.fileEl.videoHeight;
      fps = 30;   // a file's native fps isn't exposed; assume 30 for the ladder
    } else {
      var p = targetProfile();
      w = p.w; h = p.h;
      fps = targetFps();
    }
    var cls = qualityFromDims(w, h);
    var base = cls === '4K'    ? 8_000_000
             : cls === '1440p' ? 6_000_000
             : cls === '1080p' ? 4_500_000
             : cls === '720p'  ? 2_500_000
             : cls === '480p'  ? 1_400_000
             :                   800_000;
    return fps >= 60 ? Math.round(base * 1.5) : base;
  }

  // Effective bitrate in bits/sec. When the Auto checkbox is on we
  // derive it from the resolution+fps ladder; otherwise we honor
  // whatever the user put on the slider.
  function effectiveBitrate() {
    if (els.bitrateAuto.checked) return autoBitrate();
    var kbps = parseInt(els.bitrateSlider.value, 10) || 2500;
    return kbps * 1000;
  }

  function formatBitrate(bps) {
    var kbps = Math.round(bps / 1000);
    if (kbps >= 1000) return (kbps / 1000).toFixed(kbps % 1000 ? 1 : 0) + ' Mbps';
    return kbps + ' kbps';
  }

  function syncBitrateUI() {
    var bps = effectiveBitrate();
    if (els.bitrateAuto.checked) {
      els.bitrateSlider.value = Math.round(bps / 1000);
      els.bitrateSlider.disabled = true;
    } else {
      els.bitrateSlider.disabled = false;
    }
    els.bitrateOut.textContent = formatBitrate(bps);
    els.bitrateOut.title = bps.toLocaleString() + ' bits/sec';
  }

  function beginRecorder() {
    var bitrate = effectiveBitrate();
    var rec;
    try {
      rec = new MediaRecorder(getBroadcastStream(), {
        mimeType: state.mime,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 96_000,
      });
    } catch (err) {
      console.error(err);
      alert('Failed to start MediaRecorder: ' + err.message);
      return;
    }
    state.recorder = rec;
    // The closure binds `rec` to THIS recorder. If reconfigure() swaps
    // state.recorder for a new one, any still-pending chunks from this
    // recorder are silently dropped — preventing the new stream from
    // getting polluted with stale frames from the old encoder.
    rec.ondataavailable = function (e) {
      if (rec !== state.recorder) return;
      if (!e.data || !e.data.size) return;
      e.data.arrayBuffer().then(function (buf) {
        if (rec !== state.recorder) return;
        socket.emit('bcast:chunk', buf);
        state.bytes += buf.byteLength;
        els.bytesOut.textContent = formatBytes(state.bytes);
      });
    };
    // No onstop handler — every code path that intentionally ends the
    // broadcast (stopLive, kick, disconnect) emits bcast:stop explicitly.
    rec.start(250);  // 250ms chunks
    state.tickHandle = setInterval(function () {
      els.elapsedOut.textContent = formatElapsed(Date.now() - state.startedAt);
    }, 1000);
    setLive(true);
    // Refresh the broadcaster's own viewer-count display.
    els.bytesOut.textContent = formatBytes(state.bytes);
  }

  function stopLive() {
    if (state.recorder && state.recorder.state !== 'inactive') {
      try { state.recorder.stop(); } catch (_) {}
    }
    if (state.tickHandle) { clearInterval(state.tickHandle); state.tickHandle = null; }
    state.recorder = null;
    socket.emit('bcast:stop');
    setLive(false);
    // When broadcasting a file, "Stop Stream" should also pause playback
    // locally so the broadcaster isn't left with audio coming out of
    // their speakers and the playhead drifting forward after they
    // stopped sharing.
    if (state.source === 'file' && state.fileEl &&
        !state.fileEl.paused && !state.fileEl.ended) {
      try { state.fileEl.pause(); } catch (_) {}
    }
  }

  // ── Wire up controls ─────────────────────────────────────────────────
  els.previewBtn.addEventListener('click', startPreview);
  els.stopPreviewBtn.addEventListener('click', function () {
    // Only available when previewing but not live.
    stopStream();
  });
  els.liveBtn.addEventListener('click', function () {
    if (els.liveBtn.disabled) return;
    // File mode: the primary button is a Play/Pause toggle for the file.
    // First Play goes live (goLive() resumes the file as it starts the
    // broadcast); afterwards it just plays/pauses the loaded file while
    // staying live. Use End Stream Session to actually stop broadcasting.
    if (state.source === 'file') {
      var v = state.fileEl;
      if (!v || !v.duration) return;
      if (!state.isLive) {
        goLive();
      } else if (v.paused || v.ended) {
        if (v.ended && v.duration) { try { v.currentTime = 0; } catch (_) {} }
        v.play().then(refreshFileCapture).catch(function (err) {
          console.error('file play() failed:', err);
        });
      } else {
        v.pause();
      }
      return;
    }
    if (state.isLive) stopLive(); else goLive();
  });

  // Live re-acquire on source/quality change. If we're broadcasting,
  // the change propagates to viewers automatically via bcast:start.
  // If we're only previewing, the preview window updates in place.
  function onResolutionChange() {
    // If the user has Auto bitrate on, snap the slider/display to the
    // new resolution's recommended bitrate before reconfiguring.
    syncBitrateUI();
    persistSettings();
    scheduleReconfigure();
  }
  els.qualitySel.addEventListener('change', onResolutionChange);
  els.fpsSel    .addEventListener('change', onResolutionChange);
  els.cameraSel .addEventListener('change', scheduleReconfigure);
  els.micSel    .addEventListener('change', scheduleReconfigure);

  // Bitrate slider: `input` fires continuously while dragging — update
  // the readout but don't restart the encoder until the user releases
  // (the `change` event). Moving the slider also flips off Auto.
  els.bitrateSlider.addEventListener('input', function () {
    if (els.bitrateAuto.checked) els.bitrateAuto.checked = false;
    syncBitrateUI();
  });
  els.bitrateSlider.addEventListener('change', function () {
    persistSettings();
    scheduleEncoderRestart();
  });

  els.bitrateAuto.addEventListener('change', function () {
    syncBitrateUI();
    persistSettings();
    scheduleEncoderRestart();
  });

  // Source tabs
  document.querySelectorAll('.source-tab').forEach(function (b) {
    b.addEventListener('click', function () { setSource(b.dataset.sourceTab); persistSettings(); });
  });

  // File picker → load the chosen file as the broadcast source.
  // ── Transcode UI helpers ────────────────────────────────────────────
  function showTranscoding(visible) {
    if (!els.fileTranscoding) return;
    setHidden(els.fileTranscoding, !visible);
    if (visible) updateTranscodeProgress(0);
  }
  function updateTranscodeProgress(p) {
    var pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    els.fileTranscodingBar.style.width = pct + '%';
    els.fileTranscodingPct.textContent = pct + '%';
  }

  // Load a chosen file: try native first, fall back to ffmpeg.wasm
  // transcode on failure or for known-incompatible formats (MKV/AVI/…).
  function loadFilePicked(originalFile) {
    var T = window.Viibestream && window.Viibestream.Transcode;
    if (!T) {
      // Transcode helper isn't available — best effort native.
      return loadFile(originalFile);
    }
    var verdict = T.classify(originalFile);

    function transcodeAndLoad() {
      els.filePickText.textContent = 'Transcoding ' + originalFile.name + '…';
      showTranscoding(true);
      return T.transcode(originalFile, updateTranscodeProgress)
        .then(function (blob) {
          var transcoded = T.blobAsFile(blob, originalFile.name);
          showTranscoding(false);
          els.filePickText.textContent = originalFile.name + ' (transcoded)';
          return loadFile(transcoded);
        }, function (err) {
          showTranscoding(false);
          throw err;
        });
    }

    if (verdict === 'transcode') {
      return transcodeAndLoad();
    }
    // 'native' or 'unknown' — try the browser first.
    return T.tryNativeLoad(originalFile)
      .then(function () { return loadFile(originalFile); })
      .catch(function () { return transcodeAndLoad(); });
  }

  els.fileInput.addEventListener('change', function () {
    var f = els.fileInput.files && els.fileInput.files[0];
    if (!f) return;
    console.log('[viibestream] picked file:', f.name, f.size, 'bytes, type:', f.type || '(unknown)');
    loadFilePicked(f).then(function () {
      // Remember the filename so a refresh can prompt the operator to
      // re-pick this same file, and clear any stale "last session" hint.
      lastPickedName = f.name;
      hideFileHint();
      persistSettings();
      // If we're live, restart the encoder so viewers re-init MSE with
      // the file's tracks instead of the camera's.
      scheduleEncoderRestart();
    }).catch(function (err) {
      console.error('[viibestream] file load failed:', err);
      var msg = (err && err.message) || (err && String(err)) || 'Could not load that file.';
      alert('Could not load file:\n\n' + msg + '\n\n(Open DevTools Console for more detail.)');
      els.filePickText.textContent = 'Choose file…';
      showTranscoding(false);
    });
  });

  // File transport: seek + loop. Play/pause is driven by the primary
  // button (see the live-btn click handler above).
  els.fileSeek.addEventListener('input', function () {
    var v = state.fileEl;
    if (!v || !v.duration) return;
    var pct = parseInt(els.fileSeek.value, 10) / 1000;
    v.currentTime = pct * v.duration;
  });
  els.fileLoop.addEventListener('change', function () {
    if (state.fileEl) state.fileEl.loop = !!els.fileLoop.checked;
    persistSettings();
  });

  // ── Access lock controls ────────────────────────────────────────────
  var LOCK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L
  var LOCK_LS = { enabled: 'vbs-lock-enabled', code: 'vbs-lock-code' };

  function randomCode() {
    var out = '';
    var buf = new Uint8Array(5);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(buf);
    } else {
      for (var j = 0; j < 5; j++) buf[j] = Math.floor(Math.random() * 256);
    }
    for (var i = 0; i < 5; i++) out += LOCK_ALPHABET.charAt(buf[i] % LOCK_ALPHABET.length);
    return out;
  }
  function normalizeCode(value) {
    return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }
  function readSavedLockState() {
    try {
      // Default the lock to ON for a fresh install — viewers always see
      // the code prompt unless the operator has explicitly turned it off.
      var saved = localStorage.getItem(LOCK_LS.enabled);
      var enabled = (saved === null) ? true : (saved === '1');
      return {
        enabled: enabled,
        code:    normalizeCode(localStorage.getItem(LOCK_LS.code) || ''),
      };
    } catch (_) { return { enabled: true, code: '' }; }
  }
  function persistLockState() {
    try {
      localStorage.setItem(LOCK_LS.enabled, els.lockToggle.checked ? '1' : '0');
      localStorage.setItem(LOCK_LS.code, normalizeCode(els.lockCode.value));
    } catch (_) {}
  }
  function syncLockUI() {
    var on = els.lockToggle.checked;
    els.lockCode.disabled = false;             // always editable
    els.lockCode.classList.toggle('is-armed', on);
  }
  function lockPayload() {
    return {
      enabled: !!els.lockToggle.checked,
      code:    normalizeCode(els.lockCode.value),
    };
  }
  function pushLockState() {
    // Always persist locally, and always push to the server — the
    // server accepts set_lock from any broadcaster-capable user, not
    // just the currently-live one, so the lock stays enforced for
    // viewers between broadcasts.
    persistLockState();
    if (socket && socket.connected) socket.emit('bcast:set_lock', lockPayload());
  }

  // Restore the operator's last-used lock from localStorage.
  (function initLockUI () {
    var saved = readSavedLockState();
    els.lockToggle.checked = saved.enabled;
    els.lockCode.value = saved.code || randomCode();   // never blank
    syncLockUI();
    // If we had to mint a fresh code (none saved), persist it now so a
    // hard refresh keeps the same code. The code only changes when the
    // operator clicks the rotate button or edits the field.
    if (!saved.code) persistLockState();
  })();

  els.lockToggle.addEventListener('change', function () {
    // Turning the lock on with no code yet → auto-generate one so the
    // operator isn't staring at an empty input.
    if (els.lockToggle.checked && !normalizeCode(els.lockCode.value)) {
      els.lockCode.value = randomCode();
    }
    syncLockUI();
    pushLockState();
  });

  // ── Viewer reactions toggle ──────────────────────────────────────────
  // Owned by the operator's browser (localStorage) and pushed to the server
  // on connect + on change, mirroring the lock. The server reflects it to
  // viewers via stream:state so their reaction button shows/hides.
  var REACTIONS_LS = 'vbs-reactions-enabled';
  function reactionsEnabled() {
    return !!(els.reactionsToggle && els.reactionsToggle.checked);
  }
  function pushReactionsState() {
    if (socket && socket.connected) {
      socket.emit('bcast:set_reactions', { enabled: reactionsEnabled() });
    }
  }
  if (els.reactionsToggle) {
    // Restore the operator's last choice (default on if never set).
    try {
      var savedReactions = localStorage.getItem(REACTIONS_LS);
      els.reactionsToggle.checked = savedReactions !== '0';
    } catch (_) {}
    els.reactionsToggle.addEventListener('change', function () {
      try { localStorage.setItem(REACTIONS_LS, reactionsEnabled() ? '1' : '0'); } catch (_) {}
      pushReactionsState();
      updateReactionVisibility();
    });
  }

  // ── Video reactions ──────────────────────────────────────────────────
  // The broadcaster is a chat user (host auto-join), so they can send a
  // reaction from the palette like any participant. Reactions from viewers
  // (and other senders) rain over the preview here too — the host's own
  // sends are skipped server-side so they don't see their own echoed back.
  var REACTION_BURST = 9;        // particles spawned per reaction
  var REACTION_MAX = 150;        // hard cap on concurrent particles
  var reactionCount = 0;
  function rrand(min, max) { return min + Math.random() * (max - min); }

  function spawnReactionParticle(emoji, stageH) {
    var p = document.createElement('span');
    p.className = 'reaction-particle';
    p.textContent = emoji;
    p.style.left = rrand(2, 95).toFixed(2) + '%';
    p.style.fontSize = rrand(1.25, 2.6).toFixed(2) + 'rem';
    p.style.setProperty('--fall', Math.round(stageH + 64) + 'px');
    p.style.setProperty('--drift', Math.round(rrand(-70, 70)) + 'px');
    p.style.setProperty('--rot', Math.round(rrand(-220, 220)) + 'deg');
    p.style.animationDuration = rrand(2.6, 4.4).toFixed(2) + 's';
    p.style.animationDelay = rrand(0, 0.7).toFixed(2) + 's';
    reactionCount++;
    p.addEventListener('animationend', function () {
      reactionCount--;
      if (p.parentNode) p.parentNode.removeChild(p);
    });
    els.reactionLayer.appendChild(p);
  }

  function rainReaction(emoji) {
    if (!els.reactionLayer || !emoji) return;
    var stageH = els.videoWrap ? els.videoWrap.clientHeight : 360;
    for (var i = 0; i < REACTION_BURST; i++) {
      if (reactionCount >= REACTION_MAX) break;
      spawnReactionParticle(emoji, stageH);
    }
  }

  // "Who reacted" pill at the top-center of the preview. Reactions play one
  // at a time: a newer reaction queues and waits for the current pill to slide
  // out before its own pops down (mirrors the viewer player).
  var reactionQueue = [];
  var reactionPlaying = false;
  var REACTION_QUEUE_MAX = 12;
  var PILL_DISPLAY_MS = 2400;
  var PILL_SLIDE_MS = 300;
  var REACTION_GAP_MS = 180;

  function buildSenderPill(info) {
    var el = els.reactionSender;
    while (el.firstChild) el.removeChild(el.firstChild);
    var av = document.createElement('span');
    av.className = 'reaction-sender-avatar';
    av.textContent = info.avatar || '👤';
    if (info.color) { av.style.background = info.color; av.style.color = '#fff'; }
    var nm = document.createElement('span');
    nm.className = 'reaction-sender-name';
    nm.textContent = info.name;
    var em = document.createElement('span');
    em.className = 'reaction-sender-emoji';
    em.textContent = info.emoji || '';
    el.appendChild(av);
    el.appendChild(nm);
    el.appendChild(em);
  }

  function enqueueReaction(info) {
    if (!info || !info.emoji) return;
    if (reactionQueue.length >= REACTION_QUEUE_MAX) return;
    reactionQueue.push(info);
    playNextReaction();
  }

  function playNextReaction() {
    if (reactionPlaying || !els.reactionSender) return;
    var info = reactionQueue.shift();
    if (!info) return;
    reactionPlaying = true;
    rainReaction(info.emoji);
    if (info.name) {
      buildSenderPill(info);
      els.reactionSender.classList.add('is-visible');
    }
    setTimeout(function () {
      els.reactionSender.classList.remove('is-visible');
      setTimeout(function () {
        reactionPlaying = false;
        playNextReaction();
      }, PILL_SLIDE_MS + REACTION_GAP_MS);
    }, PILL_DISPLAY_MS);
  }

  socket.on('video:reaction', function (info) {
    if (info && info.emoji) enqueueReaction(info);
  });

  // The host's chat identity (auto-joined from their login) — used to label
  // the host's own reactions, which we render locally since the server skips
  // echoing a reaction back to its sender.
  var hostIdentity = null;
  document.addEventListener('vbs:chat-identity', function (e) {
    var d = (e && e.detail) || {};
    hostIdentity = d.joined ? (d.me || null) : null;
  });

  function openReactionPalette(open) {
    if (!els.reactionPalette || !els.reactionBtn) return;
    els.reactionPalette.hidden = !open;
    els.reactionBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (els.reactionControl) els.reactionControl.classList.toggle('is-open', open);
  }
  // The backend reaction button is available whenever reactions are enabled.
  function updateReactionVisibility() {
    if (!els.reactionControl) return;
    els.reactionControl.hidden = !reactionsEnabled();
    if (!reactionsEnabled()) openReactionPalette(false);
  }
  updateReactionVisibility();

  if (els.reactionBtn) {
    els.reactionBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openReactionPalette(els.reactionPalette.hidden);
    });
  }
  if (els.reactionPalette) {
    els.reactionPalette.addEventListener('click', function (e) {
      var btn = e.target.closest('.reaction-palette-emoji');
      if (!btn) return;
      if (!reactionsEnabled()) { openReactionPalette(false); return; }
      var emoji = btn.dataset.emoji;
      // Render our own reaction locally (the server skips echoing it back to
      // the sender), labelled with the host's chat identity to match viewers.
      var me = hostIdentity || {};
      enqueueReaction({ emoji: emoji, name: me.name, avatar: me.emoji, color: me.color });
      socket.emit('viewer:react', { emoji: emoji });
      openReactionPalette(false);
    });
  }
  document.addEventListener('click', function (e) {
    if (!els.reactionPalette || els.reactionPalette.hidden) return;
    if (els.reactionControl && els.reactionControl.contains(e.target)) return;
    openReactionPalette(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && els.reactionPalette && !els.reactionPalette.hidden) {
      openReactionPalette(false);
    }
  });

  // ── Alert banner ─────────────────────────────────────────────────────
  // The operator's active alert is owned by their browser (localStorage) and
  // pushed to the server on connect + on change, like the lock. It drops a
  // banner down over every viewer's video (and the preview) until taken down.
  var ALERT_LS = 'vbs-alert-message';
  function readActiveAlert() {
    try { return localStorage.getItem(ALERT_LS) || ''; } catch (_) { return ''; }
  }
  function writeActiveAlert(msg) {
    try {
      if (msg) localStorage.setItem(ALERT_LS, msg);
      else localStorage.removeItem(ALERT_LS);
    } catch (_) {}
  }
  function renderAlertPreview(msg) {
    if (!els.alertBanner) return;
    if (msg) {
      if (els.alertText) els.alertText.textContent = msg;
      els.alertBanner.classList.add('is-visible');
    } else {
      els.alertBanner.classList.remove('is-visible');
    }
  }
  function reflectAlertUI(active) {
    setHidden(els.alertClearBtn, !active);
    setHidden(els.alertStatus, !active);
  }
  function pushAlertState() {
    if (socket && socket.connected) {
      socket.emit('bcast:set_alert', { message: readActiveAlert() });
    }
  }
  function showAlert() {
    var msg = (els.alertInput.value || '').trim();
    if (!msg) { els.alertInput.focus(); return; }
    writeActiveAlert(msg);
    renderAlertPreview(msg);
    reflectAlertUI(true);
    pushAlertState();
  }
  function clearAlert() {
    writeActiveAlert('');
    renderAlertPreview('');
    reflectAlertUI(false);
    pushAlertState();
  }
  if (els.alertShowBtn) els.alertShowBtn.addEventListener('click', showAlert);
  if (els.alertClearBtn) els.alertClearBtn.addEventListener('click', clearAlert);
  // Restore the active alert on load so a refresh keeps showing it.
  (function initAlertUI() {
    var active = readActiveAlert();
    if (els.alertInput) els.alertInput.value = active;
    renderAlertPreview(active);
    reflectAlertUI(!!active);
  })();

  // Normalize and debounce code edits (operator can type or paste).
  var lockCodeTimer = null;
  els.lockCode.addEventListener('input', function () {
    var caret = els.lockCode.selectionStart;
    var normalized = normalizeCode(els.lockCode.value);
    if (normalized !== els.lockCode.value) {
      els.lockCode.value = normalized;
      try { els.lockCode.setSelectionRange(caret, caret); } catch (_) {}
    }
    if (lockCodeTimer) clearTimeout(lockCodeTimer);
    lockCodeTimer = setTimeout(pushLockState, 300);
  });
  els.lockCode.addEventListener('blur', pushLockState);

  els.lockRandomize.addEventListener('click', function () {
    els.lockCode.value = randomCode();
    syncLockUI();
    pushLockState();
  });

  // Click the code field itself to copy it. Selects the text for visual
  // feedback and briefly shows a "Copied!" flash. Falls back to
  // execCommand when the async clipboard API is unavailable (e.g. a
  // non-HTTPS origin). The field stays editable via the keyboard.
  var lockCopyTimer = null;
  function flashCopied() {
    els.lockCode.classList.add('is-copied');
    if (els.lockTip) {
      els.lockTip.textContent = 'Copied!';
      els.lockTip.classList.add('is-show');   // force-show even if not hovering
    }
    if (lockCopyTimer) clearTimeout(lockCopyTimer);
    lockCopyTimer = setTimeout(function () {
      els.lockCode.classList.remove('is-copied');
      if (els.lockTip) {
        els.lockTip.classList.remove('is-show');
        els.lockTip.textContent = 'Click to copy';
      }
    }, 1200);
  }
  function copyCode() {
    var code = normalizeCode(els.lockCode.value);
    if (!code) return;
    try { els.lockCode.setSelectionRange(0, els.lockCode.value.length); } catch (_) {}
    var fallback = function () {
      try { document.execCommand('copy'); flashCopied(); } catch (_) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(flashCopied, fallback);
    } else {
      fallback();
    }
  }
  els.lockCode.addEventListener('click', copyCode);

  // ── Chat moderation ─────────────────────────────────────────────────
  function renderChatRoster(users) {
    var n = (users && users.length) || 0;
    els.chatModCount.textContent = String(n);
    // Wipe existing rows (except the empty-state placeholder).
    Array.prototype.slice.call(els.chatModRoster.children).forEach(function (c) {
      if (c !== els.chatModEmpty) els.chatModRoster.removeChild(c);
    });
    setHidden(els.chatModEmpty, n > 0);
    if (!n) return;
    users.forEach(function (u) {
      var row = document.createElement('div');
      row.className = 'chat-roster-row';
      row.dataset.sid = u.sid;

      var emoji = document.createElement('span');
      emoji.className = 'chat-roster-emoji';
      emoji.textContent = u.emoji || '👤';

      var info = document.createElement('div');
      info.className = 'chat-roster-info';
      var name = document.createElement('span');
      name.className = 'chat-roster-name';
      name.textContent = u.name;
      name.style.color = u.color || 'var(--text-strong)';
      var ip = document.createElement('span');
      ip.className = 'chat-roster-ip';
      ip.textContent = u.ip || '';
      info.appendChild(name);
      info.appendChild(ip);

      var kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'chat-roster-kick';
      kick.title = 'Remove + ban this IP for the rest of the stream';
      kick.setAttribute('aria-label', 'Remove ' + u.name);
      kick.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<line x1="18" y1="6" x2="6" y2="18"/>' +
        '<line x1="6" y1="6" x2="18" y2="18"/></svg>';
      kick.addEventListener('click', function () {
        if (window.confirm('Remove ' + u.name + ' and ban their IP for the rest of the stream?')) {
          socket.emit('chat:moderate_kick', { sid: u.sid });
        }
      });

      row.appendChild(emoji);
      row.appendChild(info);
      row.appendChild(kick);
      els.chatModRoster.appendChild(row);
    });
  }

  els.chatModToggle.addEventListener('change', function () {
    socket.emit('chat:moderate_enable', { enabled: !!els.chatModToggle.checked });
  });

  // Wipe the chat history without ending the stream session. The server
  // (chat:moderate_clear) tells every client to clear and drops a system note.
  if (els.chatModClear) {
    els.chatModClear.addEventListener('click', function () {
      if (window.confirm(
        'Clear the chat for everyone?\n\nThis wipes the chat history. ' +
        'The stream keeps running.'
      )) {
        socket.emit('chat:moderate_clear');
      }
    });
  }

  socket.on('chat:roster', function (users) {
    renderChatRoster(users || []);
  });
  socket.on('chat:enabled_changed', function (info) {
    if (info && typeof info.enabled === 'boolean') {
      els.chatModToggle.checked = info.enabled;
    }
  });
  socket.on('chat:state', function (snap) {
    if (snap && typeof snap.enabled === 'boolean') {
      els.chatModToggle.checked = snap.enabled;
    }
  });

  // ── Now Showing (stream info) ─────────────────────────────────────
  function setInfoStatus(text, kind) {
    els.infoFormStatus.textContent = text || '';
    els.infoFormStatus.classList.remove('is-success', 'is-error');
    if (kind === 'success') els.infoFormStatus.classList.add('is-success');
    if (kind === 'error')   els.infoFormStatus.classList.add('is-error');
  }

  function renderPosterPreview(info) {
    var img = els.infoPosterImg;
    if (info && info.has_poster) {
      img.src = '/poster?v=' + encodeURIComponent(info.poster_etag || Date.now());
      setHidden(img, false);
      setHidden(els.infoPosterPh, true);
      setHidden(els.infoPosterClear, false);
    } else {
      img.removeAttribute('src');
      setHidden(img, true);
      setHidden(els.infoPosterPh, false);
      setHidden(els.infoPosterClear, true);
    }
  }

  function applyInfoToForm(info) {
    if (!info) return;
    els.infoTitleInput.value   = info.title || '';
    els.infoDescInput.value    = info.description || '';
    els.infoImdbInput.value    = info.imdb_url || '';
    els.infoTrailerInput.value = info.trailer_url || '';
    renderPosterPreview(info);
    // The form now mirrors what's published — that's the new baseline the
    // Publish button greys against until the operator changes a field.
    state.publishedInfo = snapshotInfoBaseline(info);
    syncPublishBtn();
  }

  // ── Loaded-preset state ─────────────────────────────────────────────
  // When a Library preset is loaded into the form, the bottom button
  // becomes "Update" (instead of "Save to Library") and is disabled
  // until the operator actually changes something — that way they
  // don't accidentally overwrite a preset with identical content.
  state.loadedPreset = null;

  function snapshotPreset(p) {
    if (!p) return null;
    return {
      id: p.id,
      title:       (p.title || ''),
      description: (p.description || ''),
      imdb_url:    (p.imdb_url || ''),
      trailer_url: (p.trailer_url || ''),
      has_poster:  !!p.has_poster,
    };
  }

  function setLoadedPreset(p) {
    state.loadedPreset = snapshotPreset(p);
    els.infoForm.dataset.clearPoster = '';
    syncLibraryBtn();
  }

  function presetDirty() {
    var p = state.loadedPreset;
    if (!p) return false;
    if ((els.infoTitleInput.value   || '').trim() !== p.title)       return true;
    if ((els.infoDescInput.value    || '').trim() !== p.description) return true;
    if ((els.infoImdbInput.value    || '').trim() !== p.imdb_url)    return true;
    if ((els.infoTrailerInput.value || '').trim() !== p.trailer_url) return true;
    // Poster changes: new file picked, or removal requested.
    if (els.infoPosterFile.files && els.infoPosterFile.files.length) return true;
    if (els.infoForm.dataset.clearPoster === '1') return true;
    return false;
  }

  function syncLibraryBtn() {
    var btn = document.getElementById('info-save-to-library-btn');
    var label = document.getElementById('info-save-to-library-label');
    if (!btn || !label) return;
    if (state.loadedPreset) {
      label.textContent = 'Update';
      btn.title = state.loadedPreset.title
        ? 'Update preset "' + state.loadedPreset.title + '"'
        : 'Update preset';
      btn.disabled = !presetDirty();
    } else {
      label.textContent = 'Save to Library';
      btn.title = 'Save current values as a new preset';
      btn.disabled = false;
    }
  }

  // ── Published-state baseline (Publish-to-viewers button) ────────────
  // The "Publish to viewers" button greys out unless the form differs from
  // what's currently published. Loading a saved Library item publishes it,
  // so right after selecting one the form matches and the button stays grey
  // until the operator edits a field.
  state.publishedInfo = null;

  function snapshotInfoBaseline(info) {
    return {
      title:       (info && info.title || '').trim(),
      description: (info && info.description || '').trim(),
      imdb_url:    (info && info.imdb_url || '').trim(),
      trailer_url: (info && info.trailer_url || '').trim(),
    };
  }

  function infoDirty() {
    var b = state.publishedInfo;
    if (!b) return false;
    if ((els.infoTitleInput.value   || '').trim() !== b.title)       return true;
    if ((els.infoDescInput.value    || '').trim() !== b.description) return true;
    if ((els.infoImdbInput.value    || '').trim() !== b.imdb_url)    return true;
    if ((els.infoTrailerInput.value || '').trim() !== b.trailer_url) return true;
    // Poster: a freshly-picked file or a pending removal both count.
    if (els.infoPosterFile.files && els.infoPosterFile.files.length) return true;
    if (els.infoForm.dataset.clearPoster === '1') return true;
    return false;
  }

  function syncPublishBtn() {
    if (!els.infoSaveBtn) return;
    var dirty = infoDirty();
    els.infoSaveBtn.disabled = !dirty;
    // Grey/idle reads "Published"; once a field changes it invites the
    // operator to "Publish changes".
    els.infoSaveBtn.textContent = dirty ? 'Publish changes' : 'Published';
  }

  // Start greyed (empty form == empty baseline) until something changes.
  state.publishedInfo = snapshotInfoBaseline({});
  syncPublishBtn();

  // Fetch current info on load so the form mirrors what viewers see.
  fetch('/api/info', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (info) { applyInfoToForm(info); })
    .catch(function () {});

  // Show a local preview as soon as the operator picks a poster file
  // — even before they hit Save.
  els.infoPosterFile.addEventListener('change', function () {
    var f = els.infoPosterFile.files && els.infoPosterFile.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      els.infoPosterImg.src = reader.result;
      setHidden(els.infoPosterImg, false);
      setHidden(els.infoPosterPh, true);
      setHidden(els.infoPosterClear, false);
      setInfoStatus('Unsaved changes — hit Save to publish.');
      syncLibraryBtn();
      syncPublishBtn();
    };
    reader.readAsDataURL(f);
  });

  els.infoPosterClear.addEventListener('click', function () {
    els.infoPosterFile.value = '';
    els.infoPosterImg.removeAttribute('src');
    setHidden(els.infoPosterImg, true);
    setHidden(els.infoPosterPh, false);
    setHidden(els.infoPosterClear, true);
    // Mark the form so submit knows to send clear_poster=1
    els.infoForm.dataset.clearPoster = '1';
    setInfoStatus('Poster removal pending — hit Save to publish.');
    syncLibraryBtn();
    syncPublishBtn();
  });

  // Any input edit clears the status indicator so old "Saved" text
  // doesn't stick around once the operator starts typing again, and
  // recomputes whether a loaded preset is dirty so the Update button
  // enables/disables in real time.
  ['input', 'change'].forEach(function (evName) {
    els.infoForm.addEventListener(evName, function (e) {
      if (e.target === els.infoPosterFile || e.target === els.infoPosterClear) return;
      setInfoStatus('');
      syncLibraryBtn();
      syncPublishBtn();
    });
  });

  // ── Saved-showings library ────────────────────────────────────────
  var libraryEls = {
    list:        document.getElementById('library-list'),
    empty:       document.getElementById('library-empty'),
    saveBtn:     document.getElementById('library-save-current'),
    modal:       document.getElementById('library-modal'),
  };

  // Flask-WTF protects every state-changing request. Pull the token
  // from the hidden input that already lives in the Now Showing form
  // and ship it as a header on fetches that don't carry a FormData
  // body (Load, Delete).
  function csrfHeaderToken() {
    var input = els.infoForm.querySelector('input[name="csrf_token"]');
    return input ? input.value : '';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var Y = d.getFullYear();
    var M = String(d.getMonth() + 1).padStart(2, '0');
    var D = String(d.getDate()).padStart(2, '0');
    return Y + '-' + M + '-' + D;
  }

  function renderLibrary(items) {
    libraryEls.list.innerHTML = '';
    setHidden(libraryEls.empty, items && items.length > 0);
    if (!items || !items.length) return;
    items.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'library-item';
      li.dataset.id = s.id;

      var poster = document.createElement('div');
      poster.className = 'library-item-poster';
      if (s.has_poster) {
        var img = document.createElement('img');
        img.alt = '';
        img.src = '/admin/info/library/' + s.id + '/poster?v=' + encodeURIComponent(s.updated_at || '');
        poster.appendChild(img);
      }

      var info = document.createElement('div');
      info.className = 'library-item-info';
      var t = document.createElement('div');
      t.className = 'library-item-title';
      t.textContent = s.title || 'Untitled';
      var d = document.createElement('div');
      d.className = 'library-item-desc';
      d.textContent = s.description || '';
      var meta = document.createElement('div');
      meta.className = 'library-item-meta';
      meta.textContent = 'Saved ' + fmtDate(s.updated_at || s.created_at);
      info.appendChild(t);
      if (s.description) info.appendChild(d);
      info.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'library-item-actions';
      var loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'library-item-load';
      loadBtn.textContent = 'Load';
      loadBtn.title = 'Apply this preset and publish to viewers';
      loadBtn.addEventListener('click', function () { loadPreset(s.id); });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'library-item-delete';
      delBtn.textContent = 'Delete';
      delBtn.title = 'Remove this preset';
      delBtn.addEventListener('click', function () {
        if (window.confirm('Delete the preset "' + (s.title || 'Untitled') + '"?')) {
          deletePreset(s.id);
        }
      });
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);

      li.appendChild(poster);
      li.appendChild(info);
      li.appendChild(actions);
      libraryEls.list.appendChild(li);
    });
  }

  function refreshLibrary() {
    return fetch('/admin/info/library', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { renderLibrary(j.items || []); })
      .catch(function (err) {
        console.error('library fetch failed:', err);
      });
  }

  function saveCurrentAsPreset() {
    var title = (els.infoTitleInput.value || '').trim();
    if (!title) {
      setInfoStatus('Give it a title before saving as a preset.', 'error');
      return;
    }
    var data = new FormData(els.infoForm);
    // Mirror the form's clear-poster intent. If the user has clicked
    // "Remove poster" the preset should genuinely have no poster.
    // If they haven't, the server falls back to the currently-
    // published poster so re-saving an already-published showing
    // keeps its image.
    if (els.infoForm.dataset.clearPoster === '1') {
      data.set('clear_poster', '1');
    } else {
      data.delete('clear_poster');
    }
    libraryEls.saveBtn.disabled = true;
    fetch('/admin/info/library', {
      method: 'POST',
      credentials: 'same-origin',
      body: data,
    }).then(readJsonResponse).then(function (resp) {
      if (resp.body && resp.body.ok) {
        return refreshLibrary().then(function () {
          setInfoStatus('Preset "' + title + '" saved.', 'success');
        });
      }
      var err = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
      setInfoStatus(err, 'error');
    }).catch(function (err) {
      setInfoStatus('Network error: ' + (err && err.message ? err.message : err), 'error');
    }).then(function () {
      libraryEls.saveBtn.disabled = false;
    });
  }

  // Defensively read a Response as JSON. If the body isn't JSON
  // (e.g. an HTML 400 page from a CSRF or proxy error), return a
  // synthetic { ok: false, error: ... } payload so the caller can
  // surface a sensible message instead of a JSON.parse crash.
  function readJsonResponse(r) {
    return r.text().then(function (text) {
      var body;
      try { body = JSON.parse(text); }
      catch (_) {
        body = {
          ok: false,
          error: 'Server returned ' + r.status + (r.statusText ? ' ' + r.statusText : '') +
                 ' (non-JSON response).',
        };
      }
      return { status: r.status, body: body };
    });
  }

  function loadPreset(id) {
    fetch('/admin/info/library/' + id + '/load', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': csrfHeaderToken() },
    })
      .then(readJsonResponse)
      .then(function (resp) {
        if (resp.body && resp.body.ok && resp.body.info) {
          applyInfoToForm(resp.body.info);
          // Remember which preset is loaded so the bottom button can
          // flip into "Update" mode (disabled until something diverges).
          setLoadedPreset(resp.body.showing || null);
          setInfoStatus('Preset loaded and pushed to viewers.', 'success');
          var closer = libraryEls.modal.querySelector('[data-close-modal]');
          if (closer) closer.click();
        } else {
          var msg = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
          setInfoStatus('Could not load preset: ' + msg, 'error');
        }
      })
      .catch(function (err) {
        setInfoStatus('Network error: ' + (err && err.message ? err.message : err), 'error');
      });
  }

  function deletePreset(id) {
    fetch('/admin/info/library/' + id, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': csrfHeaderToken() },
    }).then(function (r) {
      if (r.ok) return refreshLibrary();
      throw new Error('HTTP ' + r.status);
    }).catch(function (err) {
      alert('Could not delete preset: ' + (err && err.message ? err.message : err));
    });
  }

  libraryEls.saveBtn.addEventListener('click', saveCurrentAsPreset);

  // The bottom card button works in two modes:
  //   - No preset loaded → "Save to Library" (creates a new preset)
  //   - A preset is loaded → "Update" (PUTs back to that preset's row,
  //     disabled until the operator actually changes something)
  var inlineSaveBtn = document.getElementById('info-save-to-library-btn');
  if (inlineSaveBtn) {
    inlineSaveBtn.addEventListener('click', function () {
      if (inlineSaveBtn.disabled) return;
      if (state.loadedPreset) updateLoadedPreset();
      else saveCurrentAsPreset();
    });
  }

  function updateLoadedPreset() {
    var p = state.loadedPreset;
    if (!p) return;
    var title = (els.infoTitleInput.value || '').trim();
    if (!title) {
      setInfoStatus('A preset needs a title.', 'error');
      return;
    }
    var data = new FormData(els.infoForm);
    if (els.infoForm.dataset.clearPoster === '1') {
      data.set('clear_poster', '1');
    } else {
      data.delete('clear_poster');
    }
    inlineSaveBtn.disabled = true;
    setInfoStatus('Updating preset…');
    fetch('/admin/info/library/' + p.id, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': csrfHeaderToken() },
      body: data,
    })
      .then(readJsonResponse)
      .then(function (resp) {
        if (resp.body && resp.body.ok) {
          setLoadedPreset(resp.body.showing);  // refresh snapshot → not dirty
          els.infoForm.dataset.clearPoster = '';
          els.infoPosterFile.value = '';
          setInfoStatus('Preset "' + (resp.body.showing.title || title) +
                        '" updated.', 'success');
          refreshLibrary();
        } else {
          var err = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
          setInfoStatus(err, 'error');
        }
      })
      .catch(function (err) {
        setInfoStatus('Network error: ' + (err && err.message ? err.message : err), 'error');
      })
      .then(function () {
        // Re-enable only if actually dirty (server snapshot may match
        // what the user has, in which case dirty=false and button stays
        // disabled).
        syncLibraryBtn();
      });
  }

  // Refresh the list each time the modal is opened (cheap, ensures
  // changes from other sessions show up).
  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open-modal="library-modal"]');
    if (opener) refreshLibrary();
  });

  els.infoForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(els.infoForm);
    if (els.infoForm.dataset.clearPoster === '1') {
      data.append('clear_poster', '1');
      // Don't also send a file input we may have cleared.
      if (!els.infoPosterFile.files || !els.infoPosterFile.files.length) {
        data.delete('poster');
      }
    }
    els.infoSaveBtn.disabled = true;
    setInfoStatus('Saving…');
    fetch('/admin/info', {
      method: 'POST',
      credentials: 'same-origin',
      body: data,
    }).then(readJsonResponse).then(function (resp) {
      if (resp.status >= 200 && resp.status < 300 && resp.body && resp.body.ok) {
        applyInfoToForm(resp.body.info);
        els.infoForm.dataset.clearPoster = '';
        els.infoPosterFile.value = '';
        setInfoStatus('Saved · viewers updated.', 'success');
      } else {
        var err = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
        setInfoStatus(err, 'error');
      }
    }).catch(function (err) {
      setInfoStatus('Network error: ' + (err && err.message ? err.message : err), 'error');
    }).then(function () {
      // On success applyInfoToForm reset the baseline → greys to "Published".
      // On failure the form is still dirty → re-enables "Publish changes".
      syncPublishBtn();
    });
  });

  // Clear Now Showing — wipes the published info (and its persisted row)
  // so viewers no longer see anything until it's set again.
  // Clear the published Now Showing (server + form). Shared by the
  // "Clear Now Showing" button and the End-Stream-Session reset.
  function clearNowShowing() {
    setInfoStatus('Clearing…');
    return fetch('/admin/info/clear', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': csrfHeaderToken() },
    }).then(readJsonResponse).then(function (resp) {
      if (resp.body && resp.body.ok) {
        applyInfoToForm(resp.body.info);     // now empty
        els.infoForm.dataset.clearPoster = '';
        els.infoPosterFile.value = '';
        setLoadedPreset(null);               // back to "Save to Library"
        setInfoStatus('Now Showing cleared.', 'success');
      } else {
        var err = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
        setInfoStatus(err, 'error');
      }
    }).catch(function (err) {
      setInfoStatus('Network error: ' + (err && err.message ? err.message : err), 'error');
    });
  }
  if (els.infoClearBtn) {
    els.infoClearBtn.addEventListener('click', function () {
      if (!window.confirm('Clear the Now Showing for all viewers?')) return;
      els.infoClearBtn.disabled = true;
      clearNowShowing().then(function () { els.infoClearBtn.disabled = false; });
    });
  }

  // End-Stream-Session reset: stop broadcasting, drop the video file, and
  // return all controls to their defaults — but deliberately KEEP the
  // access code (lock) and the chat. Also clears the Now Showing.
  function resetSessionToDefault() {
    // Stop the broadcast + release media, clear the file, back to the
    // default video-file source. stopStream()/setSource() run
    // teardownFileAudio(), which stops the talk-over mic + mixer and
    // resets the file mute/blank flags.
    stopLive();
    stopStream();
    teardownFileSource();
    if (state.source !== 'file') setSource('file');  // back to the default source

    // Encoding controls → defaults.
    els.qualitySel.value = '720';
    els.fpsSel.value = '30';
    els.bitrateAuto.checked = true;
    if (els.fileLoop) els.fileLoop.checked = true;
    syncBitrateUI();

    // Toggle states → defaults (mic/cam live, nothing muted/blanked).
    state.fileMuted = false;
    state.fileBlank = false;
    state.fileLocalMuted = false;
    if (state.fileEl) state.fileEl.muted = false;
    setMicMuted(false);
    setCamOff(false);
    syncTalkBtn();
    syncMonitorBtn();
    refreshControls();

    // Forget the remembered source/encoding settings so a refresh after
    // End Stream starts from the defaults, not the last session's values.
    clearSettings();

    // Drop the Now Showing too (access code + chat are left untouched).
    clearNowShowing();

    // Take down any active alert banner and reset its composer.
    if (els.alertInput) els.alertInput.value = '';
    clearAlert();
  }

  // ── Source/encoding settings persistence ──────────────────────────────
  // Keep the operator's source mode + encoding choices across a refresh so
  // only "End Stream Session" resets them. The actual video FILE can't be
  // restored (browsers won't let JS re-populate a file input), so a refresh
  // keeps every setting but the picked file, which must be re-chosen.
  var SETTINGS_LS = 'vbs-bcast-settings';
  var lastPickedName = '';   // filename of the last loaded file, for the resume hint
  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_LS, JSON.stringify({
        source:      state.source,
        quality:     els.qualitySel.value,
        fps:         els.fpsSel.value,
        bitrateAuto: !!els.bitrateAuto.checked,
        bitrate:     els.bitrateSlider.value,
        loop:        els.fileLoop ? !!els.fileLoop.checked : true,
        fileName:    lastPickedName,
      }));
    } catch (_) {}
  }
  function clearSettings() {
    lastPickedName = '';
    hideFileHint();
    try { localStorage.removeItem(SETTINGS_LS); } catch (_) {}
  }
  function restoreSettings() {
    var saved;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_LS) || 'null'); }
    catch (_) { saved = null; }
    if (!saved) return;
    if (saved.quality) els.qualitySel.value = saved.quality;
    if (saved.fps) els.fpsSel.value = saved.fps;
    if (typeof saved.bitrateAuto === 'boolean') els.bitrateAuto.checked = saved.bitrateAuto;
    if (saved.bitrate) els.bitrateSlider.value = saved.bitrate;
    if (els.fileLoop && typeof saved.loop === 'boolean') els.fileLoop.checked = saved.loop;
    // Source mode last so the quality/fps disabled-state ends up correct.
    if (saved.source === 'camera' && state.source !== 'camera') setSource('camera');
    // The file blob can't be restored, so nudge the operator to re-pick it.
    if (saved.fileName) { lastPickedName = saved.fileName; showFileHint(saved.fileName); }
  }
  function showFileHint(name) {
    if (!els.fileResumeHint) return;
    els.fileResumeHint.textContent =
      'Last session: “' + name + '” — re-select it to resume (browsers can’t reload files automatically).';
    setHidden(els.fileResumeHint, false);
  }
  function hideFileHint() {
    if (els.fileResumeHint) setHidden(els.fileResumeHint, true);
  }

  // Initial render so the readout is correct before any preview starts.
  restoreSettings();
  syncBitrateUI();
  refreshControls();
  syncLibraryBtn();
  syncTalkBtn();
  syncMonitorBtn();

  els.micBtn.addEventListener('click', function () {
    if (els.micBtn.disabled) return;
    // File mode → "Mute File Stream" toggles the file's audio. Via the
    // mixer gain when present (seamless), else the raw track's enabled.
    if (state.source === 'file') {
      state.fileMuted = !state.fileMuted;
      if (mixerActive()) {
        applyMixerGains();
      } else {
        var a = state.stream && state.stream.getAudioTracks()[0];
        if (a) a.enabled = !state.fileMuted;
      }
      setMicMuted(state.fileMuted);
      return;
    }
    if (!state.stream) return;
    var tracks = state.stream.getAudioTracks();
    if (!tracks.length) return;
    // Read the actual track state — single source of truth — then flip it.
    var nowMuted = tracks[0].enabled;
    tracks.forEach(function (t) { t.enabled = !nowMuted; });
    setMicMuted(nowMuted);
  });
  els.camBtn.addEventListener('click', function () {
    if (els.camBtn.disabled) return;
    // File mode → "Blank File Stream" swaps the broadcast video for a
    // black frame (and dims the preview).
    if (state.source === 'file') {
      setFileBlank(!state.fileBlank);
      return;
    }
    if (!state.stream) return;
    if (state.usingBlackVideo) {
      restoreCameraVideo();
      setCamOff(false);
    } else {
      blankCameraVideo();
      setCamOff(true);
    }
    // Stop & restart the encoder so the (live) viewers' MediaSource
    // picks up the new track. No-op when only previewing.
    scheduleEncoderRestart();
  });

  // ── Talk-over mic (file mode) ─────────────────────────────────────────
  els.talkMicBtn.addEventListener('click', function () {
    if (els.talkMicBtn.disabled) return;
    toggleTalk();
  });
  if (els.monitorMuteBtn) {
    els.monitorMuteBtn.addEventListener('click', function () {
      if (els.monitorMuteBtn.disabled) return;
      setFileLocalMute(!state.fileLocalMuted);
    });
  }
  if (els.kickBtn) {
    els.kickBtn.addEventListener('click', function () {
      if (window.confirm(
        'End the stream session?\n\nThis stops the broadcast, clears the ' +
        'video file, Now Showing, and chat, and resets settings to default. ' +
        'The access code is kept.'
      )) {
        state.endInitiatedByMe = true;   // suppress our own "ended by admin" alert
        socket.emit('bcast:kick');
        socket.emit('chat:moderate_clear');   // wipe the chat for everyone
        resetSessionToDefault();
      }
    });
  }

  // ── Socket.IO wiring ─────────────────────────────────────────────────
  socket.on('connect', function () {
    setStatus('connected', 'Connected');
    // As soon as we're connected, push the broadcaster's saved lock
    // configuration so viewers see the correct lock state immediately
    // — even before we go live.
    socket.emit('bcast:set_lock', lockPayload());
    // Same for the viewer-reactions toggle, so the server (and viewers)
    // reflect the operator's saved choice immediately.
    pushReactionsState();
    // Re-assert any active alert banner so it survives reconnects/restarts.
    pushAlertState();
    // Subscribe ourselves to chat events as a broadcaster so we receive
    // chat:roster / chat:message / chat:enabled_changed pushes for
    // moderation, and ask the server for the current snapshot.
    socket.emit('chat:moderate_state');
  });
  socket.on('disconnect', function () {
    setStatus('error', 'Disconnected');
    stopLive();
  });
  socket.on('connect_error', function () { setStatus('error', 'Connect error'); });

  socket.on('bcast:started', function () { beginRecorder(); });
  socket.on('bcast:ended',   function (info) {
    stopLive();
    // Don't alert the admin who just clicked "End Stream Session" — only
    // a broadcaster ended by someone else should see the notice.
    if (info && info.reason === 'kicked' && !state.endInitiatedByMe) {
      alert('Your broadcast was ended by an admin.');
    }
    state.endInitiatedByMe = false;
  });
  socket.on('bcast:error', function (info) {
    alert((info && info.message) || 'Broadcast error.');
    stopLive();
  });

  socket.on('stream:state', function (snap) {
    if (snap && typeof snap.viewers === 'number')
      els.viewerCount.textContent = String(snap.viewers);
  });
  socket.on('stream:viewers', function (info) {
    if (info && typeof info.count === 'number')
      els.viewerCount.textContent = String(info.count);
  });

  // Clean up if the user navigates away.
  window.addEventListener('beforeunload', function () {
    try { stopLive(); } catch (_) {}
    try { stopStream(); } catch (_) {}
  });
})();
