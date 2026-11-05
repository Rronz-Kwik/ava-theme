(function () {
  'use strict';

  // Loaded site-wide (snippets/obo-session.liquid) and by the enrollment
  // section; the first copy wins.
  if (window.AvaObo) return;

  // ---------------------------------------------------------------------------
  // Enrollment OBO/OBE context.
  //
  // Reads the order-on-behalf-of context from the enrollment URL and returns it
  // as cart ATTRIBUTES for new-enrollment.js to write at checkout. Shopify
  // copies cart attributes onto the order as custom attributes
  // (order.customAttributes / REST note_attributes), where Shopify Flow reads
  // them. No token, metafield definition or admin setup is needed.
  //
  // URL parameter == cart attribute == order custom attribute key:
  //   is_obo               "true" for an on-behalf-of order
  //   customer_id          existing recipient (numeric Shopify customer id)
  //   customer_first_name  \
  //   customer_last_name    > new recipient (when customer_id is absent)
  //   customer_email       /
  //   customer_phone       optional, E.164
  //   obo_recipient_type   written by this file: existing | new | incomplete
  //
  // Affiliate-dashboard sessions (?obo_type=obo|ebo) add the NetFi keys below.
  // obo_type implies is_obo=true. The "__" prefix hides them from the shopper
  // at checkout; they still reach the order for NetFi and Flow.
  //   __netfi_obo_type                   obo | ebo            (?obo_type)
  //   __netfi_obo_recipient_uuid         OBO only             (?recipient_uuid)
  //   __netfi_obo_recipient_name         OBO and EBO          (?recipient_name)
  //   __netfi_obo_recipient_profile_url  OBO only             (?recipient_profile_url)
  //   __obo_payer_rep_did                logged-in customer's apex.rep_id
  //   __obo_started_at                   ISO time the session started
  //   __obo_sponsor_id                   EBO only: the sponsor from the link
  //                                      (sponsor_param_aliases), kept so the
  //                                      wizard stays locked to it on later pages
  //
  // A session lives on the cart, so it follows the rep around the store after
  // the link's params are gone. snippets/obo-session.liquid renders the cart's
  // copy into #obo-cart-context; assets/obo-session.js writes, shows and clears
  // it. Sessions expire SESSION_TTL_MS after __obo_started_at.
  //
  // Shopify keeps "__" attributes out of Liquid's cart.attributes and the Ajax
  // API, so the theme can't read them back. Each is written twice: the "__"
  // key for NetFi, and a readable "_" copy (MIRROR) the theme reads, e.g.
  // __netfi_obo_type -> _netfi_obo_type.
  //
  // Every key is always returned — blank ("") when not applicable — so a cart
  // reused from an earlier OBO visit has its stale context removed (blank
  // attribute values delete the attribute on /cart/update.js).
  // ---------------------------------------------------------------------------

  var KEYS = [
    'is_obo',
    'customer_id',
    'customer_first_name',
    'customer_last_name',
    'customer_email',
    'customer_phone',
    'obo_recipient_type'
  ];
  var SESSION_KEYS = [
    '__netfi_obo_type',
    '__netfi_obo_recipient_uuid',
    '__netfi_obo_recipient_name',
    '__netfi_obo_recipient_profile_url',
    '__obo_payer_rep_did',
    '__obo_started_at',
    '__obo_sponsor_id'
  ];
  var LINK_KEYS = ['obo_type', 'recipient_uuid', 'recipient_name', 'recipient_profile_url'];
  var URL_KEYS = KEYS.concat(LINK_KEYS);
  var ALL_KEYS = KEYS.concat(SESSION_KEYS);
  var SESSION_TTL_MS = 2 * 3600000;

  // The readable copy of a session key: __netfi_obo_type -> _netfi_obo_type.
  function mirror(key) {
    return key.replace(/^__/, '_');
  }
  var MAX_LEN = 255;

  function clean(value) {
    if (value == null) return '';
    var v = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    return v.slice(0, MAX_LEN);
  }

  function warn(msg) {
    try { console.warn('[Enrollment] OBO: ' + msg); } catch (e) {}
  }

  function readParams() {
    var out = {};
    try {
      // Keys matched case-insensitively, first occurrence wins.
      new URL(window.location.href).searchParams.forEach(function (value, key) {
        var k = key.toLowerCase();
        if (URL_KEYS.indexOf(k) !== -1 && !(k in out)) out[k] = clean(value);
      });
    } catch (e) {}
    return out;
  }

  function readJson(id) {
    try {
      var node = document.getElementById(id);
      return node ? JSON.parse(node.textContent) || {} : {};
    } catch (e) {
      return {};
    }
  }

  function apexConfig() {
    return window.__APEX_CONFIG__ || readJson('apex-config');
  }

  // Accepts a numeric id or a Customer GID; returns the numeric id or ''.
  function normalizeCustomerId(raw) {
    var m = String(raw || '').match(/^(?:gid:\/\/shopify\/Customer\/)?(\d{1,20})$/);
    return m ? m[1] : '';
  }

  function normalizePhone(raw) {
    if (!raw || raw.charAt(0) !== '+') return '';
    var digits = raw.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '+' + digits : '';
  }

  function normalizeType(raw) {
    var t = String(raw || '').toLowerCase();
    return t === 'obo' || t === 'ebo' ? t : '';
  }

  function normalizeUuid(raw) {
    return /^[A-Za-z0-9-]{1,64}$/.test(raw || '') ? raw : '';
  }

  function normalizeProfileUrl(raw) {
    try {
      var u = new URL(raw);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.slice(0, MAX_LEN) : '';
    } catch (e) {
      return '';
    }
  }

  // Same alias list and matching as readUrlSponsorId() in new-enrollment.js.
  function readUrlSponsorId() {
    var config = apexConfig();
    var aliases = Array.isArray(config.sponsor_param_aliases)
      ? config.sponsor_param_aliases
      : ['sponsor_id', 'ref', 'rep', 'aff', 'sponsor'];
    var normalised = {};
    try {
      new URL(window.location.href).searchParams.forEach(function (value, key) {
        normalised[key.toLowerCase()] = value.trim();
      });
    } catch (e) {}
    for (var i = 0; i < aliases.length; i++) {
      var v = normalised[String(aliases[i]).toLowerCase()];
      if (v) return v.toUpperCase();
    }
    return '';
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function blank(keys) {
    var out = {};
    for (var i = 0; i < keys.length; i++) out[keys[i]] = '';
    return out;
  }

  function buildContext(p) {
    var out = blank(KEYS);

    if (String(p.is_obo || '').toLowerCase() !== 'true') {
      if (p.customer_id || p.customer_email) warn('customer params ignored without is_obo=true');
      return out;
    }
    out.is_obo = 'true';

    var customerId = normalizeCustomerId(p.customer_id);
    if (p.customer_id && !customerId) warn('invalid customer_id ignored');
    if (customerId) {
      out.customer_id = customerId;
      out.obo_recipient_type = 'existing';
      return out;
    }

    var first = p.customer_first_name || '';
    var last = p.customer_last_name || '';
    var email = EMAIL_RE.test(p.customer_email || '') ? p.customer_email.toLowerCase() : '';
    if (p.customer_email && !email) warn('invalid customer_email ignored');
    var phone = normalizePhone(p.customer_phone);
    if (p.customer_phone && !phone) warn('invalid customer_phone ignored');

    if (first) out.customer_first_name = first;
    if (last) out.customer_last_name = last;
    if (email) out.customer_email = email;
    if (phone) out.customer_phone = phone;

    // Never pass an incomplete new-customer record off as valid.
    if (first && last && email) {
      out.obo_recipient_type = 'new';
    } else {
      out.obo_recipient_type = 'incomplete';
      warn('no customer_id and new-customer record incomplete (needs first name, last name, email)');
    }
    return out;
  }

  // The NetFi session keys for a dashboard link; all blank without ?obo_type.
  function buildSession(p) {
    var out = blank(SESSION_KEYS);
    var type = normalizeType(p.obo_type);
    if (!type) {
      if (p.obo_type) warn('unknown obo_type ignored');
      return out;
    }
    out.__netfi_obo_type = type;
    out.__netfi_obo_recipient_name = p.recipient_name || '';
    if (type === 'obo') {
      out.__netfi_obo_recipient_uuid = normalizeUuid(p.recipient_uuid);
      if (p.recipient_uuid && !out.__netfi_obo_recipient_uuid) warn('invalid recipient_uuid ignored');
      out.__netfi_obo_recipient_profile_url = normalizeProfileUrl(p.recipient_profile_url);
      if (p.recipient_profile_url && !out.__netfi_obo_recipient_profile_url) warn('invalid recipient_profile_url ignored');
    } else {
      var sponsor = readUrlSponsorId();
      out.__obo_sponsor_id = /^[A-Z]{0,2}\d+$/.test(sponsor) ? sponsor : '';
      if (sponsor && !out.__obo_sponsor_id) warn('invalid sponsor id ignored');
    }
    var customer = apexConfig().customer;
    out.__obo_payer_rep_did = clean(customer && customer.rep_id);
    return out;
  }

  function isExpired(startedAt) {
    var t = Date.parse(startedAt || '');
    return !isFinite(t) || Date.now() - t > SESSION_TTL_MS;
  }

  // Whether two contexts describe the same recipient (and EBO sponsor).
  function sameSession(a, b) {
    var keys = ['__netfi_obo_type', '__netfi_obo_recipient_uuid', '__netfi_obo_recipient_name',
      '__obo_sponsor_id', 'customer_id', 'customer_email'];
    for (var i = 0; i < keys.length; i++) {
      if ((a[keys[i]] || '') !== (b[keys[i]] || '')) return false;
    }
    return true;
  }

  // 'navigate' for a fresh visit (a click on the dashboard link); 'reload' or
  // 'back_forward' when the browser re-opens a page it already showed.
  function navigationType() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      if (nav && nav.type) return nav.type;
    } catch (e) {}
    return 'navigate';
  }

  // The cart's session, from the readable copies of the "__" keys.
  function fromCart(cart) {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) out[KEYS[i]] = clean(cart[KEYS[i]]);
    for (var j = 0; j < SESSION_KEYS.length; j++) out[SESSION_KEYS[j]] = clean(cart[mirror(SESSION_KEYS[j])]);
    return out;
  }

  // Captured once at load so step navigation can't lose it.
  var params = readParams();
  if (normalizeType(params.obo_type)) params.is_obo = 'true';
  var linkContext = buildContext(params);
  var linkSession = buildSession(params);
  for (var sk in linkSession) linkContext[sk] = linkSession[sk];

  var cart = fromCart(readJson('obo-cart-context'));
  var cartActive = Boolean(normalizeType(cart.__netfi_obo_type));
  var cartLive = cartActive && !isExpired(cart.__obo_started_at);

  var context = linkContext;
  var needsWrite = false; // the cart must take this page's link context
  var needsReset = false; // ...after its items and any earlier session are removed
  var needsClear = false; // the cart holds an expired session

  if (linkSession.__netfi_obo_type) {
    var same = cartLive && sameSession(linkContext, cart);
    if (navigationType() === 'navigate' || !cartActive) {
      // A dashboard link starts (or continues) a session. Re-opening the same
      // link keeps its start time, so it can't extend the session, and keeps
      // the cart; any other link starts from an empty cart.
      linkContext.__obo_started_at = same ? cart.__obo_started_at : new Date().toISOString();
      needsWrite = true;
      needsReset = !same;
    } else if (cartLive) {
      // A reload or back/forward to an old link: the cart wins.
      context = cart;
    } else {
      needsClear = true;
    }
  } else if (cartActive) {
    if (cartLive) context = cart;
    else needsClear = true;
  }
  if (needsClear) context = blank(ALL_KEYS);

  // The cart attributes to write: every key plus the readable "_" copies.
  function copy() {
    var out = {};
    for (var k in context) out[k] = context[k];
    for (var i = 0; i < SESSION_KEYS.length; i++) out[mirror(SESSION_KEYS[i])] = context[SESSION_KEYS[i]] || '';
    return out;
  }

  window.__ENROLLMENT_OBO_ATTRIBUTES__ = copy;

  window.AvaObo = {
    attributes: copy,
    type: function () { return context.__netfi_obo_type; },
    isActive: function () { return Boolean(context.__netfi_obo_type); },
    // A session missing what NetFi needs to place the order: checkout is blocked.
    isIncomplete: function () {
      if (context.__netfi_obo_type === 'obo') return !context.__netfi_obo_recipient_uuid;
      if (context.__netfi_obo_type === 'ebo') return !context.customer_email || !context.__netfi_obo_recipient_name;
      return false;
    },
    // EBO: the sponsor the wizard must use, or '' to let the rep pick.
    sponsorId: function () {
      return context.__netfi_obo_type === 'ebo' ? context.__obo_sponsor_id : '';
    },
    needsWrite: needsWrite,
    needsReset: needsReset,
    needsClear: needsClear,
    // The session on the cart when the page loaded (blank without one).
    cartSession: function () {
      var out = {};
      for (var k in cart) out[k] = cart[k];
      return out;
    },
    // Every attribute a session can leave on the cart.
    isOboKey: function (key) {
      return ALL_KEYS.indexOf(key) !== -1 || /^(__?netfi_obo_|__?obo_|customer_)/.test(key);
    },
    // URL params that would restart a session if the page were reloaded.
    isLinkParam: function (key) {
      var k = key.toLowerCase();
      return URL_KEYS.indexOf(k) !== -1 || k.indexOf('enrollment_') === 0;
    }
  };
})();
