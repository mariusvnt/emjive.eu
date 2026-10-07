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
     - the size field, pre-filled with the item's current size, with the size
       guide's button inline to its right;
     - the size guide, which opens at the bottom of the sheet (it grows
       upward); the button, or a click anywhere else, closes it.
     Laid out as the product page's specs stage is: each row a label, a gap and
     its control, anchored to the left, the metal picker's squares side by
     side with the metal's name to their right.

   Its buttons aren't in it: while it's open, the page's bar turns into
   them — the "strip" built below, handed to the bar through options.bar:
   Unselect on the bar's left quarter and Save on the rest (inactive while
   the size field holds nothing orderable), each marked by an invert band
   like the drawer rows', coming in from its own edge of the screen.
   Unselect removes the item and the sheet slides away; the strip gives the
   bar back to its own content, and the item's own line in the list (the
   drawer's, or the order page's) stays put as "Undo" for four seconds —
   js/order-rows.js's undo line: the left quarter of the line, an invert
   band growing in across it from the left edge. Tapping Undo puts the item
   back where it was; left alone, the line closes. On Save, both bands
   simply slide out through their own edges.

   window.EmjiveModifyModal = { open(item, index, options), isOpen() }.
   options:
     bar            the page's bar, as { el, show(stripEl), hide(stripEl) }:
                    the strip is appended into el, and show/hide swap it
                    with the bar's own content however that bar sequences
                    its labels
     onPreview(index, values)
                    the sheet's draft changed: the list(s) switch that row,
                    at once, to { metal, size, price, image } without storing
                    anything — and values is null when the sheet is dismissed
                    unsaved, putting the row back
     offerUndo(index, handlers)
                    the list holds the unselected row's line open as its
                    "Undo" (js/order-rows.js's offerUndo), returning the
                    handle { held(), button(), leave(done), drop() };
                    handlers is { onUndo(), onGone() }. Without it, an
                    Unselect is final
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
  // How long the list offers "Undo" after an Unselect, from the Unselect
  // itself — whatever the pointer or keyboard focus is doing.
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

  var materialRow = el("div", "size-modal__custom-row size-modal__custom-row--material");
  var materialLabel = el("span", "size-modal__custom-label", "Material");
  materialLabel.setAttribute("aria-hidden", "true");
  var materialField = el("div", "size-modal__custom-field");
  var metalsRow = el("div", "product-metals");
  materialField.appendChild(metalsRow);
  materialRow.appendChild(materialLabel);
  materialRow.appendChild(materialField);

  var sizeRow = el("div", "size-modal__custom-row");
  var sizeLabel = el("label", "size-modal__custom-label", "Size");
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
  // The size guide's "?", outside the field's top right corner.
  var guideToggle = el("button", "size-modal__guide-toggle", "?");
  guideToggle.type = "button";
  guideToggle.setAttribute("aria-label", "Size guide");
  guideToggle.hidden = true;
  guideToggle.setAttribute("aria-expanded", "false");
  guideToggle.setAttribute("aria-controls", "modifyModalGuide");
  sizeUnderline.appendChild(guideToggle);
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeField);

  content.appendChild(materialRow);
  content.appendChild(sizeRow);

  // The guide itself is the panel's last row: it opens at the bottom of the
  // sheet, which grows upward while the bar stays put.
  var guide = el("div", "size-modal__guide");
  var guidePanel = el("div", "size-modal__guide-panel");
  guidePanel.id = "modifyModalGuide";
  var guideInner = el("div", "size-modal__guide-panel-inner");
  var guideContent = el("div", "size-modal__guide-content size-guide");
  guideInner.appendChild(guideContent);
  guidePanel.appendChild(guideInner);
  guide.appendChild(guidePanel);

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
     .modify-strip): one dark, full-bleed layer over the bar holding two
     buttons, in reading (and Tab) order — Unselect (the left quarter) and
     Save (the rest) — each a plain --white label on the strip's own
     --black-bg, plus one invert band (.modify-strip__band), the same
     backdrop-filter band the drawer rows carry, sized to Save's own right
     three quarters at rest so Save's label alone reads dark on a light band.
     Tapping Save grows the band to the full bar width, then fades it out,
     before the bar takes its own content back (leaveAfterSave). Tapping
     Unselect just hides the strip, like any dismissal — "Undo" is not part
     of it: it lives in the list, on the unselected item's own line.
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
  function stripButton(className, labelClass, label) {
    var btn = el("button", className);
    btn.type = "button";
    btn.appendChild(el("span", labelClass, label));
    return btn;
  }

  function stripBand(className) {
    var node = el("span", className);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  var strip = el("div", "modify-strip is-hidden");
  strip.setAttribute("aria-hidden", "true");
  strip.inert = true;
  var unselectBtn = stripButton("modify-strip__unselect", "modify-strip__label", "Unselect");
  var saveBtn = stripButton("modify-strip__save", "modify-strip__label", "Save");
  // After the buttons, so it paints over the label it inverts.
  var saveBand = stripBand("modify-strip__band");
  strip.appendChild(unselectBtn);
  strip.appendChild(saveBtn);
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
    // While the list offers "Undo": { item, index, options, handle, timer }.
    undo: null,
    // Cancels the Save band's exit, while it's playing.
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

  // "modify" (Unselect | Save, each band at rest) or "saved" (both bands
  // sliding straight out through their own edges — see leaveAfterSave).
  // Whichever buttons aren't part of the mode are inert, so a hidden one
  // can never take a click or a Tab. instant — or a strip that's out of
  // sight anyway — skips the motion: the next open starts on the modify
  // layout rather than playing a slide backwards.
  function setStripMode(mode, instant) {
    instant = instant || strip.classList.contains("is-hidden");
    if (instant) strip.classList.add("is-instant");
    strip.classList.toggle("is-saved", mode === "saved");
    unselectBtn.inert = mode !== "modify";
    saveBtn.inert = mode !== "modify";
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

  // .is-saved's own real transition: the band's width (var(--fade-standard))
  // doubles as the opacity leg's own delay, plus the opacity leg itself
  // (var(--fade-quick)) — 0.5s total (see .modify-strip.is-saved
  // .modify-strip__band in css/style.css). The fallback timeout that backs
  // up its transitionend carries a buffer on top of that, so it can't win
  // the race before the band has actually finished fading and visibly
  // truncate it.
  var SAVE_LEAVE_MS = 600;

  // Saved: nothing more to show, so the band that grew to fill the bar
  // (css/style.css's .is-saved rule) fades out, and only then does the bar
  // take its own content back. At once if the strip isn't even showing.
  function leaveAfterSave(bar) {
    function handBack() {
      if (bar) bar.hide(strip);
    }
    if (!bar || strip.classList.contains("is-hidden")) {
      handBack();
      return;
    }
    setStripMode("saved");
    state.cancelLeave = afterTransition(saveBand, "opacity", SAVE_LEAVE_MS, function () {
      state.cancelLeave = null;
      handBack();
    });
  }

  /* ---- metal picker ------------------------------------------------------
     Re-mounted per open (the metal list is global, but the selected one
     isn't); js/metal-picker.js then updates it in place on each pick, so
     keyboard focus stays on the bar just pressed. */
  function renderMetalOptions() {
    window.EmjiveMetalPicker.mount(metalsRow, {
      metals: window.EmjiveSeries.metals || [],
      selected: state.selectedMetal,
      row: true,
      onSelect: selectMetal
    });
  }

  // The item as the sheet would save it right now. The size is the field's
  // when that's orderable, else the item's own — a half-typed or emptied
  // field mustn't blank the row's label under the sheet.
  function draftValues() {
    var sel = window.EmjiveSelection;
    var details = (state.product["per-metal-specs"] && state.product["per-metal-specs"][state.selectedMetal]) || {};
    return {
      metal: state.selectedMetal,
      size: sel.isValidSize(sizeInput.value) ? sel.normalizeSize(sizeInput.value) : state.item.size,
      price: details.price || 0,
      image: iconSrc(state.selectedMetal)
    };
  }

  // The row under the sheet follows the draft live (options.onPreview);
  // nothing is stored until Save.
  function previewDraft() {
    if (state.options.onPreview) state.options.onPreview(state.index, draftValues());
  }

  // Re-tints the live model in place (no reload, no camera reset) — after
  // the row's new label has been painted, not before: a re-tint is a fresh
  // material per mesh and a re-render, heavy enough on an iPhone to hold the
  // next frame (and the label with it). rAF runs ahead of that frame's
  // paint, the timeout right after it; picks made meanwhile just retint to
  // whichever metal is current.
  var tintQueued = false;
  function tintAfterPaint() {
    if (tintQueued) return;
    tintQueued = true;
    requestAnimationFrame(function () {
      setTimeout(function () {
        tintQueued = false;
        if (state.modelHandle) state.modelHandle.applyMetal(state.selectedMetal);
      }, 0);
    });
  }

  function selectMetal(metal) {
    if (metal === state.selectedMetal) return;
    state.selectedMetal = metal;
    previewDraft();
    // The images standing in for the model need their own swap.
    if (state.posterImg) state.posterImg.src = posterSrc(metal);
    if (state.iconImg) state.iconImg.src = iconSrc(metal);
    tintAfterPaint();
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
  // while the model loads and pops in the moment it is ready, the loader
  // finishing its crossing over the live model (js/loader.js; options.loader
  // in js/three-viewer.js).
  var SLIDE_IN_MS = 400;

  function scheduleViewer() {
    if (!state.modelSlide) return;
    if (typeof window.EmjiveModelViewer !== "function") {
      // The viewer is a lazy chunk (js/viewer-entry.js) and this may be the
      // first thing on the page to want it: fetch it while the sheet slides
      // in, then come back. A failed download leaves the poster, which is
      // what a browser with no WebGL gets anyway.
      if (!window.EmjiveLoadViewer) return;
      var token = state.openToken;
      window.EmjiveLoadViewer().then(function () {
        if (state.isOpen && token === state.openToken) scheduleViewer();
      }, function () {});
      return;
    }
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

  // quiet: Enter in the field saves from the keyboard, and the ring that
  // would then appear on the row focus goes back to reads as a glitch — see
  // js/focus-trap.js.
  function save(quiet) {
    if (!state.isOpen || !window.EmjiveSelection.isValidSize(sizeInput.value)) return;
    window.EmjiveSelection.updateItem(state.index, draftValues());
    // The strip stays up while the band grows to fill it and fades; the bar
    // gets its own content back after that (leaveAfterSave). The row already
    // shows what was saved (previewDraft), so it isn't put back.
    var bar = state.options.bar;
    close({ keepStrip: true, keepPreview: true, quiet: quiet === true });
    leaveAfterSave(bar);
  }

  // Removed from storage right away while the sheet slides away and the
  // strip hands the bar back. The row isn't let go of, though: the list holds
  // its line open as "Undo" (options.offerUndo) — asked for before the
  // removal, which is what the list then answers by keeping the row. The
  // item itself (as stored, not as edited here) is kept aside for the Undo,
  // along with the options of the session it came from: the offer outlives
  // the sheet. Focus goes to the line's Undo, since the button it was on is
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
    var handle = options.offerUndo ? options.offerUndo(index, {
      onUndo: undo,
      onGone: function () { forgetUndo(handle); }
    }) : null;
    window.EmjiveSelection.removeItem(index);
    var offered = !!handle && handle.held();
    close({ keepPreview: true, focus: offered ? handle.button() : undefined });
    if (!offered) return;
    state.undo = {
      item: removed,
      index: index,
      options: options,
      handle: handle,
      timer: setTimeout(expireUndo, UNDO_MS)
    };
  }

  // Back where it was — clamped, in case the list got shorter meanwhile.
  // The list finds its held line in the insert and brings it back to life.
  function undo() {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    var sel = window.EmjiveSelection;
    sel.insertItem(Math.min(pending.index, sel.getSelection().length), pending.item);
    window.EmjiveFocusTrap.focus(function () {
      return resolve(pending.options.returnFocus) || resolve(pending.options.fallbackFocus);
    });
  }

  // The list let go of the held line by itself (rebuilt under it, say): the
  // offer is over, the removal stands.
  function forgetUndo(handle) {
    if (!state.undo || state.undo.handle !== handle) return;
    clearTimeout(state.undo.timer);
    state.undo = null;
  }

  // The offer ran out (or, immediate, the page is going away): the removal
  // stands, and the line closes. Focus, if Undo had it, goes to the
  // fallback once the line is gone.
  function expireUndo(immediate) {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    var hadFocus = pending.handle.button() === document.activeElement;
    if (immediate === true) {
      pending.handle.drop();
      return;
    }
    pending.handle.leave(function () {
      if (!hadFocus) return;
      window.EmjiveFocusTrap.focus(function () { return resolve(pending.options.fallbackFocus); });
    });
  }

  // Another Modify opened while "Undo" was still on offer: the removal
  // stands, and the line simply closes.
  function dropUndo() {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    pending.handle.drop();
  }

  saveBtn.addEventListener("click", save);
  unselectBtn.addEventListener("click", unselect);

  // Same filter as product.html's size sheet (js/selection.js), written
  // back only when it changed something so the caret doesn't jump.
  sizeInput.addEventListener("input", function () {
    var cleaned = window.EmjiveSelection.sanitizeSizeInput(sizeInput.value);
    if (cleaned !== sizeInput.value) sizeInput.value = cleaned;
    syncSave();
    previewDraft();
  });

  // Enter saves — the same as the bar's Save, one Tab stop further away.
  sizeInput.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    save(true);
  });

  var sizeGuide = window.EmjiveSelection.wireSizeGuide({ toggle: guideToggle, panel: guidePanel });

  backdrop.addEventListener("click", function () { close(); });

  /* ---- open / close ------------------------------------------------------- */
  function show(item, index, product, slug, options) {
    dropUndo();
    // The band still sliding out after the last Save: the strip is about to
    // be needed again, so it snaps straight back to Unselect | Save.
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

    // Every metal's icon and poster fetched and decoded now, so a pick
    // swaps the row's icon and the carousel's stand-in at once.
    var assets = product.assets || {};
    window.EmjiveOrderRows.preload(
      Object.keys(assets.icons || {}).map(function (m) { return assets.icons[m]; })
        .concat(Object.keys(assets["fallback-img"] || {}).map(function (m) { return assets["fallback-img"][m]; }))
    );
    renderMetalOptions();
    sizeUnit.textContent = window.EmjiveSeries.categoryInfo(item.category).unit || "";
    sizeInput.value = window.EmjiveSelection.normalizeSize(item.size);
    sizeGuide.close();
    guideToggle.hidden = !window.EmjiveSelection.fillSizeGuide(guideContent, window.EmjiveSeries.categoryInfo(item.category)["size-guide"]);
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

  // keepStrip: the strip stays up (a Save, whose band is still to play out).
  // keepPreview: the row keeps showing the draft — a Save, which stores it,
  // or an Unselect, whose row is leaving; otherwise the row goes back
  // to what's stored.
  // focus: where focus goes instead of returnFocus.
  // quiet: it lands there without a focus ring (an Enter save).
  function close(opts) {
    if (!state.isOpen) return;
    opts = opts || {};
    state.isOpen = false;
    var options = state.options;
    if (!opts.keepPreview && options.onPreview) options.onPreview(state.index, null);
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (!opts.keepStrip && options.bar) options.bar.hide(strip);
    window.EmjiveFocusTrap.release(opts.focus, opts.quiet === true);
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
  // same "can't do that right now" notice (EmjiveOrderRows.notice) the
  // checkout button stub uses.
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
            window.EmjiveOrderRows.notice("This item listing couldn't be found, please reload.");
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
        window.EmjiveOrderRows.notice("This item listing couldn't be found, please reload.");
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
