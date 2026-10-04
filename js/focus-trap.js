/* ==========================================================================
   em·ji·ve — modal focus trap

   Shared by the site's two dialogs, which are the same bottom-sheet
   component twice: #sizeModal (product.html, opened by the Select button)
   and #modifyModal (built by js/modify-modal.js on every page, opened by
   tapping a row — in launch-order.html's order list or the floating bar's
   drawer). Loaded on all seven pages now that the Modify sheet is, and
   still not folded into js/series.js (the obvious alternative home): that
   one is a blocking <head> script, and nothing here needs to be.

   What was missing before this: both dialogs were already marked up
   correctly and already closed on Escape and on a backdrop click, but focus
   never entered them, Tab walked straight out into the page behind, and
   closing left focus wherever it had drifted to. A keyboard visitor opening
   the size picker had to tab through the whole page to reach the size
   buttons, and could tab back out of an "aria-modal" dialog while it was
   still open.

   THE TRAP ROOT IS .size-modal, NEVER .size-modal__panel. The panel is only
   part of the dialog: on #modifyModal the carousel (a draggable 3D model and
   its photos) is a SIBLING of the panel, not a child, and a trap scoped to
   the panel would leave part of the dialog outside itself. Both dialogs
   carry role="dialog"/aria-modal/aria-label on .size-modal for the same
   reason: a screen reader honouring aria-modal hides everything outside the
   declared dialog.

   The Modify sheet's own buttons live outside it altogether: Unselect and
   Save are the page's bar (js/modify-modal.js's strip), so that sheet
   passes the strip as `include` — its buttons join the Tab cycle after the
   sheet's own controls, and focus landing on them isn't pulled back.

   A modal also freezes the page behind it, so that's done here too, on
   activate() and release(): every dialog on the site goes through both —
   see lockPage() below.

   A closed modal needs no handling here: .size-modal is visibility: hidden
   when closed (css/style.css), visibility inherits, and an element whose
   computed visibility isn't `visible` is excluded from sequential focus
   navigation outright. Nothing inside either modal redeclares it.
   ========================================================================== */

