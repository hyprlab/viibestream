// Broadcaster participants panel — a live roster of everyone signed into the
// chat, each with a mute/unmute button, that highlights whoever's speaking.
//
// Loaded only on the broadcaster backend. Reuses the `chat:roster` push that
// stream-broadcaster.js already subscribes to (via chat:moderate_state on
// connect) and the voice events (talk:speaking / talk:muted / talk:audio_state
// / talk:mute_all). The per-row mic icon mirrors the viewer's mic status:
//   • green NORMAL mic → unmuted and actively speaking
//   • red SLASHED mic  → muted by the host (individually or via Mute all)
//   • grey SLASHED mic → participant audio disabled for everyone
(function () {
  'use strict';

  var listEl = document.getElementById('participants-list');
  if (!listEl) return;                  // not on the broadcaster page

  var socket = window.vbsSocket();
  var panelEl = document.getElementById('participants-panel');
  var countEl = document.getElementById('participants-count');
  var emptyEl = document.getElementById('participants-empty');
  var audioToggle = document.getElementById('participants-audio-toggle');
  var audioLabel = audioToggle ? audioToggle.querySelector('.participants-audio-label') : null;
  var muteAllBtn = document.getElementById('participants-muteall');
  var askUnmuteBtn = document.getElementById('participants-askunmute');

  var roster = [];                      // [{sid,name,emoji,color,muted}]
  var speaking = {};                    // sid -> bool (transient)
  var audioEnabled = true;              // global participant-audio gate

  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function find(sid) {
    for (var i = 0; i < roster.length; i++) if (roster[i].sid === sid) return roster[i];
    return null;
  }

  function rowFor(sid) {
    return listEl.querySelector('.participants-row[data-sid="' + sid + '"]');
  }

  // ── Mic icons ───────────────────────────────────────────────────────
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

  // Paint one row's mic button + row highlight from the current mute /
  // speaking / global-audio state — the same three-state logic the viewer's
  // own mic button uses.
  function paintRow(sid) {
    var u = find(sid);
    var row = rowFor(sid);
    if (!u || !row) return;
    var audioOff = !audioEnabled;
    var muted = !!u.muted;                                // host-mute flag
    var micOn = !!u.micOn && !audioOff;                   // their mic is actually live
    var pending = muted && !!u.pending && !audioOff;      // asked, awaiting consent
    var talking = micOn && !!speaking[sid];
    // The icon mirrors the viewer's own mic exactly: green when live, red
    // slashed when their mic is off (whether self-off or host-muted), grey
    // slashed when participant audio is disabled.
    var slashed = !micOn || audioOff;

    // Row label reflects the host-mute flag specifically ("Muted"), so a
    // participant who's merely got their mic off isn't mislabelled.
    row.classList.toggle('is-muted', muted && !audioOff);
    row.classList.toggle('is-asking', pending);
    row.classList.toggle('is-audio-off', audioOff);
    row.classList.toggle('is-speaking', talking);

    var btn = row.querySelector('.participants-mute');
    if (!btn) return;
    btn.innerHTML = slashed ? MIC_OFF : MIC_ON;
    btn.classList.toggle('is-audio-off', audioOff);
    btn.classList.toggle('is-muted', !micOn && !audioOff);
    btn.classList.toggle('is-asking', pending);
    btn.classList.toggle('is-live', micOn);
    btn.disabled = audioOff;
    if (audioOff) {
      btn.title = 'Participant audio is turned off';
      btn.setAttribute('aria-label', 'Participant audio is off');
    } else if (micOn) {
      // They're live → clicking mutes them.
      btn.title = 'Mute ' + u.name;
      btn.setAttribute('aria-label', 'Mute ' + u.name);
    } else {
      // Mic off (host-muted or just off) → clicking invites them to turn it on.
      btn.title = pending
        ? 'Waiting for ' + u.name + ' to accept'
        : 'Ask ' + u.name + ' to turn their mic on';
      btn.setAttribute('aria-label', 'Ask ' + u.name + ' to turn their mic on');
    }
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  function makeRow(u) {
    var row = document.createElement('div');
    row.className = 'participants-row';
    row.dataset.sid = u.sid;

    var emoji = document.createElement('span');
    emoji.className = 'participants-emoji';
    emoji.textContent = u.emoji || '👤';

    var nameWrap = document.createElement('div');
    nameWrap.className = 'participants-name-wrap';
    var name = document.createElement('span');
    name.className = 'participants-name';
    name.textContent = u.name;
    name.style.color = u.color || 'var(--text-strong)';
    var status = document.createElement('span');
    status.className = 'participants-status';
    nameWrap.appendChild(name);
    nameWrap.appendChild(status);

    // Rename (host only): a pencil that turns the name into an inline input.
    var renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'participants-rename';
    renameBtn.innerHTML = PENCIL;
    renameBtn.title = 'Rename ' + u.name;
    renameBtn.setAttribute('aria-label', 'Rename ' + u.name);
    renameBtn.addEventListener('click', function () { beginRename(row, u.sid); });

    var muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'participants-mute';
    muteBtn.addEventListener('click', function () {
      if (!audioEnabled) return;
      var cur = find(u.sid) || u;
      // Match the icon: green (live) → mute; red/slashed (mic off, whether
      // host-muted or just off) → invite them to turn it on (one click).
      if (cur.micOn) {
        socket.emit('talk:mute', { sid: u.sid, muted: true });
      } else {
        socket.emit('talk:request_unmute', { sid: u.sid });
        if (cur.muted) { cur.pending = true; paintRow(u.sid); }
      }
    });

    row.appendChild(emoji);
    row.appendChild(nameWrap);
    row.appendChild(renameBtn);
    row.appendChild(muteBtn);
    return row;
  }

  var PENCIL =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

  // Inline rename: swap the name for a text input pre-filled with the current
  // name. Enter / blur commits (emits chat:moderate_rename — the server
  // validates and, on success, pushes a fresh chat:roster that re-renders the
  // row); Escape cancels. On failure the roster is unchanged and a toast
  // explains why (see chat:mod_error).
  function beginRename(row, sid) {
    var u = find(sid);
    if (!u || row.querySelector('.participants-rename-input')) return;
    var nameWrap = row.querySelector('.participants-name-wrap');
    var nameEl = nameWrap && nameWrap.querySelector('.participants-name');
    var statusEl = nameWrap && nameWrap.querySelector('.participants-status');
    if (!nameWrap) return;

    row.classList.add('is-renaming');
    if (nameEl) nameEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'participants-rename-input';
    input.maxLength = 24;
    input.value = u.name;
    nameWrap.appendChild(input);
    input.focus();
    input.select();

    var done = false;
    function finish(commit) {
      if (done) return;
      done = true;
      var val = (input.value || '').trim();
      if (commit && val && val !== u.name) {
        socket.emit('chat:moderate_rename', { sid: sid, name: val });
      }
      row.classList.remove('is-renaming');
      if (input.parentNode) input.parentNode.removeChild(input);
      if (nameEl) nameEl.style.display = '';
      if (statusEl) statusEl.style.display = '';
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  // Transient error toast (e.g. a rename rejected as a duplicate name).
  var toastTimer = null;
  function showPanelError(msg) {
    if (!panelEl) return;
    var t = document.getElementById('participants-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'participants-toast';
      t.className = 'participants-toast';
      panelEl.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-visible'); }, 3200);
  }
  socket.on('chat:mod_error', function (info) {
    if (info && info.message) showPanelError(info.message);
  });

  function render() {
    if (countEl) countEl.textContent = String(roster.length);
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    setHidden(emptyEl, roster.length > 0);
    roster.forEach(function (u) {
      listEl.appendChild(makeRow(u));
      paintRow(u.sid);
    });
    paintTools();
  }

  // ── Mute all / Ask all to unmute (two independent actions) ──────────
  function allMuted() {
    return roster.length > 0 && roster.every(function (u) { return u.muted; });
  }
  function paintTools() {
    var has = roster.length > 0;
    // Mute all: pointless when there's no one or everyone's already muted.
    // Ask to unmute: always available while audio is on — independent of
    // whether anyone is currently muted.
    if (muteAllBtn) muteAllBtn.disabled = !has || !audioEnabled || allMuted();
    if (askUnmuteBtn) askUnmuteBtn.disabled = !audioEnabled;
  }
  if (muteAllBtn) {
    muteAllBtn.addEventListener('click', function () {
      socket.emit('talk:mute_all', { muted: true });
    });
  }
  if (askUnmuteBtn) {
    askUnmuteBtn.addEventListener('click', function () {
      socket.emit('talk:request_unmute_all');
    });
  }

  // ── Global "disable participant audio" toggle ───────────────────────
  function paintAudioToggle() {
    if (audioToggle) {
      audioToggle.dataset.state = audioEnabled ? 'on' : 'off';
      audioToggle.setAttribute('aria-pressed', audioEnabled ? 'false' : 'true');
      audioToggle.title = audioEnabled
        ? 'Turn off participant audio — no one can talk or unmute'
        : 'Turn participant audio back on';
      if (audioLabel) audioLabel.textContent = audioEnabled ? 'Audio on' : 'Audio off';
    }
    if (panelEl) panelEl.classList.toggle('is-audio-off', !audioEnabled);
  }
  if (audioToggle) {
    audioToggle.addEventListener('click', function () {
      socket.emit('talk:set_audio', { enabled: !audioEnabled });
    });
  }

  // ── Server events ───────────────────────────────────────────────────
  socket.on('chat:roster', function (users) {
    roster = (users || []).map(function (u) {
      return {
        sid: u.sid, name: u.name, emoji: u.emoji,
        color: u.color, muted: !!u.muted, pending: !!u.unmute_pending,
        micOn: !!u.mic_on,
      };
    });
    Object.keys(speaking).forEach(function (sid) {
      if (!find(sid)) delete speaking[sid];
    });
    render();
  });

  socket.on('talk:speaking', function (info) {
    if (!info || info.sid == null) return;
    speaking[info.sid] = !!info.speaking;
    paintRow(info.sid);
  });

  // Participant turned their own mic on/off — mirror it on their row icon.
  socket.on('talk:mic', function (info) {
    if (!info || info.sid == null) return;
    var u = find(info.sid);
    if (u) u.micOn = !!info.on;
    if (!info.on) speaking[info.sid] = false;
    paintRow(info.sid);
  });

  socket.on('talk:muted', function (info) {
    if (!info || info.sid == null) return;
    var u = find(info.sid);
    if (u) {
      u.muted = !!info.muted;
      if (u.muted) u.micOn = false;        // host mute stops their capture
      else u.pending = false;              // unmuted → request resolved
    }
    if (info.muted) speaking[info.sid] = false;
    paintRow(info.sid);
    paintTools();
  });

  socket.on('talk:mute_all', function (info) {
    if (!info || typeof info.muted !== 'boolean') return;
    roster.forEach(function (u) {
      u.muted = info.muted;
      u.pending = false;
      if (info.muted) { u.micOn = false; speaking[u.sid] = false; }
      paintRow(u.sid);
    });
    paintTools();
  });

  // Host's unmute request is now pending for this participant.
  socket.on('talk:unmute_pending', function (info) {
    if (!info || info.sid == null) return;
    var u = find(info.sid);
    if (u) u.pending = !!info.pending;
    paintRow(info.sid);
  });

  // Participant declined — they're staying muted. Surface it briefly.
  socket.on('talk:unmute_declined', function (info) {
    if (!info || info.sid == null) return;
    var u = find(info.sid);
    if (u) u.pending = false;
    paintRow(info.sid);
    var row = rowFor(info.sid);
    if (row) {
      var btn = row.querySelector('.participants-mute');
      if (btn) btn.title = (info.name || 'They') + ' declined to unmute';
    }
  });

  socket.on('talk:audio_state', function (info) {
    if (!info || typeof info.enabled !== 'boolean') return;
    audioEnabled = info.enabled;
    if (!audioEnabled) speaking = {};
    paintAudioToggle();
    paintTools();
    roster.forEach(function (u) { paintRow(u.sid); });
  });

  paintAudioToggle();
  paintTools();
})();
