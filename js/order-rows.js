// Item rows shared by launch-order.html's list and the floating bar's drawer.
// A row shows its item's picture (stacked for a count above one), label,
// count (at the label's right end, over its fade) and price. A tap puts the
// row in query mode: a − count + stepper where the label starts, Modify at
// its right end, a close cross over the price. Changing the count swaps
// Modify and the cross for Save, which turns into Remove at 0; a Remove holds
// the row as an Undo line for UNDO_MS. Modify opens the Modify sheet
// (js/modify-modal.js), whose strip then covers the row (stripHost) until the
// row comes back: as it was after a Save, in query mode after the back arrow. Rows follow the selection one change at
// a time: an update crossfades the changed parts, a removal collapses the row
// (or holds it as the Undo line), an Undo brings it back.
//
// window.EmjiveOrderRows.create(options) -> { render(items, { animate, change }),
//   preview(index, values), settledHeight(), buttonAt(index), rowAt(index),
//   isHolding(), endQuery(), stripHost(index) }
//   render()     change: the "emjive:selection-changed" detail, which tells a
//                merge's removed row from its twin
//   preview()    the Modify sheet's live draft, no fade (null: back to the stored item)
//   buttonAt()   where focus returns for the row at `index`: its query mode's
//                Modify while in query mode, else the row
//   isHolding()  an Undo line is held or pending: the list isn't empty yet
//   endQuery()   the row in query mode goes back to normal, its count dropped
//   stripHost()  where the Modify sheet's strip goes for the row at `index`:
//                { el, show(strip), hide(strip, saved) }; hide() brings the
//                row back, out of query mode after a Save, in it otherwise
// options:
//   listEl             the <ul>
//   rowClass           extra class on every <li>
//   showPrice          show each row's price (times its count)
//   queryable          false: a tap does nothing (launch-order's copy of a row)
//   onModify(binding)  Modify was pressed (binding.item, binding.index, binding.li)
//   newestFirst        latest item on top; indexes still follow the selection
//   dropAtOnce         a dropped Undo line leaves at once instead of collapsing
//                      (the drawer measures the tapped row's place right after)
//   onResize()         the list's height changes; on an Undo, called at full
//                      size before the expansion plays, then after
//   onUndoGone()       an Undo line has gone (the removal stood, or was undone)
//   fallbackFocus      element or function: where focus goes when its row is gone

