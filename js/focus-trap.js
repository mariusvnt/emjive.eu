// Modal focus trap and page lock for the bottom sheets (#sizeModal,
// #modifyModal, the size finder): window.EmjiveFocusTrap.
//
// The trap root is .size-modal, never .size-modal__panel: on #modifyModal
// the model's frame is a sibling of the panel. Controls outside the root (the
// Modify sheet's strip, on its order row) join via `include`. A closed modal
// needs nothing here: visibility: hidden already removes it from the Tab order.

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
  // Traps underneath the active one, restored on release() (`nested` dialogs).
  var stack = [];

  /* ---- quiet focus return ----
     Focus handed back right after a pointer input gets .is-focus-quiet (no
     ring) until blur or the next key: programmatic focus inherits
     :focus-visible, so a ring would otherwise appear after a tap (notably on
     iOS). release()'s `quiet` forces it. */
  var lastInputWasPointer = false;
  document.addEventListener("pointerdown", function () { lastInputWasPointer = true; }, true);
  document.addEventListener("keydown", function () { lastInputWasPointer = false; }, true);

  function focusElement(el, options, quiet) {
    if (!el) return;
    if (quiet || lastInputWasPointer) {
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
    // Focus didn't take (hidden, inert): don't leave the class for a later keyboard focus.
    if (document.activeElement !== el) el.classList.remove("is-focus-quiet");
  }

  /* ---- page lock ----
     On <html>: with html's overflow-x: hidden, body's overflow no longer
     controls the viewport. The scrollbar's width is published as
     --page-scrollbar so CSS can pad it back and nothing shifts
     (scrollbar-gutter: stable doesn't hold once the root's overflow is hidden
     in Chrome). */
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

  // Recomputed on every Tab: the sheets' contents change while open.
  function focusable(root) {
    var all = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      // getClientRects() catches display: none.
      if (global.getComputedStyle(el).visibility === "hidden") continue;
      if (!el.getClientRects().length) continue;
      // Inactive strip buttons, and the hidden strip, are inert.
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

  // An element, or a function returning one (resolved late, see release()).
  function resolveTarget(want) {
    var el = typeof want === "function" ? want() : want;
    return el && global.document.contains(el) ? el : null;
  }

  function onKeydown(e) {
    if (!activeRoot) return;

    if (e.key === "Escape") {
      if (onEscape) {
        // So the key doesn't also reach something behind the dialog.
        e.preventDefault();
        onEscape();
      }
      return;
    }

    if (e.key !== "Tab") return;

    // Every Tab is moved by hand: included elements sit elsewhere in the
    // document, outside the browser's own Tab order.
    e.preventDefault();
    var items = trapItems();
    // Nothing to move to, but focus must not leave.
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    var next = at === -1
      ? (e.shiftKey ? items[items.length - 1] : items[0])
      : items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
    next.focus();
  }

  // Focus can leave without Tab (clicks, screen readers, autofill).
  function onFocusIn(e) {
    if (!activeRoot || inTrap(e.target)) return;
    var items = focusable(activeRoot);
    (items[0] || activeRoot).focus();
  }

  global.EmjiveFocusTrap = {
    /* root    the element focus is confined to (.size-modal)
       options (all optional):
         include       element(s) outside root whose controls join the trap, after root's
         returnFocus   element or function, resolved at release()
         fallbackFocus used when returnFocus is no longer in the document
         initialFocus  defaults to root, so its aria-label is announced first
         onEscape      called on Escape
         nested        opens over another open dialog, whose trap is restored on release
       Call after adding .is-open: focus() is a no-op on a hidden element. */
    activate: function (root, options) {
      if (!root) return;
      options = options || {};
      if (activeRoot && options.nested) {
        stack.push({
          root: activeRoot,
          include: includeEls,
          returnFocus: returnFocusTo,
          fallback: fallbackFocusTo,
          onEscape: onEscape
        });
        // The page is already locked and the listeners on.
        activeRoot = root;
        includeEls = [].concat(options.include || []).filter(Boolean);
        returnFocusTo = options.returnFocus || document.activeElement;
        fallbackFocusTo = options.fallbackFocus || null;
        onEscape = options.onEscape || null;
        if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
        (options.initialFocus || root).focus({ preventScroll: true });
        return;
      }
      // Two modals are never open at once, but don't orphan a trap's listeners.
      if (activeRoot) this.release();

      activeRoot = root;
      includeEls = [].concat(options.include || []).filter(Boolean);
      returnFocusTo = options.returnFocus || document.activeElement;
      fallbackFocusTo = options.fallbackFocus || null;
      onEscape = options.onEscape || null;

      document.addEventListener("keydown", onKeydown);
      document.addEventListener("focusin", onFocusIn);
      lockPage();

      // Without tabindex, focus() would fail and leave the trap anchored on <body>.
      if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");

      // preventScroll: the sheet is a fixed overlay over a locked page.
      (options.initialFocus || root).focus({ preventScroll: true });
    },

    /* focusTarget  optional: where focus goes instead of returnFocus
       quiet        optional: no ring even after a key (see above) */
    release: function (focusTarget, quiet) {
      if (!activeRoot) return;
      if (stack.length) {
        // A nested dialog closing: the one underneath is the trap again.
        var released = resolveTarget(focusTarget) || resolveTarget(returnFocusTo) || resolveTarget(fallbackFocusTo);
        var under = stack.pop();
        activeRoot = under.root;
        includeEls = under.include;
        returnFocusTo = under.returnFocus;
        fallbackFocusTo = under.fallback;
        onEscape = under.onEscape;
        focusElement(released, undefined, quiet === true);
        return;
      }
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("focusin", onFocusIn);
      activeRoot = null;
      includeEls = [];
      // Before focus moves, so an off-screen target can scroll into view.
      unlockPage();

      // Resolved now: the opener may be gone (an unselected row, an emptied list).
      var target = resolveTarget(focusTarget) || resolveTarget(returnFocusTo) || resolveTarget(fallbackFocusTo);
      returnFocusTo = null;
      fallbackFocusTo = null;
      onEscape = null;

      focusElement(target, undefined, quiet === true);
    },

    // For outside Escape handling (EmjiveMenus in js/series.js).
    isActive: function () {
      return !!activeRoot;
    },

    // A non-release focus move, quiet after a tap like release().
    focus: function (target) {
      focusElement(resolveTarget(target));
    }
  };
})(window);
