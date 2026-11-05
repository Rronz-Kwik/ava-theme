(function () {
  'use strict';

  // Loaded site-wide for OBO sessions (snippets/obo-session.liquid) and by the
  // enrollment section; the first copy wins.
  if (window.__ENROLLMENT_SHIPPING_PREFILL__) return;

  // ---------------------------------------------------------------------------
  // Enrollment shipping-address prefill.
  //
  // Reads the recipient's shipping details from the enrollment URL and sets
  // them as the cart's SELECTED delivery address via the Storefront API
  // (cartDeliveryAddressesReplace). Checkout prefills its shipping form from
  // the cart's selected delivery address; the payer can still edit it there.
  //
  // This is deliberately NOT a cart attribute: attributes are order metadata
  // only and never populate the checkout shipping form.
  //
  // URL parameters (the enrollment_* names already reserved in
  // apex-attribution.js CHECKOUT_MAPPED_ATTRS, plus name):
  //   enrollment_name | enrollment_first_name + enrollment_last_name
  //   enrollment_address1, enrollment_address2, enrollment_city,
  //   enrollment_province, enrollment_zip, enrollment_country,
  //   enrollment_phone
  //
  // Requires the Storefront API token from the apex-config island (same token
  // apex-attribution.js uses). Without it, or without a usable address, this
  // is a no-op and checkout behaves exactly as before.
  // ---------------------------------------------------------------------------

  var SF_VERSION = '2026-07'; // keep in step with apex-attribution.js
  var SF_ENDPOINT = '/api/' + SF_VERSION + '/graphql.json';
  var PREFIX = 'enrollment_';
  var MAX_LEN = 255;

  function clean(value) {
    if (value == null) return '';
    // Strip control characters and collapse whitespace.
    var v = String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    return v.slice(0, MAX_LEN);
  }

  function readParams() {
    var out = {};
    try {
      // URLSearchParams handles percent- and +-decoding; keys are matched
      // case-insensitively like the sponsor aliases in new-enrollment.js.
      new URL(window.location.href).searchParams.forEach(function (value, key) {
        var k = key.toLowerCase();
        if (k.indexOf(PREFIX) === 0 && !out[k]) out[k] = clean(value);
      });
    } catch (e) {}
    return out;
  }

  // E.164 as required by CartDeliveryAddressInput.phone; anything else is dropped
  // rather than failing the whole address.
  function normalizePhone(raw) {
    if (!raw) return '';
    var plus = raw.charAt(0) === '+';
    var digits = raw.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return '';
    return plus ? '+' + digits : '';
  }

  // Returns a CartDeliveryAddressInput, or null when the URL lacks the minimum
  // needed for a deliverable address.
  function buildAddress(p) {
    var first = p.enrollment_first_name || '';
    var last = p.enrollment_last_name || '';
    if (!first && !last && p.enrollment_name) {
      var parts = p.enrollment_name.split(' ');
      last = parts.length > 1 ? parts.pop() : parts[0];
      first = parts.length ? parts.join(' ') : '';
    }

    var country = (p.enrollment_country || '').toUpperCase();
    var province = (p.enrollment_province || '').toUpperCase();

    if (!p.enrollment_address1 || !p.enrollment_city || !/^[A-Z]{2}$/.test(country)) return null;

    var address = {
      address1: p.enrollment_address1,
      city: p.enrollment_city,
      countryCode: country
    };
    if (first) address.firstName = first;
    if (last) address.lastName = last;
    if (p.enrollment_address2) address.address2 = p.enrollment_address2;
    if (/^[A-Z0-9-]{1,10}$/.test(province)) address.provinceCode = province;
    if (p.enrollment_zip) address.zip = p.enrollment_zip;
    var phone = normalizePhone(p.enrollment_phone);
    if (phone) address.phone = phone;
    return address;
  }

  // Captured once at load so step navigation can't lose it.
  var prefillAddress = buildAddress(readParams());

  function getToken() {
    var config = window.__APEX_CONFIG__;
    if (!config) {
      try {
        var node = document.getElementById('apex-config');
        config = node ? JSON.parse(node.textContent) : null;
      } catch (e) {}
    }
    return (config && config.storefront_api_token) || '';
  }

  // Codes and field paths only: GraphQL messages can echo the address back.
  function codes(errs) {
    return errs.map(function (e) {
      return { code: e.code || (e.extensions && e.extensions.code) || '', field: e.field || e.path || null };
    });
  }

  var MUTATION =
    'mutation EnrollmentShippingPrefill($cartId: ID!, $addresses: [CartSelectableAddressInput!]!) {' +
    ' cartDeliveryAddressesReplace(cartId: $cartId, addresses: $addresses) {' +
    '  cart { id }' +
    '  userErrors { field message code }' +
    '  warnings { message code }' +
    ' } }';

  // Sets the cart's selected delivery address: the URL address, or
  // options.address when the China Shipping step (enrollment-shipping.js)
  // passes its validated one, so the cart has a single address writer.
  // options.oneTimeUse (default true) keeps it out of the payer's account.
  // Always resolves (never rejects) so it can't block the sale.
  function applyToCart(cart, options) {
    var address = (options && options.address) || prefillAddress;
    var oneTimeUse = !(options && options.oneTimeUse === false);
    var token = getToken();
    if (!address || !token || !cart || !cart.token) return Promise.resolve(false);

    return fetch(SF_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token
      },
      body: JSON.stringify({
        query: MUTATION,
        variables: {
          cartId: 'gid://shopify/Cart/' + cart.token,
          addresses: [{
            selected: true,
            // A recipient's address must not be saved to the payer's account.
            oneTimeUse: oneTimeUse,
            address: { deliveryAddress: address }
          }]
        }
      })
    })
      .then(function (r) {
        if (r.ok) return r.json();
        try { console.warn('[Enrollment] shipping prefill HTTP ' + r.status + (r.status === 401 ? ' (Storefront API token rejected)' : '')); } catch (e) {}
        return null;
      })
      .then(function (res) {
        if (!res) return false;
        var payload = res.data && res.data.cartDeliveryAddressesReplace;
        var errs = res.errors || (payload && payload.userErrors) || [];
        if (!payload || errs.length) {
          try { console.warn('[Enrollment] shipping prefill failed:', codes(errs)); } catch (e) {}
          return false;
        }
        if (payload.warnings && payload.warnings.length) {
          try { console.warn('[Enrollment] shipping prefill warnings:', codes(payload.warnings)); } catch (e) {}
        }
        return true;
      })
      .catch(function () { return false; });
  }

  function sfPost(token, query, variables) {
    return fetch(SF_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token
      },
      body: JSON.stringify({ query: query, variables: variables })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }

  var ADDRESSES_QUERY =
    'query EnrollmentShippingAddresses($cartId: ID!) {' +
    ' cart(id: $cartId) { delivery { addresses { id oneTimeUse } } } }';

  var REMOVE_MUTATION =
    'mutation EnrollmentShippingRemove($cartId: ID!, $addressIds: [ID!]!) {' +
    ' cartDeliveryAddressesRemove(cartId: $cartId, addressIds: $addressIds) {' +
    '  cart { id }' +
    '  userErrors { field message code }' +
    ' } }';

  // Removes every one-time delivery address (an OBO recipient's, written by
  // applyToCart above) from the cart, leaving the payer's own saved addresses.
  // Used when an OBO session is cleared. Always resolves (never rejects).
  function removeOneTimeAddresses(cart) {
    var token = getToken();
    if (!token || !cart || !cart.token) return Promise.resolve(false);
    var cartId = 'gid://shopify/Cart/' + cart.token;

    return sfPost(token, ADDRESSES_QUERY, { cartId: cartId })
      .then(function (res) {
        var addresses = (res && res.data && res.data.cart && res.data.cart.delivery &&
          res.data.cart.delivery.addresses) || [];
        var ids = addresses.filter(function (a) { return a.oneTimeUse; }).map(function (a) { return a.id; });
        if (!ids.length) return true;
        return sfPost(token, REMOVE_MUTATION, { cartId: cartId, addressIds: ids }).then(function (r) {
          var payload = r && r.data && r.data.cartDeliveryAddressesRemove;
          var errs = (r && r.errors) || (payload && payload.userErrors) || [];
          if (!payload || errs.length) {
            try { console.warn('[Enrollment] shipping address removal failed:', codes(errs)); } catch (e) {}
            return false;
          }
          return true;
        });
      })
      .catch(function () { return false; });
  }

  window.__ENROLLMENT_SHIPPING_PREFILL__ = applyToCart;
  window.__ENROLLMENT_SHIPPING_PREFILL_REMOVE__ = removeOneTimeAddresses;
  // The URL (recipient) address, for the China Shipping step to start from.
  window.__ENROLLMENT_SHIPPING_PREFILL_ADDRESS__ = function () {
    if (!prefillAddress) return null;
    var copy = {};
    for (var k in prefillAddress) copy[k] = prefillAddress[k];
    return copy;
  };
})();
