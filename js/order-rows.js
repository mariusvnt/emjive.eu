/* ==========================================================================
   em·ji·ve — order rows
   The item rows shared by launch-order.html's order list and the floating
   selection bar's drawer (js/selection-page.js and js/selection-bar.js), so
   the two behave identically: a tap anywhere on a row opens the Modify
   sheet for its item (js/modify-modal.js). That's all a row does — its
   Unselect and the Undo after it live in the page's bar while the sheet is
   open. Same .order-item markup and CSS in both lists.

   Rows follow the selection one change at a time instead of being rebuilt
   on every change, so each change shows as what it is: a Modify crossfades
   just the parts of its row that changed, an Unselect collapses its row,
   and an Undo expands it back where it was — the collapse played in
   reverse.

   window.EmjiveOrderRows.create(options) returns
   { render(items, { animate }), settledHeight(), buttonAt(index) }.
   options:
     listEl             the <ul> the rows are rendered into
     rowClass           an extra class on every <li> (the drawer's
                        "order-item--drawer")
     showPrice          the order list shows each row's price; the drawer
                        doesn't
     onModify(binding)  a row was tapped — binding.item / binding.index
     onResize()         the list's height changes: once a collapsed row has
                        left, and when a row is put back — at full size,
                        just before its expansion plays, so a container
                        that sizes itself to the list (the bar's drawer) can
                        measure where it's heading — then again once it's
                        done.

   The list emptying out is left to each page (the drawer closes, the order
   list crossfades to its empty state), which simply stops calling render()
   then: the last row leaves along with its list rather than collapsing on
   its own first, and an Undo finds it still in place.
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

  function create(options) {
    var listEl = options.listEl;
    var rowClass = options.rowClass || "";
    var showPrice = !!options.showPrice;

    // One entry per row still in the list, in list order:
    // { item, index, li, inner, button, thumb, name, attrs, price }. A row
    // playing its collapse has already left this array — so a tap on it
    // can't open an item that's gone, and every index here matches
    // storage.
    var bindings = [];

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
      var binding = { item: item, index: -1 };

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
      if (item.image) thumb.src = item.image;
      thumb.alt = "";

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
    // and nothing else about the row moves.
    function crossfadeRow(binding, item) {
      var old = binding.item;
      binding.button.setAttribute("aria-label", spokenLabel(item));
      if ((old.image || "") !== (item.image || "")) {
        fadeSwap(binding.thumb, function () {
          if (item.image) binding.thumb.src = item.image;
          else binding.thumb.removeAttribute("src");
        }, decoded(item.image));
      }
      if (old.name !== item.name) {
        fadeSwap(binding.name, function () { binding.name.textContent = item.name; });
      }
      if (old.category !== item.category || old.metal !== item.metal || String(old.size) !== String(item.size)) {
        fadeSwap(binding.attrs, function () { fillAttrs(binding.attrs, item); });
      }
      if (binding.price && old.price !== item.price) {
        fadeSwap(binding.price, function () {
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

    function collapse(binding) {
      collapsing.push(binding);
      binding.li.classList.add("is-removing");
      transitionDone(binding.inner, "max-height", ROW_MOTION_MS).then(function () {
        forget(collapsing, binding);
        binding.li.remove();
        resize();
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
      if (!animate || !items.length || !bindings.length) {
        rebuild(items);
        return;
      }

      var sel = global.EmjiveSelection;
      var oldKeys = bindings.map(function (binding) { return sel.itemKey(binding.item); });
      var change = sel.singleChange(oldKeys, items.map(sel.itemKey));
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

    return {
      render: render,
      // The row now at `index` — where focus goes back to when the Modify
      // sheet closes, looked up late because rows come and go.
      settledHeight: settledHeight,
      buttonAt: function (index) {
        var binding = bindings[index];
        return binding ? binding.button : null;
      }
    };
  }

  global.EmjiveOrderRows = { create: create };
})(window);
