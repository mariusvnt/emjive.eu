// The product page: resolves the item from the address and renders its label,
// photo feed, model, metal picker, design options, specs and the selection
// flow across the three stages js/product-stages.js drives, handling what CSS
// can't (the model's blueprint sweep, its rise into specs, the feed's room).

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;
  var clamp = H.clamp;
  var invEase = H.invSmootherstep;

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
    // model, label thumbnail, specs and selection.
    view: null,
    designKey: "",
    // The loader hold while a design's model is loading.
    swapHold: null,
    metals: [],
    // data/series.json "metal-costs" (computeCosts).
    metalCosts: {},
    // data/series.json "metal-technology" and "printing-technologies".
    metalTechnology: {},
    technologies: {},
    // data/series.json "metal-composition".
    compositions: {},
    // Each caption with its picture, for inkCaption.
    captions: [],
    selectedMetal: null,
    modelHandle: null,
    // The model box's posters until the viewer is in: fallback-img, and over it
    // the specs-poster, shown as specs comes in (syncPosters).
    posterImg: null,
    specsPosterImg: null,
    // The x-ray's original file (startXray picks the viewport's version) and whether the watcher is wired.
    xraySrc: "",
    xrayWatching: false,
    iconFallbackImg: null,
    // The stage transitions (0..1) and what they make of the model (refreshStage),
    // kept so a viewer built later starts where the page is.
    toDesign: 0,
    toSpecs: 0,
    // Design's controls out of sight: the viewer is paused.
    designOut: true,
    // Linear progress through the design stretch and the transition to specs: the model's rise.
    along: 0,
    // The design stretch's ease-in share (js/product-stages.js).
    ramp: 1,
    // Whether a released model eases home by itself: not in design, where the
    // reset button does it.
    autoReturn: true,
    // The model is turned off its pose (reported by the viewer).
    modelAway: false,
    sweep: 0,
    fit: 0,
    // The chosen size over the model's base size (setModelSize), and the valid
    // size in the specs field ("" if none: no size on the label).
    sizeFactor: 1,
    sizeText: "",
    // A metal has been picked (the default isn't a pick): until then the price
    // reads from the cheapest metal.
    metalPicked: false,
    // The size tape's elements (wireSizeTape).
    sizeTape: null,
    // The plan views' elements by view name, the design's frame
    // (EmjiveHelpers.planFrame), and whether the pictures may load yet.
    planViews: null,
    planFrame: null,
    planImagesOn: false,
    // The model's lift on its way into specs, px (refreshStage).
    lift: 0,
    // Whether the specs size has its starting value (62).
    sizeSeeded: false,
    seedSize: null,
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

  // The address: /<slug> (served by public/.htaccess and the per-item pages,
  // emitItemPages() in vite.config.js), or the legacy product.html?id=01[&series=x],
  // rewritten once found (canonicalizeUrl).
  function getRequest() {
    var last = window.location.pathname.split("/").pop() || "";
    var slug;
    try { slug = decodeURIComponent(last).toLowerCase(); } catch (e) { slug = last.toLowerCase(); }
    if (slug === "product.html" || slug === "product") slug = "";
    return {
      slug: slug,
      id: new URLSearchParams(window.location.search).get("id")
    };
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
      href: (slug ? window.EmjiveSeries.mainHref(slug) : "/gallery") + "#products"
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
  // series too; a legacy ?id= is only unique within one. Either way the active
  // series is tried first, then the others in index order.
  function findProduct(slug, request) {
    var matches = function (p) {
      return request.slug ? window.EmjiveSeries.productSlug(p) === request.slug : p.id === request.id;
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
        state.metalCosts = ctx.index["metal-costs"] || {};
        state.metalTechnology = ctx.index["metal-technology"] || {};
        state.technologies = ctx.index["printing-technologies"] || {};
        state.compositions = ctx.index["metal-composition"] || {};
        return findProduct(ctx.slug, getRequest());
      })
      .then(function (found) {
        if (!found) return showNotFound();
        state.product = found.product;
        state.seriesSlug = found.slug;
        canonicalizeUrl(found.product);
        render(found.product);
      })
      .catch(showLoadError);
  }

  // Legacy addresses become /<slug> without a reload or history entry, the hash
  // kept. Only the shared template is rewritten.
  function canonicalizeUrl(product) {
    var here = window.location.pathname;
    if (here !== "/product.html" && here !== "/product") return;
    if (!window.history || typeof window.history.replaceState !== "function") return;
    var want = window.EmjiveSeries.productHref(product, state.seriesSlug);
    window.history.replaceState(window.history.state, "", want + window.location.hash);
  }

  // For the shared product.html (legacy links, dev server), whose static head
  // can't carry per-item metadata; the built per-item pages already do.
  function updateSearchMetadata(product) {
    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    if (!canonical.getAttribute("href")) {
      canonical.href = new URL(window.EmjiveSeries.productHref(product, state.seriesSlug), window.location.origin).href;
    }

    var description = document.querySelector('meta[name="description"]');
    if (description && product.description) description.setAttribute("content", product.description);
  }

  function render(product) {
    document.title = (product.name || "Product") + " — em·ji·ve";
    updateSearchMetadata(product);
    state.selectedMetal = product["default-metal"] || state.metals[0] || "steel";
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
    renderDesigns(product);
    renderMetalOptions(product);
    renderSpecs();
    renderPlanViews();
    renderPrinting();
    renderComposition();
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
  // after a cap, or after two frames without the LCP API.
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
      setTimeout(finish, AFTER_PAINT_CAP_MS);
      var frame = document.getElementById("productFeedColumn");
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
  // hidden without assets.xray. Loaded after the first paint.
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

  // After the first paint: other metals' icons, the rest of the feed, the plan
  // views, the viewer and the x-ray.
  function loadRemainingAssets(product, feed, modelParts) {
    preloadIcons(state.view);
    feed.loadRest();
    state.planImagesOn = true;
    renderPlanViews();
    modelParts.mountViewer();
    startXray(product);
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

  // ".category.metal", plus ".size" once the specs field holds one (appendSize, as in the rows).
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

  // "from" the cheapest metal until one is picked, "from" that metal's lowest
  // until a size is given, then the price at that size.
  function renderLabelPrice(product) {
    var sel = window.EmjiveSelection;
    document.getElementById("productLabelPrice").textContent = state.sizeText
      ? sel.formatPrice(sel.priceAt(product, state.selectedMetal, state.sizeText))
      : sel.formatPriceFrom(sel.priceFrom(product, state.metalPicked ? state.selectedMetal : ""));
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
  function remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
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

  /* ---- 2b. the model (design, then specs) ---- */

  // The model's box: its posters (fallback-img, the viewer's first frame, and
  // the specs-poster in specs) under the viewer until its first frame is in;
  // the icon without a model or viewer. Built for the design and metal current
  // when it arrives; later design picks swap the model in place (onDesignSelect).
  function renderModel(product) {
    var box = modelBoxEl;
    box.innerHTML = "";
    box.classList.remove("is-model");
    state.modelHandle = null;
    setModelAway(false);
    state.posterImg = null;
    state.specsPosterImg = null;
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
        // the width as margin); presses outside scroll the page. Specs shrinks it
        // (--hit-scale in css/style.css, which assumes this margin).
        hitCircle: 0.25,
        onAway: setModelAway,
        // Also fires for a lost WebGL context, possibly long after loading (iOS
        // reclaims GPU contexts under memory pressure).
        onError: replaceModelWithIcon,
        onReady: function () {
          dropPosters();
          settleViewer();
        },
        // The page's posters stay under it instead: the viewer's own would be the design stage's.
        poster: false,
        // The specs stage's metal -> blueprint sweep and wireframe (onStageChange).
        blueprint: { lineColor: pageColor("--category-col", "#727272") }
      });
    }

    // Before the viewer's first frame: the posters, sized like the viewer, so
    // the swap moves nothing (as in js/modify-modal.js posterBox()).
    function showPoster() {
      box.innerHTML = "";
      state.posterImg = null;
      state.specsPosterImg = null;
      var src = H.posterFor(state.view, state.selectedMetal);
      if (!src) return;
      var poster = el("div", "size-modal__model-poster");
      var img = document.createElement("img");
      img.src = src;
      img.alt = product.name || "";
      img.draggable = false;
      poster.appendChild(img);
      // The model as specs draws it, for a page opened (or scrolled) there before the viewer.
      var specs = document.createElement("img");
      specs.alt = "";
      specs.draggable = false;
      poster.appendChild(specs);
      box.appendChild(poster);
      state.posterImg = img;
      state.specsPosterImg = specs;
      syncPosters();
    }

    function dropPosters() {
      var poster = box.querySelector(".size-modal__model-poster");
      if (poster) box.removeChild(poster);
      state.posterImg = null;
      state.specsPosterImg = null;
    }

    // Lays the viewer over the posters, which go at its first frame; also the
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
      // Wherever the show is now (a rebuild can land in specs).
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
      state.specsPosterImg = null;
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

  /* ---- 2c. design options (design) ---- */

  // One row per option under the model: its label and choice buttons. A
  // "multiple" option is a set of toggles (the last one can't be turned off);
  // others pick one. A pick lands on the design with exactly those picks, or
  // else the one keeping the new pick and most of the others (first listed of
  // equals). Choices that wouldn't land exactly are dimmed.
  function renderDesigns(product) {
    var host = document.getElementById("productOptions");
    host.innerHTML = "";
    var designs = product.designs;
    if (!designs || !Array.isArray(designs.options) || !Array.isArray(designs.list) || designs.list.length < 2) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    designs.options.forEach(function (option, i) {
      var row = el("div", "product-option");
      row.setAttribute("role", "group");
      var label = el("span", "product-option__label", option.label);
      label.id = "productOptionLabel" + i;
      row.setAttribute("aria-labelledby", label.id);
      var choices = el("div", "product-option__choices");
      option.choices.forEach(function (choice) {
        var button = el("button", "product-option__choice", choice);
        button.type = "button";
        button.setAttribute("data-option", option.key);
        button.setAttribute("data-choice", choice);
        button.addEventListener("click", function () { pickChoice(product, option, choice); });
        choices.appendChild(button);
      });
      row.appendChild(label);
      row.appendChild(choices);
      host.appendChild(row);
    });
    syncDesignChoices(product);
  }

  function currentDesign(product) {
    var list = product.designs.list;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === state.designKey) return list[i];
    }
    return list[0];
  }

  // A design's picks for an option, as a list.
  function picksOf(design, option) {
    var pick = design.picks && design.picks[option.key];
    return Array.isArray(pick) ? pick.slice() : pick === undefined ? [] : [pick];
  }

  function samePicks(a, b) {
    if (a.length !== b.length) return false;
    var x = a.slice().sort();
    var y = b.slice().sort();
    for (var i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return false;
    }
    return true;
  }

  // The picks a tap on `choice` would give; null for the last one on of a multiple option.
  function nextPicks(product, option, choice) {
    var design = currentDesign(product);
    var picks = {};
    product.designs.options.forEach(function (o) { picks[o.key] = picksOf(design, o); });
    if (option.multiple) {
      var set = picks[option.key];
      var at = set.indexOf(choice);
      if (at === -1) set.push(choice);
      else if (set.length === 1) return null;
      else set.splice(at, 1);
    } else {
      picks[option.key] = [choice];
    }
    return picks;
  }

  function exactDesign(product, picks) {
    var options = product.designs.options;
    return product.designs.list.find(function (design) {
      return options.every(function (o) { return samePicks(picksOf(design, o), picks[o.key]); });
    }) || null;
  }

  function landingDesign(product, option, picks) {
    var exact = exactDesign(product, picks);
    if (exact) return exact;
    var best = null;
    var bestScore = -1;
    product.designs.list.forEach(function (design) {
      if (!samePicks(picksOf(design, option), picks[option.key])) return;
      var score = product.designs.options.filter(function (o) {
        return o !== option && samePicks(picksOf(design, o), picks[o.key]);
      }).length;
      if (score > bestScore) {
        best = design;
        bestScore = score;
      }
    });
    return best;
  }

  function pickChoice(product, option, choice) {
    var picks = nextPicks(product, option, choice);
    if (!picks) return;
    // A plain option's choice no design has with the other picks: no-op.
    if (!option.multiple && !exactDesign(product, picks)) return;
    var design = landingDesign(product, option, picks);
    if (design) onDesignSelect(product, design.key);
  }

  // Choice states for the current design: pressed (its picks); dimmed (no
  // design has the combination a tap would make; never for a chosen one);
  // disabled (the last one on of a multiple option, or a dimmed plain choice).
  function syncDesignChoices(product) {
    var design = currentDesign(product);
    var buttons = document.querySelectorAll("#productOptions .product-option__choice");
    Array.prototype.forEach.call(buttons, function (button) {
      var option = product.designs.options.find(function (o) { return o.key === button.getAttribute("data-option"); });
      if (!option) return;
      var choice = button.getAttribute("data-choice");
      var current = picksOf(design, option);
      var on = current.indexOf(choice) !== -1;
      var last = !!option.multiple && on && current.length === 1;
      var picks = last ? null : nextPicks(product, option, choice);
      var unavailable = !on && !(picks && exactDesign(product, picks));
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-disabled", String(last || (unavailable && !option.multiple)));
      button.classList.toggle("is-unavailable", unavailable);
    });
  }

  // Another design: label, thumbnail, specs and model follow. The viewer swaps
  // models in place, camera kept (setProduct), under the frame's loader; a
  // viewer not built yet is built as this design.
  function onDesignSelect(product, key) {
    if (key === state.designKey) return;
    state.designKey = key;
    state.view = window.EmjiveSeries.resolveDesign(product, key).view;
    syncDesignChoices(product);
    renderLabelDesign(product);
    renderLabelThumb();
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = H.assetFor(state.view, "icons", state.selectedMetal);
    }
    if (state.posterImg) state.posterImg.src = H.posterFor(state.view, state.selectedMetal);
    syncPosters();
    renderSpecs();
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

  // Two pickers (the page's and the Select sheet's), each mirroring the other.
  function renderMetalOptions(product) {
    var pagePicker = null;
    var sheetPicker = null;
    pagePicker = window.EmjiveMetalPicker.mount(document.getElementById("productMetals"), {
      metals: state.metals,
      selected: state.selectedMetal,
      onSelect: function (metal) {
        if (sheetPicker) sheetPicker.select(metal);
        onMetalSelect(product, metal);
      }
    });
    var sheetMetals = document.getElementById("sizeModalMetals");
    if (!sheetMetals) return;
    sheetPicker = window.EmjiveMetalPicker.mount(sheetMetals, {
      metals: state.metals,
      selected: state.selectedMetal,
      row: true,
      onSelect: function (metal) {
        pagePicker.select(metal);
        onMetalSelect(product, metal);
      }
    });
  }

  // Re-tint after the text changes have painted: rebuilding materials can hold
  // a phone's next frame.
  var tintAfterPaint = H.afterPaint(function () {
    if (state.modelHandle) state.modelHandle.applyMetal(state.selectedMetal);
  });

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
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = H.assetFor(view, "icons", metal);
    }
    // The poster too, if the viewer isn't in yet.
    if (state.posterImg) state.posterImg.src = H.posterFor(view, metal);
    renderSpecs();
    renderPrinting();
    renderComposition();
    tintAfterPaint();
  }

  /* ---- specs ---- */

  // Weight and costs for one metal from the piece's volume and the metal's
  // "metal-costs": raw materials = weight x (1 + loss margin) x price per gram
  // (processes lose metal); manufacturing = production cost - raw. Weight in
  // grams. null if an input is missing.
  function computeCosts(volumeCm3, costs) {
    if (!(volumeCm3 > 0) || !costs) return null;
    var weight = volumeCm3 * costs["density-g-cm3"];
    var production = volumeCm3 * costs["production-per-cm3"];
    var raw = weight * (1 + costs["loss-margin"]) * costs["price-per-g"];
    return { weight: weight, raw: raw, manufacturing: production - raw, production: production };
  }

  function formatEuros(amount) {
    return "€ " + amount.toFixed(2);
  }

  // The cost chart at the chosen size (weight only feeds it), scaling with the
  // factor cubed. Uses the design's print geometry (geometry.print, from its
  // STL) when measured: that's what is made and priced.
  function renderSpecs() {
    var geometry = (state.view && state.view.geometry) || {};
    var printed = geometry.print || geometry;
    var f = state.sizeFactor;
    var volume = printed["volume-cm3"] * f * f * f;
    var costs = computeCosts(volume, state.metalCosts[state.selectedMetal]);
    var figures = { raw: "productCostRaw", manufacturing: "productCostManufacturing", production: "productCostProduction" };
    Object.keys(figures).forEach(function (key) {
      var dd = document.getElementById(figures[key]);
      var row = dd.parentNode;
      dd.textContent = costs ? formatEuros(costs[key]) : "TBD";
      // The bars are shares of the production cost: raw from 0, manufacturing to 1.
      var share = costs && costs.production > 0 ? costs.raw / costs.production : 0;
      var from = key === "manufacturing" ? share : 0;
      var to = !costs ? 0 : key === "raw" ? share : 1;
      row.style.setProperty("--from", from.toFixed(4));
      row.style.setProperty("--to", to.toFixed(4));
    });
  }

  // How the chosen metal is printed.
  function renderPrinting() {
    var section = document.getElementById("productPrinting");
    var tech = state.technologies[state.metalTechnology[state.selectedMetal]];
    var wasShown = !section.hidden;
    var from = wasShown ? section.offsetHeight : 0;
    section.hidden = !tech;
    if (!tech) return;
    document.getElementById("productPrintingName").textContent = tech.name;
    document.getElementById("productPrintingText").textContent = tech.description;
    // A different text height: glide instead of snapping.
    if (wasShown && from > 0) tweenHeight(section, from);
  }

  // The chosen metal's composition, with the same glide.
  function renderComposition() {
    var node = document.getElementById("productComposition");
    if (!node) return;
    var text = state.compositions[state.selectedMetal] || "";
    var from = node.hidden ? 0 : node.offsetHeight;
    node.hidden = !text;
    node.textContent = text;
    if (text && from > 0) tweenHeight(node, from);
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

  /* ---- plan views (specs) ---- */

  // The model's front and side views (scripts/auto-render.js), the outer
  // tiles of a row with the model in the middle, each picture centred in its tile, its labels hanging off it. They carry lines, one per axis they measure (x
  // and y on the front, z on the side; EmjiveHelpers.PLAN_VIEWS), each
  // running between the picture's two farthest points along its axis, at the
  // height (or column) of one of them, with the axis's letter past the end that
  // is on the outline; an end off the outline gets a dashed line reaching on
  // to the outline point it stands for (placed once the picture is in:
  // measureMark). Beside each letter, its length at the chosen size in cm. The pictures are drawn in their design's plan
  // frame (EmjiveHelpers.planFrame) and cropped to one rectangle for both
  // (--plan-cw, --plan-ratio: its
  // share of a tile's square and its proportions); they scale with the chosen
  // size as the model does (--plan-f, syncPlanSizes). A tap turns the model to the view for
  // PLAN_HOLD_MS before it eases back; the view stays pressed until then
  // (setModelAway). Hidden without the pictures or the frame.
  var PLAN_HOLD_MS = 2000;
  var PLAN_NAMES = { top: "Top", front: "Front", side: "Side" };
  var PLAN_AXES = ["x", "y", "z"];
  // A picture's pixel counts as drawn from this alpha (of 255).
  var PLAN_DRAWN_ALPHA = 60;
  // How far, in picture pixels, a line's end may sit from the drawing and
  // still count as on the outline.
  var PLAN_ON_PX = 2;

  // A picture's alpha, read once on a shared canvas: { w, h, data }, null if
  // it can't be read.
  var planPixelCanvas = null;
  function readPlanPicture(img) {
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    if (!w || !h) return null;
    try {
      if (!planPixelCanvas) planPixelCanvas = document.createElement("canvas");
      planPixelCanvas.width = w;
      planPixelCanvas.height = h;
      var ctx = planPixelCanvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: w, h: h, data: ctx.getImageData(0, 0, w, h).data };
    } catch (err) {
      return null;
    }
  }

  // The line for one axis of a picture, `horizontal` (along its width)
  // or not: from the drawing's first drawn pixel to its last along that axis,
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
    var near = function (a, l) {
      for (var da = -PLAN_ON_PX; da <= PLAN_ON_PX; da++) {
        for (var dl = -PLAN_ON_PX; dl <= PLAN_ON_PX; dl++) if (drawn(a + da, l + dl)) return true;
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
    var picks = ends.map(function (end, k) {
      var best = { start: 0, len: 0 };
      var run = 0;
      for (var i = 0; i < lines; i++) {
        var on = false;
        for (var d = -PLAN_ON_PX; d <= PLAN_ON_PX && !on; d++) on = drawn(end + d, i);
        run = on ? run + 1 : 0;
        if (run > best.len) best = { start: i - run + 1, len: run };
      }
      var at = best.start + ((best.len - 1) >> 1);
      return { k: k, at: at, reach: near(ends[1 - k], at) };
    });
    var prefer = horizontal ? 1 : 0;
    var pick = picks[prefer];
    if (picks[1 - prefer].reach && !pick.reach) pick = picks[1 - prefer];
    return {
      from: lo / across,
      to: (hi + 1) / across,
      at: (pick.at + 0.5) / lines,
      labelTo: pick.k === 1,
      far: pick.reach ? null : (picks[1 - pick.k].at + 0.5) / lines
    };
  }

  // Lays a view's lines and letters on its picture, and the reach
  // from a line end off the drawing to its extreme point; they stay hidden
  // until the picture has been read.
  function placeMarks(name) {
    var view = state.planViews && state.planViews[name];
    var drawing = state.planFrame && state.planFrame.views[name];
    if (!view || !drawing) return;
    var picture = view.marks.length && view.img.getAttribute("src") ? readPlanPicture(view.img) : null;
    drawing.measures.forEach(function (measure, i) {
      var mark = view.marks[i];
      var reach = view.reaches[i];
      var found = picture && measureMark(picture, measure.horizontal);
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
    centrePlanGroup(name);
  }

  // Centres a view's picture and labels together across its tile (upright,
  // the picture stays level with the model): the picture, and all drawn on
  // it, moves (translate) by half what its labels and lengths reach past it
  // on one side more than the other. Re-run whenever they change size: the
  // marks, the lengths, the size, the screen, the font.
  function centrePlanGroup(name) {
    var view = state.planViews && state.planViews[name];
    if (!view) return;
    var box = view.pic.getBoundingClientRect();
    if (!box.width) return;
    var l = 0, r = box.width;
    view.marks.forEach(function (mark) {
      if (!mark.classList.contains("is-cut")) return;
      var label = mark.firstChild;
      [label, label.lastChild].forEach(function (part) {
        var p = part.getBoundingClientRect();
        if (!p.width) return;
        l = Math.min(l, p.left - box.left);
        r = Math.max(r, p.right - box.left);
      });
    });
    view.pic.style.translate = ((box.width - l - r) / 2).toFixed(1) + "px 0px";
  }
  function centrePlanGroups() {
    if (state.planViews) Object.keys(state.planViews).forEach(centrePlanGroup);
  }

  function buildPlanViews(host) {
    var views = {};
    Object.keys(H.PLAN_VIEWS).forEach(function (name) {
      var button = el("button", "product-plan");
      button.type = "button";
      button.setAttribute("data-view", name);
      button.setAttribute("aria-pressed", "false");
      var pic = el("span", "product-plan__pic");
      var img = document.createElement("img");
      img.className = "product-plan__img";
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      img.addEventListener("load", function () { placeMarks(name); });
      pic.appendChild(img);
      var reaches = [];
      var values = [];
      var marks = H.PLAN_VIEWS[name].measures.map(function () {
        var reach = el("span", "product-plan__reach");
        reach.setAttribute("aria-hidden", "true");
        pic.appendChild(reach);
        reaches.push(reach);
        var mark = el("span", "product-plan__mark");
        mark.setAttribute("aria-hidden", "true");
        var label = el("span", "product-plan__label");
        label.appendChild(el("span", "product-plan__axis"));
        var value = el("span", "product-plan__value");
        label.appendChild(value);
        values.push(value);
        mark.appendChild(label);
        pic.appendChild(mark);
        return mark;
      });
      button.appendChild(pic);
      button.addEventListener("click", function () {
        if (!state.modelHandle || !state.modelHandle.showView) return;
        state.modelHandle.showView(name, PLAN_HOLD_MS);
        markPlanView(name);
      });
      host.appendChild(button);
      views[name] = { button: button, pic: pic, img: img, marks: marks, reaches: reaches, values: values };
    });
    return views;
  }

  function renderPlanViews() {
    var host = document.getElementById("productPlans");
    if (!host || !state.view) return;
    var paths = (state.view.assets && state.view.assets["plan-views"]) || {};
    var frame = H.planFrame(state.view);
    var names = Object.keys(H.PLAN_VIEWS);
    state.planFrame = frame && names.every(function (name) { return paths[name]; }) ? frame : null;
    host.hidden = !state.planFrame;
    if (!state.planFrame) return;
    host.style.setProperty("--plan-cw", (frame.crop.w / frame.tile).toFixed(4));
    host.style.setProperty("--plan-ratio", (frame.crop.w / frame.crop.h).toFixed(4));
    if (!state.planViews) state.planViews = buildPlanViews(host);
    names.forEach(function (name) {
      var view = state.planViews[name];
      frame.views[name].measures.forEach(function (measure, i) {
        view.marks[i].firstChild.firstChild.textContent = PLAN_AXES[measure.axis];
      });
      if (!state.planImagesOn) return;
      // A picture already in (a design change that kept it) fires no load.
      if (view.img.getAttribute("src") !== paths[name]) view.img.src = paths[name];
      else placeMarks(name);
    });
    syncPlanSizes();
  }

  // The pictures at the chosen size (--plan-f), and each measure at it: its
  // axis of the model's box in cm, beside its letter and in the view's label.
  function syncPlanSizes() {
    var frame = state.planFrame;
    if (!frame || !state.planViews) return;
    var host = document.getElementById("productPlans");
    if (host) host.style.setProperty("--plan-f", state.sizeFactor.toFixed(4));
    Object.keys(H.PLAN_VIEWS).forEach(function (name) {
      var view = state.planViews[name];
      var said = frame.views[name].measures.map(function (measure, i) {
        var text = (frame.size[measure.axis] * state.sizeFactor / 10).toFixed(1) + " cm";
        if (view.values[i].textContent !== text) view.values[i].textContent = text;
        return PLAN_AXES[measure.axis] + " " + text;
      });
      view.button.setAttribute("aria-label", PLAN_NAMES[name] + " view" + (said.length ? ", " + said.join(", ") : ""));
    });
    centrePlanGroups();
  }

  // The view whose window is running ("" for none).
  function markPlanView(name) {
    if (!state.planViews) return;
    Object.keys(state.planViews).forEach(function (key) {
      state.planViews[key].button.setAttribute("aria-pressed", String(key === name));
    });
  }

  /* ---- the three stages ---- */

  // js/product-stages.js publishes the eased transitions and CSS fades in
  // phases (out, blank, in). This handles the rest: the feed's room and the model.
  // Inspiration -> design is a plain fade; the model holds still before it.
  // Design -> specs: an inversion band sweeps up the screen, and the model's
  // metal -> blueprint sweep is its passage across the model, from foot to
  // head. The first fade ends (--t0) as the band reaches the model, the second
  // starts (--t1) as it leaves, and the model's fit follows; all derived from
  // the model's screen position.
  function wireStages() {
    if (!stageEl) return;
    if (!window.EmjiveProductStages) return;
    stages = window.EmjiveProductStages.mount(stageEl, { onChange: onStageChange });
    // mount() published before this handle existed: fit the feed into the track now.
    fitFeed();
    stages.update();
    // Design: back to the pose.
    if (resetEl) {
      resetEl.addEventListener("click", function () {
        resetEl.blur();
        setModelAway(false);
        if (state.modelHandle) state.modelHandle.returnHome();
      });
    }
    var resizeQueued = false;
    window.addEventListener("resize", function () {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () {
        resizeQueued = false;
        fitSizeTape();
        centrePlanGroups();
        refreshStage();
      });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(centrePlanGroups);
  }

  function onStageChange(stage) {
    state.toDesign = stage.toDesign;
    state.toSpecs = stage.toSpecs;
    state.along = stage.along || 0;
    state.ramp = stage.ramp || 1;
    state.flow = stage.stage === "flow";
    refreshStage();
    // The cost chart builds once specs is fully in, and resets once left (all at once in flow).
    var costs = document.getElementById("productCosts");
    if (costs) {
      if ((stage.stage === "flow" || stage.toSpecs >= 0.999) && !costs.classList.contains("is-built")) {
        costs.classList.add("is-built");
        // After the cascade (ends by 1.65 s in CSS), figure changes move all bars at once.
        clearTimeout(state.settleTimer);
        state.settleTimer = setTimeout(function () { costs.classList.add("is-settled"); }, 1800);
      } else if (stage.stage !== "flow" && stage.toSpecs < 0.5 && costs.classList.contains("is-built")) {
        clearTimeout(state.settleTimer);
        costs.classList.remove("is-built", "is-settled");
      }
    }
    // The size field gets its starting value as design's controls start leaving.
    if ((stage.toSpecs > 0 || stage.leave > 0) && !state.sizeSeeded && state.seedSize) state.seedSize();
    // In design a released model stays put (the reset button returns it); in
    // specs and flow it eases home. Out of sight it pauses.
    var autoReturn = stage.stage !== "design";
    if (autoReturn !== state.autoReturn) {
      state.autoReturn = autoReturn;
      var handle = state.modelHandle;
      if (handle) {
        handle.setAutoReturn(autoReturn);
        if (autoReturn && (stage.stage === "specs" || stage.stage === "flow")) handle.returnHome();
      }
    }
    var out = !state.flow && stage.toDesign <= MODEL_FROM;
    if (out === state.designOut) return;
    state.designOut = out;
    if (state.modelHandle) state.modelHandle.setPaused(out);
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
      var showTop = show.getBoundingClientRect().top + browsePx();
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

  // The design stretch's browse distance (--room-1, found by fitDesignRoom), read off a probe.
  var designRoomProbe = null;
  function designRoomPx() {
    if (!designRoomProbe) designRoomProbe = lengthProbe(document.getElementById("productStage"), "width:0;height:var(--room-1)");
    return designRoomProbe.offsetHeight;
  }

  // Design's controls (the options, then the material cluster) can reach under
  // the bottom bars: the design stretch scrolls the show up until the last
  // clears them by DESIGN_CLEAR_REM (--design-room). Measured unshifted (browse
  // and lift removed) so it holds still; frozen once the controls are gone
  // (.is-specs-layout).
  var DESIGN_CLEAR_REM = 0;
  var designRoom = 0;
  function fitDesignRoom() {
    if (!stageEl) return;
    var room = designRoom;
    if (state.flow) {
      room = 0;
    } else if (!stageEl.classList.contains("is-specs-layout")) {
      var last = document.querySelector(".product-design-panel");
      room = 0;
      if (last) {
        var rem = remPx();
        var bottom = last.getBoundingClientRect().bottom + browsePx() + state.lift;
        room = Math.max(0, bottom - (barsTopPx() - DESIGN_CLEAR_REM * rem));
      }
    }
    if (Math.abs(room - designRoom) < 0.5) return;
    designRoom = room;
    stageEl.style.setProperty("--design-room", room.toFixed(1) + "px");
    // The stretch is as long as covering the room takes.
    if (stages) stages.update();
  }

  // The model's sweep span on screen (top, bottom): the viewer's own figures,
  // else the model box's (close enough to time the fades).
  function modelSpan() {
    var handle = state.modelHandle;
    var own = handle && handle.scanSpan();
    if (own) {
      var top = handle.el.getBoundingClientRect().top;
      return { top: top + own.top, bottom: top + own.bottom };
    }
    if (!modelBoxEl || !modelBoxEl.classList.contains("is-model")) return null;
    var r = modelBoxEl.getBoundingClientRect();
    var mid = r.top + r.height / 2;
    return { top: mid - r.height * 0.44, bottom: mid + r.height * 0.44 };
  }

  // The model's lift (px above rest) at progress w through the design stretch
  // and transition, with its specs place `place` up. It rises with the show's
  // browsing (`room` by the stretch's end, easing in like the show over `ramp`),
  // then carries on at the same pace and slows to a stop at its place, so the
  // show settling as specs arrives never drags it. Everything is offset by
  // `base`, where design holds the model.
  function modelRise(w, place, room, ratio, ramp, base) {
    var wh = ratio / (ratio + 1);
    var x = clamp(w, 0, 1);
    var a = ramp > 0 ? Math.min(1, ramp) : 1;
    if (x <= wh) return base + (wh > 0 ? room * browseEntry(x / wh, a) : 0);
    var u = (x - wh) / (1 - wh);
    var dist = place - room - base;
    // The browse's final pace relative to a straight line.
    var pace = 1 / (1 - a / 2);
    if (dist > 1) return base + room + dist * (1 - Math.pow(1 - u, clamp(room * pace / (ratio * dist), 1.5, 6)));
    return base + room + dist * H.smoothstep(0, 1, u);
  }

  // The browse progress at u through a stretch (js/product-stages.js entry()).
  function browseEntry(u, a) {
    var stages = window.EmjiveProductStages;
    if (stages && stages.entry) return stages.entry(u, a);
    return clamp(u, 0, 1);
  }

  // Monotone cubic interpolation (Fritsch-Carlson) through (xs, ys) at x, so
  // the band never turns back. Linear if the points aren't strictly falling.
  function bandAt(xs, ys, x) {
    var n = xs.length;
    var d = [];
    var m = [];
    var i;
    for (i = 0; i < n - 1; i++) {
      if (!(xs[i + 1] > xs[i]) || !(ys[i + 1] < ys[i] - 1)) {
        var f = clamp(x, 0, 1);
        return ys[0] + (ys[n - 1] - ys[0]) * f;
      }
      d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    }
    m.push(d[0]);
    for (i = 1; i < n - 1; i++) m.push((d[i - 1] + d[i]) / 2);
    m.push(d[n - 2]);
    for (i = 0; i < n - 1; i++) {
      var a = m[i] / d[i];
      var b = m[i + 1] / d[i];
      var r = a * a + b * b;
      if (r > 9) {
        var tau = 3 / Math.sqrt(r);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }
    var seg = 0;
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    var w = xs[seg + 1] - xs[seg];
    var u = clamp((x - xs[seg]) / w, 0, 1);
    var u2 = u * u;
    var u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * ys[seg] + (u3 - 2 * u2 + u) * w * m[seg] +
      (-2 * u3 + 3 * u2) * ys[seg + 1] + (u3 - u2) * w * m[seg + 1];
  }

  // The stable small-viewport height (js/product-stages.js screenPx):
  // innerHeight changes mid-scroll on iOS and would shift the fades and the model.
  function screenHeight() {
    return window.EmjiveProductStages && window.EmjiveProductStages.screenPx ? window.EmjiveProductStages.screenPx() : window.innerHeight;
  }

  // Derives the show from state.toSpecs and the model's position: phase timing,
  // the band, the model's sweep and lift. Runs on every scroll and resize
  // change and when a viewer arrives.
  function refreshStage() {
    var band = document.getElementById("productScan");
    if (!stageEl) return;
    var t = state.toSpecs;
    var t0 = 0.3;
    var t1 = 0.6;
    var sweep = 0;
    var barOn = false;
    var browsed = browsePx();
    var ratio = parseFloat(getComputedStyle(stageEl).getPropertyValue("--hold-ratio"));
    if (!(ratio >= 0)) ratio = 0.5;
    fitDesignRoom();
    var room = designRoomPx();
    // The model's specs place: the tile row's middle (specsRowMiddle); `place` is how far up its middle is from rest
    // (tile middle less the current browse; negative when it sits lower than rest).
    var place = 0;
    // Design's hold (`hold`, from rest): the model's middle at DESIGN_ANCHOR of
    // the screen (or under the title bar), then DESIGN_GAP_REM lower. Everything
    // placed against the model but the x-ray goes with it.
    var hold = 0;
    if (designFrameEl && !state.flow) {
      var box = designFrameEl.getBoundingClientRect();
      var titleBar = document.querySelector(".product-detail__label-bar");
      // The model's approximate half-height at its fitted size.
      var half = SPECS_HALF_HEIGHT * box.height;
      var rem = remPx();
      var middle = specsRowMiddle(titleBar ? titleBar.getBoundingClientRect().bottom : 0);
      place = box.top + box.height / 2 + browsed - middle;
      hold = Math.max(0, box.top + box.height / 2 + browsed - (Math.max(DESIGN_ANCHOR * screenHeight(), titleBar ? titleBar.getBoundingClientRect().bottom + half + 8 : 0) + DESIGN_GAP_REM * rem));
    }
    var path = modelRise(state.along, place, room, ratio, state.ramp, hold);
    var span = state.flow ? null : modelSpan();
    if (span && span.bottom > span.top) {
      // The model's foot and head at rest. Fades are timed from where they stand
      // after the design stretch's browse; the band passes monotonically through
      // four points: below the screen at 0, the foot at t0, the head at t1 (as the
      // risen model has them), above the screen at 1. The sweep is the band's
      // passage across the model as it stands now.
      var restBottom = span.bottom + state.lift + browsed;
      var restTop = span.top + state.lift + browsed;
      var viewport = screenHeight();
      var h = band ? band.offsetHeight : 0;
      t0 = clamp(1 - (restBottom - room + h / 2) / (viewport + h), 0.08, 0.7);
      t1 = clamp(1 - (restTop - room + h / 2) / (viewport + h), t0 + 0.1, 0.92);
      var along = function (x) {
        return modelRise((ratio + invEase(x)) / (ratio + 1), place, room, ratio, state.ramp, hold);
      };
      var knots = [0, t0, t1, 1];
      var places = [viewport + h / 2, restBottom - along(t0), restTop - along(t1), -h / 2];
      var barY = bandAt(knots, places, t);
      var bottom = restBottom - path;
      var top = restTop - path;
      sweep = clamp((bottom - barY) / (bottom - top), 0, 1);
      barOn = t > 0 && t < 1;
      if (band && barOn) band.style.top = barY.toFixed(1) + "px";
    }
    // Inspiration -> design uses the same band, rising with the scroll; the model
    // shows behind it by cutting its box at the band's top edge (--model-cut), so
    // the poster and icon reveal like the live model. Design's controls come in
    // from when the band's top meets the title bar (--d-from).
    var labelBar = document.querySelector(".product-detail__label-bar");
    if (band && labelBar && !state.flow) {
      var fromH = screenHeight();
      var dFrom = (fromH - labelBar.getBoundingClientRect().bottom) / (fromH + band.offsetHeight);
      stageEl.style.setProperty("--d-from", clamp(dFrom, 0.3, 0.95).toFixed(4));
    }
    var cutting = band && !barOn && !state.flow && t === 0 && state.toDesign > 0 && state.toDesign < 1;
    if (cutting) {
      var bandH = band.offsetHeight;
      var viewportH = screenHeight();
      var cutY = viewportH + bandH / 2 - (viewportH + bandH) * state.toDesign;
      band.style.top = cutY.toFixed(1) + "px";
      barOn = true;
      if (modelBoxEl) modelBoxEl.style.setProperty("--model-cut", (cutY - bandH / 2 - modelBoxEl.getBoundingClientRect().top).toFixed(1) + "px");
    } else if (modelBoxEl) {
      modelBoxEl.style.removeProperty("--model-cut");
    }
    state.sweep = sweep;
    // Design's room is measured only until the blank is half through (fitDesignRoom).
    stageEl.classList.toggle("is-specs-layout", !state.flow && t > (t0 + t1) / 2);
    state.fit = clamp((t - t1) / (1 - t1), 0, 1);
    // The model's own lift: the path less what the show's browse already does
    // (it rises for the design stretch and settles as specs arrives, --browse-px).
    var wh = ratio / (ratio + 1);
    var browsing = room * (wh > 0 ? browseEntry(clamp(state.along / wh, 0, 1), state.ramp > 0 ? Math.min(1, state.ramp) : 1) : 1) * (1 - state.fit);
    state.lift = path - browsing;
    stageEl.style.setProperty("--lift", state.lift.toFixed(1) + "px");
    stageEl.style.setProperty("--t0", t0.toFixed(4));
    stageEl.style.setProperty("--t1", t1.toFixed(4));
    if (band) band.classList.toggle("is-on", barOn);
    fitBrowse(stageEl);
    fitFeed();
    applyStageToViewer();
  }

  // The specs column can end under the bottom bars, out of reach: its stretch
  // scrolls the show up until the last block clears the bars by
  // BROWSE_CLEAR_REM (--browse-room, at least the bars' height in CSS).
  // Measured unshifted so it holds still.
  var BROWSE_CLEAR_REM = 8;
  var browseRoom = 0;
  function fitBrowse(stageEl) {
    var room = 0;
    var blocks = stageEl.querySelectorAll(".product-logistics__block");
    var bar = document.getElementById("productSelectBar");
    if (!state.flow && blocks.length && bar) {
      var clear = BROWSE_CLEAR_REM * remPx();
      var bottom = blocks[blocks.length - 1].getBoundingClientRect().bottom + browsePx();
      room = Math.max(0, bottom - (bar.getBoundingClientRect().top - clear));
    }
    if (Math.abs(room - browseRoom) < 0.5) return;
    browseRoom = room;
    stageEl.style.setProperty("--browse-room", room.toFixed(1) + "px");
  }

  function applyStageToViewer() {
    syncPosters();
    if (!state.modelHandle) return;
    state.modelHandle.setFitZoom(specsZoom());
    state.modelHandle.setBlueprint(state.sweep, state.fit);
    state.modelHandle.setSize(state.sizeFactor);
  }

  // Before the viewer: fallback-img hands over to the specs-poster (drawn
  // fitted, at the base size) with the fit, which scales with the size as the
  // model does.
  function syncPosters() {
    var specs = state.specsPosterImg;
    if (!specs || !state.posterImg) return;
    var src = (state.view && state.view.assets && state.view.assets["specs-poster"]) || "";
    if (!src) {
      specs.removeAttribute("src");
      specs.hidden = true;
      state.posterImg.style.opacity = "";
      return;
    }
    if (specs.getAttribute("src") !== src) specs.src = src;
    specs.hidden = false;
    state.posterImg.style.opacity = (1 - state.fit).toFixed(3);
    specs.style.opacity = state.fit.toFixed(3);
    var zoom = specsZoom();
    specs.style.transform = "scale(" + (1 + (state.sizeFactor * zoom - 1) * state.fit).toFixed(4) + ")";
  }

  // Specs' tile row (css/style.css, the design frame): the picture square
  // (the probe's width) and the tile's height (its height); the blank it keeps
  // at least under the title bar (--specs-top, the other probe).
  var specsRowProbe = null;
  var specsTopProbe = null;
  function specsProbe() {
    if (!specsRowProbe) specsRowProbe = lengthProbe(designFrameEl, "width:var(--plan-tile);height:var(--plan-cell-h)");
    return specsRowProbe;
  }
  // The tile row's top on arrival: SPECS_ROW_TOP of the screen down, raised
  // by SPECS_ROW_RAISE_REM, and at least --specs-top under the title bar.
  var SPECS_ROW_TOP = 0.36;
  var SPECS_ROW_RAISE_REM = 9;
  function specsRowMiddle(titleBottom) {
    if (!specsTopProbe) specsTopProbe = lengthProbe(designFrameEl, "width:0;height:var(--specs-top)");
    var top = Math.max(SPECS_ROW_TOP * screenHeight() - SPECS_ROW_RAISE_REM * remPx(), titleBottom + specsTopProbe.offsetHeight);
    return top + specsProbe().offsetHeight / 2;
  }

  // The fitted model's zoom in specs: its box's canvas brought down so the
  // drawing, SPECS_MODEL_SHARE of the box at the largest size, fills the
  // picture square; smaller sizes shrink it as they shrink the outlines.
  function specsZoom() {
    var box = modelBoxEl ? modelBoxEl.offsetWidth : 0;
    var square = designFrameEl ? specsProbe().offsetWidth : 0;
    return box > 0 && square > 0 ? square / (box * SPECS_MODEL_SHARE) : 1;
  }
  var SPECS_MODEL_SHARE = 0.66;
  // Where design holds it: a third down, then DESIGN_GAP_REM lower. The model's
  // half-height as a share of its tile.
  var DESIGN_ANCHOR = 1 / 3;
  var DESIGN_GAP_REM = 4.5;
  var SPECS_HALF_HEIGHT = 0.13;
  // The model is drawn and priced at SIZE_BASE_MM (EmjiveSelection.priceAt);
  // the bounds are the product's size-range, set on render. setModelSize scales
  // the model, specs and tape to a typed size (none: the base), clamped to
  // the range; only a size within it goes on the label and prices it.
  var SIZE_BASE_MM = H.REFERENCE_SIZE_MM;
  var SIZE_MIN_MM = 40;
  var SIZE_MAX_MM = 80;
  function setModelSize(raw) {
    var sel = window.EmjiveSelection;
    var mm = parseFloat(raw);
    var given = sel.isValidSize(raw) && isFinite(mm);
    state.sizeFactor = given ? clamp(mm, SIZE_MIN_MM, SIZE_MAX_MM) / SIZE_BASE_MM : 1;
    state.sizeText = state.product && sel.isOrderableSize(state.product, raw) ? String(+mm.toFixed(2)) : "";
    applyStageToViewer();
    if (state.product) {
      renderSpecs();
      renderLabelType(state.product);
      renderLabelPrice(state.product);
      var field = document.getElementById("productSizeInput");
      if (field) sel.syncSizeField(field, state.product);
    }
    syncPlanSizes();
    syncSizeTape();
  }

  /* ---- the size tape ---- */

  // A slider drawn as a tape measure: a mark every mm from SIZE_MIN_MM (left
  // end) to SIZE_MAX_MM (right end) across its width, a long one every
  // TAPE_MAJOR_MM, and the needle travelling along them to the size.
  var TAPE_MAJOR_MM = 5;
  // Key steps in mm: arrows, Shift+arrows, PageUp/PageDown.
  var TAPE_KEY_STEP = 0.5;
  var TAPE_KEY_FINE = 0.1;
  var TAPE_KEY_PAGE = 5;
  var TAPE_TOUCH_SLOP_PX = 6;
  // A drag moves the size by the finger's travel times a gain that falls
  // with its speed (smoothed over TAPE_SPEED_MS): 1 at TAPE_FAST_PX_MS and
  // over, TAPE_FINE_GAIN at TAPE_SLOW_PX_MS and under, for fine settings.
  var TAPE_FAST_PX_MS = 0.2;
  var TAPE_SLOW_PX_MS = 0.03;
  var TAPE_FINE_GAIN = 0.2;
  var TAPE_SPEED_MS = 60;

  // Moves the needle to the size (--tape-at, its share of the way). Runs on any size change.
  function syncSizeTape() {
    var tape = state.sizeTape;
    if (!tape) return;
    var mm = clamp(state.sizeFactor * SIZE_BASE_MM, SIZE_MIN_MM, SIZE_MAX_MM);
    tape.el.style.setProperty("--tape-at", ((mm - SIZE_MIN_MM) / (SIZE_MAX_MM - SIZE_MIN_MM)).toFixed(4));
    var given = state.sizeText !== "";
    var now = given ? state.sizeText : String(SIZE_BASE_MM);
    tape.el.classList.toggle("is-unset", !given);
    tape.el.setAttribute("aria-valuenow", now);
    tape.el.setAttribute("aria-valuetext", now + " mm");
  }

  // Lays the marks at the tape's pitch (its width over the range): their
  // spacing and where they fall. Runs whenever the tape's width changes.
  function fitSizeTape() {
    var tape = state.sizeTape;
    if (!tape) return;
    var pitch = tape.el.clientWidth / (SIZE_MAX_MM - SIZE_MIN_MM);
    if (!(pitch > 0)) return;
    var major = Math.ceil(SIZE_MIN_MM / TAPE_MAJOR_MM) * TAPE_MAJOR_MM;
    tape.pitch = pitch;
    tape.marks.style.setProperty("--tape-mm", pitch.toFixed(3) + "px");
    tape.marks.style.setProperty("--tape-major", (TAPE_MAJOR_MM * pitch).toFixed(3) + "px");
    tape.marks.style.setProperty("--tape-minor-x", ((Math.ceil(SIZE_MIN_MM) - SIZE_MIN_MM) * pitch).toFixed(2) + "px");
    tape.marks.style.setProperty("--tape-major-x", ((major - SIZE_MIN_MM) * pitch).toFixed(2) + "px");
  }

  // The tape as a slider: a mouse press puts the needle under the pointer; a
  // drag then moves it with the pointer, more finely as it slows (the gain);
  // a touch drags it sideways (vertical swipes stay the page's, touch-action,
  // and leave the size alone) or, as a tap, puts it there. The field and the
  // model follow.
  function wireSizeTape(field) {
    var el = document.getElementById("productSizeTape");
    if (!el) return;
    var marks = el.querySelector(".product-size-tape__window");
    el.setAttribute("aria-valuemin", String(SIZE_MIN_MM));
    el.setAttribute("aria-valuemax", String(SIZE_MAX_MM));

    state.sizeTape = { el: el, marks: marks, pitch: 0 };
    if (window.ResizeObserver) new ResizeObserver(fitSizeTape).observe(el);
    fitSizeTape();

    function setSize(mm) {
      mm = clamp(Math.round(mm * 10) / 10, SIZE_MIN_MM, SIZE_MAX_MM);
      field.value = mm.toFixed(1);
      setModelSize(field.value);
    }

    function currentSize() {
      var mm = parseFloat(field.value);
      return window.EmjiveSelection.isValidSize(field.value) && isFinite(mm) ? mm : SIZE_BASE_MM;
    }

    // The size under a pointer at x, the ends holding past the tape.
    function sizeAt(x) {
      var r = el.getBoundingClientRect();
      return SIZE_MIN_MM + clamp((x - r.left) / r.width, 0, 1) * (SIZE_MAX_MM - SIZE_MIN_MM);
    }

    // Registered before dragPointer's, so a touch the page took for a scroll
    // (pointercancel) is marked before its end runs.
    var held = null;
    el.addEventListener("pointercancel", function () {
      if (held) held.cancelled = true;
    });
    H.dragPointer(el, function (e) {
      el.classList.add("is-held");
      held = { touch: e.pointerType !== "mouse", x: e.clientX, y: e.clientY, moved: false, scroll: false, cancelled: false, mm: currentSize(), lastX: e.clientX, lastT: e.timeStamp, speed: TAPE_FAST_PX_MS };
      if (!held.touch) {
        held.mm = sizeAt(e.clientX);
        setSize(held.mm);
      }
      return held;
    }, function (e, drag) {
      if (drag.scroll) return;
      // A touch is a drag once it has gone TAPE_TOUCH_SLOP_PX mostly sideways,
      // else a scroll the page is taking: the drift on its way leaves the size alone.
      if (drag.touch && !drag.moved) {
        var ax = Math.abs(e.clientX - drag.x);
        var ay = Math.abs(e.clientY - drag.y);
        if (Math.max(ax, ay) < TAPE_TOUCH_SLOP_PX) return;
        if (ay >= ax) {
          drag.scroll = true;
          return;
        }
      }
      drag.moved = true;
      // The events' own times: a busy frame that delays handling doesn't read as a slow finger.
      var dt = Math.max(1, e.timeStamp - drag.lastT);
      var dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      drag.lastT = e.timeStamp;
      if (dx === 0 || !state.sizeTape.pitch) return;
      drag.speed += (Math.abs(dx) / dt - drag.speed) * (1 - Math.exp(-dt / TAPE_SPEED_MS));
      var gain = TAPE_FINE_GAIN + (1 - TAPE_FINE_GAIN) * H.smoothstep(TAPE_SLOW_PX_MS, TAPE_FAST_PX_MS, drag.speed);
      drag.mm = clamp(drag.mm + dx / state.sizeTape.pitch * gain, SIZE_MIN_MM, SIZE_MAX_MM);
      setSize(drag.mm);
    }, function (drag) {
      el.classList.remove("is-held");
      if (drag.touch && !drag.moved && !drag.scroll && !drag.cancelled) setSize(sizeAt(drag.x));
      held = null;
    });

    // A sideways trackpad swipe moves the needle with the fingers (deltaX is
    // against them); vertical wheels are left to the page.
    el.addEventListener("wheel", function (e) {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || !state.sizeTape.pitch) return;
      e.preventDefault();
      var px = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      setSize(currentSize() - px / state.sizeTape.pitch);
    }, { passive: false });

    el.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? TAPE_KEY_FINE : TAPE_KEY_STEP;
      var next = H.sliderKey(e, currentSize(), step, TAPE_KEY_PAGE, SIZE_MIN_MM, SIZE_MAX_MM);
      if (next === null) return;
      e.preventDefault();
      setSize(next);
    });
  }

  function pageColor(token, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
  }

  function hideScanBand() {
    var band = document.getElementById("productScan");
    if (band) band.classList.remove("is-on");
  }

  /* ---- 4. size sheet and selection ---- */

  function wireSelectButton(product) {
    var selectBtn = document.getElementById("selectButton");
    // The unit belongs to the category, in the global vocabulary.
    var info = window.EmjiveSeries.categoryInfo(product.category);
    var unit = info.unit || "";

    var customInput = document.getElementById("sizeModalCustomInput");
    var customUnit = document.getElementById("sizeModalCustomUnit");
    var finderToggle = document.getElementById("sizeModalFinderToggle");
    // The size finder, from the sheet and the specs stage, using the category's
    // size guide; no button without one.
    var guide = info["size-guide"];
    var hasFinder = !!(window.EmjiveSizeFinder && guide && guide.rows && guide.rows.length);
    finderToggle.hidden = !hasFinder;
    // The finder's result goes in as if typed: the sheet's way, or `format`'s.
    function openFinder(toggle, input, format) {
      window.EmjiveSizeFinder.open({
        guide: guide,
        returnFocus: toggle,
        onFill: function (size) {
          input.value = format ? format(size) : window.EmjiveSelection.normalizeSize(size);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }
    finderToggle.addEventListener("click", function () { openFinder(finderToggle, customInput); });

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

    // A unitless category has nothing to measure: Select stays disabled.
    if (!unit) {
      selectBtn.setAttribute("aria-disabled", "true");
      selectLabel.textContent = "No sizes available";
      return;
    }

    customUnit.textContent = unit;

    var modal = document.getElementById("sizeModal");

    // The specs size: a field and the size tape, kept in step
    // (setModelSize). The sheet opens with the field's value but never writes
    // back. Enter opens the sheet.
    var specsSize = document.getElementById("productSizeInput");
    document.getElementById("productSizeUnit").textContent = unit;
    document.getElementById("productSize").hidden = false;
    // The specs stage's "Find my size".
    var specsFinderToggle = document.getElementById("productSizeFinderToggle");
    specsFinderToggle.hidden = !hasFinder;
    // The specs field shows one decimal, as the tape writes it ("62.0").
    function oneDecimal(size) {
      var mm = parseFloat(window.EmjiveSelection.normalizeSize(size));
      return isFinite(mm) ? mm.toFixed(1) : "";
    }
    specsFinderToggle.addEventListener("click", function () { openFinder(specsFinderToggle, specsSize, oneDecimal); });
    // The first time specs comes in, the field starts at the model's size, within the range.
    state.seedSize = function () {
      state.sizeSeeded = true;
      state.seedSize = null;
      if (specsSize.value !== "") return;
      specsSize.value = clamp(SIZE_BASE_MM, SIZE_MIN_MM, SIZE_MAX_MM).toFixed(1);
      setModelSize(specsSize.value);
    };
    window.EmjiveSelection.syncSizeField(specsSize, product);
    wireSizeTape(specsSize);
    specsSize.addEventListener("input", function () {
      var cleaned = window.EmjiveSelection.sanitizeSizeInput(specsSize.value);
      if (cleaned !== specsSize.value) specsSize.value = cleaned;
      setModelSize(specsSize.value);
    });
    specsSize.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!modal.classList.contains("is-open")) openModal();
    });

    // The Select bar's button: "Select" opens the sheet, "Add" confirms while it
    // is open (aria-disabled until the size is orderable). The label fades through its change.
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

    // A size within the product's range: what Add needs.
    function orderable(input) {
      return window.EmjiveSelection.isOrderableSize(product, input.value);
    }

    function syncBar() {
      var isOpen = modal.classList.contains("is-open");
      setBarLabel(isOpen ? "Add" : "Select");
      // Add mode gives the bar its own ground (.product-select-bar.is-add).
      selectBar.classList.toggle("is-add", isOpen);
      var canAct = !isOpen || orderable(customInput);
      selectBtn.setAttribute("aria-disabled", String(!canAct));
      window.EmjiveSelection.syncSizeField(customInput, product);
    }

    // Written back only when changed, so the caret doesn't jump.
    customInput.addEventListener("input", function () {
      var cleaned = window.EmjiveSelection.sanitizeSizeInput(customInput.value);
      if (cleaned !== customInput.value) customInput.value = cleaned;
      syncBar();
    });

    // Enter confirms: Add sits outside the focus trap, so the keyboard needs this.
    customInput.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (orderable(customInput)) confirmAdd(true);
    });

    function openModal() {
      // Pre-filled from the specs field when it holds an orderable size.
      customInput.value = orderable(specsSize) ? specsSize.value : "";
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      syncBar();
      // After .is-open (focus() is a no-op while hidden). The trap also locks the page.
      window.EmjiveFocusTrap.activate(modal, {
        returnFocus: selectBtn,
        onEscape: closeModal
      });
    }

    // quiet: an Enter add returns focus to Select without a ring (js/focus-trap.js).
    function closeModal(quiet) {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      // Before the trap releases, so focus lands on a live button.
      syncBar();
      window.EmjiveFocusTrap.release(undefined, quiet === true);
    }

    // Reached via Add or Enter, both for an orderable size; the guard covers stale callbacks.
    function confirmAdd(quiet) {
      if (!orderable(customInput)) return;
      var view = state.view;
      var size = window.EmjiveSelection.normalizeSize(customInput.value);
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
        price: window.EmjiveSelection.priceAt(product, state.selectedMetal, size),
        image: H.assetFor(view, "icons", state.selectedMetal)
      };
      if (product.designs) item.design = state.designKey;
      window.EmjiveSelection.addItem(item);
      closeModal(quiet);
    }

    selectBtn.addEventListener("click", function () {
      if (!modal.classList.contains("is-open")) openModal();
      else if (orderable(customInput)) confirmAdd();
    });
    document.getElementById("sizeModalBackdrop").addEventListener("click", closeModal);
    // Escape is the focus trap's onEscape.

    // A Modify sheet opening (from the bar's drawer): this sheet steps aside.
    window.addEventListener("emjive:modify-open", function () {
      if (modal.classList.contains("is-open")) closeModal();
    });
  }

  init();
})();
