/**
 * Geo preselect for the footer language selector.
 *
 * Runs at most once per visitor: the first time someone lands on the store we
 * map their location (Shopify resolves `localization.country` from their IP) to
 * a published language and submit the localization form for them. A manual pick
 * writes `ava_lang_choice` and switches this off permanently, and landing on a
 * localised URL (/fr/…) is treated as a deliberate choice too.
 *
 * Bots never run this, so crawlers keep seeing the URL they asked for.
 */
(function () {
  var form = document.querySelector('form[data-ava-geo-lang]');
  if (!form) return;

  var CHOICE_KEY = 'ava_lang_choice'; // written when the visitor picks by hand
  var AUTO_KEY = 'ava_lang_auto'; // written once the preselect has run

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  if (read(CHOICE_KEY) || read(AUTO_KEY)) return;

  var select = form.querySelector('.ava-lang__select');
  if (!select) return;

  var current = (form.getAttribute('data-current-locale') || '').toLowerCase();
  var country = (form.getAttribute('data-country') || '').toUpperCase();

  // Already on a localised URL — the visitor (or a shared link) asked for it.
  var path = window.location.pathname.toLowerCase();
  if (current && (path === '/' + current || path.indexOf('/' + current + '/') === 0)) return;

  var available = Array.prototype.map.call(select.options, function (option) {
    return option.value;
  });

  /** Resolve a wanted locale against what the shop actually publishes. */
  function match(wanted) {
    if (!wanted) return '';
    wanted = String(wanted).toLowerCase();
    for (var i = 0; i < available.length; i++) {
      if (available[i].toLowerCase() === wanted) return available[i];
    }
    // zh-CN and zh-TW are not interchangeable, so only fall back on the base
    // language for the regionless case (pt → pt-BR, en → en-GB, …).
    var base = wanted.split('-')[0];
    if (base === 'zh') return '';
    for (var j = 0; j < available.length; j++) {
      if (available[j].toLowerCase().split('-')[0] === base) return available[j];
    }
    return '';
  }

  // Country → language. Only the languages this theme ships locales for.
  var COUNTRY_LANG = {
    DE: 'de', AT: 'de', CH: 'de', LI: 'de',
    FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr', SN: 'fr', CI: 'fr',
    IT: 'it', SM: 'it', VA: 'it',
    PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
    ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es',
    EC: 'es', GT: 'es', CU: 'es', BO: 'es', DO: 'es', HN: 'es', PY: 'es',
    SV: 'es', NI: 'es', CR: 'es', PA: 'es', UY: 'es', PR: 'es',
    CN: 'zh-CN', SG: 'zh-CN',
    TW: 'zh-TW', HK: 'zh-TW', MO: 'zh-TW'
  };

  var target = match(COUNTRY_LANG[country]);

  // No usable country mapping (unlisted country, or a single-country market that
  // always reports the same one) — fall back to what the browser asks for.
  if (!target) {
    var browser = navigator.languages || [navigator.language];
    for (var k = 0; k < browser.length; k++) {
      var candidate = match(browser[k]);
      if (candidate) {
        target = candidate;
        break;
      }
    }
  }

  if (!target || target.toLowerCase() === current) return;

  write(AUTO_KEY, target); // before submitting, so a failed hop can't loop
  select.value = target;
  if (form.requestSubmit) {
    form.requestSubmit();
  } else {
    form.submit();
  }
})();
