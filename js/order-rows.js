/* ==========================================================================
   em·ji·ve — order rows
   The item rows shared by launch-order.html's order list and the floating
   selection bar's drawer (js/selection-page.js and js/selection-bar.js), so
   the two behave identically: a tap anywhere on a row opens the Modify
   sheet for its item (js/modify-modal.js). That's all a row does — its
   Unselect lives in the page's bar while the sheet is open; the Undo after
   it is on the row's own line (offerUndo, below). Same .order-item markup
   and CSS in both lists.

   Rows follow the selection one change at a time instead of being rebuilt
   on every change, so each change shows as what it is: a Modify crossfades
   just the parts of its row that changed, an Unselect collapses its row
   (or, when the Modify sheet asked for an Undo, holds it open as one — see
   below), and an Undo brings it back where it was.

   window.EmjiveOrderRows.create(options) returns
   { render(items, { animate }), preview(index, values), settledHeight(),
   buttonAt(index), offerUndo(index, handlers), isHolding() } — preview() is
   the Modify sheet's live draft: the row's changed parts switch to the draft
   at once, no fade (null: back to the stored item), without touching
   storage.

   offerUndo(index, handlers) is called just BEFORE the item at `index` is
   removed from storage. The removal's row then stays in the list, at its
   full height, as the item's "undo line" (css/style.css's .order-item__undo):
   its content fades out and an invert band grows in across the left quarter
   of the line, under an "Undo" button. handlers is { onUndo(), onGone() }:
   onUndo when that button is tapped (the caller puts the item back, and the
   held line is the very row that comes back to life), onGone once the line
   has gone for any other reason — closed, dropped, or swept away by a
   rebuild. It returns the handle { held(), button(), leave(done), drop() }:
   held() is false when no line could be held (the list wasn't animating),
   leave(done) is the offer running out — the band regresses to the left
   edge, then the line closes — and drop() closes it at once. A line that is
   all that's left of its list (the last item) doesn't collapse: it leaves
   along with the list, like the last row always has. isHolding() says
   whether a line is held or about to be, which is what a page needs to know
   before it treats its list as empty.
   options:
     listEl             the <ul> the rows are rendered into
     rowClass           an extra class on every <li> (the drawer's
                        "order-item--drawer")
     showPrice          the order list shows each row's price; the drawer
                        doesn't
     onModify(binding)  a row was tapped — binding.item / binding.index
     dropAtOnce         a dropped undo line (another row was tapped while it
                        was on offer) leaves the list at once instead of
                        closing: for the bar's drawer, which is about to
                        measure the tapped row's place and mustn't have the
                        row above it still collapsing
     onResize()         the list's height changes: once a collapsed row has
                        left, and when a row is put back — at full size,
                        just before its expansion plays, so a container
                        that sizes itself to the list (the bar's drawer) can
                        measure where it's heading — then again once it's
                        done.

   The list emptying out is left to each page (the drawer closes, the order
   list crossfades to its empty state), which simply stops calling render()
   then — except while a line is held (isHolding()): the last row leaves along
   with its list rather than collapsing on its own first, and the page lets
   the list go when onGone says the line has.
   ========================================================================== */

