// Viewer: subscribe to stream:chunk events, feed into MediaSource.
//
// MediaSource Extensions (MSE) need the first chunk to contain the
// container's init segment (WebM: EBML + Tracks; fMP4: ftyp + moov).
// The server caches it per broadcast so late-joiners get one delivered
// as part of `viewer:join`. From then on, we append every chunk to the
// SourceBuffer.
//
// Safari/WebKit: iPhones expose ManagedMediaSource (iOS 17.1+) instead
// of MediaSource, and no WebKit browser accepts WebM in MSE — only
// fragmented MP4 (H.264/AAC), which the broadcaster prefers when its
// MediaRecorder can produce it. When the active broadcast is a format
// this browser truly can't play (a WebM stream viewed from Safari), we
// say so in the warning banner instead of failing silently.
(function () {
  'use strict';

  // MediaSource everywhere, ManagedMediaSource on iPhone (iOS 17.1+).
  var MS = window.MediaSource || window.ManagedMediaSource || null;
  var usingManagedMSE = !window.MediaSource && !!window.ManagedMediaSource;

  // One shared connection across chat/stream/info so server handlers that
  // key off request.sid (e.g. video-reaction identity) see a single sid.
  // See static/js/socket.js for why a plain io() per module breaks this.
  var socket = window.vbsSocket();

  var els = {
    wsStatus:      document.getElementById('ws-status'),
    player:        document.getElementById('player'),
    offlineOL:     document.getElementById('offline-overlay'),
    pausedOL:      document.getElementById('paused-overlay'),
    syncChip:      document.getElementById('sync-chip'),
    latencySep:    document.getElementById('latency-sep'),
    latencyChip:   document.getElementById('latency-chip'),
    latencyValue:  document.getElementById('latency-value'),
    unmuteBtn:     document.getElementById('unmute-btn'),
    muteBtn:       document.getElementById('mute-btn'),
    volumeIn:      document.getElementById('volume'),
    liveDot:       document.getElementById('live-dot'),
    liveLabel:     document.getElementById('live-label'),
    viewerCount:   document.getElementById('viewer-count'),
    fullscreenBtn: document.getElementById('fullscreen-btn'),
    reactionControl: document.getElementById('reaction-control'),
    reactionBtn:   document.getElementById('reaction-btn'),
    reactionPalette: document.getElementById('reaction-palette'),
    reactionLayer: document.getElementById('video-reactions'),
    reactionSender: document.getElementById('reaction-sender'),
    alertBanner:   document.getElementById('video-alert'),
    alertText:     document.getElementById('video-alert-text'),
    playerStage:   document.querySelector('.player-stage'),
    qualityChip:   document.getElementById('quality-chip'),
    qualityQ:     document.getElementById('quality-chip-q'),
    qualityBr:    document.getElementById('quality-chip-br'),
    lockScreen:   document.getElementById('lock-screen'),
    lockForm:     document.getElementById('lock-form'),
    lockInput:    document.getElementById('lock-input'),
    lockError:    document.getElementById('lock-error'),
  };

  var state = {
    mediaSource: null,
    sourceBuffer: null,
    queue: [],
    mime: null,
    streamLive: false,
    mediaUrl: null,
    didInitialSeek: false,
    lastSnap: null,   // most recent stream:state for chip-refresh fallback
    chatPinned: true,          // fullscreen overlay chat pinned (vs. auto-hide)
    chatMuted: false,          // suppress the @mention chat pop-in
  };

  // ── Status / overlay helpers ─────────────────────────────────────────
  function setStatus(s, label) {
    els.wsStatus.dataset.state = s;
    els.wsStatus.textContent = label;
  }
  function setLive(live) {
    state.streamLive = live;
    els.liveDot.classList.toggle('is-live', live);
    els.liveLabel.textContent = live ? 'Live' : 'Offline';
    els.offlineOL.hidden = live;
    // The offline overlay takes precedence over the paused one, so drop
    // the paused overlay whenever we're not live.
    if (!live) {
      els.qualityChip.hidden = true;
      setPaused(false);
      // Tear down the live-sync UI and reset any catch-up speed so the
      // next broadcast starts clean.
      if (els.latencyChip) els.latencyChip.hidden = true;
      if (els.latencySep) els.latencySep.hidden = true;
      setSyncing(false);
      if (els.player) els.player.playbackRate = 1;
    }
  }

  // Show/hide the "Paused" overlay. Only meaningful while live — when the
  // stream is offline the OFF AIR overlay is shown instead.
  //
  // The moment the broadcaster pauses we BLANK the video so the frozen last
  // frame doesn't linger behind the Paused message. We deliberately do NOT
  // touch the player's volume: voice chat runs on the always-on talk
  // channel, and the paused file's audio stops on its own as its buffered
  // tail drains — so muting here would only cut a conversation short.
  function setPaused(paused) {
    if (!els.pausedOL) return;
    var show = !!(paused && state.streamLive);
    els.pausedOL.hidden = !show;
    if (!els.player) return;
    els.player.classList.toggle('is-blanked', show);
  }

  // Map a frame size to a standard quality class by its LARGER dimension,
  // so a widescreen movie (e.g. 1920×818) reads as "1080p" — the 1920-wide
  // horizontal resolution defines the class, not the letterboxed height.
  function qualityFromDims(w, h) {
    var d = Math.max(w || 0, h || 0);
    if (!d) return '';
    if (d >= 3000) return '4K';
    if (d >= 2200) return '1440p';
    if (d >= 1700) return '1080p';
    if (d >= 1100) return '720p';
    if (d >=  760) return '480p';
    if (d >=  560) return '360p';
    return d + 'p';
  }

  function formatBitrate(bps) {
    if (!bps) return null;
    var kbps = Math.round(bps / 1000);
    if (kbps >= 1000) return (kbps / 1000).toFixed(kbps % 1000 ? 1 : 0) + ' Mbps';
    return kbps + ' kbps';
  }

  function updateQualityChip(snap) {
    if (!snap || !snap.live) {
      els.qualityChip.hidden = true;
      return;
    }
    // Resolution: trust what we're ACTUALLY decoding — the player's
    // intrinsic size is the ground truth for what's being broadcast.
    // Only fall back to the broadcaster-reported size before the first
    // frame has decoded. (Frame rate + bitrate still come from the
    // broadcaster, since the player can't know those.)
    var w    = els.player.videoWidth  || snap.width  || 0;
    var h    = els.player.videoHeight || snap.height || 0;
    var br   = snap.bitrate || 0;
    // Derive the quality label from the resolution we're actually
    // showing so it can never contradict it.
    var q    = qualityFromDims(w, h) || snap.quality;
    if (!w && !h) {
      els.qualityChip.hidden = true;
      return;
    }
    var brTxt = formatBitrate(br);
    els.qualityQ.textContent   = q || '—';
    els.qualityBr.textContent  = brTxt || '— Mbps';
    els.qualityChip.title =
      'Quality: ' + (q || 'unknown') +
      (brTxt ? ' · Bitrate: ' + brTxt : '');
    els.qualityChip.hidden = false;
  }

  // The first frame (and any later resolution change) arrives after the
  // stream:state that drew the chip, so refresh it once the player knows
  // its real dimensions — that's what fixes a stale/wrong quality label.
  ['loadedmetadata', 'resize'].forEach(function (ev) {
    els.player.addEventListener(ev, function () {
      if (state.lastSnap) updateQualityChip(state.lastSnap);
    });
  });

  function resetMSE() {
    try {
      if (state.mediaSource && state.mediaSource.readyState === 'open') {
        state.mediaSource.endOfStream();
      }
    } catch (_) {}
    if (state.mediaUrl) {
      try { URL.revokeObjectURL(state.mediaUrl); } catch (_) {}
    }
    state.mediaSource = null;
    state.sourceBuffer = null;
    state.queue = [];
    state.mime = null;
    state.mediaUrl = null;
    state.didInitialSeek = false;
    els.player.removeAttribute('src');
    try { els.player.load(); } catch (_) {}
  }

  // The mime the server relays is what the broadcaster REQUESTED, which
  // may lack a codecs= parameter (e.g. plain "video/mp4" from an older
  // Safari broadcaster). MSE's isTypeSupported usually wants codecs, so
  // fall back to the common codec pairs for the container.
  function mimeCandidates(mime) {
    var list = [];
    if (mime) list.push(mime);
    if (mime && mime.indexOf('codecs') === -1) {
      var bare = mime.split(';')[0];
      if (bare.indexOf('mp4') !== -1) {
        list.push(bare + ';codecs=avc1.42E01E,mp4a.40.2');
      } else {
        list.push(bare + ';codecs=vp9,opus');
        list.push(bare + ';codecs=vp8,opus');
      }
    }
    return list;
  }

  function playableMime(mime) {
    if (!MS || typeof MS.isTypeSupported !== 'function') return null;
    var candidates = mimeCandidates(mime);
    for (var i = 0; i < candidates.length; i++) {
      if (MS.isTypeSupported(candidates[i])) return candidates[i];
    }
    return null;
  }

  // Tell the server whether this browser can actually play the current
  // broadcast — the broadcaster page shows a "N viewers can't play this"
  // chip fed by these reports (real data, not codec guesswork). Only
  // emit when the verdict changes so reconnect/re-init churn stays quiet.
  var lastPlaybackReport = null;
  function reportPlayback(ok) {
    if (lastPlaybackReport === ok) return;
    lastPlaybackReport = ok;
    if (socket.connected) socket.emit('viewer:playback', { ok: ok });
  }

  function initMSE(mime) {
    var usable = playableMime(mime);
    if (!usable) {
      console.warn('MediaSource cannot play mime:', mime);
      showFormatWarning(mime);
      reportPlayback(false);
      return false;
    }
    hideFormatWarning();
    resetMSE();
    state.mime = usable;
    state.mediaSource = new MS();
    // ManagedMediaSource refuses to open unless remote playback (AirPlay)
    // is explicitly disabled on the media element.
    if (usingManagedMSE) els.player.disableRemotePlayback = true;
    state.mediaUrl = URL.createObjectURL(state.mediaSource);
    els.player.src = state.mediaUrl;

    state.mediaSource.addEventListener('sourceopen', function () {
      try {
        state.sourceBuffer = state.mediaSource.addSourceBuffer(state.mime);
      } catch (err) {
        console.error('addSourceBuffer failed:', err);
        reportPlayback(false);
        return;
      }
      reportPlayback(true);
      // Sequence mode keeps WebM cluster appends gapless. For fMP4 we
      // leave the default 'segments' mode: fragment timestamps are
      // authoritative, and WebKit's sequence-mode handling of fMP4 is
      // unreliable.
      if (state.mime.indexOf('mp4') === -1) {
        state.sourceBuffer.mode = 'sequence';
      }
      state.sourceBuffer.addEventListener('updateend', drainQueue);
      drainQueue();
    });
    return true;
  }

  // ── Unsupported-format messaging ─────────────────────────────────────
  // Reuses the #browser-warning banner (see browser-warning.js) with a
  // message specific to the active broadcast, shown even if the generic
  // banner was previously dismissed — this one means "no video for you",
  // not "video may stutter".
  function showFormatWarning(mime) {
    var banner = document.getElementById('browser-warning');
    if (!banner) return;
    var text = banner.querySelector('.browser-warning-text');
    if (text) {
      text.textContent = (mime && mime.indexOf('webm') !== -1)
        ? 'This browser can’t play the current broadcast (WebM). ' +
          'Watch in Chrome, Edge, or Firefox — or ask the host to ' +
          'broadcast from Chrome or Safari so Apple devices can tune in.'
        : 'This browser can’t play the current broadcast’s ' +
          'video format. Try updating it, or watch in Chrome or Firefox.';
    }
    banner.hidden = false;
    document.body.classList.add('has-browser-warning');
  }
  function hideFormatWarning() {
    var banner = document.getElementById('browser-warning');
    if (!banner || banner.hidden) return;
    banner.hidden = true;
    document.body.classList.remove('has-browser-warning');
  }

  function drainQueue() {
    if (!state.sourceBuffer || state.sourceBuffer.updating) return;
    if (!state.queue.length) return;
    try {
      var chunk = state.queue.shift();
      state.sourceBuffer.appendBuffer(chunk);
      // Trim the buffered range to keep memory bounded — anything older
      // than 30s before the current playhead can go.
      var buf = state.sourceBuffer.buffered;
      if (buf.length && els.player.currentTime > 30) {
        var removeEnd = els.player.currentTime - 30;
        if (removeEnd > buf.start(0)) {
          try { state.sourceBuffer.remove(buf.start(0), removeEnd); } catch (_) {}
        }
      }
      // First time we get a buffered range, snap the playhead to it so
      // late-joiners start playing the cached cluster rather than sitting
      // at currentTime=0 with nothing to render. Also fire the one-shot
      // autoplay attempt — if the browser rejects it with NotAllowedError
      // we'll surface the "Click for sound" badge. After this single
      // call we never auto-call play() again, so manual pause sticks.
      if (!state.didInitialSeek && buf.length) {
        try {
          els.player.currentTime = buf.start(0);
          state.didInitialSeek = true;
          tryAutoplay();
        } catch (_) {}
      }
    } catch (err) {
      console.error('appendBuffer failed:', err);
      // Probably a decode error — drop the queue and reinitialize on next chunk.
      state.queue = [];
    }
  }

  function pushChunk(buf) {
    if (!state.sourceBuffer) {
      state.queue.push(buf);
      return;
    }
    state.queue.push(buf);
    drainQueue();
  }

  // ── Keep every viewer near the live edge (watch-party sync) ────────────
  // This is a shared live experience — viewers chat about the video as it
  // plays, so they should all be watching roughly the same moment. Every
  // viewer receives the same broadcaster chunks, so `buffered.end` (the
  // live edge) is the SAME content position for everyone. If they all aim
  // to sit a small, fixed distance behind that edge, they converge to the
  // same spot — regardless of when they joined or how much they stalled.
  //
  // MSE plays at 1x and never catches up on its own, so a viewer that hits
  // a few buffering stalls — or backgrounds the tab — drifts behind and
  // stays there (that's why a paused stream could show the Paused overlay
  // while a minute of buffered video kept playing underneath). We close the
  // gap continuously: a gentle speed-up for small drift, a hard seek for
  // large drift. A viewer who has manually paused is left alone.
  var LIVE_SYNC = {
    target: 3,     // everyone aims to sit ~3s behind live (cushion vs. stalls)
    nudge:  1,     // trailing target by more → play slightly faster to catch up
    seek:   3,     // trailing target by more → jump straight to the live edge
    rate:   1.1,   // catch-up playback rate (pitch is preserved by the browser)
  };

  // Chunk cadence varies wildly by broadcaster: WebM and Safari-fMP4
  // recorders honor the 250ms timeslice, but Chrome's fMP4 muxer only
  // emits a chunk per keyframe (~every 6-7s). A fixed 3s cushion would
  // starve between such bursts (play 3s, stall 4s, hard-seek, repeat),
  // so the cushion adapts: a bit more than the largest recent
  // inter-chunk gap, never below the 3s floor. Everyone still converges
  // to the same distance behind the live edge, so the watch-party sync
  // property is preserved — just with a cadence-appropriate cushion.
  var chunkGaps = [];       // last few inter-chunk arrival gaps, seconds
  var lastChunkAt = 0;      // performance.now() of the previous chunk
  function noteChunkArrival() {
    var now = performance.now();
    if (lastChunkAt) {
      var gap = (now - lastChunkAt) / 1000;
      // A pause / network hiccup shouldn't permanently inflate the
      // cushion — gaps that large aren't a cadence.
      if (gap <= 20) {
        chunkGaps.push(gap);
        if (chunkGaps.length > 6) chunkGaps.shift();
      }
    }
    lastChunkAt = now;
  }
  function resetChunkCadence() {
    chunkGaps = [];
    lastChunkAt = 0;
  }
  function syncTarget() {
    var gapMax = 0;
    for (var i = 0; i < chunkGaps.length; i++) {
      if (chunkGaps[i] > gapMax) gapMax = chunkGaps[i];
    }
    return Math.max(LIVE_SYNC.target, Math.min(15, gapMax + 2.5));
  }

  function syncToLive() {
    var sb = state.sourceBuffer, v = els.player;
    // A paused-but-live player is always a stall, never a choice — this
    // page has no pause control. WebKit pauses the element on SourceBuffer
    // underrun and won't resume when data arrives, and iOS pauses on tab
    // background; nudge playback back to life in both cases. (tryAutoplay
    // falls back to muted playback if the browser blocks unmuted play.)
    if (v && v.paused && state.streamLive && !v.ended && sb) tryAutoplay();
    // Don't fight a seek in progress, or an offline player with nothing
    // buffered. Clear the syncing pill while paused so it doesn't linger.
    if (v && v.paused) setSyncing(false);
    if (!sb || !v || v.paused || v.seeking || !state.streamLive) return;
    var buf;
    try { buf = sb.buffered; } catch (_) { return; }
    if (!buf.length) return;
    var liveEdge = buf.end(buf.length - 1);
    var drift = liveEdge - v.currentTime;
    var target = syncTarget();
    var seeked = false;
    if (drift > target + LIVE_SYNC.seek) {
      // Way behind (e.g. tab was backgrounded) — snap to the live edge.
      try { v.currentTime = Math.max(buf.start(0), liveEdge - target); } catch (_) {}
      if (v.playbackRate !== 1) v.playbackRate = 1;
      seeked = true;
    } else if (drift > target + LIVE_SYNC.nudge) {
      if (v.playbackRate === 1) v.playbackRate = LIVE_SYNC.rate;
    } else if (drift <= target) {
      if (v.playbackRate !== 1) v.playbackRate = 1;   // close enough — normal speed
    }
    updateLatency(drift);
    // "Syncing" = actively closing the gap: a hard seek this tick, or
    // still running fast to catch up.
    setSyncing(seeked || v.playbackRate > 1);
  }

  // Show how far behind the live edge we are, in the meta row.
  function updateLatency(drift) {
    if (!els.latencyChip) return;
    els.latencyValue.textContent = Math.max(0, drift).toFixed(1) + 's';
    els.latencyChip.hidden = false;
    els.latencySep.hidden = false;
  }
  // The control-bar "Syncing" pill only reflects live-sync catch-up; it
  // appears while we're closing the gap to the live edge and hides when done.
  function setSyncing(on) {
    if (!els.syncChip) return;
    els.syncChip.hidden = !on;
  }
  setInterval(syncToLive, 2000);
  // Returning to a backgrounded tab is the worst drift case — correct it
  // immediately instead of waiting for the next interval tick.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) syncToLive();
  });

  // ── Socket.IO ────────────────────────────────────────────────────────
  socket.on('connect', function () {
    setStatus('connected', 'Connected');
    rememberedTried = false;   // allow one silent auto-auth per connection
    lastPlaybackReport = null; // fresh sid server-side — re-report if needed
    socket.emit('viewer:join');
  });
  // When the socket drops or can't be established, say so on the lock
  // screen too — otherwise a viewer staring at the code box has no idea
  // why nothing happens. Cleared automatically on the next stream:locked
  // (reconnect) or when the screen lifts via auth_ok/unlocked.
  function noteLockConnectionIssue(text) {
    if (els.lockScreen && !els.lockScreen.hasAttribute('hidden')) {
      setHidden(els.lockError, false);
      els.lockError.textContent = text;
    }
  }
  socket.on('disconnect', function () {
    setStatus('error', 'Disconnected');
    noteLockConnectionIssue('Connection lost — reconnecting…');
  });
  socket.on('connect_error', function () {
    setStatus('error', 'Connect error');
    noteLockConnectionIssue("Can't reach the server — retrying…");
  });

  socket.on('stream:state', function (snap) {
    if (!snap) return;
    state.lastSnap = snap;
    setLive(!!snap.live);
    setPaused(!!snap.paused);   // late joiners see the overlay if paused
    if (typeof snap.viewers === 'number')
      els.viewerCount.textContent = String(snap.viewers);
    if (snap.live) setStatus('live', 'Live');
    else if (socket.connected) setStatus('connected', 'Waiting for broadcast');
    updateQualityChip(snap);
    setReactionsEnabled(snap.reactions_enabled !== false);
    setAlert(snap.alert || '');
    // A showtime set/cleared mid-curtain arrives via this snapshot.
    updateCurtainCountdown();
    // We intentionally do NOT auto-hide the lock screen here based on
    // snap.lock_enabled. The lock screen ships visible on initial
    // render and stays until the server explicitly says "you're in"
    // via stream:auth_ok or stream:unlocked. That makes the lock
    // assertive even when no broadcast is active.
  });

  // Live updates as other viewers join or leave. The server fans this
  // out to every viewer (and the broadcaster) on each membership
  // change so we don't have to wait for the next stream:state snapshot.
  socket.on('stream:viewers', function (info) {
    if (info && typeof info.count === 'number') {
      els.viewerCount.textContent = String(info.count);
    }
  });

  socket.on('stream:paused', function (info) {
    setPaused(!!(info && info.paused));
    // Don't let the paused silence read as a slow chunk cadence.
    resetChunkCadence();
  });

  socket.on('stream:init', function (info) {
    if (!info || !info.mime) return;
    resetChunkCadence();
    initMSE(info.mime);
  });

  socket.on('stream:chunk', function (data) {
    // socket.io binary delivery: data is ArrayBuffer in modern clients.
    var buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    noteChunkArrival();
    if (!state.sourceBuffer && !state.mediaSource) {
      // Late-joiner case: init segment arrives before stream:init. The
      // last stream:state snapshot knows the broadcast mime; fall back
      // to WebM only if we truly have nothing to go on.
      var fallback = state.mime ||
        (state.lastSnap && state.lastSnap.mime_type) ||
        'video/webm;codecs=vp8,opus';
      if (!initMSE(fallback)) return;
    }
    pushChunk(buf);
    // NOTE: do NOT call tryAutoplay() here. The <video autoplay> attribute
    // handles initial playback, and the browser resumes from buffer
    // underruns on its own. Calling play() on every chunk fights the
    // user — clicking pause would be undone 250 ms later by the next
    // chunk's tryAutoplay. The initial play attempt is fired once from
    // drainQueue() when the first decodable buffer lands.
  });

  socket.on('stream:ended', function () {
    setLive(false);
    setStatus('connected', 'Stream ended');
    hideFormatWarning();   // any can't-play-this-broadcast notice is stale now
    setTimeout(resetMSE, 250);
  });

  // ── Access lock ──────────────────────────────────────────────────────
  // Remember the last code the viewer successfully entered so reconnects
  // (and backend restarts) don't re-prompt them. We only show the code
  // box when there's no remembered code, or when the remembered one is
  // rejected — i.e. when the broadcaster actually changed it.
  var LS_VIEWER_CODE = 'vbs-viewer-code';
  var pendingCode = null;        // code we just emitted, pending a reply
  var autoAuthInFlight = false;  // that emit was an automatic retry
  var rememberedTried = false;   // already auto-tried on this connection?

  function readRememberedCode() {
    try {
      var c = (localStorage.getItem(LS_VIEWER_CODE) || '')
        .toUpperCase().replace(/[^A-Z0-9]/g, '');
      return c.length === 5 ? c : '';
    } catch (_) { return ''; }
  }
  function rememberCode(code) {
    try { localStorage.setItem(LS_VIEWER_CODE, code); } catch (_) {}
  }
  function forgetCode() {
    try { localStorage.removeItem(LS_VIEWER_CODE); } catch (_) {}
  }

  function setLockScreen(visible, errorText) {
    if (visible) {
      setHidden(els.lockError, !errorText);
      if (errorText) els.lockError.textContent = errorText;
      els.lockScreen.removeAttribute('hidden');
      // Hide the rest of the page so nothing leaks through the overlay.
      // CSS .locked rule pulls header / main / footer out of the layout.
      document.body.classList.add('locked');
      setStatus('connected', 'Connected');
      setTimeout(function () {
        if (els.lockInput) els.lockInput.focus();
      }, 30);
    } else {
      els.lockScreen.setAttribute('hidden', '');
      document.body.classList.remove('locked');
      setHidden(els.lockError, true);
    }
  }

  function submitCode() {
    var code = (els.lockInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) {
      setHidden(els.lockError, false);
      els.lockError.textContent = 'Enter all 5 characters.';
      return;
    }
    // If the realtime socket isn't connected, emitting would silently go
    // nowhere — no auth_ok / auth_fail ever comes back and the screen just
    // sits there. Tell the viewer instead of failing invisibly.
    if (!socket.connected) {
      setHidden(els.lockError, false);
      els.lockError.textContent =
        "Can't reach the server — check your connection and try again.";
      return;
    }
    setHidden(els.lockError, true);
    pendingCode = code;
    autoAuthInFlight = false;
    socket.emit('viewer:auth', { code: code });
  }

  els.lockForm.addEventListener('submit', function (e) {
    e.preventDefault();
    submitCode();
  });
  // Force uppercase + alphanumeric as the user types.
  els.lockInput.addEventListener('input', function () {
    var caret = els.lockInput.selectionStart;
    var clean = (els.lockInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (clean !== els.lockInput.value) {
      els.lockInput.value = clean;
      try { els.lockInput.setSelectionRange(caret, caret); } catch (_) {}
    }
    setHidden(els.lockError, true);
  });

  // ── Curtain ──────────────────────────────────────────────────────────
  // Closed = the broadcaster has shut the doors entirely: the lock screen
  // shows (with the Now Showing card when one is set) but the code form
  // is hidden — there's nothing to enter. Reopening is followed by the
  // server routing us through the normal door (stream:locked /
  // stream:auth_ok), which drives what the screen does next.
  var lockTitleEl = document.querySelector('.lock-title');
  var lockSubEl = document.querySelector('.lock-sub');
  var LOCK_TITLE_DEFAULT = lockTitleEl ? lockTitleEl.textContent : '';
  var LOCK_SUB_DEFAULT = lockSubEl ? lockSubEl.textContent : '';

  function setCurtainScreen(closed) {
    if (!els.lockScreen) return;
    els.lockScreen.classList.toggle('is-curtain', closed);
    if (closed) {
      if (lockTitleEl) lockTitleEl.textContent = 'Doors are closed';
      if (lockSubEl) {
        lockSubEl.textContent =
          'Check back soon — the show will open right here.';
      }
      clearLockoutCountdown();
      setLockScreen(true);
    } else {
      if (lockTitleEl) lockTitleEl.textContent = LOCK_TITLE_DEFAULT;
      if (lockSubEl) lockSubEl.textContent = LOCK_SUB_DEFAULT;
      // Don't lift the screen here — the server's follow-up
      // (stream:locked or stream:auth_ok) decides what happens next.
    }
    updateCurtainCountdown();
  }

  // Showtime countdown on the curtain screen. The target (UTC epoch
  // seconds) rides in stream:state snapshots as `curtain_eta`; we tick
  // locally against the client clock once visible.
  var countdownWrap = document.getElementById('lock-countdown');
  var countdownTime = document.getElementById('lock-countdown-time');
  var countdownTick = null;

  function fmtCountdown(rem) {
    var d = Math.floor(rem / 86400);
    var h = Math.floor((rem % 86400) / 3600);
    var m = Math.floor((rem % 3600) / 60);
    var s = rem % 60;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    if (d > 0) return d + 'd ' + h + 'h ' + pad(m) + 'm';
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return m + ':' + pad(s);
  }
  function updateCurtainCountdown() {
    if (!countdownWrap) return;
    var eta = state.lastSnap && state.lastSnap.curtain_eta;
    var show = els.lockScreen &&
               els.lockScreen.classList.contains('is-curtain') && !!eta;
    setHidden(countdownWrap, !show);
    // With a countdown on screen, the "check back soon" sub-line is
    // redundant — the timer says it better (CSS hides .lock-sub).
    if (els.lockScreen) els.lockScreen.classList.toggle('has-countdown', show);
    if (!show) {
      if (countdownTick) { clearInterval(countdownTick); countdownTick = null; }
      return;
    }
    var rem = Math.floor(eta - Date.now() / 1000);
    if (rem <= 0) {
      countdownTime.textContent = 'Any moment now…';
      countdownWrap.classList.add('is-imminent');
    } else {
      countdownTime.textContent = fmtCountdown(rem);
      countdownWrap.classList.remove('is-imminent');
    }
    if (!countdownTick) countdownTick = setInterval(updateCurtainCountdown, 1000);
  }

  socket.on('stream:curtain', function (info) {
    var closed = !!(info && info.closed);
    if (closed) {
      // Drop any buffered video so nothing plays behind the curtain.
      // (viewer:auth is server-blocked while closed, so a remembered
      // code can't sneak in; after reopening, the server's stream:locked
      // still lets it retry silently.)
      resetMSE();
    }
    setCurtainScreen(closed);
  });

  socket.on('stream:locked', function () {
    // Server is gating chunks until we provide the right code. Throw
    // away anything we'd already buffered so we don't keep playing
    // stale frames behind the lock screen.
    setCurtainScreen(false);   // the code prompt supersedes any curtain view
    resetMSE();
    // If we have a remembered code, try it silently once before showing
    // the prompt — so an unchanged code never makes the viewer re-type
    // it after a reconnect/backend restart.
    var remembered = readRememberedCode();
    if (remembered && !rememberedTried && socket.connected) {
      rememberedTried = true;
      pendingCode = remembered;
      autoAuthInFlight = true;
      socket.emit('viewer:auth', { code: remembered });
      return;   // wait for auth_ok (hide) or auth_fail (then prompt)
    }
    setLockScreen(true);
  });
  socket.on('stream:auth_ok', function () {
    clearLockoutCountdown();
    autoAuthInFlight = false;
    if (pendingCode) { rememberCode(pendingCode); pendingCode = null; }
    setLockScreen(false);
  });
  // Active lockout countdown timer (when server is rate-limiting this
  // IP after too many wrong codes). Cleared on each new failure or on
  // a successful auth_ok.
  var lockRetryTick = null;

  function clearLockoutCountdown() {
    if (lockRetryTick) {
      clearInterval(lockRetryTick);
      lockRetryTick = null;
    }
    var submitBtn = els.lockForm.querySelector('button[type="submit"]');
    els.lockInput.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
  }

  function startLockoutCountdown(seconds) {
    if (!seconds || seconds < 1) return;
    var submitBtn = els.lockForm.querySelector('button[type="submit"]');
    els.lockInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (lockRetryTick) clearInterval(lockRetryTick);
    var remaining = Math.max(1, Math.ceil(seconds));
    function fmt(s) {
      if (s < 60) return s + ' second' + (s === 1 ? '' : 's');
      var m = Math.floor(s / 60), r = s % 60;
      return m + 'm ' + r + 's';
    }
    function tick() {
      if (remaining <= 0) {
        clearLockoutCountdown();
        setLockScreen(true);
        els.lockInput.focus();
        return;
      }
      setLockScreen(true,
        'Too many wrong codes. Try again in ' + fmt(remaining) + '.');
      remaining -= 1;
    }
    tick();
    lockRetryTick = setInterval(tick, 1000);
  }

  socket.on('stream:auth_fail', function (info) {
    info = info || {};
    if (info.reason === 'rate_limited' && info.retry_after) {
      autoAuthInFlight = false;
      els.lockInput.value = '';
      startLockoutCountdown(info.retry_after);
      return;
    }
    // A silently-retried remembered code was rejected → the broadcaster
    // changed it. Drop the stale code and prompt for the new one.
    if (autoAuthInFlight) {
      autoAuthInFlight = false;
      pendingCode = null;
      forgetCode();
      els.lockInput.value = '';
      setLockScreen(true, 'The access code changed — enter the new one.');
      if (els.lockInput) els.lockInput.focus();
      return;
    }
    pendingCode = null;
    setLockScreen(true, 'Code incorrect — try again.');
    els.lockInput.value = '';
    if (els.lockInput) els.lockInput.focus();
  });
  socket.on('stream:unlocked', function () {
    // Broadcaster turned the lock off mid-stream — we're allowed in.
    clearLockoutCountdown();
    setLockScreen(false);
  });

  // ── Playback / autoplay ──────────────────────────────────────────────
  function tryAutoplay() {
    if (!els.player.paused) return;
    var p = els.player.play();
    if (!p || typeof p.catch !== 'function') return;
    p.catch(function (err) {
      // The stream defaults to UNMUTED so sound plays the moment it starts.
      // Some browsers block autoplay-with-sound (NotAllowedError); in that
      // case fall back to muted playback so the video still starts, and show
      // the "click for sound" badge. Decode errors / aborted-pending loads
      // are transient — the next chunk retries — so don't prompt for those.
      if (err && err.name === 'NotAllowedError') {
        els.player.muted = true;                 // slider drops to 0 via volumechange
        els.unmuteBtn.hidden = false;
        var p2 = els.player.play();
        if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
      }
    });
  }

  // SVG elements don't reliably implement the `hidden` IDL property
  // across browsers, so `svg.hidden = true` may not reflect to the
  // attribute (and our CSS [hidden]{display:none} rule won't match).
  // setAttribute / removeAttribute are mandated to work on every
  // Element regardless of namespace.
  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else      el.removeAttribute('hidden');
  }

  function updateMuteIcon() {
    var muted = els.player.muted || els.player.volume === 0;
    setHidden(els.muteBtn.querySelector('.ico-muted'), !muted);
    setHidden(els.muteBtn.querySelector('.ico-vol'),    muted);
    els.muteBtn.setAttribute('aria-pressed', String(muted));
  }
  // Keep the volume slider honest: when the audio is muted (mute button,
  // volume 0, or an autoplay fallback), the slider sits at zero so the UI
  // never looks turned-up while silent.
  function updateVolumeSlider() {
    var effective = els.player.muted ? 0 : els.player.volume;
    if (parseFloat(els.volumeIn.value) !== effective) {
      els.volumeIn.value = String(effective);
    }
  }
  // Last non-zero volume we saw, so unmuting restores something audible
  // even after the user previously dragged the slider all the way down.
  var lastVolume = els.player.volume > 0 ? els.player.volume : 1;

  els.muteBtn.addEventListener('click', function () {
    if (!els.player.muted && els.player.volume > 0) lastVolume = els.player.volume;
    els.player.muted = !els.player.muted;
    if (!els.player.muted && els.player.volume === 0) {
      els.player.volume = lastVolume;
    }
    if (!els.player.muted) els.unmuteBtn.hidden = true;
    // updateMuteIcon + updateVolumeSlider run via the volumechange
    // event below — single source of truth.
  });
  els.volumeIn.addEventListener('input', function () {
    var v = parseFloat(els.volumeIn.value);
    if (isNaN(v)) v = 1;
    v = Math.max(0, Math.min(1, v));
    els.player.volume = v;
    els.player.muted = v === 0;
    if (v > 0) lastVolume = v;
    if (!els.player.muted) els.unmuteBtn.hidden = true;
  });
  els.unmuteBtn.addEventListener('click', function () {
    els.player.muted = false;
    if (els.player.volume === 0) els.player.volume = lastVolume;
    els.unmuteBtn.hidden = true;
    tryAutoplay();
  });
  // Fullscreen the whole .public-main (video + chat) rather than just the
  // video stage, so the chat panel can ride along as a transparent overlay
  // on top of the movie. A toggled class drives the overlay styling — more
  // reliable across browsers than the :fullscreen / :-webkit-full-screen
  // pseudo-classes.
  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  els.fullscreenBtn.addEventListener('click', function () {
    var main = els.player.closest('.public-main');
    if (fsElement()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    } else if (main && (main.requestFullscreen || main.webkitRequestFullscreen)) {
      (main.requestFullscreen || main.webkitRequestFullscreen).call(main);
    } else if (typeof els.player.webkitEnterFullscreen === 'function') {
      // iPhone: the element-fullscreen API doesn't exist — only the
      // <video> itself can go fullscreen, via WebKit's native player
      // (which also makes rotate-to-landscape work). Chat overlay isn't
      // available there; the native controls take over.
      try { els.player.webkitEnterFullscreen(); } catch (_) {}
    }
  });
  function onFullscreenChange() {
    var main = els.player.closest('.public-main');
    if (!main) return;
    var fs = fsElement() === main;
    main.classList.toggle('is-fullscreen', fs);
    // Each fullscreen session starts with the chat pinned (visible); leaving
    // fullscreen drops the overlay-only states so the normal layout is clean.
    if (fs) { state.chatPinned = true; applyChatPin(); applyChatMute(); markActive(); }
    else { main.classList.remove('is-chat-unpinned', 'is-chat-peek', 'is-idle'); }
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ── Floating emoji reactions ─────────────────────────────────────────
  // Only chat participants can react. Picking an emoji from the control-bar
  // palette rains a burst of that emoji down over the video and shows a
  // top-center pill of who reacted; both are broadcast to every viewer.
  var REACTION_BURST = 9;        // particles spawned per reaction
  var REACTION_MAX = 150;        // hard cap on concurrent particles
  var reactionCount = 0;
  function rand(min, max) { return min + Math.random() * (max - min); }

  function spawnReactionParticle(emoji, stageH) {
    var p = document.createElement('span');
    p.className = 'reaction-particle';
    p.textContent = emoji;
    p.style.left = rand(2, 95).toFixed(2) + '%';
    p.style.fontSize = rand(1.25, 2.6).toFixed(2) + 'rem';
    p.style.setProperty('--fall', Math.round(stageH + 64) + 'px');
    p.style.setProperty('--drift', Math.round(rand(-70, 70)) + 'px');
    p.style.setProperty('--rot', Math.round(rand(-220, 220)) + 'deg');
    p.style.animationDuration = rand(2.6, 4.4).toFixed(2) + 's';
    p.style.animationDelay = rand(0, 0.7).toFixed(2) + 's';
    reactionCount++;
    p.addEventListener('animationend', function () {
      reactionCount--;
      if (p.parentNode) p.parentNode.removeChild(p);
    });
    els.reactionLayer.appendChild(p);
  }

  function rainReaction(emoji) {
    if (!els.reactionLayer || !emoji) return;
    var stageH = els.playerStage ? els.playerStage.clientHeight : 360;
    for (var i = 0; i < REACTION_BURST; i++) {
      if (reactionCount >= REACTION_MAX) break;
      spawnReactionParticle(emoji, stageH);
    }
  }

  // "Who reacted" pill at the top-center of the video. Reactions are played
  // one at a time: a newer reaction never supplants the one on screen — it
  // queues and waits for the current pill to slide out before its own pill
  // pops down (and its particles rain).
  var reactionQueue = [];
  var reactionPlaying = false;
  var REACTION_QUEUE_MAX = 12;     // drop the newest beyond this so older ones still play
  var PILL_DISPLAY_MS = 2400;      // time the pill stays before sliding out
  var PILL_SLIDE_MS = 300;         // matches the CSS slide transition
  var REACTION_GAP_MS = 180;       // breath between queued reactions

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
    rainReaction(info.emoji);                 // this reaction's particle burst
    if (info.name) {
      buildSenderPill(info);
      els.reactionSender.classList.add('is-visible');   // pop the pill down
    }
    setTimeout(function () {
      els.reactionSender.classList.remove('is-visible'); // slide it back out
      setTimeout(function () {
        reactionPlaying = false;
        playNextReaction();                   // then the next one gets its turn
      }, PILL_SLIDE_MS + REACTION_GAP_MS);
    }, PILL_DISPLAY_MS);
  }

  function openReactionPalette(open) {
    if (!els.reactionPalette || !els.reactionBtn) return;
    els.reactionPalette.hidden = !open;
    els.reactionBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (els.reactionControl) els.reactionControl.classList.toggle('is-open', open);
  }
  // The palette shows only when the broadcaster allows reactions AND the
  // viewer has joined the chat (reactions are tied to a chat identity).
  function updateReactionControl() {
    if (!els.reactionControl) return;
    var allow = state.reactionsOn !== false && !!state.chatJoined;
    els.reactionControl.hidden = !allow;
    if (!allow) openReactionPalette(false);
  }
  function setReactionsEnabled(on) {
    state.reactionsOn = !!on;
    updateReactionControl();
  }

  // Broadcaster alert banner: drops down over the top of the video when a
  // message is set, slides back up when cleared. Stays until the host
  // takes it down (no auto-dismiss).
  function setAlert(message) {
    if (!els.alertBanner) return;
    var msg = (message || '').trim();
    if (msg) {
      if (els.alertText) els.alertText.textContent = msg;
      els.alertBanner.classList.add('is-visible');
    } else {
      els.alertBanner.classList.remove('is-visible');
    }
  }

  // Chat identity pushed from chat.js — gates the palette + labels reactions.
  document.addEventListener('vbs:chat-identity', function (e) {
    var d = (e && e.detail) || {};
    state.chatJoined = !!d.joined;
    state.chatMe = d.me || null;
    updateReactionControl();
  });

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
      if (!state.chatJoined || state.reactionsOn === false) {
        openReactionPalette(false);
        return;
      }
      var emoji = btn.dataset.emoji;
      var me = state.chatMe || {};
      // Queue our own reaction (plays immediately if nothing's on screen).
      enqueueReaction({ emoji: emoji, name: me.name, avatar: me.emoji, color: me.color });
      socket.emit('viewer:react', { emoji: emoji });
      openReactionPalette(false);
      markActive();                             // keep the bar visible in fullscreen
    });
  }
  // Dismiss the palette on outside click / Escape.
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

  socket.on('video:reaction', function (info) {
    if (info && info.emoji) enqueueReaction(info);
  });

  // ── Phone burger menu ────────────────────────────────────────────────
  // On narrow screens the header action row (#public-actions) turns into
  // a slide-down sheet; #menu-btn toggles it via body.menu-open. Desktop
  // never sees the button (CSS), so none of this runs there in practice.
  var menuBtn = document.getElementById('menu-btn');
  var actionsPanel = document.getElementById('public-actions');
  function setMenuOpen(open) {
    document.body.classList.toggle('menu-open', open);
    if (!menuBtn) return;
    menuBtn.setAttribute('aria-expanded', String(open));
    setHidden(menuBtn.querySelector('.ico-burger'), open);
    setHidden(menuBtn.querySelector('.ico-close'), !open);
  }
  if (menuBtn) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setMenuOpen(!document.body.classList.contains('menu-open'));
    });
    // Tapping anywhere outside the sheet closes it; so does using one of
    // its actions (a navigation or the Now Showing modal opening).
    document.addEventListener('click', function (e) {
      if (!document.body.classList.contains('menu-open')) return;
      if (actionsPanel && actionsPanel.contains(e.target)) {
        if (e.target.closest('a, button')) setMenuOpen(false);
        return;
      }
      setMenuOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setMenuOpen(false);
    });
  }

  // ── Phone chat sheet collapse ────────────────────────────────────────
  // The chat rides as a bottom sheet under the video on phones. Its
  // header doubles as a grab bar: tapping it (or the chevron) collapses
  // the sheet down to the header so the video takes the whole screen.
  // Desktop layouts ignore .is-collapsed entirely (CSS-scoped).
  var chatPanelEl = document.getElementById('chat-panel');
  var chatCollapseBtn = document.getElementById('chat-collapse-btn');
  var LS_CHAT_COLLAPSED = 'vbs-chat-collapsed';
  function setChatCollapsed(collapsed, persist) {
    if (!chatPanelEl) return;
    chatPanelEl.classList.toggle('is-collapsed', collapsed);
    if (chatCollapseBtn) {
      chatCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
      chatCollapseBtn.title = collapsed ? 'Expand chat' : 'Collapse chat';
    }
    if (persist) {
      try { localStorage.setItem(LS_CHAT_COLLAPSED, collapsed ? '1' : '0'); } catch (_) {}
    }
  }
  if (chatPanelEl && chatCollapseBtn) {
    chatCollapseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setChatCollapsed(!chatPanelEl.classList.contains('is-collapsed'), true);
    });
    var chatHeaderEl = chatPanelEl.querySelector('.chat-header');
    if (chatHeaderEl) {
      chatHeaderEl.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;   // talk/leave/etc. keep their jobs
        if (!window.matchMedia('(max-width: 48rem)').matches) return;
        setChatCollapsed(!chatPanelEl.classList.contains('is-collapsed'), true);
      });
    }
    try {
      if (localStorage.getItem(LS_CHAT_COLLAPSED) === '1') setChatCollapsed(true, false);
    } catch (_) {}
  }

  // Pin toggle (fullscreen overlay only). Pinned = chat stays open;
  // unpinned = chat auto-hides off the right edge and peeks in on hover.
  var chatPinBtn = document.getElementById('chat-pin-btn');
  function applyChatPin() {
    var main = els.player.closest('.public-main');
    if (main) main.classList.toggle('is-chat-unpinned', !state.chatPinned);
    if (chatPinBtn) {
      chatPinBtn.setAttribute('aria-pressed', String(state.chatPinned));
      chatPinBtn.title = state.chatPinned
        ? 'Unpin chat (auto-hide)'
        : 'Pin chat (keep open)';
    }
  }
  if (chatPinBtn) {
    chatPinBtn.addEventListener('click', function () {
      state.chatPinned = !state.chatPinned;
      applyChatPin();
    });
  }

  // Mute-chat toggle (fullscreen overlay only). When muted, an @mention
  // never pops the chat into view — the viewer is never interrupted.
  var chatMuteBtn = document.getElementById('chat-mute-btn');
  function applyChatMute() {
    if (!chatMuteBtn) return;
    chatMuteBtn.setAttribute('aria-pressed', String(state.chatMuted));
    chatMuteBtn.title = state.chatMuted ? 'Unmute chat' : 'Mute chat (no @mention pop-ins)';
    setHidden(chatMuteBtn.querySelector('.ico-bell'), state.chatMuted);
    setHidden(chatMuteBtn.querySelector('.ico-bell-off'), !state.chatMuted);
  }
  if (chatMuteBtn) {
    chatMuteBtn.addEventListener('click', function () {
      state.chatMuted = !state.chatMuted;
      applyChatMute();
    });
  }

  // Briefly reveal an auto-hidden chat when the viewer is @-mentioned —
  // unless they've muted chat, or pinned it open already (nothing to do).
  var peekTimer = null;
  document.addEventListener('vbs:chat-mention', function () {
    var main = els.player.closest('.public-main');
    if (!main || !main.classList.contains('is-fullscreen')) return;
    if (state.chatMuted || state.chatPinned) return;
    main.classList.add('is-chat-peek');
    if (peekTimer) clearTimeout(peekTimer);
    peekTimer = setTimeout(function () { main.classList.remove('is-chat-peek'); }, 5000);
  });

  // Fullscreen idle: the grab handles fade out after the mouse goes still;
  // any movement brings them back so the reveal affordances stay subtle.
  var idleTimer = null;
  function markActive() {
    var main = els.player.closest('.public-main');
    if (!main || !main.classList.contains('is-fullscreen')) return;
    main.classList.remove('is-idle');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { main.classList.add('is-idle'); }, 2500);
  }
  document.addEventListener('mousemove', markActive);

  els.player.addEventListener('volumechange', function () {
    updateMuteIcon();
    updateVolumeSlider();
  });
  // Repopulate the chip once the actual video dimensions are known —
  // covers the fallback path when the broadcaster didn't send meta.
  els.player.addEventListener('loadedmetadata', function () {
    if (!state.streamLive) return;
    var snap = state.lastSnap || {};
    updateQualityChip({
      live: true,
      width:      snap.width      || els.player.videoWidth,
      height:     snap.height     || els.player.videoHeight,
      bitrate:    snap.bitrate    || 0,
      quality:    snap.quality    || null,
    });
  });
  updateMuteIcon();
  updateVolumeSlider();
})();
