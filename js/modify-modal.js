/* ==========================================================================
   em·ji·ve — Modify sheet
   The one "Modify" popup on the site, opened by tapping a row in either
   list — launch-order.html's order rows (js/selection-page.js) or the
   floating bar's drawer on every other page (js/selection-bar.js) — so it
   lives on all seven pages and builds its own DOM, the way the bar does.

   A bottom sheet (.size-modal--drawer, same as product.html's size sheet)
   resting just above whichever bar the page has, holding:
     - a small, working copy of the product carousel, its top half sticking
       out above the sheet: the live 3D model (drag rotates it) plus the
       product's photos, paged by the same code as product.html's carousel
       (js/carousel.js);
     - the metal picker, which re-tints that model in place;
     - the size field, pre-filled with the item's current size;
     - the size guide, which opens above its own button.

   Its buttons aren't in it: while it's open, the page's bar turns into
   them — the "strip" built below, handed to the bar through options.bar:
   Unselect on the bar's left quarter (light), Save on the rest (dark,
   inactive while the size field holds nothing orderable). Unselect removes
   the item, the sheet slides away and the whole strip turns into "Undo"
   for a few seconds; tapping the bar then puts the item back where it was.

   window.EmjiveModifyModal = { open(item, index, options), isOpen() }.
   options:
     bar            the page's bar, as { el, show(stripEl), hide(stripEl) }:
                    the strip is appended into el, and show/hide swap it
                    with the bar's own content however that bar sequences
                    its labels
     onOpen()       each time the sheet shows an item (the drawer shrinks)
     onClose()      once the sheet has closed — saved, unselected or just
                    dismissed (the drawer grows back)
     returnFocus    element (or function returning one) focus goes back to:
                    on close, and after an Undo
     fallbackFocus  same, if returnFocus is gone by then — and where focus
                    goes if it was on Undo when the offer ran out

   Nothing here re-renders anything: saving, unselecting and undoing all go
   through js/selection.js, whose synchronous "emjive:selection-changed"
   the lists already follow.

   Dispatches "emjive:modify-open" before it builds anything (js/product.js
   closes its own size sheet; js/main.js lends the sheet one of the grid's
   WebGL slots) and "emjive:modify-close" once its viewer is disposed.
   ========================================================================== */

