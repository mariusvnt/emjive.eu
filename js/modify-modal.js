// The Modify sheet, on every page: opened by tapping a row in the order list
// (js/selection-page.js) or the floating bar's drawer (js/selection-bar.js).
// A bottom sheet (.size-modal--drawer) above the page's bar holding the live
// model (its poster until the sheet has slid in, scheduleViewer) with a
// button named after the item leading to its page, and the product page's
// dials (js/option-dial.js): shape (with more than one design), material,
// size with "Find my size".
//
// Its buttons are a strip the page's bar turns into (options.bar): Remove |
// Save. Remove takes the item out and the list keeps its row as an Undo line
// for UNDO_MS (js/order-rows.js offerUndo). Save needs a size within the
// product's "size-range".
//
// window.EmjiveModifyModal = { open(item, index, options), isOpen(), attach(bar) }
// options:
//   bar                         { el, show(strip), hide(strip) }: the strip goes
//                               into el; the bar sequences the swap
//   onPreview(index, values)    the draft changed: show { name, metal, size,
//                               price, image } on the row without storing (null: revert)
//   offerUndo(index, handlers)  hold the row as an Undo line (js/order-rows.js);
//                               without it a Remove is final
//   onOpen(item), onClose()     the sheet is up / has closed
//   returnFocus, fallbackFocus  elements or functions; fallbackFocus also
//                               catches focus left on an expired Undo
// Changes go through js/selection.js, whose "emjive:selection-changed" the
// lists follow. Dispatches "emjive:modify-open" before building (js/product.js
// closes its review sheet, js/gallery-stack.js frees its focused viewer's
// WebGL context) and "emjive:modify-close" once the viewer is disposed.

