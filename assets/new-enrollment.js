// ── Enrollment state ──────────────────────────────────────────────────────────
let selectedMainProduct = null;
let selectedSellingPlan = null;
let additionalProducts = {};

// ── Storage helpers ───────────────────────────────────────────────────────────
// Primary store: localStorage with TTL, keyed as apex_enrollment_sponsor.
// Stores { id, name, expires_at } so the name is available on repeat visits
// without another API round-trip.
// The apex_sponsor_id cookie is mirrored on every write so apex-attribution.js
// keeps cart attributes in sync.

var ENROLLMENT_LS_KEY = 'apex_enrollment_sponsor';

function lsGetEnrollmentSponsor() {
  try {
    var raw = localStorage.getItem(ENROLLMENT_LS_KEY);
    if (!raw) return null;
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.expires_at && parsed.expires_at < Date.now()) {
      localStorage.removeItem(ENROLLMENT_LS_KEY);
      return null;
    }
    return parsed; // { id, name, expires_at }
  } catch (e) {
    return null;
  }
}

function lsSetEnrollmentSponsor(id, name, days) {
  try {
    localStorage.setItem(
      ENROLLMENT_LS_KEY,
      JSON.stringify({ id: id, name: name, expires_at: Date.now() + (days || 90) * 86400000 })
    );
  } catch (e) {}
}

function setCookieBasic(name, value, days) {
  var expires = new Date(Date.now() + (days || 90) * 86400000).toUTCString();
  document.cookie =
    name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/; SameSite=Lax';
}

