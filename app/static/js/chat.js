// Live chat client for the public viewer page.
//
// Uses a fresh Socket.IO connection (separate from the stream socket
// in stream-viewer.js) so the two concerns don't share lifecycle —
// the chat reconnects, errors, or disconnects without affecting MSE
// playback and vice versa.
//
// The server escapes nothing; this file is responsible for rendering
// every piece of user-supplied text through textContent (never
// innerHTML). Avatar emoji and color come from the server.
(function () {
  'use strict';

  // One shared connection across chat/stream/info so the server can resolve
  // this browser's chat identity by request.sid from any feature. See
  // static/js/socket.js.
  var socket = window.vbsSocket();

  var els = {
    panel:        document.getElementById('chat-panel'),
    count:        document.getElementById('chat-count'),
    join:         document.getElementById('chat-join'),
    joinForm:     document.getElementById('chat-join-form'),
    nameInput:    document.getElementById('chat-name-input'),
    joinError:    document.getElementById('chat-join-error'),
    messages:     document.getElementById('chat-messages'),
    empty:        document.getElementById('chat-empty'),
    composeForm:  document.getElementById('chat-compose-form'),
    composeInput: document.getElementById('chat-compose-input'),
    composeMe:    document.getElementById('chat-compose-me'),
    banner:       document.getElementById('chat-banner'),
    bannerText:   document.getElementById('chat-banner-text'),
    replyBanner:  document.getElementById('chat-reply-banner'),
    replyName:    document.getElementById('chat-reply-banner-name'),
    replySnippet: document.getElementById('chat-reply-banner-snippet'),
    replyCancel:  document.getElementById('chat-reply-banner-cancel'),
    replyHint:    document.getElementById('chat-reply-hint'),
    mentionMenu:  document.getElementById('chat-mention-menu'),
    leaveBtn:     document.getElementById('chat-leave-btn'),
    profileModal: document.getElementById('chat-profile-modal'),
    profileName:  document.getElementById('chat-profile-name'),
    profileError: document.getElementById('chat-profile-error'),
    profileSave:  document.getElementById('chat-profile-save'),
    emojiGrid:    document.getElementById('chat-emoji-grid'),
  };

  // ── Remembered identity (persists across refreshes) ──────────────────
  // The viewer's chosen name + emoji are stored locally so they don't have
  // to rejoin every refresh. Cleared when they explicitly leave the chat.
  // Scoped to the public viewer (the host auto-joins from its login, not
  // from localStorage) so it doesn't reuse a viewer identity for the host.
  var IDENTITY_KEY = 'vbs-chat-identity';
  var IS_VIEWER_PAGE = !(els.panel && els.panel.dataset && els.panel.dataset.autojoin);
  function loadIdentity() {
    if (!IS_VIEWER_PAGE) return null;
    try {
      var raw = window.localStorage.getItem(IDENTITY_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && typeof obj.name === 'string' && obj.name.length >= 2) return obj;
    } catch (_) {}
    return null;
  }
  function saveIdentity(me) {
    if (!IS_VIEWER_PAGE || !me || !me.name) return;
    try {
      window.localStorage.setItem(IDENTITY_KEY,
        JSON.stringify({ name: me.name, emoji: me.emoji || '' }));
    } catch (_) {}
  }
  function clearIdentity() {
    try { window.localStorage.removeItem(IDENTITY_KEY); } catch (_) {}
  }

  // Compose placeholder — also tips the viewer about the /re reply flag.
  var COMPOSE_PLACEHOLDER = 'Message…  ·  type /re to reply';

  // Tombstone text shown in place of a message the host removed.
  var REMOVED_TEXT = 'Message removed by broadcaster';

  // The six quick reactions shown inline on hover; "…" opens the full
  // searchable palette (window.CHAT_EMOJI_DATA, from chat-emoji-data.js).
  var QUICK_REACTIONS = ['👍', '♥️', '🤣', '😭', '☝️', '💯'];
  // Reactions are allowed while chat is enabled; the host may always react.
  function canReact() { return state.enabled || IS_HOST; }
  function sendReaction(msgId, emoji) {
    if (!canReact() || msgId == null || !emoji) return;
    socket.emit('chat:react', { id: msgId, emoji: emoji });
  }

  // The broadcaster page marks its chat panel with data-autojoin; that's
  // the host, who can keep posting even when chat is disabled.
  var IS_HOST = !!(els.panel && els.panel.dataset && els.panel.dataset.autojoin);

  // SVG[hidden] vs element.hidden — same pattern we use elsewhere.
  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else      el.removeAttribute('hidden');
  }

  // Broadcast our chat identity so the video-reaction UI (stream-viewer.js)
  // can gate its palette on chat membership and label reactions with our
  // name + avatar. Fired on join/leave/rename.
  function publishChatIdentity() {
    document.dispatchEvent(new CustomEvent('vbs:chat-identity', {
      detail: { joined: state.joined, me: state.me },
    }));
  }

  var state = {
    joined: false,
    me: null,             // ChatUser dict once joined
    enabled: true,
    members: 0,
    banned: false,
    replyTo: null,        // { id, name, color, text } of message being replied to
    users: {},            // sid -> { sid, name, emoji, color } — used for @-completion
    mentionMenu: null,    // active autocomplete state, or null when closed
    selectedEmoji: null,  // emoji chosen in the open profile modal
    autoJoining: false,   // an auto-rejoin from a remembered identity is in flight
    replySelect: null,    // { index } while the /r keyboard reply-picker is active
  };

  // ── Reply state ─────────────────────────────────────────────────────
  function startReplyTo(m) {
    if (!m || m.kind === 'system') return;
    state.replyTo = {
      id: m.id,
      name: m.name,
      color: m.color,
      text: (m.text || '').slice(0, 140),
    };
    els.replyName.textContent = m.name;
    els.replyName.style.color = m.color || 'var(--text-strong)';
    els.replySnippet.textContent = state.replyTo.text;
    setHidden(els.replyBanner, false);
    if (els.composeInput) els.composeInput.focus();
  }
  function cancelReply() {
    state.replyTo = null;
    setHidden(els.replyBanner, true);
  }

  // ── /r keyboard reply-picker ─────────────────────────────────────────
  // Typing "/r" in the compose box enters a mode where ↑/↓ highlight a
  // message to reply to and Enter arms the reply (returning focus to the
  // box). Escape — or starting to type — cancels.
  function replyableMessages() {
    return Array.prototype.filter.call(
      els.messages.querySelectorAll('.chat-msg'),
      function (li) {
        return !li.classList.contains('chat-msg--system') &&
               !li.classList.contains('is-removed');
      }
    );
  }
  function messageFromLi(li) {
    if (!li) return null;
    var nameEl = li.querySelector('.chat-msg-name');
    var textEl = li.querySelector('.chat-msg-text');
    return {
      id: parseInt(li.dataset.msgId, 10),
      name: nameEl ? nameEl.textContent : '',
      color: nameEl ? nameEl.style.color : '',
      text: textEl ? textEl.textContent : '',
      kind: 'msg',
    };
  }
  function highlightReplyTarget() {
    if (!state.replySelect) return;
    var lis = replyableMessages();
    for (var i = 0; i < lis.length; i++) {
      lis[i].classList.toggle('is-reply-target', i === state.replySelect.index);
    }
    var cur = lis[state.replySelect.index];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function enterReplySelect() {
    var lis = replyableMessages();
    if (!lis.length) return;                          // nothing to reply to
    state.replySelect = { index: lis.length - 1 };    // start at the newest
    if (els.replyHint) setHidden(els.replyHint, false);
    highlightReplyTarget();
  }
  function moveReplySelect(delta) {
    if (!state.replySelect) return;
    var lis = replyableMessages();
    if (!lis.length) { exitReplySelect(); return; }
    var i = state.replySelect.index + delta;
    i = Math.max(0, Math.min(lis.length - 1, i));
    state.replySelect.index = i;
    highlightReplyTarget();
  }
  function confirmReplySelect() {
    if (!state.replySelect) return;
    var m = messageFromLi(replyableMessages()[state.replySelect.index]);
    exitReplySelect();
    els.composeInput.value = '';                       // drop the "/re" command
    if (m && !isNaN(m.id)) startReplyTo(m);            // shows banner + refocuses
  }
  // Tears down the picker WITHOUT touching the input text, so abandoning it
  // by typing keeps whatever the user wrote.
  function exitReplySelect() {
    if (!state.replySelect) return;
    state.replySelect = null;
    var marked = els.messages.querySelectorAll('.chat-msg.is-reply-target');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('is-reply-target');
    if (els.replyHint) setHidden(els.replyHint, true);
  }

  // ── @-mention autocomplete ─────────────────────────────────────────
  //
  // While the cursor sits inside an @-token in the compose input,
  // pop a list of matching users above the field. Up/Down arrows
  // navigate, Enter or Tab inserts, Escape dismisses, clicking an
  // item also inserts. The token can only start at the beginning of
  // input or after whitespace — bare @-signs inside e-mail-like
  // strings ("foo@bar.com") don't trigger the menu.

  var MENTION_MAX_ITEMS = 8;
  var MENTION_TOKEN_RE = /^[A-Za-z0-9_.\-]*$/;

  function findMentionTokenAtCursor() {
    var input = els.composeInput;
    var val = input.value || '';
    var pos = input.selectionStart || 0;
    // Walk backwards from the cursor until we hit either an '@' or
    // whitespace. If we hit '@' and it's preceded by start-of-input
    // or whitespace, we're inside a mention token.
    for (var i = pos - 1; i >= 0; i--) {
      var ch = val[i];
      if (ch === '@') {
        var prev = i > 0 ? val[i - 1] : '';
        if (prev === '' || /\s/.test(prev)) {
          var token = val.slice(i + 1, pos);
          if (MENTION_TOKEN_RE.test(token)) {
            return { start: i, token: token };
          }
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
    }
    return null;
  }

  function filterMentionItems(token) {
    var needle = (token || '').toLowerCase();
    var meSid = state.me ? state.me.sid : null;
    var all = [];
    for (var sid in state.users) {
      if (!Object.prototype.hasOwnProperty.call(state.users, sid)) continue;
      var u = state.users[sid];
      if (!u || u.sid === meSid) continue;     // can't @-mention yourself
      // Server's mention regex needs the name to be a single contiguous
      // word, so skip names with spaces — they can't be @-tagged.
      if (!/^[A-Za-z0-9_.\-]{2,24}$/.test(u.name)) continue;
      var lower = u.name.toLowerCase();
      if (needle === '' || lower.indexOf(needle) === 0) all.push(u);
    }
    all.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return all.slice(0, MENTION_MAX_ITEMS);
  }

  function renderMentionMenu() {
    var menu = els.mentionMenu;
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    if (!state.mentionMenu) { setHidden(menu, true); return; }
    state.mentionMenu.items.forEach(function (u, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-mention-item';
      btn.setAttribute('role', 'option');
      if (i === state.mentionMenu.index) btn.classList.add('is-active');

      var em = document.createElement('span');
      em.className = 'chat-mention-item-emoji';
      em.textContent = u.emoji || '👤';

      var nm = document.createElement('span');
      nm.className = 'chat-mention-item-name';
      nm.textContent = u.name;
      nm.style.color = u.color || 'inherit';

      var hint = document.createElement('span');
      hint.className = 'chat-mention-item-hint';
      // First entry shows a Tab/↵ hint as a quick affordance.
      if (i === state.mentionMenu.index) hint.textContent = '↵';

      btn.appendChild(em);
      btn.appendChild(nm);
      btn.appendChild(hint);
      // mousedown (not click) + preventDefault so the input doesn't
      // blur, which would otherwise dismiss the menu before we could
      // act on the click.
      btn.addEventListener('mousedown', function (e) {
        e.preventDefault();
        applyMentionAt(i);
      });
      menu.appendChild(btn);
    });
    setHidden(menu, false);
  }

  function openOrUpdateMentionMenu() {
    if (!state.joined || (!state.enabled && !IS_HOST)) {
      closeMentionMenu();
      return;
    }
    var token = findMentionTokenAtCursor();
    if (!token) { closeMentionMenu(); return; }
    var items = filterMentionItems(token.token);
    if (!items.length) { closeMentionMenu(); return; }
    var prevIndex = state.mentionMenu ? state.mentionMenu.index : 0;
    state.mentionMenu = {
      tokenStart: token.start,
      items: items,
      index: Math.min(prevIndex, items.length - 1),
    };
    renderMentionMenu();
  }

  function closeMentionMenu() {
    state.mentionMenu = null;
    setHidden(els.mentionMenu, true);
    while (els.mentionMenu.firstChild) els.mentionMenu.removeChild(els.mentionMenu.firstChild);
  }

  function applyMentionAt(index) {
    var ctx = state.mentionMenu;
    if (!ctx) return;
    var user = ctx.items[index];
    if (!user) return;
    var input = els.composeInput;
    var val = input.value || '';
    var pos = input.selectionStart || 0;
    // Replace the slice [tokenStart, cursor) with "@Name " — always
    // append a trailing space so the user can keep typing.
    var insert = '@' + user.name + ' ';
    var newVal = val.slice(0, ctx.tokenStart) + insert + val.slice(pos);
    input.value = newVal;
    var caret = ctx.tokenStart + insert.length;
    try { input.setSelectionRange(caret, caret); } catch (_) {}
    closeMentionMenu();
    input.focus();
  }

  // ── @-mention parsing for client-side rendering ────────────────────
  // The whole-message highlight is server-driven (msg.mentions), but
  // we wrap each @token in the rendered text so it's visually distinct
  // and the current user's mentions stand out further.
  var MENTION_RE = /@([A-Za-z0-9_.\-]{2,24})/g;

  function appendTextWithMentions(parent, text) {
    var meName = state.me && state.me.name ? state.me.name.toLowerCase() : null;
    var last = 0;
    var match;
    MENTION_RE.lastIndex = 0;
    while ((match = MENTION_RE.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      var token = match[0];
      var nameLower = match[1].toLowerCase();
      var span = document.createElement('span');
      span.className = 'chat-mention';
      if (meName && nameLower === meName) {
        span.classList.add('chat-mention--me');
      }
      span.textContent = token;
      parent.appendChild(span);
      last = match.index + token.length;
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  // ── View states ─────────────────────────────────────────────────────
  // The message list is visible in every (non-banned) state — anyone can
  // read along. The bottom of the panel swaps between the join bar (not
  // joined) and the compose row (joined). #chat-messages and #chat-empty
  // are mutually exclusive, toggled by updateEmptyState().
  function updateEmptyState() {
    var has = els.messages.children.length > 0;
    setHidden(els.empty, has);
    setHidden(els.messages, !has);
  }
  function showReadOnlyView() {
    setHidden(els.join, false);
    setHidden(els.composeForm, true);
    if (els.leaveBtn) setHidden(els.leaveBtn, true);
    updateEmptyState();
  }
  function showChatView() {
    setHidden(els.join, true);
    setHidden(els.composeForm, false);
    if (els.leaveBtn) setHidden(els.leaveBtn, false);
    updateEmptyState();
  }

  // Paint the compose avatar (the emoji circle that opens the profile
  // editor) from the current identity.
  function paintMe() {
    if (!els.composeMe || !state.me) return;
    els.composeMe.textContent = state.me.emoji || '🙂';
    els.composeMe.style.background = state.me.color || 'var(--bg-elev)';
    els.composeMe.style.borderColor = state.me.color || 'var(--border)';
    els.composeMe.style.color = '#fff';
    els.composeMe.title = 'Change your name & icon';
  }
  function setBanner(text, isBanned) {
    if (!text) {
      setHidden(els.banner, true);
      return;
    }
    els.bannerText.textContent = text;
    els.banner.classList.toggle('is-banned', !!isBanned);
    setHidden(els.banner, false);
  }
  function setCount(n) {
    state.members = n;
    if (n > 0) {
      els.count.textContent = String(n);
      setHidden(els.count, false);
    } else {
      setHidden(els.count, true);
    }
  }
  function setEnabled(enabled) {
    state.enabled = enabled;
    if (state.joined) {
      // The host can always type (their messages reach read-only viewers).
      var locked = !enabled && !IS_HOST;
      els.composeInput.disabled = locked;
      els.composeInput.placeholder = locked
        ? 'Chat is disabled by the host'
        : (enabled ? COMPOSE_PLACEHOLDER : 'Chat is off — only your messages are sent');
    } else if (!state.banned) {
      // Read-only viewer: gate the join controls on the host's toggle.
      els.nameInput.disabled = !enabled;
      var joinBtn = els.joinForm.querySelector('button[type="submit"]');
      if (joinBtn) joinBtn.disabled = !enabled;
    }
    // Never clobber the "you were removed" banner with the disabled one,
    // and don't nag the host (their placeholder already explains it).
    if (!state.banned) {
      setBanner((enabled || IS_HOST) ? '' : 'Chat has been disabled by the host.', false);
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────
  function nearBottom() {
    var el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  }
  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function renderMessage(m) {
    var li = document.createElement('li');
    // Tag every message (system rows included) with its id so duplicate
    // pushes — the host receives any chat+broadcaster-targeted message twice
    // — can be deduped in appendMessage.
    if (m.id != null) li.dataset.msgId = String(m.id);
    if (m.kind === 'system') {
      li.className = 'chat-msg chat-msg--system';
      var span = document.createElement('span');
      span.className = 'chat-msg-text';
      span.textContent = m.text;
      li.appendChild(span);
      return li;
    }

    li.className = 'chat-msg';

    var avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.textContent = m.emoji || '👤';

    var body = document.createElement('div');
    body.className = 'chat-msg-body';

    // Threaded reply quote — rendered above the meta line so the
    // parent's snippet sits between author/time and the new message.
    if (m.reply_to_meta) {
      var quote = document.createElement('div');
      quote.className = 'chat-msg-quote';
      var qArrow = document.createElement('span');
      qArrow.className = 'chat-msg-quote-arrow';
      qArrow.setAttribute('aria-hidden', 'true');
      qArrow.textContent = '↳';
      var qName = document.createElement('span');
      qName.className = 'chat-msg-quote-name';
      qName.textContent = m.reply_to_meta.name;
      qName.style.color = m.reply_to_meta.color || 'var(--text-strong)';
      var qText = document.createElement('span');
      qText.className = 'chat-msg-quote-text';
      qText.textContent = m.reply_to_meta.text;
      quote.appendChild(qArrow);
      quote.appendChild(qName);
      quote.appendChild(document.createTextNode(': '));
      quote.appendChild(qText);
      body.appendChild(quote);
    }

    var meta = document.createElement('div');
    meta.className = 'chat-msg-meta';
    var name = document.createElement('span');
    name.className = 'chat-msg-name';
    name.textContent = m.name;
    name.style.color = m.color || 'var(--text-strong)';
    var time = document.createElement('span');
    time.className = 'chat-msg-time';
    time.textContent = formatTime(m.ts);
    time.title = m.ts || '';
    meta.appendChild(name);
    meta.appendChild(time);

    // Removed messages render a tombstone in place of their text, keeping
    // the avatar + name/time so it's clear who was removed.
    var text = document.createElement('div');
    if (m.removed) {
      li.classList.add('is-removed');
      text.className = 'chat-msg-text chat-msg-removed';
      text.textContent = REMOVED_TEXT;
    } else {
      text.className = 'chat-msg-text';
      appendTextWithMentions(text, m.text || '');
    }

    body.appendChild(meta);
    body.appendChild(text);
    li.appendChild(avatar);
    li.appendChild(body);

    // A removed message carries no actions, reactions, or mention highlight.
    if (m.removed) return li;

    // Persistent reaction chips under the message body.
    var reactionsEl = document.createElement('div');
    reactionsEl.className = 'chat-reactions';
    body.appendChild(reactionsEl);
    renderReactions(reactionsEl, m.reactions, m.id);

    // Whole-bubble highlight when the current viewer was @-mentioned.
    if (state.me && Array.isArray(m.mentions) &&
        m.mentions.indexOf(state.me.sid) !== -1) {
      li.classList.add('is-mention');
    }

    // Single hover action bar (overlays the top-right of the bubble on
    // hover): quick reactions + "…" palette, then Reply, then host-only
    // moderation (Remove / Delete). Grouping them in one bar means they
    // never overlap each other.
    var reactBar = document.createElement('div');
    reactBar.className = 'chat-react-bar';

    if (canReact()) {
      QUICK_REACTIONS.forEach(function (emo) {
        var qb = document.createElement('button');
        qb.type = 'button';
        qb.className = 'chat-react-quick';
        qb.title = 'React with ' + emo;
        qb.textContent = emo;
        qb.addEventListener('click', function () { sendReaction(m.id, emo); });
        reactBar.appendChild(qb);
      });
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'chat-react-quick chat-react-more';
      more.title = 'More emojis…';
      more.setAttribute('aria-label', 'More emojis');
      more.textContent = '⋯';
      more.addEventListener('click', function () { openPalette(m.id, more); });
      reactBar.appendChild(more);
    }

    // Skip Reply on your own messages (you can't thread-reply to yourself).
    var canReply = state.joined && (!state.me || m.sid !== state.me.sid);
    var hasActions = canReply || IS_HOST;
    if (canReact() && hasActions) {
      var divider = document.createElement('span');
      divider.className = 'chat-react-divider';
      divider.setAttribute('aria-hidden', 'true');
      reactBar.appendChild(divider);
    }

    if (canReply) {
      var reply = document.createElement('button');
      reply.type = 'button';
      reply.className = 'chat-msg-action chat-msg-reply';
      reply.title = 'Reply to ' + m.name;
      reply.setAttribute('aria-label', 'Reply to ' + m.name);
      reply.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="9 17 4 12 9 7"/>' +
        '<path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
      reply.addEventListener('click', function () { startReplyTo(m); });
      reactBar.appendChild(reply);
    }

    if (IS_HOST) {
      // Remove + ban the author — not on the host's own messages (you
      // can't IP-ban yourself). Mirrors the roster kick in the mod modal.
      if (!state.me || m.sid !== state.me.sid) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'chat-msg-action chat-msg-mod chat-msg-remove';
        remove.title = 'Remove ' + m.name + ' and ban their IP for the rest of the stream';
        remove.setAttribute('aria-label', 'Remove ' + m.name);
        remove.innerHTML =
          '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
          '<circle cx="9" cy="7" r="4"/>' +
          '<line x1="17" y1="8" x2="22" y2="13"/>' +
          '<line x1="22" y1="8" x2="17" y2="13"/></svg>';
        remove.addEventListener('click', function () {
          if (window.confirm('Remove ' + m.name +
              ' and ban their IP for the rest of the stream?')) {
            socket.emit('chat:moderate_kick', { sid: m.sid });
          }
        });
        reactBar.appendChild(remove);
      }

      // Delete just this message for everyone.
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-msg-action chat-msg-mod chat-msg-delete';
      del.title = 'Delete this message for everyone';
      del.setAttribute('aria-label', 'Delete message');
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<polyline points="3 6 5 6 21 6"/>' +
        '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '<line x1="10" y1="11" x2="10" y2="17"/>' +
        '<line x1="14" y1="11" x2="14" y2="17"/></svg>';
      del.addEventListener('click', function () {
        socket.emit('chat:moderate_delete', { id: m.id });
      });
      reactBar.appendChild(del);
    }

    if (reactBar.children.length) li.appendChild(reactBar);

    return li;
  }

  // ── Reactions ───────────────────────────────────────────────────────
  // Paint the reaction chips for a message. `reactions` is the server's
  // list of { emoji, count, reactors }. A chip is highlighted when our own
  // socket id is among the reactors; clicking it toggles our reaction.
  function renderReactions(container, reactions, msgId) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!reactions || !reactions.length) { setHidden(container, true); return; }
    var mySid = socket.id;
    reactions.forEach(function (r) {
      if (!r || !r.emoji) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-reaction';
      var mine = mySid && Array.isArray(r.reactors) && r.reactors.indexOf(mySid) !== -1;
      if (mine) chip.classList.add('is-mine');
      chip.title = (mine ? 'Remove your ' : 'React with ') + r.emoji;
      var em = document.createElement('span');
      em.className = 'chat-reaction-emoji';
      em.textContent = r.emoji;
      var cnt = document.createElement('span');
      cnt.className = 'chat-reaction-count';
      cnt.textContent = String(r.count);
      chip.appendChild(em);
      chip.appendChild(cnt);
      chip.addEventListener('click', function () { sendReaction(msgId, r.emoji); });
      container.appendChild(chip);
    });
    setHidden(container, false);
  }

  // ── Full emoji palette (the "…" button) ────────────────────────────
  // A single floating popover, lazily built, reused for every message. It
  // holds a live-search box and a grid of all palette emojis.
  var palette = null;
  function buildPalette() {
    var root = document.createElement('div');
    root.className = 'chat-emoji-palette';
    setHidden(root, true);
    var search = document.createElement('input');
    search.type = 'text';
    search.className = 'chat-emoji-palette-search';
    search.placeholder = 'Search emojis…';
    search.setAttribute('aria-label', 'Search emojis');
    var grid = document.createElement('div');
    grid.className = 'chat-emoji-palette-grid';
    root.appendChild(search);
    root.appendChild(grid);
    document.body.appendChild(root);

    var p = { root: root, search: search, grid: grid, targetId: null };
    search.addEventListener('input', function () { renderPaletteGrid(p, search.value); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    });
    return p;
  }

  function renderPaletteGrid(p, term) {
    var grid = p.grid;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    term = (term || '').trim().toLowerCase();
    var data = window.CHAT_EMOJI_DATA || [];
    var shown = 0;
    for (var i = 0; i < data.length; i++) {
      var e = data[i];
      if (term && (e.name + ' ' + (e.keywords || '')).toLowerCase().indexOf(term) === -1) {
        continue;
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-emoji-palette-item';
      b.textContent = e.char;
      b.title = e.name;
      (function (ch) {
        b.addEventListener('click', function () {
          sendReaction(p.targetId, ch);
          closePalette();
        });
      })(e.char);
      grid.appendChild(b);
      shown++;
    }
    if (!shown) {
      var none = document.createElement('div');
      none.className = 'chat-emoji-palette-empty';
      none.textContent = 'No emojis match that search.';
      grid.appendChild(none);
    }
  }

  function positionPalette(anchor) {
    var root = palette.root;
    var pr = root.getBoundingClientRect();
    var ar = anchor.getBoundingClientRect();
    var pad = 8;
    var left = ar.right - pr.width;            // right-align to the "…" button
    if (left + pr.width > window.innerWidth - pad) left = window.innerWidth - pad - pr.width;
    if (left < pad) left = pad;
    var top = ar.bottom + 6;                   // prefer below the button
    if (top + pr.height > window.innerHeight - pad) {
      top = ar.top - pr.height - 6;            // not enough room → place above
      if (top < pad) top = pad;
    }
    root.style.left = Math.round(left) + 'px';
    root.style.top = Math.round(top) + 'px';
  }

  function openPalette(msgId, anchor) {
    if (!canReact()) return;
    if (!palette) palette = buildPalette();
    palette.targetId = msgId;
    palette.search.value = '';
    renderPaletteGrid(palette, '');
    setHidden(palette.root, false);
    positionPalette(anchor);
    setTimeout(function () { palette.search.focus(); }, 0);
  }
  function closePalette() {
    if (palette) setHidden(palette.root, true);
  }
  // Dismiss the palette on outside click / Escape. The "…" button's own
  // click is allowed through so it can (re)open.
  document.addEventListener('mousedown', function (e) {
    if (!palette || palette.root.hasAttribute('hidden')) return;
    if (palette.root.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.chat-react-more')) return;
    closePalette();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && palette && !palette.root.hasAttribute('hidden')) closePalette();
  });

  // Turn an already-rendered message bubble into a tombstone: drop the
  // reply quote, body text, reactions and host actions, but keep the
  // avatar + name/time so it's clear whose message was removed.
  function markRemoved(li) {
    if (!li) return;
    li.classList.add('is-removed');
    li.classList.remove('is-mention');
    var actions = li.querySelector('.chat-react-bar');
    if (actions) actions.parentNode.removeChild(actions);
    var reactions = li.querySelector('.chat-reactions');
    if (reactions) reactions.parentNode.removeChild(reactions);
    var quote = li.querySelector('.chat-msg-quote');
    if (quote) quote.parentNode.removeChild(quote);
    var body = li.querySelector('.chat-msg-body');
    var text = li.querySelector('.chat-msg-text');
    var tomb = document.createElement('div');
    tomb.className = 'chat-msg-text chat-msg-removed';
    tomb.textContent = REMOVED_TEXT;
    if (text && text.parentNode) text.parentNode.replaceChild(tomb, text);
    else if (body) body.appendChild(tomb);
  }

  function appendMessage(m) {
    // The host sits in both the chat room and the broadcaster room, so any
    // server push that targets both (chat:send, chat:moderate_clear) is
    // delivered to them twice. Skip a message we've already rendered, matched
    // by its stable id — the DOM is the source of truth, so this resets for
    // free when the list is cleared or history is rebuilt.
    if (m && m.id != null &&
        els.messages.querySelector('[data-msg-id="' + m.id + '"]')) {
      return;
    }
    var stick = nearBottom();
    els.messages.appendChild(renderMessage(m));
    // Trim the DOM at 300 messages so a long-running chat doesn't bog
    // down rendering.
    while (els.messages.children.length > 300) {
      els.messages.removeChild(els.messages.firstChild);
    }
    updateEmptyState();
    if (stick) scrollToBottom();
  }

  function renderHistory(messages) {
    els.messages.innerHTML = '';
    messages.forEach(function (m) {
      els.messages.appendChild(renderMessage(m));
    });
    updateEmptyState();
    scrollToBottom();
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // ── Wire up forms ──────────────────────────────────────────────────
  els.joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = (els.nameInput.value || '').trim();
    if (name.length < 2) {
      els.joinError.textContent = 'Pick a name with at least 2 characters.';
      setHidden(els.joinError, false);
      return;
    }
    setHidden(els.joinError, true);
    socket.emit('chat:join', { name: name });
  });

  els.composeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!state.joined || (!state.enabled && !IS_HOST)) return;
    var text = (els.composeInput.value || '').trim();
    if (!text) return;
    var payload = { text: text };
    if (state.replyTo) payload.reply_to = state.replyTo.id;
    socket.emit('chat:send', payload);
    els.composeInput.value = '';
    cancelReply();
  });

  // ── Leave chat ─────────────────────────────────────────────────────
  // Drop out of the chat and forget the remembered name; re-subscribe as
  // a read-only spectator so the messages stay visible.
  if (els.leaveBtn) {
    els.leaveBtn.addEventListener('click', function () {
      if (!state.joined) return;
      socket.emit('chat:leave');
      socket.emit('chat:watch');
      clearIdentity();
      state.joined = false;
      state.me = null;
      cancelReply();
      showReadOnlyView();
      publishChatIdentity();    // re-lock the video-reaction palette
    });
  }

  // ── Profile editor (rename + emoji) ────────────────────────────────
  function showProfileError(text) {
    if (!els.profileError) return;
    els.profileError.textContent = text;
    setHidden(els.profileError, false);
  }
  function highlightSelectedEmoji() {
    if (!els.emojiGrid) return;
    var opts = els.emojiGrid.querySelectorAll('.chat-emoji-option');
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].dataset.emoji === state.selectedEmoji;
      opts[i].classList.toggle('is-selected', on);
      opts[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  // composeMe carries data-open-modal, so modal.js opens the dialog; this
  // (target-level, fires first) seeds it with the current identity.
  if (els.composeMe) {
    els.composeMe.addEventListener('click', function () {
      if (!state.joined || !state.me) return;
      if (els.profileName) els.profileName.value = state.me.name || '';
      state.selectedEmoji = state.me.emoji || null;
      highlightSelectedEmoji();
      if (els.profileError) setHidden(els.profileError, true);
    });
  }
  if (els.emojiGrid) {
    els.emojiGrid.addEventListener('click', function (e) {
      var opt = e.target.closest('.chat-emoji-option');
      if (!opt) return;
      state.selectedEmoji = opt.dataset.emoji;
      highlightSelectedEmoji();
    });
  }
  function submitProfile() {
    if (!state.joined) return;
    var name = (els.profileName.value || '').trim();
    if (name.length < 2) { showProfileError('Pick a name with at least 2 characters.'); return; }
    if (!state.selectedEmoji) { showProfileError('Pick an icon from the grid.'); return; }
    setHidden(els.profileError, true);
    socket.emit('chat:update_profile', { name: name, emoji: state.selectedEmoji });
  }
  if (els.profileSave) els.profileSave.addEventListener('click', submitProfile);
  if (els.profileName) {
    els.profileName.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitProfile(); }
    });
  }

  // Cancel reply via the × on the banner, or by pressing Escape while
  // focused in the compose input.
  els.replyCancel.addEventListener('click', cancelReply);
  els.composeInput.addEventListener('keydown', function (e) {
    // The /re reply-picker owns the arrow keys + Enter while active.
    // Printable keys fall through: they land in the input, whose `input`
    // handler then sees the text is no longer "/re" and abandons the pick.
    if (state.replySelect) {
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveReplySelect(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveReplySelect(1);  return; }
      if (e.key === 'Enter')     { e.preventDefault(); confirmReplySelect(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); els.composeInput.value = ''; exitReplySelect(); return; }
    }
    // Mention menu takes priority over reply cancel for keyboard.
    if (state.mentionMenu) {
      var ctx = state.mentionMenu;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ctx.index = (ctx.index + 1) % ctx.items.length;
        renderMentionMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        ctx.index = (ctx.index - 1 + ctx.items.length) % ctx.items.length;
        renderMentionMenu();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMentionAt(ctx.index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionMenu();
        return;
      }
    }
    if (e.key === 'Escape' && state.replyTo) {
      e.preventDefault();
      cancelReply();
    }
  });

  // Detect / update the mention menu on every input change and on
  // cursor moves (clicks, arrow keys with no menu open). Typing exactly
  // "/r" arms the keyboard reply-picker instead.
  els.composeInput.addEventListener('input', function () {
    // Typing exactly "/re" arms the keyboard reply-picker — without wiping
    // the text. If the user keeps typing (so it's no longer "/re"), the
    // reply function is abandoned and the text is treated as a normal
    // message ("/recipe", "/regret", …).
    if (els.composeInput.value === '/re') {
      if (!state.replySelect) enterReplySelect();
      return;
    }
    if (state.replySelect) exitReplySelect();
    openOrUpdateMentionMenu();
  });
  els.composeInput.addEventListener('keyup', function (e) {
    // Only trigger on caret-moving keys to avoid double work — input
    // already handles content changes.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'Home' || e.key === 'End') {
      openOrUpdateMentionMenu();
    }
  });
  els.composeInput.addEventListener('click', openOrUpdateMentionMenu);
  els.composeInput.addEventListener('blur', function () {
    // Defer so a click on a menu item can still fire its mousedown.
    setTimeout(closeMentionMenu, 120);
    // Leaving the box abandons an in-progress /r selection.
    exitReplySelect();
  });

  // ── Server events ──────────────────────────────────────────────────
  // Read-only snapshot for viewers who haven't joined. Renders existing
  // history and leaves the join bar in place so they can opt in to send.
  socket.on('chat:watching', function (info) {
    info = info || {};
    if (info.banned) {
      // Removed earlier this stream (banned by IP) — show the locked
      // banner instead of the chat, even on a fresh page load.
      clearIdentity();
      state.banned = true;
      setHidden(els.messages, true);
      setHidden(els.empty, true);
      setHidden(els.composeForm, true);
      setHidden(els.join, false);
      setBanner('You were removed by the host. You cannot rejoin until the stream ends.', true);
      els.nameInput.disabled = true;
      els.joinForm.querySelector('button[type="submit"]').disabled = true;
      return;
    }
    // Don't disturb a session that has already joined (e.g. a late
    // watch ack after a race) — they're handled by chat:joined.
    if (state.joined) return;
    var snap = info.state || {};
    state.users = {};
    (snap.users || []).forEach(function (u) { state.users[u.sid] = u; });
    setCount((snap.users || []).length);
    renderHistory(snap.messages || []);
    setEnabled(snap.enabled !== false);
    showReadOnlyView();
  });

  socket.on('chat:joined', function (info) {
    state.joined = true;
    state.banned = false;
    state.autoJoining = false;
    state.me = info.you;
    var snap = info.state || {};
    setEnabled(snap.enabled !== false);
    // Seed the local roster from the snapshot so the @-mention
    // autocomplete has a full directory immediately on join.
    state.users = {};
    (snap.users || []).forEach(function (u) { state.users[u.sid] = u; });
    setCount((snap.users || []).length);
    renderHistory(snap.messages || []);
    showChatView();
    paintMe();
    saveIdentity(state.me);   // remember across refreshes
    publishChatIdentity();    // unlock the video-reaction palette
    setTimeout(function () { els.composeInput.focus(); }, 30);
  });

  socket.on('chat:join_failed', function (info) {
    var reason = info && info.reason;
    var wasAuto = state.autoJoining;
    state.autoJoining = false;
    // A remembered name that's now banned/invalid/taken shouldn't keep
    // auto-retrying — forget it.
    if (reason === 'banned' || reason === 'invalid_name' || reason === 'name_taken') {
      clearIdentity();
    }
    // For a silent auto-rejoin, don't nag with the join-bar error — just
    // fall back to read-only and let them rejoin by hand if they want.
    if (wasAuto) {
      if (reason === 'banned') state.banned = true;
      else socket.emit('chat:watch');
      return;
    }
    var msg = 'Could not join chat.';
    if (reason === 'banned') {
      msg = 'You have been removed from this chat by the host.';
      state.banned = true;
    } else if (reason === 'disabled') {
      msg = 'Chat is currently disabled by the host.';
    } else if (reason === 'invalid_name') {
      msg = 'That name isn\'t valid. Try 2–24 letters/digits.';
    } else if (reason === 'name_taken') {
      msg = 'Someone is already using that name. Try another.';
    }
    els.joinError.textContent = msg;
    setHidden(els.joinError, false);
  });

  socket.on('chat:message', function (m) {
    appendMessage(m);
    // Tell the viewer overlay when WE were @-mentioned so it can peek the
    // chat into view (unless the viewer has muted chat). Skip our own
    // messages. Other pages without a listener simply ignore the event.
    if (state.me && m && m.sid !== state.me.sid &&
        Array.isArray(m.mentions) && m.mentions.indexOf(state.me.sid) !== -1) {
      document.dispatchEvent(new CustomEvent('vbs:chat-mention'));
    }
  });

  socket.on('chat:user_joined', function (user) {
    if (user && user.sid) state.users[user.sid] = user;
    // Our own join is already in the snapshot count from chat:joined —
    // the room broadcast echoes back to us, so don't count it twice.
    if (state.me && user && user.sid === state.me.sid) return;
    setCount(state.members + 1);
  });
  socket.on('chat:user_left', function (who) {
    if (who && who.sid) delete state.users[who.sid];
    setCount(Math.max(0, state.members - 1));
  });

  // Someone renamed / re-emoji'd. Refresh our roster (so @-mentions and
  // future avatars use the new look). If it's us, repaint + re-persist.
  socket.on('chat:user_updated', function (user) {
    if (!user || !user.sid) return;
    state.users[user.sid] = user;
    if (state.me && user.sid === state.me.sid) {
      state.me = user;
      paintMe();
      saveIdentity(state.me);
    }
  });

  socket.on('chat:profile_updated', function (info) {
    state.me = info.you;
    if (state.me && state.me.sid) state.users[state.me.sid] = state.me;
    paintMe();
    saveIdentity(state.me);
    publishChatIdentity();    // refresh the name/avatar used on reactions
    if (window.VBSModal) window.VBSModal.close('chat-profile-modal');
  });

  socket.on('chat:profile_failed', function (info) {
    var reason = info && info.reason;
    var msg = 'Could not update your profile.';
    if (reason === 'name_taken') msg = 'Someone is already using that name. Try another.';
    else if (reason === 'invalid_name') msg = 'That name isn\'t valid. Try 2–24 letters/digits.';
    else if (reason === 'invalid_emoji') msg = 'Pick an icon from the grid.';
    showProfileError(msg);
  });

  socket.on('chat:enabled_changed', function (info) {
    setEnabled(!!(info && info.enabled));
  });

  socket.on('chat:kicked', function () {
    // We're out — hide the chat entirely and show a banner. Forget the
    // remembered identity so we don't try to auto-rejoin into the ban.
    clearIdentity();
    state.joined = false;
    state.banned = true;
    state.me = null;
    setHidden(els.composeForm, true);
    setHidden(els.messages, true);
    setHidden(els.empty, true);
    setHidden(els.join, false);
    setBanner('You were removed by the host. You cannot rejoin until the stream ends.', true);
    els.joinError.textContent = '';
    setHidden(els.joinError, true);
    els.nameInput.disabled = true;
    els.joinForm.querySelector('button[type="submit"]').disabled = true;
    publishChatIdentity();    // re-lock the video-reaction palette
  });

  socket.on('chat:reactions', function (info) {
    // Authoritative reaction state for one message — repaint its chips.
    if (!info || info.id == null) return;
    var li = els.messages.querySelector('.chat-msg[data-msg-id="' + String(info.id) + '"]');
    if (!li) return;
    var container = li.querySelector('.chat-reactions');
    if (!container) return;   // e.g. a removed message — nothing to react to
    var stick = nearBottom();
    renderReactions(container, info.reactions || [], info.id);
    if (stick) scrollToBottom();
  });

  socket.on('chat:message_removed', function (info) {
    // The host removed a single message. Gracefully slide the original
    // content down + fade it out, then swap in the "Message removed by
    // broadcaster" tombstone (keeping the author). The bubble itself
    // stays put — nothing vanishes.
    var id = info && info.id;
    if (id == null) return;
    var li = els.messages.querySelector('.chat-msg[data-msg-id="' + String(id) + '"]');
    if (!li) return;
    // Guard against the host receiving the event twice (it's in both the
    // chat and broadcaster rooms) — only animate the first time.
    if (li.classList.contains('is-removed') || li.classList.contains('is-removing')) return;
    // A removed message can no longer be a reply target in the /r picker.
    if (state.replySelect) exitReplySelect();
    li.classList.add('is-removing');
    var REMOVE_MS = 260;
    setTimeout(function () {
      var stick = nearBottom();
      li.classList.remove('is-removing');
      markRemoved(li);
      if (stick) scrollToBottom();
    }, REMOVE_MS);
  });

  socket.on('chat:cleared', function () {
    // The host rotated the access code → a fresh chat session. Wipe the
    // local history so we match the server's now-empty state.
    while (els.messages.firstChild) els.messages.removeChild(els.messages.firstChild);
    cancelReply();
    updateEmptyState();
  });

  socket.on('connect', function () {
    // On (re)connect, re-sync. If we'd already joined with a name (e.g.
    // the backend restarted under us), silently re-register so we stay
    // in the room and can keep sending — `resume` reclaims our name
    // without a "joined" announcement. Otherwise, if this browser has a
    // remembered identity (from a prior visit), silently rejoin with it
    // so a refresh doesn't make the viewer re-enter their name. Failing
    // both, subscribe read-only.
    if (state.joined && state.me) {
      socket.emit('chat:join', { name: state.me.name, emoji: state.me.emoji, resume: true });
    } else {
      var saved = !state.banned && loadIdentity();
      // The broadcaster interface always auto-joins the chat under the
      // operator's login (data-autojoin on the chat panel).
      var autoName = els.panel && els.panel.dataset ? els.panel.dataset.autojoin : '';
      if (saved) {
        state.autoJoining = true;
        socket.emit('chat:join', { name: saved.name, emoji: saved.emoji, resume: true });
      } else if (autoName && !state.banned) {
        state.autoJoining = true;
        // resume = silent (no "joined" spam on every refresh).
        socket.emit('chat:join', { name: autoName, resume: true });
      } else {
        socket.emit('chat:watch');
      }
    }
  });
  socket.on('disconnect', function () {
    // Don't reset state — when the socket comes back we want to keep
    // showing the messages we already have. Just lock the compose.
    if (state.joined) {
      els.composeInput.disabled = true;
      els.composeInput.placeholder = 'Reconnecting…';
    }
  });

  // Initial paint: read-only view (messages + join bar). The watch
  // snapshot fills in history once the socket connects.
  showReadOnlyView();
})();
