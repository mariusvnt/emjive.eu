// Item rows shared by launch-order.html's list and the floating bar's drawer.
// A tap on a row opens the Modify sheet for its item. Rows follow the
// selection one change at a time: a Modify crossfades the changed parts, an
// Remove collapses the row (or holds it as an Undo line), an Undo brings
// it back.
//
// window.EmjiveOrderRows.create(options) -> { render(items, { animate }),
//   preview(index, values), settledHeight(), buttonAt(index),
//   offerUndo(index, handlers), isHolding() }
//   preview()    the Modify sheet's live draft, no fade (null: back to the stored item)
//   offerUndo()  call just before removing the item at `index`: its row stays
//                as an Undo line (.order-item__undo). handlers { onUndo(), onGone() }.
//                Returns { held(), button(), leave(done), drop() }: held() is
//                false if no line could be held; leave() runs the offer out;
//                drop() closes it at once. A list's last line leaves with the list.
//   isHolding()  a line is held or pending: the list isn't empty yet
// options:
//   listEl             the <ul>
//   rowClass           extra class on every <li>
//   showPrice          show each row's price
//   onModify(binding)  a row was tapped (binding.item, binding.index)
//   newestFirst        latest item on top; indexes still follow the selection
//   dropAtOnce         a dropped Undo line leaves at once instead of collapsing
//                      (the drawer measures the tapped row's place right after)
//   onResize()         the list's height changes; on an Undo, called at full
//                      size before the expansion plays, then after