(function (global) {
  "use strict";

  // Backstops for a transitionend that never comes (a backgrounded tab):
  // past the rows' 0.3s collapse/expand, and past the 0.12s fade-out a
  // crossfading part plays before its swap (css/style.css).
  var ROW_MOTION_MS = 400;
  var SWAP_OUT_MS = 170;
  // How long a crossfading icon waits for its new picture before swapping
  // anyway.
  var DECODE_WAIT_MS = 1000;

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Resolves once `el`'s own `prop` transition ends — or after `ms`, if
  // there turns out to be nothing to transition.
  function transitionDone(el, prop, ms) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onEnd);
        resolve();
      }
      function onEnd(e) {
        if (e.target === el && e.propertyName === prop) finish();
      }
      el.addEventListener("transitionend", onEnd);
      setTimeout(finish, ms);
    });
  }

  // The new icon, fully decoded — so a crossfade never shows an empty frame
  // between the old picture leaving and the new one arriving.
  function decoded(src) {
    if (!src) return null;
    var img = new Image();
    img.src = src;
    var ready = img.decode ? img.decode().catch(function () {}) : null;
    return Promise.race([ready, wait(DECODE_WAIT_MS)]);
  }

  // Sequenced, not simultaneous — the same handoff the floating bar's own
  // labels use: `el` fades out (.is-swapping), apply() puts the new value
  // in while nothing's showing, and it fades back in. Two versions of a
  // label never overlap mid-fade. `ready` (optional) holds the swap until
  // it resolves — a new icon still decoding. A second swap started on the
  // same element meanwhile wins: the first one then never applies.
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

  // Fetches and decodes images ahead of a swap, so a metal pick that changes
  // an icon with no fade shows the new one at once instead of the old one
  // lingering while the new loads (most noticeable on a phone). Kept in a
  // map so they stay in memory for the swap.
  var preloaded = {};

  // A row's thumbnail is 48px: it shows the icon's 128px sibling (see
  // EmjiveLoader.variant), not the 512px file.
  function thumbSrc(src) {
    return src && global.EmjiveLoader ? global.EmjiveLoader.variant(src, "128") : src;
  }

  function preload(srcs) {
    srcs.forEach(function (src) {
      if (!src || preloaded[src]) return;
      var img = new Image();
      img.src = src;
      if (img.decode) img.decode().catch(function () {});
      preloaded[src] = img;
    });
  }

  // Safari's backdrop-filter re-samples what's behind it late when that
  // changes in place: text or an icon under an invert band (.order-item::before,
  // .product-detail__label-bar::before) showed its old value for a moment
  // after the new one was in the DOM. Nudging the band's own filter (an
  // imperceptible invert(0.99), see .is-resampling in css/style.css) for a
  // couple of frames makes it sample again at once. Used wherever a value
  // under a band changes with no fade to cover it.
  var resampleTokens = new WeakMap();

  function resampleBand(el) {
    var token = (resampleTokens.get(el) || 0) + 1;
    resampleTokens.set(el, token);
    el.classList.add("is-resampling");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (resampleTokens.get(el) === token) el.classList.remove("is-resampling");
      });
    });
  }

  // The same change with no fade, for a live preview: any fadeSwap still
  // under way on `el` is cancelled, so it can't land over this value.
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

    // One entry per row still in the list, in list order:
    // { item, index, li, inner, button, thumb, name, attrs, price }. A row
    // playing its collapse has already left this array — so a tap on it
    // can't open an item that's gone, and every index here matches
    // storage.
    var bindings = [];
    // The undo line asked for and not answered yet (offerUndo() runs before
    // the removal, which render() then answers), and the one now held: both
    // { index, handlers, state: "pending" | "held" | "leaving" | "done",
    // binding, line }.
    var pendingHold = null;
    var held = null;

    function resize() {
      if (options.onResize) options.onResize();
    }

    function fillAttrs(el, item) {
      el.textContent = "." + item.category + "." + item.metal + ".";
      global.EmjiveSelection.appendSize(el, item.size);
    }

    // The visible label packs everything into one dotted string (and a
    // decimal size into a small raised "50"), so the button gets a plain
    // spoken name of its own.
    function spokenLabel(item) {
      return "Modify " + item.name + ", " + item.metal + ", size " + item.size;
    }

    function buildRow(item) {
      // shown: the values the row currently displays — the stored item,
      // unless a Modify sheet is previewing a draft over it (see preview()).
      var binding = { item: item, shown: item, index: -1 };

      var li = document.createElement("li");
      li.className = "order-item" + (rowClass ? " " + rowClass : "");

      // The row's one control: a real <button>, so it's in the Tab order
      // and announced as one, wrapping everything the row shows — hence
      // spans throughout (a button holds phrasing content only).
      var button = document.createElement("button");
      button.type = "button";
      button.className = "order-item__content";
      button.setAttribute("aria-label", spokenLabel(item));

      var thumb = document.createElement("img");
      thumb.className = "order-item__thumb";
      if (item.image) {
        if (global.EmjiveLoader) global.EmjiveLoader.setSrc(thumb, global.EmjiveLoader.variant(item.image, "128"), item.image);
        else thumb.src = item.image;
      }
      thumb.alt = "";
      // A picture arriving under the invert band is its own change in
      // place — see resampleBand().
      thumb.addEventListener("load", function () { resampleBand(li); });

      var meta = document.createElement("span");
      meta.className = "order-item__meta";
      var name = document.createElement("span");
      name.className = "order-item__name";
      name.textContent = item.name;
      var attrs = document.createElement("span");
      attrs.className = "order-item__attrs";
      fillAttrs(attrs, item);
      // No space between them either — the two read as one continuous label
      // (the period already reads as a separator) rather than two chips with
      // any gap, flex or otherwise, between them.
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

      // Wrapped rather than appended straight to li — see .order-item__inner
      // in css/style.css: this is what clips the collapse/expand motion,
      // kept off .order-item itself so it never clips ::before's own
      // full-bleed invert band.
      var inner = document.createElement("div");
      inner.className = "order-item__inner";
      inner.appendChild(button);
      li.appendChild(inner);

      // Anywhere on the row, its padding included. A tap on the button
      // itself, or Enter/Space on it from a keyboard, arrives here too, as
      // the button's own click bubbling up.
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

    // A Modify just saved: each part whose value changed crossfades to it
    // in place — the icon, the ".category.metal.size" label, the price —
    // and nothing else about the row moves. instant (the sheet's live
    // preview) skips the fade. Compared against what the row shows, not
    // what's stored, so a Save after a preview finds nothing left to swap.
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

    // Collapsing this one row's box is what slides the rows below it up —
    // .order-items' flex layout recalculating every frame. Its item is
    // already gone from storage; this only touches the DOM.
    // Rows mid-motion, for settledHeight(): collapsing ones (already out of
    // bindings) and expanding ones, each with the height it's heading to.
    var collapsing = [];
    var expanding = [];

    // A rebuild may have cleared the list out from under a motion still
    // finishing, so the entry isn't necessarily there any more.
    function forget(list, binding) {
      var i = list.indexOf(binding);
      if (i !== -1) list.splice(i, 1);
    }

    function collapse(binding, done) {
      collapsing.push(binding);
      binding.li.classList.add("is-removing");
      // Waits for both: .order-item__inner's max-height (the layout
      // collapse) and .order-item::before's own opacity — the invert band,
      // which now outlives it (css/style.css's .order-item.is-removing
      // ::before delays the band so it's the last thing left visible).
      // transitionend on a pseudo-element reports its host as e.target, so
      // listening on binding.li for "opacity" catches ::before's own finish.
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

    /* ---- the undo line ------------------------------------------------------ */

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

    // The removed row stays: its content goes inert, and the line is built in
    // and laid out before .is-undo lands, so there is a state to transition
    // from.
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

    // The line is over. It closes like any removed row — unless it is all the
    // list has left, which goes with the list.
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

    // The offer ran out: the label goes, the band regresses to the left edge,
    // and only then does the line close.
    function leave(h, done) {
      if (h.state !== "held") return;
      h.state = "leaving";
      h.binding.li.classList.add("is-undo-leaving");
      transitionDone(h.line.band, "width", ROW_MOTION_MS).then(function () {
        if (h.state === "leaving") finishHold(h, done);
      });
    }

    // Undo: the held line is the row coming back — its band sweeps the whole
    // line and fades as the row's own band and content return (all CSS),
    // and then the undo line is taken down.
    function revive(h, items, index) {
      var binding = h.binding;
      var li = binding.li;
      h.state = "done";
      held = null;
      // Only moved when something has come between (re-inserting an element
      // drops the state its transitions start from — it would just snap).
      var next = bindings[index] ? bindings[index].li : null;
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

    // The collapse in reverse, for an Undo. The row goes in at full size
    // first, for onResize's measurement (see the header), then snaps shut
    // (.is-instant — no frame is painted in between) and opens from there
    // on the next frame. .is-expanding keeps its content clipped while it
    // grows, the way .is-removing does while it shrinks.
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

    // The list's height once every row now collapsing or expanding has
    // finished — what a container sizing itself to the list (the bar's
    // drawer) should head for, rather than whatever the list happens to
    // measure mid-motion.
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
      // Whatever was held goes with the list; told once this call is over,
      // since the page it tells may well be the one that is rendering.
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
        listEl.appendChild(binding.li);
        return binding;
      });
      syncBindings(items);
    }

    // animate off — the first render, a list nobody can see (a closed
    // drawer, a list about to crossfade in) — just rebuilds. Otherwise the
    // same single-change diff the bar's icon strip runs
    // (EmjiveSelection.singleChange) picks the one row to animate; anything
    // it can't explain as one change rebuilds too.
    function render(items, opts) {
      var animate = !!(opts && opts.animate);
      var sel = global.EmjiveSelection;
      var oldKeys = bindings.map(function (binding) { return sel.itemKey(binding.item); });
      var keys = items.map(sel.itemKey);

      // An Unselect that asked for an Undo (offerUndo): its row stays, as the
      // line — even the list's last one.
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

      // An Undo: the line held for it is the row that comes back.
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
        var next = bindings[change.index];
        listEl.insertBefore(binding.li, next ? next.li : null);
        bindings.splice(change.index, 0, binding);
        syncBindings(items);
        expand(binding);
        return;
      }
      syncBindings(items);
    }

    // Live preview for the Modify sheet: the row at `index` switches at once
    // to its item with `values` (any of metal, size, price, image) laid over it, or
    // back to the stored item when `values` is null. Storage is untouched;
    // a row that has left the list is ignored.
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
      // The row now at `index` — where focus goes back to when the Modify
      // sheet closes, looked up late because rows come and go.
      settledHeight: settledHeight,
      buttonAt: function (index) {
        var binding = bindings[index];
        return binding ? binding.button : null;
      }
    };
  }

  /* ---- transient notice ----------------------------------------------------
     What replaces alert() for "can't do that right now" messages (the Modify
     sheet failing to open, the checkout stub): a blocking native dialog is
     jarring, can't be styled, and on iOS is suppressed outright in some
     contexts. A full-width bar that slides up from the bottom of the screen
     and rests on whatever stands there — see .emjive-notice in
     css/style.css. role="status" so assistive tech announces the text
     without moving focus; it slides away by itself after a few seconds. */
  var NOTICE_MS = 6000;
  var noticeEl = null;
  var noticeTextEl = null;
  var noticeTimer = 0;

  // The bottom-anchored things a notice has to rest on. Whichever of them is
  // actually on screen and highest wins: the selection bar (grown by its
  // drawer), the product page's Select bar and the order page's checkout bar
  // and drawer that stand on it, and the Modify sheet.
  var REST_ON = ".selection-bar, .product-select-bar, .order-checkout-bar, .order-checkout-drawer, .size-modal__sheet";

  // How far up from the bottom of the screen the stack reaches: the viewport
  // height minus the highest top edge among the visible elements above.
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
      // Off screen (the homepage bar before its entrance, a closed sheet
      // slid out of view) or empty: not part of what is standing there.
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
    // A frame between placing it and showing it, so the first notice slides
    // in instead of appearing already at rest.
    requestAnimationFrame(function () { noticeEl.classList.add("is-shown"); });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { noticeEl.classList.remove("is-shown"); }, NOTICE_MS);
  }

  // preload and resampleBand are shared with js/product.js's label bar and
  // js/modify-modal.js, which swap icons the same way.
  global.EmjiveOrderRows = { create: create, preload: preload, resampleBand: resampleBand, notice: notice };
})(window);
