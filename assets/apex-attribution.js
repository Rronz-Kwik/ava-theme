(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Apex attribution + volume engine.
  //
  // Reads its ENTIRE configuration from the `apex-config` JSON island
  // (snippets/apex-config.liquid). Nothing store-specific is hardcoded here —
  // per-store behaviour lives in shop.metafields.apex.* only.
  //
  // Resolved state is published on two deliberately overlapping paths:
  //
  //   1. Cart ATTRIBUTES via /cart/update.js
  //      Read by the order_created Shopify Flows, which write the apex.*
  //      order + customer metafields server-side.
  //
  //   2. Cart METAFIELDS via the Storefront API (cartMetafieldsSet)
  //      Copied natively onto the order at checkout for every key with a
  //      matching order metafield definition that has cartToOrderCopyable
  //      enabled. Namespace + key must match that definition EXACTLY, or the
  //      value is silently dropped at checkout.
  //
  // Volume chain (per-unit product metafield -> cart metafield -> order
  // metafield, all under the same key — product and order definitions both
  // use apex.volume1/2/3):
  //   apex.volume1 -> apex.volume1 (Qualifying Volume / QV)
  //   apex.volume2 -> apex.volume2 (Commission Volume / CV)
  //   apex.volume3 -> apex.volume3 (reserved, unused on AVA today)
  //
  // Volumes are read from each PRODUCT's own metafields via the Storefront API
  // and multiplied by line quantity. Product metafields are the stable source:
  // unlike line-item properties they are not mutated by discounts or cart
  // transforms, and unlike cart attributes they are not overwritten by other
  // apps.
  //
  // No-op unless a Storefront API token is set (Theme settings > Storefront
  // API). Volume reads additionally require apex.volume1 / apex.volume2 (and
  // apex.volume3, if ever used) to have Storefront API access enabled, or the
  // lookup returns null and every total comes back 0.
  // ---------------------------------------------------------------------------

  var CONFIG_NODE_ID = 'apex-config';

  // Storefront API version. Single point of change — bump when the store moves.
  // Cart-to-order metafield copy requires a reasonably recent version; do not
  // drop this back to an old version without re-testing that copy still works.
  var SF_VERSION = '2026-07';
  var SF_ENDPOINT = '/api/' + SF_VERSION + '/graphql.json';

  // cartMetafieldsSet accepts at most 25 metafields per request. With the OBO
  // keys the full payload can exceed that, so writes are sent in chunks of
  // this size, one after another.
  var MAX_METAFIELDS = 25;

  // All persisted state is apex_-prefixed so it can never collide with cookies
  // written by other theme systems or apps.
  var COOKIE_VISITOR = 'apex_visitor_id';
  var COOKIE_SPONSOR = 'apex_sponsor_id';
  var COOKIE_FIRST_SPONSOR = 'apex_first_sponsor_id';
  var COOKIE_UTM_SOURCE = 'apex_utm_source';
  var COOKIE_UTM_CAMPAIGN = 'apex_utm_campaign';
  var COOKIE_UTM_MEDIUM = 'apex_utm_medium';
  var COOKIE_FIRST_UTM_SOURCE = 'apex_first_utm_source';
  var COOKIE_FIRST_UTM_CAMPAIGN = 'apex_first_utm_campaign';
  var COOKIE_FIRST_UTM_MEDIUM = 'apex_first_utm_medium';
  var COOKIE_FIRST_TOUCHED_AT = 'apex_first_touched_at';
  var COOKIE_LINK_TYPE = 'apex_link_type';
  // Written by the retired ?obo_rep_id / ?obo_wallet_id capture; only deleted
  // now, so a stale payer id can't outlive it.
  var LEGACY_OBO_COOKIES = ['apex_obo_rep_id', 'apex_obo_wallet_id'];

  // OBO/EBO cart attributes (assets/enrollment-obo-context.js), mirrored as
  // obo.<attribute name without leading underscores> cart metafields — e.g.
  // __netfi_obo_type -> obo.netfi_obo_type, customer_email ->
  // obo.customer_email. Each needs a matching ORDER metafield definition
  // (single line text, cart-to-order copy on) or checkout drops it.
  var OBO_ATTR_RE = /^(__netfi_obo_|__obo_|customer_)|^(is_obo|obo_recipient_type)$/;

  var LS_PREFIX = 'apex_';
  var LS_TOUCHPOINTS = 'apex_touchpoints';
  var SS_SESSION = 'apex_session_id';
  var SS_ATTRS_HASH = 'apex_attrs_hash';
  var SS_MF_HASH = 'apex_metafields_hash';

  // ?link_type=<code> — stored as the LABEL, which is what the apex.link_type
  // order metafield expects. Unknown codes are ignored rather than guessed at.
  var LINK_TYPE_MAP = {
    '1': 'Replicated Site Link',
    '2': 'Influencer Enrollment Link',
    '3': 'Customer Share Link'
  };

  // Volume system — reads apex.volume1/2/3 (QV/CV/reserved) directly off each
  // cart product's own metafields. Written to the cart as apex.cart_lines
  // (json) and apex.volume1/2/3 (number_decimal), mirrored onto the order via
  // cart-to-order copy on those ORDER metafield definitions. Product and order
  // definitions share the same apex.volume1/2/3 keys, so this is a 1:1 copy —
  // no key translation. volume3 is plumbed generically (shared with the Kwik
  // volume structure other Apex themes use) but AVA has no volume3 data today.
  var APEX_VOLUME_FIELDS = [
    { alias: 'volume1', key: 'volume1' },
    { alias: 'volume2', key: 'volume2' },
    { alias: 'volume3', key: 'volume3' }
  ];

  // Order metafield definitions are typed. A cart metafield value must be valid
  // for its order definition's type or the copy fails, so mirror those types
  // here. Anything not listed is single_line_text_field.
  var METAFIELD_TYPES = {
    lineitemattributes: 'json',
    attribution: 'json',
    enrollment_details: 'json',
    cart_lines: 'json',
    volume1: 'number_decimal',
    volume2: 'number_decimal',
    volume3: 'number_decimal',
    touchpoint_count: 'number_integer',
    first_touched_at: 'date_time',
    last_touched_at: 'date_time'
  };

  // --- enrollment transport --------------------------------------------------
  //
  // sections/distributor-selection.liquid collects fields that have no other way
  // onto the order: the password, and any custom "Input field" block the merchant
  // adds that checkout does not itself collect. One json blob rather than a
  // metafield each — the attribution payload already runs close to
  // MAX_METAFIELDS, and every separate key would need its own order definition.
  //
  // Requires an ORDER metafield definition apex.enrollment_details (json) with
  // "Copy values from matching cart metafields" enabled, or the blob is silently
  // dropped at checkout.
  var ENROLLMENT_ATTR_RE = /^enrollment(_|$)/;

  // Enrollment attributes deliberately kept OUT of the blob: the shipping
  // address, which exists only to prefill checkout. Checkout collects it itself
  // and the shopper can correct it there, so the order — not the cart — is the
  // authoritative copy. It still reaches the order as note attributes.
  //
  // This has to be the closed set (the address) rather than the open one: the
  // "Your information" group is configured per shop from theme-editor blocks, so
  // a new field must be carried without anyone editing this list.
  var CHECKOUT_MAPPED_ATTRS = [
    'enrollment',
    'enrollment_address1',
    'enrollment_address2',
    'enrollment_city',
    'enrollment_province',
    'enrollment_zip',
    'enrollment_country',
    'enrollment_phone'
  ];

  // Enrollment fields that must reach the order but must NOT become cart
  // attributes, because /cart.js is readable by any script on the page and by any
  // app with cart access. new-enrollment.js passes them straight to the sync hook.
  // Held in memory only — never sessionStorage — and remembered across syncs so
  // the debounced re-sync in apex-cart-volume.js, which calls the hook with the
  // cart alone, cannot overwrite a complete write with one missing these. Scoped
  // to the cart token they were captured for, so they can never leak into a
  // different cart built later in the same page session.
  var extraEnrollment = null;
  var extraEnrollmentCartToken = '';

  // Every cart-metafield sync currently running on this page, from its first
  // /cart.js read to its last write. apex-cart-volume.js waits on these before
  // letting a Checkout submit leave the page — otherwise the navigation aborts
  // the write and the order copies whatever an earlier page wrote (e.g. an
  // empty cart_lines from before the item was added).
  var inflightSyncs = [];

  function trackSync(p) {
    if (!p || typeof p.then !== 'function') return p;
    inflightSyncs.push(p);
    var done = function () {
      var i = inflightSyncs.indexOf(p);
      if (i !== -1) inflightSyncs.splice(i, 1);
    };
    p.then(done, done);
    return p;
  }

  // Resolves once every sync running at call time has settled (never rejects).
  // Syncs started while waiting are picked up too.
  function waitForCartSync() {
    if (!inflightSyncs.length) return Promise.resolve();
    return Promise.all(inflightSyncs.map(function (p) {
      return p.then(null, function () {});
    })).then(waitForCartSync);
  }

  window.__APEX_WAIT_FOR_CART_SYNC__ = waitForCartSync;

  // Don't append an identical touchpoint more than once an hour.
  var TOUCHPOINT_DEDUPE_MS = 3600000;

  var DAY_MS = 86400000;

  // --- primitives ------------------------------------------------------------

  function readConfig() {
    var node = document.getElementById(CONFIG_NODE_ID);
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch (e) {
      return null;
    }
  }

  function getCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var idx = parts[i].indexOf('=');
      var k = idx === -1 ? parts[i] : parts[i].slice(0, idx);
      if (k === name) return decodeURIComponent(parts[i].slice(idx + 1));
    }
    return '';
  }

  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * DAY_MS).toUTCString();
    document.cookie =
      name + '=' + encodeURIComponent(value) +
      '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  function deleteCookie(name) {
    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
  }

  // localStorage mirror of each cookie, with its own expiry stamp so it honours
  // the same attribution window instead of living forever.
  function lsSet(name, value, days) {
    try {
      localStorage.setItem(
        LS_PREFIX + name,
        JSON.stringify({ value: value, expires_at: Date.now() + days * DAY_MS })
      );
    } catch (e) {}
  }

  function lsGet(name) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + name);
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return '';
      if (parsed.expires_at && parsed.expires_at < Date.now()) {
        localStorage.removeItem(LS_PREFIX + name);
        return '';
      }
      return parsed.value || '';
    } catch (e) {
      return '';
    }
  }

  // Cookie first, localStorage as the fallback — cookies can be cleared by
  // browser policy well before the attribution window is up.
  function readPersisted(cookieName, lsName) {
    return getCookie(cookieName) || lsGet(lsName) || '';
  }

  function writePersisted(cookieName, lsName, value, days) {
    setCookie(cookieName, value, days);
    lsSet(lsName, value, days);
  }

  function num(v) {
    if (v == null) return 0;
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      var b = new Uint8Array(16);
      window.crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = '';
      for (var i = 0; i < 16; i++) h += ('0' + b[i].toString(16)).slice(-2);
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) +
        '-' + h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      return 'apex-' + Date.now() + '-' + Math.floor(Math.random() * 1e9).toString(16);
    }
  }

  // --- identity --------------------------------------------------------------

  // The visitor id outlives the attribution window on purpose, so analytics can
  // still join sessions after a sponsor claim has expired.
  function ensureVisitorId(attrDays) {
    var existing = readPersisted(COOKIE_VISITOR, 'visitor_id');
    if (existing) return existing;
    var id = uuid();
    var days = Math.max(attrDays * 4, 365);
    writePersisted(COOKIE_VISITOR, 'visitor_id', id, days);
    return id;
  }

  function ensureSessionId() {
    try {
      var existing = sessionStorage.getItem(SS_SESSION);
      if (existing) return existing;
      var id = uuid();
      sessionStorage.setItem(SS_SESSION, id);
      return id;
    } catch (e) {
      return uuid();
    }
  }

  // --- url -------------------------------------------------------------------

  // Keys are lower-cased so ?Ref= and ?ref= both match the configured aliases.
  function readUrlParams() {
    try {
      var raw = new URL(window.location.href).searchParams;
      var out = new URLSearchParams();
      raw.forEach(function (value, key) {
        out.append(String(key).toLowerCase(), value);
      });
      return out;
    } catch (e) {
      return new URLSearchParams('');
    }
  }

  function param(params, name) {
    var v = params.get(name);
    return v && v.trim() ? v.trim() : '';
  }

  function clearAllAttribution() {
    var cookies = [
      COOKIE_SPONSOR, COOKIE_FIRST_SPONSOR,
      COOKIE_UTM_SOURCE, COOKIE_UTM_CAMPAIGN, COOKIE_UTM_MEDIUM,
      COOKIE_FIRST_UTM_SOURCE, COOKIE_FIRST_UTM_CAMPAIGN, COOKIE_FIRST_UTM_MEDIUM,
      COOKIE_FIRST_TOUCHED_AT, COOKIE_LINK_TYPE
    ];
    for (var i = 0; i < cookies.length; i++) deleteCookie(cookies[i]);
    var lsKeys = [
      'sponsor_id', 'first_sponsor_id', 'utm_source', 'utm_campaign', 'utm_medium',
      'first_utm_source', 'first_utm_campaign', 'first_utm_medium', 'link_type'
    ];
    try {
      for (var j = 0; j < lsKeys.length; j++) localStorage.removeItem(LS_PREFIX + lsKeys[j]);
      localStorage.removeItem(LS_TOUCHPOINTS);
      sessionStorage.removeItem(SS_ATTRS_HASH);
      sessionStorage.removeItem(SS_MF_HASH);
    } catch (e) {}
  }

  // --- analytics events ------------------------------------------------------

  // Consumed by the custom Customer Events pixel. Never allowed to throw.
  function publish(name, data) {
    try {
      if (window.Shopify && window.Shopify.analytics &&
          typeof window.Shopify.analytics.publish === 'function') {
        window.Shopify.analytics.publish(name, data);
      }
    } catch (e) {}
  }

  // --- capture ---------------------------------------------------------------

  // Walks the configured alias list; first param present wins. Returns the
  // sponsor in force after this load, or '' when none.
  function captureSponsor(params, aliases, days, ctx) {
    if (!aliases || !aliases.length) return readPersisted(COOKIE_SPONSOR, 'sponsor_id');

    for (var i = 0; i < aliases.length; i++) {
      var value = param(params, String(aliases[i]).toLowerCase());
      if (!value) continue;

      // A logged-in distributor cannot recruit themselves.
      if (ctx.self_referral_block && ctx.customer_apex_user_id &&
          value === ctx.customer_apex_user_id) {
        return readPersisted(COOKIE_SPONSOR, 'sponsor_id');
      }

      var prev = readPersisted(COOKIE_SPONSOR, 'sponsor_id');

      // First-touch: an already-stored sponsor keeps the credit.
      if (ctx.first_touch_model && prev) return prev;

      writePersisted(COOKIE_SPONSOR, 'sponsor_id', value, days);

      if (prev !== value) {
        publish('apex_sponsor_resolved', {
          sponsor_id: value,
          previous_sponsor_id: prev || null,
          param_key: aliases[i],
          visitor_id: ctx.visitor_id,
          session_id: ctx.session_id,
          ts: Date.now()
        });
      }
      return value;
    }

    return readPersisted(COOKIE_SPONSOR, 'sponsor_id');
  }

  // First-click values are written once and never overwritten, on their own
  // (longer) window, independent of the last-click values above.
  function captureFirstClick(sponsorValue, params, firstDays, ctx) {
    var changed = false;

    if (sponsorValue && !readPersisted(COOKIE_FIRST_SPONSOR, 'first_sponsor_id')) {
      writePersisted(COOKIE_FIRST_SPONSOR, 'first_sponsor_id', sponsorValue, firstDays);
      changed = true;
    }

    var pairs = [
      ['utm_source', COOKIE_FIRST_UTM_SOURCE, 'first_utm_source'],
      ['utm_campaign', COOKIE_FIRST_UTM_CAMPAIGN, 'first_utm_campaign'],
      ['utm_medium', COOKIE_FIRST_UTM_MEDIUM, 'first_utm_medium']
    ];
    for (var i = 0; i < pairs.length; i++) {
      var value = param(params, pairs[i][0]);
      if (value && !readPersisted(pairs[i][1], pairs[i][2])) {
        writePersisted(pairs[i][1], pairs[i][2], value, firstDays);
        changed = true;
      }
    }

    if (changed && !getCookie(COOKIE_FIRST_TOUCHED_AT)) {
      setCookie(COOKIE_FIRST_TOUCHED_AT, new Date(Date.now()).toISOString(), firstDays);
    }

    if (changed) {
      publish('apex_first_click', {
        sponsor_id: readPersisted(COOKIE_FIRST_SPONSOR, 'first_sponsor_id') || null,
        source: readPersisted(COOKIE_FIRST_UTM_SOURCE, 'first_utm_source') || null,
        campaign: readPersisted(COOKIE_FIRST_UTM_CAMPAIGN, 'first_utm_campaign') || null,
        medium: readPersisted(COOKIE_FIRST_UTM_MEDIUM, 'first_utm_medium') || null,
        first_touched_at: getCookie(COOKIE_FIRST_TOUCHED_AT) || null,
        landing_path: window.location.pathname + window.location.search,
        visitor_id: ctx.visitor_id,
        session_id: ctx.session_id
      });
    }
  }

  function captureUtm(params, days, firstWins) {
    var pairs = [
      ['utm_source', COOKIE_UTM_SOURCE, 'utm_source'],
      ['utm_campaign', COOKIE_UTM_CAMPAIGN, 'utm_campaign'],
      ['utm_medium', COOKIE_UTM_MEDIUM, 'utm_medium']
    ];
    for (var i = 0; i < pairs.length; i++) {
      var value = param(params, pairs[i][0]);
      if (!value) continue;
      if (firstWins && readPersisted(pairs[i][1], pairs[i][2])) continue;
      writePersisted(pairs[i][1], pairs[i][2], value, days);
    }
  }

  function captureLinkType(params, days, firstWins) {
    var raw = param(params, 'link_type');
    if (!raw) return;
    var label = LINK_TYPE_MAP[raw];
    if (!label) return;
    if (firstWins && readPersisted(COOKIE_LINK_TYPE, 'link_type')) return;
    writePersisted(COOKIE_LINK_TYPE, 'link_type', label, days);
  }

  // --- obo (order on behalf of) ----------------------------------------------

  // OBO/EBO sessions live on the cart (assets/enrollment-obo-context.js); this
  // file only mirrors them into obo.* metafields. The old ?obo_rep_id /
  // ?obo_wallet_id capture is retired — drop anything it left behind.
  function removeLegacyObo() {
    for (var i = 0; i < LEGACY_OBO_COOKIES.length; i++) {
      if (getCookie(LEGACY_OBO_COOKIES[i])) deleteCookie(LEGACY_OBO_COOKIES[i]);
    }
    try {
      localStorage.removeItem(LS_PREFIX + 'obo_rep_id');
      localStorage.removeItem(LS_PREFIX + 'obo_wallet_id');
    } catch (e) {}
  }

  function oboMetafieldKey(attrKey) {
    return 'obo.' + attrKey.replace(/^_+/, '');
  }

  // --- touchpoints -----------------------------------------------------------

  function readTouchpoints() {
    try {
      var parsed = JSON.parse(localStorage.getItem(LS_TOUCHPOINTS) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeTouchpoints(arr) {
    try {
      localStorage.setItem(LS_TOUCHPOINTS, JSON.stringify(arr));
    } catch (e) {}
  }

  // Drop anything outside the attribution window, then keep only the newest
  // `cap` entries.
  function pruneTouchpoints(arr, windowMs, cap) {
    var cutoff = Date.now() - windowMs;
    var fresh = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].ts > cutoff) fresh.push(arr[i]);
    }
    if (cap > 0 && fresh.length > cap) fresh = fresh.slice(fresh.length - cap);
    return fresh;
  }

  function sameTouchpoint(a, b) {
    return a.sponsor_id === b.sponsor_id &&
      (a.source || '') === (b.source || '') &&
      (a.campaign || '') === (b.campaign || '') &&
      (a.medium || '') === (b.medium || '') &&
      (a.link_type || '') === (b.link_type || '');
  }

  // Returns the appended touchpoint, or null when deduped — callers use that
  // null to decide whether to publish an event.
  function appendTouchpoint(tp, windowMs, cap) {
    var arr = readTouchpoints();
    var last = arr.length ? arr[arr.length - 1] : null;
    if (last && sameTouchpoint(last, tp) && tp.ts - last.ts < TOUCHPOINT_DEDUPE_MS) {
      return null;
    }
    arr.push(tp);
    writeTouchpoints(pruneTouchpoints(arr, windowMs, cap));
    return tp;
  }

  function maybeAppendTouchpoint(sponsorValue, params, windowMs, cap, ctx) {
    var source = param(params, 'utm_source');
    var campaign = param(params, 'utm_campaign');
    var medium = param(params, 'utm_medium');
    var linkType = ctx.link_type_tracking ? (LINK_TYPE_MAP[param(params, 'link_type')] || '') : '';

    // Nothing attributable on this load — don't record a bare pageview.
    if (!sponsorValue && !source && !campaign && !medium && !linkType) return;

    var appended = appendTouchpoint({
      ts: Date.now(),
      sponsor_id: sponsorValue || '',
      source: source,
      campaign: campaign,
      medium: medium,
      link_type: linkType,
      landing_path: window.location.pathname + window.location.search,
      referrer: document.referrer || ''
    }, windowMs, cap);

    if (appended) {
      publish('apex_touchpoint', {
        ts: appended.ts,
        sponsor_id: appended.sponsor_id || null,
        source: appended.source || null,
        campaign: appended.campaign || null,
        medium: appended.medium || null,
        link_type: appended.link_type || null,
        landing_path: appended.landing_path,
        referrer: appended.referrer || null,
        visitor_id: ctx.visitor_id,
        session_id: ctx.session_id,
        touchpoint_count: readTouchpoints().length
      });
    }
  }

  // --- cart attributes -------------------------------------------------------

  // Flat string map. Keys are apex_-prefixed except where the Flows and order
  // metafield definitions already expect a bare name.
  function buildAttributes(config, ctx) {
    var attrs = {};
    var customer = config.customer || null;

    var sponsor = readPersisted(COOKIE_SPONSOR, 'sponsor_id');
    var firstSponsor = readPersisted(COOKIE_FIRST_SPONSOR, 'first_sponsor_id');

    if (sponsor) attrs.sponsor_id = sponsor;
    if (firstSponsor) attrs.apex_first_sponsor_id = firstSponsor;

    if (customer) {
      if (customer.apex_user_id) attrs.apex_user_id = customer.apex_user_id;
      if (customer.rep_id) attrs.rep_id = customer.rep_id;
    }
    attrs.user_type = (customer && customer.user_type) || 'influencer';

    if (config.utm_capture_enabled !== false) {
      var src = readPersisted(COOKIE_UTM_SOURCE, 'utm_source');
      var camp = readPersisted(COOKIE_UTM_CAMPAIGN, 'utm_campaign');
      var med = readPersisted(COOKIE_UTM_MEDIUM, 'utm_medium');
      if (src) attrs.attribution_source = src;
      if (camp) attrs.attribution_campaign = camp;
      if (med) attrs.attribution_medium = med;

      var fSrc = readPersisted(COOKIE_FIRST_UTM_SOURCE, 'first_utm_source');
      var fCamp = readPersisted(COOKIE_FIRST_UTM_CAMPAIGN, 'first_utm_campaign');
      var fMed = readPersisted(COOKIE_FIRST_UTM_MEDIUM, 'first_utm_medium');
      if (fSrc) attrs.apex_first_source = fSrc;
      if (fCamp) attrs.apex_first_campaign = fCamp;
      if (fMed) attrs.apex_first_medium = fMed;
    }

    if (ctx.link_type_tracking) {
      var linkType = readPersisted(COOKIE_LINK_TYPE, 'link_type');
      if (linkType) attrs.apex_link_type = linkType;
    }

    var firstTouchedAt = getCookie(COOKIE_FIRST_TOUCHED_AT);
    if (firstTouchedAt) attrs.apex_first_touched_at = firstTouchedAt;

    var touchpoints = readTouchpoints();
    if (touchpoints.length) {
      attrs.apex_touchpoint_count = String(touchpoints.length);
      attrs.apex_last_touched_at = new Date(touchpoints[touchpoints.length - 1].ts).toISOString();
    }

    attrs.apex_attribution_model = config.attribution_model || 'last';
    if (ctx.visitor_id) attrs.apex_visitor_id = ctx.visitor_id;

    return attrs;
  }

  function hashAttrs(attrs) {
    var keys = Object.keys(attrs).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) parts.push(keys[i] + '=' + attrs[keys[i]]);
    return parts.join('&');
  }

  function postCartUpdate(attrs) {
    return fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ attributes: attrs })
    });
  }

  // Mirrors cart.token onto the CartToken cart attribute so it survives into
  // checkout, where the total-volumes checkout UI extension reads it (cart
  // attributes are the only cart-identifying data extensions can read there)
  // to build the Storefront cart GID for its own apex.volume2 lookup. A no-op
  // once the attribute already matches, so this costs one write per cart.
  // Resolves (never rejects) once written, so callers can finish their cart
  // writes before leaving for checkout.
  function ensureCartToken(cart) {
    var attrs = cart.attributes || {};
    if (attrs.CartToken === cart.token) return Promise.resolve();
    return postCartUpdate({ CartToken: cart.token }).then(function () {}, function () {});
  }

  function fetchCart() {
    return fetch('/cart.js', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }, function () {
      return null;
    });
  }

  // --- storefront api --------------------------------------------------------

  function sfQuery(token, query, variables) {
    return fetch(SF_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token
      },
      body: JSON.stringify({ query: query, variables: variables })
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }, function () {
      return null;
    });
  }

  // Confirms a candidate Cart owner ID is actually live, and returns the
  // confirmed id (or '' if rejected). cart(id:) is the cheapest possible
  // probe: it only returns a cart when the id — key included, if present —
  // currently resolves.
  function verifyCartOwnerId(token, ownerId) {
    var query = 'query ApexCartOwnerCheck($id: ID!) { cart(id: $id) { id } }';
    return sfQuery(token, query, { id: ownerId }).then(function (res) {
      return (res && res.data && res.data.cart && res.data.cart.id) || '';
    });
  }

  // cart.token (key included) is the confirmed-correct Storefront Cart id on
  // this store — verified directly against a live cartMetafieldsSet call, so
  // no alternate/stripped-key form is needed here. This just confirms the id
  // is still live before spending the real write on it.
  function resolveCartOwnerId(token, cartToken) {
    return verifyCartOwnerId(token, 'gid://shopify/Cart/' + cartToken);
  }

  function idFromGid(gid) {
    if (gid == null) return '';
    var m = String(gid).match(/(\d+)\s*$/);
    return m ? m[1] : String(gid);
  }

  // --- volume (QV/CV/reserved, apex.volume1/2/3) ------------------------------

  // Reads apex.volume1/2/3 for every product in the cart. Returns null (never
  // an empty/partial map) when the lookup can't be trusted — network/HTTP
  // failure, GraphQL errors, or missing data — so the caller can skip writing
  // cart_lines/volume1/2/3 rather than overwrite good totals with zero. An
  // empty cart (no ids to request) legitimately resolves to {}.
  function fetchApexVolumeMap(token, items) {
    var ids = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var pid = String(items[i].product_id || '');
      if (!pid || seen[pid]) continue;
      seen[pid] = true;
      ids.push('gid://shopify/Product/' + pid);
    }
    if (!ids.length) return Promise.resolve({});

    var fields = '';
    for (var f = 0; f < APEX_VOLUME_FIELDS.length; f++) {
      fields += APEX_VOLUME_FIELDS[f].alias +
        ': metafield(namespace: "apex", key: "' + APEX_VOLUME_FIELDS[f].key + '") { value } ';
    }
    var query =
      'query ApexVolumes($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id ' +
      fields + '} } }';

    return sfQuery(token, query, { ids: ids }).then(function (res) {
      if (res && res.errors) {
        try { console.warn('[Apex] volume1/2/3 read errors:', res.errors); } catch (e) {}
      }
      if (!res || res.errors || !res.data || !res.data.nodes) return null;
      var nodes = res.data.nodes;
      var map = {};
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!n || !n.id) continue;
        map[idFromGid(n.id)] = {
          volume1: n.volume1 ? num(n.volume1.value) : 0,
          volume2: n.volume2 ? num(n.volume2.value) : 0,
          volume3: n.volume3 ? num(n.volume3.value) : 0
        };
      }
      // Every requested id resolved to nothing — indistinguishable from "all
      // zero", so treat it as a failure too rather than write zeroed volumes.
      if (!Object.keys(map).length) return null;
      return map;
    });
  }

  // Per-line volume1/volume2/volume3 (per-unit) and volume1_total/volume2_total/
  // volume3_total (× quantity). Cart-level volume1/2/3 are always exactly Σ of
  // the *_total fields here.
  function buildApexCartLines(items, map) {
    return (items || []).map(function (item) {
      var m = map[String(item.product_id)] || { volume1: 0, volume2: 0, volume3: 0 };
      var qty = num(item.quantity);
      return {
        key: item.key,
        variant_id: item.variant_id || item.id,
        product_id: item.product_id,
        quantity: item.quantity,
        properties: item.properties || {},
        volume1: round4(m.volume1),
        volume2: round4(m.volume2),
        volume3: round4(m.volume3),
        volume1_total: round4(m.volume1 * qty),
        volume2_total: round4(m.volume2 * qty),
        volume3_total: round4(m.volume3 * qty)
      };
    });
  }

  function sumApexVolumes(lines) {
    var v1 = 0, v2 = 0, v3 = 0;
    for (var i = 0; i < lines.length; i++) {
      v1 += lines[i].volume1_total;
      v2 += lines[i].volume2_total;
      v3 += lines[i].volume3_total;
    }
    return { v1: round4(v1), v2: round4(v2), v3: round4(v3) };
  }

  // --- cart metafields -------------------------------------------------------

  // apex_user_id is genuinely named apex_user_id in the schema; every other
  // apex_-prefixed attribute drops the prefix to match its order definition.
  function metafieldKeyFor(attrKey) {
    if (attrKey === 'apex_user_id') return 'apex_user_id';
    return attrKey.indexOf('apex_') === 0 ? attrKey.slice(5) : attrKey;
  }

  function metafieldEntry(ownerId, key, value) {
    return {
      ownerId: ownerId,
      key: 'apex.' + key,
      type: METAFIELD_TYPES[key] || 'single_line_text_field',
      value: value
    };
  }

  // { password: '…' } — everything the order cannot get any other way: `extra`
  // (fields kept out of the cart entirely) plus any enrollment_* cart attribute
  // checkout does NOT collect, so a future custom field is carried without
  // touching this function. The enrollment_ prefix is stripped since the
  // metafield key already scopes it. Blank values are dropped, so a field the
  // form did not render is absent rather than "". `extra` wins on a key clash.
  // Returns null when there is nothing checkout won't already deliver.
  function enrollmentDetails(cart, extra) {
    var out = null;
    var attrs = (cart && cart.attributes) || {};
    var more = extra || {};
    var key;

    for (key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      if (!ENROLLMENT_ATTR_RE.test(key)) continue;
      if (CHECKOUT_MAPPED_ATTRS.indexOf(key) !== -1) continue;
      if (attrs[key] == null || attrs[key] === '') continue;
      if (!out) out = {};
      out[key.replace(/^enrollment_/, '')] = String(attrs[key]);
    }

    for (key in more) {
      if (!Object.prototype.hasOwnProperty.call(more, key)) continue;
      if (more[key] == null || more[key] === '') continue;
      if (!out) out = {};
      out[key.replace(/^enrollment_/, '')] = String(more[key]);
    }

    return out;
  }

  // djb2 + length. Used for the sessionStorage dedupe key so what is stored is
  // not the payload itself — the enrollment blob can carry a password, which has
  // no business sitting in sessionStorage in plaintext. A collision only costs
  // one skipped redundant write, and the length guard makes that vanishingly
  // rare.
  function digest(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + '.' + str.length;
  }

  function computeMetafields(cart, attrs, config, extra, apexVolumeMap, ownerId) {
    var metafields = [];

    // Per-line record: quantity and properties. Volume detail for each line
    // lives in the apex.cart_lines metafield below, not here.
    var lines = (cart.items || []).map(function (item) {
      return {
        key: item.key,
        variant_id: item.variant_id || item.id,
        product_id: item.product_id,
        quantity: item.quantity,
        properties: item.properties || {}
      };
    });
    metafields.push(metafieldEntry(ownerId, 'lineitemattributes', JSON.stringify(lines)));

    // Pushed early so the MAX_METAFIELDS trim below can only ever drop trailing
    // attribution attributes, never the enrollment blob or the volume data
    // below — those are the only transport the enrollment fields have, and the
    // volume data is this task's whole point.
    var enrollment = enrollmentDetails(cart, extra);
    if (enrollment) {
      metafields.push(metafieldEntry(ownerId, 'enrollment_details', JSON.stringify(enrollment)));
    }

    // Order-on-behalf-of: every OBO/EBO cart attribute, mirrored into the obo
    // namespace (see OBO_ATTR_RE). Blank ones are skipped; a cleared session's
    // metafields are deleted by __APEX_DELETE_OBO_METAFIELDS__ below.
    var oboAttrs = cart.attributes || {};
    for (var oboKey in oboAttrs) {
      if (!Object.prototype.hasOwnProperty.call(oboAttrs, oboKey)) continue;
      if (!OBO_ATTR_RE.test(oboKey) || oboAttrs[oboKey] == null || oboAttrs[oboKey] === '') continue;
      metafields.push({ ownerId: ownerId, key: oboMetafieldKey(oboKey), type: 'single_line_text_field', value: String(oboAttrs[oboKey]) });
    }

    // apexVolumeMap is null when the Storefront lookup for apex.volume1/2/3
    // failed, returned GraphQL errors, or had no data — skip writing
    // cart_lines/volume1/2/3 this cycle rather than overwrite a previously-
    // correct total with zero. A real zero volume flows through normally,
    // since it comes back as actual node data, not a failed lookup.
    // Attribution/enrollment metafields above and below still write regardless.
    if (apexVolumeMap) {
      var apexLines = buildApexCartLines(cart.items || [], apexVolumeMap);
      var apexVol = sumApexVolumes(apexLines);
      metafields.push(metafieldEntry(ownerId, 'cart_lines', JSON.stringify(apexLines)));
      metafields.push(metafieldEntry(ownerId, 'volume1', String(apexVol.v1)));
      metafields.push(metafieldEntry(ownerId, 'volume2', String(apexVol.v2)));
      metafields.push(metafieldEntry(ownerId, 'volume3', String(apexVol.v3)));
    }

    // One metafield per resolved attribution attribute.
    for (var key in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      if (attrs[key] == null || attrs[key] === '') continue;
      metafields.push(metafieldEntry(ownerId, metafieldKeyFor(key), String(attrs[key])));
    }

    // Enrollment carts are identified by the orderFrom attribute the enrollment
    // flow sets at add-to-cart time.
    var cartAttrs = cart.attributes || {};
    if (cartAttrs.orderFrom) {
      metafields.push(metafieldEntry(ownerId, 'order_type', String(cartAttrs.orderFrom)));
    }

    // Full attribution blob — keeps the touchpoint detail that the flat
    // touchpoint_count metafield throws away.
    metafields.push(metafieldEntry(ownerId, 'attribution', JSON.stringify({
      model: config.attribution_model || 'last',
      attribution_window_days: config.attribution_window_days,
      first_click_window_days: config.first_click_window_days,
      touchpoints: readTouchpoints()
    })));

    return metafields;
  }

  function writeMetafields(token, metafields) {
    // Digested, not stored verbatim: the payload can include the enrollment
    // blob, and that must never be written to sessionStorage in plaintext.
    var hash = '';
    try {
      hash = digest(JSON.stringify(metafields));
      if (sessionStorage.getItem(SS_MF_HASH) === hash) return Promise.resolve();
    } catch (e) {}

    var mutation =
      'mutation ApexCartMetafieldsSet($metafields: [CartMetafieldsSetInput!]!) {' +
      ' cartMetafieldsSet(metafields: $metafields) {' +
      ' userErrors { field message code } } }';

    function writeChunk(chunk) {
      return sfQuery(token, mutation, { metafields: chunk }).then(function (res) {
        var errs = res && res.data && res.data.cartMetafieldsSet &&
          res.data.cartMetafieldsSet.userErrors;
        if (errs && errs.length) {
          try { console.warn('[Apex] cartMetafieldsSet userErrors:', errs); } catch (e) {}
          return false;
        }
        if (res && res.errors) {
          try { console.warn('[Apex] cartMetafieldsSet errors:', res.errors); } catch (e) {}
          return false;
        }
        return Boolean(res);
      });
    }

    // One chunk at a time: concurrent writes to one cart can drop each other.
    var allOk = true;
    var chain = Promise.resolve();
    for (var i = 0; i < metafields.length; i += MAX_METAFIELDS) {
      (function (chunk) {
        chain = chain.then(function () {
          return writeChunk(chunk).then(function (ok) { if (!ok) allOk = false; });
        });
      })(metafields.slice(i, i + MAX_METAFIELDS));
    }
    return chain.then(function () {
      if (!allOk || !hash) return;
      try { sessionStorage.setItem(SS_MF_HASH, hash); } catch (e) {}
    });
  }

  // Deletes the obo.* cart metafields mirrored from the given attribute keys
  // (non-OBO keys are ignored), in one request. Used when an OBO session is
  // cleared: blanking the attributes alone would leave the metafields on the
  // cart to be copied onto the next order. Always resolves.
  function deleteOboMetafields(token, ownerId, attrKeys) {
    var keys = [];
    for (var i = 0; i < attrKeys.length; i++) {
      var key = oboMetafieldKey(attrKeys[i]);
      if (OBO_ATTR_RE.test(attrKeys[i]) && keys.indexOf(key) === -1) keys.push(key);
    }
    if (!keys.length) return Promise.resolve(true);

    var vars = [];
    var fields = [];
    var variables = { ownerId: ownerId };
    keys.forEach(function (key, n) {
      vars.push('$k' + n + ': String!');
      fields.push('d' + n + ': cartMetafieldDelete(input: { ownerId: $ownerId, key: $k' + n + ' }) {' +
        ' userErrors { field message code } }');
      variables['k' + n] = key;
    });
    var mutation = 'mutation ApexOboMetafieldsDelete($ownerId: ID!, ' + vars.join(', ') + ') { ' +
      fields.join(' ') + ' }';

    return sfQuery(token, mutation, variables).then(function (res) {
      if (!res || res.errors) {
        try { console.warn('[Apex] obo metafield delete failed:', res && res.errors); } catch (e) {}
        return false;
      }
      try { sessionStorage.removeItem(SS_MF_HASH); } catch (e) {}
      return true;
    });
  }

  // Reads volumes (when tracking is on and the cart has lines), then writes the
  // whole payload. Returns a promise so callers can await it before navigating.
  function setCartMetafield(config, cart, attrs, extra) {
    // Awaited, not fired and forgotten: an unfinished write to the cart can
    // race the writes that follow it (new-enrollment.js's checkout address).
    var tokenWrite = cart && cart.token ? ensureCartToken(cart) : Promise.resolve();

    var token = config.storefront_api_token;
    if (!token || !cart || !cart.token) return tokenWrite;

    // Every apex.* cart metafield shares one ownerId, so a wrong candidate
    // fails all of them at once with INVALID_OWNER rather than a per-key
    // error. Resolve a confirmed-live id before spending the real write on
    // it; if the current cart snapshot yields none, re-fetch once (the cart
    // itself may have moved on) and resolve again before giving up.
    return tokenWrite.then(function () {
      return resolveCartOwnerId(token, cart.token);
    }).then(function (ownerId) {
      if (ownerId) return writeForCart(cart, ownerId);

      return fetchCart().then(function (fresh) {
        if (!fresh || !fresh.token) {
          try { console.warn('[Apex] no cart owner id resolves and re-fetch failed; skipping metafield sync for this cycle'); } catch (e) {}
          return;
        }
        return resolveCartOwnerId(token, fresh.token).then(function (freshOwnerId) {
          if (!freshOwnerId) {
            try { console.warn('[Apex] no cart owner id resolves after re-fetch; skipping metafield sync for this cycle'); } catch (e) {}
            return;
          }
          return writeForCart(fresh, freshOwnerId);
        });
      });
    });

    function writeForCart(liveCart, ownerId) {
      // Remember the enrollment extras against the cart they were captured for, so
      // a later cart-mutation re-sync (which has no extras of its own) still writes
      // the complete blob rather than clobbering it with a partial one.
      if (extra) {
        extraEnrollment = extra;
        extraEnrollmentCartToken = liveCart.token;
      }
      var carryExtra = extraEnrollmentCartToken === liveCart.token ? extraEnrollment : null;

      // Volume always syncs — volume_tracking_enabled only gates the QV/CV
      // enrollment UI display (in the Liquid templates directly), never this
      // data.
      return fetchApexVolumeMap(token, liveCart.items || []).then(function (apexVolumeMap) {
        var metafields = computeMetafields(liveCart, attrs || {}, config, carryExtra, apexVolumeMap, ownerId);
        if (!metafields.length) return;
        return writeMetafields(token, metafields);
      });
    }
  }

  // --- run -------------------------------------------------------------------

  function publishIdentity(config, ctx) {
    publish('apex_identity', {
      visitor_id: ctx.visitor_id,
      session_id: ctx.session_id,
      sponsor_id: readPersisted(COOKIE_SPONSOR, 'sponsor_id') || null,
      first_sponsor_id: readPersisted(COOKIE_FIRST_SPONSOR, 'first_sponsor_id') || null,
      utm_source: readPersisted(COOKIE_UTM_SOURCE, 'utm_source') || null,
      utm_campaign: readPersisted(COOKIE_UTM_CAMPAIGN, 'utm_campaign') || null,
      utm_medium: readPersisted(COOKIE_UTM_MEDIUM, 'utm_medium') || null,
      first_touched_at: getCookie(COOKIE_FIRST_TOUCHED_AT) || null,
      link_type: (ctx.link_type_tracking && readPersisted(COOKIE_LINK_TYPE, 'link_type')) || null,
      attribution_model: config.attribution_model || 'last',
      touchpoint_count: readTouchpoints().length,
      customer_id: config.customer ? config.customer.id : null,
      apex_user_id: config.customer ? (config.customer.apex_user_id || null) : null
    });
  }

  function run() {
    var config = readConfig();
    if (!config) return;
    window.__APEX_CONFIG__ = config;

    // Single kill switch for the whole layer.
    if (config.attribution_enabled === false) return;

    var days = Number(config.attribution_window_days) || 90;
    var firstDays = Number(config.first_click_window_days) || 365;
    var cap = Number(config.touchpoint_cap);
    if (!isFinite(cap)) cap = 50;
    var windowMs = days * DAY_MS;

    var ctx = {
      visitor_id: ensureVisitorId(days),
      session_id: ensureSessionId(),
      self_referral_block: config.self_referral_block !== false,
      customer_apex_user_id: config.customer ? (config.customer.apex_user_id || '') : '',
      link_type_tracking: config.link_type_tracking !== false,
      first_touch_model: config.attribution_model === 'first'
    };

    // Re-sync hook for apex-cart-volume.js after cart mutations. Rebuilds the
    // attributes from current state so volume changes and attribution changes
    // land in one write.
    //
    // `extra` is optional and only new-enrollment.js passes it, for enrollment
    // fields that must reach the order but must not exist as cart attributes.
    window.__APEX_SYNC_CART_METAFIELDS__ = function (cart, extra) {
      var attrs = buildAttributes(config, ctx);
      if (cart) return trackSync(setCartMetafield(config, cart, attrs, extra));
      return trackSync(fetchCart().then(function (fresh) {
        if (fresh) return setCartMetafield(config, fresh, attrs, extra);
      }));
    };

    // For assets/obo-session.js when it clears a session: deletes the obo.*
    // metafields mirrored from `attrKeys`. Always resolves.
    window.__APEX_DELETE_OBO_METAFIELDS__ = function (cart, attrKeys) {
      var token = config.storefront_api_token;
      if (!token || !cart || !cart.token) return Promise.resolve(false);
      return resolveCartOwnerId(token, cart.token).then(function (ownerId) {
        return ownerId ? deleteOboMetafields(token, ownerId, attrKeys || []) : false;
      }).then(null, function () { return false; });
    };

    var params = readUrlParams();

    if (param(params, 'attribution_reset') === 'true') clearAllAttribution();

    var sponsor = captureSponsor(params, config.sponsor_param_aliases, days, ctx);
    captureFirstClick(sponsor, params, firstDays, ctx);
    if (config.utm_capture_enabled !== false) {
      captureUtm(params, days, ctx.first_touch_model);
    }
    if (ctx.link_type_tracking) {
      captureLinkType(params, days, ctx.first_touch_model);
    }
    removeLegacyObo();
    maybeAppendTouchpoint(sponsor, params, windowMs, cap, ctx);

    publishIdentity(config, ctx);

    var attrs = buildAttributes(config, ctx);
    if (!Object.keys(attrs).length) return;

    // Skip the write when nothing changed since the last page in this session.
    var hash = hashAttrs(attrs);
    var prev = '';
    try { prev = sessionStorage.getItem(SS_ATTRS_HASH) || ''; } catch (e) {}

    if (hash === prev) {
      // Attributes are already correct, but the cart lines may not be — still
      // sync the metafields so volumes stay in step.
      trackSync(fetchCart().then(function (cart) {
        if (cart) return setCartMetafield(config, cart, attrs);
      }));
      return;
    }

    trackSync(postCartUpdate(attrs).then(function (res) {
      if (!res || !res.ok) return;
      try { sessionStorage.setItem(SS_ATTRS_HASH, hash); } catch (e) {}
      // /cart/update.js returns the updated cart — reuse it instead of refetching.
      return res.json().then(function (cart) {
        if (cart) return setCartMetafield(config, cart, attrs);
      }, function () {});
    }, function () {}));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