(function () {
  "use strict";

  if (!window.EmjiveSelection || !window.EmjiveSeries || !window.EmjiveCarousel) return;

  // The sheet's slide-out (.size-modal--drawer .size-modal__sheet's 0.3s
  // transform in css/style.css) plus a margin — the viewer is disposed only
  // once it's out of sight, or the model would blank out mid-slide.
  var SLIDE_OUT_MS = 350;
  // How long the bar offers "Undo" after an Unselect.
  var UNDO_MS = 4000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // An option given as an element or as a function returning one.
  function resolve(want) {
    return typeof want === "function" ? want() : want;
  }

  /* ---- build the DOM once ------------------------------------------------
     role/aria-modal/aria-label sit on the outer .size-modal rather than on
     .size-modal__panel: js/focus-trap.js traps the whole modal, and the
     carousel is a sibling of the panel, not a child — aria-modal hides
     everything outside the declared dialog from a screen reader. tabindex
     "-1" lets the trap focus it on open so the label is read first. */
  var modal = el("div", "size-modal size-modal--drawer size-modal--modify");
  modal.id = "modifyModal";
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Modify selection");
  modal.tabIndex = -1;

  var backdrop = el("div", "size-modal__backdrop");

  // The small carousel: product.html's own .product-carousel markup, so
  // js/carousel.js and the slide CSS apply unchanged. .size-modal__carousel
  // is what shrinks the tile and makes the top half stick out above the
  // sheet (see css/style.css).
  var carouselFrame = el("div", "size-modal__carousel product-carousel-frame");
  var carouselEl = el("div", "product-carousel");
  var viewport = el("div", "product-carousel__viewport");
  var track = el("div", "product-carousel__track");
  viewport.appendChild(track);
  carouselEl.appendChild(viewport);
  carouselFrame.appendChild(carouselEl);

  var panel = el("div", "size-modal__panel");
  var content = el("div", "size-modal__content");

  var metalsRow = el("div", "product-metals");
  metalsRow.appendChild(el("span", "product-metals__label", "Metal"));
  var metalOptions = el("div", "product-metals__options");
  metalsRow.appendChild(metalOptions);

  var sizeRow = el("div", "size-modal__custom-row");
  var sizeLabel = el("label", "size-modal__custom-label", "Custom size");
  sizeLabel.htmlFor = "modifyModalCustomInput";
  var sizeField = el("div", "size-modal__custom-field");
  var sizeUnderline = el("span", "size-modal__custom-underline");
  var sizeInput = el("input", "size-modal__custom-input");
  sizeInput.id = "modifyModalCustomInput";
  sizeInput.type = "text";
  // The numeric keypad on mobile; js/selection.js's filter backstops the rest.
  sizeInput.setAttribute("inputmode", "decimal");
  sizeInput.setAttribute("autocomplete", "off");
  var sizeUnit = el("span", "size-modal__custom-unit");
  sizeUnderline.appendChild(sizeInput);
  sizeUnderline.appendChild(sizeUnit);
  sizeField.appendChild(sizeUnderline);
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeField);

  content.appendChild(metalsRow);
  content.appendChild(sizeRow);

  // Guide ahead of its toggle: it opens between the size row and the
  // button, so the sheet grows upward while the button stays put, right
  // above the bar, where it can be tapped again to close.
  var guide = el("div", "size-modal__guide");
  var guidePanel = el("div", "size-modal__guide-panel");
  guidePanel.id = "modifyModalGuide";
  var guideInner = el("div", "size-modal__guide-panel-inner");
  guideInner.appendChild(el("div", "size-modal__guide-content"));
  guidePanel.appendChild(guideInner);
  var guideToggle = el("button", "size-modal__guide-toggle", "Size guide");
  guideToggle.type = "button";
  guideToggle.setAttribute("aria-expanded", "false");
  guideToggle.setAttribute("aria-controls", "modifyModalGuide");
  guide.appendChild(guidePanel);
  guide.appendChild(guideToggle);

  panel.appendChild(content);
  panel.appendChild(guide);

  var sheet = el("div", "size-modal__sheet");
  sheet.appendChild(carouselFrame);
  sheet.appendChild(panel);

  modal.appendChild(backdrop);
  modal.appendChild(sheet);
  document.body.appendChild(modal);

  /* ---- the bar strip -------------------------------------------------------
     What the page's bar turns into while this sheet is open (css/style.css's
     .modify-strip): one full-bleed layer over the bar holding three buttons,
     in reading (and Tab) order — Unselect (the light quarter on the left),
     Save (the dark three quarters on the right) and Undo (the whole strip).
     Unselect is also the light surface that widens across the bar when the
     strip turns into "Undo"; Save, painted after it, has no background of
     its own, so that surface shows straight through; Undo is just the label
     over it all. Appended into the page's bar on the first open
     (mountStrip), shown and hidden by that bar (options.bar), since only
     the bar knows how it hands its own content over. Hidden, it's inert, so
     nothing in it can be tabbed to. */
  function stripButton(className, label) {
    var btn = el("button", className);
    btn.type = "button";
    btn.appendChild(el("span", "modify-strip__label", label));
    return btn;
  }

  var strip = el("div", "modify-strip is-hidden");
  strip.setAttribute("aria-hidden", "true");
  strip.inert = true;
  var unselectBtn = stripButton("modify-strip__unselect", "Unselect");
  var saveBtn = stripButton("modify-strip__save", "Save");
  var undoBtn = stripButton("modify-strip__undo", "Undo");
  strip.appendChild(unselectBtn);
  strip.appendChild(saveBtn);
  strip.appendChild(undoBtn);

  var carousel = window.EmjiveCarousel(carouselEl);

  var state = {
    isOpen: false,
    // Bumped on every open() so a slow product fetch from an earlier click
    // can't open the sheet over a later one — the latest click wins.
    openToken: 0,
    item: null,
    index: null,
    product: null,
    slug: null,
    selectedMetal: null,
    options: {},
    modelHandle: null,
    iconImg: null,
    cleanupTimer: null,
    // While the bar offers "Undo": { item, index, options, timer }.
    undo: null
  };

  function iconSrc(metal) {
    var product = state.product;
    return (product && product.assets && product.assets.icons && product.assets.icons[metal]) || "";
  }

  // "modify" (Unselect | Save) or "undo". Whichever buttons aren't part of
  // the mode are inert, so a hidden one can never take a click or a Tab.
  // With the strip out of sight there's no motion worth showing, so the
  // switch is instant (.is-instant) — the next open starts on the modify
  // layout rather than playing the Undo widening backwards.
  function setStripMode(mode) {
    var undoing = mode === "undo";
    var instant = strip.classList.contains("is-hidden");
    if (instant) strip.classList.add("is-instant");
    strip.classList.toggle("is-undo", undoing);
    saveBtn.inert = undoing;
    unselectBtn.inert = undoing;
    undoBtn.inert = !undoing;
    if (instant) {
      void strip.offsetWidth;
      strip.classList.remove("is-instant");
    }
  }

  function mountStrip(bar) {
    if (!bar || strip.parentNode === bar.el) return;
    bar.el.appendChild(strip);
    // Laid out once while still hidden, so the bar's first reveal fades it
    // in instead of popping it straight to visible.
    void strip.offsetWidth;
  }

  /* ---- metal picker ------------------------------------------------------
     Built per open (the metal list is global, but the selected one isn't),
     then updated in place on each pick — rebuilding the buttons would drop
     keyboard focus off the one just pressed. */
  function renderMetalOptions() {
    metalOptions.innerHTML = "";
    (window.EmjiveSeries.metals || []).forEach(function (metal) {
      var optionWrap = el("div", "product-metals__option-wrap");
      optionWrap.classList.toggle("is-selected", metal === state.selectedMetal);

      var btn = el("button", "product-metals__option");
      btn.type = "button";
      btn.dataset.metal = metal;
      btn.setAttribute("aria-label", metal);
      // The selected finish is otherwise conveyed only by a wrapper class
      // and a dot, neither of which a screen reader can reach, on a control
      // that changes the price.
      btn.setAttribute("aria-pressed", String(metal === state.selectedMetal));
      btn.addEventListener("click", function () { selectMetal(metal); });

      optionWrap.appendChild(btn);
      optionWrap.appendChild(el("span", "product-metals__option-label", metal));
      metalOptions.appendChild(optionWrap);
    });
  }

  function selectMetal(metal) {
    if (metal === state.selectedMetal) return;
    state.selectedMetal = metal;
    metalOptions.querySelectorAll(".product-metals__option-wrap").forEach(function (optionWrap) {
      var btn = optionWrap.querySelector(".product-metals__option");
      var on = btn.dataset.metal === metal;
      optionWrap.classList.toggle("is-selected", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    // Re-tints the live model in place (no reload, no camera reset); a
    // model-less or failed slide shows the icon, which needs its own swap.
    if (state.modelHandle) state.modelHandle.applyMetal(metal);
    if (state.iconImg) state.iconImg.src = iconSrc(metal);
  }

  /* ---- carousel slides ---------------------------------------------------
     Slide 1 is the model — or its icon, when the product has no model, the
     page has no viewer, or the browser refuses another WebGL context — then
     the photos. No captions and no x-ray backdrop at this size. */
  function iconSlide() {
    var src = iconSrc(state.selectedMetal);
    if (!src) return null;
    var slide = window.EmjiveCarousel.imageSlide(src, state.product.name);
    state.iconImg = slide.querySelector("img");
    return slide;
  }

  function buildSlides() {
    var product = state.product;
    track.innerHTML = "";
    state.iconImg = null;

    var handle = null;
    if (product.assets && product.assets.model && window.EmjiveModelViewer) {
      handle = window.EmjiveModelViewer(product, state.selectedMetal, {
        hdri: window.EmjiveSeries.hdriPath(state.slug),
        // Same cap the homepage grid uses: iOS Safari budgets canvas memory
        // for the page as a whole, and this sheet can open over the grid.
        maxPixelRatio: 1.5,
        onError: function () { replaceModelWithIcon(handle); }
      });
    }

    if (handle) {
      state.modelHandle = handle;
      // Smaller than the slide (css/style.css's --model rule), which leaves
      // room around the model to page the carousel from — a drag that
      // starts on the model itself rotates it instead.
      var modelSlide = el("div", "product-carousel__slide product-carousel__slide--model");
      modelSlide.appendChild(handle.el);
      track.appendChild(modelSlide);
    } else {
      var fallback = iconSlide();
      if (fallback) track.appendChild(fallback);
    }

    ((product.assets && product.assets.photos) || []).forEach(function (photo) {
      track.appendChild(window.EmjiveCarousel.imageSlide(photo.src, product.name));
    });

    carouselFrame.classList.toggle("product-carousel--single", track.children.length <= 1);
  }

  // A load failure or a lost WebGL context, possibly well after the model
  // was on screen. The slide stays where it is (its place in the track is
  // what the carousel's geometry is built on); only its contents become
  // the icon. Ignores a handle that's no longer the live one.
  function replaceModelWithIcon(handle) {
    if (!handle || handle !== state.modelHandle) return;
    var slide = handle.el.parentNode;
    handle.dispose();
    state.modelHandle = null;
    if (!slide) return;
    slide.classList.remove("product-carousel__slide--model");
    slide.innerHTML = "";
    var src = iconSrc(state.selectedMetal);
    if (!src) return;
    var img = el("img");
    img.src = src;
    img.alt = state.product.name || "";
    img.draggable = false;
    slide.appendChild(img);
    state.iconImg = img;
  }

  function disposeViewer() {
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    if (!state.modelHandle) return;
    state.modelHandle.dispose();
    state.modelHandle = null;
  }

  // After the slide-out: frees the viewer (its WebGL context, decoded model
  // and environment map) and the photos, then tells the grid it can have
  // its slot back.
  function cleanup() {
    disposeViewer();
    track.innerHTML = "";
    state.iconImg = null;
    window.dispatchEvent(new CustomEvent("emjive:modify-close"));
  }

  /* ---- Save, Unselect, Undo ------------------------------------------------ */

  // Save stays on the bar the whole time the sheet is up, but only acts —
  // and only looks like it would — while the field holds a size that can
  // actually be ordered (isValidSize in js/selection.js).
  function syncSave() {
    saveBtn.disabled = !window.EmjiveSelection.isValidSize(sizeInput.value);
  }

  function save() {
    if (!state.isOpen || !window.EmjiveSelection.isValidSize(sizeInput.value)) return;
    var product = state.product;
    var details = (product["per-metal-specs"] && product["per-metal-specs"][state.selectedMetal]) || {};
    window.EmjiveSelection.updateItem(state.index, {
      metal: state.selectedMetal,
      size: window.EmjiveSelection.normalizeSize(sizeInput.value),
      price: details.price || 0,
      image: iconSrc(state.selectedMetal)
    });
    close();
  }

  // Removed from storage right away — the lists collapse the row on the
  // spot — while the strip stays up as "Undo" and the sheet slides away.
  // The item itself (as stored, not as edited here) is kept aside for the
  // Undo, along with the options of the session it came from: the offer
  // outlives the sheet. Focus goes to Undo, since the button it was on is
  // about to be inert.
  function unselect() {
    if (!state.isOpen) return;
    var index = state.index;
    var removed = window.EmjiveSelection.getSelection()[index];
    if (!removed) {
      close();
      return;
    }
    var options = state.options;
    window.EmjiveSelection.removeItem(index);
    setStripMode("undo");
    close({ keepStrip: true, focus: undoBtn });
    state.undo = {
      item: removed,
      index: index,
      options: options,
      timer: setTimeout(expireUndo, UNDO_MS)
    };
  }

  // Back where it was — clamped, in case the list got shorter meanwhile.
  function undo() {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    var sel = window.EmjiveSelection;
    sel.insertItem(Math.min(pending.index, sel.getSelection().length), pending.item);
    if (pending.options.bar) pending.options.bar.hide(strip);
    window.EmjiveFocusTrap.focus(function () {
      return resolve(pending.options.returnFocus) || resolve(pending.options.fallbackFocus);
    });
  }

  // The offer ran out (or the page is going away): the removal stands.
  function expireUndo() {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    var hadFocus = strip.contains(document.activeElement);
    if (pending.options.bar) pending.options.bar.hide(strip);
    if (hadFocus) {
      window.EmjiveFocusTrap.focus(function () { return resolve(pending.options.fallbackFocus); });
    }
  }

  // Another Modify opened while "Undo" was still on offer: the removal
  // stands, and the strip — still up — simply becomes that Modify's.
  function commitUndo() {
    if (!state.undo) return;
    clearTimeout(state.undo.timer);
    state.undo = null;
  }

  saveBtn.addEventListener("click", save);
  unselectBtn.addEventListener("click", unselect);
  undoBtn.addEventListener("click", undo);

  // Same filter as product.html's size sheet (js/selection.js), written
  // back only when it changed something so the caret doesn't jump.
  sizeInput.addEventListener("input", function () {
    var cleaned = window.EmjiveSelection.sanitizeSizeInput(sizeInput.value);
    if (cleaned !== sizeInput.value) sizeInput.value = cleaned;
    syncSave();
  });

  // Enter saves — the same as the bar's Save, one Tab stop further away.
  sizeInput.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    save();
  });

  guideToggle.addEventListener("click", function () {
    var isOpen = guidePanel.classList.toggle("is-open");
    guideToggle.setAttribute("aria-expanded", String(isOpen));
  });

  backdrop.addEventListener("click", function () { close(); });

  /* ---- open / close ------------------------------------------------------- */
  function show(item, index, product, slug, options) {
    // Tapping another row in the drawer while the sheet is up: it just
    // switches to that item — no slide out and back in, and the bar, the
    // focus trap and the shrunken drawer all stay as they are.
    var switching = state.isOpen;
    commitUndo();
    // Before building anything — js/main.js drops a grid viewer to free the
    // WebGL slot the model below is about to take.
    window.dispatchEvent(new CustomEvent("emjive:modify-open"));
    // A reopen inside the previous close's slide-out, or a switch: tear the
    // old viewer down now rather than letting a timer do it (and signal a
    // close) later.
    disposeViewer();

    state.item = item;
    state.index = index;
    state.product = product;
    state.slug = slug;
    state.selectedMetal = item.metal;
    state.options = options;

    renderMetalOptions();
    sizeUnit.textContent = window.EmjiveSeries.categoryInfo(item.category).unit || "";
    sizeInput.value = window.EmjiveSelection.normalizeSize(item.size);
    guidePanel.classList.remove("is-open");
    guideToggle.setAttribute("aria-expanded", "false");
    buildSlides();
    setStripMode("modify");
    syncSave();

    if (!switching) {
      mountStrip(options.bar);
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("is-modal-open");
      state.isOpen = true;
    }
    carousel.sync(true);

    if (!switching) {
      // After .is-open — the modal is visibility: hidden until then, and
      // focus() on a hidden element is a no-op. Both focus targets are
      // looked up in whatever session is current when they're needed, so
      // a switch to another row retargets them.
      window.EmjiveFocusTrap.activate(modal, {
        include: strip,
        returnFocus: function () { return resolve(state.options.returnFocus); },
        fallbackFocus: function () { return resolve(state.options.fallbackFocus); },
        onEscape: function () { close(); }
      });
      if (options.bar) options.bar.show(strip);
    }
    if (options.onOpen) options.onOpen();
  }

  // keepStrip: the strip stays up (an Unselect, turning it into "Undo").
  // focus: where focus goes instead of returnFocus.
  function close(opts) {
    if (!state.isOpen) return;
    opts = opts || {};
    state.isOpen = false;
    var options = state.options;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-modal-open");
    if (!opts.keepStrip && options.bar) options.bar.hide(strip);
    window.EmjiveFocusTrap.release(opts.focus);
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(cleanup, SLIDE_OUT_MS);
    if (options.onClose) options.onClose();
  }

  // Product ids are only unique within a series (see js/selection.js) —
  // falls back to the active series for a pre-refactor selection saved
  // without one. A genuine miss (the product no longer exists in that
  // series' catalog) leaves the sheet unopened with an explanation, the
  // same "can't do that right now" alert() convention the checkout button
  // stub uses.
  function open(item, index, options) {
    // The row already up: nothing to do — reopening it would throw away
    // picks not saved yet.
    if (state.isOpen && state.index === index) return;
    var token = ++state.openToken;
    window.EmjiveSeries.ready
      .then(function () {
        var slug = item.series || window.EmjiveSeries.slug;
        return window.EmjiveSeries.loadProducts(slug).then(function (products) {
          if (token !== state.openToken) return;
          var product = products.find(function (p) { return p.id === item.productId; });
          if (!product) {
            alert("This item's original product listing couldn't be found, so it can't be modified here.");
            return;
          }
          show(item, index, product, slug, options || {});
        });
      })
      // Without this, a failed data/series.json or products.json fetch made
      // "Modify" do nothing at all — no sheet, no message, an unhandled
      // rejection in the console and a row that looks broken. Same alert
      // as the "product no longer in this series' catalog" branch above:
      // from the visitor's side both are "we can't open this right now".
      .catch(function (err) {
        if (token !== state.openToken) return;
        console.error("emjive: could not open the modify sheet", err);
        alert("This item's original product listing couldn't be loaded, so it can't be modified right now.");
      });
  }

  // Leaving the page with the sheet up (Back, say): close it, and free the
  // viewer right away rather than after the slide-out — a page kept in the
  // back/forward cache is still alive, and would otherwise hold its WebGL
  // context the whole time (same reasoning as js/main.js's grid and
  // js/product.js's carousel). An "Undo" still on offer ends there too, so
  // a page restored from that cache doesn't come back offering one.
  window.addEventListener("pagehide", function () {
    if (state.isOpen) close();
    if (state.cleanupTimer) cleanup();
    expireUndo();
  });

  window.EmjiveModifyModal = {
    open: open,
    isOpen: function () { return state.isOpen; }
  };
})();
