/* ==========================================================================
   J&MV — floating selection bar
   Present on every page except launch-order.html (that page already shows
   the full list — this script simply isn't included there). Mirrors the
   header visually (full-width, fixed) but in black: always shows either
   "No selected item" or a row of thumbnails for whatever's in
   window.EmjiveSelection, plus an "Order ›" link straight to
   launch-order.html. Clicking the bar itself (not the Order link) opens a
   drawer listing the selected items, each removable via "Unselect".

   Always visible here in the DOM/JS sense — the one exception (sliding
   in as a direct continuation of the homepage hero's own scroll-driven
   reveal, and back out again in either direction) is driven entirely by
   js/main.js's updateReveal(), which sets this element's transform
   straight off scroll position on pages that have a hero to continue
   from (see its own comment) — this script has no notion of which page
   it's running on, or of scroll position at all.
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
  // updateSummaryState() below) — shown only while js/product.js has a
  // size picked in the still-open sliding sheet, replacing whichever of
  // the other two would otherwise be showing. pendingConfirm is the
  // callback that actually performs the add, supplied by whoever called
  // showAddAction().
  var addActionBtn = document.createElement("button");
  addActionBtn.type = "button";
  addActionBtn.className = "selection-bar__add is-hidden";
  addActionBtn.textContent = "Add";
  addActionBtn.setAttribute("aria-hidden", "true");
  var pendingConfirm = null;
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
    // Published so a concurrently-open size-selection sheet (js/product.js's
    // #sizeModal) can reserve exactly this much space above the bar instead
    // of a fixed summary-only height — see .size-modal--drawer's
    // --selection-bar-reserved in css/style.css, which reads this and caps
    // it at 50vh. Harmless to set even when nothing reads it (every other
    // page/context on the site just never references this custom property).
    var liveHeight = summary.getBoundingClientRect().height + drawerContentHeight;
    document.documentElement.style.setProperty("--selection-bar-live-height", liveHeight + "px");
  }

  // Registered with window.EmjiveMenus (js/series.js) so a click away from
  // the bar closes the drawer — root is the whole bar (toggle/summary row
  // included), not just the drawer, so clicking the toggle itself is never
  // mistaken for "away" by that shared listener.
  var barMenuPanel = { root: bar, close: function () { setDrawerOpen(false); } };

  function setDrawerOpen(isOpen) {
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
    // itself is acting as one big Add button (see .is-add-active below) —
    // the whole point of that mode is a single, unambiguous hit target.
    if (bar.classList.contains("is-add-active")) return;
    setDrawerOpen(!drawer.classList.contains("is-open"));
  }
  toggleBtn.addEventListener("click", toggleDrawer);
  // emptyLabelEl is a sibling of toggleBtn (not inside it — see its own
  // comment above), so it needs this wired separately to still open the
  // drawer when clicked.
  emptyLabelEl.addEventListener("click", toggleDrawer);

  // While a size is picked (js/product.js's sliding sheet), the ENTIRE bar
  // becomes addActionBtn's hit box rather than just its own small centered
  // label — bubbling catches a click anywhere in the bar, including a
  // keyboard Enter/Space activation of addActionBtn itself (which also
  // dispatches a real, bubbling click). Guarded on is-add-active so this
  // is a complete no-op the rest of the time.
  bar.addEventListener("click", function () {
    if (bar.classList.contains("is-add-active") && pendingConfirm) pendingConfirm();
  });

  // Three-way slot for the summary row's right-hand side: emptyLabelEl/
  // orderLink normally split it based on hasItems (as before), but a
  // pendingConfirm from js/product.js's sliding sheet overrides both of
  // them, showing addActionBtn instead regardless of hasItems — even an
  // empty cart shows "Add" once a size is picked.
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
    // entirely while the bar is one big Add button (see toggleDrawer()'s
    // own guard above, which is what keeps it closed for the duration).
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

  window.EmjiveSelectionBar = {
    showAddAction: function (onConfirm) {
      pendingConfirm = onConfirm;
      updateSummaryState();
    },
    hideAddAction: function () {
      pendingConfirm = null;
      updateSummaryState();
    }
  };

  /* ---- render -------------------------------------------------------------
     Full rebuild every time (rows + icons), same convention as
     js/selection-page.js — this is a short list, not worth a keyed diff
     beyond what the entrance animation below needs. */

  // null (rather than []) specifically marks "haven't rendered yet" —
  // distinguishes the very first render on a fresh page load/navigation
  // (where every already-selected item should just appear in place, no
  // slide-in) from a later live update within the same page view.
  var lastKeys = null;
  var removalInFlight = false;

  function setUnselectButtonsDisabled(disabled) {
    rowsEl.querySelectorAll(".selection-bar__row-unselect").forEach(function (btn) {
      btn.disabled = disabled;
    });
  }

  // The icon has to visibly collapse (see .selection-bar__icon--exit in
  // css/style.css) before it actually leaves the data — otherwise the
  // full rebuild in render() would just make it vanish instantly instead
  // of sliding the gap closed. Every other Unselect button is disabled
  // while this is in flight: index positions are only valid for the
  // render they came from, and letting a second removal fire before this
  // one lands would shift indices out from under it.
  function handleUnselect(index) {
    if (removalInFlight) return;
    removalInFlight = true;
    setUnselectButtonsDisabled(true);

    // The icon strip renders newest-first in DOM (a plain, non-reversed
    // row then lands the oldest — the last DOM child — at the visual
    // right end, next to Order) — the reverse of items' own array order
    // — so array index has to be flipped to find the matching DOM node.
    var iconEl = iconsEl.children[iconsEl.children.length - 1 - index];
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      removalInFlight = false;
      window.EmjiveSelection.removeItem(index);
    }

    if (!iconEl) {
      finish();
      return;
    }

    iconEl.classList.add("selection-bar__icon--exit");
    iconEl.addEventListener("transitionend", function onEnd(e) {
      if (e.propertyName !== "width") return;
      iconEl.removeEventListener("transitionend", onEnd);
      finish();
    });
    // Fallback in case transitionend never fires (e.g. reduced-motion
    // environments that skip the transition outright).
    setTimeout(finish, 400);
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

  function buildRow(item, index) {
    var li = el("li", "selection-bar__row");

    var thumb = document.createElement("img");
    thumb.className = "selection-bar__row-thumb";
    if (item.image) thumb.src = item.image;
    thumb.alt = "";

    var text = el("span", "selection-bar__row-text");
    var name = el("span", "selection-bar__row-name");
    name.textContent = item.name;
    var attrs = el("span", "selection-bar__row-attrs");
    attrs.textContent = "." + item.category + "." + item.metal + ".";
    window.EmjiveSelection.appendSize(attrs, item.size);
    text.appendChild(name);
    text.appendChild(attrs);

    var unselectBtn = document.createElement("button");
    unselectBtn.type = "button";
    unselectBtn.className = "selection-bar__row-unselect";
    unselectBtn.textContent = "Unselect";
    unselectBtn.addEventListener("click", function () { handleUnselect(index); });

    li.appendChild(thumb);
    li.appendChild(text);
    li.appendChild(unselectBtn);
    return li;
  }

  function render() {
    var items = window.EmjiveSelection.getSelection();

    // Only the genuinely-added icon(s) get the entrance animation — a
    // multiset diff against the previous render's keys, so re-adding an
    // identical productId/metal/size after it was removed still counts
    // as new (nothing persists across renders to "recognize" it). On the
    // very first render (page load/navigation, lastKeys still null),
    // everything already selected just appears in place instead — there's
    // nothing to "arrive" from on a fresh page.
    var keys = items.map(itemKey);
    var isNew;
    if (lastKeys === null) {
      isNew = keys.map(function () { return false; });
    } else {
      var pool = lastKeys.slice();
      isNew = keys.map(function (k) {
        var idx = pool.indexOf(k);
        if (idx === -1) return true;
        pool.splice(idx, 1);
        return false;
      });
    }
    lastKeys = keys;

    // Newest-first in DOM — a plain (non-reversed) row then lands DOM
    // child 0 (newest) at the strip's *left* end and the last DOM child
    // (oldest) at its right end, next to Order, which stays put once
    // picked; each newer item joins to its left instead of displacing it.
    iconsEl.innerHTML = "";
    var newIconEls = [];
    for (var i = items.length - 1; i >= 0; i--) {
      var img = document.createElement("img");
      img.className = "selection-bar__icon";
      if (items[i].image) img.src = items[i].image;
      img.alt = "";
      iconsEl.appendChild(img);
      if (isNew[i]) newIconEls.push(img);
    }

    // Both stay in the layout (no [hidden]) and crossfade via opacity —
    // see the .is-hidden rules in css/style.css — rather than popping
    // instantly between "No selected item" and "Order (N)".
    var hasItems = items.length > 0;
    iconsEl.hidden = !hasItems;
    updateSummaryState();
    // Only updated while there's at least one item — unselecting the
    // last one leaves this reading whatever it last said (e.g. "Order
    // (1)") while Order fades out, instead of flipping to "Order (0)"
    // right as the crossfade starts, which reads as a jarring clash
    // between the number changing and the fade.
    if (hasItems) {
      orderCountEl.textContent = "Order (" + items.length + ")";
    }

    newIconEls.forEach(playEnterAnimation);

    // Oldest first (top of the drawer), newest at the bottom — plain
    // array order, same order items were actually picked in.
    rowsEl.innerHTML = "";
    items.forEach(function (item, index) {
      rowsEl.appendChild(buildRow(item, index));
    });

    if (!items.length) {
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