(function (global) {
  "use strict";

  var FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  var activeRoot = null;
  var includeEls = [];
  var returnFocusTo = null;
  var fallbackFocusTo = null;
  var onEscape = null;

  /* ---- focus handed back after a tap ----------------------------------------
     Closing a sheet hands focus back to whatever opened it — a row, the
     Select button, the bar's Undo — which is right for a keyboard, but a
     ring appearing there after a tap reads as a glitch. And browsers do draw
     one: programmatic focus inherits :focus-visible from the element focus
     came from, and the size field (a text input) always matches it — on
     iOS especially, where tapping the bar's Save doesn't move focus off the
     field first. So the last input is tracked (capture phase, so nothing
     that stops propagation can hide an event from it), and focus handed
     back right after a pointer input carries .is-focus-quiet — which
     css/style.css uses to drop the ring — until that element loses focus or
     the next key is pressed, when the ring is right again. */
  var lastInputWasPointer = false;
  document.addEventListener("pointerdown", function () { lastInputWasPointer = true; }, true);
  document.addEventListener("keydown", function () { lastInputWasPointer = false; }, true);

  function focusElement(el, options) {
    if (!el) return;
    if (lastInputWasPointer) {
      el.classList.add("is-focus-quiet");
      var clear = function () {
        el.classList.remove("is-focus-quiet");
        el.removeEventListener("blur", clear);
        document.removeEventListener("keydown", clear, true);
      };
      el.addEventListener("blur", clear);
      document.addEventListener("keydown", clear, true);
    }
    el.focus(options);
    // The element couldn't take focus after all (hidden, inert): nothing to
    // be quiet about, and a class left behind would silence a later,
    // genuinely keyboard-driven focus.
    if (document.activeElement !== el) el.classList.remove("is-focus-quiet");
  }

  /* ---- the page behind a modal stays put ------------------------------------
     On <html>, not <body>: html carries overflow-x: hidden (css/style.css),
     and once html's overflow isn't `visible`, body's own overflow stops
     applying to the viewport — a body-level overflow: hidden then only
     clips body's own box, and the page behind the sheet went on scrolling
     exactly as before. html.is-modal-open (css/style.css) stops the viewport
     itself. Its scroll position doesn't move, so nothing driven by it (the
     homepage bar's scroll-linked reveal) does either.
     Where scrollbars take up room (Windows, mostly), hiding the page's would
     widen everything behind the backdrop by its width for as long as the
     sheet is up. So its width is published as --page-scrollbar, which
     css/style.css gives back as padding — on <html> for the page, and on the
     fixed bars and header, which size themselves to the viewport rather
     than to the page. (scrollbar-gutter: stable would be the tidy way, but
     Chrome doesn't keep the root's gutter once its overflow is hidden.)
     Zero wherever scrollbars float over the page instead (phones, macOS). */
  function lockPage() {
    var root = document.documentElement;
    var scrollbar = Math.max(0, global.innerWidth - root.clientWidth);
    root.style.setProperty("--page-scrollbar", scrollbar + "px");
    root.classList.add("is-modal-open");
  }

  function unlockPage() {
    var root = document.documentElement;
    root.classList.remove("is-modal-open");
    root.style.removeProperty("--page-scrollbar");
  }

  // Recomputed on every Tab rather than cached at activate() time, because
  // the dialogs change shape: the Modify sheet rebuilds its metal buttons
  // and carousel slides for every item it opens on, and either sheet's
  // contents can change under an open trap. A cached list goes stale.
  function focusable(root) {
    var all = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      // The same mechanism that already keeps a closed modal untabbable, so
      // one check covers the modal itself and anything inside it that hides
      // the same way later. getClientRects() catches display: none.
      if (global.getComputedStyle(el).visibility === "hidden") continue;
      if (!el.getClientRects().length) continue;
      // The strip's inactive buttons (Undo while modifying, Unselect/Save
      // while offering Undo) are inert, and so is the whole strip while
      // it's hidden.
      if (el.closest("[inert]")) continue;
      out.push(el);
    }
    return out;
  }

  function trapItems() {
    var items = focusable(activeRoot);
    includeEls.forEach(function (el) { items = items.concat(focusable(el)); });
    return items;
  }

  function inTrap(node) {
    if (!activeRoot || !node) return false;
    if (activeRoot.contains(node)) return true;
    return includeEls.some(function (el) { return el.contains(node); });
  }

  // A target may be given as an element or as a function returning one. The
  // function form is what makes a stale trigger survivable — see release().
  function resolveTarget(want) {
    var el = typeof want === "function" ? want() : want;
    return el && global.document.contains(el) ? el : null;
  }

  function onKeydown(e) {
    if (!activeRoot) return;

    if (e.key === "Escape") {
      if (onEscape) {
        // preventDefault so the same keypress can't also reach something
        // behind the dialog — a native picker on the size input, say.
        e.preventDefault();
        onEscape();
      }
      return;
    }

    if (e.key !== "Tab") return;

    // Every Tab is moved by hand, wrapping at both ends, rather than only
    // the two edges: an included element (the Modify sheet's strip) sits
    // somewhere else in the document entirely, so the browser's own Tab
    // order would never step between it and the dialog. From the dialog
    // root itself (where focus starts), Tab goes to the first control and
    // Shift+Tab to the last.
    e.preventDefault();
    var items = trapItems();
    // Nothing to move to, but focus still must not leave.
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    var next = at === -1
      ? (e.shiftKey ? items[items.length - 1] : items[0])
      : items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
    next.focus();
  }

  // Focus can leave without a Tab keypress at all — a click on page chrome
  // behind the backdrop, a screen reader's own navigation commands, a
  // browser autofill dropdown handing focus back somewhere unexpected.
  // focusin bubbles, so one document-level listener covers every route.
  function onFocusIn(e) {
    if (!activeRoot || inTrap(e.target)) return;
    var items = focusable(activeRoot);
    (items[0] || activeRoot).focus();
  }

  global.EmjiveFocusTrap = {
    /* root    — the element focus is confined to (.size-modal; see header).
       options — all optional:
         include       an element (or array of them) outside root whose
                       controls count as inside the trap — the Modify
                       sheet's bar strip. Tabbed to after root's own.
         returnFocus   Element, or a function returning one, resolved at
                       release() time rather than here.
         fallbackFocus same, used when returnFocus resolves to nothing still
                       in the document.
         initialFocus  defaults to root itself, so the dialog's own
                       aria-label is announced before its first control.
         onEscape      called on Escape. Omit to keep your own handler. */
    activate: function (root, options) {
      if (!root) return;
      options = options || {};
      // Defensive: two modals are never open at once (product.html's size
      // sheet closes itself when the Modify sheet opens — the
      // "emjive:modify-open" event), but a stacked activate() would
      // otherwise silently orphan the first trap's listeners.
      if (activeRoot) this.release();

      activeRoot = root;
      includeEls = [].concat(options.include || []).filter(Boolean);
      returnFocusTo = options.returnFocus || document.activeElement;
      fallbackFocusTo = options.fallbackFocus || null;
      onEscape = options.onEscape || null;

      document.addEventListener("keydown", onKeydown);
      document.addEventListener("focusin", onFocusIn);
      lockPage();

      // Belt and braces — both modals carry tabindex="-1", but a root
      // without it would silently swallow focus() and leave the trap
      // anchored on <body>, where onFocusIn would then fight every move.
      if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");

      // preventScroll: the sheet is a fixed overlay over a page just locked
      // above, so any scrolling this provoked could only shift
      // .size-modal__panel's own overflow-y box off its top for no reason.
      //
      // Callers MUST call this AFTER adding .is-open — focus() on a
      // visibility: hidden element is a no-op, and the modal is hidden
      // until that class lands.
      (options.initialFocus || root).focus({ preventScroll: true });
    },

    /* focusTarget — optional: where focus goes instead of returnFocus (the
       Modify sheet sends it to the bar's Undo after an Unselect). */
    release: function (focusTarget) {
      if (!activeRoot) return;
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("focusin", onFocusIn);
      activeRoot = null;
      includeEls = [];
      // Before focus moves below, so a target that's off-screen can still be
      // scrolled into view.
      unlockPage();

      // Resolved HERE, not at activate() time, and that is the whole reason
      // returnFocus accepts a function: the element that opened a sheet can
      // be gone by the time it closes (a row whose item was just
      // unselected, a list that emptied), and a lookup run now finds
      // whatever occupies that slot today.
      var target = resolveTarget(focusTarget) || resolveTarget(returnFocusTo) || resolveTarget(fallbackFocusTo);
      returnFocusTo = null;
      fallbackFocusTo = null;
      onEscape = null;

      // No preventScroll this time: the trigger may legitimately be
      // off-screen now, and scrolling it back into view is exactly right.
      focusElement(target);
    },

    // Whether a dialog currently holds the trap — for the Escape handling
    // outside it (js/series.js's EmjiveMenus), which must leave a keypress to
    // the dialog while one is open.
    isActive: function () {
      return !!activeRoot;
    },

    // Moves focus the way release() hands it back — quietly after a tap —
    // for focus moves that aren't a trap release: the bar's Undo resolving.
    // Same element-or-function target.
    focus: function (target) {
      focusElement(resolveTarget(target));
    }
  };
})(window);
