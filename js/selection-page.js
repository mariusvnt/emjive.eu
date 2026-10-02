/* ==========================================================================
   J&MV — order page
   Renders window.EmjiveSelection's contents into launch-order.html as a
   full checkout review: item rows (js/order-rows.js, shared with the
   floating bar's drawer — a tap on one opens the Modify sheet), a
   shipping-option pick, a terms-acceptance toggle, and a fixed "Proceed to
   checkout" bar gated on both of those. While the Modify sheet
   (js/modify-modal.js) is open that bar turns into its Unselect | Save
   strip — and, after an Unselect, into "Undo" for a few seconds — with a
   drawer opened over it showing the row that was tapped, the sheet resting
   right on top of it. Falls
   back to the static .selection-empty block when there's nothing selected.
   ========================================================================== */

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

  // Placeholders for now (prices included) — a real carrier/rate list
  // later is just editing these entries, not a restructure of the
  // section around them.
  var SHIPPING_OPTIONS = [
    { id: "standard", name: "Standard shipping", price: 0 },
    { id: "express", name: "Express shipping", price: 15 }
  ];
  var selectedShippingId = SHIPPING_OPTIONS[0].id;
  var termsAccepted = false;

  // Falls back to the first option rather than returning undefined: every
  // caller wants a price out of this, and SHIPPING_OPTIONS[0] is also what
  // selectedShippingId is seeded with, so a desynced id resolves to the
  // option the UI is already showing as selected instead of silently
  // dropping shipping from the total.
  function selectedShippingOption() {
    for (var i = 0; i < SHIPPING_OPTIONS.length; i++) {
      if (SHIPPING_OPTIONS[i].id === selectedShippingId) return SHIPPING_OPTIONS[i];
    }
    return SHIPPING_OPTIONS[0];
  }

  function updateCheckoutGate() {
    checkoutButton.disabled = !(selectedShippingId && termsAccepted);
  }

  /* ---- checkout bar as the Modify sheet's strip ------------------------------
     While the sheet is open, its Unselect | Save strip (built by
     js/modify-modal.js, appended into this bar) covers the bar, and after
     an Unselect the strip stays on as "Undo". The swap itself is pure CSS
     (.order-checkout-bar.is-strip-active, sequenced with transition-delay
     so the total and "Proceed to checkout" are gone before the strip
     arrives); this flips the classes and keeps whichever half isn't
     showing out of reach. stripShown also keeps the bar up through an
     "Undo" that follows the last item out. */
  var stripShown = false;

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
      updateCheckoutSummary();
    }
  };
  // The strip goes into the bar now, hidden, rather than in the middle of
  // the first Modify.
  window.EmjiveModifyModal.attach(stripHost);

  /* ---- the drawer over the checkout bar ---------------------------------------
     The floating bar on every other page opens the Modify sheet from its
     drawer, which then shrinks down to the one row tapped, with the sheet
     resting right on it. This page's list is the page itself, so its bar
     has no drawer to shrink — instead one opens, between the bar and the
     sheet, holding a copy of the row that was tapped: the same row
     component, the same drawer look, the same result. Built here, once;
     opened as the sheet slides up and closed as it slides away, both on the
     drawer's own 0.3s max-height transition — in step with the sheet, which
     rests on top of it through --selection-bar-live-height (the property
     the floating bar publishes for the same purpose). A copy for the eye
     only: inert, and hidden from assistive tech, which already has the
     real row. */
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
    showPrice: false,
    onModify: function () {}
  });
  // The index of the item the drawer is showing, while it's open.
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
    // Laid out even while the drawer is shut (max-height, not display), so
    // it measures at its real size.
    var height = rowDrawerList.offsetHeight;
    rowDrawer.style.maxHeight = height + "px";
    setLiveHeight(height);
  }

  function closeRowDrawer() {
    drawerIndex = null;
    rowDrawer.style.maxHeight = "0px";
    setLiveHeight(null);
  }

  // Keeps the checkout total/visibility in sync with storage — cheap
  // enough to just recompute from scratch rather than tracking a running
  // total. Runs on every render() (so after every Modify, Unselect and
  // Undo), from the strip's hide above, and from the shipping buttons.
  //
  // Shipping is part of the total, not a separate line: this bar shows one
  // figure, and a "total" that silently excluded the € 15 the visitor just
  // picked would be the one number on the page that's wrong. Also called
  // from the shipping buttons' own click handler, since changing carrier
  // changes this without touching storage at all.
  //
  // A `price: 0` item contributes 0 rather than poisoning the whole sum:
  // that's today's "Price on request" placeholder, which is transitional —
  // every product carries a real price at launch. See data.md's
  // per-metal-specs notes.
  function updateCheckoutSummary() {
    var items = window.EmjiveSelection.getSelection();
    checkoutBar.hidden = !items.length && !stripShown;
    var total = selectedShippingOption().price || 0;
    items.forEach(function (item) { total += item.price || 0; });
    checkoutTotalEl.textContent = window.EmjiveSelection.formatPrice(total);
  }

  /* ---- list <-> empty state ------------------------------------------------ */

  // Mirrors --fade-standard in css/style.css — written directly into an
  // inline transition string below rather than read from the CSS custom
  // property, matching this file's own existing convention for JS-side
  // fallback timers (js/order-rows.js's ROW_MOTION_MS/SWAP_OUT_MS,
  // js/modify-modal.js's LEAVE_MS).
  var CROSSFADE_MS = 300;
  var fadeToken = 0;

  // Smooths the switch between the list and the "No selected item" empty
  // state, either way — a plain sequential opacity crossfade (the one
  // showing fades out, then the other fades in), hand-orchestrated because
  // [hidden] means display:none, which can't itself transition. Sequential,
  // not simultaneous, since the two aren't stacked on top of each other —
  // fading both at once would show list and empty-state content
  // overlapping mid-fade. One motion for the whole list: its last row
  // doesn't collapse on its own first, it rides out with the rest. A newer
  // crossfade supersedes one still under way (an Undo straight after the
  // last item left) — fadeToken.
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
      // Double rAF: guarantees a real paint of the opacity:0 starting
      // state has happened before the transition to 1 is triggered, so it
      // actually registers instead of coalescing into one paint with no
      // fade.
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
    // e.target, not just the property: the rows inside the list run
    // opacity transitions of their own, and theirs bubble up to here.
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
    // Fallback in case transitionend never fires (e.g. a backgrounded tab)
    // — same backstop convention js/order-rows.js uses.
    setTimeout(swap, CROSSFADE_MS + 50);
  }

  /* ---- rows + Modify --------------------------------------------------------- */

  // null before the first render, then "list" or "empty": which of the
  // two is showing (or on its way in).
  var listState = null;

  // The drawer over the bar opens with the sheet and closes with it (see
  // above). Focus goes back to the row — updated in place on a Save and put
  // back in place by an Undo — looked up when it's needed, since rows come
  // and go. Nothing while the empty state is showing; the fallback then is
  // the empty state's "Back to gallery" link.
  function openModify(binding) {
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      bar: stripHost,
      // Both copies of the row: the list's, and the drawer's (which holds
      // just that one item, at index 0).
      onPreview: function (index, values) {
        rows.preview(index, values);
        if (drawerIndex !== null) drawerRows.preview(0, values);
      },
      onOpen: function () { openRowDrawer(binding.index); },
      onClose: closeRowDrawer,
      returnFocus: function () {
        return listState === "list" ? rows.buttonAt(binding.index) : null;
      },
      fallbackFocus: function () {
        return (listState === "list" && rows.buttonAt(0)) || backLink;
      }
    });
  }

  var rows = window.EmjiveOrderRows.create({
    listEl: itemsEl,
    showPrice: true,
    onModify: openModify
  });

  /* ---- shipping ------------------------------------------------------- */

  function renderShippingOptions() {
    shippingOptionsEl.innerHTML = "";
    SHIPPING_OPTIONS.forEach(function (option) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "order-shipping__option";
      btn.classList.toggle("is-selected", option.id === selectedShippingId);
      // Same gap as the metal and size pickers: the chosen carrier was a
      // CSS class only, on a control that now changes the total.
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
        // Shipping is part of the total (see updateCheckoutSummary), and
        // this is the one mutation that changes it without going through
        // storage — so nothing else would refresh the bar.
        updateCheckoutSummary();
      });
      shippingOptionsEl.appendChild(btn);
    });
  }

  /* ---- terms --------------------------------------------------------------
     A single delegated listener on the whole row: clicking the dedicated
     tick box or the surrounding sentence both flip it, but a click that
     lands on the "terms & conditions" link inside that sentence navigates
     instead — same "toggle vs. its own separately-clickable label" split
     js/selection-bar.js uses for its drawer toggle/empty-label pair. */
  termsEl.addEventListener("click", function (e) {
    if (e.target.closest("a")) return;
    termsAccepted = !termsAccepted;
    termsToggleEl.classList.toggle("is-checked", termsAccepted);
    termsToggleEl.setAttribute("aria-pressed", String(termsAccepted));
    updateCheckoutGate();
  });

  /* ---- checkout -------------------------------------------------------
     No backend yet — same "isn't connected yet" stub js/main.js's contact
     form uses, until a real Stripe Checkout session exists to redirect to.
     Inert while the bar is standing in as the Modify sheet's strip. */
  checkoutButton.addEventListener("click", function () {
    if (checkoutButton.disabled || stripShown) return;
    alert("Checkout isn't connected yet. Wire this up to a Stripe Checkout session once the backend exists.");
  });

  /* ---- render -----------------------------------------------------------
     On load, then after every change to the selection — a Modify, an
     Unselect or an Undo, all made in the Modify sheet and all announced by
     js/selection.js's "emjive:selection-changed", synchronously, from inside
     the call that made them. The rows animate just the one row a change
     touched (js/order-rows.js); the list and the empty state crossfade when
     the last item leaves, and back when an Undo returns it — the rows kept
     as they were meanwhile, so the returning one is simply still there.
     A Save also crossfades the copy in the drawer over the bar, the way the
     floating bar's drawer row does; an Unselect leaves that copy alone — the
     drawer is closing with the sheet anyway, and takes it along. */
  function render(e) {
    var items = window.EmjiveSelection.getSelection();

    var change = e && e.detail;
    if (drawerIndex !== null && change && change.action === "update" && items[drawerIndex]) {
      drawerRows.render([items[drawerIndex]], { animate: true });
    }

    if (items.length) {
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