(function (global) {
  "use strict";

  // Backstops for a missing transitionend (background tab): past the 0.3s
  // collapse/expand and the 0.12s swap fade-out (css/style.css).
  var ROW_MOTION_MS = 400;
  var SWAP_OUT_MS = 170;
  // How long a crossfading icon waits for its new picture before swapping anyway.
  var DECODE_WAIT_MS = 1000;

  var H = global.EmjiveHelpers;
  var transitionDone = H.transitionDone;

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

  function fadeSwap(el, apply, ready) {
    var token = (swapTokens.get(el) || 0) + 1;
    swapTokens.set(el, token);
    el.classList.add("is-swapping");
    Promise.all([transitionDone(el, "opacity", SWAP_OUT_MS), ready]).then(function () {
      if (swapTokens.get(el) !== token) return;
      apply();
      el.classList.remove("is-swapping");
    });
  }

  // Rows show the icon's 128px variant.
  var thumbSrc = H.thumbSrc;
  var resampleBand = H.resampleBand;

  // No-fade change for a live preview; cancels any fadeSwap under way on `el`.
  function setNow(el, apply) {
    swapTokens.set(el, (swapTokens.get(el) || 0) + 1);
    el.classList.remove("is-swapping");
    apply();
  }

  function create(options) {
    var listEl = options.listEl;
    var rowClass = options.rowClass || "";
    var showPrice = !!options.showPrice;
    var dropAtOnce = !!options.dropAtOnce;
    var newestFirst = !!options.newestFirst;

    // The element the row at `index` goes before (null: the end); the list is
    // reversed when newestFirst.
    function slotFor(index) {
      var neighbour = bindings[newestFirst ? index - 1 : index];
      return neighbour ? neighbour.li : null;
    }

    // Rows in the list, in order: { item, index, li, inner, button, thumb, name,
    // attrs, price }. A collapsing row has already left, so indexes match storage.
    var bindings = [];
    // The Undo line requested but not yet answered (offerUndo() precedes the
    // removal render() answers), and the one held: { index, handlers, state:
    // "pending" | "held" | "leaving" | "done", binding, line }.
    var pendingHold = null;
    var held = null;

    function resize() {
      if (options.onResize) options.onResize();
    }

    function fillAttrs(el, item) {
      el.textContent = "." + item.category + "." + item.metal + ".";
      global.EmjiveSelection.appendSize(el, item.size);
    }

    // The visible label is a dotted string, so the button gets a plain spoken name.
    function spokenLabel(item) {
      return "Modify " + item.name + ", " + item.metal + ", size " + String(parseFloat(item.size));
    }

    function buildRow(item) {
      // shown: what the row displays (a preview may be over the stored item).
      var binding = { item: item, shown: item, index: -1 };

      var li = document.createElement("li");
      li.className = "order-item" + (rowClass ? " " + rowClass : "");

      // One <button> wrapping the whole row, hence spans throughout.
      var button = document.createElement("button");
      button.type = "button";
      button.className = "order-item__content";
      button.setAttribute("aria-label", spokenLabel(item));

      var thumb = document.createElement("img");
      thumb.className = "order-item__thumb";
      H.setThumb(thumb, item.image);
      thumb.alt = "";
      // A picture arriving under the band: see resampleBand().
      thumb.addEventListener("load", function () { resampleBand(li); });

      var meta = document.createElement("span");
      meta.className = "order-item__meta edge-scroll";
      H.edgeFades(meta);
      var name = document.createElement("span");
      name.className = "order-item__name";
      name.textContent = item.name;
      var attrs = document.createElement("span");
      attrs.className = "order-item__attrs";
      fillAttrs(attrs, item);
      // No space between: they read as one label.
      meta.appendChild(name);
      meta.appendChild(attrs);

      button.appendChild(thumb);
      button.appendChild(meta);

      var price = null;
      if (showPrice) {
        price = document.createElement("span");
        price.className = "order-item__price";
        price.textContent = global.EmjiveSelection.formatPrice(item.price);
        button.appendChild(price);
      }

      // .order-item__inner clips the collapse/expand, so .order-item doesn't clip its ::before band.
      var inner = document.createElement("div");
      inner.className = "order-item__inner";
      inner.appendChild(button);
      li.appendChild(inner);

      // Anywhere on the row; the button's own click (and Enter/Space) bubbles here.
      li.addEventListener("click", function () {
        if (bindings.indexOf(binding) === -1) return;
        if (options.onModify) options.onModify(binding);
      });

      binding.li = li;
      binding.inner = inner;
      binding.button = button;
      binding.thumb = thumb;
      binding.name = name;
      binding.attrs = attrs;
      binding.price = price;
      return binding;
    }

    // Crossfades only the parts that changed (icon, label, price); `instant` for
    // previews. Compared with what the row shows, so a Save after a preview has
    // nothing left to swap.
    function crossfadeRow(binding, item, instant) {
      var old = binding.shown;
      var swap = instant ? setNow : fadeSwap;
      binding.shown = item;
      binding.button.setAttribute("aria-label", spokenLabel(item));
      if ((old.image || "") !== (item.image || "")) {
        swap(binding.thumb, function () {
          if (item.image) binding.thumb.src = thumbSrc(item.image);
          else binding.thumb.removeAttribute("src");
        }, instant ? null : decoded(thumbSrc(item.image)));
      }
      if (old.name !== item.name) {
        swap(binding.name, function () { binding.name.textContent = item.name; });
      }
      if (old.category !== item.category || old.metal !== item.metal || String(old.size) !== String(item.size)) {
        swap(binding.attrs, function () { fillAttrs(binding.attrs, item); });
      }
      if (binding.price && old.price !== item.price) {
        swap(binding.price, function () {
          binding.price.textContent = global.EmjiveSelection.formatPrice(item.price);
        });
      }
    }

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
      var wrap = document.createElement("div");
      wrap.className = "order-item__undo";
      var button = document.createElement("button");
      button.type = "button";
      button.className = "order-item__undo-button";
      var label = document.createElement("span");
      label.className = "order-item__undo-label";
      label.textContent = "Undo";
      button.appendChild(label);
      var band = document.createElement("span");
      band.className = "order-item__undo-band";
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

    // Without animate (first render, hidden list) it just rebuilds; otherwise
    // EmjiveSelection.singleChange picks the one row to animate, rebuilding when
    // the change isn't a single one.
    function render(items, opts) {
      var animate = !!(opts && opts.animate);
      var sel = global.EmjiveSelection;
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

      var change = sel.singleChange(oldKeys, keys);
      if (!change) {
        rebuild(items);
        return;
      }

      if (change.type === "update") {
        items.forEach(function (item, i) { crossfadeRow(bindings[i], item); });
      } else if (change.type === "remove") {
        collapse(bindings.splice(change.index, 1)[0]);
      } else {
        var binding = buildRow(items[change.index]);
        listEl.insertBefore(binding.li, slotFor(change.index));
        bindings.splice(change.index, 0, binding);
        syncBindings(items);
        expand(binding);
        return;
      }
      syncBindings(items);
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
      offerUndo: offerUndo,
      isHolding: function () { return !!(pendingHold || held); },
      // buttonAt: the row now at `index` (focus return), looked up late as rows come and go.
      settledHeight: settledHeight,
      buttonAt: function (index) {
        var binding = bindings[index];
        return binding ? binding.button : null;
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