function getCookieBasic(name) {
  var parts = document.cookie ? document.cookie.split('; ') : [];
  for (var i = 0; i < parts.length; i++) {
    var idx = parts[i].indexOf('=');
    var k = idx === -1 ? parts[i] : parts[i].slice(0, idx);
    if (k === name) return decodeURIComponent(parts[i].slice(idx + 1));
  }
  return '';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read sponsor ID from the current URL using the APEX config aliases.
 * Keys are matched case-insensitively so ?sponsor_ID= hits the "sponsor_id" alias.
 */
function readUrlSponsorId() {
  try {
    var rawParams = new URL(window.location.href).searchParams;
    var aliases =
      window.__APEX_CONFIG__ && Array.isArray(window.__APEX_CONFIG__.sponsor_param_aliases)
        ? window.__APEX_CONFIG__.sponsor_param_aliases
        : ['sponsor_id', 'ref', 'rep', 'aff', 'sponsor'];
    var normalised = {};
    rawParams.forEach(function (value, key) {
      normalised[key.toLowerCase()] = value.trim();
    });
    for (var i = 0; i < aliases.length; i++) {
      var v = normalised[aliases[i].toLowerCase()];
      if (v) return v;
    }
  } catch (e) {}
  return '';
}

var SPONSOR_ID_PATTERN = /^[A-Z]{0,2}\d+$/;

/**
 * Translated UI string from the #enrollment-i18n island
 * (sections/distributor-selection.liquid, locales enrollment.*). Falls back
 * to the English text so the flow still reads correctly without the island.
 */
var ENROLL_I18N = null;
function i18n(key, fallback) {
  if (ENROLL_I18N === null) {
    try {
      var node = document.getElementById('enrollment-i18n');
      ENROLL_I18N = node ? JSON.parse(node.textContent) || {} : {};
    } catch (e) { ENROLL_I18N = {}; }
  }
  return ENROLL_I18N[key] || fallback;
}

/**
 * Normalize a Sponsor ID for comparison/lookup: trim surrounding whitespace
 * and uppercase letters. This never removes or reorders characters, so it
 * cannot turn one ID into a different one.
 */
function normalizeSponsorId(value) {
  return (value || '').trim().toUpperCase();
}

/**
 * A valid Sponsor ID is 0-2 alphabetic characters followed by digits
 * (e.g. "1919068", "D100", "CN5002363"). Anything else — extra prefix
 * letters, letters after the numeric portion, embedded spaces — is invalid
 * and must not be silently coerced into a valid ID.
 */
function isValidSponsorId(value) {
  return SPONSOR_ID_PATTERN.test(value);
}

/**
 * An OBO/EBO session (assets/enrollment-obo-context.js) missing what NetFi
 * needs: checkout stays blocked until the rep starts again from the dashboard.
 */
function oboCheckoutBlocked() {
  var obo = window.AvaObo;
  return Boolean(obo && obo.isActive() && obo.isIncomplete());
}

// ── Popup ─────────────────────────────────────────────────────────────────────

function showEnrollmentPopup(message) {
  let popup = document.getElementById("enrollment-popup");

  if (!popup) {
    popup = document.createElement("div");
    popup.id = "enrollment-popup";
    popup.innerHTML = `
      <div class="enrollment-popup__content" role="dialog" aria-modal="true" aria-labelledby="enrollment-popup-message">
        <button type="button" class="enrollment-popup__close" aria-label="${i18n('popup_close', 'Close popup')}">&times;</button>
        <div class="enrollment-popup__icon" aria-hidden="true">
          <svg width="104" height="93" viewBox="0 0 104 93" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M52 5L99 88H5L52 5Z" stroke="#F2BB11" stroke-width="7" fill="#FFFDF4"/>
            <path d="M52 31V54" stroke="#F2BB11" stroke-width="7" stroke-linecap="round"/>
            <circle cx="52" cy="69" r="4.5" fill="#F2BB11"/>
          </svg>
        </div>
        <h3 class="enrollment-popup__title">${i18n('popup_title', 'Product Selection Required')}</h3>
        <p id="enrollment-popup-message" class="enrollment-popup__message"></p>
        <button type="button" class="enrollment-popup__action">${i18n('popup_go_back', 'Go Back')}</button>
      </div>
    `;
    document.body.appendChild(popup);

    const style = document.createElement("style");
    style.textContent = `
      #enrollment-popup {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.7);
      }
      #enrollment-popup.is-visible {
        display: flex;
      }
      #enrollment-popup .enrollment-popup__content {
        position: relative;
        z-index: 1;
        width: calc(100% - 40px);
        max-width: 560px;
        background: #fff;
        border-radius: 10px;
        padding: 40px 28px 34px;
        box-shadow: 0 14px 45px rgba(17, 23, 41, 0.22);
      }
      #enrollment-popup .enrollment-popup__message {
        margin: 14px auto 0;
        max-width: 460px;
        font-size: 18px;
        line-height: 1.5;
        font-weight: 400;
        color: #4a5567;
        text-align: center;
      }
      #enrollment-popup .enrollment-popup__title {
        margin: 24px 0 0;
        font-size: 36px;
        line-height: 1.1;
        font-weight: 600;
        color: #111729;
        text-align: center;
      }
      #enrollment-popup .enrollment-popup__icon {
        width: 104px;
        height: 93px;
        margin: 0 auto;
      }
      #enrollment-popup .enrollment-popup__close {
        position: absolute;
        top: 16px;
        right: 16px;
        border: none;
        background: #f1f3f7;
        cursor: pointer;
        font-size: 26px;
        line-height: 1;
        color: #c4cad4;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #enrollment-popup .enrollment-popup__action {
        margin: 28px auto 0;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 58px;
        width: 100%;
        max-width: 280px;
        border: none;
        border-radius: 8px;
        background: #45b09c;
        color: #fff;
        font-size: 18px;
        line-height: 1.2;
        font-weight: 500;
        cursor: pointer;
        font-family: Inter Tight, sans-serif;
      }
      @media (max-width: 749px) {
        #enrollment-popup .enrollment-popup__content {
          padding: 26px 18px 22px;
        }
        #enrollment-popup .enrollment-popup__title {
          margin-top: 18px;
          font-size: 30px;
        }
        #enrollment-popup .enrollment-popup__message {
          margin-top: 10px;
          font-size: 16px;
        }
        #enrollment-popup .enrollment-popup__action {
          margin-top: 20px;
          max-width: 220px;
          min-height: 48px;
          font-size: 18px;
        }
      }
    `;
    document.head.appendChild(style);

    const hidePopup = () => popup.classList.remove("is-visible");
    popup.addEventListener("click", (event) => {
      if (event.target === popup) hidePopup();
    });
    popup.querySelector(".enrollment-popup__close")?.addEventListener("click", hidePopup);
    popup.querySelector(".enrollment-popup__action")?.addEventListener("click", hidePopup);
  }

  const messageEl = popup.querySelector(".enrollment-popup__message");
  if (messageEl) messageEl.textContent = message;
  popup.classList.add("is-visible");
}

// ── Main ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  try {
    // Clear any stale distributor key from previous sessions
    if (document.querySelector('.distributor-wrapper')) {
      try { localStorage.removeItem('distributor'); } catch (e) {}
    }

    var proxyUrl    = (window.__APEX_CONFIG__ && window.__APEX_CONFIG__.sponsor_proxy_url) || '';
    var attrDays    = (window.__APEX_CONFIG__ && window.__APEX_CONFIG__.attribution_window_days) || 90;

    // Sponsor/rep list endpoint. A section setting (data-sponsor-url) takes
    // precedence over the app-proxy URL from apex-config so it can point at an
    // external API directly.
    var wrapperConfigEl = document.querySelector('.distributor-wrapper');
    var sponsorUrl  = (wrapperConfigEl && wrapperConfigEl.dataset.sponsorUrl) || proxyUrl;

    var dropdown    = document.querySelector('.dropdown-selected');
    var list        = document.querySelector('.dropdown-list');
    var resultsEl   = document.getElementById('sponsorResults');
    var searchInput = document.getElementById('sponsorSearchInput');
    var sponsorIdEl = document.getElementById('sponsorId');
    var continueBtn = document.querySelector('.continue-btn');

    var step1 = document.querySelector('.step-1');
    var step2 = document.querySelector('.step-2');   // Choose Affiliate Pack (kit)
    var step3 = document.querySelector('.step-3');   // Add Additional Products
    var step4 = document.querySelector('.step-4');   // Review / Finish up
    // China Shipping step (assets/enrollment-shipping.js), between add-ons and
    // review when the section's "Enable China enrollment address step" setting is on.
    var stepShipping = document.querySelector('.step-shipping');
    var shipping = stepShipping && window.AvaEnrollmentShipping && window.AvaEnrollmentShipping.isEnabled()
      ? window.AvaEnrollmentShipping
      : null;

    var step2Cards  = document.querySelectorAll('.step-2 .package-card');
    var step2NextBtn = document.querySelector('.step2-next-btn');
    var step3NextBtn = document.querySelector('.step3-next-btn');
    var step3BackBtn = document.querySelector('.step3-back');
    var step4BackBtn = document.querySelector('.step4-back');
    var finalCheckoutBtn = document.querySelector('.final-checkout-btn');

    var selectedDistributor = null;
    // EBO: the sponsor chosen in the affiliate dashboard. Once set, no other
    // sponsor can be selected.
    var lockedSponsorId = '';

    // ── Order summary sidebar ──────────────────────────────────────────────────
    var wrapperEl     = document.querySelector('.distributor-wrapper');
    var currencyCode  = (wrapperEl && wrapperEl.dataset.currency) || 'USD';
    var summaryPanels = document.querySelectorAll('.enroll-summary, .enroll-overview');
    var summaryAside  = document.querySelector('.enroll-summary');
    var removeLabel   = (summaryAside && summaryAside.dataset.removeLabel) || 'Remove';

    var moneyFmt;
    try {
      moneyFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode });
    } catch (e) {
      moneyFmt = { format: function (n) { return '$' + n.toFixed(2); } };
    }
    function formatMoney(cents) {
      return moneyFmt.format((parseInt(cents, 10) || 0) / 100);
    }

    // Build a variant lookup from every rendered card (steps 2 + 3)
    var productIndex = {};
    document.querySelectorAll('.package-card[data-variant-id]').forEach(function (card) {
      var vid = card.dataset.variantId;
      if (!vid) return;
      productIndex[vid] = {
        title:        card.dataset.title || '',
        price:        parseInt(card.dataset.price, 10) || 0,
        image:        card.dataset.image || '',
        subscription: card.dataset.subscription === 'true'
      };
    });

    var CHECK_SVG =
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function summaryItemHtml(p, qty, variantId, type) {
      var img = p.image
        ? '<img class="enroll-item__thumb" src="' + escapeHtml(p.image) + '" alt="" loading="lazy">'
        : '<span class="enroll-item__thumb"></span>';
      return '<div class="enroll-item">' +
        img +
        '<span class="enroll-item__text">' + qty + 'x ' + escapeHtml(p.title) + '</span>' +
        '<button type="button" class="enroll-item__remove" aria-label="' + escapeHtml(removeLabel) + '" ' +
          'data-remove-type="' + type + '" data-remove-variant="' + escapeHtml(variantId) + '">&times;</button>' +
      '</div>';
    }

    function setBadge(panel, selector, complete, num) {
      var badge = panel.querySelector(selector);
      if (!badge) return;
      if (complete) {
        badge.innerHTML = CHECK_SVG;
        badge.classList.add('is-complete');
      } else {
        badge.textContent = num;
        badge.classList.remove('is-complete');
      }
    }

    // Overview row: thumb · "Nx" · title · line price (no remove button)
    function overviewRowHtml(p, qty) {
      var img = p.image
        ? '<img class="enroll-row__thumb" src="' + escapeHtml(p.image) + '" alt="" loading="lazy">'
        : '<span class="enroll-row__thumb"></span>';
      return '<div class="enroll-row">' +
        img +
        '<span class="enroll-row__qty">' + qty + 'x</span>' +
        '<span class="enroll-row__title">' + escapeHtml(p.title) + '</span>' +
        '<span class="enroll-row__price">' + formatMoney(p.price * qty) + '</span>' +
      '</div>';
    }

    function setText(panel, selector, text) {
      var el = panel.querySelector(selector);
      if (el) el.textContent = text;
    }

    // Compute the current enrollment state, grouped for rendering
    function computeState() {
      var hasKit = !!(selectedMainProduct && productIndex[selectedMainProduct]);
      var kit    = hasKit ? productIndex[selectedMainProduct] : null;

      var oneTime = [];
      var subs    = [];
      for (var vid in additionalProducts) {
        var qty = additionalProducts[vid];
        if (!qty || qty <= 0 || !productIndex[vid]) continue;
        var entry = { p: productIndex[vid], qty: qty, vid: vid };
        (productIndex[vid].subscription ? subs : oneTime).push(entry);
      }

      var kitTotal     = hasKit ? kit.price : 0;
      var oneTimeTotal = oneTime.reduce(function (s, e) { return s + e.p.price * e.qty; }, 0);
      var subTotal     = subs.reduce(function (s, e) { return s + e.p.price * e.qty; }, 0);

      return {
        hasKit: hasKit, kit: kit,
        oneTime: oneTime, subs: subs,
        kitTotal: kitTotal, oneTimeTotal: oneTimeTotal, subTotal: subTotal,
        subtotal: kitTotal + oneTimeTotal + subTotal
      };
    }

    // Step 2 sidebar: numbered step checklist with remove buttons
    function renderChecklistPanel(panel, s) {
      var kitEl = panel.querySelector('[data-summary-kit]');
      if (kitEl) kitEl.innerHTML = s.hasKit ? summaryItemHtml(s.kit, 1, selectedMainProduct, 'kit') : '';
      var kitEmpty = panel.querySelector('[data-summary-kit-empty]');
      if (kitEmpty) kitEmpty.hidden = s.hasKit;
      setBadge(panel, '[data-summary-kit-badge]', s.hasKit, '1');

      var allAddons = s.oneTime.concat(s.subs);
      var addonEl = panel.querySelector('[data-summary-addons]');
      if (addonEl) addonEl.innerHTML = allAddons.map(function (e) {
        return summaryItemHtml(e.p, e.qty, e.vid, 'addon');
      }).join('');
      var addonEmpty = panel.querySelector('[data-summary-addon-empty]');
      if (addonEmpty) addonEmpty.hidden = allAddons.length > 0;
      setBadge(panel, '[data-summary-addon-badge]', allAddons.length > 0, '2');

      setText(panel, '[data-summary-sponsor-name]',
        (selectedDistributor && selectedDistributor.name) ? selectedDistributor.name : '—');

      var money = formatMoney(s.subtotal);
      setText(panel, '[data-summary-subtotal]', money);
      setText(panel, '[data-summary-total]', money);

      var checkoutBtn = panel.querySelector('.enroll-summary__checkout');
      if (checkoutBtn) {
        var terms = panel.querySelector('.enroll-terms');
        var termsOk = !terms || terms.checked;
        // Checkout only unlocks on the final step (step 4). It stays disabled
        // on the kit (step 2) and additional-products (step 3) steps.
        var stepEl = panel.closest('.distributor-step');
        if (stepEl && stepEl.classList.contains('step-2')) {
          checkoutBtn.disabled = !s.hasKit;
        } else if (stepEl && stepEl.classList.contains('step-3')) {
          checkoutBtn.disabled = false;
        } else {
          checkoutBtn.disabled = !s.hasKit || !termsOk || oboCheckoutBlocked();
        }
      }
    }

    // Step 3 sidebar: grouped "Enrollment overview" cards
    function renderOverviewPanel(panel, s) {
      var kitEl = panel.querySelector('[data-summary-kit]');
      if (kitEl) kitEl.innerHTML = s.hasKit ? overviewRowHtml(s.kit, 1) : '';
      var kitEmpty = panel.querySelector('[data-summary-kit-empty]');
      if (kitEmpty) kitEmpty.hidden = s.hasKit;
      setText(panel, '[data-summary-kit-total]', formatMoney(s.kitTotal));

      var addonEl = panel.querySelector('[data-summary-addons]');
      if (addonEl) addonEl.innerHTML = s.oneTime.map(function (e) {
        return overviewRowHtml(e.p, e.qty);
      }).join('');
      var addonEmpty = panel.querySelector('[data-summary-addon-empty]');
      if (addonEmpty) addonEmpty.hidden = s.oneTime.length > 0;
      setText(panel, '[data-summary-addon-total]', formatMoney(s.oneTimeTotal));

      var subGroup = panel.querySelector('[data-summary-sub-group]');
      var subEl    = panel.querySelector('[data-summary-subs]');
      if (subEl) subEl.innerHTML = s.subs.map(function (e) {
        return overviewRowHtml(e.p, e.qty);
      }).join('');
      if (subGroup) subGroup.hidden = s.subs.length === 0;
      setText(panel, '[data-summary-sub-total]', formatMoney(s.subTotal));

      var money = formatMoney(s.subtotal);
      setText(panel, '[data-summary-subtotal]', money);
      setText(panel, '[data-summary-total]', money);

      var checkoutBtn = panel.querySelector('.enroll-summary__checkout');
      if (checkoutBtn) checkoutBtn.disabled = !s.hasKit;
    }

    function renderSummary() {
      var s = computeState();
      summaryPanels.forEach(function (panel) {
        if (panel.classList.contains('enroll-overview')) {
          renderOverviewPanel(panel, s);
        } else {
          renderChecklistPanel(panel, s);
        }
      });

  }

    // Reset a step-2 kit card (deselect)
    function removeKit() {
      if (selectedMainProduct) {
        var card = document.querySelector('.step-2 .package-card[data-variant-id="' + selectedMainProduct + '"]');
        if (card) card.classList.remove('active');
      }
      selectedMainProduct = null;
      selectedSellingPlan = null;
      renderSummary();
    }

    // Reset a step-3 add-on card (remove from cart + clear its qty UI)
    function removeAddon(variantId) {
      delete additionalProducts[variantId];
      var card = document.querySelector('.additional-products .package-card[data-variant-id="' + variantId + '"]');
      if (card) {
        card.classList.remove('active');
        var input = card.querySelector('.qty-input');
        if (input) input.value = 0;
        var qtyBox = card.querySelector('.qty-box');
        if (qtyBox) qtyBox.classList.add('is-hidden');
        var addBtn = card.querySelector('.add-to-cart-btn');
        if (addBtn) addBtn.style.display = 'block';
      }
      renderSummary();
    }

    var checkoutInProgress = false;
    function goToCheckout() {
      if (checkoutInProgress) return; // guard: bound to 3 buttons, avoid double-add
      if (oboCheckoutBlocked()) {
        var oboBanner = document.getElementById('ava-obo-banner');
        showEnrollmentPopup((oboBanner && oboBanner.getAttribute('data-incomplete')) ||
          'Details for this order are incomplete — please start again from your dashboard.');
        return;
      }
      if (!selectedMainProduct) {
        showEnrollmentPopup(i18n('popup_select_before_checkout', 'Please select a product before checkout. You need to choose a main package to complete your enrollment.'));
        return;
      }
      if (shipping && !shipping.isValid()) {
        // e.g. the address was edited after review: validate it again first.
        [step2, step3, step4].forEach(function (el) { if (el) el.style.display = 'none'; });
        goToStep(null, stepShipping);
        showEnrollmentPopup(stepShipping.dataset.confirmMessage || 'Please confirm your shipping address before checkout.');
        return;
      }
      checkoutInProgress = true;

      // Build the exact enrollment cart. Volumes are NOT sent as line-item
      // properties — apex-attribution.js reads them from the product metafields
      // (apex.volume1 / apex.volume2) via the Storefront API and writes the
      // apex.* cart metafields, which we await below so they land before checkout.
      var items = [];
      var mainItem = { id: selectedMainProduct, quantity: 1 };
      if (selectedSellingPlan) mainItem.selling_plan = selectedSellingPlan;
      items.push(mainItem);

      for (var variantId in additionalProducts) {
        var qty = additionalProducts[variantId];
        if (qty > 0) items.push({ id: variantId, quantity: qty });
      }

      // Cart-level attributes. sponsor_id also reaches the order via the
      // apex_sponsor_id cookie -> apex.sponsor mapping in apex-attribution.js;
      // this attribute is kept for back-compat.
      var attributes = { 
        enrollment: 'true',
        orderFrom: 'enrollment'
       };
      if (selectedDistributor && selectedDistributor.id) {
        attributes.sponsor_id = selectedDistributor.id;
      }
      // OBO/OBE context from the enrollment URL (enrollment-obo-context.js).
      // Always merged: blank values clear stale context from an earlier visit.
      if (typeof window.__ENROLLMENT_OBO_ATTRIBUTES__ === 'function') {
        var obo = window.__ENROLLMENT_OBO_ATTRIBUTES__();
        for (var oboKey in obo) attributes[oboKey] = obo[oboKey];
      }

      if (finalCheckoutBtn) finalCheckoutBtn.disabled = true;

      var jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
      function post(url, body) {
        return fetch(url, {
          method: 'POST',
          headers: jsonHeaders,
          credentials: 'same-origin',
          body: JSON.stringify(body)
        });
      }
      var goCheckout = function () { window.location.href = '/checkout'; };

      // Resumes apex-cart-volume.js's automatic debounced resync. Called on
      // every exit from the rebuild below (success, sync failure, or a fatal
      // add-to-cart failure) so suspension can never get stuck on.
      function resumeAutosync() { window.__APEX_AUTOSYNC_SUSPENDED__ = false; }

      // Suspend the automatic resync for the whole clear -> add -> update ->
      // final-sync rebuild below. Without this, apex-cart-volume.js's own
      // debounced resync can fire against the cart while it's momentarily
      // empty (right after /cart/clear.js) or only half-built, and race the
      // explicit final sync below — whichever cartMetafieldsSet write lands
      // last wins, so a stale/empty read can silently overwrite correct
      // volume totals. Automatic resyncs are unaffected everywhere else.
      window.__APEX_AUTOSYNC_SUSPENDED__ = true;

      // Clear first so the order is exactly these items (the old permalink
      // replaced the whole cart). Add is the only fatal step; the attribute
      // update + metafield sync are best-effort — never block the sale on them.
      post('/cart/clear.js', {})
        .then(function () { return post('/cart/add.js', { items: items }); })
        .then(function (r) {
          if (!r.ok) {
            return r.json().then(function (e) {
              throw new Error(e && e.description ? e.description : 'Add to cart failed');
            });
          }
          return post('/cart/update.js', { attributes: attributes })
            .then(function () {
              return fetch('/cart.js', {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin'
              }).then(function (r2) {
                return r2.ok ? r2.json() : null;
              });
            })
            .then(function (cart) {
              // Cart writes run one after another: concurrent writes to the
              // same cart can drop each other. The apex.* metafields first,
              // then the shipping address — the last write before checkout.
              var sync;
              if (cart && typeof window.__APEX_SYNC_CART_METAFIELDS__ === 'function') {
                try { sync = window.__APEX_SYNC_CART_METAFIELDS__(cart); } catch (e) {}
              }
              return Promise.resolve(sync).then(null, function () {}).then(function () {
                // One writer of the checkout shipping address: the validated
                // China Shipping step (address + district) when it's on,
                // otherwise the URL prefill (enrollment-shipping-prefill.js;
                // no-op without URL params). Best-effort: checkout asks anyway.
                if (!cart) return;
                if (shipping) return shipping.applyToCart(cart);
                if (typeof window.__ENROLLMENT_SHIPPING_PREFILL__ === 'function') {
                  return window.__ENROLLMENT_SHIPPING_PREFILL__(cart).catch(function () {});
                }
              });
            })
            .then(resumeAutosync, resumeAutosync)
            .then(goCheckout, goCheckout); // best-effort: checkout regardless
        })
        .catch(function (err) {
          // Fatal: the items didn't make it into the cart.
          resumeAutosync();
          console.error('[Enrollment] Checkout failed:', err);
          checkoutInProgress = false;
          if (finalCheckoutBtn) finalCheckoutBtn.disabled = false;
          showEnrollmentPopup((err && err.message) || 'Something went wrong adding your items. Please try again.');
        });
    }

    summaryPanels.forEach(function (panel) {
    var btn = panel.querySelector('.enroll-summary__checkout');
    var summaryStep = panel.closest('.distributor-step');
    if (btn && summaryStep && summaryStep.classList.contains('step-2')) {
      btn.textContent = btn.dataset.nextLabel || 'Next';
      btn.addEventListener('click', function () {
        if (!selectedMainProduct) {
          showEnrollmentPopup(i18n('popup_select_before_continue', 'Please select a product before continuing. Choose one package to proceed to the next step.'));
          return;
        }
        goToStep(step2, step3);
      });
    } else if (btn && summaryStep && summaryStep.classList.contains('step-3')) {
      btn.textContent = btn.dataset.nextLabel || 'Next';
      btn.addEventListener('click', function () { goToStep(step3, afterAddonsStep()); });
    } else if (btn) {
      btn.addEventListener('click', goToCheckout);
    }
      // Re-evaluate the checkout button when the terms box is toggled
      var termsBox = panel.querySelector('.enroll-terms');
      if (termsBox) termsBox.addEventListener('change', renderSummary);

      // Delegate remove + "Change" clicks (items re-render on each state change)
      panel.addEventListener('click', function (e) {
        var changeBtn = e.target.closest('.enroll-group__change');
        if (changeBtn) {
          // "Change" on the review screen jumps back to the relevant step
          if (step4) step4.style.display = 'none';
          if (changeBtn.dataset.goto === 'kit') {
            if (step2) step2.style.display = 'block';
          } else {
            if (step3) step3.style.display = 'block';
          }
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }

        var removeBtn = e.target.closest('.enroll-item__remove');
        if (!removeBtn) return;
        if (removeBtn.dataset.removeType === 'kit') {
          removeKit();
        } else {
          removeAddon(removeBtn.dataset.removeVariant);
        }
      });
    });

    renderSummary();

    // ── Sponsor selection helpers ─────────────────────────────────────────────

    /**
     * Commit a sponsor selection: update UI, persist to localStorage + cookie,
     * and show the "You're shopping with" banner in steps 2 & 3.
     */
    function selectDistributor(id, name) {
      if (lockedSponsorId && id !== lockedSponsorId) return;
      selectedDistributor = { id: id, name: name };
      if (dropdown) dropdown.textContent = name;
      if (sponsorIdEl) sponsorIdEl.textContent = id;
      if (list) { list.style.display = 'none'; }
      if (dropdown) dropdown.classList.remove('active');

      lsSetEnrollmentSponsor(id, name, attrDays);
      // Mirror to cookie so apex-attribution.js cart-attribute pump picks it up
      setCookieBasic('apex_sponsor_id', id, attrDays);

      try {
        if (window.Shopify && window.Shopify.analytics && typeof window.Shopify.analytics.publish === 'function') {
          window.Shopify.analytics.publish('apex_enrollment_sponsor_selected', {
            sponsor_id: id,
            sponsor_name: name,
            visitor_id: getCookieBasic('apex_visitor_id') || null,
            ts: Date.now()
          });
        }
      } catch (e) {}

      // Build initials from name (up to 2 words)
      var initials = name
        .split(' ')
        .filter(function (w) { return w.length > 0; })
        .slice(0, 2)
        .map(function (w) { return w.charAt(0).toUpperCase(); })
        .join('');

      // Update every sponsor banner (step 2 + step 3)
      document.querySelectorAll('.sponsor-banner').forEach(function (banner) {
        var avatarEl = banner.querySelector('.sponsor-avatar');
        var nameEl   = banner.querySelector('.sponsor-banner__name');
        if (avatarEl) avatarEl.textContent = initials;
        if (nameEl)   nameEl.textContent   = name;
        banner.style.display = '';
      });

      renderSummary();
    }

    /** Show a single italic status/empty/error message in the results list. */
    function showResultsMessage(msg, isError) {
      if (!resultsEl) return;
      resultsEl.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'dropdown-state-msg' + (isError ? ' dropdown-state-msg--error' : '');
      li.textContent = msg;
      resultsEl.appendChild(li);
    }

    function renderSponsorItems(sponsors) {
      if (!resultsEl) return;
      if (!sponsors || !sponsors.length) {
        showResultsMessage(i18n('sponsor_not_found', 'No sponsor found with that ID.'), false);
        return;
      }
      resultsEl.innerHTML = '';
      sponsors.forEach(function (sponsor) {
        var li = document.createElement('li');
        li.dataset.name = sponsor.name;
        li.dataset.id   = sponsor.id;
        li.innerHTML =
          '<span>' + escapeHtml(sponsor.name) + '</span>' +
          '<span>' + escapeHtml(sponsor.id)   + '</span>';
        li.addEventListener('click', function () {
          selectDistributor(sponsor.id, sponsor.name);
        });
        resultsEl.appendChild(li);
      });
    }

    function setDropdownState(state) {
      if (!dropdown) return;
      dropdown.classList.remove('is-loading');
      if (continueBtn) continueBtn.disabled = false;
      if (state === 'ready') {
        dropdown.textContent = i18n('sponsor_select', 'Select Distributor');
      }
    }

    // Normalise the endpoint's response into [{ id, name }]:
    //   app proxy  → { sponsors: [{ id, name }] }
    //   reps API   → { reps: [{ repDid, name }] }
    //   bare array → [{ repDid|id, name }]
    function normalizeSponsors(data) {
      if (!data) return [];
      if (Array.isArray(data.sponsors)) return data.sponsors;
      var arr = Array.isArray(data.reps) ? data.reps : (Array.isArray(data) ? data : null);
      if (arr) {
        return arr.map(function (r) { return { id: r.repDid || r.id, name: r.name }; });
      }
      return [];
    }

    // Append the search term to the configured endpoint, respecting any
    // query string it may already carry.
    function buildSearchUrl(base, q) {
      return base + (base.indexOf('?') === -1 ? '?' : '&') + 'search=' + encodeURIComponent(q);
    }

    var MIN_SEARCH_CHARS = 1;
    var searchCtrl = null;

    /**
     * Query the sponsor endpoint for `query` and render matches.
     * The query is a Sponsor ID: 0-2 alphabetic characters followed by digits
     * (e.g. "1919068", "D100", "CN5002363"). Only reps whose repDid exactly
     * equals the query (case-insensitive) are shown. Aborts any in-flight
     * request so only the latest keystroke wins.
     */
    function searchSponsors(query) {
      query = normalizeSponsorId(query);

      if (!sponsorUrl) {
        console.warn('[Enrollment] Sponsor URL not set — configure it in section settings.');
        showResultsMessage(i18n('sponsor_unavailable', 'Sponsor lookup unavailable. Please contact support.'), true);
        return;
      }
      if (query.length < MIN_SEARCH_CHARS) {
        showResultsMessage(i18n('sponsor_enter_id', 'Enter a Sponsor ID to search…'), false);
        return;
      }
      // Invalid shape (e.g. "ABC123", "D100X") — do not transform it into a
      // different, valid-looking ID; just skip the lookup.
      if (!isValidSponsorId(query)) {
        showResultsMessage(i18n('sponsor_not_found', 'No sponsor found with that ID.'), false);
        return;
      }

      if (searchCtrl) { try { searchCtrl.abort(); } catch (e) {} }
      searchCtrl = window.AbortController ? new AbortController() : null;
      // Guard against a slow/cold endpoint: abort after 8s.
      var timer = searchCtrl ? setTimeout(function () { searchCtrl.abort(); }, 8000) : null;

      showResultsMessage(i18n('sponsor_searching', 'Searching…'), false);

      fetch(buildSearchUrl(sponsorUrl, query), searchCtrl ? { signal: searchCtrl.signal } : undefined)
        .then(function (r) {
          if (timer) { clearTimeout(timer); timer = null; }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (data) {
          var matches = normalizeSponsors(data).filter(function (s) {
            return String(s.id).toUpperCase() === query;
          });
          renderSponsorItems(matches);
        })
        .catch(function (err) {
          if (timer) { clearTimeout(timer); timer = null; }
          if (err && err.name === 'AbortError') return; // superseded by a newer keystroke
          console.error('[Enrollment] Sponsor search failed:', err);
          showResultsMessage(i18n('sponsor_failed', 'Search failed. Please try again.'), true);
        });
    }

    function openDropdown() {
      if (!list) return;
      list.style.display = 'block';
      if (dropdown) dropdown.classList.add('active');
      if (searchInput) {
        searchInput.value = '';
        showResultsMessage(i18n('sponsor_enter_id', 'Enter a Sponsor ID to search…'), false);
        searchInput.focus();
      }
    }
    function closeDropdown() {
      if (list) list.style.display = 'none';
      if (dropdown) dropdown.classList.remove('active');
    }

    // Dropdown open/close
    if (dropdown && list) {
      dropdown.addEventListener('click', function () {
        if (this.classList.contains('is-loading') || lockedSponsorId) return;
        if (list.style.display === 'block') { closeDropdown(); } else { openDropdown(); }
      });
    }

    // Debounced typeahead search — Sponsor ID (optional 1-2 letter prefix + digits).
    if (searchInput) {
      var searchDebounce = null;
      searchInput.addEventListener('input', function () {
        // Only trim surrounding whitespace and uppercase letters here — an
        // invalid ID (e.g. "ABC123", "D100X") is left as-is, not silently
        // rewritten into a different, valid-looking ID. Validity itself is
        // checked inside searchSponsors().
        var normalized = normalizeSponsorId(this.value);
        if (normalized !== this.value) this.value = normalized;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(function () { searchSponsors(normalized); }, 250);
      });
      // Keep the panel open while interacting with the input.
      searchInput.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    // Close when clicking outside the picker.
    document.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('.custom-dropdown')) closeDropdown();
    });

    // Continue button
    if (continueBtn) {
      continueBtn.addEventListener('click', function () {
        if (!selectedDistributor) {
          alert(i18n('sponsor_required', 'Please select a distributor.'));
          return;
        }
        step1.style.display = 'none';
        step2.style.display = 'block';
      });
    }

    // ── Auto-advance if the sponsor is already known ──────────────────────────
    //
    // Resolution order (first non-empty wins):
    //   1. URL param (case-insensitive, uses APEX config aliases)
    //   2. localStorage apex_enrollment_sponsor (id + name, TTL-checked)
    //   3. cookie apex_sponsor_id (id only)
    //
    // If any source resolves, step 1 is skipped entirely. We no longer fetch
    // the full roster up front — the picker is search-driven — so the display
    // name comes from localStorage when available, otherwise the id itself.

    setDropdownState('ready');
    showResultsMessage(i18n('sponsor_enter_id', 'Enter a Sponsor ID to search…'), false);

    (function resolveKnownSponsor() {
      // EBO (register for another influencer): the sponsor is the one chosen
      // in the dashboard — the rep or someone in their downline — taken from
      // the link (or the cart, on later pages) and locked. Never the stored
      // sponsor or the paying rep: without one in the link, the rep picks in
      // step 1.
      var obo = window.AvaObo;
      if (obo && obo.type() === 'ebo') {
        var eboId = obo.sponsorId();
        if (!eboId) return;
        var eboLs = lsGetEnrollmentSponsor();
        lockedSponsorId = eboId;
        selectDistributor(eboId, (eboLs && eboLs.id === eboId && eboLs.name) || eboId);
        if (dropdown) dropdown.classList.add('is-locked');
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = 'block';

        // Display name only; the id is already locked in.
        if (sponsorUrl && selectedDistributor.name === eboId) {
          fetch(buildSearchUrl(sponsorUrl, eboId))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              var match = normalizeSponsors(data).filter(function (s) {
                return String(s.id).toUpperCase() === eboId;
              })[0];
              if (match && match.name) selectDistributor(eboId, match.name);
            })
            .catch(function () {});
        }
        return;
      }

      var urlId    = readUrlSponsorId();
      var lsData   = lsGetEnrollmentSponsor();
      var cookieId = getCookieBasic('apex_sponsor_id');

      var resolvedId = urlId || (lsData && lsData.id) || cookieId || '';
      if (!resolvedId) return; // no sponsor — show step 1 as normal

      var resolvedName = (lsData && lsData.id === resolvedId && lsData.name)
        ? lsData.name
        : resolvedId;

      selectDistributor(resolvedId, resolvedName);

      // Hide step 1, jump straight to kit selection
      if (step1) step1.style.display = 'none';
      if (step2) step2.style.display = 'block';
    })();

    // ── Step 2: starter kit selection ────────────────────────────────────────

    step2Cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var isAvailable = this.querySelector('.is-available') ? this.querySelector('.is-available').value : 'true';
        if (isAvailable === 'false') {
          showEnrollmentPopup(i18n('popup_sold_out', 'This product is sold out. Please select another available product to continue.'));
          return;
        }
        step2Cards.forEach(function (c) { c.classList.remove('active'); });
        this.classList.add('active');
        selectedMainProduct  = this.querySelector('.variant-id')    ? this.querySelector('.variant-id').value    : null;
        selectedSellingPlan  = this.querySelector('.selling-plan-id') ? this.querySelector('.selling-plan-id').value : null;
        console.log('🟢 Step2 Selected:', selectedMainProduct);
        renderSummary();
      });
    });

    function goToStep(hideEl, showEl) {
      if (hideEl) hideEl.style.display = 'none';
      if (showEl) showEl.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Step 2 (kit) → Step 3 (additional products). Requires a kit.
    if (step2NextBtn) {
      step2NextBtn.addEventListener('click', function () {
        if (!selectedMainProduct) {
          showEnrollmentPopup(i18n('popup_select_before_continue', 'Please select a product before continuing. Choose one package to proceed to the next step.'));
          return;
        }
        goToStep(step2, step3);
      });
    }

    // Step 3 (additional products) → Shipping (when enabled) → Step 4 (review)
    function afterAddonsStep() {
      if (!shipping) return step4;
      shipping.load();
      return stepShipping;
    }
    if (step3NextBtn) {
      step3NextBtn.addEventListener('click', function () { goToStep(step3, afterAddonsStep()); });
    }
    if (shipping) {
      var shippingBackBtn = stepShipping.querySelector('.shipping-back');
      var shippingNextBtn = stepShipping.querySelector('.shipping-next-btn');
      if (shippingBackBtn) {
        shippingBackBtn.addEventListener('click', function () { goToStep(stepShipping, step3); });
      }
      if (shippingNextBtn) {
        shippingNextBtn.addEventListener('click', function () {
          // Only a validated address reaches review (and checkout).
          shippingNextBtn.disabled = true;
          shipping.validate().then(function (ok) {
            shippingNextBtn.disabled = false;
            if (ok) goToStep(stepShipping, step4);
          });
        });
      }
    }

    // Back buttons
    if (step3BackBtn) {
      step3BackBtn.addEventListener('click', function () { goToStep(step3, step2); });
    }
    if (step4BackBtn) {
      step4BackBtn.addEventListener('click', function () { goToStep(step4, shipping ? stepShipping : step3); });
    }

    // Step 4 bottom "Proceed to Checkout" (mirrors the sidebar button)
    var step4CheckoutBtn = document.querySelector('.step4-checkout-btn');
    if (step4CheckoutBtn) {
      step4CheckoutBtn.addEventListener('click', goToCheckout);
    }

    // ── Step 3: additional products ───────────────────────────────────────────

    var additionalCards = document.querySelectorAll('.additional-products .package-card');

    additionalCards.forEach(function (card) {
      var plus    = card.querySelector('.qty-plus');
      var minus   = card.querySelector('.qty-minus');
      var input   = card.querySelector('.qty-input');
      var selectCircle = card.querySelector('.select-circle');
      var image   = card.querySelector('img');
      var addToCartBtn = card.querySelector('.add-to-cart-btn');

      var variantId   = card.querySelector('.variant-id').value;
      var isAvailable = card.querySelector('.is-available') ? card.querySelector('.is-available').value : 'true';

      if (isAvailable === 'false') {
        card.classList.add('is-sold-out');
        if (plus)  plus.disabled  = true;
        if (minus) minus.disabled = true;
        if (input) { input.disabled = true; input.value = 0; }
        return;
      }

      input.value = 0;

      function syncQtyUI(qty) {
        if (!addToCartBtn || !input) return;
        if (qty > 0) {
          addToCartBtn.style.display = "none";
          input.closest(".qty-box")?.classList.remove("is-hidden");
        } else {
          addToCartBtn.style.display = "block";
          input.closest(".qty-box")?.classList.add("is-hidden");
        }
      }

      syncQtyUI(0);

      function toggleSelection() {
        var qty = parseInt(input.value) || 0;
        if (qty <= 0) {
          qty = 1;
          input.value = qty;
          card.classList.add('active');
          additionalProducts[variantId] = qty;
          console.log('SELECT:', variantId, qty);
        } else {
          input.value = 0;
          card.classList.remove('active');
          delete additionalProducts[variantId];
          console.log('DESELECT:', variantId);
        }
        syncQtyUI(parseInt(input.value) || 0);
        renderSummary();
      }

      selectCircle.addEventListener('click', toggleSelection);
      if (image) image.addEventListener('click', toggleSelection);

      // "Add to cart" adds the item at qty 1 and reveals the qty stepper
      if (addToCartBtn) {
        addToCartBtn.addEventListener('click', function () {
          input.value = 1;
          card.classList.add('active');
          additionalProducts[variantId] = 1;
          console.log('ADD TO CART:', variantId, 1);
          syncQtyUI(1);
          renderSummary();
        });
      }

      plus.addEventListener('click', function () {
        var qty = (parseInt(input.value) || 0) + 1;
        input.value = qty;
        card.classList.add('active');
        additionalProducts[variantId] = qty;
        console.log('ADD:', variantId, qty);
        syncQtyUI(qty);
        renderSummary();
      });

      minus.addEventListener('click', function () {
        var qty = (parseInt(input.value) || 0) - 1;
        if (qty <= 0) {
          input.value = 0;
          card.classList.remove('active');
          delete additionalProducts[variantId];
          console.log('REMOVE:', variantId);
        } else {
          input.value = qty;
          additionalProducts[variantId] = qty;
          console.log('UPDATE:', variantId, qty);
        }
        syncQtyUI(parseInt(input.value) || 0);
        renderSummary();
      });

      input.addEventListener('input', function () {
        var qty = parseInt(input.value) || 0;
        if (qty <= 0) {
          input.value = 0;
          card.classList.remove('active');
          delete additionalProducts[variantId];
          console.log('REMOVED VIA INPUT:', variantId);
        } else {
          card.classList.add('active');
          additionalProducts[variantId] = qty;
          console.log('UPDATED VIA INPUT:', variantId, qty);
        }
        syncQtyUI(parseInt(input.value) || 0);
        renderSummary();
      });
    });

    // ── Checkout ──────────────────────────────────────────────────────────────

    if (finalCheckoutBtn) {
      finalCheckoutBtn.addEventListener('click', function () {
        console.log('🟡 Checkout Clicked');
        goToCheckout();
      });
    }

    // ── Tooltip: click-to-toggle for touch devices ────────────────────────────
    document.querySelectorAll('.info-icon').forEach(function (icon) {
      icon.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = this.classList.contains('is-open');
        // Close any other open tooltips first
        document.querySelectorAll('.info-icon.is-open').forEach(function (el) {
          el.classList.remove('is-open');
        });
        if (!isOpen) this.classList.add('is-open');
      });
    });

    document.addEventListener('click', function () {
      document.querySelectorAll('.info-icon.is-open').forEach(function (el) {
        el.classList.remove('is-open');
      });
    });

  } catch (error) {
    console.error('❌ Global Error:', error);
  }
});
