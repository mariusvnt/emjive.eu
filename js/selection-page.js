/* ==========================================================================
   J&MV — order page
   Renders window.EmjiveSelection's contents into launch-order.html as a
   full checkout review: item rows (each with a Modify/Unselect overlay and
   its own Undo — js/order-rows.js, shared with the floating bar's drawer),
   a shipping-option pick, a terms-acceptance toggle, and a fixed "Proceed
   to checkout" bar gated on both of those. That bar doubles as the Modify
   sheet's "Save" (js/modify-modal.js) while the sheet is open. Falls back
   to the static .selection-empty block when there's nothing selected.
   ========================================================================== */

(function () {
  "use strict";

  var listEl = document.getElementById("selectionList");
  if (!listEl) return;

  var emptyEl = document.getElementById("selectionEmpty");
  var itemsEl = document.getElementById("selectionItems");

  var shippingOptionsEl = document.getElementById("orderShippingOptions");
  var termsEl = document.getElementById("orderTerms");
  var termsToggleEl = document.getElementById("orderTermsToggle");

  var checkoutBar = document.getElementById("orderCheckoutBar");
  var checkoutTotalEl = document.getElementById("orderCheckoutTotal");
  var checkoutButton = document.getElementById("orderCheckoutButton");
  var checkoutSaveBtn = document.getElementById("orderCheckoutSave");

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

  // How long the list-to-empty-state crossfade takes once the last row's
  // undo window is truly over — see crossfadeToEmpty().
  var EMPTY_CROSSFADE_MS = 300;

  // Keeps the checkout total/visibility in sync with storage after every
  // Unselect/Undo — cheap enough to just recompute from scratch rather
  // than tracking a running total, and decoupled from render() since
  // neither action rebuilds the row list.
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
    checkoutBar.hidden = !items.length;
    var total = selectedShippingOption().price || 0;
    items.forEach(function (item) { total += item.price || 0; });
    checkoutTotalEl.textContent = window.EmjiveSelection.formatPrice(total);
  }

  // Smooths the switch from the list into the "No selected item" empty
  // state — a plain sequential opacity crossfade (list fades out, then
  // the empty state fades in), hand-orchestrated because [hidden] means
  // display:none, which can't itself transition. Sequential, not
  // simultaneous, since the two aren't stacked on top of each other —
  // fading both at once would show list and empty-state content
  // overlapping mid-fade. Runs instead of a normal per-row collapse when
  // the very last pending row's own window runs out (js/order-rows.js's
  // onEmptied) — one motion, not two: that row stays at full size and
  // rides out with the rest of the list as this fades it away, rather
  // than first collapsing itself away on its own and only then having the
  // (now empty) list separately fade into place.
  function crossfadeToEmpty() {
    listEl.style.transition = "opacity " + EMPTY_CROSSFADE_MS + "ms ease";
    listEl.style.opacity = "0";
    var swapped = false;
    function swapToEmpty() {
      if (swapped) return;
      swapped = true;
      listEl.hidden = true;
      listEl.style.transition = "";
      listEl.style.opacity = "";
      checkoutBar.hidden = true;

      emptyEl.hidden = false;
      emptyEl.style.transition = "none";
      emptyEl.style.opacity = "0";
      void emptyEl.offsetWidth;
      // Double rAF: guarantees a real paint of the opacity:0 starting
      // state has happened before the transition to 1 is triggered, so it
      // actually registers instead of coalescing into one paint with no
      // fade.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          emptyEl.style.transition = "opacity " + EMPTY_CROSSFADE_MS + "ms ease";
          emptyEl.style.opacity = "1";
          emptyEl.addEventListener("transitionend", function onEnd(e) {
            if (e.propertyName !== "opacity") return;
            emptyEl.removeEventListener("transitionend", onEnd);
            emptyEl.style.transition = "";
            emptyEl.style.opacity = "";
          });
        });
      });
    }
    listEl.addEventListener("transitionend", function onEnd(e) {
      if (e.propertyName !== "opacity") return;
      listEl.removeEventListener("transitionend", onEnd);
      swapToEmpty();
    });
    // Fallback in case transitionend never fires (e.g. reduced-motion
    // environments that skip the transition outright) — same backstop
    // convention js/order-rows.js uses for a normal row collapse.
    setTimeout(swapToEmpty, EMPTY_CROSSFADE_MS + 50);
  }

  /* ---- checkout bar as the Modify sheet's "Save" -----------------------------
     While the sheet is open with a valid size, the whole bar crossfades
     from total + "Proceed to checkout" to a single centered "Save" — the
     same handoff product.html's floating bar does for "Add" — and the whole
     bar becomes its hit target. The crossfade itself is pure CSS
     (.order-checkout-bar.is-save-active, sequenced with transition-delay);
     this only flips the class and remembers what Save should do. */
  var pendingSave = null;

  function showCheckoutSave(onConfirm) {
    pendingSave = onConfirm;
    checkoutBar.classList.add("is-save-active");
    checkoutSaveBtn.setAttribute("aria-hidden", "false");
    checkoutSaveBtn.removeAttribute("tabindex");
  }

  function hideCheckoutSave() {
    pendingSave = null;
    checkoutBar.classList.remove("is-save-active");
    checkoutSaveBtn.setAttribute("aria-hidden", "true");
    checkoutSaveBtn.setAttribute("tabindex", "-1");
  }

  // Anywhere on the bar, including a keyboard activation of the Save
  // button itself (which dispatches a real, bubbling click) — so the button
  // has no listener of its own, or a direct click would save twice.
  checkoutBar.addEventListener("click", function () {
    if (checkoutBar.classList.contains("is-save-active") && pendingSave) pendingSave();
  });

  /* ---- rows + Modify --------------------------------------------------------- */

  // Where focus goes when the sheet closes. A FUNCTION, not the button that
  // opened it, because that button is routinely gone by then: saving a
  // Modify calls render(), which rebuilds every row from scratch, so the
  // trigger is detached even on the ordinary success path — not just when
  // the row was unselected. Looking the row up by index instead lands on
  // whatever occupies that slot now, falling back to the last row if the
  // list shrank.
  //
  // .order-item__overlay hides via opacity and pointer-events, never
  // visibility, so a row whose overlay is currently closed still has a
  // focusable Modify button — and when a keyboard is driving, focusing it
  // opens that row's overlay around it (js/order-rows.js), which is the
  // behaviour we want, for free.
  function modifyReturnFocus(index) {
    return function () {
      var row = itemsEl.children[index] || itemsEl.lastElementChild;
      return row && row.querySelector('.order-item__overlay-btn[data-action="modify"]');
    };
  }

  var rows = window.EmjiveOrderRows.create({
    listEl: itemsEl,
    showPrice: true,
    closeOnOutsideClick: true,
    onModify: function (binding) {
      window.EmjiveModifyModal.open(binding.item, binding.index, {
        saveAction: { show: showCheckoutSave, hide: hideCheckoutSave },
        returnFocus: modifyReturnFocus(binding.index),
        // The whole list can be gone by close time (every other row's undo
        // ran out while the sheet was open), and the empty state's "Back to
        // gallery" link is then the only thing left to land on.
        fallbackFocus: emptyEl.querySelector(".selection-empty__back"),
        // render() BEFORE the sheet releases focus, and the order matters:
        // releasing resolves where focus goes by looking the row up by
        // index — so the list has to already be rebuilt, or that lookup
        // finds the button this rebuild is about to discard. The sheet
        // calls this right after the update and before it closes.
        onSaved: render
      });
    },
    onChange: updateCheckoutSummary,
    onEmptied: crossfadeToEmpty
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
     Inert while the bar is standing in as the Modify sheet's Save. */
  checkoutButton.addEventListener("click", function () {
    if (checkoutButton.disabled || checkoutBar.classList.contains("is-save-active")) return;
    alert("Checkout isn't connected yet. Wire this up to a Stripe Checkout session once the backend exists.");
  });

  /* ---- render ----------------------------------------------------------- */

  // Full rebuild — only needed for the initial page load and after a
  // Modify save (updateItem patches an existing item in place, and a fresh
  // render is the simplest way to reflect that). Unselect/Undo never come
  // through here — js/order-rows.js handles those in place — so this never
  // runs mid-undo-window in the common case. If it *does* (a Modify saved
  // on one row while a different row is still pending), that other row's
  // grace period ends early, silently; see rows.render()'s own comment.
  function render() {
    var items = window.EmjiveSelection.getSelection();

    if (!items.length) {
      rows.render([]);
      emptyEl.hidden = false;
      listEl.hidden = true;
      checkoutBar.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;
    rows.render(items);
    updateCheckoutSummary();
  }

  renderShippingOptions();
  updateCheckoutGate();
  render();
})();
