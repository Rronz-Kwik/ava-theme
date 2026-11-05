/**
 * China enrollment Shipping step (snippets/enrollment-shipping.liquid)
 * ===================================================================
 * 1. Loads Province -> City -> District choices from Ava Attribution App's
 *    app proxy (GET {proxy}/options), built from the synced ByDesign data.
 * 2. On Continue, validates the whole address there (POST {proxy}/validate):
 *    the same rules as checkout, plus the district must belong to the city.
 *    A logged-in customer can save it as their default address (the app does
 *    that through the Admin API, only for the customer Shopify signs).
 * 3. Before checkout (applyToCart, called by new-enrollment.js), prefills the
 *    cart's delivery address through enrollment-shipping-prefill.js (the one
 *    writer of it; new-enrollment.js skips its URL prefill while this step is
 *    on) and stores the district as the cn_shipping_district cart metafield.
 *    With a simple
 *    key, cartMetafieldsSet writes to the token's app-reserved namespace:
 *    Ava Attribution App's, since its Storefront token is the one in Theme
 *    settings > Storefront API. That is the value the app's checkout district
 *    picker preselects, and checkout validates both again.
 *
 * OBO/OBE (enrollment-obo-context.js, is_obo=true): the order ships to the
 * recipient, so the form starts from the recipient's address in the enrollment
 * URL (enrollment-shipping-prefill.js parses it), never the payer's saved
 * address; "save as default" is off and the cart address is one-time use.
 *
 * Only for the China market: the step is enabled when Shopify's market
 * country (localization.country, also used by the language selector) is CN.
 * Otherwise isEnabled() is false and new-enrollment.js keeps its original flow.
 *
 * new-enrollment.js uses window.AvaEnrollmentShipping:
 *   isEnabled(), isValid(), validate() -> Promise<boolean>, applyToCart(cart) -> Promise
 */
