/* ==========================================================================
   em·ji·ve — Modify sheet
   The one "Modify" popup on the site, opened by tapping a row in either
   list — launch-order.html's order rows (js/selection-page.js) or the
   floating bar's drawer on every other page (js/selection-bar.js) — so it
   lives on all seven pages and builds its own DOM, the way the bar does.

   A bottom sheet (.size-modal--drawer, same as product.html's size sheet)
   resting just above whichever bar the page has — right on top of the
   tapped row, when that's in the bar's drawer — holding:
     - a small, working copy of the product carousel, its top half sticking
       out above the sheet: the live 3D model (drag rotates it) plus the
       product's photos, paged by the same code as product.html's carousel
       (js/carousel.js). The sheet never waits for the model: it opens on
       the model's poster image, and the viewer is built once it has slid
       in (scheduleViewer);
     - the metal picker, which re-tints that model in place;
     - the size field, pre-filled with the item's current size;
     - the size guide, which opens above its own button.

   Its buttons aren't in it: while it's open, the page's bar turns into
   them — the "strip" built below, handed to the bar through options.bar:
   Unselect on the bar's left quarter and Save on the rest (inactive while
   the size field holds nothing orderable), each marked by an invert band
   like the drawer rows', coming in from its own edge of the screen.
   Unselect removes the item, the sheet slides away and its band stretches
   across the whole bar, over "Undo", for a few seconds; tapping the bar
   then puts the item back where it was. Either way the band slides back
   out to the left once the offer is over. On Save, both bands simply slide
   out through their own edges.

   window.EmjiveModifyModal = { open(item, index, options), isOpen() }.
   options:
     bar            the page's bar, as { el, show(stripEl), hide(stripEl) }:
                    the strip is appended into el, and show/hide swap it
                    with the bar's own content however that bar sequences
                    its labels
     onOpen()       once the sheet is up (the drawer shrinks to the row)
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
     .modify-strip): one dark, full-bleed layer over the bar holding three
     buttons, in reading (and Tab) order — Unselect (the left quarter), Save
     (the rest) and Undo (the whole strip, once Unselect has been tapped) —
     each a plain --white label on the strip's own --black-bg, plus one
     invert band (.modify-strip__band), the same backdrop-filter band the
     drawer rows carry, sized to Save's own right three quarters at rest so
     Save's label alone reads dark on a light band. Tapping Save grows the
     band to the full bar width, then fades it out, before the bar takes its
     own content back (leaveAfterSave). Tapping Unselect shrinks the band
     back into the right edge it's pinned to, crossfading into "Undo" as it
     goes; once that offer is over, "Undo" simply fades out in turn
     (leaveStrip) — nothing left to slide, the band having already gone.
     The strip's own outer show/hide (options.bar showing/hiding it) fades
     its dark surface (css/style.css's .modify-strip::before, grouped with
     the band) and its three buttons on two separately-delayed timings —
     surface first in, buttons first out — rather than one shared opacity,
     per the sitewide rule that a bar with text on it appears first and
     disappears last. No JS change needed for that split: is-hidden is
     still just added/removed here on the strip's own class list, same as
     always.
     Appended into the page's bar as soon as that bar exists (attach) — not
     on the first open, so opening never has to add it — then shown and
     hidden by that bar (options.bar), since only the bar knows how it hands
     its own content over. Hidden, it's inert, so nothing in it can be
     tabbed to. */
  function stripButton(className, label) {
    var btn = el("button", className);
    btn.type = "button";
    btn.appendChild(el("span", "modify-strip__label", label));
    return btn;
  }

  function stripBand() {
    var node = el("span", "modify-strip__band");
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  var strip = el("div", "modify-strip is-hidden");
  strip.setAttribute("aria-hidden", "true");
  strip.inert = true;
  var unselectBtn = stripButton("modify-strip__unselect", "Unselect");
  var saveBtn = stripButton("modify-strip__save", "Save");
  var undoBtn = stripButton("modify-strip__undo", "Undo");
  // After the buttons, so it paints over the label it inverts.
  var saveBand = stripBand();
  strip.appendChild(unselectBtn);
  strip.appendChild(saveBtn);
  strip.appendChild(undoBtn);
  strip.appendChild(saveBand);

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
    // The model's slide, and the image standing in for the model in it —
    // until the viewer is built, or for good if it can't be. iconImg is the
    // image of a product with no model at all.
    modelSlide: null,
    posterImg: null,
    iconImg: null,
    // Cancels a viewer build still waiting on the slide-in.
    cancelViewerBuild: null,
    cleanupTimer: null,
    // While the bar offers "Undo": { item, index, options, timer }.
    undo: null,
    // Cancels the bands' exit, while it's playing.
    cancelLeave: null
  };

  function assetFor(kind, metal) {
    var assets = state.product && state.product.assets;
    return (assets && assets[kind] && assets[kind][metal]) || "";
  }

  function iconSrc(metal) {
    return assetFor("icons", metal);
  }

  // What stands in for the model: its own default-pose capture — the very
  // image the viewer shows as its poster until the model has loaded, so
  // swapping one for the other doesn't move a pixel. The icon (framed
  // differently) only for a product without one.
  function posterSrc(metal) {
    return assetFor("fallback-img", metal) || iconSrc(metal);
  }

  // Calls fn once el's own `prop` transition ends — or after ms, if it never
  // does (a backgrounded tab). Returns a function that cancels it.
  function afterTransition(el, prop, ms, fn) {
    var done = false;
    var timer = setTimeout(finish, ms);
    function onEnd(e) {
      if (e.target === el && e.propertyName === prop) finish();
    }
    function cancel() {
      done = true;
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    }
    function finish() {
      if (done) return;
      cancel();
      fn();
    }
    el.addEventListener("transitionend", onEnd);
    return cancel;
  }

  // "modify" (Unselect | Save, each band at rest), "undo" (Unselect's band
  // across the whole bar, under "Undo", Save's drawn back into its edge),
  // "leaving" (that stretched band sliding back out to the left once the
  // offer is over — see leaveStrip) or "saved" (both bands sliding straight
  // out through their own edges — see leaveAfterSave).
  // Whichever buttons aren't part of the mode are inert, so a hidden one
  // can never take a click or a Tab. instant — or a strip that's out of
  // sight anyway — skips the motion: the next open starts on the modify
  // layout rather than playing a stretch backwards.
  function setStripMode(mode, instant) {
    instant = instant || strip.classList.contains("is-hidden");
    if (instant) strip.classList.add("is-instant");
    if (mode !== "leaving") {
      strip.classList.toggle("is-undo", mode === "undo");
      strip.classList.toggle("is-saved", mode === "saved");
    }
    strip.classList.toggle("is-leaving", mode === "leaving");
    unselectBtn.inert = mode !== "modify";
    saveBtn.inert = mode !== "modify";
    undoBtn.inert = mode !== "undo";
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

  // The "Undo" offer is over, taken or run out: its label fades out (the
  // band having already regressed into the right edge it's pinned to, back
  // when Unselect was tapped) and only once it's gone does the bar take its
  // own content back. At once if the strip isn't even showing (on
  // product.html a size typed during the offer takes the bar over as
  // "Add"). onDone runs once the bar has its content back — where focus has
  // to wait to move: until then the rest of the bar (the drawer toggle,
  // say) is inert under the strip.
  var LEAVE_MS = 400;
  // .is-saved's own real transition is longer than LEAVE_MS: the band's
  // width (var(--fade-standard)) doubles as the opacity leg's own delay,
  // plus the opacity leg itself (var(--fade-quick)) — 0.5s total (see
  // .modify-strip.is-saved .modify-strip__band in css/style.css).
  // LEAVE_MS's 400ms used to be less than that, so afterTransition()'s
  // fallback timer won the race before the band had actually finished
  // fading — handBack() fired early, visibly truncating it. Sized with
  // the same buffer convention as LEAVE_MS.
  var SAVE_LEAVE_MS = 600;

  function leaveStrip(bar, onDone) {
    exitStrip(bar, "leaving", undoBtn, "opacity", LEAVE_MS, onDone);
  }

  // Saved: nothing more to show, so the band that grew to fill the bar
  // (css/style.css's .is-saved rule) fades out before the bar takes its own
  // content back.
  function leaveAfterSave(bar) {
    exitStrip(bar, "saved", saveBand, "opacity", SAVE_LEAVE_MS);
  }

  // mode's own exit animation plays (css/style.css), and the bar gets its
  // content back once `property` finishes transitioning on `node` —
  // whichever is the last thing left moving. `ms` is that transition's own
  // fallback timeout, sized per caller since it isn't the same for both.
  function exitStrip(bar, mode, node, property, ms, onDone) {
    function handBack() {
      if (bar) bar.hide(strip);
      if (onDone) onDone();
    }
    if (!bar || strip.classList.contains("is-hidden")) {
      handBack();
      return;
    }
    setStripMode(mode);
    state.cancelLeave = afterTransition(node, property, ms, function () {
      state.cancelLeave = null;
      handBack();
    });
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
    // Re-tints the live model in place (no reload, no camera reset); the
    // images standing in for it need their own swap.
    if (state.modelHandle) state.modelHandle.applyMetal(metal);
    if (state.posterImg) state.posterImg.src = posterSrc(metal);
    if (state.iconImg) state.iconImg.src = iconSrc(metal);
  }

  /* ---- carousel slides ---------------------------------------------------
     Slide 1 is the model — its poster image to begin with (see
     scheduleViewer), or the icon for a product with no model — then the
     photos. No captions and no x-ray backdrop at this size. */
  function iconSlide() {
    var src = iconSrc(state.selectedMetal);
    if (!src) return null;
    var slide = window.EmjiveCarousel.imageSlide(src, state.product.name);
    state.iconImg = slide.querySelector("img");
    return slide;
  }

  // Sized exactly like the viewer that later takes its place (css/style.css,
  // .size-modal__model-poster), its image placed like the viewer's own
  // poster.
  function posterBox() {
    var box = el("div", "size-modal__model-poster");
    var img = el("img");
    img.src = posterSrc(state.selectedMetal);
    img.alt = state.product.name || "";
    img.draggable = false;
    box.appendChild(img);
    state.posterImg = img;
    return box;
  }

  function buildSlides() {
    var product = state.product;
    track.innerHTML = "";
    state.modelSlide = null;
    state.posterImg = null;
    state.iconImg = null;

    if (product.assets && product.assets.model) {
      // Smaller than the slide (css/style.css's --model rule), which leaves
      // room around the model to page the carousel from — a drag that
      // starts on the model itself rotates it instead.
      var modelSlide = el("div", "product-carousel__slide product-carousel__slide--model");
      modelSlide.appendChild(posterBox());
      track.appendChild(modelSlide);
      state.modelSlide = modelSlide;
    } else {
      var fallback = iconSlide();
      if (fallback) track.appendChild(fallback);
    }

    ((product.assets && product.assets.photos) || []).forEach(function (photo) {
      track.appendChild(window.EmjiveCarousel.imageSlide(photo.src, product.name));
    });

    carouselFrame.classList.toggle("product-carousel--single", track.children.length <= 1);
  }

  // The sheet goes up first and the model follows. Building a viewer means a
  // fresh WebGL context and a synchronous shader compile (js/three-viewer.js),
  // which can hold a phone's main thread long enough that a sheet waiting on
  // it looks like a tap that did nothing. So the model's slide shows its
  // poster image while the sheet slides in, and the viewer is only built
  // once it has — the viewer's own poster is that same image in that same
  // box, so nothing moves. The viewer then puts a loader over that poster
  // while the model loads and pops in once the loader has finished its cycle
  // and left (js/loader.js; options.loader in js/three-viewer.js).
  var SLIDE_IN_MS = 400;

  function scheduleViewer() {
    if (!state.modelSlide || !window.EmjiveModelViewer) return;
    state.cancelViewerBuild = afterTransition(sheet, "transform", SLIDE_IN_MS, function () {
      state.cancelViewerBuild = null;
      buildViewer();
    });
  }

  function buildViewer() {
    var slide = state.modelSlide;
    if (!state.isOpen || !slide || state.modelHandle) return;
    var handle = window.EmjiveModelViewer(state.product, state.selectedMetal, {
      hdri: window.EmjiveSeries.hdriPath(state.slug),
      // Same cap the homepage grid uses: iOS Safari budgets canvas memory
      // for the page as a whole, and this sheet can open over the grid.
      maxPixelRatio: 1.5,
      // Same reason as product.js: the viewer's box has no visible edge.
      loaderBleed: true,
      onError: function () { restorePoster(handle); }
    });
    // No WebGL context to be had: the poster simply stays.
    if (!handle) return;
    state.modelHandle = handle;
    state.posterImg = null;
    slide.innerHTML = "";
    slide.appendChild(handle.el);
  }

  // A load failure or a lost WebGL context, possibly well after the model
  // was on screen: the poster takes the model's place again — same slide,
  // same box (the slide's place in the track is what the carousel's
  // geometry is built on). Ignores a handle that's no longer the live one.
  function restorePoster(handle) {
    if (!handle || handle !== state.modelHandle) return;
    handle.dispose();
    state.modelHandle = null;
    var slide = state.modelSlide;
    if (!slide) return;
    slide.innerHTML = "";
    slide.appendChild(posterBox());
  }

  function disposeViewer() {
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = null;
    if (state.cancelViewerBuild) {
      state.cancelViewerBuild();
      state.cancelViewerBuild = null;
    }
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
    state.modelSlide = null;
    state.posterImg = null;
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
    // The strip stays up while the band grows to fill it and fades; the bar
    // gets its own content back after that (leaveAfterSave).
    var bar = state.options.bar;
    close({ keepStrip: true });
    leaveAfterSave(bar);
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
    leaveStrip(pending.options.bar, function () {
      window.EmjiveFocusTrap.focus(function () {
        return resolve(pending.options.returnFocus) || resolve(pending.options.fallbackFocus);
      });
    });
  }

  // The offer ran out (or, immediate, the page is going away): the removal
  // stands.
  function expireUndo(immediate) {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    // Read before the strip goes inert, which drops focus off it.
    var hadFocus = strip.contains(document.activeElement);
    function refocus() {
      if (!hadFocus) return;
      window.EmjiveFocusTrap.focus(function () { return resolve(pending.options.fallbackFocus); });
    }
    if (immediate === true) {
      if (pending.options.bar) pending.options.bar.hide(strip);
      refocus();
    } else {
      leaveStrip(pending.options.bar, refocus);
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
    commitUndo();
    // Bands still sliding out after the last Save or Undo: the strip is
    // about to be needed again, so it snaps straight back to Unselect | Save.
    var cutLeaveShort = !!state.cancelLeave;
    if (cutLeaveShort) {
      state.cancelLeave();
      state.cancelLeave = null;
    }
    // Before building anything — js/main.js drops a grid viewer to free the
    // WebGL slot the model is about to take.
    window.dispatchEvent(new CustomEvent("emjive:modify-open"));
    // A reopen inside the previous close's slide-out: tear that viewer down
    // now rather than letting a timer do it (and signal a close) later.
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
    // Normally already in place (attach); mounted before the mode is set
    // either way, so it's laid out (see mountStrip) before anything on it
    // starts to move.
    mountStrip(options.bar);
    setStripMode("modify", cutLeaveShort);
    syncSave();

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    state.isOpen = true;
    carousel.sync(true);

    // After .is-open — the modal is visibility: hidden until then, and
    // focus() on a hidden element is a no-op. The trap also freezes the
    // page behind the sheet until release().
    window.EmjiveFocusTrap.activate(modal, {
      include: strip,
      returnFocus: function () { return resolve(state.options.returnFocus); },
      fallbackFocus: function () { return resolve(state.options.fallbackFocus); },
      onEscape: function () { close(); }
    });
    if (options.bar) options.bar.show(strip);
    if (options.onOpen) options.onOpen();
    scheduleViewer();
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
    if (!opts.keepStrip && options.bar) options.bar.hide(strip);
    window.EmjiveFocusTrap.release(opts.focus);
    // A viewer not built yet never will be now; one that was goes with the
    // rest after the slide-out.
    if (state.cancelViewerBuild) {
      state.cancelViewerBuild();
      state.cancelViewerBuild = null;
    }
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
    // Already up: the only row still in view (or reachable) is the one it's
    // showing, and reopening would throw away picks not saved yet.
    if (state.isOpen) return;
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

  // The products behind everything already selected, fetched once the page
  // has loaded, so opening the sheet — which needs the product for its
  // photos, its model and its per-metal prices — doesn't have to wait on the
  // network. The pages that list products have them already; this is for
  // the order page and the pages that don't, where the first Modify used to
  // wait for products.json. A failure is left for open() to report.
  function prefetchProducts() {
    window.EmjiveSeries.ready.then(function () {
      var seen = {};
      window.EmjiveSelection.getSelection().forEach(function (item) {
        var slug = item.series || window.EmjiveSeries.slug;
        if (!slug || seen[slug]) return;
        seen[slug] = true;
        window.EmjiveSeries.loadProducts(slug).catch(function () {});
      });
    }).catch(function () {});
  }
  if (document.readyState === "complete") prefetchProducts();
  else window.addEventListener("load", prefetchProducts);

  // Leaving the page with the sheet up (Back, say): close it, and free the
  // viewer right away rather than after the slide-out — a page kept in the
  // back/forward cache is still alive, and would otherwise hold its WebGL
  // context the whole time (same reasoning as js/main.js's grid and
  // js/product.js's carousel). An "Undo" still on offer ends there too, so
  // a page restored from that cache doesn't come back offering one.
  window.addEventListener("pagehide", function () {
    if (state.isOpen) close();
    if (state.cleanupTimer) cleanup();
    expireUndo(true);
  });

  window.EmjiveModifyModal = {
    open: open,
    isOpen: function () { return state.isOpen; },
    // Called by each page's bar as soon as it exists (js/selection-bar.js,
    // js/selection-page.js), with the same { el, show, hide } it later
    // passes to open(): the strip goes into that bar right away, hidden,
    // instead of in the middle of the first open.
    attach: mountStrip
  };
})();
