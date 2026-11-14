// launch-order.html: the checkout review of window.EmjiveSelection — item rows
// (js/order-rows.js: a tap puts a row in query mode, whose Modify opens the
// Modify sheet), the terms toggle, and a "Proceed to checkout" bar gated on
// it. While the sheet is open, a drawer over the bar shows a copy of the row,
// which takes the sheet's strip, and the sheet rests on it. Shows
// .selection-empty when empty.

(function () {
  "use strict";

  var listEl = document.getElementById("selectionList");
  if (!listEl) return;

  var emptyEl = document.getElementById("selectionEmpty");
  var itemsEl = document.getElementById("selectionItems");
  var backLink = emptyEl.querySelector(".selection-empty__back");

  var termsEl = document.getElementById("orderTerms");
  var termsToggleEl = document.getElementById("orderTermsToggle");

  var checkoutBar = document.getElementById("orderCheckoutBar");
  var checkoutRow = checkoutBar.querySelector(".order-checkout-bar__row");
  var checkoutTotalEl = document.getElementById("orderCheckoutTotal");
  var checkoutButton = document.getElementById("orderCheckoutButton");

  var termsAccepted = false;

  function updateCheckoutGate() {
    checkoutButton.disabled = !termsAccepted;
  }

  function modifyOpen() {
    return !!(window.EmjiveModifyModal && window.EmjiveModifyModal.isOpen());
  }

  /* ---- the drawer over the checkout bar ----
     Like the floating bar's drawer on other pages: a copy of the row whose
     Modify was pressed, between the bar and the sheet, which rests on it
     through --selection-bar-live-height. The copy takes the sheet's strip
     (its only live controls); inert and aria-hidden while shut. Opens with
     the sheet and closes once the strip has left (after a Save's band). */
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
    queryable: false
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
    rowDrawer.inert = false;
    rowDrawer.removeAttribute("aria-hidden");
    // Laid out while shut (max-height, not display), so it measures true.
    var height = rowDrawerList.offsetHeight;
    rowDrawer.style.maxHeight = height + "px";
    setLiveHeight(height);
  }

  function closeRowDrawer() {
    drawerIndex = null;
    rowDrawer.inert = true;
    rowDrawer.setAttribute("aria-hidden", "true");
    rowDrawer.style.maxHeight = "0px";
    setLiveHeight(null);
  }

  // Recomputed from scratch after every change; any unpriced (price 0) item
  // makes it "TBD".
  function updateCheckoutSummary() {
    var sel = window.EmjiveSelection;
    var items = sel.getSelection();
    checkoutBar.hidden = !items.length;
    var total = 0;
    var unpriced = false;
    items.forEach(function (item) {
      total += sel.linePrice(item);
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

  // The top row, the latest, or the empty state's "Back to gallery".
  function fallbackFocus() {
    return (listState === "list" && rows.buttonAt(window.EmjiveSelection.getSelection().length - 1)) || backLink;
  }

  // The strip goes on the drawer's copy of the row (rendered in onOpen); the
  // list's row stays in query mode under the sheet, and leaves it after a
  // Save. Focus returns to the list's row, looked up late as rows
  // come and go.
  function openModify(binding) {
    if (!window.EmjiveModifyModal) return;
    var host = null;
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      bar: {
        el: function () { return host && host.el; },
        show: function (strip) { if (host) host.show(strip); },
        hide: function (strip, saved) {
          if (host) host.hide(strip, saved);
          if (saved) rows.endQuery();
          closeRowDrawer();
        }
      },
      // Both copies of the row: the list's and the drawer's (index 0).
      onPreview: function (index, values) {
        rows.preview(index, values);
        if (drawerIndex !== null) drawerRows.preview(0, values);
      },
      onOpen: function () {
        openRowDrawer(binding.index);
        host = drawerRows.stripHost(0);
      },
      returnFocus: function () {
        return listState === "list" ? rows.buttonAt(binding.index) : null;
      },
      fallbackFocus: fallbackFocus
    });
  }

  var rows = window.EmjiveOrderRows.create({
    listEl: itemsEl,
    showPrice: true,
    newestFirst: true,
    onModify: openModify,
    // An emptied list gives way to the empty state once its last Undo line has gone.
    onUndoGone: function () { render(); },
    fallbackFocus: fallbackFocus
  });

  /* ---- terms: a click anywhere on the row toggles, except on the link ---- */
  termsEl.addEventListener("click", function (e) {
    if (e.target.closest("a")) return;
    termsAccepted = !termsAccepted;
    termsToggleEl.classList.toggle("is-checked", termsAccepted);
    termsToggleEl.setAttribute("aria-checked", String(termsAccepted));
    updateCheckoutGate();
  });

  /* ---- checkout: no backend yet, so a notice. Not while the Modify sheet is up. ---- */
  checkoutButton.addEventListener("click", function () {
    if (checkoutButton.disabled || modifyOpen()) return;
    window.EmjiveOrderRows.notice("Online checkout isn't open yet. Your selection stays saved on this device.");
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
        rows.render(items, { animate: listState === "list", change: change });
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

  updateCheckoutGate();
  render();
})();
