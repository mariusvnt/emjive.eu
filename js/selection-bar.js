/* ==========================================================================
   J&MV — floating selection bar
   Present on every page except launch-order.html (that page already shows
   the full list — this script simply isn't included there). Mirrors the
   header visually (full-width, fixed) but in black: always shows either
   "No selected item" or a row of thumbnails for whatever's in
   window.EmjiveSelection, plus an "Order ›" link straight to
   launch-order.html. Clicking the bar itself (not the Order link) opens a
   drawer listing the selected items — the very same rows as the order page
   (js/order-rows.js). Tapping one shrinks the drawer down to just that row
   and opens the Modify sheet (js/modify-modal.js) right on top of it, while
   the bar itself turns into the sheet's Unselect | Save — and, after an
   Unselect, into "Undo" for a few seconds.

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
  // element that never had the class to begin with. Hidden also means
  // inert, so an invisible label can't be tabbed to.
  var emptyLabelEl = el("span", "selection-bar__empty-label is-hidden");
  emptyLabelEl.textContent = "No selected item";
  emptyLabelEl.setAttribute("aria-hidden", "true");
  emptyLabelEl.inert = true;

  var orderLink = document.createElement("a");
  orderLink.className = "selection-bar__order is-hidden";
  orderLink.href = "launch-order.html";
  orderLink.setAttribute("aria-hidden", "true");
  orderLink.inert = true;
  var orderCountEl = el("span", "selection-bar__order-count");
  var orderChevronEl = el("span", "selection-bar__order-chevron");
  orderChevronEl.textContent = "›"; // ›
  orderLink.appendChild(orderCountEl);
  orderLink.appendChild(orderChevronEl);

  // Occupies the same reserved slot as emptyLabelEl/orderLink (see
  // updateSummaryState() below) — shown only while js/product.js's size
  // sheet holds a size that can be added, replacing whichever of the other
  // two would otherwise be showing. pendingConfirm is the callback that
  // actually performs it, pendingLabel what the button says, both supplied
  // by whoever called showAction().
  var addActionBtn = document.createElement("button");
  addActionBtn.type = "button";
  addActionBtn.className = "selection-bar__add is-hidden";
  addActionBtn.textContent = "Add";
  addActionBtn.setAttribute("aria-hidden", "true");
  addActionBtn.inert = true;
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
  var rows = window.EmjiveOrderRows.create({
    listEl: rowsEl,
    rowClass: "order-item--drawer",
    showPrice: false,
    onModify: openModify,
    onResize: syncDrawerHeight
  });

  /* ---- drawer height --------------------------------------------------------
     Measured and set in px — on the drawer AND on its inner scroll box,
     both carrying the same 0.3s max-height transition (css/style.css) —
     rather than the grid-template-rows 0fr/1fr trick .site-header__menu
     uses: that only animates between two fixed states, and this drawer
     moves between several — closed, open, open with a row coming or going,
     and shrunk down to the one row the Modify sheet was opened from.
     Setting the inner box's cap alongside is what keeps the list scrolled
     right at whatever height the drawer is at; closed, the inner box keeps
     the list's own height, so nothing reflows while the drawer slides shut.
     The list's height is the one it's heading to (rows.settledHeight()), so
     a row collapsing or coming back doesn't send the drawer somewhere else
     first. */

  // As it always was: two thirds of the screen, past which the rows scroll.
  var LIST_CAP = 0.66;
  // While the Modify sheet is up, the drawer shows nothing but the row it
  // was opened from: this is that row's height (null the rest of the time),
  // and the sheet rests right on top of it.
  var reducedHeight = null;

  // Returns the height the drawer is now heading to.
  function syncDrawerHeight() {
    var isOpen = drawer.classList.contains("is-open");
    var summaryHeight = summary.getBoundingClientRect().height;
    var listHeight = Math.min(rows.settledHeight(), window.innerHeight * LIST_CAP);
    var target = !isOpen ? 0 : reducedHeight !== null ? reducedHeight : listHeight;
    drawer.style.maxHeight = target + "px";
    drawerInner.style.maxHeight = (isOpen ? target : listHeight) + "px";
    // Published so a sheet (js/product.js's #sizeModal, js/modify-modal.js's
    // #modifyModal) can rest exactly this far above the bar — see
    // .size-modal--drawer's --selection-bar-reserved in css/style.css. It's
    // the height the drawer is heading to, and the sheet's own 0.3s
    // padding-bottom transition then moves it in step with the drawer.
    document.documentElement.style.setProperty("--selection-bar-live-height", summaryHeight + target + "px");
    return target;
  }

  // Scrolls the list to `to` in step with the drawer's height transition,
  // which syncDrawerHeight() has just set off: each frame the scroll covers
  // the same share of its distance as the drawer has of its own. On the way
  // in, the tapped row glides straight into place right above the bar while
  // the rows around it scroll or clip away — and on the way out, the list
  // opens back up around it. Set from here only: while reduced the list is
  // overflow: hidden, which stops the visitor's scrolling, not this.
  var scrollRun = 0;

  function animateDrawerScroll(to, fromHeight, toHeight) {
    var run = ++scrollRun;
    var from = drawerInner.scrollTop;
    var span = toHeight - fromHeight;
    // Past the 0.3s transition, in case it never runs (a background tab).
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

  // Where the list was scrolled before it was reduced, to go back to.
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
      // No scrolling by hand while the sheet is up (the CSS makes the list
      // overflow: hidden). That also takes away a scrollbar that takes up
      // room (Windows), so its width goes back on as padding: the rows keep
      // their exact width.
      var scrollbar = drawerInner.offsetWidth - drawerInner.clientWidth;
      bar.classList.add("is-drawer-reduced");
      drawerInner.style.paddingRight = scrollbar > 0 ? scrollbar + "px" : "";
    } else {
      reducedHeight = null;
      bar.classList.remove("is-drawer-reduced");
      drawerInner.style.paddingRight = "";
    }
    var toHeight = syncDrawerHeight();
    // Back where it was — as far as the list, a row shorter after an
    // Unselect, still lets it be.
    if (!on) to = Math.min(restoreScroll, Math.max(0, rows.settledHeight() - toHeight));
    animateDrawerScroll(to, fromHeight, toHeight);
  }

  // Registered with window.EmjiveMenus (js/series.js) so a click away from
  // the bar closes the drawer — root spans the whole bar (toggle/summary
  // row included), not just the drawer, so clicking the toggle itself is
  // never mistaken for "away" by that shared listener. The Modify sheet
  // counts as part of the bar too: tapping its backdrop dismisses the
  // sheet, and the drawer it was opened from stays open.
  var barMenuPanel = {
    root: {
      contains: function (node) {
        return bar.contains(node) || !!(node && node.closest && node.closest("#modifyModal"));
      }
    },
    close: function () { setDrawerOpen(false); }
  };

  function setDrawerOpen(isOpen) {
    var wasOpen = drawer.classList.contains("is-open");
    // Rebuilt fresh on the way open. That also sweeps away the last row of
    // a cart that emptied while the drawer was open: render() stops
    // updating the rows once the cart is empty, so that row leaves with
    // the closing drawer instead of collapsing on its own first.
    if (isOpen && !wasOpen) {
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
    // The bar's own "pop up" (its drawer) sits out entirely while the bar
    // itself is acting as one big Add button (see .is-add-active below) —
    // the whole point of that mode is a single, unambiguous hit target.
    if (bar.classList.contains("is-add-active")) return;
    // Likewise while the Modify sheet is up. The strip covers the toggle
    // then anyway (and the summary row is inert); this is the backstop.
    if (window.EmjiveModifyModal && window.EmjiveModifyModal.isOpen()) return;
    setDrawerOpen(!drawer.classList.contains("is-open"));
  }
  toggleBtn.addEventListener("click", toggleDrawer);
  // emptyLabelEl is a sibling of toggleBtn (not inside it — see its own
  // comment above), so it needs this wired separately to still open the
  // drawer when clicked.
  emptyLabelEl.addEventListener("click", toggleDrawer);

  // While the size sheet has a size to add, the ENTIRE bar becomes
  // addActionBtn's hit box rather than just its own small centered label —
  // bubbling catches a click anywhere in the bar, including a keyboard
  // Enter/Space activation of addActionBtn itself (which also dispatches a
  // real, bubbling click). Guarded on is-add-active so this is a complete
  // no-op the rest of the time. The Modify strip's buttons (appended to the
  // bar while that sheet is up) handle their own clicks.
  // Never for a click from inside the drawer, though: a row tap there opens
  // the Modify sheet off an already-resolved promise, whose callbacks run in
  // the microtask checkpoint between two listeners of that same click — so
  // by the time the click reaches this one, the bar may already have
  // changed mode under it.
  bar.addEventListener("click", function (e) {
    if (drawer.contains(e.target)) return;
    if (bar.classList.contains("is-add-active") && pendingConfirm) pendingConfirm();
  });

  /* ---- the summary row's one slot ------------------------------------------
     Whatever the bar has to say, it says in one place, one thing at a time:
       add    js/product.js's size sheet has a size to add — "Add"
       strip  the Modify sheet is up (or its "Undo" is on offer) — its strip,
              laid over the whole row (js/modify-modal.js builds it; this
              bar only shows and hides it — stripHost below)
       order  items selected — "Order (N) ›"
       empty  nothing selected — "No selected item"
     in that order of precedence: even an empty cart shows "Add" once a size
     is picked, and a size typed while "Undo" is on offer takes the bar
     over. */
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
  // The strip goes into the bar now, hidden, rather than in the middle of
  // the first Modify.
  if (window.EmjiveModifyModal) window.EmjiveModifyModal.attach(stripHost);

  function summaryElFor(mode) {
    if (mode === "add") return addActionBtn;
    if (mode === "strip") return stripEl;
    return mode === "order" ? orderLink : emptyLabelEl;
  }
  function computeSummaryMode() {
    if (pendingConfirm) return "add";
    if (stripShown) return "strip";
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
    // Target check matters now that the strip (one of the things this can
    // watch) fades on more than one element — its surface and its three
    // buttons, separately delayed (css/style.css's .modify-strip::before).
    // Without it, a button's own faster opacity transition bubbling up
    // through this listener would reveal the next label before the
    // strip's surface has actually finished. Same pattern as
    // js/selection-page.js's crossfade(), which already filters this way.
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
    // Relabelled only here, while it's still fully transparent — a label
    // changing in plain sight would read as a flicker.
    if (visibleSummaryMode === "add") addActionBtn.textContent = pendingLabel;
    el.classList.remove("is-hidden");
    el.setAttribute("aria-hidden", "false");
    el.inert = false;
    // Icons only ever share the bar with Order/the empty label — never
    // with Add or the strip — and reveal at the exact same instant those
    // do, here, rather than the moment is-add-active/is-strip-active
    // clears (updateSummaryState()'s own hide, above): everything fades
    // in together instead of icons arriving a beat early.
    if (visibleSummaryMode === "order" || visibleSummaryMode === "empty") {
      iconsEl.classList.remove("is-hidden");
    }
  }

  function updateSummaryState() {
    var mode = computeSummaryMode();
    // Ahead of the early returns below (which only fire once nothing about
    // the visible label needs to change) so these stay correct even on a
    // redundant call — cheap, and all idempotent. Entering add mode also
    // closes the drawer if it happened to be open — that "pop up" sits out
    // entirely while the bar is one big Add button (see toggleDrawer()'s
    // own guard above, which is what keeps it closed for the duration). The
    // strip leaves the drawer be: the Modify sheet is opened from it. The
    // strip covers the whole summary row, so nothing under it should be
    // reachable while it's up.
    bar.classList.toggle("is-add-active", mode === "add");
    bar.classList.toggle("is-strip-active", mode === "strip");
    // Hidden at once, same as always — only its REVEAL moves, to
    // revealCurrentSummaryMode() below, so it fades back in alongside
    // Order/the empty label instead of a beat ahead of them.
    if (mode === "add" || mode === "strip") iconsEl.classList.add("is-hidden");
    summary.inert = mode === "strip";
    if (mode === "add") setDrawerOpen(false);
    if (mode === visibleSummaryMode) return;

    // A handoff already under way — its outgoing label still fading out:
    // retarget it rather than start a second one on top (its reveal reads
    // visibleSummaryMode when it fires). If the label now wanted is the
    // very one fading out, it comes straight back instead. Saving and at
    // once tapping another row, say, or a size typed while "Undo" shows.
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
    // Forces layout before the transitionend listener below is attached —
    // Safari has a known history of coalescing/dropping a transition
    // that's triggered by a class change with nothing reading layout in
    // between (same reasoning as playEnterAnimation()'s own
    // `void iconEl.offsetWidth` a bit further down this file).
    void outgoingEl.offsetWidth;

    clearTimeout(summaryRevealTimer);
    summaryHideListenerEl = outgoingEl;
    outgoingEl.addEventListener("transitionend", onSummaryHideEnd);
    // Fallback in case transitionend never fires (e.g. a backgrounded tab),
    // matching the 0.075s opacity transition these share plus a buffer.
    summaryRevealTimer = setTimeout(revealCurrentSummaryMode, 350);
  }

  // label: "Add" (js/product.js).
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

  // A drawer row's tap: the drawer stays open but shrinks down to just that
  // row, and the Modify sheet (js/modify-modal.js) slides up from behind the
  // bar to rest right on top of it, the bar turning into its strip. The
  // drawer grows back — height and scroll — once the sheet is gone. Focus
  // comes back to the row (still there: rows are updated in place), or, if
  // the drawer closed meanwhile (its last item unselected), to the toggle.
  function openModify(binding) {
    window.EmjiveModifyModal.open(binding.item, binding.index, {
      bar: stripHost,
      onPreview: function (index, values) { rows.preview(index, values); },
      onOpen: function () { setDrawerReduced(true, binding.li); },
      onClose: function () { setDrawerReduced(false); },
      returnFocus: function () {
        return drawer.classList.contains("is-open") ? rows.buttonAt(binding.index) : null;
      },
      fallbackFocus: toggleBtn
    });
  }

  /* ---- icon strip ---------------------------------------------------------
     Newest-first in DOM — a plain (non-reversed) row then lands DOM child 0
     (newest) at the strip's *left* end and the last DOM child (oldest) at
     its right end, next to Order, which stays put once picked; each newer
     item joins to its left instead of displacing it.

     Every change the site makes to the selection is a single one — an Add,
     an Unselect, an Undo, a Modify — so renderIcons() works out which of
     those just happened (EmjiveSelection.singleChange, the same diff the
     rows use) and animates exactly that one icon, rather than rebuilding
     the strip. iconEls holds the live icons in array order (oldest first),
     which is what maps a storage index to its element; an icon playing its
     exit animation has already left iconEls, so it can never throw that
     mapping off while it collapses. */

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

  // playExitAnimation in reverse, for an Undo: the icon goes in as the
  // collapsed sliver its exit ends on (.selection-bar__icon--exit — width,
  // margin, opacity and scale), snapped there without a transition, and
  // eases back open on its own transitions on the next frame, easing its
  // neighbours apart as it grows. Back where it was, the way it left —
  // not the long slide in from the screen's edge an Add plays.
  function playRestoreAnimation(iconEl) {
    iconEl.style.transition = "none";
    iconEl.classList.add("selection-bar__icon--exit");
    void iconEl.offsetWidth;
    iconEl.style.transition = "";
    requestAnimationFrame(function () {
      iconEl.classList.remove("selection-bar__icon--exit");
    });
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

  // detail: the change event's own account of what happened (see notify()
  // in js/selection.js) — only needed to tell an Undo's insert from an
  // Add's.
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
      // Newest-first in DOM, so the new icon goes right before its older
      // neighbour (or at the very end, if it's now the oldest).
      iconsEl.insertBefore(icon, change.index > 0 ? iconEls[change.index - 1] : null);
      iconEls.splice(change.index, 0, icon);
      // Unhidden before measuring: playEnterAnimation reads where the icon
      // actually landed, and a [hidden] strip has no layout at all.
      iconsEl.hidden = false;
      if (detail && detail.action === "insert") playRestoreAnimation(icon);
      else playEnterAnimation(icon);
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

  function render(e) {
    var items = window.EmjiveSelection.getSelection();
    var hasItems = items.length > 0;

    renderIcons(items, e && e.detail);

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
    // order, same order items were actually picked in. The rows follow
    // every change, animated only while the drawer is open for anyone to
    // see — except the one that empties the cart: then the drawer simply
    // closes, its last row still in it (see setDrawerOpen()).
    if (hasItems) {
      rows.render(items, { animate: drawer.classList.contains("is-open") });
    } else {
      setDrawerOpen(false);
    }
    // Re-measures against the updated rows — if the drawer is open, this
    // is what makes it grow/shrink smoothly with them.
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