(function (global) {
  "use strict";

  // Backstops for a missing transitionend (background tab): past the 0.3s
  // collapse/expand and the 0.12s swap fade-out (css/style.css).
  var ROW_MOTION_MS = 400;
  var SWAP_OUT_MS = 170;
  // How long a crossfading icon waits for its new picture before swapping anyway.
  var DECODE_WAIT_MS = 1000;
  // The Undo offer's length, from the removal, regardless of focus or pointer.
  var UNDO_MS = 2000;

  var H = global.EmjiveHelpers;
  var el = H.el;
  var transitionDone = H.transitionDone;

  // An element, or a function returning one.
  function resolve(want) {
    return typeof want === "function" ? want() : want;
  }

  // Quiet after a tap, like the sheets' focus return.
  function focusQuietly(target) {
    if (!target) return;
    if (global.EmjiveFocusTrap) global.EmjiveFocusTrap.focus(target);
    else target.focus();
  }

  // Fully decoded, so a crossfade never shows an empty frame.
  function decoded(src) {
    if (!src) return null;
    var img = new Image();
    img.src = src;
    var ready = img.decode ? img.decode().catch(function () {}) : null;
    return Promise.race([ready, H.wait(DECODE_WAIT_MS)]);
  }

  // Sequential swap: fade out (.is-swapping), apply(), fade in, so two values
  // never overlap. `ready` holds the swap (an icon decoding); a newer swap on
  // the same element wins.
  var swapTokens = new WeakMap();

  function fadeSwap(node, apply, ready) {
    var token = (swapTokens.get(node) || 0) + 1;
    swapTokens.set(node, token);
    node.classList.add("is-swapping");
    Promise.all([transitionDone(node, "opacity", SWAP_OUT_MS), ready]).then(function () {
      if (swapTokens.get(node) !== token) return;
      apply();
      node.classList.remove("is-swapping");
    });
  }

  // Rows show the icon's 128px variant.
  var thumbSrc = H.thumbSrc;
  var resampleBand = H.resampleBand;

  // No-fade change for a live preview; cancels any fadeSwap under way on `node`.
  function setNow(node, apply) {
    swapTokens.set(node, (swapTokens.get(node) || 0) + 1);
    node.classList.remove("is-swapping");
    apply();
  }

  function create(options) {
    var listEl = options.listEl;
    var rowClass = options.rowClass || "";
    var showPrice = !!options.showPrice;
    var queryable = options.queryable !== false;
    var dropAtOnce = !!options.dropAtOnce;
    var newestFirst = !!options.newestFirst;
    var sel = global.EmjiveSelection;

    // The element the row at `index` goes before (null: the end); the list is
    // reversed when newestFirst.
    function slotFor(index) {
      var neighbour = bindings[newestFirst ? index - 1 : index];
      return neighbour ? neighbour.li : null;
    }

    // Rows in the list, in order: { item, shown, index, li, inner, button,
    // thumb, name, attrs, count, price, query }. A collapsing row has already
    // left, so indexes match storage.
    var bindings = [];
    // The Undo line requested but not yet answered (offerUndo() precedes the
    // removal render() answers), and the one held: { index, handlers, state:
    // "pending" | "held" | "leaving" | "done", binding, line }.
    var pendingHold = null;
    var held = null;
    // The row in query mode: { binding, stored, draft } (the stored count and
    // the stepper's), or null.
    var query = null;
    // While a removed item's Undo is offered: { item, index, handle, timer }.
    var undoState = null;

    function resize() {
      if (options.onResize) options.onResize();
    }

    function fillAttrs(node, item) {
      node.textContent = "." + item.category + "." + item.metal + ".";
      sel.appendSize(node, item.size);
    }

    // The label keeps room at its end for the count (.has-count, --count-chars),
    // so scrolled to its end it stops short of it.
    function fillCount(node, item) {
      var count = sel.countOf(item);
      var text = count > 1 ? "x" + count : "";
      node.textContent = text;
      node.hidden = !text;
      node.parentNode.classList.toggle("has-count", !!text);
      node.parentNode.style.setProperty("--count-chars", text.length);
    }

    // The visible label is a dotted string, so the button gets a plain spoken name.
    function spokenLabel(item) {
      var count = sel.countOf(item);
      return "Change " + item.name + ", " + item.metal + ", size " + String(parseFloat(item.size)) +
        (count > 1 ? ", " + count + " pieces" : "");
    }

    function buildRow(item) {
      // shown: what the row displays (a preview may be over the stored item).
      var binding = { item: item, shown: item, index: -1, query: null };

      var li = el("li", "order-item" + (rowClass ? " " + rowClass : ""));

      // One <button> wrapping the whole row, hence spans throughout.
      var button = el("button", "order-item__content");
      button.type = "button";
      button.setAttribute("aria-label", spokenLabel(item));

      var thumb = H.thumbStack("order-item__thumb");
      thumb.set(item.image, sel.countOf(item));
      // A picture arriving under the band: see resampleBand(). load doesn't
      // bubble, hence the capture.
      thumb.el.addEventListener("load", function () { resampleBand(li); }, true);

      // The text: the label, scrolling sideways with its fades, and the count
      // laid over its right end.
      var text = el("span", "order-item__text");
      var meta = el("span", "order-item__meta edge-scroll");
      H.edgeFades(meta);
      var name = el("span", "order-item__name", item.name);
      var attrs = el("span", "order-item__attrs");
      fillAttrs(attrs, item);
      // No space between name and attrs: they read as one label.
      meta.appendChild(name);
      meta.appendChild(attrs);
      var count = el("span", "order-item__count");
      text.appendChild(meta);
      text.appendChild(count);
      fillCount(count, item);

      button.appendChild(thumb.el);
      button.appendChild(text);

      var price = null;
      if (showPrice) {
        price = el("span", "order-item__price", sel.formatPrice(sel.linePrice(item)));
        button.appendChild(price);
      }

      // .order-item__inner clips the collapse/expand, so .order-item doesn't clip its ::before band.
      var inner = el("div", "order-item__inner");
      inner.appendChild(button);
      li.appendChild(inner);

      // Anywhere on the row; the button's own click (and Enter/Space) bubbles
      // here. The query controls' and the strip's clicks bubble too, and are
      // theirs: a cross or Save that just ended query mode mustn't restart it.
      li.addEventListener("click", function (e) {
        if (!queryable || bindings.indexOf(binding) === -1) return;
        if (query && query.binding === binding) return;
        var target = e.target;
        if (binding.query && binding.query.layer.contains(target)) return;
        if (target.closest && target.closest(".modify-strip")) return;
        enterQuery(binding);
      });

      binding.li = li;
      binding.inner = inner;
      binding.button = button;
      binding.thumb = thumb;
      binding.name = name;
      binding.attrs = attrs;
      binding.count = count;
      binding.price = price;
      return binding;
    }

    // Crossfades only the parts that changed (picture, label, count, price);
    // `instant` for previews. Compared with what the row shows, so a Save
    // after a preview has nothing left to swap.
    function crossfadeRow(binding, item, instant) {
      var old = binding.shown;
      var swap = instant ? setNow : fadeSwap;
      var oldCount = sel.countOf(old);
      var count = sel.countOf(item);
      binding.shown = item;
      binding.button.setAttribute("aria-label", spokenLabel(item));
      var newImage = (old.image || "") !== (item.image || "");
      if (newImage || oldCount !== count) {
        swap(binding.thumb.el, function () {
          binding.thumb.set(item.image, count);
        }, instant || !newImage ? null : decoded(thumbSrc(item.image)));
      }
      if (old.name !== item.name) {
        swap(binding.name, function () { binding.name.textContent = item.name; });
      }
      if (old.category !== item.category || old.metal !== item.metal || String(old.size) !== String(item.size)) {
        swap(binding.attrs, function () { fillAttrs(binding.attrs, item); });
      }
      if (oldCount !== count) {
        swap(binding.count, function () { fillCount(binding.count, item); });
      }
      if (binding.price && sel.linePrice(old) !== sel.linePrice(item)) {
        swap(binding.price, function () {
          binding.price.textContent = sel.formatPrice(sel.linePrice(item));
        });
      }
    }

    // Every row against its item: after a removal or insertion, a merge's
    // surviving row has a new count.
    function crossfadeAll(items) {
      bindings.forEach(function (binding, i) { crossfadeRow(binding, items[i]); });
    }

    /* ---- query mode ----
       The controls are a layer over the row (.order-item__query), built on
       the row's first query and kept, inert while out of query mode. Its
       columns follow the row's: the picture's (empty), the text's (the
       stepper at its start) and a fixed one about a price wide (the cross),
       with Modify, Save or Remove centred between + and the cross. The row's
       content fades and goes inert while it shows (.is-query). */

    // − and + drawn, not typed: a glyph sits on the font's math axis, off the
    // strip's middle. In the cross's stroke (EmjiveHelpers.ICON_CLOSE).
    var ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M0 12 H24" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    var ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 0 V24 M0 12 H24" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

    function queryButton(className, label, spoken) {
      var btn = el("button", "order-item__q " + className);
      btn.type = "button";
      if (label) btn.appendChild(el("span", "order-item__q-label", label));
      if (spoken) btn.setAttribute("aria-label", spoken);
      return btn;
    }

    function buildQuery(binding) {
      var layer = el("div", "order-item__query");
      layer.setAttribute("role", "group");
      layer.inert = true;
      var box = el("div", "order-item__query-box");

      // Modify, Save and Remove share one place, crossfading.
      var actions = el("span", "order-item__q-actions");
      var modify = queryButton("order-item__q-modify", "Modify");
      var save = queryButton("order-item__q-save", "Save");
      var remove = queryButton("order-item__q-remove", "Remove");
      actions.appendChild(modify);
      actions.appendChild(save);
      actions.appendChild(remove);

      var stepper = el("span", "order-item__stepper");
      var minus = queryButton("order-item__q-step order-item__q-minus", null, "One fewer");
      minus.insertAdjacentHTML("afterbegin", ICON_MINUS);
      var count = el("span", "order-item__q-count");
      count.setAttribute("aria-live", "polite");
      count.setAttribute("aria-atomic", "true");
      var plus = queryButton("order-item__q-step", null, "One more");
      plus.insertAdjacentHTML("afterbegin", ICON_PLUS);
      stepper.appendChild(minus);
      stepper.appendChild(count);
      stepper.appendChild(plus);

      var textCol = el("span", "order-item__q-text");
      textCol.appendChild(stepper);

      var priceCol = el("span", "order-item__q-price");
      var close = queryButton("order-item__q-close", null, "Close");
      close.insertAdjacentHTML("afterbegin", H.ICON_CLOSE);
      priceCol.appendChild(close);

      box.appendChild(textCol);
      box.appendChild(priceCol);
      box.appendChild(actions);
      layer.appendChild(box);

      minus.addEventListener("click", function () { stepDraft(-1); });
      plus.addEventListener("click", function () { stepDraft(1); });
      save.addEventListener("click", saveCount);
      remove.addEventListener("click", saveCount);
      close.addEventListener("click", function () { endQuery(true); });
      modify.addEventListener("click", function () {
        if (!query || query.binding !== binding) return;
        // The drawer measures the row right after: a held line goes first.
        dropUndo();
        if (options.onModify) options.onModify(binding);
      });

      return {
        layer: layer, box: box, minus: minus, count: count, plus: plus,
        actions: actions, modify: modify, save: save, remove: remove, close: close
      };
    }

    // A tap outside the row ends query mode; not while the Modify sheet is up
    // (its backdrop and the strip's row are elsewhere).
    function onOutsidePointer(e) {
      if (!query) return;
      if (global.EmjiveModifyModal && global.EmjiveModifyModal.isOpen()) return;
      var target = e.target;
      if (query.binding.li.contains(target)) return;
      if (target.closest && target.closest("#modifyModal")) return;
      endQuery(false);
    }

    // Escape ends query mode, wherever focus is. Captured, so the drawer
    // around the row (js/series.js) stays open; the Modify sheet's own Escape
    // goes first while it is up.
    function onEscapeKey(e) {
      if (e.key !== "Escape" || !query) return;
      if (global.EmjiveModifyModal && global.EmjiveModifyModal.isOpen()) return;
      e.stopPropagation();
      endQuery(true);
    }

    function enterQuery(binding) {
      endQuery(false);
      if (!binding.query) {
        binding.query = buildQuery(binding);
        binding.li.appendChild(binding.query.layer);
      }
      var stored = sel.countOf(binding.item);
      query = { binding: binding, stored: stored, draft: stored };
      binding.query.layer.setAttribute("aria-label", binding.item.name);
      syncQuery();
      binding.inner.inert = true;
      binding.query.layer.inert = false;
      // Laid out before .is-query lands, so the layer fades in.
      void binding.li.offsetWidth;
      binding.li.classList.add("is-query");
      focusQuietly(binding.query.plus);
      document.addEventListener("pointerdown", onOutsidePointer, true);
      document.addEventListener("keydown", onEscapeKey, true);
      window.addEventListener("resize", onQueryResize);
    }

    // Modify, Save and Remove centred between the + and the cross's drawings,
    // which the grid can't express (the count's width moves +): measured, and
    // set as --actions-x on the layer's box.
    function placeActions() {
      var parts = query.binding.query;
      var from = parts.plus.firstElementChild.getBoundingClientRect().right;
      var to = parts.close.firstElementChild.getBoundingClientRect().left;
      var box = parts.box.getBoundingClientRect();
      parts.box.style.setProperty("--actions-x", ((from + to) / 2 - box.left) + "px");
    }

    function onQueryResize() {
      if (query) placeActions();
    }

    // focusRow: focus moves to the row's button if it was in the row (the
    // controls, the strip) or nowhere.
    function endQuery(focusRow) {
      if (!query) return;
      var binding = query.binding;
      query = null;
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("keydown", onEscapeKey, true);
      window.removeEventListener("resize", onQueryResize);
      var active = document.activeElement;
      var hadFocus = !active || active === document.body || binding.li.contains(active);
      binding.li.classList.remove("is-query", "is-count-changed", "is-hosting");
      if (binding.query) binding.query.layer.inert = true;
      binding.inner.inert = false;
      if (focusRow && hadFocus && bindings.indexOf(binding) !== -1) focusQuietly(binding.button);
    }

    function stepDraft(delta) {
      if (!query) return;
      query.draft = Math.max(0, query.draft + delta);
      syncQuery();
    }

    // The stepper's count; Modify and the cross give way to Save once it
    // differs from the stored count, Save to Remove at 0 (.is-count-zero),
    // where − goes.
    function syncQuery() {
      var parts = query.binding.query;
      var changed = query.draft !== query.stored;
      var zero = query.draft <= 0;
      parts.count.textContent = String(query.draft);
      // Focus on − (or on Save, swapped for Remove) moves on rather than drop.
      var active = document.activeElement;
      parts.minus.disabled = zero;
      query.binding.li.classList.toggle("is-count-changed", changed);
      query.binding.li.classList.toggle("is-count-zero", zero);
      parts.modify.inert = changed;
      parts.close.inert = changed;
      parts.save.inert = !changed || zero;
      parts.remove.inert = !zero;
      // The count's width moves +.
      placeActions();
      if (zero && active === parts.minus) focusQuietly(parts.plus);
      else if (zero && active === parts.save) focusQuietly(parts.remove);
      else if (!zero && active === parts.remove) focusQuietly(parts.save);
    }

    function saveCount() {
      if (!query || query.draft === query.stored) return;
      var binding = query.binding;
      var draft = query.draft;
      if (draft <= 0) {
        removeAt(binding);
        return;
      }
      endQuery(true);
      sel.updateItem(binding.index, { count: draft });
    }

    // The Modify sheet's strip over the row. Its band and the row's are alike
    // and both invert, so one stands in for the other: arriving, the row's
    // content or controls fade (.is-hosting), then the strip's band replaces
    // the row's and its labels fade in. Leaving (.is-unhosting), on the
    // strip's band: after a Save the labels fade out, then the row's content
    // fades in, out of query mode (.is-unhost-saved); after the back arrow the
    // labels crossfade into the controls, still in query mode. Then the row's
    // band takes back over at once.
    var UNHOST_MS = 800;

    function stripHost(index) {
      var binding = bindings[index];
      if (!binding) return null;
      return {
        el: binding.li,
        show: function (strip) {
          binding.unhostToken = (binding.unhostToken || 0) + 1;
          binding.li.classList.remove("is-unhosting", "is-unhost-saved");
          binding.li.classList.add("is-hosting");
          if (binding.query) binding.query.layer.inert = true;
          strip.classList.remove("is-hidden", "is-leaving");
          strip.setAttribute("aria-hidden", "false");
          strip.inert = false;
        },
        hide: function (strip, saved) {
          var li = binding.li;
          var token = (binding.unhostToken || 0) + 1;
          binding.unhostToken = token;
          strip.classList.add("is-leaving");
          strip.setAttribute("aria-hidden", "true");
          strip.inert = true;
          li.classList.add("is-unhosting");
          li.classList.toggle("is-unhost-saved", !!saved);
          li.classList.remove("is-hosting");
          var inQuery = query && query.binding === binding;
          if (inQuery && saved) endQuery(true);
          else if (inQuery) binding.query.layer.inert = false;
          var arriving = inQuery && !saved ? binding.query.layer : binding.inner;
          transitionDone(arriving, "opacity", UNHOST_MS).then(function () {
            if (binding.unhostToken !== token) return;
            // In one frame, the bands swap back with no transition.
            li.classList.add("is-instant");
            li.classList.remove("is-unhosting", "is-unhost-saved");
            if (strip.parentNode === li) {
              strip.classList.add("is-hidden");
              strip.classList.remove("is-leaving");
            }
            void li.offsetWidth;
            li.classList.remove("is-instant");
          });
        }
      };
    }
    /* ---- removal (a count saved at 0) and Undo ----
       Removed from storage at once; the Undo line is requested before the
       removal, which render() answers by keeping the row. Focus moves to the
       line's Undo button. */

    function removeAt(binding) {
      var index = binding.index;
      var removed = sel.getSelection()[index];
      if (!removed) return;
      endQuery(false);
      var handle = offerUndo(index, {
        onUndo: undo,
        onGone: function () {
          forgetUndo(handle);
          if (options.onUndoGone) options.onUndoGone();
        }
      });
      sel.removeItem(index);
      if (!handle.held()) {
        focusQuietly(resolve(options.fallbackFocus));
        return;
      }
      undoState = {
        item: removed,
        index: index,
        handle: handle,
        timer: setTimeout(expireUndo, UNDO_MS)
      };
      focusQuietly(handle.button());
    }

    // Back at its index, clamped if the list shrank; render() revives the held line.
    function undo() {
      var pending = undoState;
      if (!pending) return;
      clearTimeout(pending.timer);
      undoState = null;
      var at = Math.min(pending.index, sel.getSelection().length);
      sel.insertItem(at, pending.item);
      focusQuietly((bindings[at] && bindings[at].button) || resolve(options.fallbackFocus));
    }

    // The list dropped the held line itself (a rebuild, a newer removal): it stands.
    function forgetUndo(handle) {
      if (!undoState || undoState.handle !== handle) return;
      clearTimeout(undoState.timer);
      undoState = null;
    }

    // The offer ran out (or, immediate, the page is leaving): the line closes
    // and focus, if on Undo, goes to the fallback.
    function expireUndo(immediate) {
      var pending = undoState;
      if (!pending) return;
      clearTimeout(pending.timer);
      undoState = null;
      var hadFocus = pending.handle.button() === document.activeElement;
      if (immediate === true) {
        pending.handle.drop();
        return;
      }
      pending.handle.leave(function () {
        if (hadFocus) focusQuietly(resolve(options.fallbackFocus));
      });
    }

    // A Modify opening during the offer: the removal stands.
    function dropUndo() {
      var pending = undoState;
      if (!pending) return;
      clearTimeout(pending.timer);
      undoState = null;
      pending.handle.drop();
    }

    // Leaving: a bfcache page comes back without the offer.
    global.addEventListener("pagehide", function () {
      endQuery(false);
      expireUndo(true);
    });

    // Rows mid-motion, for settledHeight(): collapsing (already out of bindings)
    // and expanding, each with its target height.
    var collapsing = [];
    var expanding = [];

    // A rebuild may have cleared the list under a running motion.
    function forget(list, binding) {
      var i = list.indexOf(binding);
      if (i !== -1) list.splice(i, 1);
    }

    function collapse(binding, done) {
      collapsing.push(binding);
      binding.li.classList.add("is-removing");
      // Waits for the collapse (max-height) and the band's later fade (::before
      // opacity, reported on the li).
      Promise.all([
        transitionDone(binding.inner, "max-height", ROW_MOTION_MS),
        transitionDone(binding.li, "opacity", ROW_MOTION_MS)
      ]).then(function () {
        forget(collapsing, binding);
        binding.li.remove();
        resize();
        if (done) done();
      });
    }

    /* ---- the Undo line ---- */

    function buildUndoLine(h) {
      var wrap = el("div", "order-item__undo");
      var button = el("button", "order-item__undo-button");
      button.type = "button";
      button.appendChild(el("span", "order-item__undo-label", "Undo"));
      var band = el("span", "order-item__undo-band");
      band.setAttribute("aria-hidden", "true");
      wrap.appendChild(button);
      wrap.appendChild(band);
      button.addEventListener("click", function (e) {
        e.stopPropagation();
        if (h.state === "held" && h.handlers.onUndo) h.handlers.onUndo();
      });
      return { wrap: wrap, button: button, band: band };
    }

    // The row stays, content inert; the line is laid out before .is-undo lands,
    // so there is a state to transition from.
    function hold(h, binding) {
      h.state = "held";
      h.binding = binding;
      h.line = buildUndoLine(h);
      held = h;
      binding.inner.inert = true;
      binding.li.appendChild(h.line.wrap);
      void binding.li.offsetWidth;
      binding.li.classList.add("is-undo");
    }

    // The line is over: it collapses like a removed row, unless it is the list's last.
    function finishHold(h, done, atOnce) {
      if (h.state === "done") return;
      var wasPending = h.state === "pending";
      h.state = "done";
      if (pendingHold === h) pendingHold = null;
      if (held === h) held = null;
      if (wasPending) return;
      function end() {
        if (done) done();
        if (h.handlers.onGone) h.handlers.onGone();
      }
      if (atOnce) {
        h.binding.li.remove();
        resize();
        end();
      } else if (bindings.length) {
        collapse(h.binding, end);
      } else {
        end();
      }
    }

    // The offer ran out: the label goes, the band shrinks back, then the line closes.
    function leave(h, done) {
      if (h.state !== "held") return;
      h.state = "leaving";
      h.binding.li.classList.add("is-undo-leaving");
      transitionDone(h.line.band, "width", ROW_MOTION_MS).then(function () {
        if (h.state === "leaving") finishHold(h, done);
      });
    }

    // Undo: the held line becomes the row again (CSS transitions), then the line is removed.
    function revive(h, items, index) {
      var binding = h.binding;
      var li = binding.li;
      h.state = "done";
      held = null;
      // Re-inserting would reset the transition's start state; only move if needed.
      var next = slotFor(index);
      if (li.nextElementSibling !== next) listEl.insertBefore(li, next);
      bindings.splice(index, 0, binding);
      syncBindings(items);
      crossfadeRow(binding, items[index], true);
      binding.inner.inert = false;
      li.classList.remove("is-undo", "is-undo-leaving");
      li.classList.add("is-undo-revived");
      transitionDone(h.line.band, "opacity", 700).then(function () {
        li.classList.remove("is-undo-revived");
        h.line.wrap.remove();
        if (h.handlers.onGone) h.handlers.onGone();
      });
    }

    // The collapse in reverse: inserted at full size for onResize's measurement,
    // snapped shut (.is-instant) and opened on the next frame.
    function expand(binding) {
      var li = binding.li;
      binding.fullHeight = li.offsetHeight;
      expanding.push(binding);
      resize();
      li.classList.add("is-instant", "is-removing", "is-expanding");
      void li.offsetHeight;
      li.classList.remove("is-instant");
      requestAnimationFrame(function () {
        li.classList.remove("is-removing");
        transitionDone(binding.inner, "max-height", ROW_MOTION_MS).then(function () {
          forget(expanding, binding);
          li.classList.remove("is-expanding");
          resize();
        });
      });
    }

    // The list's height once current motions finish, for containers sized to it.
    function settledHeight() {
      var height = listEl.offsetHeight;
      collapsing.forEach(function (binding) { height -= binding.li.offsetHeight; });
      expanding.forEach(function (binding) { height += binding.fullHeight - binding.li.offsetHeight; });
      return height;
    }

    function syncBindings(items) {
      bindings.forEach(function (binding, i) {
        binding.index = i;
        binding.item = items[i];
      });
    }

    function rebuild(items) {
      endQuery(false);
      // A held line goes with the list; onGone deferred, as the caller may be mid-render.
      var swept = held;
      held = null;
      if (swept) {
        swept.state = "done";
        setTimeout(function () { if (swept.handlers.onGone) swept.handlers.onGone(); }, 0);
      }
      if (pendingHold) {
        pendingHold.state = "done";
        pendingHold = null;
      }
      listEl.innerHTML = "";
      collapsing = [];
      expanding = [];
      bindings = items.map(function (item) {
        var binding = buildRow(item);
        if (newestFirst) listEl.insertBefore(binding.li, listEl.firstChild);
        else listEl.appendChild(binding.li);
        return binding;
      });
      syncBindings(items);
    }

    // Query mode lasts while its row and stored count do.
    function checkQuery() {
      if (!query) return;
      if (bindings.indexOf(query.binding) === -1 || sel.countOf(query.binding.item) !== query.stored) endQuery(false);
    }

    // Without animate (first render, hidden list) it just rebuilds; otherwise
    // EmjiveSelection.singleChange picks the one row to animate, rebuilding when
    // the change isn't a single one. A merge names its removed row (keys alone
    // can't tell it from its twin).
    function render(items, opts) {
      var animate = !!(opts && opts.animate);
      var detail = opts && opts.change;
      var oldKeys = bindings.map(function (binding) { return sel.itemKey(binding.item); });
      var keys = items.map(sel.itemKey);

      // A Remove that asked for an Undo: its row stays as the line, even the last one.
      if (pendingHold) {
        var asked = pendingHold;
        pendingHold = null;
        var removal = animate && bindings.length ? sel.singleChange(oldKeys, keys) : null;
        if (removal && removal.type === "remove" && removal.index === asked.index) {
          hold(asked, bindings.splice(removal.index, 1)[0]);
          syncBindings(items);
          checkQuery();
          return;
        }
        asked.state = "done";
      }

      // An Undo: the held line is the row that comes back.
      if (held && animate) {
        var back = sel.singleChange(oldKeys, keys);
        if (back && back.type === "insert" && keys[back.index] === sel.itemKey(held.binding.item)) {
          revive(held, items, back.index);
          return;
        }
      }

      if (!animate || !items.length || !bindings.length) {
        rebuild(items);
        return;
      }

      var change = detail && detail.action === "merge" && bindings[detail.index] && keys.length === oldKeys.length - 1
        ? { type: "remove", index: detail.index }
        : sel.singleChange(oldKeys, keys);
      if (!change) {
        rebuild(items);
        return;
      }

      if (change.type === "update") {
        syncBindings(items);
        crossfadeAll(items);
      } else if (change.type === "remove") {
        collapse(bindings.splice(change.index, 1)[0]);
        syncBindings(items);
        crossfadeAll(items);
      } else {
        var binding = buildRow(items[change.index]);
        listEl.insertBefore(binding.li, slotFor(change.index));
        bindings.splice(change.index, 0, binding);
        syncBindings(items);
        crossfadeAll(items);
        expand(binding);
      }
      checkQuery();
    }

    // The row at `index` shows its item with `values` (metal, size, price,
    // image) over it, or the stored item for null. Storage untouched.
    function preview(index, values) {
      var binding = bindings[index];
      if (!binding) return;
      var item = binding.item;
      if (values) {
        item = {};
        Object.keys(binding.item).forEach(function (key) { item[key] = binding.item[key]; });
        Object.keys(values).forEach(function (key) { item[key] = values[key]; });
      }
      crossfadeRow(binding, item, true);
      resampleBand(binding.li);
    }

    function offerUndo(index, handlers) {
      if (held) finishHold(held);
      var h = { index: index, handlers: handlers || {}, state: "pending", binding: null, line: null };
      pendingHold = h;
      return {
        held: function () { return h.state === "held" || h.state === "leaving"; },
        button: function () { return h.line ? h.line.button : null; },
        leave: function (done) { leave(h, done); },
        drop: function () { finishHold(h, null, dropAtOnce); }
      };
    }

    return {
      render: render,
      preview: preview,
      isHolding: function () { return !!(pendingHold || held); },
      endQuery: function () { endQuery(false); },
      stripHost: stripHost,
      settledHeight: settledHeight,
      // Looked up late, as rows come and go.
      buttonAt: function (index) {
        var binding = bindings[index];
        if (!binding) return null;
        return query && query.binding === binding ? binding.query.modify : binding.button;
      },
      rowAt: function (index) {
        var binding = bindings[index];
        return binding ? binding.li : null;
      }
    };
  }

  /* ---- transient notice ----
     A bar sliding up from the bottom in place of alert() (unstyleable, and
     suppressed on iOS in some contexts). role="status"; hides after NOTICE_MS. */
  var NOTICE_MS = 6000;
  var noticeEl = null;
  var noticeTextEl = null;
  var noticeTimer = 0;

  // Bottom-anchored elements a notice rests on; the highest visible one wins.
  var REST_ON = ".selection-bar, .product-select-bar, .order-checkout-bar, .order-checkout-drawer, .size-modal__sheet";

  // The viewport height minus the highest visible top edge among them.
  function stackHeight() {
    var viewportHeight = window.innerHeight;
    var top = viewportHeight;
    var nodes = document.querySelectorAll(REST_ON);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.hidden) continue;
      var style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") continue;
      var rect = node.getBoundingClientRect();
      // Off screen or empty: not standing there.
      if (rect.height <= 0 || rect.top >= viewportHeight || rect.bottom <= 0) continue;
      if (rect.top < top) top = rect.top;
    }
    return Math.max(0, viewportHeight - top);
  }

  function notice(message) {
    if (!noticeEl) {
      noticeEl = document.createElement("div");
      noticeEl.className = "emjive-notice";
      noticeEl.setAttribute("role", "status");
      var bar = document.createElement("div");
      bar.className = "emjive-notice__bar";
      noticeTextEl = document.createElement("p");
      noticeTextEl.className = "emjive-notice__text";
      bar.appendChild(noticeTextEl);
      noticeEl.appendChild(bar);
      document.body.appendChild(noticeEl);
    }
    noticeTextEl.textContent = message;
    noticeEl.style.setProperty("--notice-rest", stackHeight() + "px");
    // A frame between placing and showing, so it slides in.
    requestAnimationFrame(function () { noticeEl.classList.add("is-shown"); });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { noticeEl.classList.remove("is-shown"); }, NOTICE_MS);
  }

  global.EmjiveOrderRows = { create: create, notice: notice };
})(window);
