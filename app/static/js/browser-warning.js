// Reveals the playback-support warning banner (#browser-warning) when the
// browser has no MediaSource implementation at all — no MSE and no
// ManagedMediaSource (iPhones only gained the latter in iOS 17.1). Such a
// browser cannot play live streams here, period. Browsers WITH an MSE get
// no blanket warning; if the active broadcast turns out to be a format
// they can't decode, stream-viewer.js raises this same banner with a
// format-specific message. Dismissal is remembered per-browser.
(function () {
  'use strict';

  var DISMISS_KEY = 'vbs-browser-warning-dismissed';

  function init() {
    var banner = document.getElementById('browser-warning');
    if (!banner) return;

    var dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) {}
    if (dismissed || window.MediaSource || window.ManagedMediaSource) return;

    banner.hidden = false;
    document.body.classList.add('has-browser-warning');

    var close = document.getElementById('browser-warning-close');
    if (close) {
      close.addEventListener('click', function () {
        banner.hidden = true;
        document.body.classList.remove('has-browser-warning');
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
