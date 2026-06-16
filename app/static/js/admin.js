// Admin shell behaviors: mobile sidebar drawer.
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var menuBtn = document.getElementById('menu-toggle');
    var side = document.querySelector('.sidebar');
    if (!menuBtn || !side) return;

    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      side.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!side.classList.contains('open')) return;
      if (side.contains(e.target) || menuBtn.contains(e.target)) return;
      side.classList.remove('open');
    });
    side.querySelectorAll('nav a').forEach(function (a) {
      a.addEventListener('click', function () { side.classList.remove('open'); });
    });
  });

  // ── Live password-strength meter ─────────────────────────────────────
  // Attaches to any input with [data-password-strength]; the meter markup
  // is its [data-pw-meter] element in the same form. Reflects the server
  // policy: 10+ chars with lower, upper, number, and a special character.
  var CHECKS = {
    len:     function (v) { return v.length >= 10; },
    lower:   function (v) { return /[a-z]/.test(v); },
    upper:   function (v) { return /[A-Z]/.test(v); },
    number:  function (v) { return /[0-9]/.test(v); },
    special: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };
  var LEVELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];

  function wireMeter(input) {
    var meter = input.form ? input.form.querySelector('[data-pw-meter]') : null;
    if (!meter) return;
    var fill = meter.querySelector('.pw-strength-fill');
    var label = meter.querySelector('[data-pw-label]');

    function update() {
      var v = input.value || '';
      if (!v) { meter.hidden = true; return; }
      meter.hidden = false;
      var met = 0;
      Object.keys(CHECKS).forEach(function (k) {
        var ok = CHECKS[k](v);
        if (ok) met++;
        var li = meter.querySelector('li[data-req="' + k + '"]');
        if (li) li.classList.toggle('is-met', ok);
      });
      if (fill) fill.style.width = (met / 5 * 100) + '%';
      meter.dataset.level = met <= 2 ? 'weak' : (met <= 4 ? 'medium' : 'strong');
      if (label) {
        label.textContent = met === 5
          ? 'Strong — meets all requirements'
          : (LEVELS[Math.max(0, met - 1)] || 'Very weak');
      }
    }
    // input fires on typing, pasting, autofill, and cut.
    input.addEventListener('input', update);
    update();
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-password-strength]').forEach(wireMeter);
  });
})();
