/* ==========================================================================
   J&MV — floating selection bar
   Present on every page except launch-order.html (that page already shows
   the full list — this script simply isn't included there). Mirrors the
   header visually (full-width, fixed) but in black: always shows either
   "No selected item" or a row of thumbnails for whatever's in
   window.EmjiveSelection, plus an "Order ›" link straight to
   launch-order.html. Clicking the bar itself (not the Order link) opens a
   drawer listing the selected items — the very same rows as the order page
   (js/order-rows.js): tap one for Modify/Unselect, and Unselect leaves an
   Undo behind for a few seconds.

   Always visible here in the DOM/JS sense — the one exception (sliding
   in as a direct continuation of the homepage hero's own scroll-driven
   reveal, and back out again in either direction) is driven by the active
   series' hero publishing its scroll position through window.EmjiveHero
   (see the bottom of this file) — this script has no notion of which page
   it's running on.
   ========================================================================== */

(function () {
  "use strict";

  if (!window.EmjiveSelection) return;

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  // productId is only unique within a series, hence the series prefix. The
  // `|| ""` covers selections saved before that field existed: it keeps
  // their key stable across renders, so an existing cart doesn't read as
  // all-new and replay the entrance animation on every row.
  function itemKey(item) {
    return (item.series || "") + "|" + item.productId + "|" + item.metal + "|" + item.size;
  }

  /* ---- build the DOM once ------------------------------------------------ */

  var bar = el("div", "selection-bar");

  var drawer = el("div", "selection-bar__drawer");
  var drawerInner = el("div", "selection-bar__drawer-inner");
  var rowsEl = el("ul", "selection-bar__rows");
  drawerInner.appendChild(rowsEl);
  drawer.appendChild(drawerInner);

  var summary = el("div", "selection-bar__summary");

  var toggleBtn = el("button", "selection-bar__toggle");
  toggleBtn.type = "button";
  toggleBtn.setAttribute("aria-expanded", "false");
  // Its only content is the icon strip, which is [hidden] whenever nothing
  // is selected — so with an empty selection this button had no accessible
  // name at all AND collapsed to near-zero width. A keyboard visitor could
  // land on it and be told nothing about what it was.
  toggleBtn.setAttribute("aria-label", "Selected items");
  var iconsEl = el("span", "selection-bar__icons");
  toggleBtn.appendChild(iconsEl);

  // A sibling of toggleBtn, not a descendant — see its own CSS comment
  // for why (it's positioned relative to .selection-bar__summary so it
  // can reach the bar's true right edge, past the toggle button's own,
  // narrower box) — so it needs its own click handling below rather than
  // relying on being inside that button.
  // All three of these (plus addActionBtn below) start with .is-hidden —
  // updateSummaryState()'s first call (from the unconditional render() at
  // the bottom of this file) reveals whichever one actually matches the
  // real starting state; without an explicit starting class here, the two
  // NOT chosen would have nothing telling them to stay hidden, since
  // classList.remove("is-hidden") on the chosen one is a no-op against an
  // element that never had the class to begin with.
  var emptyLabelEl = el("span", "selection-bar__empty-label is-hidden");
  emptyLabelEl.textContent = "No selected item";
  emptyLabelEl.setAttribute("aria-hidden", "true");

  var orderLink = document.createElement("a");
  orderLink.className = "selection-bar__order is-hidden";
  orderLink.href = "launch-order.html";
  orderLink.setAttribute("aria-hidden", "true");
  var orderCountEl = el("span", "selection-bar__order-count");
  var orderChevronEl = el("span", "selection-bar__order-chevron");
  orderChevronEl.textContent = "›"; // ›
  orderLink.appendChild(orderCountEl);
  orderLink.appendChild(orderChevronEl);

  // Occupies the same reserved slot as emptyLabelEl/orderLink (see
  // updateSummaryState() below) — shown only while a sheet has something
  // to confirm, replacing whichever of the other two would otherwise be
  // showing: js/product.js's size sheet ("Add") or the Modify sheet
  // (js/modify-modal.js, "Save"). pendingConfirm is the callback that
  // actually performs it, pendingLabel what the button says, both supplied
  // by whoever called showAction().
  var addActionBtn = document.createElement("button");
  addActionBtn.type = "button";
  addActionBtn.className = "selection-bar__add is-hidden";
  addActionBtn.textContent = "Add";
  addActionBtn.setAttribute("aria-hidden", "true");
  var pendingConfirm = null;
  var pendingLabel = "Add";
  // No click listener of its own — while it's showing, the whole bar acts
  // as its hit box instead (see the bar-level listener below), which this
  // button's own bubbling click already reaches. A listener here too would
  // double-fire pendingConfirm() on a direct click.

  summary.appendChild(toggleBtn);
  summary.appendChild(emptyLabelEl);
  summary.appendChild(orderLink);
  summary.appendChild(addActionBtn);

  // Drawer sits before the summary row in DOM order so it stacks visually
  // above it inside this column-flex bar — the bar's total height is
  // intrinsic and grows upward from the pinned bottom edge as the drawer
  // opens, no manual position math needed.
  bar.appendChild(drawer);
  bar.appendChild(summary);
  document.body.appendChild(bar);

  // The drawer's rows: the order page's own row component, not a lookalike.
  // A click away from the bar closes the whole drawer (window.EmjiveMenus,
  // below), so an open row doesn't register a click-away of its own — the
  // drawer closes it on the way instead (setDrawerOpen).
  var rows = window.EmjiveOrderRows.create({
    listEl: rowsEl,
    rowClass: "order-item--drawer",
    showPrice: false,
    closeOnOutsideClick: false,
    onModify: openModify,
    onRowRemoved: syncDrawerHeight,
    onEmptied: function () { setDrawerOpen(false); }
  });

  // Measures .selection-bar__drawer-inner's own real rendered height (its
  // own max-height: 66vh + overflow already caps that, independent of
  // this) and transitions the outer drawer's max-height to match — used
  // both for the open/close toggle and, from render() below, whenever
  // the row count changes while the drawer is already open, so removing
  // an item shrinks the drawer smoothly instead of snapping to the new
  // height instantly.
  function syncDrawerHeight() {
    var isOpen = drawer.classList.contains("is-open");
    var drawerContentHeight = isOpen ? drawerInner.offsetHeight : 0;
    drawer.style.maxHeight = isOpen ? drawerContentHeight + "px" : "0px";
    // Published so a concurrently-open sheet (js/product.js's #sizeModal,
    // js/modify-modal.js's #modifyModal) can reserve exactly this much
    // space above the bar instead of a fixed summary-only height — see
    // .size-modal--drawer's --selection-bar-reserved in css/style.css,
    // which reads this and caps it at 50vh. Harmless to set even when
    // nothing reads it (every other page/context on the site just never
    // references this custom property).
    var liveHeight = summary.getBoundingClientRect().height + drawerContentHeight;
    document.documentElement.style.setProperty("--selection-bar-live-height", liveHeight + "px");
  }

  // Registered with window.EmjiveMenus (js/series.js) so a click away from
  // the bar closes the drawer — root is the whole bar (toggle/summary row
  // included), not just the drawer, so clicking the toggle itself is never
  // mistaken for "away" by that shared listener.
  var barMenuPanel = { root: bar, close: function () { setDrawerOpen(false); } };

  function setDrawerOpen(isOpen) {
    var wasOpen = drawer.classList.contains("is-open");
    // Rebuilt fresh on the way open — unless a row is mid-undo, whose
    // prompt should still be there if the drawer is reopened within its
    // window. That also sweeps away the last row of a cart that emptied
    // while the drawer was closing: onEmptied closes the drawer with that
    // row still in place (so it leaves with the drawer instead of
    // collapsing on its own first), and nothing rebuilds it until now.
    if (isOpen && !wasOpen && !rows.hasPending()) {
      rows.render(window.EmjiveSelection.getSelection());
    }
    if (!isOpen) rows.closeOpenRow();
    drawer.classList.toggle("is-open", isOpen);
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
    syncDrawerHeight();
    if (window.EmjiveMenus) {
      if (isOpen) window.EmjiveMenus.opened(barMenuPanel);
      else window.EmjiveMenus.closed(barMenuPanel);
    }
  }

  function toggleDrawer() {
    // The bar's own "pop up" (its drawer) sits out entirely while the bar
    // itself is acting as one big Add/Save button (see .is-add-active
    // below) — the whole point of that mode is a single, unambiguous hit
    // target.
    if (bar.classList.contains("is-add-active")) return;
    // Likewise while the Modify sheet is up, even with Save hidden (an
    // emptied size field): a second row's Modify from under the first
    // would stack two edits of the cart on one backdrop.
    if (window.EmjiveModifyModal && window.EmjiveModifyModal.isOpen()) return;
    setDrawerOpen(!drawer.classList.contains("is-open"));
  }
  toggleBtn.addEventListener("click", toggleDrawer);
  // emptyLabelEl is a sibling of toggleBtn (not inside it — see its own
  // comment above), so it needs this wired separately to still open the
  // drawer when clicked.
  emptyLabelEl.addEventListener("click", toggleDrawer);

  // While a sheet has something to confirm, the ENTIRE bar becomes
  // addActionBtn's hit box rather than just its own small centered label —
  // bubbling catches a click anywhere in the bar, including a keyboard
  // Enter/Space activation of addActionBtn itself (which also dispatches a
  // real, bubbling click). Guarded on is-add-active so this is a complete
  // no-op the rest of the time.
  // Never for a click from inside the drawer, though. The drawer is always
  // closed while the bar is in this mode, so no real Save/Add click can
  // come from there — but a drawer row's Modify click can still be
  // bubbling through here when the bar enters it: the Modify sheet opens
  // off an already-resolved promise, whose callbacks run in the microtask
  // checkpoint between two listeners of that same click, so by the time it
  // reaches this one, Save is showing and would fire on the spot.
  bar.addEventListener("click", function (e) {
    if (drawer.contains(e.target)) return;
    if (bar.classList.contains("is-add-active") && pendingConfirm) pendingConfirm();
  });

  // Three-way slot for the summary row's right-hand side: emptyLabelEl/
  // orderLink normally split it based on hasItems (as before), but a
  // pendingConfirm from one of the sheets overrides both of them, showing
  // addActionBtn instead regardless of hasItems — even an empty cart shows
  // "Add" once a size is picked.
  function summaryElFor(mode) {
    return mode === "add" ? addActionBtn : mode === "order" ? orderLink : emptyLabelEl;
  }
  function computeSummaryMode() {
    if (pendingConfirm) return "add";
    return window.EmjiveSelection.getSelection().length > 0 ? "order" : "empty";
  }

  // Sequenced, not simultaneous: the incoming label only starts fading in
  // once the outgoing one has fully faded out, rather than both crossfading
  // at once — a simultaneous swap left two semi-transparent labels stacked
  // on top of each other for the middle of the transition, which read as a
  // glitch rather than a clean handoff. visibleSummaryMode is null only
  // before the very first call, which sets the right one instantly instead
  // (nothing to visibly arrive from on a fresh page — same reasoning
  // render() already uses for the icon strip's own entrance animation).
  var visibleSummaryMode = null;
  var summaryRevealTimer = null;
  var summaryHideListenerEl = null;

  function onSummaryHideEnd(e) {
    if (e.propertyName !== "opacity") return;
    revealCurrentSummaryMode();
  }

  function revealCurrentSummaryMode() {
    clearTimeout(summaryRevealTimer);
    if (summaryHideListenerEl) {
      summaryHideListenerEl.removeEventListener("transitionend", onSummaryHideEnd);
      summaryHideListenerEl = null;
    }
    var el = summaryElFor(visibleSummaryMode);
    // Relabelled only here, while it's still fully transparent — the one
    // button hosts both "Add" and "Save", and a label changing in plain
    // sight would read as a flicker.
    if (visibleSummaryMode === "add") addActionBtn.textContent = pendingLabel;
    el.classList.remove("is-hidden");
    el.setAttribute("aria-hidden", "false");
  }

  function updateSummaryState() {
    var mode = computeSummaryMode();
    // Ahead of the early return below (which only fires once nothing about
    // the visible label actually needs to change) so this stays correct
    // even on a redundant call — cheap, and classList.toggle/setDrawerOpen
    // are already idempotent besides. Entering add mode also closes the
    // drawer if it happened to be open — that "pop up" behavior sits out
    // entirely while the bar is one big Add/Save button (see
    // toggleDrawer()'s own guard above, which is what keeps it closed for
    // the duration).
    bar.classList.toggle("is-add-active", mode === "add");
    if (mode === "add") setDrawerOpen(false);
    if (mode === visibleSummaryMode) return;

    var outgoingEl = visibleSummaryMode ? summaryElFor(visibleSummaryMode) : null;
    visibleSummaryMode = mode;

    if (!outgoingEl) {
      revealCurrentSummaryMode();
      return;
    }

    outgoingEl.classList.add("is-hidden");
    outgoingEl.setAttribute("aria-hidden", "true");
    // Forces layout before the transitionend listener below is attached —
    // Safari has a known history of coalescing/dropping a transition
    // that's triggered by a class change with nothing reading layout in
    // between (same reasoning as playEnterAnimation()'s own
    // `void iconEl.offsetWidth` a bit further down this file).
    void outgoingEl.offsetWidth;

    clearTimeout(summaryRevealTimer);
    if (summaryHideListenerEl) summaryHideListenerEl.removeEventListener("transitionend", onSummaryHideEnd);
    summaryHideListenerEl = outgoingEl;
    outgoingEl.addEventListener("transitionend", onSummaryHideEnd);
    // Fallback in case transitionend never fires (e.g. a backgrounded tab),
    // matching the 0.3s opacity transition these three share plus a buffer.
    summaryRevealTimer = setTimeout(revealCurrentSummaryMode, 350);
  }

  // label: "Add" (js/product.js) or "Save" (the Modify sheet, via
  // openModify below).
  window.EmjiveSelectionBar = {
    showAction: function (label, onConfirm) {
      pendingLabel = label;
      pendingConfirm = onConfirm;
      updateSummaryState();
    },
    hideAction: function () {
      pendingConfirm = null;
      updateSummaryState();
    }
  };

  // A drawer row's Modify: the drawer steps out of the way and the Modify
  // sheet (js/modify-modal.js) slides up from behind the bar, which turns
  // into its Save button. Focus comes back to the toggle — the row that
  // was clicked is inside a drawer that's closed by then.
  function openModify(binding) {
    setDrawerOpen(false);
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      saveAction: {
        show: function (onConfirm) { window.EmjiveSelectionBar.showAction("Save", onConfirm); },
        hide: function () { window.EmjiveSelectionBar.hideAction(); }
      },
      returnFocus: toggleBtn
    });
  }

  /* ---- icon strip ---------------------------------------------------------
     Newest-first in DOM — a plain (non-reversed) row then lands DOM child 0
     (newest) at the strip's *left* end and the last DOM child (oldest) at
     its right end, next to Order, which stays put once picked; each newer
     item joins to its left instead of displacing it.

     Every change the site makes to the selection is a single one — an Add,
     an Unselect, an Undo, a Modify — so render() works out which of those
     just happened and animates exactly that one icon, rather than
     rebuilding the strip. iconEls holds the live icons in array order
     (oldest first), which is what maps a storage index to its element; an
     icon playing its exit animation has already left iconEls, so it can
     never throw that mapping off while it collapses. */

  // null (rather than []) specifically marks "haven't rendered yet" —
  // distinguishes the very first render on a fresh page load/navigation
  // (where every already-selected item should just appear in place, no
  // slide-in) from a later live update within the same page view.
  var lastKeys = null;
  var iconEls = [];

  function buildIcon(item) {
    var img = document.createElement("img");
    img.className = "selection-bar__icon";
    if (item.image) img.src = item.image;
    img.alt = "";
    return img;
  }

  // Slides a freshly-added icon in from the screen's own left edge all the
  // way to its resting slot, fully visible (opaque) for the entire trip —
  // not a small local nudge. The distance depends on where the icon
  // actually lands (icon count, viewport width), so it's computed per
  // element via getBoundingClientRect() rather than a fixed CSS
  // @keyframes. Overrides .selection-bar__icon's own `transition` inline
  // while it plays, then clears the override so the base class's
  // width/margin-right/opacity transitions (needed for the exit/collapse
  // animation) take back over. A long duration + a gentle, gradually-
  // decelerating easeOutExpo-style curve (rather than the sharper curve
  // used elsewhere on the site) is what makes a full-width trip like this
  // read as smooth instead of rushed.
  function playEnterAnimation(iconEl) {
    var startX = -iconEl.getBoundingClientRect().left;
    iconEl.style.transition = "none";
    iconEl.style.transform = "translateX(" + startX + "px)";
    // Force layout so the browser registers that starting position before
    // the transition below is applied — otherwise the two style writes
    // can get coalesced into one and no animation plays.
    void iconEl.offsetWidth;
    requestAnimationFrame(function () {
      iconEl.style.transition = "transform 1.1s cubic-bezier(0.16, 1, 0.3, 1)";
      iconEl.style.transform = "translateX(0)";
      iconEl.addEventListener("transitionend", function onEnd(e) {
        if (e.propertyName !== "transform") return;
        iconEl.removeEventListener("transitionend", onEnd);
        iconEl.style.transition = "";
        iconEl.style.transform = "";
      });
    });
  }

  // The icon collapses (see .selection-bar__icon--exit in css/style.css —
  // width and margin together, so the remaining icons slide into the gap as
  // a side effect of flex layout) and only leaves the DOM once that's
  // done. Its item is already gone from storage by now.
  function playExitAnimation(iconEl) {
    iconEl.classList.add("selection-bar__icon--exit");
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      iconEl.remove();
      if (!iconsEl.children.length) iconsEl.hidden = true;
    }
    iconEl.addEventListener("transitionend", function onEnd(e) {
      if (e.propertyName !== "width") return;
      iconEl.removeEventListener("transitionend", onEnd);
      finish();
    });
    // Fallback in case transitionend never fires (e.g. reduced-motion
    // environments that skip the transition outright).
    setTimeout(finish, 400);
  }

  // Which single change turns oldKeys into keys: one item inserted at
  // `index` (an Add pushes at the end, an Undo puts one back where it was),
  // one removed from `index`, or — same length — items updated in place (a
  // Modify changes a key without moving it). null for anything else.
  function singleChange(oldKeys, keys) {
    if (keys.length === oldKeys.length) return { type: "update" };
    if (Math.abs(keys.length - oldKeys.length) !== 1) return null;
    var longer = keys.length > oldKeys.length ? keys : oldKeys;
    var shorter = longer === keys ? oldKeys : keys;
    var i = 0;
    while (i < shorter.length && shorter[i] === longer[i]) i++;
    for (var j = i; j < shorter.length; j++) {
      if (shorter[j] !== longer[j + 1]) return null;
    }
    return { type: longer === keys ? "insert" : "remove", index: i };
  }

  // The first render on a page, or a change that isn't a single one: build
  // the strip from scratch. Only genuinely-added icons get the entrance
  // animation — a multiset diff against the previous render's keys, so
  // re-adding an identical productId/metal/size after it was removed still
  // counts as new. On the very first render everything already selected
  // just appears in place — there's nothing to "arrive" from on a fresh
  // page.
  function rebuildIcons(items, keys, oldKeys) {
    var isNew;
    if (oldKeys === null) {
      isNew = keys.map(function () { return false; });
    } else {
      var pool = oldKeys.slice();
      isNew = keys.map(function (k) {
        var idx = pool.indexOf(k);
        if (idx === -1) return true;
        pool.splice(idx, 1);
        return false;
      });
    }
    iconsEl.innerHTML = "";
    iconEls = [];
    var newIconEls = [];
    for (var i = items.length - 1; i >= 0; i--) {
      var icon = buildIcon(items[i]);
      iconsEl.appendChild(icon);
      iconEls.unshift(icon);
      if (isNew[i]) newIconEls.push(icon);
    }
    iconsEl.hidden = !items.length;
    newIconEls.forEach(playEnterAnimation);
  }

  function renderIcons(items) {
    var keys = items.map(itemKey);
    var oldKeys = lastKeys;
    lastKeys = keys;
    var change = oldKeys && singleChange(oldKeys, keys);
    if (!change) {
      rebuildIcons(items, keys, oldKeys);
      return;
    }

    if (change.type === "insert") {
      var icon = buildIcon(items[change.index]);
      // Newest-first in DOM, so the new icon goes right before its older
      // neighbour (or at the very end, if it's now the oldest).
      iconsEl.insertBefore(icon, change.index > 0 ? iconEls[change.index - 1] : null);
      iconEls.splice(change.index, 0, icon);
      // Unhidden before measuring: playEnterAnimation reads where the icon
      // actually landed, and a [hidden] strip has no layout at all.
      iconsEl.hidden = false;
      playEnterAnimation(icon);
    } else if (change.type === "remove") {
      playExitAnimation(iconEls.splice(change.index, 1)[0]);
    } else {
      items.forEach(function (item, i) {
        if (keys[i] === oldKeys[i]) return;
        if (item.image) iconEls[i].src = item.image;
        else iconEls[i].removeAttribute("src");
      });
    }
  }

  /* ---- render ------------------------------------------------------------- */

  function render() {
    var items = window.EmjiveSelection.getSelection();
    var hasItems = items.length > 0;

    renderIcons(items);

    // Both stay in the layout (no [hidden]) and crossfade via opacity —
    // see the .is-hidden rules in css/style.css — rather than popping
    // instantly between "No selected item" and "Order (N)".
    updateSummaryState();
    // Only updated while there's at least one item — unselecting the
    // last one leaves this reading whatever it last said (e.g. "Order
    // (1)") while Order fades out, instead of flipping to "Order (0)"
    // right as the crossfade starts, which reads as a jarring clash
    // between the number changing and the fade.
    if (hasItems) {
      orderCountEl.textContent = "Order (" + items.length + ")";
    }

    // Oldest first (top of the drawer), newest at the bottom — plain array
    // order, same order items were actually picked in. Skipped when the
    // change came from the drawer's own Unselect/Undo, which fire this
    // very event mid-click: a rebuild then would replace the row showing
    // its Undo prompt with a fresh list that no longer has it.
    if (!rows.isMutating()) rows.render(items);

    // An empty cart closes the drawer — except while a row is still
    // offering its Undo (unselecting the last item empties the cart
    // immediately; the drawer closes once that row's window runs out).
    if (!hasItems && !rows.hasPending()) {
      setDrawerOpen(false);
    }
    // Re-measures against the just-rebuilt rows — if the drawer is open,
    // this is what makes it shrink/grow smoothly as items are removed or
    // added instead of snapping to the new height instantly.
    syncDrawerHeight();
  }

  window.addEventListener("emjive:selection-changed", render);
  render();

  // The homepage bar doesn't just sit fixed at the bottom — it slides in as
  // a continuation of the hero's own wipe. The hero owns all that geometry
  // and publishes one number (how far past its trigger point the page has
  // scrolled); how far the BAR has to travel is measured here, since it's a
  // property of the bar, not the hero. No CSS transition on either side —
  // every value is set directly per scroll frame, in both directions, so
  // scrolling back up un-reveals it exactly as readily.
  //
  // Subscribing unconditionally keeps this file page-agnostic, which was
  // always the point (see the header comment): on a page with no hero
  // nothing ever publishes, so nothing ever happens and the bar just stays
  // visible — no special-casing, same as before.
  if (window.EmjiveHero) {
    window.EmjiveHero.onScroll(function (pastTriggerPx, hasScrollRange) {
      // The summary row specifically, not .selection-bar as a whole: the
      // bar's own rendered height grows whenever its drawer is open, which
      // would make "how far to scroll" fluctuate with unrelated drawer
      // state instead of staying tied to the one constant, always-visible
      // part of the bar.
      var revealDistance = Math.max(summary.getBoundingClientRect().height, 1);
      var progress = hasScrollRange ? Math.min(1, pastTriggerPx / revealDistance) : 1;
      bar.style.transform = "translateY(" + (100 - progress * 100) + "%) translateZ(0)";
    });
  }
})();
