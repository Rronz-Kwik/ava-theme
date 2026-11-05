(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // OBO / EBO session (order or register for another influencer).
  //
  // A rep arrives from the affiliate dashboard with ?obo_type=obo|ebo and the
  // recipient in the URL. enrollment-obo-context.js (window.AvaObo) turns that
  // into cart attributes; this file, loaded site-wide after it by
  // snippets/obo-session.liquid, does the rest on every page:
  //
  //   1. Writes the link's session onto the cart as attributes and obo.*
  //      cart metafields (apex-attribution.js), then the recipient's address
  //      via enrollment-shipping-prefill.js (oneTimeUse), so it reaches the
  //      order from any checkout, not only the enrollment wizard. A link for
  //      a different session first empties the cart and removes the old one.
  //   2. Shows the "Shopping for / Registering {name}" banner with Clear.
  //   3. Clears the session — every OBO attribute and obo.* metafield plus the
  //      one-time address — on Clear, and on load once it is older than its
  //      2-hour TTL.
  //   4. Blocks checkout while the session lacks what NetFi needs.
  // ---------------------------------------------------------------------------

  var obo = window.AvaObo;
  if (!obo || window.AvaOboSession) return;

  var BLOCKED_CLASS = 'ava-obo-blocked';
  var CHECKOUT_SELECTOR = '[name="checkout"], a[href*="/checkout"]';
  var EXPRESS_SELECTOR = '.shopify-payment-button, shopify-accelerated-checkout, shopify-accelerated-checkout-cart';
  var VERIFY_DELAY_MS = 1500;

  function warn(msg) {
    try { console.warn('[OBO] ' + msg); } catch (e) {}
  }

  function updateAttributes(attributes) {
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ attributes: attributes })
    }).then(function (r) {
      if (!r.ok) throw new Error('cart update HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchCart() {
    return fetch('/cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; });
  }

  // /cart.js never shows the "__" attributes, so the obo.* metafields they
  // mirror into (apex-attribution.js) are synced from the session instead.
  function withSession(cart, attributes) {
    var copy = {};
    for (var k in cart) copy[k] = cart[k];
    copy.attributes = {};
    for (var a in cart.attributes || {}) copy.attributes[a] = cart.attributes[a];
    for (var s in attributes) copy.attributes[s] = attributes[s];
    return copy;
  }

  // Empties the cart's lines; its attributes, attribution included, stay.
  function emptyCart(cart) {
    var updates = {};
    (cart.items || []).forEach(function (item) { updates[item.key] = 0; });
    if (!Object.keys(updates).length) return Promise.resolve(cart);
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ updates: updates })
    }).then(function (r) {
      if (!r.ok) throw new Error('cart empty HTTP ' + r.status);
      document.querySelectorAll('.ava-cart-count').forEach(function (el) { el.textContent = '0'; });
      return r.json();
    });
  }

  // apex-cart-volume.js resyncs the cart metafields after every cart write.
  // Paused while a session is written or cleared, like the enrollment
  // wizard's rebuild: its write can land between ours and undo them (a
  // deleted obo.* metafield coming back). Our own final sync covers it.
  function pauseAutosync() { window.__APEX_AUTOSYNC_SUSPENDED__ = true; }
  function resumeAutosync() { window.__APEX_AUTOSYNC_SUSPENDED__ = false; }

  function apexConfig() {
    if (window.__APEX_CONFIG__) return window.__APEX_CONFIG__;
    try { return JSON.parse(document.getElementById('apex-config').textContent) || {}; } catch (e) { return {}; }
  }

  // --- write -----------------------------------------------------------------

  // apex-attribution.js writes the cart on the same page load, and concurrent
  // writes to one cart can drop each other: check once the dust settles and
  // write again if ours was lost.
  // A link for a different session than the cart's starts from a clean cart:
  // no lines, and none of the earlier session's attributes, metafields,
  // one-time address or EBO sponsor (unless this link uses the same one).
  // Resolves whether the cart had lines; a failure is logged and the link's
  // session is written anyway.
  function resetCart() {
    return fetchCart()
      .then(function (cart) {
        if (!cart) return false;
        var hadItems = cart.item_count > 0;
        var sponsor = (cart.attributes && cart.attributes._obo_sponsor_id) || '';
        return emptyCart(cart)
          .then(function () { return removeSession(cart, sponsor === obo.sponsorId() ? '' : sponsor); })
          .then(function () { return hadItems; });
      })
      .catch(function (err) {
        warn('cart reset failed: ' + (err && err.message));
        return false;
      });
  }

  function writeSession() {
    var attributes = obo.attributes();
    var emptied = false;
    pauseAutosync();
    function landed(cart) {
      return Boolean(cart && cart.attributes &&
        cart.attributes._netfi_obo_type === attributes.__netfi_obo_type &&
        cart.attributes._obo_started_at === attributes.__obo_started_at);
    }
    return Promise.resolve(obo.needsReset ? resetCart() : false)
      .then(function (hadItems) {
        emptied = hadItems;
        return updateAttributes(attributes);
      })
      .then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, VERIFY_DELAY_MS); });
      })
      .then(fetchCart)
      .then(function (cart) { return landed(cart) ? cart : updateAttributes(attributes); })
      .then(function (cart) {
        // Cart writes one after another: the obo.* metafields mirrored from
        // the attributes (apex-attribution.js), then the recipient's address
        // from the link (no-op without one), never saved to the rep's account.
        // After a reset, the metafields this session leaves blank are deleted
        // first: apex-attribution.js may have mirrored the old session's again
        // on this page load.
        var full = cart && withSession(cart, attributes);
        var blankKeys = Object.keys(attributes).filter(function (k) { return !attributes[k]; });
        var removeMetafields = window.__APEX_DELETE_OBO_METAFIELDS__;
        var sync = window.__APEX_SYNC_CART_METAFIELDS__;
        return Promise.resolve(full && obo.needsReset && typeof removeMetafields === 'function'
          ? removeMetafields(full, blankKeys)
          : null)
          .then(function () { return full && typeof sync === 'function' ? sync(full) : null; })
          .then(null, function () {})
          .then(function () {
            if (cart && typeof window.__ENROLLMENT_SHIPPING_PREFILL__ === 'function') {
              return window.__ENROLLMENT_SHIPPING_PREFILL__(cart);
            }
          })
          .then(function () {
            // The cart page was rendered with the lines just removed.
            if (emptied && /\/cart\/?$/.test(window.location.pathname)) window.location.reload();
          });
      })
      .catch(function (err) { warn('session write failed: ' + (err && err.message)); })
      .then(resumeAutosync);
  }

  // --- clear -----------------------------------------------------------------

  function sponsorAliases() {
    var aliases = apexConfig().sponsor_param_aliases;
    return (Array.isArray(aliases) ? aliases : ['sponsor_id', 'ref', 'rep', 'aff', 'sponsor'])
      .map(function (a) { return String(a).toLowerCase(); });
  }

  // The current URL minus the link params, so reloading it can't restart the
  // session. An EBO link's sponsor goes too: it was the recipient's sponsor,
  // not one for the rep's own shopping.
  function urlWithoutLink(wasEbo) {
    try {
      var url = new URL(window.location.href);
      var aliases = wasEbo ? sponsorAliases() : [];
      var drop = [];
      url.searchParams.forEach(function (value, key) {
        if (obo.isLinkParam(key) || aliases.indexOf(key.toLowerCase()) !== -1) drop.push(key);
      });
      drop.forEach(function (key) { url.searchParams.delete(key); });
      return url.href;
    } catch (e) {
      return window.location.pathname;
    }
  }

  // The wizard stores the EBO sponsor like any sponsor pick (cookie +
  // localStorage, see selectDistributor in new-enrollment.js). Drop it so it
  // doesn't follow the rep into their own orders.
  function forgetSponsor(id) {
    if (!id) return;
    var expired = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
    if (document.cookie.split('; ').indexOf('apex_sponsor_id=' + encodeURIComponent(id)) !== -1) {
      document.cookie = 'apex_sponsor_id' + expired;
    }
    try {
      var stored = JSON.parse(localStorage.getItem('apex_sponsor_id') || 'null');
      if (stored && stored.value === id) localStorage.removeItem('apex_sponsor_id');
      var picked = JSON.parse(localStorage.getItem('apex_enrollment_sponsor') || 'null');
      if (picked && picked.id === id) localStorage.removeItem('apex_enrollment_sponsor');
      sessionStorage.removeItem('apex_attrs_hash');
    } catch (e) {}
  }

  // Removes every OBO attribute (the "__" keys blind, as /cart.js never shows
  // them), the obo.* metafields mirrored from them and the one-time delivery
  // address. `sponsor`, an EBO session's, goes too.
  function removeSession(cart, sponsor) {
    var current = (cart && cart.attributes) || {};
    var attributes = obo.attributes();
    var key;
    for (key in attributes) attributes[key] = '';
    for (key in current) if (obo.isOboKey(key)) attributes[key] = '';
    if (sponsor && current.sponsor_id === sponsor) attributes.sponsor_id = '';

    return updateAttributes(attributes).then(function () {
      forgetSponsor(sponsor);
      // The obo.* metafields mirrored from those attributes, then the
      // one-time address — one cart write after another.
      var removeMetafields = window.__APEX_DELETE_OBO_METAFIELDS__;
      var removeAddress = window.__ENROLLMENT_SHIPPING_PREFILL_REMOVE__;
      return Promise.resolve(cart && typeof removeMetafields === 'function'
        ? removeMetafields(cart, Object.keys(attributes))
        : true)
        .then(function () {
          return cart && typeof removeAddress === 'function' ? removeAddress(cart) : true;
        });
    });
  }

  var clearing = false;

  // Removes the session, then reloads without the link params. On failure
  // nothing reloads (an automatic clear would otherwise loop) and the next
  // page load tries again.
  function clear() {
    if (clearing) return Promise.resolve(false);
    clearing = true;
    setClearBusy(true);
    pauseAutosync();

    return fetchCart()
      .then(function (cart) {
        var current = (cart && cart.attributes) || {};
        var wasEbo = current._netfi_obo_type === 'ebo' || obo.type() === 'ebo';
        var sponsor = current._obo_sponsor_id || obo.sponsorId();
        return removeSession(cart, sponsor).then(function () {
          window.location.replace(urlWithoutLink(wasEbo));
          return true;
        });
      })
      .catch(function (err) {
        warn('clear failed: ' + (err && err.message));
        clearing = false;
        resumeAutosync();
        setClearBusy(false);
        return false;
      });
  }

  // --- banner ----------------------------------------------------------------

  function banner() {
    return document.getElementById('ava-obo-banner');
  }

  function setClearBusy(busy) {
    var el = banner();
    var btn = el && el.querySelector('[data-obo-clear]');
    if (btn) btn.disabled = busy;
  }

  function recipientName(a) {
    return a.__netfi_obo_recipient_name ||
      [a.customer_first_name, a.customer_last_name].filter(Boolean).join(' ') ||
      a.customer_email || '';
  }

  // Keeps the sticky header below the sticky banner.
  function syncHeight(el) {
    document.documentElement.style.setProperty('--ava-obo-banner-h', el.hidden ? '0px' : el.offsetHeight + 'px');
  }

  function renderBanner() {
    var el = banner();
    if (!el) return;
    if (!obo.isActive()) {
      el.hidden = true;
      syncHeight(el);
      return;
    }
    var template = el.getAttribute(obo.type() === 'ebo' ? 'data-label-ebo' : 'data-label-obo') || '';
    var text = el.querySelector('[data-obo-banner-text]');
    if (text) text.textContent = template.replace('%NAME%', recipientName(obo.attributes()));
    var notice = el.querySelector('[data-obo-banner-incomplete]');
    if (notice) notice.hidden = !obo.isIncomplete();
    el.hidden = false;
    syncHeight(el);

    var btn = el.querySelector('[data-obo-clear]');
    if (btn && !btn.__oboBound) {
      btn.__oboBound = true;
      btn.addEventListener('click', clear);
    }
    window.addEventListener('resize', function () { syncHeight(el); });
  }

  // --- checkout guard --------------------------------------------------------

  function incompleteMessage() {
    var el = banner();
    return (el && el.getAttribute('data-incomplete')) ||
      'Details for this order are incomplete — please start again from your dashboard.';
  }

  function disableCheckoutButtons() {
    document.querySelectorAll(CHECKOUT_SELECTOR).forEach(function (btn) {
      if (btn.__oboBlocked) return;
      btn.__oboBlocked = true;
      if ('disabled' in btn) btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
      var note = document.createElement('p');
      note.className = 'ava-obo-incomplete';
      note.setAttribute('role', 'alert');
      note.textContent = incompleteMessage();
      btn.insertAdjacentElement('afterend', note);
    });
  }

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Disables the cart's checkout buttons (also ones rendered later, e.g. by a
  // cart drawer) and hides dynamic checkout buttons (CSS, snippets/
  // obo-session.liquid). The capture-phase listeners catch anything that is
  // still clicked or submitted.
  function blockCheckout() {
    document.documentElement.classList.add(BLOCKED_CLASS);
    disableCheckoutButtons();
    if (window.MutationObserver) {
      new MutationObserver(disableCheckoutButtons).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest(CHECKOUT_SELECTOR + ', ' + EXPRESS_SELECTOR)) stop(e);
    }, true);
    window.addEventListener('submit', function (e) {
      var form = e.target;
      var action = (form && form.getAttribute && form.getAttribute('action')) || '';
      if ((e.submitter && e.submitter.name === 'checkout') || /\/checkout/.test(action)) stop(e);
    }, true);
  }

  // --- run -------------------------------------------------------------------

  window.AvaOboSession = { clear: clear };

  function run() {
    if (obo.needsClear) {
      clear();
      return;
    }
    renderBanner();
    if (obo.isActive() && obo.isIncomplete()) blockCheckout();
    if (obo.needsWrite) writeSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