(function (root) {
  'use strict';

  var SF_ENDPOINT = '/api/2026-07/graphql.json'; // same version as apex-attribution.js
  var DISTRICT_KEY = 'cn_shipping_district';
  var ADDRESS_FIELDS = ['firstName', 'lastName', 'phone', 'address1', 'address2', 'city', 'provinceCode', 'zip'];

  // --- pure helpers (unit tested in tests/enrollment-shipping.test.js) ------

  /** Whether enrollment in this market country gets the Shipping step. */
  function appliesToCountry(country) {
    return String(country || '').toUpperCase() === 'CN';
  }

  function findProvince(options, code) {
    var list = (options && options.provinces) || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  function citiesFor(options, provinceCode) {
    var province = findProvince(options, provinceCode);
    return province ? province.cities : [];
  }

  function districtsFor(options, provinceCode, city) {
    var cities = citiesFor(options, provinceCode);
    for (var i = 0; i < cities.length; i++) if (cities[i].name === city) return cities[i].districts || [];
    return [];
  }

  /** Validated address -> Storefront CartDeliveryAddressInput (empty fields left out). */
  function cartDeliveryAddress(address) {
    var out = { countryCode: 'CN' };
    for (var i = 0; i < ADDRESS_FIELDS.length; i++) {
      var key = ADDRESS_FIELDS[i];
      if (address && address[key]) out[key] = address[key];
    }
    return out;
  }

  /**
   * URL address (a CartDeliveryAddressInput from enrollment-shipping-prefill.js)
   * -> form values, or null when there is no mainland China address to start from.
   */
  function recipientFormValues(address) {
    if (!address || String(address.countryCode || '').toUpperCase() !== 'CN') return null;
    var out = {};
    for (var i = 0; i < ADDRESS_FIELDS.length; i++) out[ADDRESS_FIELDS[i]] = address[ADDRESS_FIELDS[i]] || '';
    return out;
  }

  /**
   * Whether the cart's selected delivery address (Storefront cart.delivery.addresses)
   * is the one we wrote. Returns field NAMES only, never values, so it can be logged.
   */
  function checkSelectedAddress(addresses, wanted) {
    var list = addresses || [];
    var selected = list.filter(function (a) { return a && a.selected; });
    var actual = selected.length === 1 ? selected[0].address || {} : null;
    var mismatched = [];
    if (actual) {
      for (var key in wanted) {
        if (String(actual[key] || '').trim() !== String(wanted[key] || '').trim()) mismatched.push(key);
      }
    }
    return { ok: Boolean(actual) && mismatched.length === 0, addressCount: list.length, selectedCount: selected.length, mismatched: mismatched };
  }

  /** Whether the OBO context (enrollment-obo-context.js) marks an on-behalf-of order. */
  function isOboContext(attributes) {
    return Boolean(attributes && attributes.is_obo === 'true');
  }

  var helpers = {
    appliesToCountry: appliesToCountry,
    citiesFor: citiesFor,
    districtsFor: districtsFor,
    cartDeliveryAddress: cartDeliveryAddress,
    recipientFormValues: recipientFormValues,
    checkSelectedAddress: checkSelectedAddress,
    isOboContext: isOboContext
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
    return;
  }

  // --- browser ---------------------------------------------------------------

  var rootEl = document.querySelector('[data-enroll-shipping]');
  if (rootEl && !appliesToCountry(rootEl.getAttribute('data-country'))) rootEl = null; // not the China market
  var form = rootEl && rootEl.querySelector('[data-shipping-form]');
  var proxy = rootEl ? (rootEl.getAttribute('data-proxy-path') || '/apps/ava-china-address').replace(/\/+$/, '') : '';
  var locale = rootEl ? rootEl.getAttribute('data-locale') || '' : '';

  var options = null;
  var optionsPromise = null;
  var validated = null; // { address, districtSelection } of the last successful validation
  var isObo = isOboContext(typeof root.__ENROLLMENT_OBO_ATTRIBUTES__ === 'function' ? root.__ENROLLMENT_OBO_ATTRIBUTES__() : null);
  // Province/city to preselect once the options load (the Liquid prefill is the
  // logged-in customer's default address; startFromUrlAddress may replace it).
  var prefillProvince = form ? form.getAttribute('data-prefill-province') : null;
  var prefillCity = form ? form.getAttribute('data-prefill-city') : null;

  // Translated in the snippet (locales enrollment.shipping.*); English fallback.
  var T = {
    selectProvince: 'Select a province', selectCity: 'Select a city', selectProvinceFirst: 'Select a province first',
    selectDistrict: 'Select a district', selectCityFirst: 'Select a city first', noDistricts: 'Not needed',
    loadFailed: "We couldn't load the address options. Please try again.",
    validateFailed: "We couldn't check your address right now. Please try again.",
    fixErrors: 'Please fix the highlighted fields.', checking: 'Checking…'
  };
  try {
    var messagesNode = rootEl && rootEl.querySelector('[data-shipping-messages]');
    var messages = messagesNode ? JSON.parse(messagesNode.textContent) : {};
    for (var key in T) if (messages[key]) T[key] = messages[key];
  } catch (e) {}

  function el(name) { return form && form.elements[name]; }

  function setStatus(message) {
    var node = rootEl && rootEl.querySelector('[data-shipping-status]');
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function setFieldError(field, message) {
    var node = form && form.querySelector('[data-error-for="' + field + '"]');
    var input = field === 'city' && el('cityText') && !el('cityText').hidden ? el('cityText') : el(field);
    if (node) {
      node.textContent = message || '';
      node.hidden = !message;
    }
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function clearErrors() {
    if (!form) return;
    var nodes = form.querySelectorAll('[data-error-for]');
    for (var i = 0; i < nodes.length; i++) setFieldError(nodes[i].getAttribute('data-error-for'), '');
    setStatus('');
  }

  function fillSelect(select, placeholder, values, current) {
    select.innerHTML = '';
    var first = document.createElement('option');
    first.value = '';
    first.textContent = placeholder;
    select.appendChild(first);
    for (var i = 0; i < values.length; i++) {
      var option = document.createElement('option');
      option.value = values[i].value;
      option.textContent = values[i].label;
      select.appendChild(option);
    }
    select.value = current && values.some(function (v) { return v.value === current; }) ? current : '';
    select.disabled = values.length === 0;
  }

  function districtEnabled() {
    return Boolean(options && options.settings && options.settings.districtPicker);
  }

  function renderCities(preferred) {
    var provinceCode = el('provinceCode').value;
    var cities = citiesFor(options, provinceCode);
    var useText = Boolean(provinceCode) && cities.length === 0;
    el('city').hidden = useText;
    el('cityText').hidden = !useText;
    fillSelect(
      el('city'),
      provinceCode ? T.selectCity : T.selectProvinceFirst,
      cities.map(function (c) { return { value: c.name, label: c.name }; }),
      preferred
    );
    if (useText && preferred) el('cityText').value = preferred;
    renderDistricts();
  }

  function renderDistricts(preferred) {
    var field = form.querySelector('[data-district-field]');
    if (!districtEnabled()) {
      if (field) field.hidden = true;
      return;
    }
    if (field) field.hidden = false;
    var city = el('city').hidden ? '' : el('city').value;
    var districts = districtsFor(options, el('provinceCode').value, city);
    fillSelect(
      el('district'),
      !city ? T.selectCityFirst : districts.length ? T.selectDistrict : T.noDistricts,
      districts.map(function (d) { return { value: d, label: d }; }),
      preferred
    );
    var star = form.querySelector('[data-district-required]');
    if (star) star.hidden = !(options.settings.requireDistrict && districts.length);
  }

  function loadOptions() {
    if (optionsPromise) return optionsPromise;
    optionsPromise = fetch(proxy + '/options' + (locale ? '?locale=' + encodeURIComponent(locale) : ''), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        options = data;
        var provinceSelect = el('provinceCode');
        fillSelect(
          provinceSelect,
          T.selectProvince,
          (data.provinces || []).map(function (p) { return { value: p.code, label: p.name }; }),
          prefillProvince
        );
        renderCities(prefillCity);
        setStatus('');
        return data;
      })
      .catch(function (err) {
        optionsPromise = null; // allow a retry
        try { console.warn('[EnrollmentShipping] options failed:', err); } catch (e) {}
        setStatus(T.loadFailed);
        throw err;
      });
    return optionsPromise;
  }

  function readForm() {
    var useText = !el('cityText').hidden;
    var address = {
      countryCode: 'CN',
      lastName: el('lastName').value,
      firstName: el('firstName').value,
      phone: el('phone').value,
      provinceCode: el('provinceCode').value,
      city: useText ? el('cityText').value : el('city').value,
      district: districtEnabled() ? el('district').value : '',
      address1: el('address1').value,
      address2: el('address2').value,
      zip: el('zip').value
    };
    return address;
  }

  function validate() {
    if (!form) return Promise.resolve(true);
    clearErrors();
    return loadOptions().then(function () {
      var save = el('saveAsDefault');
      setStatus(T.checking);
      return fetch(proxy + '/validate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        // Never save an OBO recipient's address as the payer's default.
        body: JSON.stringify({ address: readForm(), locale: locale, saveAsDefault: !isObo && Boolean(save && save.checked) })
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (result) {
      setStatus('');
      if (!result.ok) {
        validated = null;
        (result.errors || []).forEach(function (e) { setFieldError(e.field, e.message); });
        setStatus(T.fixErrors);
        return false;
      }
      validated = { address: result.address, districtSelection: result.districtSelection || null };
      return true;
    }).catch(function (err) {
      validated = null;
      try { console.warn('[EnrollmentShipping] validation failed:', err); } catch (e) {}
      setStatus(options ? T.validateFailed : T.loadFailed);
      return false;
    });
  }

  // --- cart prefill (Storefront API) ------------------------------------------

  function storefrontToken() {
    var node = document.getElementById('apex-config');
    try {
      return (node && JSON.parse(node.textContent).storefront_api_token) || '';
    } catch (e) {
      return '';
    }
  }

  function sfQuery(token, query, variables) {
    return fetch(SF_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': token },
      body: JSON.stringify({ query: query, variables: variables })
    }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; });
  }

  // Error codes and field paths only: GraphQL messages can echo input values.
  function errorSummary(res, payloadKey) {
    if (!res) return [{ code: 'NO_RESPONSE' }];
    var errs = res.errors || (res.data && res.data[payloadKey] && res.data[payloadKey].userErrors) || [];
    return errs.map(function (e) {
      return { code: e.code || (e.extensions && e.extensions.code) || '', field: e.field || e.path || null };
    });
  }

  function warnErrors(label, res, payloadKey) {
    var errs = errorSummary(res, payloadKey);
    if (errs.length) {
      try { console.warn('[EnrollmentShipping] ' + label + ' failed', errs); } catch (e) {}
    }
    return errs.length === 0;
  }

  // TEMPORARY (remove after the China preview test): add enrollment_debug=1 to
  // the enrollment URL to log each cart write. Logs only field names, codes,
  // counts and booleans — never address values, names, phones, ids or tokens.
  var DEBUG = (function () {
    try { return /[?&]enrollment_debug=1(&|$)/.test(root.location.search); } catch (e) { return false; }
  })();
  function debug(step, info) {
    if (!DEBUG) return;
    try { console.info('[EnrollmentShipping][debug] ' + step, JSON.stringify(info || {})); } catch (e) {}
  }

  var ADDRESS_CHECK =
    'query EnrollCartAddressCheck($id: ID!) { cart(id: $id) { id delivery { addresses { selected address {' +
    ' ... on CartDeliveryAddress { firstName lastName phone address1 address2 city provinceCode countryCode zip } } } } } }';
  var DISTRICT_CHECK =
    'query EnrollCartDistrictCheck($id: ID!) { cart(id: $id) { id district: metafield(key: "' + DISTRICT_KEY + '") { value } } }';

  /**
   * Best-effort: checkout still asks for (and validates) anything this
   * couldn't prefill, so failures are logged, never thrown.
   *
   * Writes run one at a time (district, then address, then a read-back):
   * concurrent writes to the same cart can drop each other, and the address
   * goes last so it's the final thing written before checkout. new-enrollment.js
   * calls this only after its other cart writes have finished.
   */
  function applyToCart(cart) {
    if (!form || !validated || !cart || !cart.token) {
      debug('skipped', { form: Boolean(form), validated: Boolean(validated), cartToken: Boolean(cart && cart.token) });
      return Promise.resolve();
    }
    var token = storefrontToken();
    var cartId = 'gid://shopify/Cart/' + cart.token; // same id form as apex-attribution.js
    var wanted = cartDeliveryAddress(validated.address);
    var writeAddress = root.__ENROLLMENT_SHIPPING_PREFILL__;
    var canWrite = typeof writeAddress === 'function' && typeof root.__ENROLLMENT_SHIPPING_PREFILL_ADDRESS__ === 'function';
    debug('start', {
      storefrontToken: Boolean(token),
      cartIdHasKey: cart.token.indexOf('?key=') !== -1,
      prefillWriter: canWrite,
      addressFields: Object.keys(wanted),
      phoneE164: !wanted.phone || /^\+[1-9]\d{6,14}$/.test(wanted.phone),
      oneTimeUse: isObo,
      district: Boolean(validated.districtSelection)
    });
    if (!canWrite) warnErrors('address prefill (enrollment-shipping-prefill.js missing or outdated)', null);
    if (!token) warnErrors('Storefront API token (Theme settings > Storefront API)', null);

    function writeDistrict() {
      if (!token || !validated.districtSelection) return Promise.resolve();
      return sfQuery(token,
        'mutation EnrollCartDistrict($metafields: [CartMetafieldsSetInput!]!) {' +
        ' cartMetafieldsSet(metafields: $metafields) { userErrors { field message code } } }',
        { metafields: [{ ownerId: cartId, key: DISTRICT_KEY, type: 'json', value: validated.districtSelection }] }
      ).then(function (r) { debug('district write', { ok: warnErrors('cartMetafieldsSet', r, 'cartMetafieldsSet') }); });
    }

    // Writes the address, reads the cart back, and writes once more if it
    // didn't stick (e.g. another write replaced it).
    function writeAddressChecked(attempt) {
      if (!canWrite) return Promise.resolve();
      return Promise.resolve(writeAddress(cart, { address: wanted, oneTimeUse: isObo }))
        .then(function (ok) {
          debug('address write', { attempt: attempt, ok: ok === true });
          return token ? sfQuery(token, ADDRESS_CHECK, { id: cartId }) : null;
        })
        .then(function (res) {
          if (!res) return;
          var data = res.data && res.data.cart;
          if (!data) { warnErrors('cart address read-back', res, 'cart'); return; }
          var check = checkSelectedAddress(data.delivery && data.delivery.addresses, wanted);
          debug('address read-back', { attempt: attempt, ok: check.ok, addressCount: check.addressCount, selectedCount: check.selectedCount, mismatched: check.mismatched });
          if (check.ok) return;
          if (attempt < 2) return writeAddressChecked(attempt + 1);
          try { console.warn('[EnrollmentShipping] the shipping address is not on the cart', { selectedCount: check.selectedCount, mismatched: check.mismatched }); } catch (e) {}
        });
    }

    function checkDistrict() {
      if (!DEBUG || !token || !validated.districtSelection) return Promise.resolve();
      return sfQuery(token, DISTRICT_CHECK, { id: cartId }).then(function (res) {
        var mf = res && res.data && res.data.cart && res.data.cart.district;
        debug('district read-back', { saved: Boolean(mf), matches: Boolean(mf && mf.value === validated.districtSelection), errors: res && res.errors ? errorSummary(res) : [] });
      });
    }

    return writeDistrict()
      .then(function () { return writeAddressChecked(1); })
      .then(checkDistrict)
      .then(function () {}, function () {});
  }

  /**
   * Starts the form from the enrollment URL's address when it has a China one,
   * and for OBO always: an OBO order ships to the recipient, so the payer's
   * saved address (rendered by Liquid) is cleared and never saved.
   */
  function startFromUrlAddress() {
    var get = root.__ENROLLMENT_SHIPPING_PREFILL_ADDRESS__;
    var values = recipientFormValues(typeof get === 'function' ? get() : null);
    if (values || isObo) {
      ['lastName', 'firstName', 'phone', 'address1', 'address2', 'zip'].forEach(function (name) {
        if (el(name)) el(name).value = values ? values[name] : '';
      });
      prefillProvince = values ? values.provinceCode : null;
      prefillCity = values ? values.city : null;
    }
    var save = el('saveAsDefault');
    if (isObo && save) {
      save.checked = false;
      save.disabled = true;
      var label = save.closest && save.closest('.enroll-shipping__save');
      if (label) label.hidden = true;
    }
  }

  // --- wiring -------------------------------------------------------------------

  if (form) {
    startFromUrlAddress();
    el('provinceCode').addEventListener('change', function () { validated = null; renderCities(); });
    el('city').addEventListener('change', function () { validated = null; renderDistricts(); });
    form.addEventListener('input', function () { validated = null; });
    form.addEventListener('change', function () { validated = null; });
    form.addEventListener('submit', function (e) { e.preventDefault(); });
  }

  root.AvaEnrollmentShipping = {
    isEnabled: function () { return Boolean(form); },
    isValid: function () { return !form || Boolean(validated); },
    load: function () { return form ? loadOptions().catch(function () {}) : Promise.resolve(); },
    validate: validate,
    applyToCart: applyToCart
  };
})(typeof window !== 'undefined' ? window : this);
