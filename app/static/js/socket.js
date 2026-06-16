// Single shared Socket.IO connection for every page module.
//
// Socket.IO v4 does NOT reliably multiplex repeated io() calls: when io() is
// called a second time for a namespace whose socket is already connecting/
// active, the client opens a BRAND-NEW Manager + connection with its own sid.
// So chat.js, stream-viewer.js, stream-broadcaster.js and info.js each used to
// get a different sid. That breaks any server handler that resolves identity
// by request.sid across features — e.g. video reactions look up the reacting
// chat user by the socket's sid, so a reaction sent on the stream socket while
// the user joined chat on a different socket was silently dropped (it rendered
// only on the sender's own screen, never fanned out to other viewers).
//
// Fix: create exactly ONE connection here and hand the same instance to every
// module via window.vbsSocket(). Loaded right after the Socket.IO client and
// before any module that needs it.
(function () {
  'use strict';
  var socket = null;
  window.vbsSocket = function () {
    if (!socket) {
      // WebSocket-first — this deployment's proxy handles WS but not
      // Socket.IO long-polling, so polling-first makes the socket flap.
      socket = io({ transports: ['websocket', 'polling'] });
    }
    return socket;
  };
})();
