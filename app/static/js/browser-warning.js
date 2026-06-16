// Reveals the Safari performance warning banner (#browser-warning). Safari
// uses WebKit's MediaSource implementation, which handles this app's live
// WebM/MSE playback less reliably than Chrome/Firefox, so we nudge Safari
// users toward a Chromium/Gecko browser. Dismissal is remembered per-browser.
(function () {
  'use strict';

  var DISMISS_KEY = 'vbs-browser-warning-dismissed';

  // True only for real Safari (desktop or iOS). Chrome, Edge, Opera, Firefox
  // and their iOS variants all include "Safari" in the UA, so exclude them
  // explicitly; genuine Safari additionally reports an Apple vendor.
  function isSafari() {
    var ua = navigator.userAgent || '';
    var vendor = navigator.vendor || '';
    if (/chrome|chromium|crios|edg|edgios|opr|opera|fxios|firefox|android|samsungbrowser/i.test(ua)) {
      return false;
    }
    return /safari/i.test(ua) && /apple/i.test(vendor);
  }

  function init() {
    var banner = document.getElementById('browser-warning');
    if (!banner) return;

    var dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) {}
    if (dismissed || !isSafari()) return;

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
