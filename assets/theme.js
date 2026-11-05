/* AVA theme — lightweight interactions (PDP gallery slider + zoom).
   Nav dropdown/mobile menu and accordions are pure CSS. */
(function () {
  'use strict';

  function initGallery(root) {
    var thumbs = Array.prototype.slice.call(root.querySelectorAll('[data-thumb]'));
    var slides = Array.prototype.slice.call(root.querySelectorAll('[data-main]'));
    var track = root.querySelector('[data-gal-track]');
    var stage = root.querySelector('[data-gal-stage]');
    if (!slides.length || !track) return;

    var current = 0;
    var drag = null;
    var suppressClick = false;
    var SWIPE_THRESHOLD = 40;

    function show(i, instant) {
      if (i < 0) i = slides.length - 1;
      if (i >= slides.length) i = 0;
      current = i;
      if (instant) track.classList.add('is-dragging');
      track.style.transform = 'translateX(-' + (current * 100) + '%)';
      if (instant) {
        void track.offsetWidth;
        track.classList.remove('is-dragging');
      }
      slides.forEach(function (s, k) {
        s.setAttribute('aria-hidden', k === current ? 'false' : 'true');
      });
      thumbs.forEach(function (t, k) {
        t.classList.toggle('ava-thumb--active', k === current);
      });
    }

    thumbs.forEach(function (t) {
      t.addEventListener('click', function () {
        show(parseInt(t.getAttribute('data-thumb'), 10));
      });
    });

    var prev = root.querySelector('[data-gal-prev]');
    var next = root.querySelector('[data-gal-next]');
    if (prev) prev.addEventListener('click', function () { show(current - 1); });
    if (next) next.addEventListener('click', function () { show(current + 1); });

    slides.forEach(function (slide) {
      var img = slide.querySelector('img');
      if (!img) return;
      img.addEventListener('click', function () {
        if (suppressClick) return;
        var src = img.getAttribute('data-zoom-src') || img.src;
        openZoom(src, img.alt);
      });
    });

    if (stage && slides.length > 1) {
      stage.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Don't start a drag from the nav arrows.
        if (e.target.closest && e.target.closest('.ava-galnav')) return;
        drag = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          dx: 0,
          axis: null
        };
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      });

      stage.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.startX;
        var dy = e.clientY - drag.startY;
        if (!drag.axis) {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
          drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          if (drag.axis === 'x') track.classList.add('is-dragging');
        }
        if (drag.axis !== 'x') return;
        e.preventDefault();
        drag.dx = dx;
        var width = stage.clientWidth || 1;
        var pct = (dx / width) * 100;
        track.style.transform = 'translateX(calc(-' + (current * 100) + '% + ' + pct + '%))';
      });

      function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.id)) return;
        var dx = drag.dx;
        var axis = drag.axis;
        track.classList.remove('is-dragging');
        drag = null;
        if (axis === 'x' && Math.abs(dx) >= SWIPE_THRESHOLD) {
          suppressClick = true;
          show(dx < 0 ? current + 1 : current - 1);
          setTimeout(function () { suppressClick = false; }, 50);
        } else {
          show(current);
        }
      }

      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
    }

    show(0, true);
  }

  var zoomEl = null;
  function openZoom(src, alt) {
    closeZoom();
    zoomEl = document.createElement('div');
    zoomEl.className = 'ava-zoom';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ava-zoom__x';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u2715';

    var img = document.createElement('img');
    img.src = src;
    img.alt = alt || '';

    zoomEl.appendChild(closeBtn);
    zoomEl.appendChild(img);

    zoomEl.addEventListener('click', function (e) {
      if (e.target === zoomEl || e.target.classList.contains('ava-zoom__x')) closeZoom();
    });
    document.body.appendChild(zoomEl);
    document.addEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') closeZoom(); }
  function closeZoom() {
    if (zoomEl) { zoomEl.remove(); zoomEl = null; document.removeEventListener('keydown', escClose); }
  }

  function formatMoney(cents, moneyFormat, currency) {
    cents = Math.round(Number(cents) || 0);
    if (currency && typeof Intl !== 'undefined' && Intl.NumberFormat) {
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: currency
        }).format(cents / 100);
      } catch (e) {}
    }
    var value = (cents / 100).toFixed(2);
    var format = moneyFormat || '${{amount}}';
    return format
      .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/g, value.replace('.', ','))
      .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, String(Math.round(cents / 100)))
      .replace(/\{\{\s*amount\s*\}\}/g, value);
  }

  function updateCartCount(count) {
    document.querySelectorAll('.ava-cart-count').forEach(function (el) {
      el.textContent = String(count || 0);
    });
  }
    function feeForLine(lineCents) {
    return lineCents - Math.floor(lineCents * 1000 / 1207);
  }

  function initCart(form) {
    var changeUrl = form.getAttribute('data-cart-change-url') || '/cart/change';
    var moneyFormat = form.getAttribute('data-money-format') || '${{amount}}';
    var currency = form.getAttribute('data-currency') || '';
    var pending = {};

    function changeLine(row, quantity) {
      var key = row.getAttribute('data-key');
      if (!key) return Promise.resolve(null);

      quantity = Math.max(0, parseInt(quantity, 10) || 0);
      row.classList.add('is-loading');

      if (pending[key] && pending[key].abort) {
        try { pending[key].abort(); } catch (e) {}
      }

      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      pending[key] = controller;

      return fetch(changeUrl + (changeUrl.indexOf('.js') === -1 ? '.js' : ''), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        credentials: 'same-origin',
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({ id: key, quantity: quantity })
      })
        .then(function (res) {
          if (!res.ok) throw new Error('Cart update failed');
          return res.json();
        })
        .then(function (cart) {
          if (pending[key] === controller) delete pending[key];
          applyCart(cart);
          return cart;
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return null;
          if (pending[key] === controller) delete pending[key];
          row.classList.remove('is-loading');
          console.error(err);
          return null;
        });
    }

    function applyCart(cart) {
      if (!cart) return;

      updateCartCount(cart.item_count);

      var totalEl = form.querySelector('[data-cart-total]');
      if (totalEl) totalEl.textContent = formatMoney(cart.total_price, moneyFormat, currency);

      var rows = Array.prototype.slice.call(form.querySelectorAll('[data-cart-row]'));
      var itemsByKey = {};
      (cart.items || []).forEach(function (item) {
        itemsByKey[item.key] = item;
      });

            var feeCents = 0;

      rows.forEach(function (row) {
        var key = row.getAttribute('data-key');
        var item = itemsByKey[key];
        if (!item) {
          row.remove();
          return;
        }
        row.classList.remove('is-loading');
        var qtyInput = row.querySelector('[data-cart-qty]');
        if (qtyInput && document.activeElement !== qtyInput) {
          qtyInput.value = item.quantity;
        }
        var linePrice = row.querySelector('[data-cart-line-price]');
        if (linePrice) {
          linePrice.textContent = formatMoney(item.final_line_price, moneyFormat, currency);
        }
        if (row.hasAttribute('data-fee-included')) {
          var lineFee = feeForLine(item.final_line_price);
          feeCents += lineFee;
          var lineFeeEl = row.querySelector('[data-cart-line-fee]');
          if (lineFeeEl) lineFeeEl.textContent = formatMoney(lineFee, moneyFormat, currency) + ' ' + currency;
        }
      });

      var feeEl = form.querySelector('[data-cart-fee]');
      var feeWrap = form.querySelector('[data-cart-fee-wrap]');
      if (feeEl) feeEl.textContent = formatMoney(feeCents, moneyFormat, currency) + ' ' + currency;
      if (feeWrap) feeWrap.hidden = feeCents === 0;

      if (!cart.item_count) {
        window.location.reload();
      }
    }

    form.addEventListener('click', function (e) {
      var row = e.target.closest('[data-cart-row]');
      if (!row) return;

      if (e.target.closest('[data-cart-remove]')) {
        e.preventDefault();
        changeLine(row, 0);
        return;
      }

      var qtyInput = row.querySelector('[data-cart-qty]');
      if (!qtyInput) return;
      var current = parseInt(qtyInput.value, 10) || 1;

      if (e.target.closest('[data-cart-qty-minus]')) {
        e.preventDefault();
        if (current <= 1) return;
        qtyInput.value = current - 1;
        changeLine(row, current - 1);
        return;
      }

      if (e.target.closest('[data-cart-qty-plus]')) {
        e.preventDefault();
        qtyInput.value = current + 1;
        changeLine(row, current + 1);
      }
    });

    form.addEventListener('change', function (e) {
      var input = e.target.closest('[data-cart-qty]');
      if (!input) return;
      var row = input.closest('[data-cart-row]');
      if (!row) return;
      var qty = parseInt(input.value, 10);
      if (!isFinite(qty) || qty < 1) {
        changeLine(row, 0);
        return;
      }
      changeLine(row, qty);
    });
  }

  function boot() {
    document.querySelectorAll('[data-gallery]').forEach(initGallery);
    document.querySelectorAll('[data-cart]').forEach(initCart);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
