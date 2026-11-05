(function (root) {
  'use strict';

  var FIELD_NAMES = ['firstName', 'lastName', 'phone', 'address1', 'address2', 'province', 'city', 'district', 'zip'];
  var COUNTRY_CODE = 'CN';
  var DEFAULT_PROXY_PATH = '/apps/ava-china-address';
  var ENDPOINT_SUFFIX = '/address-confirmed';
  var GEO_RESOURCES = {
    provinces: '/geo/provinces',
    cities: '/geo/cities',
    districts: '/geo/districts'
  };

  var FIELD_ALIASES = {
    firstname: 'firstName',
    givenname: 'firstName',
    first: 'firstName',
    lastname: 'lastName',
    familyname: 'lastName',
    last: 'lastName',
    phone: 'phone',
    phonenumber: 'phone',
    mobile: 'phone',
    address1: 'address1',
    addressline1: 'address1',
    address2: 'address2',
    addressline2: 'address2',
    province: 'province',
    provincename: 'province',
    provincecode: 'province',
    state: 'province',
    stateprovince: 'province',
    region: 'province',
    city: 'city',
    cityname: 'city',
    district: 'district',
    districtname: 'district',
    county: 'district',
    zip: 'zip',
    zipcode: 'zip',
    postal: 'zip',
    postalcode: 'zip',
    postcode: 'zip'
  };

  function canonicalFieldName(raw) {
    if (raw == null) return '';
    var name = String(raw).trim();
    name = name.replace(/^address[\.\[]/i, '');
    name = name.split(/[\.\/]/).pop();
    name = name.replace(/[\[\]]/g, '');
    var key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FIELD_ALIASES[key]) return FIELD_ALIASES[key];
    for (var i = 0; i < FIELD_NAMES.length; i++) {
      if (FIELD_NAMES[i].toLowerCase() === key) return FIELD_NAMES[i];
    }
    return '';
  }

  function messageText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var text = messageText(value[i]);
        if (text) return text;
      }
      return '';
    }
    if (typeof value === 'object') {
      return messageText(value.message || value.msg || value.error || value.detail || value.reason || value.messages || value.errors);
    }
    return '';
  }

  function normalizeErrors(payload) {
    var out = { fields: {}, general: [] };
    var source = payload && (payload.errors || payload.error || payload.fieldErrors || payload.field_errors || payload.validationErrors);

    if (!source) {
      var topField = canonicalFieldName(payload && (payload.field || payload.path || payload.name));
      var topMessage = messageText(payload && (payload.message || payload.msg || payload.error));
      if (topField && topMessage) out.fields[topField] = topMessage;
      else if (topMessage) out.general.push(topMessage);
      return out;
    }

    if (typeof source === 'string') {
      if (source.trim()) out.general.push(source.trim());
      return out;
    }

    if (typeof source === 'object' && !Array.isArray(source)) {
      var singleRawField = source.field || source.path || source.name || source.param || source.key;
      var singleMessage = messageText(source.message || source.msg || source.error || source.detail || source.messages);
      if (singleRawField && singleMessage) {
        var singleField = canonicalFieldName(singleRawField);
        if (singleField) out.fields[singleField] = singleMessage;
        else out.general.push(singleMessage);
        return out;
      }
    }

    if (Array.isArray(source)) {
      for (var i = 0; i < source.length; i++) {
        var item = source[i];

        if (Array.isArray(item)) {
          var pairField = canonicalFieldName(item[0]);
          var pairMessage = messageText(item[1]);
          if (pairField && pairMessage) out.fields[pairField] = pairMessage;
          else if (pairMessage) out.general.push(pairMessage);
          continue;
        }

        if (typeof item === 'string') {
          var match = item.match(/^\s*([A-Za-z0-9_.\[\]]+)\s*[:=]\s*(.+)$/);
          var namedField = match ? canonicalFieldName(match[1]) : '';
          if (namedField) out.fields[namedField] = match[2].trim();
          else if (item.trim()) out.general.push(item.trim());
          continue;
        }

        if (!item || typeof item !== 'object') continue;
        var message = messageText(item.message || item.msg || item.error || item.detail || item.messages);
        var field = canonicalFieldName(item.field || item.path || item.name || item.param || item.key);
        if (field && message) out.fields[field] = message;
        else if (message) out.general.push(message);
      }
      return out;
    }

    if (typeof source === 'object') {
      for (var rawField in source) {
        if (!Object.prototype.hasOwnProperty.call(source, rawField)) continue;
        var fieldMessage = messageText(source[rawField]);
        if (!fieldMessage) continue;
        var canonical = canonicalFieldName(rawField);
        if (canonical) out.fields[canonical] = fieldMessage;
        else out.general.push(fieldMessage);
      }
    }

    return out;
  }

  function hasFieldErrors(errors) {
    for (var key in errors.fields) {
      if (Object.prototype.hasOwnProperty.call(errors.fields, key)) return true;
    }
    return false;
  }

  function buildPayload(values) {
    var payload = { country: COUNTRY_CODE };
    for (var i = 0; i < FIELD_NAMES.length; i++) {
      var name = FIELD_NAMES[i];
      payload[name] = values && values[name] != null ? String(values[name]).trim() : '';
    }
    return payload;
  }

  function endpointFor(proxyPath) {
    var base = String(proxyPath || '').trim() || DEFAULT_PROXY_PATH;
    base = base.replace(/\/+$/, '');
    if (base.slice(-ENDPOINT_SUFFIX.length) === ENDPOINT_SUFFIX) return base;
    return base + ENDPOINT_SUFFIX;
  }

  function classifyStatus(status) {
    if (status === 401) return 'unauthorized';
    if (status === 422) return 'validation';
    if (status >= 500) return 'server';
    return 'other';
  }

  function geoEndpointFor(proxyPath, resource, params) {
    var base = String(proxyPath || '').trim() || DEFAULT_PROXY_PATH;
    base = base.replace(/\/+$/, '');
    var path = base + (GEO_RESOURCES[resource] || '');
    var query = [];
    if (params) {
      for (var key in params) {
        if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
        var value = params[key];
        if (value == null || value === '') continue;
        query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
      }
    }
    return query.length ? path + '?' + query.join('&') : path;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function findProvinceByCode(provinces, code) {
    var wanted = String(code || '').toUpperCase();
    if (!wanted) return null;
    for (var i = 0; i < (provinces || []).length; i++) {
      var province = provinces[i];
      if (province && String(province.provinceCode || '').toUpperCase() === wanted) {
        return province;
      }
    }
    return null;
  }

  function findOptionByValue(options, value) {
    var wanted = String(value || '');
    if (!wanted) return null;
    for (var i = 0; i < (options || []).length; i++) {
      var option = options[i];
      if (option && String(option.value) === wanted) return option;
    }
    return null;
  }

  function districtForAddress(districtList, addressId) {
    var parsed = districtList;
    if (typeof parsed === 'string') {
      if (!parsed) return '';
      try { parsed = JSON.parse(parsed); } catch (e) { return ''; }
    }
    if (!parsed) return '';
    var entries = Array.isArray(parsed) ? parsed : parsed.districts;
    if (!Array.isArray(entries)) return '';
    var wanted = String(addressId || '');
    if (!wanted) return '';
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || !entry.district) continue;
      var entryId = String(entry.shopifyAddressID || '').split('?')[0];
      if (entryId === wanted || entryId.slice(-(wanted.length + 1)) === '/' + wanted) {
        return String(entry.district);
      }
    }
    return '';
  }

  function decodeEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function optionsHtml(items, selectedValue) {
    var html = '';
    for (var i = 0; i < (items || []).length; i++) {
      var item = items[i];
      if (!item) continue;
      var value = String(item.value == null ? '' : item.value);
      var label = String(
        item.description == null || item.description === '' ? value : item.description
      );
      html += '<option value="' + escapeHtml(value) + '"' +
        (value === String(selectedValue || '') ? ' selected' : '') +
        '>' + escapeHtml(label) + '</option>';
    }
    return html;
  }

  var helpers = {
    FIELD_NAMES: FIELD_NAMES,
    canonicalFieldName: canonicalFieldName,
    normalizeErrors: normalizeErrors,
    hasFieldErrors: hasFieldErrors,
    buildPayload: buildPayload,
    endpointFor: endpointFor,
    geoEndpointFor: geoEndpointFor,
    escapeHtml: escapeHtml,
    findProvinceByCode: findProvinceByCode,
    findOptionByValue: findOptionByValue,
    districtForAddress: districtForAddress,
    decodeEntities: decodeEntities,
    optionsHtml: optionsHtml,
    classifyStatus: classifyStatus
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = helpers;
    return;
  }

  var DEFAULT_MESSAGES = {
    saving: 'Saving…',
    confirmed: 'Confirmed',
    saved: 'Your shipping address has been confirmed. Taking you to your account…',
    sessionExpired: 'Your session has expired. Please log in again.',
    errorSummary: 'Please correct the highlighted fields.',
    genericError: "We couldn't save your address right now. Please try again.",
    networkError: "We couldn't reach the server. Please check your connection and try again.",
    selectProvince: 'Select a province',
    selectCity: 'Select a city',
    selectProvinceFirst: 'Select a province first',
    selectDistrict: 'Select a district',
    selectCityFirst: 'Select a city first',
    loading: 'Loading…',
    loadFailed: "We couldn't load the address options. Please try again."
  };

  function readMessages(form) {
    var node = form.querySelector('[data-csa-messages]');
    var messages = {};
    if (node) {
      try { messages = JSON.parse(node.textContent || '{}'); } catch (e) { messages = {}; }
    }
    for (var key in DEFAULT_MESSAGES) {
      if (!messages[key]) messages[key] = DEFAULT_MESSAGES[key];
    }
    for (var messageKey in messages) {
      if (typeof messages[messageKey] === 'string') {
        messages[messageKey] = decodeEntities(messages[messageKey]);
      }
    }
    return messages;
  }

  function initForm(form) {
    if (!form) return;

    var messages = readMessages(form);
    var summary = form.querySelector('[data-csa-summary]');
    var status = form.querySelector('[data-csa-status]');
    var submit = form.querySelector('[data-csa-submit]');
    var submitLabel = submit ? submit.textContent : '';
    var busy = false;
    var provinceSelect = form.querySelector('[data-geo-province]');
    var citySelect = form.querySelector('[data-geo-city]');
    var districtSelect = form.querySelector('[data-geo-district]');
    var geoStatus = form.querySelector('[data-geo-status]');
    var proxyPath = form.getAttribute('data-proxy-path') || DEFAULT_PROXY_PATH;
    var locale = form.getAttribute('data-locale') || '';
    var prefillProvinceCode = form.getAttribute('data-prefill-province-code') || '';
    var prefillCity = form.getAttribute('data-prefill-city') || '';
    var prefillDistrict = districtForAddress(
      form.getAttribute('data-district-list') || '',
      form.getAttribute('data-default-address-id') || ''
    );

    function fieldFor(name) {
      if (form.elements && form.elements[name]) return form.elements[name];
      return form.querySelector('[name="' + name + '"]');
    }

    function errorFor(name) {
      return form.querySelector('[data-error-for="' + name + '"]');
    }

    function setStatusKind(kind) {
      if (!status || !status.classList) return;
      status.classList.remove('is-error');
      status.classList.remove('is-success');
      if (kind) status.classList.add('is-' + kind);
    }

    function setSummary(message) {
      if (!summary) return;
      summary.textContent = message || '';
      summary.hidden = !message;
    }

    function setStatus(message, kind) {
      if (!status) return;
      status.textContent = message || '';
      status.hidden = !message;
      setStatusKind(kind);
    }

    function clearFieldError(name) {
      var node = errorFor(name);
      var field = fieldFor(name);
      if (node) {
        node.textContent = '';
        node.hidden = true;
      }
      if (field) field.removeAttribute('aria-invalid');
    }

    function showFieldError(name, message) {
      if (!message) {
        clearFieldError(name);
        return;
      }
      var node = errorFor(name);
      var field = fieldFor(name);
      if (node) {
        node.textContent = message;
        node.hidden = false;
      }
      if (field) field.setAttribute('aria-invalid', 'true');
    }

    function clearMessages() {
      for (var i = 0; i < FIELD_NAMES.length; i++) clearFieldError(FIELD_NAMES[i]);
      setSummary('');
      setStatus('');
    }

    function setBusy(isBusy) {
      busy = isBusy;
      form.setAttribute('aria-busy', isBusy ? 'true' : 'false');
      if (!submit) return;
      submit.disabled = isBusy;
      submit.textContent = isBusy ? messages.saving : submitLabel;
    }

    function readValues() {
      var values = {};
      for (var i = 0; i < FIELD_NAMES.length; i++) {
        var field = fieldFor(FIELD_NAMES[i]);
        values[FIELD_NAMES[i]] = field ? field.value : '';
      }
      return values;
    }

    function redirect(url, delay) {
      if (!url) return;
      setTimeout(function () {
        if (!root.location) return;
        if (typeof root.location.assign === 'function') root.location.assign(url);
        else root.location.href = url;
      }, delay);
    }

    function setGeoStatus(message, kind) {
      if (!geoStatus) return;
      geoStatus.textContent = message || '';
      geoStatus.hidden = !message;
      if (geoStatus.classList) {
        geoStatus.classList.remove('is-error');
        if (kind === 'error') geoStatus.classList.add('is-error');
      }
    }

    function setSelectLoading(select, message) {
      if (!select) return;
      select.innerHTML = '<option value="">' + escapeHtml(message) + '</option>';
      select.value = '';
      select.disabled = true;
      select.setAttribute('aria-busy', 'true');
    }

    function resetSelect(select, message) {
      if (!select) return;
      select.innerHTML = '<option value="">' + escapeHtml(message) + '</option>';
      select.value = '';
      select.disabled = true;
      select.removeAttribute('aria-busy');
    }

    function fillSelect(select, placeholder, items, selectedValue) {
      if (!select) return;
      var selected = findOptionByValue(items, selectedValue);
      select.innerHTML =
        '<option value="">' +
        escapeHtml(placeholder) +
        '</option>' +
        optionsHtml(items, selected ? selected.value : '');
      select.value = selected ? String(selected.value) : '';
      select.disabled = false;
      select.removeAttribute('aria-busy');
    }

    function fetchJson(url) {
      return fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      });
    }

    function loadCities(provinceValue, selectedCity, selectedDistrict) {
      setSelectLoading(citySelect, messages.loading);
      resetSelect(districtSelect, messages.selectCityFirst);
      setGeoStatus(messages.loading, '');
      return fetchJson(geoEndpointFor(proxyPath, 'cities', { province: provinceValue, locale: locale }))
        .then(function (data) {
          var cities = Array.isArray(data && data.cities) ? data.cities : [];
          var selected = findOptionByValue(cities, selectedCity);
          fillSelect(citySelect, messages.selectCity, cities, selected ? selected.value : '');
          setGeoStatus('');
          if (selected) {
            return loadDistricts(provinceValue, selected.value, selectedDistrict);
          }
          return null;
        })
        .catch(function () {
          setGeoStatus(messages.loadFailed, 'error');
          resetSelect(citySelect, messages.selectCity);
          if (citySelect) citySelect.disabled = false;
          resetSelect(districtSelect, messages.selectCityFirst);
        });
    }

    function loadDistricts(provinceValue, cityValue, selectedDistrict) {
      setSelectLoading(districtSelect, messages.loading);
      setGeoStatus(messages.loading, '');
      return fetchJson(
        geoEndpointFor(proxyPath, 'districts', {
          province: provinceValue,
          city: cityValue,
          locale: locale
        })
      )
        .then(function (data) {
          var districts = Array.isArray(data && data.districts) ? data.districts : [];
          var selected = findOptionByValue(districts, selectedDistrict);
          fillSelect(
            districtSelect,
            messages.selectDistrict,
            districts,
            selected ? selected.value : ''
          );
          setGeoStatus('');
          return null;
        })
        .catch(function () {
          setGeoStatus(messages.loadFailed, 'error');
          resetSelect(districtSelect, messages.selectDistrict);
          if (districtSelect) districtSelect.disabled = false;
        });
    }

    function loadProvinces() {
      resetSelect(citySelect, messages.selectProvinceFirst);
      resetSelect(districtSelect, messages.selectCityFirst);
      setSelectLoading(provinceSelect, messages.loading);
      setGeoStatus(messages.loading, '');
      return fetchJson(geoEndpointFor(proxyPath, 'provinces', { locale: locale }))
        .then(function (data) {
          var provinces = Array.isArray(data && data.provinces) ? data.provinces : [];
          var prefill = findProvinceByCode(provinces, prefillProvinceCode);
          fillSelect(
            provinceSelect,
            messages.selectProvince,
            provinces,
            prefill ? prefill.value : ''
          );
          setGeoStatus('');
          if (prefill) return loadCities(prefill.value, prefillCity, prefillDistrict);
          return null;
        })
        .catch(function () {
          setGeoStatus(messages.loadFailed, 'error');
          setSelectLoading(provinceSelect, messages.selectProvince);
        });
    }

    function onProvinceChange() {
      clearFieldError('city');
      clearFieldError('district');
      resetSelect(citySelect, messages.selectProvinceFirst);
      resetSelect(districtSelect, messages.selectCityFirst);
      if (!provinceSelect || !provinceSelect.value) return;
      loadCities(provinceSelect.value);
    }

    function onCityChange() {
      clearFieldError('district');
      resetSelect(districtSelect, messages.selectCityFirst);
      if (!provinceSelect || !citySelect || !citySelect.value) return;
      loadDistricts(provinceSelect.value, citySelect.value);
    }

    function showValidationErrors(data) {
      var errors = normalizeErrors(data);
      var firstInvalid = null;

      for (var i = 0; i < FIELD_NAMES.length; i++) {
        var name = FIELD_NAMES[i];
        if (!errors.fields[name]) continue;
        showFieldError(name, errors.fields[name]);
        if (!firstInvalid) firstInvalid = fieldFor(name);
      }

      if (errors.general.length) setSummary(errors.general.join(' '));
      else if (hasFieldErrors(errors)) setSummary(messages.errorSummary);
      else setSummary(messages.genericError);

      if (firstInvalid && typeof firstInvalid.focus === 'function') firstInvalid.focus();
    }

    function handleResult(response, data) {
      var httpStatus = response && typeof response.status === 'number' ? response.status : 0;
      var kind = classifyStatus(httpStatus);

      if (kind === 'unauthorized') {
        setBusy(false);
        if (submit) submit.disabled = true;
        setStatus(messages.sessionExpired, 'error');
        redirect(form.getAttribute('data-login-url') || '/account/login', 1600);
        return;
      }

      if (response && response.ok && data && data.ok === true) {
        setBusy(false);
        if (submit) {
          submit.disabled = true;
          submit.textContent = messages.confirmed;
        }
        setStatus(messages.saved, 'success');
        redirect(form.getAttribute('data-success-url') || '/account', 1400);
        return;
      }

      setBusy(false);

      if (kind === 'server') {
        setSummary(messages.genericError);
        return;
      }

      if (kind === 'validation' || (data && (data.errors || data.error || data.fieldErrors || data.field_errors))) {
        showValidationErrors(data);
        return;
      }

      setSummary(messages.genericError);
    }

    function onSubmit(event) {
      if (event && event.preventDefault) event.preventDefault();
      if (busy) return Promise.resolve();

      clearMessages();

      var endpoint = endpointFor(form.getAttribute('data-proxy-path'));
      var payload = buildPayload(readValues());
      if (locale) payload.locale = locale;
      var body = JSON.stringify(payload);
      setBusy(true);

      return fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body
      }).then(function (response) {
        return response.text().then(function (text) {
          var data = null;
          if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
          }
          handleResult(response, data);
        });
      }).catch(function () {
        setBusy(false);
        setSummary(messages.networkError);
      });
    }

    function onEdit(event) {
      var target = event && event.target;
      var name = canonicalFieldName(target && target.name);
      if (name) clearFieldError(name);
      setSummary('');
      if (status && !status.hidden && status.classList && status.classList.contains('is-error')) setStatus('');
    }

    form.addEventListener('submit', onSubmit);
    form.addEventListener('input', onEdit);
    form.addEventListener('change', function (event) {
      onEdit(event);
      var target = event && event.target;
      if (target === provinceSelect) onProvinceChange();
      else if (target === citySelect) onCityChange();
    });
    setBusy(false);
    if (provinceSelect) loadProvinces();
  }

  function init() {
    if (typeof document === 'undefined') return;
    var forms = document.querySelectorAll ? document.querySelectorAll('[data-csa-form]') : [];
    for (var i = 0; i < forms.length; i++) initForm(forms[i]);
  }

  root.AvaConfirmShipping = { initForm: initForm, init: init };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : this);
