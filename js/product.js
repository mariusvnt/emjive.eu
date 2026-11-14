// The product page: resolves the item from the address and renders its label,
// photo feed, model, dials (shape, material, size), plan views, the
// information and the selection flow across the two stages
// js/product-stages.js drives, handling what CSS can't (the band's reveal of
// the model, its lift, the feed's and the design column's room).

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;
  var clamp = H.clamp;
  var remPx = H.remPx;

  var root = document.getElementById("productDetail");
  if (!root) return;

  var loadingEl = document.getElementById("productDetailLoading");
  var contentEl = document.getElementById("productDetailContent");
  var stageEl = document.getElementById("productStage");
  // The design stage's frame (a --tile tall band, the model centred) and the model's box.
  var designFrameEl = document.getElementById("productDesignFrame");
  var modelBoxEl = document.getElementById("productModel");
  // js/product-stages.js's handle (wireStages).
  var stages = null;
  // The model holds still out of sight until --to-design passes this; design's
  // other controls follow from --d-from (refreshStage).
  var MODEL_FROM = 0;
  var resetEl = document.getElementById("productModelReset");

  // The reset button shows while the model is turned off its pose; a plan
  // view's window ends as the model starts back.
  function setModelAway(away) {
    state.modelAway = !!away;
    if (resetEl) resetEl.classList.toggle("is-away", state.modelAway);
    if (!state.modelAway) markPlanView("");
  }

  var state = {
    product: null,
    // The product as its chosen design (EmjiveSeries.resolveDesign), read by the
    // model, label thumbnail, costs and selection.
    view: null,
    designKey: "",
    // The loader hold while a design's model is loading.
    swapHold: null,
    metals: [],
    // data/series.json "production-costs" (computeCosts).
    productionCosts: {},
    // data/series.json "metal-technology" and "printing-technologies".
    metalTechnology: {},
    technologies: {},
    // data/series.json "metal-composition".
    compositions: {},
    // Each caption with its picture, for inkCaption.
    captions: [],
    selectedMetal: null,
    modelHandle: null,
    // The model box's poster (fallback-img) until the viewer is in.
    posterImg: null,
    // The x-ray's original file (startXray picks the viewport's version) and whether the watcher is wired.
    xraySrc: "",
    xrayWatching: false,
    iconFallbackImg: null,
    // The stage transition (0..1), kept so a viewer built later starts where the page is.
    toDesign: 0,
    // Design's controls out of sight: the viewer is paused.
    designOut: true,
    // Whether a released model eases home by itself: not in design, where the
    // reset button does it.
    autoReturn: true,
    // The model is turned off its pose (reported by the viewer).
    modelAway: false,
    // The size the model is shown at, mm (setModelSize), and the valid size in
    // the size field ("" if none: no size on the label).
    sizeMm: H.REFERENCE_SIZE_MM,
    sizeText: "",
    // A metal has been picked (the default isn't a pick): until then the price
    // reads from the cheapest metal.
    metalPicked: false,
    // The size dial (js/option-dial.js mountSize; wireSelectButton).
    sizeDial: null,
    // The plan views' elements by view name and the design's frame
    // (EmjiveHelpers.planFrame).
    planViews: null,
    planFrame: null,
    // The view whose outline lies over the model ("" for none: showOutline).
    outlineView: "",
    // The shape and material dials (js/option-dial.js); no shape dial with a single design.
    shapeDial: null,
    materialDial: null,
    // The model's lift where design holds it, px (refreshStage).
    lift: 0,
    // Marks the cost chart as played out.
    settleTimer: 0
  };

  // The model's loader, on the design frame (the model's box has no visible
  // edge): for the first load and each design swap. Counts only while the model
  // is on screen; CSS hides it during .is-design-out. null without a loader.
  function modelLoadHold() {
    if (!window.EmjiveLoader || !designFrameEl) return null;
    var hold = window.EmjiveLoader.mount(designFrameEl, { target: modelBoxEl });
    return hold && typeof hold.done === "function" ? hold : null;
  }

  // The item's slug, from its address /<slug> (the per-item pages,
  // emitItemPages() in vite.config.js).
  function getSlug() {
    var last = window.location.pathname.split("/").pop() || "";
    try { return decodeURIComponent(last).toLowerCase(); } catch (e) { return last.toLowerCase(); }
  }

  // Lifts the arrival loader.
  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  function showNotFound() {
    loadingEl.hidden = false;
    // Back to the series being browsed (mainHref drops ?series= for the featured one).
    var slug = state.seriesSlug || (window.EmjiveSeries && window.EmjiveSeries.slug);
    window.EmjiveMessage.show(loadingEl, "Item not found", {
      label: "Back to gallery",
      href: (slug ? window.EmjiveSeries.mainHref(slug) : "/") + "#products"
    }, "status");
    pageReady();
  }

  // A failure other than "no such item": saying "not found" would turn away a
  // valid link. Reload is the retry.
  function showLoadError(err) {
    console.error("Could not load the product:", err);
    loadingEl.hidden = false;
    contentEl.hidden = true;
    window.EmjiveMessage.show(loadingEl,
      "This item couldn't be loaded. Check your connection and try again.",
      { label: "Reload" }, "alert");
    pageReady();
  }

  // A slug is unique across all series (validate-data), so it identifies the
  // series too. The active series is tried first, then the others in index order.
  function findProduct(slug, itemSlug) {
    var matches = function (p) {
      return !!itemSlug && window.EmjiveSeries.productSlug(p) === itemSlug;
    };
    return window.EmjiveSeries.loadProducts(slug).then(function (products) {
      var product = products.find(matches);
      if (product) return { product: product, slug: slug };

      var others = window.EmjiveSeries.all()
        .map(function (s) { return s.slug; })
        .filter(function (s) { return s !== slug; });

      return others.reduce(function (chain, otherSlug) {
        return chain.then(function (found) {
          if (found) return found;
          return window.EmjiveSeries.loadProducts(otherSlug).then(function (list) {
            var hit = list.find(matches);
            return hit ? { product: hit, slug: otherSlug } : null;
          });
        });
      }, Promise.resolve(null));
    });
  }

  // Renders as soon as the product data is in, not waiting for the viewer
  // chunk: the first paint is the inspiration stage; the model's box starts as
  // its poster until the viewer takes over (mountViewer).
  function init() {
    window.EmjiveSeries.ready
      .then(function (ctx) {
        state.metals = ctx.index.metals || [];
        state.productionCosts = ctx.index["production-costs"] || {};
        state.metalTechnology = ctx.index["metal-technology"] || {};
        state.technologies = ctx.index["printing-technologies"] || {};
        state.compositions = ctx.index["metal-composition"] || {};
        return findProduct(ctx.slug, getSlug());
      })
      .then(function (found) {
        if (!found) return showNotFound();
        state.product = found.product;
        state.seriesSlug = found.slug;
        render(found.product);
      })
      .catch(showLoadError);
  }

  function render(product) {
    // The built page already has it; the dev server serves the bare template.
    document.title = "em·ji·ve: " + (product.name || "product").toLowerCase();
    // The metal picked in the gallery, priced as a pick, else the item's own.
    var chosen = window.EmjiveSeries.chosenMetal();
    state.selectedMetal = chosen || product["default-metal"] || state.metals[0] || "steel";
    state.metalPicked = !!chosen;
    var sizes = H.sizeRange(product);
    SIZE_MIN_MM = sizes.min;
    SIZE_MAX_MM = sizes.max;
    // Opens on the default design.
    state.view = window.EmjiveSeries.resolveDesign(product).view;
    state.designKey = state.view.designKey;

    // First: the feed's first photo is what the first paint waits on.
    var feed = renderFeed(product);

    renderLabel(product);
    var modelParts = renderModel(product);
    // Design's lead picture, as the feed's first photo is inspiration's: not
    // held back by the first paint.
    startXray(product);
    renderDesigns(product);
    renderMetalOptions(product);
    renderCosts();
    renderPlanViews();
    renderPrinting();
    renderComposition();
    wireCosts();
    wireSelectButton(product);

    loadingEl.hidden = true;
    contentEl.hidden = false;

    // After unhiding: the stages and the feed measure laid-out boxes.
    wireStages();

    // The arrival loader lifts once the first paint's picture is in, and
    // everything else waits for it so nothing competes for bandwidth.
    var firstPaintReady = Promise.race([feed.firstReady, H.wait(FIRST_PAINT_WAIT_MS)]);
    firstPaintReady.then(pageReady);
    // ...and once it's actually painted, not just downloaded.
    firstPaintReady
      .then(afterFirstPaint)
      .then(function () { loadRemainingAssets(product, feed, modelParts); });
  }

  // Resolves once the browser reports the feed's largest contentful paint, or
  // after a cap, or after two frames without the LCP API. Also after two
  // frames when the feed's first photo isn't on screen (none, or the page
  // opened past inspiration): the browser reports no paint for it, and the
  // wait would run to the cap.
  var AFTER_PAINT_CAP_MS = 2000;

  function afterFirstPaint() {
    return new Promise(function (resolve) {
      var done = false;
      var observer = null;
      function finish() {
        if (done) return;
        done = true;
        if (observer) observer.disconnect();
        resolve();
      }
      var frame = document.getElementById("productFeedColumn");
      var first = frame && frame.querySelector(".product-feed__photo img");
      var box = first && first.getBoundingClientRect();
      var onScreen = !!box && box.bottom > 0 && box.top < screenHeight() && getComputedStyle(first).visibility !== "hidden";
      if (!onScreen) {
        requestAnimationFrame(function () { requestAnimationFrame(finish); });
        return;
      }
      setTimeout(finish, AFTER_PAINT_CAP_MS);
      try {
        observer = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (entry.element && frame && frame.contains(entry.element)) finish();
          });
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });
      } catch (err) {
        requestAnimationFrame(function () { requestAnimationFrame(finish); });
      }
    });
  }

  // A ceiling, so a stalled image can't hold everything up.
  var FIRST_PAINT_WAIT_MS = 6000;

  // The x-ray behind the model in design: independent of metal and design;
  // hidden without assets.xray. Started with the page (render).
  function startXray(product) {
    var xray = document.getElementById("productDesignXray");
    var xraySrc = product.assets && product.assets.xray;
    if (!xraySrc) {
      xray.hidden = true;
      return;
    }
    // The low-res version first, a fraction of the size; loadRemainingAssets swaps
    // in the high-res once the model is up. Phone versions are cropped (hence the
    // narrower box in the phone CSS).
    var loader = window.EmjiveLoader;
    state.xraySrc = xraySrc;
    // Ahead of the viewer's downloads, which would otherwise outrank an image;
    // its low-res version is small.
    xray.fetchPriority = "high";
    // Hidden until its first picture is in (.is-loading).
    xray.classList.add("is-loading");
    xray.addEventListener("load", function () { xray.classList.remove("is-loading"); }, { once: true });
    if (loader) {
      loader.setSrc(xray, loader.versions(xraySrc, true).first, xraySrc);
      // Crossing the phone/desktop line reshapes the box: switch straight to the other set's high-res.
      if (!state.xrayWatching) {
        state.xrayWatching = true;
        loader.onPhoneChange(function () {
          xray.src = loader.versions(state.xraySrc, true).hi;
        });
      }
    } else {
      xray.src = xraySrc;
    }
    xray.hidden = false;
  }

  // After the first paint: other metals' icons, the rest of the feed, the
  // viewer and the high-res x-ray.
  function loadRemainingAssets(product, feed, modelParts) {
    preloadIcons(state.view);
    feed.loadRest();
    modelParts.mountViewer();
    // The high-res x-ray once the model is up (or after VIEWER_SETTLE_WAIT_MS), so
    // it never competes with the viewer's downloads.
    if (state.xraySrc && window.EmjiveLoader) {
      Promise.race([modelParts.viewerSettled, H.wait(VIEWER_SETTLE_WAIT_MS)]).then(function () {
        window.EmjiveLoader.upgradeImage(
          document.getElementById("productDesignXray"),
          window.EmjiveLoader.versions(state.xraySrc, true).hi
        );
      });
    }
  }

  // Decode the other metals' icons ahead, so the label thumbnail swaps at once.
  function preloadIcons(view) {
    var icons = (view.assets && view.assets.icons) || {};
    H.preload(Object.keys(icons)
      .filter(function (m) { return m !== state.selectedMetal; })
      .map(function (m) { return icons[m]; }));
  }

  var VIEWER_SETTLE_WAIT_MS = 20000;

  /* ---- 1. label ---- */

  // The label's bar, an invert band re-sampled when its content changes in place (EmjiveHelpers.resampleBand).
  function labelBar() {
    return document.querySelector(".product-detail__label-bar");
  }

  function renderLabel(product) {
    H.edgeFades(document.querySelector(".product-detail__label-text"));
    document.getElementById("productLabelName").textContent = product.name || "";
    renderLabelDesign(product);
    renderLabelType(product);

    renderLabelThumb();
    renderLabelPrice(product);
  }

  // The design's addition to the name ("rib-cage" + "-1L2"); none for single-design products.
  function renderLabelDesign(product) {
    var node = document.getElementById("productLabelDesign");
    var name = String(product.name || "");
    var designName = String(state.view.designName || "");
    var suffix = "";
    if (product.designs && designName) {
      suffix = designName.toLowerCase().indexOf(name.toLowerCase()) === 0 ? designName.slice(name.length) : " " + designName;
    }
    if (node.textContent === suffix) return;
    node.textContent = suffix;
    H.resampleBand(labelBar());
  }

  // ".category.metal", plus ".size" once the size field holds one (appendSize, as in the rows).
  function labelTypeText(product) {
    return (product.category ? "." + product.category.toLowerCase() : "") +
      (state.selectedMetal ? "." + state.selectedMetal : "");
  }

  function renderLabelType(product) {
    var node = document.getElementById("productLabelType");
    var key = labelTypeText(product) + "|" + state.sizeText;
    if (node.getAttribute("data-key") === key) return;
    node.setAttribute("data-key", key);
    node.textContent = labelTypeText(product);
    if (state.sizeText) {
      node.appendChild(document.createTextNode("."));
      window.EmjiveSelection.appendSize(node, state.sizeText);
    }
    // Changed in place under the invert band.
    H.resampleBand(labelBar());
  }

  // Always the icon, for its consistent framing at this small size; hidden
  // without one. Re-run on metal and design changes.
  function renderLabelThumb() {
    var thumb = document.getElementById("productLabelThumb");
    // A picture arriving under the invert band needs a re-sample (resampleBand). Wired once.
    if (!thumb.dataset.resample) {
      thumb.dataset.resample = "1";
      thumb.addEventListener("load", function () {
        H.resampleBand(labelBar());
      });
    }
    var view = state.view;
    var thumbSrc = H.assetFor(view, "icons", state.selectedMetal);
    if (thumbSrc) {
      thumb.src = thumbSrc;
      thumb.hidden = false;
    } else {
      thumb.hidden = true;
    }
  }

  // The chosen design's price: "from" the cheapest metal until one is picked,
  // "from" that metal's lowest until a size is given, then the price at that size.
  function renderLabelPrice(product) {
    var sel = window.EmjiveSelection;
    var view = state.view || product;
    document.getElementById("productLabelPrice").textContent = state.sizeText
      ? sel.formatPrice(sel.priceAt(view, state.selectedMetal, state.sizeText))
      : sel.formatPriceFrom(sel.priceFrom(view, state.metalPicked ? state.selectedMetal : ""));
  }

  /* ---- 2. the feed (inspiration) ---- */

  // The description, then the photos stacked without gaps, each with its
  // caption, then the trail (buildTrail). The first photo is requested at once;
  // the rest after the first paint (loadRest), each behind its own loader. Photo
  // heights are their own, so the feed's room is re-fitted as each arrives (fitFeed).
  function renderFeed(product) {
    var description = document.getElementById("productDescription");
    description.textContent = product.description || "";
    description.hidden = !product.description;

    var list = document.getElementById("productFeed");
    list.innerHTML = "";
    state.captions = [];
    var photos = (product.assets && product.assets.photos) || [];
    var last = photos.length - 1;
    var trail = null;
    if (photos.length) {
      trail = el("div", "product-feed__trail");
      trail.setAttribute("aria-hidden", "true");
    }
    var loaders = photos.map(function (photo, i) {
      var figure = el("figure", "product-feed__photo");
      var frame = el("div", "product-feed__frame");
      var img = document.createElement("img");
      img.alt = (product.name || "") + (photo.description ? " — " + photo.description : "");
      img.decoding = "async";
      img.draggable = false;
      if (i === 0) img.fetchPriority = "high";
      else img.loading = "lazy";
      frame.appendChild(img);
      var caption = null;
      if (photo.description) {
        caption = captionFor(photo.description);
        frame.appendChild(caption);
        state.captions.push({ img: img, caption: caption });
      }
      figure.appendChild(frame);
      list.appendChild(figure);
      var started = null;
      return function load() {
        if (started) return started;
        img.src = photo.src;
        started = H.imageReady(img);
        if (window.EmjiveLoader && i > 0) window.EmjiveLoader.cover(frame, started);
        started.then(function () {
          // The caption's ink is set before it shows (.is-loaded).
          inkCaption(img, caption);
          figure.classList.add("is-loaded");
          if (i === last) buildTrail(trail, img);
          fitFeed();
        });
        return started;
      };
    });
    if (trail) list.appendChild(trail);
    wireCaptionInk();
    return {
      firstReady: loaders.length ? loaders[0]() : Promise.resolve(),
      loadRest: function () { loaders.forEach(function (load) { load(); }); }
    };
  }

  // The caption is the item's name styled like everywhere else: name, then
  // ".category.metal.size" in mono (appendSize). Colour from inkCaption.
  function captionFor(text) {
    var caption = el("figcaption", "product-feed__caption");
    var dot = text.indexOf(".");
    caption.appendChild(el("span", "product-feed__caption-name", dot === -1 ? text : text.slice(0, dot)));
    if (dot !== -1) {
      var type = el("span", "product-feed__caption-type");
      var rest = text.slice(dot);
      var sized = /^(.*)\.(\d+(?:\.\d+)?)$/.exec(rest);
      if (sized) {
        type.appendChild(document.createTextNode(sized[1] + "."));
        window.EmjiveSelection.appendSize(type, sized[2]);
      } else {
        type.textContent = rest;
      }
      caption.appendChild(type);
    }
    return caption;
  }

  // Caption colour from the picture under it: the area (plus INK_PAD_PX) is
  // averaged through a 16x8 canvas and its WCAG relative luminance compared to
  // INK_THRESHOLD (0.179, where white and black read equally), giving data-ink.
  // An unreadable picture leaves the CSS default. Re-run on width changes.
  var INK_PAD_PX = 6;
  var INK_THRESHOLD = 0.179;
  var INK_COLS = 16;
  var INK_ROWS = 8;
  var inkContext = null;
  function inkCaption(img, caption) {
    if (!caption || !img.naturalWidth) return;
    var shown = img.getBoundingClientRect();
    var box = caption.getBoundingClientRect();
    if (!(shown.width > 0) || !(box.width > 0)) return;
    var k = img.naturalWidth / shown.width;
    var x0 = Math.max(0, (box.left - INK_PAD_PX - shown.left) * k);
    var y0 = Math.max(0, (box.top - INK_PAD_PX - shown.top) * k);
    var x1 = Math.min(img.naturalWidth, (box.right + INK_PAD_PX - shown.left) * k);
    var y1 = Math.min(img.naturalHeight, (box.bottom + INK_PAD_PX - shown.top) * k);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    try {
      if (!inkContext) {
        var canvas = document.createElement("canvas");
        canvas.width = INK_COLS;
        canvas.height = INK_ROWS;
        inkContext = canvas.getContext("2d", { willReadFrequently: true });
      }
      inkContext.clearRect(0, 0, INK_COLS, INK_ROWS);
      inkContext.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, INK_COLS, INK_ROWS);
      var data = inkContext.getImageData(0, 0, INK_COLS, INK_ROWS).data;
      var sum = 0;
      for (var i = 0; i < data.length; i += 4) {
        sum += 0.2126 * linearChannel(data[i]) + 0.7152 * linearChannel(data[i + 1]) + 0.0722 * linearChannel(data[i + 2]);
      }
      caption.setAttribute("data-ink", sum / (data.length / 4) < INK_THRESHOLD ? "white" : "black");
    } catch (err) {
      // A tainted canvas: left as it was.
    }
  }

  // sRGB channel (0-255) to linear light.
  function linearChannel(value) {
    var c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  var captionInkWired = false;
  function wireCaptionInk() {
    if (captionInkWired) return;
    captionInkWired = true;
    var queued = false;
    window.addEventListener("resize", function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        state.captions.forEach(function (c) { inkCaption(c.img, c.caption); });
      });
    });
  }

  // The trail under the last photo: a slit-scan smear of its bottom
  // TRAIL_DEPTH rows, laid down one canvas row at a time with the stretch
  // growing from the photo's own scale at the seam to a single held row, so the
  // edge continues as coarsening streaks. CSS stretches the canvas over the
  // trail and fades it to --bg beneath an overlay. No trail if the picture can't
  // be read.
  //
  // Red and blue slip apart, starting TRAIL_FRINGE_LEAD rem inside the photo
  // (buildPhotoFringe) and widening down the trail up to TRAIL_FRINGE of the
  // width; one profile (trailFringe) so photo and trail join seamlessly. The
  // split fades out toward the sides so edges don't get coloured.
  var TRAIL_DEPTH = 180; // rows of the photo's edge used
  var TRAIL_ROWS = 288; // the smear's height, in canvas rows
  var TRAIL_PACE = 3; // stretch growth: photo rows per canvas row at the seam = DEPTH * PACE / ROWS
  var TRAIL_FRINGE = 0.04; // widest red-blue gap, as a share of the width
  var TRAIL_FRINGE_LEAD = 6; // rem of the photo above its bottom edge carrying the split
  var TRAIL_FRINGE_FULL = 14; // rem from its start to its widest
  function trailFringe(rem) {
    return Math.pow(H.clamp01(rem / TRAIL_FRINGE_FULL), 1.8);
  }
  // The picture multiplied into red, green and blue layers, each with its slip direction.
  function fringeChannels(source, width, height) {
    return [["#f00", 1], ["#0f0", 0], ["#00f", -1]].map(function (spec) {
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(source, 0, 0);
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = spec[0];
      ctx.fillRect(0, 0, width, height);
      return { canvas: canvas, side: spec[1] };
    });
  }
  // Row y takes row rowAt(y) of the channels, split by the profile at
  // rem0 + (y + 0.5) / height * remSpan; added together they rebuild the picture
  // where unsplit. Transparent toward the sides.
  function fringeSplit(channels, width, height, rowAt, rem0, remSpan) {
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    var widest = Math.round(width * TRAIL_FRINGE * 0.5);
    for (var y = 0; y < height; y++) {
      var shift = Math.round(widest * trailFringe(rem0 + (y + 0.5) / height * remSpan));
      var sy = rowAt(y);
      for (var c = 0; c < channels.length; c++) {
        var dx = shift * channels[c].side;
        ctx.drawImage(channels[c].canvas, 0, sy, width, 1, dx, y, width, 1);
        if (dx) ctx.drawImage(channels[c].canvas, 0, sy, width, 1, dx > 0 ? dx - width : dx + width, y, width, 1);
      }
    }
    // None within the widest slip of the edge (wrapped pixels), full from twice that in.
    var edge = Math.min(width / 4, widest + 2);
    var fade = ctx.createLinearGradient(0, 0, width, 0);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(edge / width, "rgba(0,0,0,0)");
    fade.addColorStop(Math.min(0.5, 2 * edge / width), "#000");
    fade.addColorStop(Math.max(0.5, 1 - 2 * edge / width), "#000");
    fade.addColorStop(1 - edge / width, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, width, height);
    return canvas;
  }
  function buildTrail(trail, img) {
    if (!trail || trail.firstChild || !img.naturalWidth) return;
    try {
      var width = Math.min(img.naturalWidth, 1600);
      var depth = Math.min(TRAIL_DEPTH, img.naturalHeight);
      var strip = document.createElement("canvas");
      strip.width = width;
      strip.height = depth;
      strip.getContext("2d").drawImage(img, 0, img.naturalHeight - depth, img.naturalWidth, depth, 0, 0, width, depth);
      var channels = fringeChannels(strip, width, depth);
      var row = document.createElement("canvas");
      row.width = width;
      row.height = TRAIL_ROWS;
      var ctx = row.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      // Which row of the photo's edge a trail row takes.
      var rowAt = function (y) {
        var t = (y + 0.5) / TRAIL_ROWS;
        return depth - 1 - Math.min(depth - 1, Math.floor(depth * (1 - Math.pow(1 - t, TRAIL_PACE))));
      };
      for (var y = 0; y < TRAIL_ROWS; y++) ctx.drawImage(strip, 0, rowAt(y), width, 1, 0, y, width, 1);
      var span = (trail.offsetHeight / remPx()) || 12;
      ctx.drawImage(fringeSplit(channels, width, TRAIL_ROWS, rowAt, TRAIL_FRINGE_LEAD, span), 0, 0);
      trail.appendChild(row);
      trail.classList.add("is-built");
      watchPhotoFringe(img);
    } catch (err) {
      trail.innerHTML = "";
    }
  }

  // The photo's own part of the split: a canvas over its bottom
  // TRAIL_FRINGE_LEAD rem (.product-feed__fringe), from zero at its top to where
  // the trail takes over. Redrawn at the photo's current width.
  function buildPhotoFringe(img) {
    var shown = img.clientWidth;
    if (!shown || !img.naturalWidth) return false;
    var width = Math.min(img.naturalWidth, 1600);
    var height = Math.min(Math.round(TRAIL_FRINGE_LEAD * remPx() * width / shown), Math.floor(img.naturalHeight * width / img.naturalWidth));
    var natural = Math.min(img.naturalHeight, Math.round(height * img.naturalWidth / width));
    var strip = document.createElement("canvas");
    strip.width = width;
    strip.height = height;
    strip.getContext("2d").drawImage(img, 0, img.naturalHeight - natural, img.naturalWidth, natural, 0, 0, width, height);
    var canvas = img.parentNode.querySelector(".product-feed__fringe");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "product-feed__fringe";
      canvas.setAttribute("aria-hidden", "true");
      img.parentNode.insertBefore(canvas, img.nextSibling);
    }
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(
      fringeSplit(fringeChannels(strip, width, height), width, height, function (y) { return y; }, 0, TRAIL_FRINGE_LEAD),
      0, 0
    );
    return true;
  }
  function watchPhotoFringe(img) {
    var built = 0;
    var build = function () {
      if (Math.abs(img.clientWidth - built) < 1) return;
      if (buildPhotoFringe(img)) built = img.clientWidth;
    };
    build();
    if (window.ResizeObserver) new ResizeObserver(build).observe(img);
  }

  /* ---- 2b. the model (design) ---- */

  // The model's box: its poster (fallback-img, the viewer's first frame) under
  // the viewer until its first frame is in;
  // the icon without a model or viewer. Built for the design and metal current
  // when it arrives; later design picks swap the model in place (onDesignSelect).
  function renderModel(product) {
    var box = modelBoxEl;
    box.innerHTML = "";
    box.classList.remove("is-model");
    state.modelHandle = null;
    setModelAway(false);
    state.posterImg = null;
    state.iconFallbackImg = null;
    // Resolves once the model is on screen, or never will be; the high-res x-ray waits on it.
    var settleViewer;
    var viewerSettled = new Promise(function (resolve) { settleViewer = resolve; });
    var hasModel = !!(product.assets && product.assets.model);

    // window.EmjiveModelViewer (js/three-viewer.js), null without a WebGL context
    // (then the icon). Reads state.view and state.selectedMetal at call time, so
    // rebuilds pick up the current choice.
    function buildModelViewer() {
      // The viewer module never arrived (stale hashed file after a deploy, a
      // blocked request): the icon, as without WebGL.
      if (typeof window.EmjiveModelViewer !== "function") return null;
      // The frame loader's hold goes to the viewer, which releases it when the
      // model shows, fails or is disposed; released here if no viewer comes back.
      var hold = modelLoadHold();
      var viewer = null;
      try {
        viewer = createModelViewer(hold);
      } catch (err) {
        console.error("3D viewer could not start:", err);
      }
      if (!viewer && hold) hold.done();
      return viewer;
    }

    function createModelViewer(loadHold) {
      return window.EmjiveModelViewer(state.view, state.selectedMetal, {
        hdri: window.EmjiveSeries.hdriPath(state.seriesSlug),
        // false: no loader (reduced motion).
        loader: loadHold || false,
        // Only a centred circle is the model's to drag (radius leaving a quarter of
        // the width as margin); presses outside scroll the page. Shrunk to the
        // model (--hit-scale in css/style.css, which assumes this margin).
        hitCircle: 0.25,
        onAway: setModelAway,
        // A plan view's lines over the model while it holds the view, measured
        // on each frame drawn meanwhile.
        onViewHeld: showOutline,
        onViewDrawn: onViewDrawn,
        // Also fires for a lost WebGL context, possibly long after loading (iOS
        // reclaims GPU contexts under memory pressure).
        onError: replaceModelWithIcon,
        onReady: function () {
          dropPosters();
          settleViewer();
        },
        // The page's posters stay under it instead: the viewer's own would be the design stage's.
        poster: false,
        // The size, plan views and outlines, and the model at its own size in
        // its roomier box (modelRest).
        sizing: { restScale: modelRest() }
      });
    }

    // Before the viewer's first frame: the poster, sized like the viewer, so
    // the swap moves nothing (as in js/modify-modal.js posterBox()).
    function showPoster() {
      box.innerHTML = "";
      state.posterImg = null;
        var src = H.posterFor(state.view, state.selectedMetal);
      if (!src) return;
      var poster = el("div", "size-modal__model-poster");
      var img = document.createElement("img");
      img.src = src;
      img.alt = product.name || "";
      img.draggable = false;
      poster.appendChild(img);
      box.appendChild(poster);
      state.posterImg = img;
    }

    function dropPosters() {
      var poster = box.querySelector(".size-modal__model-poster");
      if (poster) box.removeChild(poster);
      state.posterImg = null;
      }

    // Lays the viewer over the poster, which goes at its first frame; also the
    // bfcache restore path. Falls back to the icon without a viewer.
    function attachViewer() {
      if (state.modelHandle) return;
      // Without .is-model the icon fallback has taken over: a viewer under it would
      // be an invisible second context.
      if (!box.classList.contains("is-model")) return;
      if (!state.posterImg) showPoster();
      var handle = buildModelViewer();
      if (!handle) {
        replaceModelWithIcon();
        return;
      }
      state.modelHandle = handle;
      box.appendChild(handle.el);
      // Paused while out of sight (inspiration).
      handle.setPaused(state.designOut);
      handle.setAutoReturn(state.autoReturn);
      // At the size chosen meanwhile.
      applyStageToViewer();
    }

    // After the first paint: request the chunk, then build when idle (context
    // creation and shader compiles are long tasks).
    function mountViewer() {
      if (!hasModel) {
        settleViewer();
        return;
      }
      if (!window.EmjiveLoadViewer) {
        replaceModelWithIcon();
        return;
      }
      // Hint the HDRI and model now so they download alongside the chunk; the
      // viewer's own requests reuse them.
      hintFetch(window.EmjiveSeries.hdriPath(state.seriesSlug));
      hintFetch(state.view.assets.model);
      window.EmjiveLoadViewer().then(function () {
        H.whenIdle(attachViewer, 1500, 0);
      }, replaceModelWithIcon);
    }

    // The permanent fallback for a failed viewer: the metal's icon.
    // state.iconFallbackImg is re-pointed on picks.
    function replaceModelWithIcon() {
      if (state.modelHandle) {
        state.modelHandle.dispose();
        state.modelHandle = null;
      }
      setModelAway(false);
      settleViewer();
      showIcon();
    }

    function showIcon() {
      box.classList.remove("is-model");
      box.innerHTML = "";
      state.posterImg = null;
        state.iconFallbackImg = null;
      var src = H.assetFor(state.view, "icons", state.selectedMetal);
      if (!src) return;
      var img = document.createElement("img");
      img.className = "product-model__icon";
      img.src = src;
      img.alt = product.name || "";
      img.draggable = false;
      box.appendChild(img);
      state.iconFallbackImg = img;
    }

    /* ---- releasing the viewer on pagehide ----
       A bfcache page keeps its WebGL context, model and environment while the
       gallery builds its own, and iOS counts both against one budget. Unlike
       replaceModelWithIcon this leaves the box intact, so a return restores the
       viewer. */
    function releaseModelViewer() {
      hideScanBand();
      if (!state.modelHandle) return;
      state.modelHandle.dispose();
      if (state.modelHandle.el.parentNode) {
        state.modelHandle.el.parentNode.removeChild(state.modelHandle.el);
      }
      state.modelHandle = null;
      setModelAway(false);
    }

    if (hasModel) {
      box.classList.add("is-model");
      showPoster();

      window.addEventListener("pagehide", releaseModelViewer);
      window.addEventListener("pageshow", function (e) {
        if (e.persisted) attachViewer();
      });

      // The Modify sheet builds a viewer of its own: show the poster while it's up
      // and rebuild after "emjive:modify-close" (sent once the sheet's viewer is freed).
      var viewerHeldForModify = false;
      window.addEventListener("emjive:modify-open", function () {
        if (!state.modelHandle) return;
        releaseModelViewer();
        showPoster();
        viewerHeldForModify = true;
      });
      window.addEventListener("emjive:modify-close", function () {
        if (!viewerHeldForModify) return;
        viewerHeldForModify = false;
        attachViewer();
      });
    } else {
      showIcon();
    }

    return {
      mountViewer: mountViewer,
      viewerSettled: viewerSettled
    };
  }

  // Matches three's same-origin fetch(), so the viewer's request reuses this download.
  function hintFetch(href) {
    if (!href) return;
    var link = document.createElement("link");
    link.rel = "preload";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = href;
    document.head.appendChild(link);
  }

  /* ---- 2c. the dials: shape, material ---- */

  // While a dial is open, its active option's name between the model and
  // the dials, held a moment once a pick closes it (EmjiveOptionDial.nameShower).
  var dialNameEl = document.getElementById("productDialName");
  var showDialName = dialNameEl ? window.EmjiveOptionDial.nameShower(dialNameEl) : function () {};

  // The shape dial: one option per design, its key as its name and its icon
  // in the chosen metal as its preview. None with a single design.
  function renderDesigns(product) {
    var host = document.getElementById("productShapeDial");
    var designs = product.designs;
    if (!host || !designs || !Array.isArray(designs.list) || designs.list.length < 2) return;
    host.hidden = false;
    state.shapeDial = window.EmjiveOptionDial.mount(host, {
      name: "Shape",
      options: shapeOptions(product),
      selected: state.designKey,
      onSelect: function (key) { onDesignSelect(product, key); },
      onShow: showDialName
    });
  }

  function shapeOptions(product) {
    return product.designs.list.map(function (design) {
      return {
        key: design.key,
        label: design.key,
        preview: function () {
          var view = window.EmjiveSeries.resolveDesign(product, design.key).view;
          return previewImg(H.assetFor(view, "icons", state.selectedMetal), "product-dial__icon");
        }
      };
    });
  }

  function previewImg(src, className) {
    var img = el("img", className);
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    if (src) img.src = src;
    return img;
  }

  // Another design: label, price, thumbnail, costs, plan views and model follow. The viewer swaps
  // models in place, camera kept (setProduct), under the frame's loader; a
  // viewer not built yet is built as this design.
  function onDesignSelect(product, key) {
    if (key === state.designKey) return;
    state.designKey = key;
    state.view = window.EmjiveSeries.resolveDesign(product, key).view;
    if (state.shapeDial) state.shapeDial.select(key);
    renderLabelDesign(product);
    renderLabelPrice(product);
    renderLabelThumb();
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = H.assetFor(state.view, "icons", state.selectedMetal);
    }
    if (state.posterImg) state.posterImg.src = H.posterFor(state.view, state.selectedMetal);
    renderCosts();
    renderPlanViews();
    preloadIcons(state.view);
    if (state.modelHandle && state.modelHandle.setProduct) {
      if (state.swapHold) state.swapHold.done();
      var hold = state.swapHold = modelLoadHold();
      var release = function () {
        if (hold) hold.done();
        if (state.swapHold === hold) state.swapHold = null;
      };
      state.modelHandle.setProduct(state.view, {
        onReady: function () {
          release();
          refreshStage();
        },
        onError: release
      });
    }
  }

  /* ---- 3. metal selection ---- */

  // The material dial: a metal's swatch as its preview.
  function renderMetalOptions(product) {
    state.materialDial = window.EmjiveOptionDial.mount(document.getElementById("productMaterialDial"), {
      name: "Material",
      options: state.metals.map(function (metal) {
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
      onSelect: function (metal) { onMetalSelect(product, metal); },
      onShow: showDialName
    });
  }

  function onMetalSelect(product, metal) {
    var firstPick = !state.metalPicked;
    state.metalPicked = true;
    if (metal === state.selectedMetal) {
      if (firstPick) renderLabelPrice(product);
      return;
    }
    state.selectedMetal = metal;
    renderLabelType(product);
    renderLabelPrice(product);
    // Safari re-samples the label bar's invert band late otherwise.
    H.resampleBand(labelBar());
    // The label thumbnail and icon fallback are static images: swap them to the design's icon.
    var view = state.view;
    renderLabelThumb();
    if (state.iconFallbackImg) H.crossfadeSrc(state.iconFallbackImg, H.assetFor(view, "icons", metal));
    // The poster too, if the viewer isn't in yet.
    if (state.posterImg) H.crossfadeSrc(state.posterImg, H.posterFor(view, metal));
    // The shape previews are the designs in this metal.
    if (state.shapeDial) state.shapeDial.setOptions(shapeOptions(product));
    renderCosts();
    renderPrinting();
    renderComposition();
    // The model eases into the metal.
    if (state.modelHandle) state.modelHandle.applyMetal(metal, true);
  }

  /* ---- costs ---- */

  // The price of the `printed` geometry in `metal` at size `mm`, broken down:
  // manufacturing = the printer's price (EmjiveHelpers.productionCost, flat at
  // its minimum charge); VAT = its share of the price (EmjiveHelpers.salePrice);
  // design = what is left, the margin plus the rounding up, so the rows add up
  // to the price. null if an input is missing or the formula doesn't hold.
  function computeCosts(printed, mm, metal) {
    var index = window.EmjiveSeries.index;
    var manufacturing = H.productionCost(state.productionCosts[metal], H.volumeAt(printed, mm), H.areaAt(printed, mm));
    var price = H.salePrice(index, printed, metal, mm);
    if (manufacturing === null || !(price > 0)) return null;
    var vat = price * index.pricing.vat / (1 + index.pricing.vat);
    return { design: price - vat - manufacturing, manufacturing: manufacturing, vat: vat, total: price };
  }

  function formatEuros(amount) {
    return "€ " + amount.toFixed(2);
  }

  // The price breakdown at the chosen size. Uses the
  // design's print geometry (geometry.print, from its STL) when measured:
  // that's what is made and priced.
  var COST_PARTS = [["design", "productCostDesign"], ["manufacturing", "productCostManufacturing"], ["vat", "productCostVat"]];
  function renderCosts() {
    var geometry = (state.view && state.view.geometry) || {};
    var costs = computeCosts(geometry.print || geometry, state.sizeMm, state.selectedMetal);
    // The bars are shares of the price, each part starting where the one before ends.
    var at = 0;
    COST_PARTS.forEach(function (part) {
      var dd = document.getElementById(part[1]);
      var share = costs ? costs[part[0]] / costs.total : 0;
      dd.textContent = costs ? formatEuros(costs[part[0]]) : "TBD";
      dd.parentNode.style.setProperty("--from", at.toFixed(4));
      dd.parentNode.style.setProperty("--to", (at + share).toFixed(4));
      at += share;
    });
    document.getElementById("productCostTotal").textContent = costs ? formatEuros(costs.total) : "TBD";
  }

  // How the chosen metal is printed: its row, hidden without one.
  function renderPrinting() {
    var item = document.getElementById("productPrinting");
    var tech = state.technologies[state.metalTechnology[state.selectedMetal]];
    var from = item.hidden ? 0 : item.offsetHeight;
    item.hidden = !tech;
    if (!tech) return;
    document.getElementById("productPrintingName").textContent = tech.name;
    document.getElementById("productPrintingText").textContent = tech.description;
    // A different text height: glide instead of snapping.
    if (from > 0) tweenHeight(item, from);
  }

  // The chosen metal's composition, its row as the printing technology's.
  function renderComposition() {
    var item = document.getElementById("productCompositionItem");
    var node = document.getElementById("productComposition");
    if (!item || !node) return;
    var text = state.compositions[state.selectedMetal] || "";
    var from = item.hidden ? 0 : item.offsetHeight;
    item.hidden = !text;
    node.textContent = text;
    if (text && from > 0) tweenHeight(item, from);
  }

  // Animates `node`'s height from `from` to `to` (default: its new natural
  // height; .is-resizing owns the transition), then returns it to auto and calls
  // `after`. A new call mid-flight restarts and drops the old `after`.
  function tweenHeight(node, from, to, after) {
    if (node._tween) {
      clearTimeout(node._tween);
      node._tween = null;
    }
    node.classList.remove("is-resizing");
    node.style.height = "";
    if (to === undefined) to = node.offsetHeight;
    if (Math.abs(to - from) < 1) {
      if (after) after();
      return;
    }
    node.style.height = from + "px";
    node.classList.add("is-resizing");
    void node.offsetHeight;
    node.style.height = to + "px";
    // transitionend can be skipped, so a timer cleans up too.
    node._tween = setTimeout(function () {
      node._tween = null;
      node.classList.remove("is-resizing");
      node.style.height = "";
      if (after) after();
    }, 260);
  }

  /* ---- plan views ---- */

  // The model's front and side views: a button for each, stacked under the
  // reset button in the model box's top-right corner. A tap turns the model
  // to the view and holds it there until a drag, the reset button or another
  // tap on it; the button stays pressed until then.
  // Once the model is there, the viewer draws its outline over it on every
  // frame (js/three-viewer.js), and here its dimensions are laid on it
  // (placeOutline), fading in and out with the hold (showOutline), and out
  // while the size changes, back in measured afresh once the model holds
  // still (hideMarksWhileSizing). A view
  // carries lines, one per axis it measures (x and y on the front, z on the
  // side; EmjiveHelpers.PLAN_VIEWS), each running between the model's two
  // farthest points along its axis, at the height (or column) of one of them,
  // with the axis's letter past the end that is on the outline; an end off
  // the outline gets a dashed line reaching on to the outline point it stands
  // for (measureMark, on the viewer's silhouette of the model, each frame it
  // draws: onViewDrawn). Beside each letter, its length at the chosen size in
  // cm. The lines are placed in the view's rectangle of its design's plan
  // frame (EmjiveHelpers.planFrame) at the size (--plan-ratio: its
  // proportions). Hidden without the frame.
  var PLAN_NAMES = { top: "Top", front: "Front", side: "Side" };
  var PLAN_AXES = ["x", "y", "z"];
  // A silhouette's pixel counts as the model's from this alpha (of 255).
  var PLAN_DRAWN_ALPHA = 60;
  // How far, in silhouette pixels, a line's end may sit from the model and
  // still count as on the outline.
  var PLAN_ON_PX = 2;

  // The line for one axis of a view's silhouette (the viewer's planMask),
  // `horizontal` (along its width) or not: from the model's first pixel to
  // its last along that axis,
  // at the row (or column) of one of those two extreme points, the middle of
  // the run of rows reaching it. The line takes the extreme whose far end
  // still lands on the drawing; with neither or both, the right one of a
  // horizontal line and the top one of a vertical line. { from, to, at } as
  // shares of the picture, `labelTo` whether the letter sits at the `to` end
  // (the end on the drawing); `far`, when the other end is off the drawing,
  // the share along the lines of the drawing's extreme point it stands for,
  // else null.
  function measureMark(picture, horizontal) {
    var w = picture.w;
    var data = picture.data;
    var lines = horizontal ? picture.h : w;
    var across = horizontal ? w : picture.h;
    var drawn = function (a, l) {
      if (a < 0 || a >= across || l < 0 || l >= lines) return false;
      return data[((horizontal ? l * w + a : a * w + l) << 2) + 3] >= PLAN_DRAWN_ALPHA;
    };
    var near = function (a, l, px) {
      for (var da = -px; da <= px; da++) {
        for (var dl = -px; dl <= px; dl++) if (drawn(a + da, l + dl)) return true;
      }
      return false;
    };
    var lo = across;
    var hi = -1;
    for (var l = 0; l < lines; l++) {
      for (var a = 0; a < across; a++) {
        if (!drawn(a, l)) continue;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
      }
    }
    if (hi < 0) return null;
    var ends = [lo, hi];
    var runs = ends.map(function (end) {
      var found = [];
      var run = 0;
      for (var i = 0; i <= lines; i++) {
        var on = false;
        for (var d = -PLAN_ON_PX; d <= PLAN_ON_PX && !on && i < lines; d++) on = drawn(end + d, i);
        if (on) {
          run++;
        } else if (run) {
          found.push({ start: i - run, len: run });
          run = 0;
        }
      }
      return found;
    });
    // The middle line of an end's longest run.
    var middle = function (k) {
      var best = runs[k][0];
      runs[k].forEach(function (run) {
        if (run.len > best.len) best = run;
      });
      return best.start + ((best.len - 1) >> 1);
    };
    var share = function (line) { return (line + 0.5) / lines; };
    var picks = [0, 1].map(function (end) {
      var line = middle(end);
      return { k: end, at: line, reach: near(ends[1 - end], line, PLAN_ON_PX) };
    });
    var prefer = horizontal ? 1 : 0;
    var pick = picks[prefer];
    if (picks[1 - prefer].reach && !pick.reach) pick = picks[1 - prefer];
    return {
      from: lo / across,
      to: (hi + 1) / across,
      at: share(pick.at),
      labelTo: pick.k === 1,
      far: pick.reach ? null : share(picks[1 - pick.k].at)
    };
  }

  // Lays a view's lines and letters on its picture, and the reach
  // from a line end off the drawing to its extreme point; they stay hidden
  // until the silhouette has been read.
  function placeMarks(name, picture) {
    var view = state.planViews && state.planViews[name];
    var drawing = state.planFrame && state.planFrame.views[name];
    if (!view || !drawing) return;
    drawing.measures.forEach(function (measure, i) {
      var mark = view.marks[i];
      var reach = view.reaches[i];
      var found = picture ? measureMark(picture, measure.horizontal) : null;
      mark.classList.toggle("is-cut", !!found);
      mark.classList.toggle("is-vertical", !measure.horizontal);
      reach.classList.toggle("is-cut", !!found && found.far !== null);
      reach.classList.toggle("is-vertical", !measure.horizontal);
      if (!found) return;
      mark.classList.toggle("is-label-to", found.labelTo);
      mark.style.setProperty("--cut-from", found.from.toFixed(4));
      mark.style.setProperty("--cut-to", found.to.toFixed(4));
      mark.style.setProperty("--cut-at", found.at.toFixed(4));
      if (found.far === null) return;
      reach.classList.toggle("is-end-to", !found.labelTo);
      reach.style.setProperty("--reach-x", (found.labelTo ? found.from : found.to).toFixed(4));
      reach.style.setProperty("--reach-from", Math.min(found.at, found.far).toFixed(4));
      reach.style.setProperty("--reach-len", Math.abs(found.far - found.at).toFixed(4));
    });
  }

  // A size change hides the lines (.is-sizing on the outlines) rather than
  // have them follow the model's glide; once neither the size nor the
  // model's drawing has moved for PLAN_SETTLE_MS, the held view's lines are
  // laid afresh and fade back in.
  var PLAN_SETTLE_MS = 300;
  var sizingTimer = 0;
  function hideMarksWhileSizing() {
    var outlines = document.getElementById("productOutlines");
    if (!outlines) return;
    outlines.classList.add("is-sizing");
    clearTimeout(sizingTimer);
    sizingTimer = setTimeout(function () {
      sizingTimer = 0;
      var handle = state.modelHandle;
      var name = state.outlineView;
      if (name && handle && handle.planMask) {
        placeMarks(name, handle.planMask(name));
        placeOutline();
      }
      outlines.classList.remove("is-sizing");
    }, PLAN_SETTLE_MS);
  }

  // The buttons' icons, the band ring's outline as the view sees it, in a
  // hairline at any size: from the front its rim, two circles; from the
  // side its band, a narrow upright rectangle rounded at the corners, as a
  // domed wedding band's.
  var PLAN_OUTLINES = {
    front: "M20 12 A8 8 0 1 1 4 12 A8 8 0 1 1 20 12 Z M17 12 A5 5 0 1 1 7 12 A5 5 0 1 1 17 12 Z",
    side: "M11.25 4 H12.75 A1.75 1.75 0 0 1 14.5 5.75 V18.25 A1.75 1.75 0 0 1 12.75 20 H11.25 A1.75 1.75 0 0 1 9.5 18.25 V5.75 A1.75 1.75 0 0 1 11.25 4 Z"
  };
  function planIcon(name) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "product-plan__icon");
    // Cropped to the ring.
    svg.setAttribute("viewBox", "3.5 3.5 17 17");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = '<path d="' + (PLAN_OUTLINES[name] || "") + '" fill="none" stroke="currentColor" stroke-width="0.75" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    return svg;
  }

  function onViewTap(name) {
    var handle = state.modelHandle;
    if (!handle || !handle.showView) return;
    // The held view's button lets go of it.
    if (state.outlineView === name) {
      setModelAway(false);
      handle.returnHome();
      return;
    }
    handle.showView(name);
    markPlanView(name);
  }

  function buildPlanViews(host, outlines) {
    var views = {};
    Object.keys(H.PLAN_VIEWS).forEach(function (name) {
      var button = el("button", "product-plan");
      button.type = "button";
      button.setAttribute("data-view", name);
      button.setAttribute("aria-pressed", "false");
      button.appendChild(planIcon(name));
      button.addEventListener("click", function () { onViewTap(name); });
      host.appendChild(button);

      var outline = el("div", "product-outline");
      outline.setAttribute("data-view", name);
      var reaches = [];
      var values = [];
      var marks = H.PLAN_VIEWS[name].measures.map(function () {
        var reach = el("span", "product-outline__reach");
        outline.appendChild(reach);
        reaches.push(reach);
        var mark = el("span", "product-outline__mark");
        var label = el("span", "product-outline__label");
        label.appendChild(el("span", "product-outline__axis"));
        var value = el("span", "product-outline__value");
        label.appendChild(value);
        values.push(value);
        mark.appendChild(label);
        outline.appendChild(mark);
        return mark;
      });
      outlines.appendChild(outline);
      views[name] = { button: button, outline: outline, marks: marks, reaches: reaches, values: values };
    });
    return views;
  }

  function renderPlanViews() {
    var host = document.getElementById("productPlans");
    var outlines = document.getElementById("productOutlines");
    if (!host || !outlines || !state.view) return;
    var frame = H.planFrame(state.view);
    state.planFrame = frame;
    host.hidden = !frame;
    outlines.hidden = !frame;
    if (!frame) return;
    if (!state.planViews) {
      state.planViews = buildPlanViews(host, outlines);
      syncPlanLine();
      window.addEventListener("resize", syncPlanLine);
    }
    Object.keys(H.PLAN_VIEWS).forEach(function (name) {
      var view = state.planViews[name];
      frame.views[name].measures.forEach(function (measure, i) {
        view.marks[i].firstChild.firstChild.textContent = PLAN_AXES[measure.axis];
      });
      // Hidden until measured on this design.
      placeMarks(name, null);
    });
    syncPlanSizes();
    placeOutline();
  }

  // The lines' width (--plan-line) from the width CSS wants (--plan-line-want)
  // in whole device pixels, so each line is as thick as the others wherever
  // it lands; again on a resize, which a zoom's pixel ratio change is too.
  function syncPlanLine() {
    var outlines = document.getElementById("productOutlines");
    if (!outlines) return;
    var want = parseFloat(getComputedStyle(outlines).getPropertyValue("--plan-line-want")) || 1;
    outlines.style.setProperty("--plan-line", H.devicePx(want, 1) + "px");
  }

  // Each frame the viewer draws over the held view: its lines measured on
  // the model's silhouette as drawn, and laid on it. While the size moves
  // they wait, hidden, for the model to hold still.
  function onViewDrawn(name) {
    var handle = state.modelHandle;
    if (name !== state.outlineView || !handle || !handle.planMask) return;
    if (sizingTimer) {
      hideMarksWhileSizing();
      return;
    }
    placeMarks(name, handle.planMask(name));
    placeOutline();
  }

  // Each measure at the chosen size: its axis of the model's box in cm,
  // beside its letter and in the view's button label.
  function syncPlanSizes() {
    var frame = state.planFrame && H.planFrame(state.view, state.sizeMm);
    if (!frame || !state.planViews) return;
    Object.keys(H.PLAN_VIEWS).forEach(function (name) {
      var view = state.planViews[name];
      var said = frame.views[name].measures.map(function (measure, i) {
        var text = (frame.size[measure.axis] / 10).toFixed(1) + " cm";
        if (view.values[i].textContent !== text) view.values[i].textContent = text;
        return PLAN_AXES[measure.axis] + " " + text;
      });
      view.button.setAttribute("aria-label", PLAN_NAMES[name] + " view" + (said.length ? ", " + said.join(", ") : ""));
    });
  }

  // The view being turned to or held ("" for none): its button pressed.
  function markPlanView(name) {
    if (!state.planViews) return;
    Object.keys(state.planViews).forEach(function (key) {
      state.planViews[key].button.setAttribute("aria-pressed", String(key === name));
    });
  }

  // The lines of the view the model holds ("" for none), from the viewer
  // (onViewHeld).
  function showOutline(name) {
    state.outlineView = name || "";
    if (!state.outlineView) markPlanView("");
    placeOutline();
    if (!state.planViews) return;
    Object.keys(state.planViews).forEach(function (key) {
      state.planViews[key].outline.classList.toggle("is-shown", key === state.outlineView);
    });
  }

  // Lays the shown view's lines on the model: the viewer's figures for the
  // view (viewPlacement: its centre and a mm, shares of the canvas, which is
  // the model's box), set as shares of the box for CSS to place the view's
  // rectangle at the chosen size against the box (.product-outline,
  // --plan-ratio its proportions), where the viewer draws the outline.
  // Re-run whenever the model's size or scale may have changed.
  function placeOutline() {
    var view = state.planViews && state.planViews[state.outlineView];
    var handle = state.modelHandle;
    var place = view && state.planFrame && handle && handle.viewPlacement ? handle.viewPlacement(state.outlineView) : null;
    if (!place) return;
    var crop = H.planFrame(state.view, state.sizeMm).crop;
    view.outline.style.setProperty("--plan-ratio", (crop.w / crop.h).toFixed(4));
    view.outline.style.setProperty("--outline-x", place.x.toFixed(5));
    view.outline.style.setProperty("--outline-y", place.y.toFixed(5));
    view.outline.style.setProperty("--outline-w", (crop.w * place.mm).toFixed(5));
  }

  /* ---- the two stages ---- */

  // js/product-stages.js publishes the eased transition and CSS fades in
  // phases (out, blank, in). This handles the rest: the feed's room, the
  // design column's room, and the model. Inspiration -> design: an inversion
  // band sweeps up the screen, revealing the model behind it; the model holds
  // still before it.
  function wireStages() {
    if (!stageEl) return;
    if (!window.EmjiveProductStages) return;
    stages = window.EmjiveProductStages.mount(stageEl, { onChange: onStageChange });
    // mount() published before this handle existed: fit the feed into the track now.
    fitFeed();
    stages.update();
    // Back to the pose.
    if (resetEl) {
      resetEl.addEventListener("click", function () {
        resetEl.blur();
        setModelAway(false);
        if (state.modelHandle) state.modelHandle.returnHome();
      });
    }
    var refreshQueued = false;
    function queueRefresh() {
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(function () {
        refreshQueued = false;
        refreshStage();
      });
    }
    window.addEventListener("resize", queueRefresh);
    // The column grows and shrinks (a text's glide, a row wrapping): the
    // design stretch follows.
    var below = document.querySelector(".product-below");
    if (below && window.ResizeObserver) new ResizeObserver(queueRefresh).observe(below);
  }

  function onStageChange(stage) {
    state.toDesign = stage.toDesign;
    state.flow = stage.stage === "flow";
    refreshStage();
    var costs = document.getElementById("productCosts");
    if (costs && !state.flow && stage.toDesign < 0.5 && costs.classList.contains("is-built")) buildCosts(costs, false);
    // In design a released model stays put (the reset button returns it);
    // elsewhere it eases home. Out of sight it pauses.
    var autoReturn = stage.stage !== "design";
    if (autoReturn !== state.autoReturn) {
      state.autoReturn = autoReturn;
      var handle = state.modelHandle;
      if (handle) {
        handle.setAutoReturn(autoReturn);
        if (autoReturn && stage.stage === "flow") handle.returnHome();
      }
    }
    var out = !state.flow && stage.toDesign <= MODEL_FROM;
    if (out === state.designOut) return;
    state.designOut = out;
    if (state.modelHandle) state.modelHandle.setPaused(out);
  }

  // The cost chart builds once it's in view, and resets once design is left
  // (onStageChange), to build again on the way back.
  var COSTS_IN_VIEW = 0.5;
  function wireCosts() {
    var costs = document.getElementById("productCosts");
    if (!costs || !window.IntersectionObserver) {
      if (costs) buildCosts(costs, true);
      return;
    }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !costs.classList.contains("is-built")) buildCosts(costs, true);
      });
    }, { threshold: COSTS_IN_VIEW }).observe(costs);
  }

  function buildCosts(costs, on) {
    clearTimeout(state.settleTimer);
    if (!on) {
      costs.classList.remove("is-built", "is-settled");
      return;
    }
    costs.classList.add("is-built");
    // After the cascade (ends by 2.15 s in CSS), figure changes move all bars at once.
    state.settleTimer = setTimeout(function () { costs.classList.add("is-settled"); }, 2300);
  }

  // The inspiration stretch scrolls the feed up until its end (the trail, already
  // the page colour) stands FEED_CLEAR_REM above the bottom bars, clear of the
  // bottom veil's blurs. Published as --feed-room (js/product-stages.js sizes
  // the stretch from it). Measured unshifted against the bars at their highest,
  // so it holds still; re-fitted as photos arrive and on resize.
  var FEED_CLEAR_REM = 4;
  var feedRoom = 0;
  function fitFeed() {
    var feed = document.getElementById("productFeedColumn");
    var show = document.querySelector(".product-stage__show");
    if (!stageEl || !feed || !show) return;
    var room = 0;
    if (!state.flow) {
      var rem = remPx();
      var showTop = show.getBoundingClientRect().top - pinShift() + browsePx();
      var bottom = showTop + feed.offsetTop + feed.offsetHeight;
      room = Math.max(0, bottom - (barsTopPx() - FEED_CLEAR_REM * rem));
    }
    if (Math.abs(room - feedRoom) < 0.5) return;
    feedRoom = room;
    stageEl.style.setProperty("--feed-room", room.toFixed(1) + "px");
    if (stages) stages.update();
  }

  // The bottom bars' top in screen px: the small viewport's bottom minus
  // --bars-h (a probe), stable as the page moves.
  var barsHeightProbe = null;
  function barsTopPx() {
    if (!barsHeightProbe) barsHeightProbe = lengthProbe(stageEl, "width:0;height:var(--bars-h)");
    return screenHeight() - barsHeightProbe.offsetHeight;
  }

  // An invisible box in `host` sized by CSS lengths (`size`, a width and a
  // height), so their px can be read off it.
  function lengthProbe(host, size) {
    var probe = el("div", null);
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;" + size;
    host.appendChild(probe);
    return probe;
  }

  // The show's current browse offset (its transform), so measurements can undo it.
  function browsePx() {
    var show = document.querySelector(".product-stage__show");
    if (!show) return 0;
    var t = getComputedStyle(show).transform;
    if (!t || t === "none") return 0;
    return -new DOMMatrix(t).m42;
  }

  // How far the pin stands off its stick point: 0 while it is stuck, which is
  // the whole track, and the bounce while iOS rubber-bands past an end. Taken
  // off the screen positions read here, so a re-fit on the bounce's scroll
  // events doesn't undo it (the model held still while the page moves).
  var stagePin = null;
  function pinShift() {
    if (!stagePin) stagePin = stageEl && stageEl.querySelector(".product-stage__pin");
    if (!stagePin) return 0;
    return stagePin.getBoundingClientRect().top - (parseFloat(getComputedStyle(stagePin).top) || 0);
  }

  // The design column (the configuration, then the information) can reach
  // under the bottom bars: the design stretch scrolls the show up until its
  // end clears them by DESIGN_CLEAR_REM (--design-room). Measured with the
  // browse removed and the model's lift in. Never under the browse already
  // done, so a re-fit never pulls the page from under the finger.
  var DESIGN_CLEAR_REM = 4;
  var designRoom = 0;
  function fitDesignRoom() {
    if (!stageEl) return;
    var room = 0;
    var below = document.querySelector(".product-below");
    if (!state.flow && below) {
      var browsed = browsePx();
      var bottom = below.getBoundingClientRect().bottom - pinShift() + browsed;
      room = Math.max(0, browsed, bottom - (barsTopPx() - DESIGN_CLEAR_REM * remPx()));
    }
    if (Math.abs(room - designRoom) < 0.5) return;
    designRoom = room;
    stageEl.style.setProperty("--design-room", room.toFixed(1) + "px");
    // The stretch is as long as covering the room takes.
    if (stages) stages.update();
  }

  // The stable small-viewport height (js/product-stages.js screenPx):
  // innerHeight changes mid-scroll on iOS and would shift the fades and the model.
  function screenHeight() {
    return window.EmjiveProductStages && window.EmjiveProductStages.screenPx ? window.EmjiveProductStages.screenPx() : window.innerHeight;
  }

  // Where design holds the model, as its lift (px up from rest): its middle
  // at DESIGN_ANCHOR of the screen (or under the title bar), then
  // DESIGN_GAP_REM lower. Everything placed against
  // the model, the x-ray included, goes with it.
  var DESIGN_ANCHOR = 1 / 3;
  var DESIGN_GAP_REM = 4.5;
  // The model's approximate half-height as a share of its tile.
  var DESIGN_HALF_HEIGHT = 0.13;
  function designLift() {
    if (!designFrameEl || state.flow) return 0;
    var titleBar = labelBar();
    var shift = pinShift();
    var titleBottom = titleBar ? titleBar.getBoundingClientRect().bottom - shift : 0;
    var browsed = browsePx();
    var box = designFrameEl.getBoundingClientRect();
    var half = DESIGN_HALF_HEIGHT * box.height;
    var target = Math.max(DESIGN_ANCHOR * screenHeight(), titleBar ? titleBottom + half + 8 : 0) + DESIGN_GAP_REM * remPx();
    return Math.max(0, box.top - shift + box.height / 2 + browsed - target);
  }

  // Derives the show from state.toDesign and the page's layout: the model's
  // lift, the design column's room and the band's reveal. Runs on every scroll
  // and resize change and when a viewer arrives.
  function refreshStage() {
    if (!stageEl) return;
    var band = document.getElementById("productScan");
    state.lift = designLift();
    stageEl.style.setProperty("--lift", state.lift.toFixed(1) + "px");
    fitDesignRoom();
    // The band rises with the scroll; the model shows behind it by cutting its
    // box at the band's top edge (--model-cut), so the poster and icon reveal
    // like the live model. Design's controls come in from when the band's top
    // meets the title bar (--d-from).
    var titleBar = labelBar();
    if (band && titleBar && !state.flow) {
      var fromH = screenHeight();
      var dFrom = (fromH - (titleBar.getBoundingClientRect().bottom - pinShift())) / (fromH + band.offsetHeight);
      stageEl.style.setProperty("--d-from", clamp(dFrom, 0.3, 0.95).toFixed(4));
    }
    var cutting = !!band && !state.flow && state.toDesign > 0 && state.toDesign < 1;
    if (cutting) {
      var bandH = band.offsetHeight;
      var viewportH = screenHeight();
      var cutY = viewportH + bandH / 2 - (viewportH + bandH) * state.toDesign;
      band.style.top = cutY.toFixed(1) + "px";
      if (modelBoxEl) modelBoxEl.style.setProperty("--model-cut", (cutY - bandH / 2 - modelBoxEl.getBoundingClientRect().top).toFixed(1) + "px");
    } else if (modelBoxEl) {
      modelBoxEl.style.removeProperty("--model-cut");
    }
    if (modelBoxEl) modelBoxEl.classList.toggle("is-cut", cutting);
    if (band) band.classList.toggle("is-on", cutting);
    fitFeed();
    applyStageToViewer();
  }

  function applyStageToViewer() {
    if (!state.modelHandle) return;
    state.modelHandle.setSize(state.sizeMm);
    placeOutline();
  }

  // The model's share of its box: 1 / --model-room (css/style.css, the design
  // frame), the rest being room for larger sizes. Read once.
  var modelRestShare = 0;
  function modelRest() {
    if (!modelRestShare) {
      var room = designFrameEl ? parseFloat(getComputedStyle(designFrameEl).getPropertyValue("--model-room")) : 1;
      modelRestShare = room > 0 ? 1 / room : 1;
    }
    return modelRestShare;
  }

  // The model is drawn and its costs shown at SIZE_BASE_MM until a size is given;
  // the bounds are the product's size-range, set on render. setModelSize sizes
  // the model, costs, plan views and tape to a typed size (none: the base),
  // clamped to the range; only a size within it goes on the label and prices it.
  var SIZE_BASE_MM = H.REFERENCE_SIZE_MM;
  var SIZE_MIN_MM = 40;
  var SIZE_MAX_MM = 80;
  function setModelSize(raw) {
    var sel = window.EmjiveSelection;
    var mm = parseFloat(raw);
    var given = sel.isValidSize(raw) && isFinite(mm);
    var was = state.sizeMm;
    state.sizeMm = given ? clamp(mm, SIZE_MIN_MM, SIZE_MAX_MM) : SIZE_BASE_MM;
    if (state.sizeMm !== was) hideMarksWhileSizing();
    state.sizeText = state.product && sel.isOrderableSize(state.product, raw) ? String(+mm.toFixed(2)) : "";
    applyStageToViewer();
    if (state.product) {
      renderCosts();
      renderLabelType(state.product);
      renderLabelPrice(state.product);
      var field = document.getElementById("productSizeInput");
      if (field) sel.syncSizeField(field, state.product);
    }
    syncPlanSizes();
    syncSizeDial();
  }

  // The size dial at the model's size, the visitor's once orderable.
  function syncSizeDial() {
    if (state.sizeDial) state.sizeDial.set(state.sizeMm, state.sizeText !== "");
  }

  function hideScanBand() {
    var band = document.getElementById("productScan");
    if (band) band.classList.remove("is-on");
  }

  /* ---- 4. the size dial, the review sheet and the selection ---- */

  // The Select bar's button: "Add" opens the sheet, the item as configured
  // (shape, material, size) to review and change in place; "Confirm" adds it
  // while the sheet is open (aria-disabled unless the size is orderable). The label
  // fades through its change. Also wires the size dial, which writes the
  // size into a hidden field ("62.0"); the model follows (setModelSize).
  function wireSelectButton(product) {
    var selectBtn = document.getElementById("selectButton");
    // Whether the category is sized at all is in the global vocabulary (its
    // "unit"); sizes show as plain numbers.
    var info = window.EmjiveSeries.categoryInfo(product.category);

    var selectBar = document.getElementById("productSelectBar");
    var selectLabel = selectBar.querySelector(".product-select-bar__label");
    selectBar.hidden = false;

    // Steps aside while the Modify sheet rests where this bar rides.
    function setBarAway(away) {
      selectBar.classList.toggle("is-away", away);
      selectBar.inert = away;
    }
    window.addEventListener("emjive:modify-open", function () { setBarAway(true); });
    window.addEventListener("emjive:modify-close", function () { setBarAway(false); });

    // A unitless category has nothing to measure: Add stays disabled.
    if (!info.unit) {
      selectBtn.setAttribute("aria-disabled", "true");
      selectLabel.textContent = "No sizes available";
      return;
    }

    var modal = document.getElementById("sizeModal");
    var sizeField = document.getElementById("productSizeInput");
    // The field holds one decimal, as the dial writes it ("62.0").
    function oneDecimal(size) {
      var mm = parseFloat(window.EmjiveSelection.normalizeSize(size));
      return isFinite(mm) ? mm.toFixed(1) : "";
    }
    // "Find my size", under the dials, with the category's size guide; none without one.
    var guide = info["size-guide"];
    var hasFinder = !!(window.EmjiveSizeFinder && guide && guide.rows && guide.rows.length);
    var dialHost = document.getElementById("productSizeDial");
    dialHost.hidden = false;
    state.sizeDial = window.EmjiveOptionDial.mountSize(dialHost, {
      range: { min: SIZE_MIN_MM, max: SIZE_MAX_MM },
      onChange: function (mm) {
        sizeField.value = mm.toFixed(1);
        setModelSize(sizeField.value);
      },
      onShow: showDialName,
      // Its result goes in as if typed.
      onFind: hasFinder ? function () {
        window.EmjiveSizeFinder.open({
          guide: guide,
          returnFocus: state.sizeDial.finder,
          onFill: function (size) {
            sizeField.value = oneDecimal(size);
            sizeField.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
      } : null
    });
    if (state.sizeDial.finder) document.getElementById("productConfig").appendChild(state.sizeDial.finder);
    // The field starts at the default size, within the range (syncs the dial).
    if (sizeField.value === "") sizeField.value = clamp(H.DEFAULT_SIZE_MM, SIZE_MIN_MM, SIZE_MAX_MM).toFixed(1);
    setModelSize(sizeField.value);
    sizeField.addEventListener("input", function () {
      var cleaned = window.EmjiveSelection.sanitizeSizeInput(sizeField.value);
      if (cleaned !== sizeField.value) sizeField.value = cleaned;
      setModelSize(sizeField.value);
    });

    var swapTimer = null;
    function setBarLabel(text) {
      if (selectLabel.textContent === text) return;
      clearTimeout(swapTimer);
      selectLabel.classList.add("is-swapping");
      swapTimer = setTimeout(function () {
        selectLabel.textContent = text;
        selectLabel.classList.remove("is-swapping");
      }, 80);
    }

    // The review's size, typed in place.
    var reviewSize = document.getElementById("sizeModalSize");

    // A size within the product's range: what Confirm needs, typed as well
    // while the sheet is open.
    function orderable() {
      var sel = window.EmjiveSelection;
      if (!sel.isOrderableSize(product, sizeField.value)) return false;
      return !modal.classList.contains("is-open") || sel.isOrderableSize(product, reviewSize.value);
    }

    function syncBar() {
      var isOpen = modal.classList.contains("is-open");
      setBarLabel(isOpen ? "Confirm" : "Add");
      // Confirm gives the bar its own ground (.product-select-bar.is-confirm).
      selectBar.classList.toggle("is-confirm", isOpen);
      selectBtn.setAttribute("aria-disabled", String(isOpen && !orderable()));
    }

    // The shape and material rows pick through the page's own handlers, so
    // the dials, label and model follow.
    var shapePicker = reviewPicker(document.getElementById("sizeModalShape"), "sizeModalShapeLabel", function (key) {
      onDesignSelect(product, key);
      fillReview();
    });
    var materialPicker = reviewPicker(document.getElementById("sizeModalMaterial"), "sizeModalMaterialLabel", function (metal) {
      if (state.materialDial) state.materialDial.select(metal);
      onMetalSelect(product, metal);
      fillReview();
    });
    var pickers = [shapePicker, materialPicker];
    // One list open at a time.
    pickers.forEach(function (picker) {
      picker.onOpen = function () {
        pickers.forEach(function (other) { if (other !== picker) other.close(); });
      };
    });
    // A tap elsewhere in the sheet closes an open list.
    modal.addEventListener("click", function (e) {
      pickers.forEach(function (picker) {
        if (!picker.root.contains(e.target)) picker.close();
      });
    });

    // The typed size goes in once orderable, as if dialled; until then
    // Confirm waits (and the field shows aria-invalid).
    reviewSize.addEventListener("input", function () {
      var sel = window.EmjiveSelection;
      var cleaned = sel.sanitizeSizeInput(reviewSize.value);
      if (cleaned !== reviewSize.value) reviewSize.value = cleaned;
      sel.syncSizeField(reviewSize, product);
      if (sel.isOrderableSize(product, cleaned)) {
        sizeField.value = cleaned;
        sizeField.dispatchEvent(new Event("input", { bubbles: true }));
      }
      syncBar();
    });
    reviewSize.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (orderable()) confirmAdd();
    });

    // The review's values; the shape only with a shape dial.
    function fillReview() {
      document.getElementById("sizeModalShapeRow").hidden = !state.shapeDial;
      if (state.shapeDial) {
        shapePicker.set(product.designs.list.map(function (design) { return design.key; }), state.designKey);
      }
      materialPicker.set(state.metals, state.selectedMetal);
      reviewSize.value = state.sizeText;
      window.EmjiveSelection.syncSizeField(reviewSize, product);
    }

    // The value column fits the widest option of every picker (the listed
    // ones and the value shown), set once per opening so the chevrons hold
    // still while options change. Measured with the column at max-content.
    function fitValueColumn() {
      var review = modal.querySelector(".size-modal__review");
      review.style.removeProperty("--review-value-w");
      var widest = 0;
      modal.querySelectorAll(".review-pick__option, .review-pick__value").forEach(function (node) {
        widest = Math.max(widest, node.getBoundingClientRect().width);
      });
      review.style.setProperty("--review-value-w", Math.ceil(widest) + "px");
    }

    function openModal() {
      fillReview();
      fitValueColumn();
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      syncBar();
      // After .is-open (focus() is a no-op while hidden). The trap also locks
      // the page; Confirm, in the bar, is in its reach.
      window.EmjiveFocusTrap.activate(modal, {
        include: selectBar,
        returnFocus: selectBtn,
        // An open list closes first, focus back on its value.
        onEscape: function () {
          var open = pickers.filter(function (picker) { return picker.isOpen(); })[0];
          if (open) open.close(true);
          else closeModal();
        }
      });
    }

    function closeModal() {
      pickers.forEach(function (picker) { picker.close(); });
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      // Before the trap releases, so focus lands on a live button.
      syncBar();
      window.EmjiveFocusTrap.release();
    }

    // Reached via Confirm for an orderable size; the guard covers stale callbacks.
    function confirmAdd() {
      if (!orderable()) return;
      var view = state.view;
      var size = window.EmjiveSelection.normalizeSize(sizeField.value);
      var item = {
        // Ids are only unique within a series.
        series: state.seriesSlug,
        productId: product.id,
        // The chosen design's name and icon.
        name: view.designName || product.name,
        category: product.category,
        metal: state.selectedMetal,
        // Canonical form ("62.5" -> "62.50").
        size: size,
        price: window.EmjiveSelection.priceAt(view, state.selectedMetal, size),
        image: H.assetFor(view, "icons", state.selectedMetal)
      };
      if (product.designs) item.design = state.designKey;
      window.EmjiveSelection.addItem(item);
      closeModal();
    }

    selectBtn.addEventListener("click", function () {
      if (!modal.classList.contains("is-open")) openModal();
      else if (orderable()) confirmAdd();
    });
    document.getElementById("sizeModalBackdrop").addEventListener("click", closeModal);
    // Escape is the focus trap's onEscape.

    // A Modify sheet opening (from the bar's drawer): this sheet steps aside.
    window.addEventListener("emjive:modify-open", function () {
      if (modal.classList.contains("is-open")) closeModal();
    });
  }

  // A review row's picker, built into the <dd> host: the value with a
  // chevron, toggling a list of the other options under it; a single option
  // is plain text. onPick(key) runs for the option picked; set() repaints.
  function reviewPicker(host, labelId, onPick) {
    var toggle = el("button", "review-pick__toggle");
    toggle.type = "button";
    toggle.id = host.id + "Toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-labelledby", labelId + " " + toggle.id);
    var value = el("span", "review-pick__value");
    var chevron = el("span", "review-pick__chevron");
    chevron.setAttribute("aria-hidden", "true");
    toggle.append(value, chevron);
    var list = el("ul", "review-pick__list");
    list.id = host.id + "List";
    list.setAttribute("aria-labelledby", labelId);
    toggle.setAttribute("aria-controls", list.id);
    var clip = el("div", "review-pick__clip");
    clip.appendChild(list);
    var menu = el("div", "review-pick__menu");
    menu.appendChild(clip);
    host.replaceChildren(toggle, menu);

    var api = {
      root: host,
      onOpen: null,
      isOpen: function () { return host.classList.contains("is-open"); },
      // focusToggle: focus back on the value, for a close from inside the list.
      close: function (focusToggle) {
        if (!api.isOpen()) return;
        host.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        if (focusToggle) toggle.focus();
      },
      set: function (keys, selected) {
        value.textContent = selected;
        var single = keys.length < 2;
        toggle.disabled = single;
        chevron.hidden = single;
        var others = keys.filter(function (key) { return key !== selected; });
        list.replaceChildren.apply(list, others.map(function (key) {
          var option = el("button", "review-pick__option", key);
          option.type = "button";
          option.addEventListener("click", function () {
            api.close(true);
            onPick(key);
          });
          var item = el("li");
          item.appendChild(option);
          return item;
        }));
      }
    };
    toggle.addEventListener("click", function () {
      if (api.isOpen()) return api.close();
      if (api.onOpen) api.onOpen();
      host.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
    });
    return api;
  }

  init();
})();
