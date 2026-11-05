(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Apex cart-volume helper. One job, no writes of its own:
  //
  //   Re-trigger the cart-metafield sync after any cart mutation, by calling
  //   window.__APEX_SYNC_CART_METAFIELDS__ (defined in apex-attribution.js,
  //   which is loaded first — see snippets/apex-attribution.liquid).
  //
  // All the actual computation and writing lives in apex-attribution.js —
  // volumes are read from product metafields there, not from anything on the
  // cart form. This file only decides WHEN a resync should happen — and holds
  // a Checkout submit until the running sync has landed (onSubmit), so the
  // order copies the cart's current volumes rather than a stale write.
  //
  // Three independent triggers are wired on purpose: themes differ in how they
  // submit carts, and any one of these can be the only one that fires. The
  // shared debounce collapses the overlap into a single sync.
  //
  // window.__APEX_AUTOSYNC_SUSPENDED__ is a pause switch a coordinated,
  // multi-step cart rebuild (assets/new-enrollment.js's goToCheckout) sets
  // while it clears/re-adds/updates the cart, so a debounced resync firing on
  // a momentarily-empty or half-built cart can't race the rebuild's own final
  // sync and overwrite correct totals with zero. Automatic syncs resume once
  // that flag is cleared; it never affects the enrollment flow's own explicit
  // final sync call.
  // ---------------------------------------------------------------------------

  var DEBOUNCE_MS = 250;

  // Matches both the AJAX API paths (/cart/add.js) and the suffix-less routes
  // themes generate from routes.cart_add_url (/cart/add, possibly with a query).
  var MUTATING_PATTERN = /\/cart\/(add|change|update|clear)(\.js)?([?#]|$)/;

  var recomputeTimer = null;

  // Cart mutations and resyncs still running in this file — the parts before
  // apex-attribution.js starts its own tracking (the mutation itself, and the
  // /cart.js read that precedes the sync hook). The checkout wait needs both.
  var pending = [];

  function track(p) {
    pending.push(p);
    var done = function () {
      var i = pending.indexOf(p);
      if (i !== -1) pending.splice(i, 1);
    };
    p.then(done, done);
    return p;
  }

  function scheduleRecompute() {
    if (window.__APEX_AUTOSYNC_SUSPENDED__) return;
    if (recomputeTimer) clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(recomputeCartMetafields, DEBOUNCE_MS);
  }

  // Fetch the fresh cart and hand it to apex-attribution.js, which recomputes
  // volumes from product metafields and rewrites the apex.* cart metafields.
  // That write dedupes internally, so an unchanged cart costs one /cart.js read.
  function recomputeCartMetafields() {
    // Re-checked here, not just in scheduleRecompute: a timer armed just
    // before suspension started would otherwise still fire mid-rebuild.
    if (window.__APEX_AUTOSYNC_SUSPENDED__) return;
    if (typeof window.__APEX_SYNC_CART_METAFIELDS__ !== 'function') return;
    return track(fetch('/cart.js', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cart) {
        if (!cart || !Array.isArray(cart.items)) return;
        try {
          return window.__APEX_SYNC_CART_METAFIELDS__(cart);
        } catch (e) {}
      })
      .catch(function () {}));
  }

  // Longest a Checkout click waits on the sync before going ahead anyway —
  // a slow or failing Storefront API must never block checkout. A full sync
  // from page load measures ~2.5s on the cart page.
  var CHECKOUT_WAIT_MS = 4000;

  var checkoutPending = false;

  // Settles once no cart mutation or resync is left in this file: runs a
  // debounced resync now instead of after its timer (so a quantity edit made
  // right before Checkout is in the write being waited on), and repeats while
  // finished mutations keep scheduling new ones.
  function drainLocal() {
    if (recomputeTimer) {
      clearTimeout(recomputeTimer);
      recomputeTimer = null;
      recomputeCartMetafields();
    }
    if (!pending.length) return Promise.resolve();
    return Promise.all(pending.map(function (p) {
      return p.then(null, function () {});
    })).then(drainLocal);
  }

  function waitForSync() {
    var settled = drainLocal().then(function () {
      var wait = window.__APEX_WAIT_FOR_CART_SYNC__;
      return typeof wait === 'function' ? wait() : null;
    });
    var timeout = new Promise(function (resolve) {
      setTimeout(resolve, CHECKOUT_WAIT_MS);
    });
    return Promise.race([settled, timeout]);
  }

  function isCheckoutSubmit(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return false;
    if (e.submitter && e.submitter.name === 'checkout') return true;
    return /\/checkout/.test(form.getAttribute('action') || '');
  }

  // Resubmits with the original button so name="checkout" is still posted —
  // a bare form.submit() would drop it and land on /cart instead of checkout.
  function resubmit(form, submitter) {
    form.setAttribute('data-apex-synced', '');
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
      return;
    }
    if (submitter && submitter.name) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = submitter.name;
      input.value = submitter.value || '';
      form.appendChild(input);
    }
    form.submit();
  }

  // Trigger-independent: the cart page's Checkout is a plain form submit, and
  // without this it navigates away while the metafield write from page load
  // is still in flight (see apex-attribution.js, inflightSyncs). Capture phase
  // on document, so obo-session.js's window-level checkout block still runs
  // first and can stop the submit before this ever sees it.
  function onSubmit(e) {
    if (!isCheckoutSubmit(e)) return;
    var form = e.target;
    if (form.hasAttribute('data-apex-synced')) {
      form.removeAttribute('data-apex-synced');
      return;
    }
    e.preventDefault();
    if (checkoutPending) return;
    checkoutPending = true;
    var submitter = e.submitter || null;
    if (submitter) submitter.setAttribute('aria-busy', 'true');
    waitForSync().then(null, function () {}).then(function () {
      checkoutPending = false;
      if (submitter) submitter.removeAttribute('aria-busy');
      resubmit(form, submitter);
    });
  }

  function onQtyChange(e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT') return;
    if (t.name !== 'quantity' && !/quantity/i.test(t.name || '')) return;
    scheduleRecompute();
  }

  // Trigger 1 of 3: catches cart writes made by any script on the page,
  // including theme code this file knows nothing about.
  function wrapFetchForCartMutations() {
    if (typeof window.fetch !== 'function') return;
    if (window.__APEX_CART_FETCH_WRAPPED__) return;
    window.__APEX_CART_FETCH_WRAPPED__ = true;
    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') url = input;
      else if (input && input.url) url = input.url;
      var willMutate = MUTATING_PATTERN.test(url);
      var p = orig(input, init);
      if (willMutate) track(p.then(scheduleRecompute, function () {}));
      return p;
    };
  }

  // Trigger 2 of 3: Dawn-style themes announce cart changes over their own
  // pub/sub instead of (or as well as) a bare fetch.
  function subscribeToThemePubsub() {
    if (typeof window.subscribe !== 'function') return;
    if (typeof window.PUB_SUB_EVENTS !== 'object' || !window.PUB_SUB_EVENTS) return;
    var events = ['cartUpdate', 'cartDrawerUpdate'];
    for (var i = 0; i < events.length; i++) {
      var name = window.PUB_SUB_EVENTS[events[i]];
      if (!name) continue;
      try {
        window.subscribe(name, scheduleRecompute);
      } catch (e) {}
    }
  }

  function init() {
    // Trigger 3 of 3: quantity edits.
    document.addEventListener('change', onQtyChange);
    document.addEventListener('input', onQtyChange);
    document.addEventListener('submit', onSubmit, true);

    wrapFetchForCartMutations();
    subscribeToThemePubsub();

    // Initial pass — covers a cart that already had items on page load.
    scheduleRecompute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
