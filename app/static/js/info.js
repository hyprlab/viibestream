// Now Showing modal — populates the info modal from /api/info and
// keeps it in sync with broadcaster updates pushed via stream:info.
//
// Reuse the single shared connection (window.vbsSocket) so we don't open
// another WebSocket just for the stream:info push. See static/js/socket.js.

(function () {
  'use strict';

  var els = {
    btn:        document.getElementById('info-btn'),
    btnLabel:   document.getElementById('info-btn-label'),
    poster:     document.getElementById('info-modal-poster'),
    posterEmpty:document.getElementById('info-modal-poster-empty'),
    title:      document.getElementById('info-modal-title'),
    desc:       document.getElementById('info-modal-desc'),
    imdb:       document.getElementById('info-modal-imdb'),
    trailer:    document.getElementById('info-modal-trailer'),
  };

  // The paused + offline overlay Now Showing cards mirror the modal fields.
  // Same id suffix per card, just a different prefix — fill them in lockstep.
  var cards = ['paused', 'offline'].map(function (k) {
    return {
      poster:      document.getElementById(k + '-ns-poster'),
      posterEmpty: document.getElementById(k + '-ns-poster-empty'),
      title:       document.getElementById(k + '-ns-title'),
      desc:        document.getElementById(k + '-ns-desc'),
      imdb:        document.getElementById(k + '-ns-imdb'),
      trailer:     document.getElementById(k + '-ns-trailer'),
    };
  });

  function setHidden(el, hide) {
    if (!el) return;
    if (hide) el.setAttribute('hidden', '');
    else      el.removeAttribute('hidden');
  }

  function hasAnyInfo(info) {
    if (!info) return false;
    return !!(info.title || info.description || info.imdb_url ||
              info.trailer_url || info.has_poster);
  }

  function apply(info) {
    if (!info) return;
    // Title — fall back to placeholder so the modal still looks
    // intentional if only a poster / description is set.
    els.title.textContent = info.title || 'Tonight\'s broadcast';

    // Description — empty paragraph if blank to preserve spacing.
    if (info.description) {
      els.desc.textContent = info.description;
      setHidden(els.desc, false);
    } else {
      els.desc.textContent = '';
      setHidden(els.desc, true);
    }

    // Poster — append the etag as a cache buster.
    if (info.has_poster) {
      els.poster.src = '/poster?v=' + encodeURIComponent(info.poster_etag || Date.now());
      setHidden(els.poster, false);
      setHidden(els.posterEmpty, true);
    } else {
      els.poster.removeAttribute('src');
      setHidden(els.poster, true);
      setHidden(els.posterEmpty, false);
    }

    // External links — only render the buttons when a URL is set.
    if (info.imdb_url) {
      els.imdb.href = info.imdb_url;
      setHidden(els.imdb, false);
    } else {
      els.imdb.href = '#';
      setHidden(els.imdb, true);
    }
    if (info.trailer_url) {
      els.trailer.href = info.trailer_url;
      setHidden(els.trailer, false);
    } else {
      els.trailer.href = '#';
      setHidden(els.trailer, true);
    }

    // Hide the header button entirely when nothing has been set yet,
    // so the viewer doesn't see an empty "Now Showing" prompt.
    setHidden(els.btn, !hasAnyInfo(info));
    // Label reads "NOW SHOWING: <title>" so viewers know there's info to
    // open (paired with the ⓘ icon on the button). Falls back to plain
    // "NOW SHOWING" when only a poster/description is set.
    if (info.title) {
      var t = info.title.length > 32 ? info.title.slice(0, 32) + '…' : info.title;
      els.btnLabel.textContent = 'NOW SHOWING: ' + t;
    } else {
      els.btnLabel.textContent = 'NOW SHOWING';
    }

    // Mirror everything into the paused + offline overlay cards and flag
    // whether an entry exists. stream-viewer.js shows the relevant overlay;
    // the .has-now-showing flag is what swaps the plain "Paused"/"OFF AIR"
    // message for the card (CSS-driven, see public.css).
    cards.forEach(function (c) { fillCard(c, info); });
    document.documentElement.classList.toggle('has-now-showing', hasAnyInfo(info));
  }

  // Fill one overlay Now Showing card. Same logic as the modal, pointed at
  // a card's element set.
  function fillCard(c, info) {
    if (!c || !c.title) return;
    c.title.textContent = info.title || 'Tonight\'s broadcast';

    if (info.description) {
      c.desc.textContent = info.description;
      setHidden(c.desc, false);
    } else {
      c.desc.textContent = '';
      setHidden(c.desc, true);
    }

    if (info.has_poster) {
      c.poster.src = '/poster?v=' + encodeURIComponent(info.poster_etag || Date.now());
      setHidden(c.poster, false);
      setHidden(c.posterEmpty, true);
    } else {
      c.poster.removeAttribute('src');
      setHidden(c.poster, true);
      setHidden(c.posterEmpty, false);
    }

    if (info.imdb_url) {
      c.imdb.href = info.imdb_url;
      setHidden(c.imdb, false);
    } else {
      c.imdb.href = '#';
      setHidden(c.imdb, true);
    }
    if (info.trailer_url) {
      c.trailer.href = info.trailer_url;
      setHidden(c.trailer, false);
    } else {
      c.trailer.href = '#';
      setHidden(c.trailer, true);
    }
  }

  // Initial fetch — one HTTP call so we have something to render
  // before the WebSocket pushes its first stream:info.
  fetch('/api/info', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (info) { apply(info); })
    .catch(function () { /* ignore — the page can live without it */ });

  // Live updates over the single shared connection.
  if (window.vbsSocket) {
    window.vbsSocket().on('stream:info', apply);
  }
})();