(function () {
  "use strict";

  if (!window.EmjiveSelection || !window.EmjiveSeries || !window.EmjiveOptionDial) return;

  // The sheet's 0.3s slide-out plus a margin: dispose the viewer only once out
  // of sight, or the model blanks mid-slide.
  var SLIDE_OUT_MS = 350;
  // The Undo offer's length, from the Remove, regardless of focus or pointer.
  var UNDO_MS = 4000;

  var H = window.EmjiveHelpers;
  var el = H.el;

  // An element, or a function returning one.
  function resolve(want) {
    return typeof want === "function" ? want() : want;
  }

  /* ---- DOM, built once ----
     role/aria-* on .size-modal, not the panel: the model's frame is the
     panel's sibling, and js/focus-trap.js traps the whole modal. tabindex -1
     lets it take focus so its label is read first. */
  var modal = el("div", "size-modal size-modal--drawer size-modal--modify");
  modal.id = "modifyModal";
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Modify selection");
  modal.tabIndex = -1;

  var backdrop = el("div", "size-modal__backdrop");

  // The model's frame, its top half above the sheet; the slot holds one slide
  // per open (buildSlide).
  var modelFrame = el("div", "size-modal__frame");
  var slot = el("div", "size-modal__slot");
  modelFrame.appendChild(slot);
  var pageToggle = el("button", "size-modal__page-toggle");
  pageToggle.type = "button";
  pageToggle.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12 H21 M14 5 L21 12 L14 19" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');
  var pageLabel = el("span", "size-modal__page-label");
  pageToggle.appendChild(pageLabel);
  modelFrame.appendChild(pageToggle);

  var panel = el("div", "size-modal__panel");
  var content = el("div", "size-modal__content");
  // While a dial is open, its active option's name (showDialName).
  var dialName = el("p", "size-modal__dial-name");
  dialName.setAttribute("aria-hidden", "true");
  content.appendChild(dialName);
  // The dials, built per open (mountDials), and under them the size dial's
  // "Find my size".
  var config = el("div", "product-config size-modal__config");
  var dials = el("div", "product-dials");
  config.appendChild(dials);
  content.appendChild(config);
  panel.appendChild(content);

  var sheet = el("div", "size-modal__sheet");
  sheet.appendChild(modelFrame);
  sheet.appendChild(panel);

  modal.appendChild(backdrop);
  modal.appendChild(sheet);
  document.body.appendChild(modal);

  /* ---- the bar strip ----
     What the page's bar turns into while the sheet is open (.modify-strip):
     Remove (left quarter) and Save (the rest), with an invert band under
     Save's label. Save grows the band across the bar and fades it before the
     bar gets its content back (leaveAfterSave); Remove just hides the strip.
     Mounted into the bar as soon as it exists (attach), shown and hidden by
     the bar, inert while hidden. */
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
  var removeBtn = stripButton("modify-strip__remove", "modify-strip__label", "Remove");
  var saveBtn = stripButton("modify-strip__save", "modify-strip__label", "Save");
  // After the buttons, so it paints over the label it inverts.
  var saveBand = stripBand("modify-strip__band");
  strip.appendChild(removeBtn);
  strip.appendChild(saveBtn);
  strip.appendChild(saveBand);

  var state = {
    isOpen: false,
    // Bumped per open() so a slow fetch from an earlier click can't open over a later one.
    openToken: 0,
    item: null,
    index: null,
    // The catalog product, and the product as the chosen design (state.product,
    // EmjiveSeries.resolveDesign), which the model, icons and name follow.
    base: null,
    product: null,
    designKey: "",
    slug: null,
    selectedMetal: null,
    // The chosen size, mm.
    sizeMm: H.REFERENCE_SIZE_MM,
    // The dials (js/option-dial.js); shapeDial null without one, sizeDial
    // null for a unitless category.
    shapeDial: null,
    sizeDial: null,
    options: {},
    modelHandle: null,
    // The model's slide (in the slot) and the image standing in for the model
    // until the viewer is built (or for good); iconImg for a product without a model.
    modelSlide: null,
    posterImg: null,
    iconImg: null,
    // Cancels a viewer build waiting on the slide-in.
    cancelViewerBuild: null,
    cleanupTimer: null,
    // While the list offers Undo: { item, index, options, handle, timer }.
    undo: null,
    // Cancels the Save band's exit while it plays.
    cancelLeave: null
  };

  function iconSrc(metal) {
    return H.assetFor(state.product, "icons", metal);
  }

  // The viewer's own poster image, so the swap moves nothing; the icon only without one.
  function posterSrc(metal) {
    return H.posterFor(state.product, metal);
  }

  function itemName() {
    return state.product.designName || state.base.name || "";
  }

  // "modify" (Remove | Save) or "saved" (band growing and fading, buttons
  // inert). `instant`, or a hidden strip, skips the motion so the next open
  // starts on its own layout.
  function setStripMode(mode, instant) {
    instant = instant || strip.classList.contains("is-hidden");
    if (instant) strip.classList.add("is-instant");
    strip.classList.toggle("is-saved", mode === "saved");
    removeBtn.inert = mode !== "modify";
    saveBtn.inert = mode !== "modify";
    if (instant) {
      void strip.offsetWidth;
      strip.classList.remove("is-instant");
    }
  }

  function mountStrip(bar) {
    if (!bar || strip.parentNode === bar.el) return;
    bar.el.appendChild(strip);
    // Laid out while hidden, so the first reveal fades in.
    void strip.offsetWidth;
  }

  // The .is-saved transition's total length (band width, then opacity:
  // 0.5s, css/style.css) plus a buffer, so the fallback never cuts it short.
  var SAVE_LEAVE_MS = 600;

  // After a Save the grown band fades, then the bar gets its content back; at
  // once if the strip isn't showing.
  function leaveAfterSave(bar) {
    function handBack() {
      if (bar) bar.hide(strip);
    }
    if (!bar || strip.classList.contains("is-hidden")) {
      handBack();
      return;
    }
    setStripMode("saved");
    state.cancelLeave = H.afterTransition(saveBand, "opacity", SAVE_LEAVE_MS, function () {
      state.cancelLeave = null;
      handBack();
    });
  }

  /* ---- the dials: built per open, each on a fresh host (a dial's listeners
     live on its host) ---- */
  function dialHost() {
    var host = el("div");
    dials.appendChild(host);
    return host;
  }

  function shapeOptions() {
    return state.base.designs.list.map(function (design) {
      return {
        key: design.key,
        label: design.key,
        preview: function () {
          var img = el("img", "product-dial__icon");
          img.alt = "";
          img.decoding = "async";
          img.draggable = false;
          var src = H.assetFor(window.EmjiveSeries.resolveDesign(state.base, design.key).view, "icons", state.selectedMetal);
          if (src) img.src = src;
          return img;
        }
      };
    });
  }

  // The open dial's option name, held a moment after a pick.
  var showDialName = window.EmjiveOptionDial.nameShower(dialName);

  function mountDials() {
    if (state.sizeDial && state.sizeDial.finder) config.removeChild(state.sizeDial.finder);
    dials.innerHTML = "";
    showDialName("");
    var designs = state.base.designs;
    state.shapeDial = designs && Array.isArray(designs.list) && designs.list.length > 1
      ? window.EmjiveOptionDial.mount(dialHost(), {
        name: "Shape",
        options: shapeOptions(),
        selected: state.designKey,
        onSelect: selectDesign,
        onShow: showDialName
      })
      : null;
    window.EmjiveOptionDial.mount(dialHost(), {
      name: "Material",
      options: (window.EmjiveSeries.metals || []).map(function (metal) {
        return {
          key: metal,
          label: metal,
          // The swatch as css/style.css draws it.
          preview: function () {
            var swatch = el("span", "product-dial__swatch");
            swatch.setAttribute("data-metal", metal);
            return swatch;
          }
        };
      }),
      selected: state.selectedMetal,
      onSelect: selectMetal,
      onShow: showDialName
    });
    state.sizeDial = null;
    var info = window.EmjiveSeries.categoryInfo(state.base.category);
    if (!info.unit) return;
    // "Find my size" with the category's size guide; none without one. Its
    // result goes in as if dialled.
    var guide = info["size-guide"];
    var range = H.sizeRange(state.base);
    var dial = window.EmjiveOptionDial.mountSize(dialHost(), {
      range: range,
      onChange: selectSize,
      onShow: showDialName,
      onFind: window.EmjiveSizeFinder && guide && guide.rows && guide.rows.length ? function () {
        window.EmjiveSizeFinder.open({
          guide: guide,
          returnFocus: dial.finder,
          onFill: function (size) {
            var mm = H.clamp(Math.round(parseFloat(window.EmjiveSelection.normalizeSize(size)) * 10) / 10, range.min, range.max);
            if (!isFinite(mm)) return;
            dial.set(mm, true);
            selectSize(mm);
          }
        });
      } : null
    });
    if (dial.finder) config.appendChild(dial.finder);
    dial.set(state.sizeMm, true);
    state.sizeDial = dial;
  }

  // The item as Save would store it now.
  function draftValues() {
    var sel = window.EmjiveSelection;
    var size = sel.normalizeSize(String(state.sizeMm));
    var values = {
      name: itemName(),
      metal: state.selectedMetal,
      size: size,
      price: sel.priceAt(state.product, state.selectedMetal, size),
      image: iconSrc(state.selectedMetal)
    };
    if (state.base.designs) values.design = state.designKey;
    return values;
  }

  // The row follows the draft live; nothing is stored until Save.
  function previewDraft() {
    if (state.options.onPreview) state.options.onPreview(state.index, draftValues());
  }

  // The stand-in images follow the design and metal, a metal crossfading in.
  function syncStandIns(fade) {
    var poster = posterSrc(state.selectedMetal);
    var icon = iconSrc(state.selectedMetal);
    if (state.posterImg) {
      if (fade) H.crossfadeSrc(state.posterImg, poster);
      else state.posterImg.src = poster;
    }
    if (state.iconImg) {
      if (fade) H.crossfadeSrc(state.iconImg, icon);
      else state.iconImg.src = icon;
    }
  }

  function selectMetal(metal) {
    if (metal === state.selectedMetal) return;
    state.selectedMetal = metal;
    previewDraft();
    syncStandIns(true);
    // The shape previews are the designs in this metal.
    if (state.shapeDial) state.shapeDial.setOptions(shapeOptions());
    // The model eases into the metal.
    if (state.modelHandle) state.modelHandle.applyMetal(metal, true);
  }

  // Another design: the model swaps in place, camera kept (setProduct).
  function selectDesign(key) {
    if (key === state.designKey) return;
    state.designKey = key;
    state.product = window.EmjiveSeries.resolveDesign(state.base, key).view;
    pageLabel.textContent = itemName();
    previewDraft();
    syncStandIns();
    if (state.modelHandle && state.modelHandle.setProduct) state.modelHandle.setProduct(state.product);
  }

  function selectSize(mm) {
    state.sizeMm = mm;
    syncSave();
    previewDraft();
    if (state.modelHandle) state.modelHandle.setSize(mm);
  }

  /* ---- the model's slide: the poster (scheduleViewer), or the icon without a model ---- */
  function iconSlide() {
    var src = iconSrc(state.selectedMetal);
    if (!src) return null;
    var slide = el("div", "size-modal__slide");
    var img = el("img");
    img.src = src;
    img.alt = state.product.name || "";
    img.draggable = false;
    slide.appendChild(img);
    if (window.EmjiveLoader) window.EmjiveLoader.cover(slide, H.imageReady(img));
    state.iconImg = img;
    return slide;
  }

  // Sized and placed like the viewer that replaces it (.size-modal__model-poster).
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

  function buildSlide() {
    var product = state.product;
    slot.innerHTML = "";
    state.modelSlide = null;
    state.posterImg = null;
    state.iconImg = null;

    if (product.assets && product.assets.model) {
      // Smaller than the slot (the --model rule).
      var modelSlide = el("div", "size-modal__slide size-modal__slide--model");
      modelSlide.appendChild(posterBox());
      slot.appendChild(modelSlide);
      state.modelSlide = modelSlide;
    } else {
      var fallback = iconSlide();
      if (fallback) slot.appendChild(fallback);
    }
  }

  // Already on that product's page: close and scroll to the top instead.
  function goToPage() {
    var href = window.EmjiveSeries.productHref(state.base);
    if (window.location.pathname.replace(/\/+$/, "") === href) {
      close();
      window.scrollTo({ top: 0, left: 0 });
      return;
    }
    window.location.href = href;
  }
  pageToggle.addEventListener("click", goToPage);

  // The sheet goes up first: building a viewer (new WebGL context, synchronous
  // shader compile) can stall a phone long enough for the tap to look ignored.
  // The poster shows during the slide-in and the viewer is built after; its own
  // poster is the same image in the same box, so nothing moves.
  var SLIDE_IN_MS = 400;

  function scheduleViewer() {
    if (!state.modelSlide) return;
    if (typeof window.EmjiveModelViewer !== "function") {
      // The viewer is a lazy chunk: fetch it during the slide-in, then retry. On
      // failure the poster stays.
      if (!window.EmjiveLoadViewer) return;
      var token = state.openToken;
      window.EmjiveLoadViewer().then(function () {
        if (state.isOpen && token === state.openToken) scheduleViewer();
      }, function () {});
      return;
    }
    state.cancelViewerBuild = H.afterTransition(sheet, "transform", SLIDE_IN_MS, function () {
      state.cancelViewerBuild = null;
      buildViewer();
    });
  }

  // The model's share of the viewer's box: 1 / --model-room (css/style.css),
  // the rest being room for larger sizes. Read once.
  var modelRest = 0;
  function readModelRest() {
    if (!modelRest) {
      var room = parseFloat(getComputedStyle(modal).getPropertyValue("--model-room"));
      modelRest = room > 0 ? 1 / room : 1;
    }
    return modelRest;
  }

  function buildViewer() {
    var slide = state.modelSlide;
    if (!state.isOpen || !slide || state.modelHandle) return;
    var handle = window.EmjiveModelViewer(state.product, state.selectedMetal, {
      hdri: window.EmjiveSeries.hdriPath(state.slug),
      // The viewer's box has no visible edge.
      loaderBleed: true,
      sizing: { restScale: readModelRest() },
      onError: function () { restorePoster(handle); }
    });
    // No WebGL context: the poster stays.
    if (!handle) return;
    handle.setSize(state.sizeMm);
    state.modelHandle = handle;
    state.posterImg = null;
    slide.innerHTML = "";
    slide.appendChild(handle.el);
  }

  // A load failure or lost context, possibly much later: the poster returns in
  // the same slide. Ignores a handle that isn't the live one.
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

  // After the slide-out: free the viewer, then hand the wheel its slot back.
  function cleanup() {
    disposeViewer();
    slot.innerHTML = "";
    state.modelSlide = null;
    state.posterImg = null;
    state.iconImg = null;
    window.dispatchEvent(new CustomEvent("emjive:modify-close"));
  }

  /* ---- Save, Remove, Undo ---- */

  function orderable() {
    return window.EmjiveSelection.isOrderableSize(state.base, String(state.sizeMm));
  }

  // Save stays visible but acts only on an orderable size.
  function syncSave() {
    saveBtn.disabled = !orderable();
  }

  function save() {
    if (!state.isOpen || !orderable()) return;
    window.EmjiveSelection.updateItem(state.index, draftValues());
    // The strip stays up for the band to play out; the row already shows what was saved.
    var bar = state.options.bar;
    close({ keepStrip: true, keepPreview: true });
    leaveAfterSave(bar);
  }

  // Removed from storage at once while the sheet slides away. The Undo line is
  // requested before the removal, which the list answers by keeping the row.
  // The stored item and this session's options are kept for the Undo, which
  // outlives the sheet. Focus moves to the line's Undo button.
  function removeItem() {
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

  // Back at its index, clamped if the list shrank; the list revives its held line.
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

  // The list dropped the held line itself (a rebuild): the removal stands.
  function forgetUndo(handle) {
    if (!state.undo || state.undo.handle !== handle) return;
    clearTimeout(state.undo.timer);
    state.undo = null;
  }

  // The offer ran out (or, immediate, the page is leaving): the line closes and
  // focus, if on Undo, goes to the fallback.
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

  // Another Modify opened during the offer: the removal stands.
  function dropUndo() {
    var pending = state.undo;
    if (!pending) return;
    clearTimeout(pending.timer);
    state.undo = null;
    pending.handle.drop();
  }

  saveBtn.addEventListener("click", save);
  removeBtn.addEventListener("click", removeItem);

  backdrop.addEventListener("click", function () { close(); });

  /* ---- open / close ---- */
  function show(item, index, product, slug, options) {
    dropUndo();
    // The Save band still leaving: snap the strip straight back.
    var cutLeaveShort = !!state.cancelLeave;
    if (cutLeaveShort) {
      state.cancelLeave();
      state.cancelLeave = null;
    }
    // Before building: js/gallery-stack.js frees the WebGL context this needs.
    window.dispatchEvent(new CustomEvent("emjive:modify-open"));
    // Reopened during the previous slide-out: dispose that viewer now.
    disposeViewer();

    state.item = item;
    state.index = index;
    state.base = product;
    // Shown in the item's chosen design.
    state.product = window.EmjiveSeries.resolveDesign(product, item.design).view;
    state.designKey = state.product.designKey;
    state.slug = slug;
    state.selectedMetal = item.metal;
    var mm = parseFloat(item.size);
    state.sizeMm = isFinite(mm) ? mm : H.REFERENCE_SIZE_MM;
    state.options = options;

    // Every metal's icon and poster decoded now, so picks swap at once.
    var assets = state.product.assets || {};
    H.preload(
      Object.keys(assets.icons || {}).map(function (m) { return assets.icons[m]; })
        .concat(Object.keys(assets["fallback-img"] || {}).map(function (m) { return assets["fallback-img"][m]; }))
    );
    pageLabel.textContent = itemName();
    mountDials();
    buildSlide();
    // Mounted (normally already, via attach) before the mode is set, so it is laid out first.
    mountStrip(options.bar);
    setStripMode("modify", cutLeaveShort);
    syncSave();

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    state.isOpen = true;

    // After .is-open (focus() is a no-op while hidden). The trap also locks the page.
    window.EmjiveFocusTrap.activate(modal, {
      include: strip,
      returnFocus: function () { return resolve(state.options.returnFocus); },
      fallbackFocus: function () { return resolve(state.options.fallbackFocus); },
      onEscape: function () { close(); }
    });
    if (options.bar) options.bar.show(strip);
    if (options.onOpen) options.onOpen(item);
    scheduleViewer();
  }

  // keepStrip    the strip stays up (a Save's band still to play)
  // keepPreview  the row keeps the draft (a Save, or a Remove's leaving row)
  // focus        where focus goes instead of returnFocus
  function close(opts) {
    if (!state.isOpen) return;
    opts = opts || {};
    state.isOpen = false;
    var options = state.options;
    if (!opts.keepPreview && options.onPreview) options.onPreview(state.index, null);
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (!opts.keepStrip && options.bar) options.bar.hide(strip);
    window.EmjiveFocusTrap.release(opts.focus);
    // A pending viewer build is cancelled; a built one goes after the slide-out.
    if (state.cancelViewerBuild) {
      state.cancelViewerBuild();
      state.cancelViewerBuild = null;
    }
    clearTimeout(state.cleanupTimer);
    state.cleanupTimer = setTimeout(cleanup, SLIDE_OUT_MS);
    if (options.onClose) options.onClose();
  }

  // Ids are only unique within a series; items without one use the active
  // series. A missing product shows a notice instead of opening.
  function open(item, index, options) {
    // Already open: reopening would discard unsaved picks.
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
      // A failed fetch gets the same notice as a missing product.
      .catch(function (err) {
        if (token !== state.openToken) return;
        console.error("emjive: could not open the modify sheet", err);
        window.EmjiveOrderRows.notice("This item listing couldn't be found, please reload.");
      });
  }

  // Prefetch the products behind the selection after load, so the first Modify
  // on pages without product data doesn't wait. Failures are left to open().
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

  // Leaving with the sheet up: close it and free the viewer now (a bfcache page
  // stays alive with its WebGL context). A pending Undo ends too.
  window.addEventListener("pagehide", function () {
    if (state.isOpen) close();
    if (state.cleanupTimer) cleanup();
    expireUndo(true);
  });

  window.EmjiveModifyModal = {
    open: open,
    isOpen: function () { return state.isOpen; },
    // Each page's bar calls this as soon as it exists, so the strip is in place before the first open.
    attach: mountStrip
  };
})();
