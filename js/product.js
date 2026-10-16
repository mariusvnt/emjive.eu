/* ==========================================================================
   J&MV — product detail page
   Resolves the item from the address against the active series'
   products.json and renders the label, the feed of photos, the model, the
   metal picker and the design options, the characteristics and the
   size/selection flow — the three stages of product.html's show
   (inspiration, design, specs), whose scrolling js/product-stages.js drives;
   this file reacts to it for the parts CSS can't do (the model's grey sweep,
   its rise to its place in specs, the feed's room to scroll).
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("productDetail");
  if (!root) return;

  var loadingEl = document.getElementById("productDetailLoading");
  var contentEl = document.getElementById("productDetailContent");
  var stageEl = document.getElementById("productStage");
  // The design stage's frame (a --tile tall band across the screen, the
  // model in its middle) and the model's own box in it.
  var designFrameEl = document.getElementById("productDesignFrame");
  var modelBoxEl = document.getElementById("productModel");
  // js/product-stages.js's handle, once mounted (wireStages).
  var stages = null;
  // Up to here of the way to design (--to-design), design's things haven't
  // started to come in: the model is out of sight and holds still. The same
  // number as DESIGN_FROM in js/product-stages.js and --d-in's in
  // css/style.css.
  var DESIGN_FROM = 0.55;
  var resetEl = document.getElementById("productModelReset");

  // The reset button fades in once the model has been turned off its pose and
  // out when it is back (or on its way, after a tap).
  function setModelAway(away) {
    state.modelAway = !!away;
    if (resetEl) resetEl.classList.toggle("is-away", state.modelAway);
  }

  var state = {
    product: null,
    // The product as its chosen design (EmjiveSeries.resolveDesign): what the
    // model, the label's thumbnail, the specs and the selection read. The
    // product itself for one with a single design.
    view: null,
    designKey: "",
    // The loader hold over the model while a design's model is on its way.
    swapHold: null,
    metals: [],
    // data/series.json's "metal-costs", keyed by metal (see computeCosts).
    metalCosts: {},
    // data/series.json's "metal-technology" (metal -> technology) and
    // "printing-technologies" (technology -> { name, description }).
    metalTechnology: {},
    technologies: {},
    // data/series.json's "metal-composition" (metal -> what it is made of).
    compositions: {},
    // Each photo's caption with the picture under it, for inkCaption.
    captions: [],
    selectedMetal: null,
    modelHandle: null,
    // The model box's poster <img> while the viewer isn't in yet.
    posterImg: null,
    // The x-ray backdrop's original file (the page shows a version of it
    // chosen for the viewport — see startXray) and whether the viewport
    // watcher is wired.
    xraySrc: "",
    xrayWatching: false,
    iconFallbackImg: null,
    // How far the show has gone (js/product-stages.js): inspiration ->
    // design and design -> specs, 0 to 1 each — and what that makes of the
    // model (refreshStage). Kept so a viewer built later (first mount, after
    // the Modify sheet, after Back) starts where the page is.
    toDesign: 0,
    toSpecs: 0,
    // Whether design's things are out of sight (the inspiration stage): the
    // viewer is paused then.
    designOut: true,
    // How far the page is through the design stretch and the transition to
    // specs, linear in the scroll from its first pixel: what the model's rise
    // runs on.
    along: 0,
    // The share of the design stretch its browsing eases in over
    // (js/product-stages.js).
    ramp: 1,
    // Whether a released model eases back to its pose on its own: not in the
    // design stage, where it stays and the reset button (productModelReset)
    // is the way back. Kept for a viewer built later, like the pause.
    autoReturn: true,
    // Whether the model stands turned off its pose (the viewer says so).
    modelAway: false,
    sweep: 0,
    fit: 0,
    // The chosen ring size over the model's base size (setModelSize), and
    // the size as it stands in the specs field when it is a valid one ("" if
    // none: the label bar then shows no size).
    sizeFactor: 1,
    sizeText: "",
    // Whether a metal has been picked on the page yet (the default one is not
    // a pick): the price reads from the lowest of all the metals until then.
    metalPicked: false,
    // The size circle's elements (wireSizeRing) and its sizes as last worked
    // out (syncSizeRing).
    sizeRing: null,
    ringGeo: null,
    // How far the model is lifted on the page, in pixels (refreshStage): on its
    // way to its place in specs, from the first pixel of scrolling.
    lift: 0,
    // Whether the specs size has been given its starting value (62).
    sizeSeeded: false,
    seedSize: null,
    // The timer that marks the cost chart as played out.
    settleTimer: 0
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The model's loader: on the design frame, crossing the screen at the
  // model's height (the model's box itself is smaller than its tile, and has
  // no visible edge), for the model's first load and for each design's model
  // after it. It only counts while the model is on screen (js/loader.js, "a
  // loader shared by several assets"), and CSS keeps it out of sight while
  // the design stage is (.is-design-out). null when there is no loader
  // (js/loader.js missing, reduced motion).
  function modelLoadHold() {
    if (!window.EmjiveLoader || !designFrameEl) return null;
    var hold = window.EmjiveLoader.mount(designFrameEl, { target: modelBoxEl });
    return hold && typeof hold.done === "function" ? hold : null;
  }

  // What the address asks for. The real form is /<name-as-a-slug> (the
  // server hands every such path this one page — public/.htaccess, and a
  // per-item copy of it for each product, see emitItemPages() in
  // vite.config.js); the older product.html?id=01[&series=x] still arrives
  // from old bookmarks and from selections saved before the move, and is
  // rewritten to the new address once the product is found (canonicalizeUrl).
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

  // The page's arrival loader (js/loader.js) covers the page until this is
  // called — on success once the product is built, on failure once the
  // not-found message is in place.
  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  function showNotFound() {
    loadingEl.hidden = false;
    // Back to whichever series was being browsed, not always the featured
    // one — mainHref() drops the ?series= for the featured slug anyway.
    var slug = state.seriesSlug || (window.EmjiveSeries && window.EmjiveSeries.slug);
    window.EmjiveMessage.show(loadingEl, "Item not found", {
      label: "Back to gallery",
      href: (slug ? window.EmjiveSeries.mainHref(slug) : "/gallery") + "#products"
    }, "status");
    pageReady();
  }

  // Something went wrong that is NOT "this id doesn't exist": a failed
  // request, a timeout, an exception while building the page. Saying
  // "Item not found" for those sends a visitor with a perfectly good link
  // away from a product that is really there. A reload is the retry.
  function showLoadError(err) {
    console.error("Could not load the product:", err);
    loadingEl.hidden = false;
    contentEl.hidden = true;
    window.EmjiveMessage.show(loadingEl,
      "This item couldn't be loaded. Check your connection and try again.",
      { label: "Reload" }, "alert");
    pageReady();
  }

  // An item's slug (its name, see EmjiveSeries.productSlug) is unique across
  // ALL series — validate-data enforces it — so the address alone identifies
  // the product and the series it lives in. A bare ?id= (an old bookmark)
  // can't: ids are only unique WITHIN a series. Resolution order either way:
  // the active series first — the featured one unless ?series= says otherwise
  // — then every other series in index order. The scan costs nothing in the
  // normal case, since step 1 hits, and it's bounded by the number of series.
  // For an id shared by two series with no ?series= in the URL, the active
  // one wins, which is the friendliest resolution available.
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

  // The page renders as soon as the product data is in — it does NOT wait for
  // the 3D viewer chunk (js/viewer-entry.js, ~165KB gzipped plus evaluation).
  // The first paint is the inspiration stage (the description and the feed's
  // first photo); the model's box starts as its poster image, out of sight
  // until the design stage, and the viewer takes it over once the chunk is in
  // (mountViewer below).
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

  // Old-style addresses (product.html?id=01, product.html?series=x&id=01)
  // become the item's own, /<slug>, without a reload or a history entry; a
  // hash survives. Only the shared template is rewritten: a path the server
  // really has (/furcula) keeps whatever the visitor typed.
  function canonicalizeUrl(product) {
    var here = window.location.pathname;
    if (here !== "/product.html" && here !== "/product") return;
    if (!window.history || typeof window.history.replaceState !== "function") return;
    var want = window.EmjiveSeries.productHref(product, state.seriesSlug);
    window.history.replaceState(window.history.state, "", want + window.location.hash);
  }

  // The per-item pages the build emits (emitItemPages() in vite.config.js)
  // already carry the product's canonical URL and description in the static
  // <head>; this is for the shared product.html (old links, the dev server),
  // whose head can't — it would collapse every product into one. Crawlers
  // that run the page's JS get the product's own address and summary, taken
  // from the data already on the page, never a stray #hash or ?id=.
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
    var sizes = window.EmjiveSelection.sizeRange(product);
    SIZE_MIN_MM = sizes.min;
    SIZE_MAX_MM = sizes.max;
    // The product opens on its default design.
    state.view = window.EmjiveSeries.resolveDesign(product).view;
    state.designKey = state.view.designKey;

    // First, ahead of everything else this function builds: the feed's first
    // photo is what the first paint is really waiting on, so its request
    // goes out before any other image's.
    var feed = renderFeed(product);

    renderLabel(product);
    var modelParts = renderModel(product);
    renderDesigns(product);
    renderMetalOptions(product);
    renderSpecs();
    renderPrinting();
    renderComposition();
    wireSelectButton(product);

    loadingEl.hidden = true;
    contentEl.hidden = false;

    // Once #productDetailContent is visible: the stages measure the track,
    // and the feed's room is measured off its laid-out height (while it's
    // [hidden], every element in it has a zero-size box).
    wireStages();

    // The arrival loader (js/loader.js) lifts once the picture the first
    // paint is made of is in, rather than on a blank page that fills in
    // underneath it; and everything that isn't needed for that paint waits
    // until then, so none of it competes with that picture for bandwidth.
    var firstPaintReady = Promise.race([
      feed.firstReady,
      new Promise(function (resolve) { setTimeout(resolve, FIRST_PAINT_WAIT_MS); })
    ]);
    firstPaintReady.then(pageReady);
    // ...and not before it has actually been painted: the image being
    // downloaded is not the same moment as it being on screen, and anything
    // started in between (the viewer, the environment map, the model) is
    // competing with a paint that has not happened yet.
    firstPaintReady
      .then(afterFirstPaint)
      .then(function () { loadRemainingAssets(product, feed, modelParts); });
  }

  // Resolves once the browser has painted the first stage's largest picture —
  // the feed's first photo, or the description where there is none, whichever
  // the browser reports as the largest paint inside the feed — or after a
  // short cap, or at the next two frames where the Largest Contentful Paint
  // API is missing.
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

  // A ceiling, not a target: an image that stalls must not hold the loader
  // cover (or the viewer, photos and other icons behind it) up indefinitely.
  var FIRST_PAINT_WAIT_MS = 6000;

  // The x-ray backdrop behind the model in the design stage: static,
  // independent of the metal and the design. No product.assets.xray means no
  // backdrop at all, rather than a broken image. Not part of the first paint
  // (the design stage is a scroll away): started after it, with the rest.
  function startXray(product) {
    var xray = document.getElementById("productDesignXray");
    var xraySrc = product.assets && product.assets.xray;
    if (!xraySrc) {
      xray.hidden = true;
      return;
    }
    // The low-res version for this viewport first (~25-50KB against ~320KB
    // for the original); loadRemainingAssets() swaps the high-res one in once
    // the model is on screen. A phone's versions are cropped to the middle of
    // the picture, which is why the phone rule for .product-design__xray in
    // css/style.css narrows the box to match. Without EmjiveLoader, the
    // original directly.
    var loader = window.EmjiveLoader;
    state.xraySrc = xraySrc;
    if (loader) {
      loader.setSrc(xray, loader.versions(xraySrc, true).first, xraySrc);
      // A phone turned (or a window resized) across the phone/desktop line:
      // the box changes shape with it, so the picture has to be the other
      // set's — its high-res one straight away, the low-res one has no job
      // left to do.
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

  // What the first paint did not need: the other metals' icons (so a pick
  // swaps the label thumbnail at once — the selected one's is already in),
  // the rest of the feed's photos, the 3D viewer and the x-ray behind it.
  function loadRemainingAssets(product, feed, modelParts) {
    preloadIcons(state.view);
    feed.loadRest();
    modelParts.mountViewer();
    startXray(product);
    // The sharp x-ray replaces the small one once the model is on screen
    // (or, at the latest, VIEWER_SETTLE_WAIT_MS after the first paint), so
    // its 320KB never competes with the viewer, the environment map and the
    // model for the link.
    if (state.xraySrc && window.EmjiveLoader) {
      Promise.race([
        modelParts.viewerSettled,
        new Promise(function (resolve) { setTimeout(resolve, VIEWER_SETTLE_WAIT_MS); })
      ]).then(function () {
        window.EmjiveLoader.upgradeImage(
          document.getElementById("productDesignXray"),
          window.EmjiveLoader.versions(state.xraySrc, true).hi
        );
      });
    }
  }

  // A design's icons for the metals not showing, fetched and decoded ahead of
  // a pick (js/order-rows.js preload), so the label's thumbnail swaps at once.
  function preloadIcons(view) {
    var icons = (view.assets && view.assets.icons) || {};
    window.EmjiveOrderRows.preload(Object.keys(icons)
      .filter(function (m) { return m !== state.selectedMetal; })
      .map(function (m) { return icons[m]; }));
  }

  var VIEWER_SETTLE_WAIT_MS = 20000;

  /* ---- 1. label ------------------------------------------------------- */

  function renderLabel(product) {
    document.getElementById("productLabelName").textContent = product.name || "";
    renderLabelDesign(product);
    renderLabelType(product);

    renderLabelThumb();
    renderLabelPrice(product);
  }

  // The chosen design, after the name, as its own name has it: the product's
  // name and what the design adds to it ("rib-cage" + "-1L2"; nothing for a
  // design named as the product is). A product with one design has none.
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
    window.EmjiveOrderRows.resampleBand(document.querySelector(".product-detail__label-bar"));
  }

  // ".category.metal", like the rows' label in the selection lists — and
  // ".size" once one is held in the specs field, written as the order rows
  // and the drawer write it: whole millimetres, a fraction (two digits) small
  // and with no point (EmjiveSelection.appendSize).
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
    // Text changing in place under the bar's invert band.
    window.EmjiveOrderRows.resampleBand(document.querySelector(".product-detail__label-bar"));
  }

  // Always the icon (not a photos[0] fallback) — this thumbnail sits right
  // next to the name at a fixed small size, so it needs the icon's
  // consistent transparent-background framing rather than a real photo's
  // arbitrary crop. No thumbnail at all if there's no icon for the
  // currently selected metal, rather than showing a broken or placeholder
  // image. Re-run from onMetalSelect and onDesignSelect too (not just the
  // initial render), so the thumbnail always matches whichever finish and
  // design are currently selected.
  function renderLabelThumb() {
    var thumb = document.getElementById("productLabelThumb");
    // A picture arriving under the label bar's invert band is a change in
    // place the band has to re-sample — see resampleBand() in
    // js/order-rows.js. Wired once.
    if (!thumb.dataset.resample) {
      thumb.dataset.resample = "1";
      thumb.addEventListener("load", function () {
        window.EmjiveOrderRows.resampleBand(document.querySelector(".product-detail__label-bar"));
      });
    }
    var view = state.view;
    var thumbSrc = (view.assets && view.assets.icons && view.assets.icons[state.selectedMetal]) || "";
    if (thumbSrc) {
      thumb.src = thumbSrc;
      thumb.hidden = false;
    } else {
      thumb.hidden = true;
    }
  }

  // "from" the lowest price over all the metals until one is picked, "from"
  // the picked metal's lowest until a size is given for the first time, then
  // the price at that size.
  function renderLabelPrice(product) {
    var sel = window.EmjiveSelection;
    document.getElementById("productLabelPrice").textContent = state.sizeText
      ? sel.formatPrice(sel.priceAt(product, state.selectedMetal, state.sizeText))
      : sel.formatPriceFrom(sel.priceFrom(product, state.metalPicked ? state.selectedMetal : ""));
  }

  /* ---- 2. the feed (inspiration) ------------------------------------------ */

  // The description (plain text under the title — no heading, nothing to
  // open; a product without one shows nothing there rather than a
  // placeholder), then the product's photos (product.assets.photos) one
  // under the other, with no gap between them, each with the name of what it
  // shows in its bottom right corner (its description, set like an item's name
  // — see captionFor; none, none). After the last, the trail: the last row of
  // its pixels carried on down, going to the page's colour (buildTrail). The
  // first photo is the first paint's picture and is requested at once; the
  // others only once that has been painted (loadRest, from
  // loadRemainingAssets). Each of those waits out a loader of its own
  // (js/loader.js cover()); the first is what the page's arrival loader waits
  // on, and shows as soon as that lifts. A photo's height is its own (square
  // until it has loaded), so the feed's room to scroll is measured again as
  // each one arrives (fitFeed).
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
        started = window.EmjiveLoader ? window.EmjiveLoader.imageReady(img) : Promise.resolve();
        if (window.EmjiveLoader && i > 0) window.EmjiveLoader.cover(frame, started);
        started.then(function () {
          // The caption's ink is set before it can show (.is-loaded).
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

  // A photo's caption: the name of the item on it, set as an item's name is
  // everywhere (the label bar's, the rows'): the name in the main face, then
  // ".category.metal.size" in the mono one, smaller, the size's fraction small
  // (EmjiveSelection.appendSize). Its colour is inkCaption's (css/style.css
  // .product-feed__caption).
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

  // The colour of a caption follows the corner it stands on: white over a dark
  // one, black over a light one. The part of the picture under the caption
  // (its box and INK_PAD_PX more all round, in the picture's own pixels) is
  // read back through a 16 by 8 canvas, which averages it, and the mean
  // luminance of those pixels (WCAG's relative luminance) is set against
  // INK_THRESHOLD: 0.179, where white and black are equally readable. Set as
  // data-ink (css/style.css .product-feed__caption); a picture the page can't
  // read back leaves the caption as it was, white inverted by blending.
  // Run when a photo arrives, and again whenever the screen's width changes
  // (the caption covers a different part of the picture).
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
      // A picture that won't be read back (a tainted canvas): as it was.
    }
  }

  // An sRGB channel (0-255) as light, 0 to 1.
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

  // The trail under the last photo: its last row of pixels, copied twice into
  // canvases one pixel tall that the CSS stretches over the trail's height
  // (css/style.css .product-feed__trail) — the stretched row is the same
  // colours as the photo's edge, so there is no seam — one in its own colours
  // and one that goes to grey, and a layer in the page's own background over
  // both. Each of those two takes more of the picture the further down it
  // goes, on a smooth curve, so that the row goes from the picture's colours
  // through grey to --bg exactly at the bottom, and a change to --bg is
  // followed with no script. A picture the page can't read back (a failed
  // load) leaves no trail. In the middle of the trail, a line saying where the
  // scrolling leads (TRAIL_HINT): there the trail is at least half the page's
  // colour, which black always reads on.
  var TRAIL_HINT = "scroll down to explore design options";
  function buildTrail(trail, img) {
    if (!trail || trail.firstChild || !img.naturalWidth) return;
    try {
      var width = Math.min(img.naturalWidth, 1600);
      var row = document.createElement("canvas");
      row.width = width;
      row.height = 1;
      row.getContext("2d").drawImage(img, 0, img.naturalHeight - 1, img.naturalWidth, 1, 0, 0, width, 1);
      var grey = document.createElement("canvas");
      grey.width = width;
      grey.height = 1;
      grey.getContext("2d").drawImage(row, 0, 0);
      grey.className = "product-feed__trail-grey";
      trail.appendChild(row);
      trail.appendChild(grey);
      trail.appendChild(el("p", "product-feed__trail-label", TRAIL_HINT));
      trail.classList.add("is-built");
    } catch (err) {
      trail.innerHTML = "";
    }
  }

  /* ---- 2b. the model (design, then specs) ---------------------------------- */

  // The model's box, in the middle of the design frame: its poster (the
  // viewer's own, fallback-img, so the swap moves nothing) until the 3D viewer
  // takes it over; a plain icon for a product without a model, or when the
  // viewer can't be had. The viewer is built for the design and the metal
  // chosen when it arrives (state.view, state.selectedMetal), and a design
  // picked later swaps its model in place (onDesignSelect).
  function renderModel(product) {
    var box = modelBoxEl;
    box.innerHTML = "";
    box.classList.remove("is-model");
    state.modelHandle = null;
    setModelAway(false);
    state.posterImg = null;
    state.iconFallbackImg = null;
    // Resolves when the 3D model is on screen — or will never be (no viewer,
    // failed, no model at all). What render() holds the sharp x-ray back for:
    // that swap is polish, and should not share the link with the model.
    var settleViewer;
    var viewerSettled = new Promise(function (resolve) { settleViewer = resolve; });
    var hasModel = !!(product.assets && product.assets.model);

    // window.EmjiveModelViewer is exposed by js/three-viewer.js — reused here
    // so the viewer construction/material logic lives in exactly one place.
    // It can return null if the browser couldn't grant a WebGL context (see
    // its own comment) — that takes the icon fallback. Reads state.view and
    // state.selectedMetal at call time, so a rebuild (after the Modify sheet,
    // after Back) picks up whatever is chosen now.
    function buildModelViewer() {
      // The viewer is a separate module: if it never arrived (its hashed file
      // gone after a deploy while this page's HTML was cached, a blocked
      // request) the box takes the icon fallback, exactly as it does for a
      // browser with no WebGL.
      if (typeof window.EmjiveModelViewer !== "function") return null;
      // The model's wait goes through the frame's loader (modelLoadHold):
      // handed to the viewer, which releases it when the model is on screen
      // or has failed or the viewer is disposed. If no viewer comes back the
      // hold is released here.
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
        // The frame's loader, held on the model while it loads (false: none,
        // e.g. reduced motion) — the viewer's box has no visible edge.
        loader: loadHold || false,
        // Only a circle of the viewer is the model's to drag: its radius
        // leaves a quarter of the viewer's width as a margin. A press outside
        // it scrolls the page.
        hitCircle: 0.25,
        // The model turned off its pose (or back on it): the reset button.
        onAway: setModelAway,
        // Fires for an initial load/HDRI failure OR — since three-viewer.js
        // also treats a WebGL context loss as a failure — for a model that
        // HAD already loaded and was on screen: iOS Safari can silently
        // reclaim a GPU context under memory pressure at any time, not just
        // during load.
        onError: replaceModelWithIcon,
        onReady: function () {
          settleViewer();
        },
        // The specs stage's metal -> grey sweep and wireframe (see
        // onStageChange). lineColor is the wireframe's colour.
        blueprint: { lineColor: pageColor("--category-col", "#727272") }
      });
    }

    // The box before the viewer is in: its poster image (the same one the
    // viewer shows over its own canvas until the model is drawn), sized
    // exactly like the viewer that replaces it, so the swap moves nothing —
    // the Modify sheet's stand-in for the same reason (js/modify-modal.js
    // posterBox(), .size-modal__model-poster in css/style.css).
    function showPoster() {
      box.innerHTML = "";
      state.posterImg = null;
      var src = posterSrcFor(state.view, state.selectedMetal);
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

    // Swaps the viewer in for the poster. Also what restoreModelViewer() calls
    // after a back/forward-cache restore. No WebGL context to be had (or the
    // viewer module never arrived) means the icon fallback, as always.
    function attachViewer() {
      if (state.modelHandle) return;
      // The box loses .is-model the moment replaceModelWithIcon takes it
      // over, which is exactly the case that must NOT be rebuilt — the
      // visitor is looking at the icon fallback, and a viewer appended
      // underneath it would be an invisible second context.
      if (!box.classList.contains("is-model")) return;
      var handle = buildModelViewer();
      if (!handle) {
        replaceModelWithIcon();
        return;
      }
      state.modelHandle = handle;
      state.posterImg = null;
      box.innerHTML = "";
      box.appendChild(handle.el);
      // Out of sight while the design stage is (the inspiration stage): no
      // drawing, no idle nudge.
      handle.setPaused(state.designOut);
      handle.setAutoReturn(state.autoReturn);
      // Wherever the show is now — a rebuild after the Modify sheet or Back
      // can land in specs.
      applyStageToViewer();
    }

    // Called by render() once the first paint is in. Asks for the viewer
    // chunk, then builds it when the browser is idle: creating a WebGL
    // context and compiling shaders is a long task that should not land on
    // top of the images and text arriving.
    function mountViewer() {
      if (!hasModel) {
        settleViewer();
        return;
      }
      if (!window.EmjiveLoadViewer) {
        replaceModelWithIcon();
        return;
      }
      // The chunk, the environment map and the model are independent
      // downloads; the viewer asks for the last two only once it has been
      // built, which is after the chunk. Hinting them now runs all three at
      // once instead of one after another (the viewer's own requests then
      // reuse these, being the same URL fetched the same way).
      hintFetch(window.EmjiveSeries.hdriPath(state.seriesSlug));
      hintFetch(state.view.assets.model);
      window.EmjiveLoadViewer().then(function () {
        whenIdle(attachViewer);
      }, replaceModelWithIcon);
    }

    // The permanent fallback, for a viewer that failed (a load or HDRI
    // failure, a lost context): the box shows the metal's icon instead, as a
    // product without a model does. state.iconFallbackImg is what
    // onMetalSelect and onDesignSelect re-point on a pick.
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
      var src = state.view.assets && state.view.assets.icons && state.view.assets.icons[state.selectedMetal];
      if (!src) return;
      var img = document.createElement("img");
      img.className = "product-model__icon";
      img.src = src;
      img.alt = product.name || "";
      img.draggable = false;
      box.appendChild(img);
      state.iconFallbackImg = img;
    }

    /* ---- releasing the viewer while the page is frozen --------------------
       Same reasoning as js/gallery-stack.js's pagehide, from the other end
       of the same navigation. Pressing Back doesn't end this page: it goes
       into the back/forward cache holding its WebGL context, its decoded
       model and its PMREM environment, while the gallery it returns to
       builds its own. Both pages' footprints counted against one page-wide
       iOS Safari budget is what tips it over.

       Deliberately NOT replaceModelWithIcon: that's the permanent fallback
       for a viewer that genuinely failed, and it rewrites the box so no
       rebuild is possible afterwards. This leaves the box alone, so coming
       back from the cache restores the real thing.
       --------------------------------------------------------------------- */
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

      // The Modify sheet (js/modify-modal.js, opened from a row of the
      // selection bar's drawer) builds a viewer of its own — a second WebGL
      // context, a second PMREM environment and a second decode — while this
      // page's viewer sits behind the sheet's backdrop, drawing nothing
      // anyone is looking at. The page's own model goes back to its poster
      // for as long as the sheet is up, and the real viewer is rebuilt once
      // the sheet's own has been freed ("emjive:modify-close" is dispatched
      // after that, see cleanup() there). Same swap as the back/forward-cache
      // path above.
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

  // What stands in for the model until its viewer is built: the viewer's own
  // poster (fallback-img, the model's default-orbit capture, so it lines up
  // with the live canvas's first frame), else the metal's icon.
  function posterSrcFor(view, metal) {
    var assets = view.assets || {};
    return (assets["fallback-img"] && assets["fallback-img"][metal]) ||
      (assets.icons && assets.icons[metal]) || "";
  }

  // <link rel="preload" as="fetch" crossorigin> is what a same-origin fetch()
  // (three's FileLoader) matches, so the viewer's own request joins this one
  // instead of downloading the file twice.
  function hintFetch(href) {
    if (!href) return;
    var link = document.createElement("link");
    link.rel = "preload";
    link.as = "fetch";
    link.crossOrigin = "anonymous";
    link.href = href;
    document.head.appendChild(link);
  }

  function whenIdle(fn) {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 0);
  }

  /* ---- 2c. the design options (design) ------------------------------------- */

  // A product with several designs (its "designs" in products.json: the
  // options and every design they lead to) gets one row per option under the
  // model: its label, then its choices, each a button with the site's dot
  // before the chosen one(s). A "multiple" option (the rib-cage's ribs) is a
  // set of toggles, the last one on not turned off; any other is one choice
  // of several. Every design is a combination of picks, so a pick lands on
  // the design that has them all — or, when no design has that combination
  // (a link between ribs that aren't side by side), on the one that keeps the
  // pick just made and as many of the others as it can (the first listed of
  // equals). A choice that would land somewhere other than its exact
  // combination is dimmed, still there to be tapped.
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

  // A design's picks for one option, as a list (one item for a plain option).
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

  // The picks a tap on `choice` would make, from the current design's: null
  // for turning off the last one on of a multiple option.
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
    // A choice of a plain option that no design has with the other picks as
    // they are (a link between ribs that aren't side by side) is out: a tap
    // does nothing.
    if (!option.multiple && !exactDesign(product, picks)) return;
    var design = landingDesign(product, option, picks);
    if (design) onDesignSelect(product, design.key);
  }

  // The choices' states, for the current design: pressed (its picks), dimmed
  // (not one of them, and no design has the combination a tap would make — a
  // chosen one is never dimmed, whatever turning it off would land on; a
  // toggle of a multiple option still goes to the nearest design, the choice
  // of a plain one is disabled as well), disabled (the last one on of a
  // multiple option; a dimmed choice of a plain one).
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

  // Another design: the label, the thumbnail, the specs (its geometry) and
  // the model follow it. The viewer swaps its model in place, the camera kept
  // (handle.setProduct), under the frame's loader until the new one is in; a
  // model not built yet is simply built as this design (state.view).
  function onDesignSelect(product, key) {
    if (key === state.designKey) return;
    state.designKey = key;
    state.view = window.EmjiveSeries.resolveDesign(product, key).view;
    syncDesignChoices(product);
    renderLabelDesign(product);
    renderLabelThumb();
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = (state.view.assets && state.view.assets.icons && state.view.assets.icons[state.selectedMetal]) || "";
    }
    if (state.posterImg) state.posterImg.src = posterSrcFor(state.view, state.selectedMetal);
    renderSpecs();
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

  /* ---- 3. metal selection ------------------------------------------------ */

  // The bars, their selected state and the change animation are
  // js/metal-picker.js; this just reacts to a pick. There are two pickers —
  // the page's own and the Select sheet's first row — each moving the other
  // along with it, so whichever is looked at shows the metal chosen.
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

  // Re-tints the existing model in place (no reload, no camera reset) — but
  // only once the text changes below have been painted: re-tinting means a
  // fresh material per mesh and a re-render, heavy enough on an iPhone to
  // hold the next frame for a noticeable moment, and the label waited on it.
  // rAF runs ahead of that frame's paint, the timeout right after it; picks
  // made meanwhile just retint to whichever metal is current.
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
    // The text and thumbnail under the label bar's invert band would show
    // their old value a moment longer in Safari otherwise.
    window.EmjiveOrderRows.resampleBand(document.querySelector(".product-detail__label-bar"));
    // The label thumbnail (and the model box's icon fallback) are static
    // images — each needs its own explicit swap to the new metal's icon, the
    // chosen design's.
    var view = state.view;
    renderLabelThumb();
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = (view.assets && view.assets.icons && view.assets.icons[metal]) || "";
    }
    // The model's poster, if the viewer isn't in yet: the viewer is built for
    // whichever metal is selected when it arrives.
    if (state.posterImg) state.posterImg.src = posterSrcFor(view, metal);
    renderSpecs();
    renderPrinting();
    renderComposition();
    tintAfterPaint();
  }

  /* ---- specs: characteristics (metal-dependent) -------------------------- */

  // The weight and the cost breakdown for one metal, from the piece's
  // measured volume (the chosen design's geometry, written by
  // scripts/measure-models.js: the print model's, see renderSpecs) and that
  // metal's constants in data/series.json's "metal-costs". Raw materials are
  // the metal bought, which is more than the finished piece weighs: the
  // process loses a share of it (lost-wax casting, binder jetting), so it is
  // weight x (1 + loss margin) x price per gram. Manufacturing is whatever
  // is left of the production cost (volume x production cost per cm3).
  // The weight is the finished piece's, in grams. Returns null if either
  // input is missing.
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

  // The figures that follow the chosen size: the dimensions, in centimetres,
  // and the weight, in grams (the two rows of the specs cluster), and the cost
  // diagram. A piece scaled by a factor weighs and costs that factor cubed
  // (the model is scaled the same on every axis); the diagram's bars are shares
  // of that cost — the raw materials', the manufacturing's — so they always fill
  // their column, and move with the metal only. The geometry is the chosen
  // design's, and as it is printed where the design has that measured
  // (geometry.print, from its STL): that is the piece that is made and
  // priced, whatever the 3D model on the page shows.
  function renderSpecs() {
    var geometry = (state.view && state.view.geometry) || {};
    var printed = geometry.print || geometry;
    var dims = printed["dimensions-mm"];
    var f = state.sizeFactor;
    var volume = printed["volume-cm3"] * f * f * f;
    var costs = computeCosts(volume, state.metalCosts[state.selectedMetal]);
    var dl = document.getElementById("productSpecs");
    dl.innerHTML = "";
    var haveDims = Array.isArray(dims) && dims.length === 3 && dims.every(function (d) { return typeof d === "number" && isFinite(d); });
    appendSpec(dl, "dimensions", "Dimensions", haveDims ?
      dims.map(function (d) { return (Math.round(d * f * 10 + 1e-6) / 100).toFixed(2); }).join(" × ") + " cm" : "TBD");
    appendSpec(dl, "weight", "Weight", costs ? costs.weight.toFixed(1) + " g" : "TBD");

    var figures = { raw: "productCostRaw", manufacturing: "productCostManufacturing", production: "productCostProduction" };
    Object.keys(figures).forEach(function (key) {
      var dd = document.getElementById(figures[key]);
      var row = dd.parentNode;
      dd.textContent = costs ? formatEuros(costs[key]) : "TBD";
      // The bars are shares of the production cost, so together they always
      // fill the column: the raw materials from 0 to their share, the
      // manufacturing from there to the whole.
      var share = costs && costs.production > 0 ? costs.raw / costs.production : 0;
      var from = key === "manufacturing" ? share : 0;
      var to = !costs ? 0 : key === "raw" ? share : 1;
      row.style.setProperty("--from", from.toFixed(4));
      row.style.setProperty("--to", to.toFixed(4));
    });
  }

  // The specs stage's printing technology: how the chosen metal is made.
  function renderPrinting() {
    var section = document.getElementById("productPrinting");
    var tech = state.technologies[state.metalTechnology[state.selectedMetal]];
    var wasShown = !section.hidden;
    var from = wasShown ? section.offsetHeight : 0;
    section.hidden = !tech;
    if (!tech) return;
    document.getElementById("productPrintingName").textContent = tech.name;
    document.getElementById("productPrintingText").textContent = tech.description;
    // A different text can be a different height, and the rows under it follow:
    // glide from the old height to the new one instead of snapping.
    if (wasShown && from > 0) tweenHeight(section, from);
  }

  // The specs stage's composition of the chosen metal, in the picker's second
  // column under the squares (data/series.json's "metal-composition"). Shown
  // in specs only (css/style.css); the same glide as the printing technology's
  // when the text is a different height.
  function renderComposition() {
    var node = document.getElementById("productComposition");
    if (!node) return;
    var text = state.compositions[state.selectedMetal] || "";
    var from = node.hidden ? 0 : node.offsetHeight;
    node.hidden = !text;
    node.textContent = text;
    if (text && from > 0) tweenHeight(node, from);
  }

  // Animates `node`'s height from `from` px to `to` (default: what it is now;
  // css/style.css .is-resizing owns the transition): pins the old height, lets
  // the next frame set the new one, and hands the height back to the layout
  // once it has arrived, then calls `after`. Called again mid-flight (read the
  // height off `node.offsetHeight` for `from` then), it starts over from
  // there, and the first call's `after` is dropped.
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
    // transitionend can be skipped (display: none, a cancelled transition), so
    // a timer past the longest the transition runs does the clean-up too.
    node._tween = setTimeout(function () {
      node._tween = null;
      node.classList.remove("is-resizing");
      node.style.height = "";
      if (after) after();
    }, 260);
  }

  function appendSpec(dl, key, label, value) {
    var group = el("div", "product-specs__item product-specs__item--" + key);
    group.appendChild(el("dt", null, label));
    group.appendChild(el("dd", null, value));
    dl.appendChild(group);
  }

  /* ---- the three stages ---------------------------------------------------- */

  // The show's scroll (js/product-stages.js) gives two eased numbers, and
  // css/style.css fades everything from them — in phases, never crossfading:
  // what a stage shows fades out, there is a blank, then what the next shows
  // fades in. This is the rest: the feed's room to scroll, and the model.
  //
  // Inspiration -> design is a plain fade (the feed out, the model, the
  // picker and the options in); the model holds still out of sight before
  // it (state.designOut).
  //
  // Design -> specs is the one with the model in it, and its blank is
  // the model's own change. A full-width inversion band (the hero's frontier
  // band) travels the whole height of the screen over the transition, from
  // under the page to over it, and the model's metal -> grey sweep is
  // that band's passage across it: it starts when the band reaches the
  // model's foot and ends when it leaves its head, the cut under the band
  // all the way. So the first fade ends (--t0) as the band reaches the
  // model, the second begins (--t1) as it leaves it, and the model's fit
  // (the shrink that makes room for the size circle, and the size scale)
  // follows from there on. The three are worked out from where the model is
  // on screen, so they hold on any screen.
  function wireStages() {
    if (!stageEl) return;
    if (!window.EmjiveProductStages) return;
    stages = window.EmjiveProductStages.mount(stageEl, { onChange: onStageChange });
    // mount() has already published once, before this handle existed: the
    // feed's room it fitted then is only taken into the track now.
    fitFeed();
    stages.update();
    // Design: the model back to its pose, the button fading out as it goes.
    if (resetEl) {
      resetEl.addEventListener("click", function () {
        resetEl.blur();
        setModelAway(false);
        if (state.modelHandle) state.modelHandle.returnHome();
      });
    }
    // The end of specs: the way back to the first stage (there is no loop).
    var restart = document.getElementById("productRestart");
    if (restart) {
      restart.addEventListener("click", function () {
        restart.blur();
        stages.restart();
      });
    }
    var resizeQueued = false;
    window.addEventListener("resize", function () {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(function () {
        resizeQueued = false;
        refreshStage();
      });
    });
  }

  function onStageChange(stage) {
    state.toDesign = stage.toDesign;
    state.toSpecs = stage.toSpecs;
    state.along = stage.along || 0;
    state.ramp = stage.ramp || 1;
    state.flow = stage.stage === "flow";
    refreshStage();
    // The cost chart builds once the last stage is fully in, and starts over
    // when it has been left (everything shows at once in the flow layout).
    var costs = document.getElementById("productCosts");
    if (costs) {
      if ((stage.stage === "flow" || stage.toSpecs >= 0.999) && !costs.classList.contains("is-built")) {
        costs.classList.add("is-built");
        // Once the cascade has played out (css/style.css: its last step ends
        // by 1.65 s), a change of the figures — another metal — moves the bars
        // all at once, not by the cascade's steps.
        clearTimeout(state.settleTimer);
        state.settleTimer = setTimeout(function () { costs.classList.add("is-settled"); }, 1800);
      } else if (stage.stage !== "flow" && stage.toSpecs < 0.5 && costs.classList.contains("is-built")) {
        clearTimeout(state.settleTimer);
        costs.classList.remove("is-built", "is-settled");
      }
    }
    // The size field gets its starting value as design's things start going.
    if ((stage.toSpecs > 0 || stage.leave > 0) && !state.sizeSeeded && state.seedSize) state.seedSize();
    // Out of sight (before design's things start to come in): the viewer
    // holds still — no drawing, no idle nudge.
    // In design, where the visitor looks at what they have changed, a released
    // model stays where it was put (the reset button takes it back); not in
    // specs, nor in the plain column, which it enters at its pose.
    var autoReturn = stage.stage !== "design";
    if (autoReturn !== state.autoReturn) {
      state.autoReturn = autoReturn;
      var handle = state.modelHandle;
      if (handle) {
        handle.setAutoReturn(autoReturn);
        if (autoReturn && (stage.stage === "specs" || stage.stage === "flow")) handle.returnHome();
      }
    }
    var out = !state.flow && stage.toDesign <= DESIGN_FROM;
    if (out === state.designOut) return;
    state.designOut = out;
    if (state.modelHandle) state.modelHandle.setPaused(out);
  }

  // The feed is taller than the screen as soon as it has a photo or two: the
  // inspiration stage's stretch of scrolling takes it up (css/style.css
  // .product-feed) by what it takes for its end — the trail under the last
  // photo, already the page's colour there — to stand FEED_CLEAR_REM above the
  // two bars at the bottom: just above the band over them (.product-bottom-veil,
  // 3.5rem tall), clear of its strong blurs, which would otherwise draw the picture's
  // colours down into the end of the trail. Published as --feed-room, which
  // js/product-stages.js turns into the stretch's length. Measured as the feed would stand unshifted,
  // against the bars as high as they ever are (the smallest viewport's
  // bottom), so it holds still once it has moved; again whenever a photo
  // arrives (it was a square until then) and on every resize.
  var FEED_CLEAR_REM = 4;
  var feedRoom = 0;
  function fitFeed() {
    var feed = document.getElementById("productFeedColumn");
    var show = document.querySelector(".product-stage__show");
    if (!stageEl || !feed || !show) return;
    var room = 0;
    if (!state.flow) {
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var showTop = show.getBoundingClientRect().top + browsePx();
      var bottom = showTop + feed.offsetTop + feed.offsetHeight;
      room = Math.max(0, bottom - (barsTopPx() - FEED_CLEAR_REM * rem));
    }
    if (Math.abs(room - feedRoom) < 0.5) return;
    feedRoom = room;
    stageEl.style.setProperty("--feed-room", room.toFixed(1) + "px");
    if (stages) stages.update();
  }

  // Where the two bars at the bottom begin, in pixels from the top of the
  // screen: the small viewport's bottom less the bars as tall as they ever are
  // (--bars-h, read off a probe), so it holds still once the page has moved.
  var barsHeightProbe = null;
  function barsTopPx() {
    if (!barsHeightProbe) {
      barsHeightProbe = el("div", null);
      barsHeightProbe.setAttribute("aria-hidden", "true");
      barsHeightProbe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--bars-h)";
      stageEl.appendChild(barsHeightProbe);
    }
    return screenHeight() - barsHeightProbe.offsetHeight;
  }

  // How far the show stands scrolled up by browsing a stage, in pixels (its
  // transform, css/style.css .product-stage__show); what is measured on it
  // is measured at its place without that.
  function browsePx() {
    var show = document.querySelector(".product-stage__show");
    if (!show) return 0;
    var t = getComputedStyle(show).transform;
    if (!t || t === "none") return 0;
    return -new DOMMatrix(t).m42;
  }

  // What the design stage's stretch of browsing takes the show up by, in
  // pixels (css/style.css --room-1: the two bars and a blank, or the room
  // fitDesignRoom has found it takes), read off a probe that is as tall.
  var designRoomProbe = null;
  function designRoomPx() {
    if (!designRoomProbe) {
      designRoomProbe = el("div", null);
      designRoomProbe.setAttribute("aria-hidden", "true");
      designRoomProbe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--room-1)";
      document.getElementById("productStage").appendChild(designRoomProbe);
    }
    return designRoomProbe.offsetHeight;
  }

  // The design stage's things — the picker and, under it, the options of a
  // product with several designs — are tall too, and the last of them can stand
  // under the bars at the bottom of the screen: the stage's stretch of
  // scrolling takes the show up by what it takes for it to clear them by
  // DESIGN_CLEAR_REM (css/style.css --design-room; it is never less than the two
  // bars and a blank, --room-0). Measured as it would stand unshifted — less
  // the show's browsing and the model's lift, which it goes up with — so it
  // holds still once it has moved. Once the picker has gone to its place in
  // the specs column (.is-specs-layout) nothing of design stands where it did:
  // the last figure is kept.
  var DESIGN_CLEAR_REM = 8;
  var designRoom = 0;
  function fitDesignRoom() {
    if (!stageEl) return;
    var room = designRoom;
    if (state.flow) {
      room = 0;
    } else if (!stageEl.classList.contains("is-specs-layout")) {
      var options = document.getElementById("productOptions");
      var last = options && !options.hidden && options.children.length ? options : document.querySelector(".product-material");
      room = 0;
      if (last) {
        var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        var bottom = last.getBoundingClientRect().bottom + browsePx() + state.lift;
        room = Math.max(0, bottom - (barsTopPx() - DESIGN_CLEAR_REM * rem));
      }
    }
    if (Math.abs(room - designRoom) < 0.5) return;
    designRoom = room;
    stageEl.style.setProperty("--design-room", room.toFixed(1) + "px");
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  // Where the model is on screen, as the top and bottom of its sweep in
  // viewport pixels — the viewer's own figures once it is in, else the
  // model slide's (the poster standing in), which is close enough to time
  // the fades by.
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

  // How far up the model stands (in pixels, from where it stands at rest) when
  // the page is `w` of the way through the design stretch and the transition,
  // and its place in specs is `place` up. One path, from the first pixel of
  // that stretch: it goes up with the show while the stretch browses
  // (`room` by its end), and then goes on to its place, at the same speed at
  // first and slowing gently to a stop there — so that the show coming back
  // down to rest as specs arrives never takes the model with it. (The
  // browsing that follows starts before the transition ends,
  // js/product-stages.js, and takes it up from there.) The stretch's browsing
  // eases in (js/product-stages.js entry(), over `ramp` of the stretch, the
  // show's own curve), so it speeds up from rest by the same amount as the
  // show does, and the model goes on from there at the pace it has got to.
  function modelRise(w, place, room, ratio, ramp) {
    var wh = ratio / (ratio + 1);
    var x = clamp(w, 0, 1);
    var a = ramp > 0 ? Math.min(1, ramp) : 1;
    if (x <= wh) return wh > 0 ? room * browseEntry(x / wh, a) : 0;
    var u = (x - wh) / (1 - wh);
    var dist = place - room;
    // The pace the browsing ends at, over the one of a straight line.
    var pace = 1 / (1 - a / 2);
    if (dist > 1) return room + dist * (1 - Math.pow(1 - u, clamp(room * pace / (ratio * dist), 1.5, 6)));
    return room + dist * u * u * (3 - 2 * u);
  }

  // How far a stretch's browsing has got (0 to 1) at u of the way through it:
  // js/product-stages.js's ramp, from there.
  function browseEntry(u, a) {
    var stages = window.EmjiveProductStages;
    if (stages && stages.entry) return stages.entry(u, a);
    return clamp(u, 0, 1);
  }

  // The t at which ease(u) = t, by bisection.
  function invEase(y) {
    var lo = 0;
    var hi = 1;
    for (var i = 0; i < 24; i++) {
      var mid = (lo + hi) / 2;
      if (ease(mid) < y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // A smooth monotone curve through the points (xs[i], ys[i]) (Fritsch-
  // Carlson), read at x: it never overshoots a point, so the band never turns
  // back. Falls back to straight lines if the points aren't strictly falling.
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

  // Zero speed and zero acceleration at both ends, as in js/product-stages.js.
  function ease(u) {
    var x = clamp(u, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
  }

  // The screen's height for the timing and the places below: the small
  // viewport (js/product-stages.js screenPx), not window.innerHeight, which on
  // iOS Safari changes as the toolbar collapses mid-scroll and would move the
  // fades (the metal picker's among them) and the model's place under the
  // visitor's finger.
  function screenHeight() {
    return window.EmjiveProductStages && window.EmjiveProductStages.screenPx ? window.EmjiveProductStages.screenPx() : window.innerHeight;
  }

  // Works the whole of the show out from state.toSpecs and where the model is: the phases' timing, the band, and what the model
  // does. Run on every change of the scroll and of the screen's size, and
  // whenever a viewer arrives.
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
    // The model's place in specs: its middle on the first quarter of the
    // screen's height — or just under the title bar, if the model is so tall
    // that its head would run under it — and then SPECS_GAP_REM lower, the
    // gap before the model. How far up that is from where the
    // model stands at rest (`place`): the middle of its tile (the design
    // frame, which the lift doesn't move), less the browsing it is under now.
    var place = 0;
    if (designFrameEl && !state.flow) {
      var box = designFrameEl.getBoundingClientRect();
      var titleBar = document.querySelector(".product-detail__label-bar");
      // (The model stands about this tall: the share of the tile it fills at
      // the size it is fitted to.)
      var half = SPECS_HALF_HEIGHT * box.height;
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var middle = Math.max(SPECS_ANCHOR * screenHeight(),titleBar ? titleBar.getBoundingClientRect().bottom + half + 8 : 0) + SPECS_GAP_REM * rem;
      place = Math.max(0, box.top + box.height / 2 + browsed - middle);
    }
    var path = modelRise(state.along, place, room, ratio, state.ramp);
    var span = state.flow ? null : modelSpan();
    if (span && span.bottom > span.top) {
      // The model's foot and head where they stand at rest (nothing applied).
      // The fades are timed by where they stand once the first stretch has
      // browsed (`room` up), the model still on its way; the band then goes
      // smoothly (a monotone curve) through four places: under the screen at
      // the start, the model's foot at t0, its head at t1 — where they stand
      // by then, the model having risen — and over the screen at the end. The
      // sweep is the band's passage across the model as it stands now.
      var restBottom = span.bottom + state.lift + browsed;
      var restTop = span.top + state.lift + browsed;
      var viewport = screenHeight();
      var h = band ? band.offsetHeight : 0;
      t0 = clamp(1 - (restBottom - room + h / 2) / (viewport + h), 0.08, 0.7);
      t1 = clamp(1 - (restTop - room + h / 2) / (viewport + h), t0 + 0.1, 0.92);
      var along = function (x) {
        return modelRise((ratio + invEase(x)) / (ratio + 1), place, room, ratio, state.ramp);
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
    state.sweep = sweep;
    // The picker changes place (under the model / in the specs column) in the middle
    // of the blank, where nothing of it shows.
    stageEl.classList.toggle("is-specs-layout", !state.flow && t > (t0 + t1) / 2);
    state.fit = clamp((t - t1) / (1 - t1), 0, 1);
    // What the model is lifted by, on top of the show: the path less what
    // the show does by itself — it goes up for the design stretch's browsing
    // and comes back down as specs arrives (css/style.css --browse-px).
    var wh = ratio / (ratio + 1);
    var browsing = room * (wh > 0 ? browseEntry(clamp(state.along / wh, 0, 1), state.ramp > 0 ? Math.min(1, state.ramp) : 1) : 1) * (1 - state.fit);
    state.lift = path - browsing;
    stageEl.style.setProperty("--lift", state.lift.toFixed(1) + "px");
    stageEl.style.setProperty("--t0", t0.toFixed(4));
    stageEl.style.setProperty("--t1", t1.toFixed(4));
    if (band) band.classList.toggle("is-on", barOn);
    syncSizeRing();
    fitBrowse(stageEl);
    fitFeed();
    applyStageToViewer();
  }

  // The specs stage's column (size, picker, printing technology, costs, shipping,
  // returns, the button back to the photos) is tall, and starts under where
  // the model stands: its end can be under the bars at the bottom of the
  // screen, out of reach (the page doesn't scroll there). So the stage's
  // stretch of scrolling takes the show up by what it takes for the end (the
  // button) to clear the bars by BROWSE_CLEAR_REM — never less than the two
  // bars' own height (css/style.css --browse-room). Measured as the column
  // would stand unshifted, so it holds still once it has moved.
  var BROWSE_CLEAR_REM = 8;
  var browseRoom = 0;
  function fitBrowse(stageEl) {
    var room = 0;
    var blocks = stageEl.querySelectorAll(".product-logistics__block, .product-restart");
    var bar = document.getElementById("productSelectBar");
    if (!state.flow && blocks.length && bar) {
      var clear = BROWSE_CLEAR_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      var bottom = blocks[blocks.length - 1].getBoundingClientRect().bottom + browsePx();
      room = Math.max(0, bottom - (bar.getBoundingClientRect().top - clear));
    }
    if (Math.abs(room - browseRoom) < 0.5) return;
    browseRoom = room;
    stageEl.style.setProperty("--browse-room", room.toFixed(1) + "px");
  }

  function applyStageToViewer() {
    if (!state.modelHandle) return;
    state.modelHandle.setBlueprint(state.sweep, state.fit);
    state.modelHandle.setSize(state.sizeFactor);
  }

  // The model is drawn at the chosen ring size: the specs stage's size field
  // and slider call this with what they hold. Its base size is 62 (what the
  // model files are authored at, and what the field starts at when specs
  // first comes in); the slider's own range bounds how far it scales, and no
  // size (or a half-typed one) is the base. The size also goes to the label
  // bar, and to the dimensions and the cost diagram.
  var SPECS_ANCHOR = 0.25;
  var SPECS_HALF_HEIGHT = 0.13;
  // The gap before the model in specs, on top of where it would stand: 7.5rem.
  var SPECS_GAP_REM = 7.5;
  // The base is the size the model is drawn at, and the one its price is for
  // (EmjiveSelection.priceAt). The ends are the product's own size-range,
  // set when it renders.
  var SIZE_BASE_MM = 62;
  var SIZE_MIN_MM = 40;
  var SIZE_MAX_MM = 80;
  function setModelSize(raw) {
    var mm = parseFloat(raw);
    var given = window.EmjiveSelection.isValidSize(raw) && isFinite(mm);
    state.sizeFactor = given ? clamp(mm, SIZE_MIN_MM, SIZE_MAX_MM) / SIZE_BASE_MM : 1;
    state.sizeText = given ? String(+mm.toFixed(2)) : "";
    if (state.modelHandle) state.modelHandle.setSize(state.sizeFactor);
    if (state.product) {
      renderSpecs();
      renderLabelType(state.product);
      renderLabelPrice(state.product);
    }
    syncSizeRing();
  }

  /* ---- the size circle ---------------------------------------------------- */

  // How far from the line a touch still takes the circle, each way, and the
  // room the box has beyond the largest circle.
  var RING_BAND_PX = 22;
  var RING_PAD_PX = 4;
  // Arrow keys: the step, and with Shift the fine one, in millimetres.
  var RING_KEY_STEP = 0.5;
  var RING_KEY_FINE = 0.1;
  var RING_KEY_PAGE = 5;
  // A drag on the circle moves the size by half of what the finger moves the
  // circle's edge (the gain, as the size finder's sliders have), and by less
  // as the size nears an end in the direction of the drag: within
  // RING_RESIST_MM of it the gain falls, by a smooth curve, to
  // RING_RESIST_END of itself at the end — so the extremes take a long drag.
  var RING_DRAG_GAIN = 0.5;
  var RING_RESIST_MM = 10;
  var RING_RESIST_END = 0.2;

  // The circle's sizes in pixels, from the viewer's: now (at the fit and the
  // size the page is at), at the largest size (what the layout under it makes
  // room for), and per millimetre at the fit — the circle's radius is the
  // model's reach from its middle, which scales with the size. null with no
  // live model.
  function ringGeometry() {
    var handle = state.modelHandle;
    var g = handle && handle.sizeRing && handle.sizeRing();
    if (!g) return null;
    var scale = 1 + (g.fitScale * state.sizeFactor - 1) * state.fit;
    return {
      now: g.reachPx * scale,
      max: g.reachPx * g.fitScale * (SIZE_MAX_MM / SIZE_BASE_MM),
      perMm: g.reachPx * g.fitScale / SIZE_BASE_MM
    };
  }

  // A disc as an SVG path: for the band, an annulus (evenodd) of two.
  function ringDisc(c, r) {
    return "M " + (c - r).toFixed(1) + " " + c.toFixed(1) + " a " + r.toFixed(1) + " " + r.toFixed(1) + " 0 1 0 " + (2 * r).toFixed(1) +
      " 0 a " + r.toFixed(1) + " " + r.toFixed(1) + " 0 1 0 " + (-2 * r).toFixed(1) + " 0 Z ";
  }

  // The circle drawn at the right size (--ring-r), its box and the band that
  // takes a touch (an annulus: clip-path clips hit-testing as well as
  // painting) — and what the layout needs: the circle's radius at the largest
  // size (--ring-r-max, on the design frame), under which the column starts.
  // Run whenever the size, the fit, the model or the screen changes.
  var ringShape = "";
  function syncSizeRing() {
    var ring = state.sizeRing;
    if (!ring || !designFrameEl) return;
    var g = state.flow ? null : ringGeometry();
    state.ringGeo = g;
    if (!g) {
      if (!ring.el.hidden) ring.el.hidden = true;
      designFrameEl.style.removeProperty("--ring-r-max");
      ringShape = "";
      return;
    }
    ring.el.hidden = false;
    var box = 2 * (g.max + RING_BAND_PX + RING_PAD_PX);
    var shape = box.toFixed(1) + "|" + g.now.toFixed(1);
    if (shape !== ringShape) {
      ringShape = shape;
      var c = box / 2;
      var inner = Math.max(0, g.now - RING_BAND_PX);
      var path = "path(evenodd, \"" + ringDisc(c, g.now + RING_BAND_PX) + (inner > 0 ? ringDisc(c, inner) : "") + "\")";
      ring.hit.style.webkitClipPath = path;
      ring.hit.style.clipPath = path;
      ring.el.style.setProperty("--ring-box", box.toFixed(1) + "px");
      ring.el.style.setProperty("--ring-r", g.now.toFixed(1) + "px");
      designFrameEl.style.setProperty("--ring-r-max", g.max.toFixed(1) + "px");
    }
    var given = state.sizeText !== "";
    ring.el.classList.toggle("is-unset", !given);
    ring.hit.setAttribute("aria-valuenow", given ? state.sizeText : String(SIZE_BASE_MM));
    ring.hit.setAttribute("aria-valuetext", (given ? state.sizeText : String(SIZE_BASE_MM)) + " mm");
  }

  // The gain of a drag that moves the size `from` by `delta` millimetres (its
  // sign the direction): RING_DRAG_GAIN, less within RING_RESIST_MM of the end
  // it is heading for.
  function dragGain(from, delta) {
    var toEnd = delta > 0 ? SIZE_MAX_MM - from : from - SIZE_MIN_MM;
    var u = clamp(toEnd / RING_RESIST_MM, 0, 1);
    var smooth = u * u * (3 - 2 * u);
    return RING_DRAG_GAIN * (RING_RESIST_END + (1 - RING_RESIST_END) * smooth);
  }

  // The circle's touches and keys: a drag on its band moves the size by the
  // finger's movement across the circle's edge, over the pixels a millimetre
  // is, times the gain (dragGain) — the circle follows the size, not the
  // finger, and the grip on the line follows the finger round — to the nearest
  // tenth, between the ends (the size is kept as it is moved, so a slow drag
  // adds up instead of rounding away). The field follows.
  function wireSizeRing(field) {
    var el = document.getElementById("productSizeRing");
    var hit = document.getElementById("productSizeRingHit");
    if (!el || !hit) return;
    state.sizeRing = { el: el, hit: hit };
    var grabbed = null;

    function setSize(mm) {
      mm = clamp(Math.round(mm * 10) / 10, SIZE_MIN_MM, SIZE_MAX_MM);
      field.value = mm.toFixed(1);
      setModelSize(field.value);
    }

    function currentSize() {
      var mm = parseFloat(field.value);
      return window.EmjiveSelection.isValidSize(field.value) && isFinite(mm) ? mm : SIZE_BASE_MM;
    }

    // The finger's distance from the circle's middle, and the grip's angle.
    function fingerAt(e) {
      var r = el.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width / 2);
      var dy = e.clientY - (r.top + r.height / 2);
      el.style.setProperty("--ring-angle", (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1) + "deg");
      return Math.sqrt(dx * dx + dy * dy);
    }

    function follow(e) {
      var g = state.ringGeo;
      if (!g || !grabbed) return;
      var distance = fingerAt(e);
      var delta = (distance - grabbed.distance) / g.perMm;
      grabbed.distance = distance;
      if (delta === 0) return;
      grabbed.mm = clamp(grabbed.mm + delta * dragGain(grabbed.mm, delta), SIZE_MIN_MM, SIZE_MAX_MM);
      setSize(grabbed.mm);
    }

    hit.addEventListener("pointerdown", function (e) {
      if ((e.pointerType === "mouse" && e.button !== 0) || !state.ringGeo) return;
      e.preventDefault();
      // Where it was taken: the size moves from here, the circle doesn't jump
      // to the finger.
      grabbed = { id: e.pointerId, distance: fingerAt(e), mm: currentSize() };
      try { hit.setPointerCapture(e.pointerId); } catch (err) { /* a pointer that is already gone */ }
    });
    hit.addEventListener("pointermove", function (e) {
      if (grabbed && e.pointerId === grabbed.id) follow(e);
    });
    function release(e) {
      if (grabbed && e.pointerId === grabbed.id) grabbed = null;
    }
    hit.addEventListener("pointerup", release);
    hit.addEventListener("pointercancel", release);

    hit.addEventListener("keydown", function (e) {
      var step = e.shiftKey ? RING_KEY_FINE : RING_KEY_STEP;
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") next = currentSize() + step;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = currentSize() - step;
      else if (e.key === "PageUp") next = currentSize() + RING_KEY_PAGE;
      else if (e.key === "PageDown") next = currentSize() - RING_KEY_PAGE;
      else if (e.key === "Home") next = SIZE_MIN_MM;
      else if (e.key === "End") next = SIZE_MAX_MM;
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

  /* ---- 4 + size modal + selection ---------------------------------------- */

  function wireSelectButton(product) {
    var selectBtn = document.getElementById("selectButton");
    // The unit is a property of the category (all rings are measured the
    // same way, all necklaces would share another), not of the individual
    // product — and the category vocabulary is global rather than
    // per-series, so this resolves identically whichever series the product
    // lives in. See data/series.json's top-level "categories". Its "sizes"
    // run isn't read any more: the size field below is the only way to
    // give a size.
    var info = window.EmjiveSeries.categoryInfo(product.category);
    var unit = info.unit || "";

    var customInput = document.getElementById("sizeModalCustomInput");
    var customUnit = document.getElementById("sizeModalCustomUnit");
    var finderToggle = document.getElementById("sizeModalFinderToggle");
    // The size finder (js/size-finder.js), from the sheet (beside the size
    // field) and from the specs stage (under its size row): its chart is the
    // category's own size guide, and a category with none gets no button.
    var guide = info["size-guide"];
    var hasFinder = !!(window.EmjiveSizeFinder && guide && guide.rows && guide.rows.length);
    finderToggle.hidden = !hasFinder;
    // What the finder works out goes into the field as if typed: the field's
    // own input listener does the rest.
    function openFinder(toggle, input) {
      window.EmjiveSizeFinder.open({
        guide: guide,
        returnFocus: toggle,
        onFill: function (size) {
          input.value = window.EmjiveSelection.normalizeSize(size);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }
    finderToggle.addEventListener("click", function () { openFinder(finderToggle, customInput); });

    var selectBar = document.getElementById("productSelectBar");
    var selectLabel = selectBar.querySelector(".product-select-bar__label");
    selectBar.hidden = false;

    // The Select bar steps aside while the Modify sheet is up: that sheet
    // rests on the drawer's one remaining row, right where this bar rides.
    function setBarAway(away) {
      selectBar.classList.toggle("is-away", away);
      selectBar.inert = away;
    }
    window.addEventListener("emjive:modify-open", function () { setBarAway(true); });
    window.addEventListener("emjive:modify-close", function () { setBarAway(false); });

    // A category with no unit has nothing to measure yet (neck and wrist,
    // today) — the Select bar stays disabled rather than opening a field
    // nobody knows how to fill in.
    if (!unit) {
      selectBtn.setAttribute("aria-disabled", "true");
      selectLabel.textContent = "No sizes available";
      return;
    }

    customUnit.textContent = unit;

    var modal = document.getElementById("sizeModal");

    // The specs stage's own size: a field to type an exact size in (any
    // orderable size, in or out of the circle's range) and the circle round
    // the model, which is as big as the model is at that size and can be
    // dragged to change it — the two follow each other (setModelSize drives
    // the circle). What the field holds is what the sheet opens with; it
    // never works the other way round — the sheet doesn't write back — so a
    // visitor who never gave a size in specs keeps getting an empty sheet, an
    // earlier Add included. Same filtering as the sheet's field; Enter opens
    // the sheet with it. The circle's range is in millimetres, the one unit
    // with a size run today (a category with no unit never gets this row at
    // all).
    var specsSize = document.getElementById("productSizeInput");
    document.getElementById("productSizeUnit").textContent = unit;
    document.getElementById("productSize").hidden = false;
    // The specs stage's "Find my size", centred under the field.
    var specsFinderToggle = document.getElementById("productSizeFinderToggle");
    specsFinderToggle.hidden = !hasFinder;
    specsFinderToggle.addEventListener("click", function () { openFinder(specsFinderToggle, specsSize); });
    // The first time specs comes in the field starts at the model's own size
    // (62), as if it had been given; from then on it is the visitor's.
    state.seedSize = function () {
      state.sizeSeeded = true;
      state.seedSize = null;
      if (specsSize.value !== "") return;
      specsSize.value = String(SIZE_BASE_MM);
      setModelSize(specsSize.value);
    };
    wireSizeRing(specsSize);
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

    // The glass Select bar's one button: "Select" (opens the sheet), then
    // "Add" while the sheet is up — the only way to confirm. Add is dimmed
    // (aria-disabled) until the field holds a size that can actually be
    // ordered: an empty field, a lone "." or a zero isn't one. See
    // isValidSize in js/selection.js. The label fades out, changes, and
    // fades back in rather than changing in plain sight.
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

    function syncBar() {
      var isOpen = modal.classList.contains("is-open");
      setBarLabel(isOpen ? "Add" : "Select");
      // Add mode: the sheet rests above the bar, so the bar gets a ground of
      // its own (css/style.css .product-select-bar.is-add).
      selectBar.classList.toggle("is-add", isOpen);
      var canAct = !isOpen || window.EmjiveSelection.isValidSize(customInput.value);
      selectBtn.setAttribute("aria-disabled", String(!canAct));
    }

    // Filtered down to digits and one decimal point (js/selection.js's
    // sanitizeSizeInput, shared with the Modify sheet). Only written back
    // when the filter actually changed something — reassigning an
    // unchanged value would throw the caret to the end on every keystroke.
    customInput.addEventListener("input", function () {
      var cleaned = window.EmjiveSelection.sanitizeSizeInput(customInput.value);
      if (cleaned !== customInput.value) customInput.value = cleaned;
      syncBar();
    });

    // Enter confirms. Not just a convenience: the Add button lives in the
    // Select bar, outside the focus trap, so without this a keyboard
    // visitor could type a size and have no way to add it.
    customInput.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (window.EmjiveSelection.isValidSize(customInput.value)) confirmAdd(true);
    });

    function openModal() {
      // Pre-filled from the specs stage when a size was given there (Add is
      // then live straight away); otherwise empty, as it always was.
      customInput.value = window.EmjiveSelection.isValidSize(specsSize.value) ? specsSize.value : "";
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      syncBar();
      // AFTER .is-open, not before: the modal is visibility: hidden until
      // that class lands, and focus() on a hidden element is a no-op. The
      // trap also freezes the page behind the sheet (and frees it again on
      // release()).
      // selectBtn is resolved once at wireSelectButton() time and is never
      // re-rendered, so a plain element reference is enough here — unlike
      // the order page's per-row trigger.
      window.EmjiveFocusTrap.activate(modal, {
        returnFocus: selectBtn,
        onEscape: closeModal
      });
    }

    // quiet: focus goes back to the Select button without a ring — Enter in
    // the field confirms from the keyboard, and the ring that would otherwise
    // appear there right after reads as a glitch (see js/focus-trap.js).
    function closeModal(quiet) {
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      // Covers both paths that reach here: a successful confirmAdd() (which
      // calls this after adding) and an abandoned pick via backdrop/Escape
      // — either way, the bar goes back to "Select" once the sheet is gone.
      // Before the trap lets go, so focus lands back on a live button.
      syncBar();
      window.EmjiveFocusTrap.release(undefined, quiet === true);
    }

    // The actual "add to cart" action — reached via the Select bar's Add or
    // Enter in the field, both of which only fire for a valid size; the
    // guard below is belt and braces against a stale callback.
    function confirmAdd(quiet) {
      if (!window.EmjiveSelection.isValidSize(customInput.value)) return;
      var view = state.view;
      var size = window.EmjiveSelection.normalizeSize(customInput.value);
      var item = {
        // Which series this came from — product ids are only unique within
        // one, so the id alone no longer identifies a piece.
        series: state.seriesSlug,
        productId: product.id,
        // The chosen design's name and icon (the product's own for a product
        // with one design), so every list shows the piece as it was chosen.
        name: view.designName || product.name,
        category: product.category,
        metal: state.selectedMetal,
        // Stored in its one canonical form ("62.5" -> "62.50", "62." -> "62").
        size: size,
        price: window.EmjiveSelection.priceAt(product, state.selectedMetal, size),
        image: (view.assets && view.assets.icons && view.assets.icons[state.selectedMetal]) || ""
      };
      if (product.designs) item.design = state.designKey;
      window.EmjiveSelection.addItem(item);
      closeModal(quiet);
    }

    selectBtn.addEventListener("click", function () {
      if (!modal.classList.contains("is-open")) openModal();
      else if (window.EmjiveSelection.isValidSize(customInput.value)) confirmAdd();
    });
    document.getElementById("sizeModalBackdrop").addEventListener("click", closeModal);
    // Escape is handled by the focus trap's own keydown listener (registered
    // on activate, removed on release) rather than by a permanent
    // document-level one here. That listener already exists for Tab, and
    // folding Escape into it means the two can't disagree about whether the
    // modal is open — the old handler gated on .is-open, a second source of
    // truth for exactly that.

    // The bar's drawer can still be opened over this sheet (its height is
    // what pushes the sheet up — see --selection-bar-live-height), and
    // tapping a drawer row opens a sheet of its own (js/modify-modal.js).
    // Two sheets stacked on one backdrop is never right, so this one steps
    // aside for it.
    window.addEventListener("emjive:modify-open", function () {
      if (modal.classList.contains("is-open")) closeModal();
    });
  }

  init();
})();
