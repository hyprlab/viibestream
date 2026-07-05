// Voice talk-back for the live chat — viewers who've joined can speak so
// everyone hears them, and the broadcaster can mute individuals.
//
// Transport mirrors the video: instead of WebRTC, each speaker captures the
// mic, runs voice-activity detection, downsamples to 16 kHz mono PCM and
// emits `talk:frame` over the shared Socket.IO connection. The server fans
// frames to the whole chat room (skipping the sender) and drops frames from
// muted participants. Every page mixes all incoming speakers through one
// Web Audio context, so multiple people can talk at once.
//
// Loaded on both the public viewer and the broadcaster backend. Capture is
// only wired on the viewer side (the host's voice is the broadcast itself);
// playback runs everywhere.
(function () {
  'use strict';

  var socket = window.vbsSocket();

  // The broadcaster page tags its chat panel with data-autojoin — that's the
  // host, whose mic is the stream, so they capture nothing here (playback
  // only). Everyone else is a viewer who may talk once they've joined chat.
  var panel = document.getElementById('chat-panel');
  var IS_HOST = !!(panel && panel.dataset && panel.dataset.autojoin);

  var TARGET_RATE = 16000;            // PCM sample rate we transmit at
  var SPEAK_THRESHOLD = 0.014;        // RMS above which we treat as speech
  var SPEAK_HANGOVER = 9;             // ~0.75s of blocks kept "open" after a peak

  // ── Mixed playback (all pages) ──────────────────────────────────────
  var outCtx = null;
  var masterGain = null;
  var nextStart = {};                 // sid -> scheduled playhead time

  function ensureOutput() {
    if (!outCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        outCtx = new AC();
      } catch (_) { return null; }
      masterGain = outCtx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(outCtx.destination);
    }
    if (outCtx.state === 'suspended') outCtx.resume().catch(function () {});
    return outCtx;
  }

  // Browsers gate audio playback until a user gesture. Resume the output
  // context on the first interaction so incoming voices aren't silently
  // dropped before the viewer has clicked anything.
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (outCtx && outCtx.state === 'suspended') outCtx.resume().catch(function () {});
    }, { passive: true });
  });

  socket.on('talk:frame', function (msg) {
    if (!msg || msg.sid == null || !msg.data) return;
    var ctx = ensureOutput();
    if (!ctx) return;
    // Socket.IO delivers binary as an ArrayBuffer (or a typed-array view).
    var i16;
    if (msg.data instanceof ArrayBuffer) {
      i16 = new Int16Array(msg.data);
    } else if (ArrayBuffer.isView(msg.data)) {
      i16 = new Int16Array(msg.data.buffer, msg.data.byteOffset,
        Math.floor(msg.data.byteLength / 2));
    } else {
      return;
    }
    if (!i16.length) return;
    var f32 = new Float32Array(i16.length);
    for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    var buf = ctx.createBuffer(1, f32.length, TARGET_RATE);
    buf.copyToChannel(f32, 0);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain);
    // Tiny jitter buffer: schedule each speaker's frames back-to-back. If we
    // fall behind (a gap arrived), re-prime ~60 ms ahead of "now".
    var now = ctx.currentTime;
    var t = nextStart[msg.sid] || 0;
    if (t < now + 0.02) t = now + 0.06;
    src.start(t);
    nextStart[msg.sid] = t + buf.duration;
  });

  // ── Capture (viewers only) ──────────────────────────────────────────
  var cap = {
    joined: false,        // joined live chat (can talk)
    muted: false,         // muted by the host — no mic, no unmute
    audioEnabled: true,   // global gate: host can turn off everyone's mics
    on: false,            // mic actively capturing
    speaking: false,      // currently transmitting (VAD open)
    hangover: 0,
    stream: null,
    ctx: null,
    src: null,
    proc: null,
    srcRate: 48000,
  };

  // The local user's own mic control. On the viewer page it's the mic button
  // in the chat composer; on the broadcaster page it's the host's own row in
  // the Participants panel (so the broadcaster sits in the roster like anyone
  // else, with a reactive speaking highlight).
  var btn = document.getElementById(IS_HOST ? 'host-mic-btn' : 'chat-talk-btn');
  var icoMic = btn ? btn.querySelector('.ico-mic') : null;
  var icoMicOff = btn ? btn.querySelector('.ico-mic-off') : null;

  // Host-row pieces (broadcaster page only).
  var hostRow = document.getElementById('host-row');
  var hostNameEl = document.getElementById('host-name');
  var hostEmojiEl = document.getElementById('host-emoji');
  var hostMe = null;   // {name, emoji, …} from the chat identity, once joined

  // Inline mic glyphs for the host row (matches the participant rows'
  // green-live / red-slashed styling in participants.js).
  var MIC_ON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
  var MIC_OFF =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="1" y1="1" x2="23" y2="23"/>' +
    '<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>' +
    '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>' +
    '<line x1="12" y1="19" x2="12" y2="23"/></svg>';

  function setIcon(showOff) {
    if (icoMic) { if (showOff) icoMic.setAttribute('hidden', ''); else icoMic.removeAttribute('hidden'); }
    if (icoMicOff) { if (showOff) icoMicOff.removeAttribute('hidden'); else icoMicOff.setAttribute('hidden', ''); }
  }

  function setSpeaking(active) {
    if (active === cap.speaking) return;
    cap.speaking = active;
    socket.emit('talk:speaking', { speaking: active });
    updateBtn();   // single source of truth for the button's classes
  }

  function onAudio(e) {
    if (!cap.on || cap.muted) return;
    var input = e.inputBuffer.getChannelData(0);
    // Voice-activity detection: RMS of the block, with a hangover so a
    // sentence isn't chopped between syllables.
    var sum = 0;
    for (var i = 0; i < input.length; i++) { var s = input[i]; sum += s * s; }
    var rms = Math.sqrt(sum / input.length);
    if (rms > SPEAK_THRESHOLD) cap.hangover = SPEAK_HANGOVER;
    else if (cap.hangover > 0) cap.hangover--;
    var active = rms > SPEAK_THRESHOLD || cap.hangover > 0;
    setSpeaking(active);
    if (!active) return;
    // Downsample to 16 kHz mono int16 by block-averaging, then ship it. Only
    // sending while speaking keeps the fan-out quiet when no one's talking.
    var ratio = cap.srcRate / TARGET_RATE;
    var outLen = Math.floor(input.length / ratio);
    if (outLen <= 0) return;
    var out = new Int16Array(outLen);
    for (var j = 0; j < outLen; j++) {
      var from = Math.floor(j * ratio);
      var to = Math.floor((j + 1) * ratio);
      var acc = 0, n = 0;
      for (var k = from; k < to && k < input.length; k++) { acc += input[k]; n++; }
      var v = n ? acc / n : 0;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      out[j] = v < 0 ? v * 32768 : v * 32767;
    }
    socket.emit('talk:frame', out.buffer);
  }

  function startCapture() {
    // cap.muted is cleared by the caller (self-unmute) before we get here.
    // The host is exempt from the global audio gate — their voice is an
    // always-on channel they alone control.
    if (cap.on || !cap.joined) return;
    if (!IS_HOST && !cap.audioEnabled) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setBtnState('error', 'Microphone not supported in this browser');
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { setBtnState('error', 'Audio not supported in this browser'); return; }
    // Host mic: AEC/NS/AGC OFF. Echo cancellation re-binds the audio OUTPUT
    // device, which briefly glitches the file's playback (and thus the
    // broadcast); the broadcaster is expected to wear headphones. Viewers,
    // who are on a call-like experience, keep the processing on.
    var audioConstraints = IS_HOST
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    }).then(function (stream) {
      // A late mute (or leave) could have landed while permission was pending.
      if (cap.muted || !cap.joined) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      cap.stream = stream;
      cap.ctx = new AC();
      cap.srcRate = cap.ctx.sampleRate || 48000;
      cap.src = cap.ctx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but universally available and needs no
      // separate worklet module (which would add a CSP/loader wrinkle). Fine
      // for a single mono voice capture.
      cap.proc = cap.ctx.createScriptProcessor(4096, 1, 1);
      cap.proc.onaudioprocess = onAudio;
      cap.src.connect(cap.proc);
      // The processor only fires while connected to a destination; route it
      // through a silenced gain so we don't monitor our own mic locally.
      var sink = cap.ctx.createGain();
      sink.gain.value = 0;
      cap.proc.connect(sink);
      sink.connect(cap.ctx.destination);
      cap.on = true;
      socket.emit('talk:mic', { on: true });   // tell the panel our mic is live
      showHeadphonesTip();                      // one-time nudge on first unmute
      updateBtn();
    }).catch(function () {
      setBtnState('error', 'Microphone blocked — allow access to talk');
    });
  }

  function stopCapture() {
    var was = cap.on;
    if (cap.proc) { try { cap.proc.disconnect(); } catch (_) {} cap.proc.onaudioprocess = null; }
    if (cap.src) { try { cap.src.disconnect(); } catch (_) {} }
    if (cap.stream) cap.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    if (cap.ctx) { try { cap.ctx.close(); } catch (_) {} }
    cap.proc = cap.src = cap.stream = cap.ctx = null;
    if (cap.on || cap.speaking) setSpeaking(false);
    cap.on = false;
    cap.hangover = 0;
    if (was) socket.emit('talk:mic', { on: false });   // panel goes red/slashed
    updateBtn();
  }

  // ── One-time headphones tip ─────────────────────────────────────────
  // Drops down the first time the viewer goes live this session — same quip
  // as the access-code page. sessionStorage keeps it to once per tab session.
  var hintBar = document.getElementById('voice-hint');
  var hintClose = document.getElementById('voice-hint-close');
  var HINT_KEY = 'vbs-voice-headphones-tip';
  var hintTimer = null;
  function hideHeadphonesTip() {
    if (hintBar) hintBar.classList.remove('is-visible');
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  }
  function showHeadphonesTip() {
    if (!hintBar) return;
    try { if (window.sessionStorage.getItem(HINT_KEY)) return; } catch (_) {}
    try { window.sessionStorage.setItem(HINT_KEY, '1'); } catch (_) {}
    hintBar.classList.add('is-visible');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHeadphonesTip, 8000);
  }
  if (hintClose) hintClose.addEventListener('click', hideHeadphonesTip);

  // ── Talk button (viewer) ────────────────────────────────────────────
  function setBtnState(_kind, title) {
    if (btn && title) btn.title = title;
  }

  // The host's own row in the Participants panel. Green live mic when their
  // mic is on, red slashed when off, and the row glows while they speak —
  // mirroring how a participant's row reacts. Hidden until they've joined
  // chat (which the broadcaster page does automatically).
  function updateHostRow() {
    if (!btn || !hostRow) return;
    if (!cap.joined) { hostRow.setAttribute('hidden', ''); return; }
    hostRow.removeAttribute('hidden');
    if (hostMe) {
      if (hostNameEl && hostMe.name) hostNameEl.textContent = hostMe.name;
      if (hostEmojiEl && hostMe.emoji) hostEmojiEl.textContent = hostMe.emoji;
    }
    var on = cap.on;
    btn.innerHTML = on ? MIC_ON : MIC_OFF;
    btn.classList.toggle('is-live', on);
    btn.classList.toggle('is-muted', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? "You're live — click to turn your mic off"
      : 'Turn your mic on so viewers and participants can hear you';
    btn.setAttribute('aria-label', btn.title);
    hostRow.classList.toggle('is-speaking', on && cap.speaking);
  }

  function updateBtn() {
    if (IS_HOST) { updateHostRow(); return; }
    if (!btn) return;
    // Hidden entirely until the viewer joins the chat (no name = no voice).
    if (!cap.joined) {
      btn.setAttribute('hidden', '');
      return;
    }
    btn.removeAttribute('hidden');
    // The button is the viewer's OWN mic control — always theirs to toggle
    // while participant audio is on:
    //   • green NORMAL mic → mic is on (live)
    //   • red SLASHED mic  → mic is off (click to turn on) — also how a host
    //                        mute looks; they can still click to come back on
    //   • grey SLASHED mic → participant audio is off for everyone — the only
    //                        state where the viewer can't unmute (unclickable)
    var globalOff = !cap.audioEnabled;
    var active = cap.on && !globalOff;     // their mic is actually capturing
    btn.classList.toggle('is-live', active);
    btn.classList.toggle('is-muted', !globalOff && !active);   // red slash, still clickable
    btn.classList.toggle('is-disabled', globalOff);            // grey, the only hard lock
    btn.classList.toggle('is-speaking', active && cap.speaking);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.disabled = globalOff;
    setIcon(!active);   // normal mic only while live; slashed otherwise
    if (globalOff) btn.title = 'The host has turned off participant audio';
    else if (active) btn.title = "You're live — click to turn your mic off";
    else if (cap.muted) btn.title = 'The host muted you — click to turn your mic back on';
    else btn.title = 'Click to turn your mic on so everyone can hear you';
  }

  if (btn && !IS_HOST) {
    btn.addEventListener('click', function () {
      // The viewer controls their own mic at will; only a global audio-off
      // (or not being joined) blocks them.
      if (!cap.joined || !cap.audioEnabled) return;
      if (cap.on) {
        stopCapture();                       // turn my mic off
      } else {
        if (cap.muted) {
          // Clear a host mute by unmuting myself — my mic is mine.
          cap.muted = false;
          socket.emit('talk:self_unmute');
        }
        startCapture();                      // turn my mic on
      }
    });
  }

  if (btn && IS_HOST) {
    // The broadcaster's mic toggle — always theirs, independent of the file
    // stream or the participant-audio gate.
    btn.addEventListener('click', function () {
      if (!cap.joined) return;
      if (cap.on) stopCapture();
      else startCapture();
    });
  }

  // Pick up the global participant-audio gate from the chat snapshot on
  // join / read-only watch, then keep it in sync on live toggles.
  function applyAudioSnapshot(info) {
    if (info && info.state && typeof info.state.audio_enabled === 'boolean') {
      cap.audioEnabled = info.state.audio_enabled;
      // The host's own mic isn't governed by the participant-audio gate.
      if (!IS_HOST && !cap.audioEnabled && cap.on) stopCapture();
      updateBtn();
    }
  }
  socket.on('chat:joined', applyAudioSnapshot);
  socket.on('chat:watching', applyAudioSnapshot);
  socket.on('talk:audio_state', function (info) {
    if (!info || typeof info.enabled !== 'boolean') return;
    cap.audioEnabled = info.enabled;
    if (!IS_HOST && !cap.audioEnabled && cap.on) stopCapture();
    updateBtn();
  });

  // chat.js publishes our chat identity on join/leave/rename. Gate talk on
  // being joined, and pick up our muted flag from the roster snapshot.
  document.addEventListener('vbs:chat-identity', function (e) {
    var detail = e.detail || {};
    var wasJoined = cap.joined;
    cap.joined = !!detail.joined;
    if (detail.me) hostMe = detail.me;   // name/emoji for the host row
    if (detail.me && typeof detail.me.muted === 'boolean') cap.muted = detail.me.muted;
    if (!cap.joined) {
      if (wasJoined) stopCapture();
      cap.muted = false;
    }
    updateBtn();
  });

  // The host (un)muted someone. If it's us, stop capturing immediately and
  // lock the button — there is no viewer-side unmute.
  socket.on('talk:muted', function (info) {
    if (IS_HOST) return;                 // the host can't be muted
    if (!info || info.sid == null) return;
    if (info.sid !== socket.id) return;
    cap.muted = !!info.muted;
    if (cap.muted) stopCapture();
    updateBtn();
  });

  // Host muted/unmuted everyone at once.
  socket.on('talk:mute_all', function (info) {
    if (IS_HOST) return;                 // "mute all" never silences the host
    if (!info || typeof info.muted !== 'boolean') return;
    cap.muted = info.muted;
    if (cap.muted && cap.on) stopCapture();
    updateBtn();
  });

  // ── Unmute consent ──────────────────────────────────────────────────
  // The host can mute us at will but can NEVER unmute us — they can only
  // ask. We get the final say here. (The modal markup lives on the viewer
  // page; on the broadcaster page these elements don't exist.)
  var UNMUTE_MODAL = 'unmute-request-modal';
  var unmuteAccept = document.getElementById('unmute-accept-btn');
  var unmuteDecline = document.getElementById('unmute-decline-btn');
  socket.on('talk:unmute_request', function () {
    if (IS_HOST) return;                 // the host never receives an ask
    // The broadcaster is inviting us to turn our mic on. Show the prompt if
    // we're not already live and audio is on — covers both a host mute and a
    // mic we simply haven't switched on yet.
    if (cap.on || !cap.audioEnabled) return;
    if (window.VBSModal) window.VBSModal.open(UNMUTE_MODAL);
  });
  if (unmuteAccept) {
    unmuteAccept.addEventListener('click', function () {
      cap.muted = false;                    // optimistic; server confirms via talk:muted
      socket.emit('talk:unmute_accept');    // server lifts the mute
      if (window.VBSModal) window.VBSModal.close(UNMUTE_MODAL);
      // Accepting means "yes, turn my mic on" — actually go live so the
      // button shows green, not the red/slashed mic-off state.
      startCapture();
    });
  }
  if (unmuteDecline) {
    unmuteDecline.addEventListener('click', function () {
      socket.emit('talk:unmute_decline');
      if (window.VBSModal) window.VBSModal.close(UNMUTE_MODAL);
    });
  }

  // Dropping the socket ends any in-flight capture; chat.js re-publishes
  // identity on reconnect, which re-enables the button.
  socket.on('disconnect', function () {
    if (cap.on) stopCapture();
  });

  updateBtn();
})();
