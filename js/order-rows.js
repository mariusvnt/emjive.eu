/* ==========================================================================
   em·ji·ve — order rows
   The item rows shared by launch-order.html's order list and the floating
   selection bar's drawer (js/selection-page.js and js/selection-bar.js), so
   the two behave identically: a tap on a row crossfades its content into a
   Modify/Unselect overlay, Unselect crossfades it in place into its own
   "Undo" prompt, and only a row whose undo window runs out unused actually
   collapses. Same .order-item markup and CSS in both lists.

   window.EmjiveOrderRows.create(options) returns
   { render(items), closeOpenRow(), hasPending(), isMutating() }.
   options:
     listEl               the <ul> the rows are rendered into
     rowClass             an extra class on every <li> (the drawer's
                          "order-item--drawer")
     showPrice            the order list shows each row's price; the drawer
                          doesn't
     closeOnOutsideClick  register an open row with window.EmjiveMenus, so a
                          click anywhere else closes it (the order list). The
                          drawer leaves this off: a click away from the bar
                          closes the whole drawer, which closes its open row
                          on the way (closeOpenRow()).
     onModify(binding)    Modify was clicked — binding.item / binding.index
     onChange()           an Unselect or Undo just changed storage
     onRowRemoved()       a row's final collapse took it out of the list
     onEmptied()          the last row's undo window ran out, none remain
   ========================================================================== */

