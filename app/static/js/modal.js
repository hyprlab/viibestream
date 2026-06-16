// Modal controller. Modals are opened by any element with
//   data-open-modal="<id>"
// and closed by any element with data-close-modal inside the modal, by
// pressing Escape, or by clicking the backdrop.
(function () {
  'use strict';

  var openModals = [];

  function lockScroll(lock) {
    document.documentElement.style.overflow = lock ? 'hidden' : '';
  }

  function open(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    var lastFocus = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    openModals.push({ id: id, lastFocus: lastFocus });
    lockScroll(true);
    // Focus first interactive element for accessibility.
    var firstInput = modal.querySelector(
      'input, select, textarea, button:not([data-close-modal])'
    );
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 30);
  }

  function close(id) {
    var modal = id
      ? document.getElementById(id)
      : (openModals.length ? document.getElementById(openModals[openModals.length - 1].id) : null);
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    var idx = -1;
    for (var i = openModals.length - 1; i >= 0; i--) {
      if (openModals[i].id === modal.id) { idx = i; break; }
    }
    var record = idx >= 0 ? openModals.splice(idx, 1)[0] : null;
    if (!openModals.length) lockScroll(false);
    if (record && record.lastFocus && typeof record.lastFocus.focus === 'function') {
      record.lastFocus.focus();
    }
  }

  // Activate a named tab/panel within a .modal. Shared by tab clicks and
  // the data-tab hint on an opener.
  function activateTab(modal, key) {
    if (!modal || !key) return;
    modal.querySelectorAll('.modal-tab').forEach(function (t) {
      var active = t.dataset.tab === key;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    modal.querySelectorAll('.modal-panel').forEach(function (p) {
      var active = p.dataset.panel === key;
      p.classList.toggle('is-active', active);
      p.hidden = !active;
    });
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open-modal]');
    if (opener) {
      e.preventDefault();
      var id = opener.getAttribute('data-open-modal');
      open(id);
      // Optional: jump straight to a named tab (e.g. "Manage users").
      if (opener.dataset.tab) {
        var root = document.getElementById(id);
        var inner = root && root.querySelector('.modal');
        activateTab(inner, opener.dataset.tab);
      }
      return;
    }
    var closer = e.target.closest('[data-close-modal]');
    if (closer) {
      e.preventDefault();
      var modalRoot = closer.closest('.modal-root');
      close(modalRoot ? modalRoot.id : null);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && openModals.length) {
      e.preventDefault();
      close();
    }
  });

  // Modal tabs — works for any modal that contains .modal-tab / .modal-panel.
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('.modal-tab');
    if (!tab) return;
    activateTab(tab.closest('.modal'), tab.dataset.tab);
  });

  // Confirm-before-submit helper used on dangerous forms.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    var msg = btn.getAttribute('data-confirm');
    // eslint-disable-next-line no-alert
    if (!window.confirm(msg)) e.preventDefault();
  });

  // Expose programmatic open/close so other scripts can drive a modal
  // (e.g. closing the chat profile editor after a successful save).
  window.VBSModal = { open: open, close: close };
})();
