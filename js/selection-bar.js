// The floating selection bar, on every page but launch-order.html: a fixed
// black bar showing the selection's thumbnails (or "No selected item") and
// "Order (N) ›". Tapping it opens a drawer of order rows (js/order-rows.js);
// tapping a row shrinks the drawer to that row and opens the Modify sheet on
// it, the bar turning into the sheet's strip. Page-agnostic: on the homepage
// it slides in with the hero's scroll (window.EmjiveHero, bottom of file).

(function () {
  "use strict";

  // The drawer's rows need the order-row component.
  if (!window.EmjiveSelection || !window.EmjiveOrderRows) return;

  var el = window.EmjiveHelpers.el;

  /* ---- DOM, built once ---- */

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
  // Its only content, the icon strip, is hidden when empty: it needs its own name.
  toggleBtn.setAttribute("aria-label", "Selected items");
  var iconsEl = el("span", "selection-bar__icons");
  toggleBtn.appendChild(iconsEl);

  // Siblings of toggleBtn (positioned against the summary row to reach its
  // right edge), hence their own click handling. Both start .is-hidden (and
  // inert); the first updateSummaryState() reveals the right one.
  var emptyLabelEl = el("span", "selection-bar__empty-label is-hidden");
  emptyLabelEl.textContent = "No selected item";
  emptyLabelEl.setAttribute("aria-hidden", "true");
  emptyLabelEl.inert = true;

  var orderLink = document.createElement("a");
  orderLink.className = "selection-bar__order is-hidden";
  orderLink.href = "/launch-order";
  orderLink.setAttribute("aria-hidden", "true");
  orderLink.inert = true;
  var orderCountEl = el("span", "selection-bar__order-count");
  var orderChevronEl = el("span", "selection-bar__order-chevron");
  orderChevronEl.textContent = "›"; // ›
  orderLink.appendChild(orderCountEl);
  orderLink.appendChild(orderChevronEl);

  summary.appendChild(toggleBtn);
  summary.appendChild(emptyLabelEl);
  summary.appendChild(orderLink);

  // Before the summary in the column flex, so the drawer grows upward from the pinned bottom.
  bar.appendChild(drawer);
  bar.appendChild(summary);

  // The visible count fades and goes aria-hidden mid-change: announce changes
  // here (never on the first render).
  var statusEl = el("div", "visually-hidden");
  statusEl.setAttribute("role", "status");
  bar.appendChild(statusEl);
  var announcedCount = null;

  document.body.appendChild(bar);

  var rows = window.EmjiveOrderRows.create({
    listEl: rowsEl,
    rowClass: "order-item--drawer",
    showPrice: true,
    newestFirst: true,
    dropAtOnce: true,
    onModify: openModify,
    onResize: syncDrawerHeight
  });

  /* ---- drawer height ----
     Set in px on the drawer and its inner scroll box (both with the 0.3s
     max-height transition), since it moves between several states: closed,
     open, rows coming and going, and reduced to the row the Modify sheet opened
     from. Closed, the inner box keeps the list's height so nothing reflows while
     it shuts. The list height used is the one it's heading to
     (rows.settledHeight()). */

  // Past two thirds of the screen the rows scroll.
  var LIST_CAP = 0.66;
  // While the Modify sheet is up: the one row's height (null otherwise); the sheet rests on it.
  var reducedHeight = null;
  // A just-added row peeking out of the closed drawer (peekNewest()): its height, and whether it's up.
  var peekHeight = null;
  var peekShown = false;

  // Returns the height the drawer is heading to.
  function syncDrawerHeight() {
    var isOpen = drawer.classList.contains("is-open");
    var summaryHeight = summary.getBoundingClientRect().height;
    var listHeight = Math.min(rows.settledHeight(), window.innerHeight * LIST_CAP);
    var target = !isOpen ? (peekShown ? peekHeight : 0) : reducedHeight !== null ? reducedHeight : listHeight;
    drawer.style.maxHeight = target + "px";
    // A peeking drawer's inner box keeps the peek's height on the way down, so nothing reflows.
    drawerInner.style.maxHeight = (isOpen ? target : peekHeight !== null ? peekHeight : listHeight) + "px";
    // --selection-bar-live-height: where the sheets (#sizeModal, #modifyModal)
    // rest (.size-modal--drawer), moving in step via their own transition. A
    // peek isn't included.
    var published = !isOpen && peekHeight !== null ? 0 : target;
    document.documentElement.style.setProperty("--selection-bar-live-height", summaryHeight + published + "px");
    // The product page's Select bar rides on the bar and drawer, a peek included.
    document.documentElement.style.setProperty("--selection-bar-stack-height", summaryHeight + target + "px");
    return target;
  }

  /* ---- peek ----
     An Add raises the newest row out of the closed drawer for a moment and
     lowers it, showing that the bar hides a drawer. Anything opening, emptying
     or restarting the drawer cancels it. */
  var PEEK_HOLD_MS = 1000;
  var DRAWER_MS = 300;
  var peekTimer = null;

  function cancelPeek() {
    clearTimeout(peekTimer);
    peekHeight = null;
    peekShown = false;
    bar.classList.remove("is-peek-up");
    bar.classList.remove("is-peeking");
  }

  function endPeek() {
    cancelPeek();
    drawerInner.scrollTop = 0;
    syncDrawerHeight();
  }

  function peekNewest() {
    if (drawer.classList.contains("is-open") || reducedHeight !== null) return;
    var row = rowsEl.firstElementChild;
    if (!row) return;
    cancelPeek();
    // A lone row shows from the list's top, padding included.
    var alone = rowsEl.children.length === 1;
    peekHeight = alone ? rows.settledHeight() : row.offsetHeight;
    // The inner box jumps to the peek height so the scroll can be set at once;
    // only the drawer's height animates.
    drawerInner.style.transition = "none";
    drawerInner.style.maxHeight = peekHeight + "px";
    void drawerInner.offsetHeight;
    drawerInner.scrollTop = alone ? 0 : row.getBoundingClientRect().top - rowsEl.getBoundingClientRect().top;
    drawerInner.style.transition = "";
    bar.classList.add("is-peeking", "is-peek-up");
    peekShown = true;
    syncDrawerHeight();
    peekTimer = setTimeout(function () {
      peekShown = false;
      // Lowering: the product page's Select bar comes back with it.
      bar.classList.remove("is-peek-up");
      syncDrawerHeight();
      peekTimer = setTimeout(endPeek, DRAWER_MS + 50);
    }, DRAWER_MS + PEEK_HOLD_MS);
  }

  // Scrolls the list to `to` in step with the drawer's height transition, so
  // the tapped row glides into place above the bar. Programmatic only: the
  // reduced list is overflow: hidden.
  var scrollRun = 0;

  function animateDrawerScroll(to, fromHeight, toHeight) {
    var run = ++scrollRun;
    var from = drawerInner.scrollTop;
    var span = toHeight - fromHeight;
    // Past the 0.3s transition, in case it never runs (background tab).
    var until = performance.now() + 450;
    function step() {
      if (run !== scrollRun) return;
      var height = drawer.getBoundingClientRect().height;
      var p = span ? Math.max(0, Math.min(1, (height - fromHeight) / span)) : 1;
      if (p >= 1 || performance.now() > until) {
        drawerInner.scrollTop = to;
        return;
      }
      drawerInner.scrollTop = from + (to - from) * p;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // The scroll before reducing, to restore.
  var restoreScroll = 0;

  function setDrawerReduced(on, rowEl) {
    if ((reducedHeight !== null) === on) return;
    if (on && (!rowEl || !drawer.classList.contains("is-open"))) return;
    var fromHeight = drawer.getBoundingClientRect().height;
    var to;
    if (on) {
      restoreScroll = drawerInner.scrollTop;
      reducedHeight = rowEl.offsetHeight;
      to = rowEl.getBoundingClientRect().top - rowsEl.getBoundingClientRect().top;
      // Reduced lists can't scroll (overflow: hidden), which removes a space-taking
      // scrollbar (Windows): pad its width back so rows keep their width.
      var scrollbar = drawerInner.offsetWidth - drawerInner.clientWidth;
      bar.classList.add("is-drawer-reduced");
      drawerInner.style.paddingRight = scrollbar > 0 ? scrollbar + "px" : "";
    } else {
      reducedHeight = null;
      bar.classList.remove("is-drawer-reduced");
      drawerInner.style.paddingRight = "";
    }
    var toHeight = syncDrawerHeight();
    // Back where it was, as far as a possibly shorter list allows.
    if (!on) to = Math.min(restoreScroll, Math.max(0, rows.settledHeight() - toHeight));
    animateDrawerScroll(to, fromHeight, toHeight);
  }

  // For window.EmjiveMenus click-away: root covers the whole bar and the Modify
  // sheet, so tapping the sheet's backdrop keeps the drawer open.
  var barMenuPanel = {
    root: {
      contains: function (node) {
        return bar.contains(node) || !!(node && node.closest && node.closest("#modifyModal"));
      }
    },
    close: function () { setDrawerOpen(false); },
    returnFocus: toggleBtn
  };

  function setDrawerOpen(isOpen) {
    var wasOpen = drawer.classList.contains("is-open");
    cancelPeek();
    // Rebuilt on opening, which also sweeps a last row left from emptying while
    // open; not while an Undo line is held.
    if (isOpen && !wasOpen && !rows.isHolding()) {
      rows.render(window.EmjiveSelection.getSelection(), { animate: false });
    }
    drawer.classList.toggle("is-open", isOpen);
    toggleBtn.setAttribute("aria-expanded", String(isOpen));
    syncDrawerHeight();
    if (window.EmjiveMenus) {
      if (isOpen) window.EmjiveMenus.opened(barMenuPanel);
      else window.EmjiveMenus.closed(barMenuPanel);
    }
  }

  function toggleDrawer() {
    // Not while the Modify sheet is up (the strip covers the toggle anyway).
    if (window.EmjiveModifyModal && window.EmjiveModifyModal.isOpen()) return;
    setDrawerOpen(!drawer.classList.contains("is-open"));
  }
  toggleBtn.addEventListener("click", toggleDrawer);
  // A sibling of toggleBtn, wired separately.
  emptyLabelEl.addEventListener("click", toggleDrawer);

  /* ---- the summary row's one slot, by precedence ----
       strip  the Modify sheet's strip (js/modify-modal.js builds it; stripHost shows it)
       order  "Order (N) ›"
       empty  "No selected item" */
  var stripEl = null;
  var stripShown = false;

  var stripHost = {
    el: bar,
    show: function (strip) {
      stripEl = strip;
      stripShown = true;
      updateSummaryState();
    },
    hide: function () {
      stripShown = false;
      updateSummaryState();
    }
  };
  // Attached up front, not mid-Modify.
  if (window.EmjiveModifyModal) window.EmjiveModifyModal.attach(stripHost);

  function summaryElFor(mode) {
    if (mode === "strip") return stripEl;
    return mode === "order" ? orderLink : emptyLabelEl;
  }
  function computeSummaryMode() {
    if (stripShown) return "strip";
    return window.EmjiveSelection.getSelection().length > 0 ? "order" : "empty";
  }

  // Sequential: the incoming label fades in only after the outgoing one has
  // faded out (overlapping read as a glitch). The first call sets it instantly.
  var visibleSummaryMode = null;
  var summaryRevealTimer = null;
  var summaryHideListenerEl = null;

  function onSummaryHideEnd(e) {
    // The strip fades its surface and buttons on separate delays: only the
    // watched element's own opacity transition counts, not a bubbling child's.
    if (e.propertyName !== "opacity" || e.target !== summaryHideListenerEl) return;
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
    el.inert = false;
    // Icons reveal with Order or the empty label, never with the strip.
    if (visibleSummaryMode === "order" || visibleSummaryMode === "empty") {
      iconsEl.classList.remove("is-hidden");
    }
  }

  function updateSummaryState() {
    var mode = computeSummaryMode();
    // Before the early returns, so redundant calls keep these right. The strip
    // covers the whole summary row: nothing under it is reachable.
    bar.classList.toggle("is-strip-active", mode === "strip");
    // Hidden at once; revealed in revealCurrentSummaryMode() with the label.
    if (mode === "strip") iconsEl.classList.add("is-hidden");
    summary.inert = mode === "strip";
    if (mode === visibleSummaryMode) return;

    // A handoff under way: retarget it rather than start another; if the wanted
    // label is the one fading out, bring it straight back.
    if (summaryHideListenerEl) {
      var fading = summaryHideListenerEl;
      visibleSummaryMode = mode;
      if (summaryElFor(mode) === fading) revealCurrentSummaryMode();
      return;
    }

    var outgoingEl = visibleSummaryMode ? summaryElFor(visibleSummaryMode) : null;
    visibleSummaryMode = mode;

    if (!outgoingEl) {
      revealCurrentSummaryMode();
      return;
    }

    outgoingEl.classList.add("is-hidden");
    outgoingEl.setAttribute("aria-hidden", "true");
    outgoingEl.inert = true;
    // Read layout before listening: Safari can drop a class-triggered transition otherwise.
    void outgoingEl.offsetWidth;

    clearTimeout(summaryRevealTimer);
    summaryHideListenerEl = outgoingEl;
    outgoingEl.addEventListener("transitionend", onSummaryHideEnd);
    // In case transitionend never fires: the 0.075s fade plus a buffer.
    summaryRevealTimer = setTimeout(revealCurrentSummaryMode, 350);
  }

  // A drawer row's tap: the drawer shrinks to that row and the Modify sheet
  // rests on it; it grows back after. Focus returns to the row, or to the
  // toggle if the drawer closed meanwhile.
  function openModify(binding) {
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      bar: stripHost,
      onPreview: function (index, values) { rows.preview(index, values); },
      onOpen: function () { setDrawerReduced(true, binding.li); },
      onClose: function () { setDrawerReduced(false); },
      // The row stays as its Undo; when it goes, an emptied drawer closes.
      offerUndo: function (index, handlers) {
        return rows.offerUndo(index, {
          onUndo: handlers.onUndo,
          onGone: function () {
            handlers.onGone();
            if (!window.EmjiveSelection.getSelection().length && !rows.isHolding()) setDrawerOpen(false);
            syncDrawerHeight();
          }
        });
      },
      returnFocus: function () {
        return drawer.classList.contains("is-open") ? rows.buttonAt(binding.index) : null;
      },
      fallbackFocus: toggleBtn
    });
  }

  /* ---- icon strip ----
     Newest first in the DOM, so newer icons join at the left and the oldest
     stays by Order. Each change is a single one (EmjiveSelection.singleChange)
     and animates only its icon. iconEls is in array order (oldest first); an
     exiting icon has already left it. */

  // null: not rendered yet, so the first render's icons appear without sliding in.
  var lastKeys = null;
  var iconEls = [];

  function buildIcon(item) {
    var img = document.createElement("img");
    img.className = "selection-bar__icon";
    // The thumbnail, on every page with a selection.
    window.EmjiveHelpers.setThumb(img, item.image);
    img.alt = "";
    return img;
  }

  // A new icon slides in from the screen's left edge to its slot (distance
  // measured per element), on a long decelerating curve, then hands back to
  // the class's own transitions.
  function playEnterAnimation(iconEl) {
    var startX = -iconEl.getBoundingClientRect().left;
    iconEl.style.transition = "none";
    iconEl.style.transform = "translateX(" + startX + "px)";
    // Force layout so the start position registers before the transition.
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

  // Collapses (width and margin, so neighbours close the gap), then leaves the DOM.
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
    // In case transitionend never fires (reduced motion).
    setTimeout(finish, 400);
  }

  // An Undo: the exit in reverse, from the collapsed sliver back open where it
  // was, not the Add's slide-in.
  function playRestoreAnimation(iconEl) {
    iconEl.style.transition = "none";
    iconEl.classList.add("selection-bar__icon--exit");
    void iconEl.offsetWidth;
    iconEl.style.transition = "";
    requestAnimationFrame(function () {
      iconEl.classList.remove("selection-bar__icon--exit");
    });
  }

  // First render, or not a single change: rebuild. Only genuinely new icons
  // (multiset diff on keys) slide in; none on the first render.
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

  // detail tells an Undo's insert from an Add.
  function renderIcons(items, detail) {
    var sel = window.EmjiveSelection;
    var keys = items.map(sel.itemKey);
    var oldKeys = lastKeys;
    lastKeys = keys;
    var change = oldKeys && sel.singleChange(oldKeys, keys);
    if (!change) {
      rebuildIcons(items, keys, oldKeys);
      return;
    }

    if (change.type === "insert") {
      var icon = buildIcon(items[change.index]);
      // Before its older neighbour (newest first), or at the end.
      iconsEl.insertBefore(icon, change.index > 0 ? iconEls[change.index - 1] : null);
      iconEls.splice(change.index, 0, icon);
      // Unhidden first: the animation measures where it landed.
      iconsEl.hidden = false;
      if (detail && detail.action === "insert") playRestoreAnimation(icon);
      else playEnterAnimation(icon);
    } else if (change.type === "remove") {
      playExitAnimation(iconEls.splice(change.index, 1)[0]);
    } else {
      items.forEach(function (item, i) {
        if (keys[i] === oldKeys[i]) return;
        window.EmjiveHelpers.setThumb(iconEls[i], item.image);
      });
    }
  }

  /* ---- render ---- */

  function render(e) {
    var items = window.EmjiveSelection.getSelection();
    var hasItems = items.length > 0;

    renderIcons(items, e && e.detail);

    if (announcedCount !== null && items.length !== announcedCount) {
      statusEl.textContent = hasItems
        ? items.length + (items.length === 1 ? " item" : " items") + " in your order"
        : "Your order is empty";
    }
    announcedCount = items.length;

    // Both labels stay laid out and crossfade (.is-hidden).
    updateSummaryState();
    // Not updated when emptying, so Order fades out still reading its last count.
    if (hasItems) {
      orderCountEl.textContent = "Order (" + items.length + ")";
    }

    // Rows animate only while the drawer is open. Emptying closes the drawer
    // with its last row, unless that row is held as an Undo.
    if (hasItems || rows.isHolding()) {
      rows.render(items, { animate: drawer.classList.contains("is-open") });
    } else {
      setDrawerOpen(false);
    }
    // Re-measured, so an open drawer follows its rows.
    syncDrawerHeight();
    // A real Add: peek the new row.
    if (e && e.detail && e.detail.action === "add") peekNewest();
  }

  window.addEventListener("emjive:selection-changed", render);
  render();

  // The homepage bar slides in continuing the hero's wipe: the hero publishes
  // how far past its trigger the page has scrolled, and the bar's travel is
  // measured here. Set per scroll frame, both directions. Without a hero
  // nothing publishes and the bar just stays visible.
  var summaryHeight = 0;
  if (window.EmjiveHero && typeof ResizeObserver === "function") {
    new ResizeObserver(function (entries) {
      summaryHeight = entries[entries.length - 1].target.getBoundingClientRect().height;
    }).observe(summary);
  }
  if (window.EmjiveHero) {
    window.EmjiveHero.onScroll(function (pastTriggerPx, hasScrollRange) {
      // The summary row's height (the drawer would make the bar's vary), cached by
      // ResizeObserver: measuring here, right after the hero's style writes, would
      // force a layout every frame.
      var revealDistance = Math.max(summaryHeight || summary.getBoundingClientRect().height, 1);
      var progress = hasScrollRange ? Math.min(1, pastTriggerPx / revealDistance) : 1;
      bar.style.transform = "translateY(" + (100 - progress * 100) + "%) translateZ(0)";
    });
  }
})();
