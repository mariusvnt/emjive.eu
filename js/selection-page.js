// launch-order.html: the checkout review of window.EmjiveSelection — item rows
// (js/order-rows.js; a tap opens the Modify sheet), shipping pick, terms
// toggle, and a "Proceed to checkout" bar gated on both. While the Modify
// sheet is open the bar becomes its Unselect | Save strip, with a drawer
// showing the tapped row under the sheet. Shows .selection-empty when empty.

(function () {
  "use strict";

  var listEl = document.getElementById("selectionList");
  if (!listEl) return;

  var emptyEl = document.getElementById("selectionEmpty");
  var itemsEl = document.getElementById("selectionItems");
  var backLink = emptyEl.querySelector(".selection-empty__back");

  var shippingOptionsEl = document.getElementById("orderShippingOptions");
  var termsEl = document.getElementById("orderTerms");
  var termsToggleEl = document.getElementById("orderTermsToggle");

  var checkoutBar = document.getElementById("orderCheckoutBar");
  var checkoutRow = checkoutBar.querySelector(".order-checkout-bar__row");
  var checkoutTotalEl = document.getElementById("orderCheckoutTotal");
  var checkoutButton = document.getElementById("orderCheckoutButton");

  // Placeholder carriers and prices.
  var SHIPPING_OPTIONS = [
    { id: "standard", name: "Standard shipping", price: 0 },
    { id: "express", name: "Express shipping", price: 15 }
  ];
  var selectedShippingId = SHIPPING_OPTIONS[0].id;
  var termsAccepted = false;

  // Falls back to the first option, which is also the initial selection.
  function selectedShippingOption() {
    for (var i = 0; i < SHIPPING_OPTIONS.length; i++) {
      if (SHIPPING_OPTIONS[i].id === selectedShippingId) return SHIPPING_OPTIONS[i];
    }
    return SHIPPING_OPTIONS[0];
  }

  function updateCheckoutGate() {
    checkoutButton.disabled = !(selectedShippingId && termsAccepted);
  }

  /* ---- checkout bar as the Modify sheet's strip ----
     The swap is CSS (.is-strip-active); this flips classes and makes the hidden
     half inert. stripFading keeps the bar up while the strip fades out after
     the last item's Unselect. */
  var stripShown = false;
  var stripFading = false;
  var stripFadeTimer = 0;
  var STRIP_FADE_MS = 300;

  var stripHost = {
    el: checkoutBar,
    show: function (strip) {
      stripShown = true;
      checkoutBar.hidden = false;
      checkoutBar.classList.add("is-strip-active");
      checkoutRow.inert = true;
      strip.classList.remove("is-hidden");
      strip.setAttribute("aria-hidden", "false");
      strip.inert = false;
    },
    hide: function (strip) {
      stripShown = false;
      checkoutBar.classList.remove("is-strip-active");
      checkoutRow.inert = false;
      strip.classList.add("is-hidden");
      strip.setAttribute("aria-hidden", "true");
      strip.inert = true;
      stripFading = true;
      clearTimeout(stripFadeTimer);
      stripFadeTimer = setTimeout(function () {
        stripFading = false;
        updateCheckoutSummary();
      }, STRIP_FADE_MS);
      updateCheckoutSummary();
    }
  };
  // Attached up front, not mid-Modify. Modify is optional here: the page works
  // without the sheet script.
  if (window.EmjiveModifyModal) window.EmjiveModifyModal.attach(stripHost);

  /* ---- the drawer over the checkout bar ----
     Like the floating bar's drawer on other pages: a copy of the tapped row
     between the bar and the sheet, which rests on it through
     --selection-bar-live-height. Opens and closes with the sheet. Visual only:
     inert and aria-hidden (the real row is in the list). */
  var rowDrawer = document.createElement("div");
  rowDrawer.className = "order-checkout-drawer";
  rowDrawer.setAttribute("aria-hidden", "true");
  rowDrawer.inert = true;
  var rowDrawerList = document.createElement("ul");
  rowDrawerList.className = "order-checkout-drawer__rows";
  rowDrawer.appendChild(rowDrawerList);
  checkoutBar.parentNode.insertBefore(rowDrawer, checkoutBar);

  var drawerRows = window.EmjiveOrderRows.create({
    listEl: rowDrawerList,
    rowClass: "order-item--drawer",
    showPrice: true,
    onModify: function () {}
  });
  // The item shown in the drawer while open.
  var drawerIndex = null;

  function setLiveHeight(drawerHeight) {
    var root = document.documentElement;
    if (drawerHeight === null) {
      root.style.removeProperty("--selection-bar-live-height");
      return;
    }
    root.style.setProperty("--selection-bar-live-height", checkoutRow.getBoundingClientRect().height + drawerHeight + "px");
  }

  function openRowDrawer(index) {
    var item = window.EmjiveSelection.getSelection()[index];
    if (!item) return;
    drawerIndex = index;
    drawerRows.render([item], { animate: false });
    // Laid out while shut (max-height, not display), so it measures true.
    var height = rowDrawerList.offsetHeight;
    rowDrawer.style.maxHeight = height + "px";
    setLiveHeight(height);
  }

  function closeRowDrawer() {
    drawerIndex = null;
    rowDrawer.style.maxHeight = "0px";
    setLiveHeight(null);
  }

  // Recomputed from scratch after every change. Shipping is included in the
  // one total shown; any unpriced (price 0) item makes it "TBD".
  function updateCheckoutSummary() {
    var items = window.EmjiveSelection.getSelection();
    checkoutBar.hidden = !items.length && !stripShown && !stripFading;
    checkoutBar.classList.toggle("is-empty", !items.length);
    var total = selectedShippingOption().price || 0;
    var unpriced = false;
    items.forEach(function (item) {
      total += item.price || 0;
      if (!(item.price > 0)) unpriced = true;
    });
    checkoutTotalEl.textContent = unpriced ? "TBD" : window.EmjiveSelection.formatPrice(total);
  }

  /* ---- list <-> empty state ---- */

  // Mirrors --fade-standard (css/style.css).
  var CROSSFADE_MS = 300;
  var fadeToken = 0;

  // Sequential opacity crossfade between the list and the empty state ([hidden]
  // can't transition, and the two aren't stacked). A newer crossfade cancels
  // one under way (fadeToken).
  function crossfade(fromEl, toEl) {
    var token = ++fadeToken;

    function fadeIn() {
      if (token !== fadeToken) return;
      fromEl.hidden = true;
      fromEl.style.transition = "";
      fromEl.style.opacity = "";

      toEl.hidden = false;
      toEl.style.transition = "none";
      toEl.style.opacity = "0";
      void toEl.offsetWidth;
      // Double rAF so the opacity 0 start state paints before the transition.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (token !== fadeToken) return;
          toEl.style.transition = "opacity " + CROSSFADE_MS + "ms ease";
          toEl.style.opacity = "1";
          toEl.addEventListener("transitionend", function onEnd(e) {
            if (e.target !== toEl || e.propertyName !== "opacity") return;
            toEl.removeEventListener("transitionend", onEnd);
            if (token !== fadeToken) return;
            toEl.style.transition = "";
            toEl.style.opacity = "";
          });
        });
      });
    }

    if (fromEl.hidden) {
      fadeIn();
      return;
    }

    fromEl.style.transition = "opacity " + CROSSFADE_MS + "ms ease";
    fromEl.style.opacity = "0";
    var swapped = false;
    // The rows' own opacity transitions bubble up here.
    function onEnd(e) {
      if (e.target !== fromEl || e.propertyName !== "opacity") return;
      swap();
    }
    function swap() {
      if (swapped) return;
      swapped = true;
      fromEl.removeEventListener("transitionend", onEnd);
      fadeIn();
    }
    fromEl.addEventListener("transitionend", onEnd);
    // In case transitionend never fires (background tab).
    setTimeout(swap, CROSSFADE_MS + 50);
  }

  /* ---- rows + Modify ---- */

  // null before the first render, then "list" or "empty".
  var listState = null;

  // Focus returns to the row, looked up late as rows come and go; the
  // fallback is the empty state's "Back to gallery".
  function openModify(binding) {
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      bar: stripHost,
      // Both copies of the row: the list's and the drawer's (index 0).
      onPreview: function (index, values) {
        rows.preview(index, values);
        if (drawerIndex !== null) drawerRows.preview(0, values);
      },
      onOpen: function () { openRowDrawer(binding.index); },
      onClose: closeRowDrawer,
      // The row stays as its Undo; when it goes, an empty list gives way to the empty state.
      offerUndo: function (index, handlers) {
        return rows.offerUndo(index, {
          onUndo: handlers.onUndo,
          onGone: function () {
            handlers.onGone();
            render();
          }
        });
      },
      returnFocus: function () {
        return listState === "list" ? rows.buttonAt(binding.index) : null;
      },
      fallbackFocus: function () {
        // The top row, the latest.
        return (listState === "list" && rows.buttonAt(window.EmjiveSelection.getSelection().length - 1)) || backLink;
      }
    });
  }

  var rows = window.EmjiveOrderRows.create({
    listEl: itemsEl,
    showPrice: true,
    newestFirst: true,
    onModify: openModify
  });

  /* ---- shipping ---- */

  function renderShippingOptions() {
    shippingOptionsEl.innerHTML = "";
    SHIPPING_OPTIONS.forEach(function (option) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "order-shipping__option";
      btn.classList.toggle("is-selected", option.id === selectedShippingId);
      btn.setAttribute("aria-pressed", String(option.id === selectedShippingId));

      var name = document.createElement("span");
      name.className = "order-shipping__option-name";
      name.textContent = option.name;

      var price = document.createElement("span");
      price.className = "order-shipping__option-price";
      price.textContent = option.price ? window.EmjiveSelection.formatPrice(option.price) : "Free";

      btn.appendChild(name);
      btn.appendChild(price);
      btn.addEventListener("click", function () {
        selectedShippingId = option.id;
        renderShippingOptions();
        updateCheckoutGate();
        // The one change to the total that doesn't go through storage.
        updateCheckoutSummary();
      });
      shippingOptionsEl.appendChild(btn);
    });
  }

  /* ---- terms: a click anywhere on the row toggles, except on the link ---- */
  termsEl.addEventListener("click", function (e) {
    if (e.target.closest("a")) return;
    termsAccepted = !termsAccepted;
    termsToggleEl.classList.toggle("is-checked", termsAccepted);
    termsToggleEl.setAttribute("aria-checked", String(termsAccepted));
    updateCheckoutGate();
  });

  /* ---- checkout: no backend yet, so a notice. Inert while the bar is the strip. ---- */
  checkoutButton.addEventListener("click", function () {
    if (checkoutButton.disabled || stripShown) return;
    window.EmjiveOrderRows.notice("Checkout isn't connected yet. Wire this up to a Stripe Checkout session once the backend exists.");
  });

  /* ---- render ----
     On load and on every "emjive:selection-changed". Rows animate only the
     touched row; list and empty state crossfade when the last item leaves or an
     Undo returns it. A Save also refreshes the drawer's copy. */
  function render(e) {
    var items = window.EmjiveSelection.getSelection();

    var change = e && e.detail;
    if (drawerIndex !== null && change && change.action === "update" && items[drawerIndex]) {
      drawerRows.render([items[drawerIndex]], { animate: true });
    }

    // A row held as an Undo keeps the list up.
    if (items.length || rows.isHolding()) {
      if (listState === "empty") {
        rows.render(items, { animate: false });
        crossfade(emptyEl, listEl);
      } else {
        rows.render(items, { animate: listState === "list" });
        if (listState === null) {
          emptyEl.hidden = true;
          listEl.hidden = false;
        }
      }
      listState = "list";
    } else {
      if (listState === "list") {
        crossfade(listEl, emptyEl);
      } else if (listState === null) {
        listEl.hidden = true;
        emptyEl.hidden = false;
      }
      listState = "empty";
    }

    updateCheckoutSummary();
  }

  window.addEventListener("emjive:selection-changed", render);

  renderShippingOptions();
  updateCheckoutGate();
  render();
})();