(function (global) {
  "use strict";

  var UNDO_TIMEOUT_MS = 4000;

  /* ---- keyboard vs. pointer ------------------------------------------------
     A row's overlay opens only from the visitor's own tap or click — never
     from hover. The one other route in is keyboard focus landing on one of
     its buttons, since otherwise Tab would walk onto invisible controls; so
     focusin has to know whether a keyboard actually put focus there.
     :focus-visible isn't reliable enough for that here: on iOS a tapped
     button doesn't take focus, so after typing in the Modify sheet's size
     field and tapping the bar's Save, the focus returned to a row's Modify
     button still counts as :focus-visible (inherited from the text field),
     and the row would pop open on its own. Tracking the last input is
     exact. Capture phase, so nothing that stops propagation can hide an
     event from it. */
  var lastInputWasKeyboard = false;
  document.addEventListener("keydown", function () { lastInputWasKeyboard = true; }, true);
  document.addEventListener("pointerdown", function () { lastInputWasKeyboard = false; }, true);

  function create(options) {
    var listEl = options.listEl;
    var rowClass = options.rowClass || "";
    var showPrice = !!options.showPrice;
    var useMenus = !!options.closeOnOutsideClick;

    /* ---- overlay: one open at a time ------------------------------------ */
    var openRowPanel = null;

    function closeOpenRow() {
      if (!openRowPanel) return;
      var panel = openRowPanel;
      openRowPanel = null;
      panel.root.classList.remove("is-open");
      if (useMenus && global.EmjiveMenus) global.EmjiveMenus.closed(panel);
    }

    function openRowOverlay(li) {
      if (openRowPanel && openRowPanel.root === li) return;
      closeOpenRow();
      li.classList.add("is-open");
      openRowPanel = { root: li, close: closeOpenRow };
      if (useMenus && global.EmjiveMenus) global.EmjiveMenus.opened(openRowPanel);
    }

    /* ---- undo ------------------------------------------------------------
       Unselecting a row crossfades its own content into an "Undo" prompt in
       place (css/style.css's .order-item__undo-prompt — same inset: 0
       crossfade recipe .order-item__overlay already uses, so the row never
       resizes) rather than collapsing it and showing a separate shared bar
       elsewhere. Every row tracks its own undo window independently, so
       unselecting several in a row leaves each showing its own prompt —
       deliberately: a row's own removal never causes any *other* row to
       move while it's pending, and each row only ever plays exactly one
       motion of its own (crossfade in place, then — only if its own window
       runs out unused — its final collapse). No shared stack, no shared
       timer, no bar to reuse or reposition.

       rowBindings mirrors listEl's children in order, one entry per row:
       { li, item, index, pending, timer, undoBtn }. index is kept live —
       shiftIndices below adjusts every other binding's index whenever one
       row's item is actually removed from or reinserted into storage — so
       each row always knows its own true current position, however many
       other rows are simultaneously mid-undo and regardless of which one
       gets confirmed or undone first. */
    var rowBindings = [];
    var mutating = false;

    // Unselect and Undo change storage, and storage dispatches
    // "emjive:selection-changed" synchronously — so a listener that
    // rebuilds rows on that event (the bar's drawer) would wipe the very
    // row that's showing its Undo prompt. isMutating() lets it tell its own
    // rows' changes apart from anyone else's.
    function mutate(fn) {
      mutating = true;
      try { fn(); } finally { mutating = false; }
    }

    // Called right after binding's own item is actually removed from (delta
    // -1) or reinserted into (delta 1) storage, at fromIndex — updates every
    // *other* binding still tracked so their own .index stays correct
    // without needing a full rebuild. binding itself is excluded: its index
    // already equals fromIndex (that's the position being mutated) and
    // doesn't need adjusting against its own change.
    function shiftIndices(binding, fromIndex, delta) {
      rowBindings.forEach(function (b) {
        if (b === binding) return;
        if (delta < 0 ? b.index > fromIndex : b.index >= fromIndex) {
          b.index += delta;
        }
      });
    }

    // Unselect click: removed from storage immediately (nothing about this
    // row is "soft" from storage's point of view), but the row itself just
    // crossfades to its own undo prompt in place rather than leaving the
    // DOM. pending is set BEFORE the removal, not after: the removal's
    // synchronous change event is what the drawer reacts to, and it checks
    // hasPending() to decide whether an empty cart should close it.
    // undoBtn.focus() carries keyboard focus along with the crossfade,
    // since the button it was on a moment ago (Unselect, inside
    // .order-item__overlay) is about to become invisible.
    function handleUnselect(binding) {
      binding.pending = true;
      binding.li.classList.add("is-pending-undo");
      mutate(function () { global.EmjiveSelection.removeItem(binding.index); });
      shiftIndices(binding, binding.index, -1);
      if (options.onChange) options.onChange();
      binding.undoBtn.focus();
      binding.timer = setTimeout(function () {
        binding.timer = null;
        confirmRemoval(binding);
      }, UNDO_TIMEOUT_MS);
    }

    // Undo click: reinserts at binding's own current index (kept accurate by
    // shiftIndices regardless of what's happened to any other row in the
    // meantime) and crossfades straight back — .order-item__content was
    // never rebuilt or removed, only hidden, so there's nothing to reload or
    // reanimate in. Also drops is-open, which the Unselect click
    // deliberately left in place (see its own comment) — while pending,
    // is-pending-undo wins over it in css/style.css regardless, but once
    // pending clears it'd otherwise fall straight back to is-open's own
    // state (the Modify/Unselect overlay) instead of the plain row.
    function handleUndo(binding) {
      if (!binding.pending) return;
      if (binding.timer) {
        clearTimeout(binding.timer);
        binding.timer = null;
      }
      mutate(function () { global.EmjiveSelection.insertItem(binding.index, binding.item); });
      shiftIndices(binding, binding.index, 1);
      binding.pending = false;
      binding.li.classList.remove("is-pending-undo", "is-open");
      if (options.onChange) options.onChange();
    }

    // binding's own window ran out unused. Its item is already gone from
    // storage (removed back when Unselect was first clicked) — this only
    // ever touches the DOM, and only in one of two ways: if this was the
    // last row standing, hand over to onEmptied (the order list crossfades
    // itself into its empty state, the drawer closes) with the row still in
    // place, so it leaves with the rest rather than collapsing on its own
    // first; otherwise, collapse-then-remove — genuinely a single motion for
    // this row, since nothing about it moved or resized while it was
    // pending.
    function confirmRemoval(binding) {
      var i = rowBindings.indexOf(binding);
      if (i === -1) return;
      rowBindings.splice(i, 1);

      if (!rowBindings.length) {
        if (options.onEmptied) options.onEmptied();
        return;
      }

      var li = binding.li;
      li.classList.add("is-removing");
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        li.remove();
        if (options.onRowRemoved) options.onRowRemoved();
      }
      li.addEventListener("transitionend", function onEnd(e) {
        if (e.propertyName !== "max-height") return;
        li.removeEventListener("transitionend", onEnd);
        finish();
      });
      // Fallback in case transitionend never fires (e.g. reduced-motion
      // environments that skip the transition outright) — same 400ms
      // backstop js/selection-bar.js's own icon-collapse animation uses.
      setTimeout(finish, 400);
    }

    // binding: { item, index, ... } — see the "undo" section above for the
    // rest of its fields, filled in here (li, undoBtn) and by
    // handleUnselect/handleUndo/confirmRemoval as the row's own undo window
    // plays out.
    function buildRow(binding) {
      var item = binding.item;
      var li = document.createElement("li");
      li.className = "order-item" + (rowClass ? " " + rowClass : "");
      binding.li = li;

      var content = document.createElement("div");
      content.className = "order-item__content";

      var thumb = document.createElement("img");
      thumb.className = "order-item__thumb";
      if (item.image) thumb.src = item.image;
      thumb.alt = "";

      var meta = document.createElement("div");
      meta.className = "order-item__meta";
      var name = document.createElement("span");
      name.className = "order-item__name";
      name.textContent = item.name;
      var attrs = document.createElement("span");
      attrs.className = "order-item__attrs";
      attrs.textContent = "." + item.category + "." + item.metal + ".";
      global.EmjiveSelection.appendSize(attrs, item.size);
      // No space between them either — the two read as one continuous label
      // (the period already reads as a separator) rather than two chips with
      // any gap, flex or otherwise, between them.
      meta.appendChild(name);
      meta.appendChild(attrs);

      content.appendChild(thumb);
      content.appendChild(meta);

      if (showPrice) {
        var price = document.createElement("span");
        price.className = "order-item__price";
        price.textContent = global.EmjiveSelection.formatPrice(item.price);
        content.appendChild(price);
      }

      var overlay = document.createElement("div");
      overlay.className = "order-item__overlay";

      var modifyBtn = document.createElement("button");
      modifyBtn.type = "button";
      modifyBtn.className = "order-item__overlay-btn";
      modifyBtn.dataset.action = "modify";
      modifyBtn.textContent = "Modify";
      modifyBtn.addEventListener("click", function () {
        closeOpenRow();
        if (options.onModify) options.onModify(binding);
      });

      var unselectBtn = document.createElement("button");
      unselectBtn.type = "button";
      unselectBtn.className = "order-item__overlay-btn";
      unselectBtn.dataset.action = "unselect";
      unselectBtn.textContent = "Unselect";
      unselectBtn.addEventListener("click", function () {
        // Clears the open-row bookkeeping directly, without going through
        // closeOpenRow() — that would also revert the overlay/content
        // crossfade an instant before the undo prompt crossfades in, where
        // leaving "is-open" alone lets that be one continuous swap instead
        // (.is-pending-undo wins over .is-open in css/style.css regardless).
        if (openRowPanel && openRowPanel.root === li) {
          if (useMenus && global.EmjiveMenus) global.EmjiveMenus.closed(openRowPanel);
          openRowPanel = null;
        }
        handleUnselect(binding);
      });

      overlay.appendChild(modifyBtn);
      overlay.appendChild(unselectBtn);

      // ---- undo prompt: swapped in for content/overlay while pending, in
      // place — see css/style.css's .order-item__undo-prompt and the "undo"
      // section above. Deliberately just the button, nothing else.
      var undoPrompt = document.createElement("div");
      undoPrompt.className = "order-item__undo-prompt";
      var undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "order-item__undo-btn";
      undoBtn.textContent = "Undo";
      undoBtn.addEventListener("click", function () { handleUndo(binding); });
      undoPrompt.appendChild(undoBtn);
      binding.undoBtn = undoBtn;

      // Wrapped rather than appended straight to li — see .order-item__inner
      // in css/style.css: this is what carries the max-height/overflow
      // removal-animation clipping, kept off .order-item itself so it never
      // clips ::before's own full-bleed invert band.
      var inner = document.createElement("div");
      inner.className = "order-item__inner";
      inner.appendChild(content);
      inner.appendChild(overlay);
      inner.appendChild(undoPrompt);
      li.appendChild(inner);

      // Keyboard only (see lastInputWasKeyboard above), both ways: focus
      // tabbing in opens the overlay, tabbing out closes it. focusin/
      // focusout rather than focus/blur because they bubble, so this can be
      // delegated once on the row instead of on each button.
      // The focusout side has to be keyboard-only too, not just the
      // focusin: pressing Modify/Unselect with a mouse (or a tap, on Android
      // Chrome) focuses the button on pointerdown, and with product.html's
      // size sheet open its focus trap pulls that focus straight back — a
      // focusout that closed the overlay then would make the button
      // pointer-events: none before the pointerup, and the click would land
      // on the row instead of the button. A pointer closes a row by
      // tapping it again, tapping another one, or clicking away.
      li.addEventListener("focusin", function () {
        if (lastInputWasKeyboard && !binding.pending) openRowOverlay(li);
      });
      li.addEventListener("focusout", function (e) {
        if (lastInputWasKeyboard && !li.contains(e.relatedTarget)) closeOpenRow();
      });
      // The row's one real trigger: a tap or click opens the overlay. A
      // click on Modify/Unselect/Undo themselves is excluded — those
      // already handle themselves — but once open, a click anywhere else on
      // the row (the overlay's own empty space, since it covers
      // .order-item__content entirely) closes it back to the normal view
      // rather than being ignored, a way to back out without picking
      // either action.
      // The undoBtn exclusion isn't just belt-and-suspenders: handleUndo
      // (fired by undoBtn's own listener first, same event, before it
      // bubbles here) already flips binding.pending back to false
      // synchronously, so by the time this handler runs the leading
      // `if (binding.pending) return;` below no longer catches an Undo
      // click — without also matching the button itself here, that click
      // would fall through and immediately reopen the Modify/Unselect
      // overlay on the row it just restored.
      li.addEventListener("click", function (e) {
        if (e.target.closest(".order-item__overlay-btn, .order-item__undo-btn")) return;
        if (binding.pending) return;
        if (li.classList.contains("is-open")) {
          closeOpenRow();
        } else {
          openRowOverlay(li);
        }
      });

      return li;
    }

    // Full rebuild from `items`. Any row still mid-undo has its timer
    // cleared first and simply isn't rebuilt: its item is already gone from
    // storage, so its grace period ends early, silently. Only happens when
    // something other than these rows changed the selection while one was
    // pending (a Modify confirmed on another row) — rare enough not to be
    // worth carrying mid-flight state across the rebuild.
    function render(items) {
      closeOpenRow();
      rowBindings.forEach(function (b) {
        if (b.timer) clearTimeout(b.timer);
      });
      listEl.innerHTML = "";
      rowBindings = items.map(function (item, index) {
        return { item: item, index: index, pending: false, timer: null };
      });
      rowBindings.forEach(function (binding) {
        listEl.appendChild(buildRow(binding));
      });
    }

    return {
      render: render,
      closeOpenRow: closeOpenRow,
      hasPending: function () {
        return rowBindings.some(function (b) { return b.pending; });
      },
      isMutating: function () { return mutating; }
    };
  }

  global.EmjiveOrderRows = { create: create };
})(window);
