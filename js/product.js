/* ==========================================================================
   J&MV — product detail page
   Resolves ?id= against the active series' products.json and renders the label, carousel,
   metal picker, description, characteristics and size/selection flow — the
   two stages of product.html's show (presentation, specs), whose
   scrolling js/product-stages.js drives; this file reacts to it for the parts
   CSS can't do (the model's grey sweep, the carousel holding the model).
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("productDetail");
  if (!root) return;

  var loadingEl = document.getElementById("productDetailLoading");
  var contentEl = document.getElementById("productDetailContent");

  // The drag/paging/tap-to-center behaviour lives in js/carousel.js, shared
  // with the Modify sheet's small carousel — wired once here, since the
  // viewport/track are static markup in product.html and only the slides
  // inside the track change per product. dragScroll: a vertical drag on it
  // scrolls the page (the model's circle apart, see createModelViewer).
  var carouselEl = document.getElementById("productCarousel");
  var carousel = window.EmjiveCarousel(carouselEl, { dragScroll: true });
  // The frame around it (see carouselLoadHold).
  var carouselFrameEl = document.getElementById("productCarouselFrame");
  // How far presentation's things have gone (--leave) when the carousel's strip
  // is held on the model.
  var HOLD_AT = 0.25;

  var state = {
    product: null,
    metals: [],
    // data/series.json's "metal-costs", keyed by metal (see computeCosts).
    metalCosts: {},
    // data/series.json's "metal-technology" (metal -> technology) and
    // "printing-technologies" (technology -> { name, description }).
    metalTechnology: {},
    technologies: {},
    selectedMetal: null,
    modelHandle: null,
    // The model slide's poster <img> while the viewer isn't in yet.
    posterImg: null,
    // The x-ray backdrop's original file (the page shows a version of it
    // chosen for the viewport — see startXray) and whether the viewport
    // watcher is wired.
    xraySrc: "",
    xrayWatching: false,
    iconFallbackImg: null,
    // How far the show has gone (js/product-stages.js): presentation ->
    // specs, 0 to 1 — and what that makes of the model (refreshStage). Kept so
    // a viewer built later (first mount, after the Modify sheet, after Back)
    // starts where the page is.
    toSpecs: 0,
    // How far the page is through the first stretch and the transition, linear
    // in the scroll from its first pixel: what the model's rise runs on.
    along: 0,
    sweep: 0,
    fit: 0,
    // The chosen ring size over the model's base size (setModelSize), and
    // the size as it stands in the specs field when it is a valid one ("" if
    // none: the label bar then shows no size).
    sizeFactor: 1,
    sizeText: "",
    // How far the model is lifted on the page, in pixels (refreshStage): on its
    // way to its place in specs, from the first pixel of scrolling.
    lift: 0,
    // Whether the specs size has been given its starting value (62).
    sizeSeeded: false,
    seedSize: null,
    // Whether the carousel is held on the model (presentation's things are on
    // their way out).
    carouselHeld: false,
    // The timer that marks the cost chart as played out.
    settleTimer: 0
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // One loader for the whole carousel — the model's, the photos' and the icon
  // fallback's waits all go through it (js/loader.js, "a loader shared by
  // several assets"), and it only shows while one of them is both loading and
  // on screen. A hold on it names the slide the asset appears in. null when
  // there is no loader (js/loader.js missing, reduced motion). It is mounted on
  // the carousel's frame, not the carousel itself, which is a stacking context
  // of its own: there it passed under the metal picker and the edge bands.
  function carouselLoadHold(slide) {
    if (!window.EmjiveLoader || !slide) return null;
    var hold = window.EmjiveLoader.mount(carouselFrameEl || carouselEl, { target: slide });
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
  // The model's slide starts as its poster
  // image and the viewer takes that slot over once the chunk, and the images
  // the first paint is waiting on, are in (mountViewerWhenReady below). The
  // x-ray backdrop is the page's largest image; it used to be requested only
  // after the chunk had arrived and then fought the HDRI and the model for
  // bandwidth.
  function init() {
    window.EmjiveSeries.ready
      .then(function (ctx) {
        state.metals = ctx.index.metals || [];
        state.metalCosts = ctx.index["metal-costs"] || {};
        state.metalTechnology = ctx.index["metal-technology"] || {};
        state.technologies = ctx.index["printing-technologies"] || {};
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

    // First, ahead of everything else this function builds: the x-ray
    // backdrop is the largest image on the page — what the first paint is
    // really waiting on — so its request goes out before any other image's.
    var xrayReady = startXray(product);

    renderLabel(product);
    var carouselParts = renderCarousel(product);
    renderMetalOptions(product);
    renderSpecs(product);
    renderPrinting();
    // Plain text under the title — no heading, nothing to open. A product
    // without one shows nothing there rather than a placeholder.
    var description = document.getElementById("productDescription");
    description.textContent = product.description || "";
    description.hidden = !product.description;
    wireSelectButton(product);

    loadingEl.hidden = true;
    contentEl.hidden = false;

    // Carousel geometry (js/carousel.js's getBoundingClientRect calls) can
    // only be measured once #productDetailContent is actually visible —
    // while it's [hidden], every element in it has a zero-size box, which
    // would read as a zero-width tile/carousel and rest at offset 0
    // instead of centering the first tile.
    carousel.sync(true);
    // After the carousel, for the same reason (the stages measure the track)
    // and because a page restored part way down starts with the carousel
    // already held on the model.
    wireStages();

    // The arrival loader (js/loader.js) lifts once the images the first
    // paint is made of are in, rather than on a blank page that fills in
    // underneath it; and everything that isn't needed for that paint waits
    // until then, so none of it competes with those images for bandwidth.
    var firstPaintReady = Promise.race([
      Promise.all([xrayReady, carouselParts.posterReady]),
      new Promise(function (resolve) { setTimeout(resolve, FIRST_PAINT_WAIT_MS); })
    ]);
    firstPaintReady.then(pageReady);
    // ...and not before they have actually been painted: the images being
    // downloaded is not the same moment as them being on screen, and anything
    // started in between (the viewer, the environment map, the model) is
    // competing with a paint that has not happened yet.
    firstPaintReady
      .then(afterFirstPaint)
      .then(function () { loadRemainingAssets(product, carouselParts); });
  }

  // Resolves once the browser has painted the carousel's first picture — the
  // x-ray backdrop or the model's poster, whichever the browser reports as the
  // largest paint inside the carousel frame — or after a short cap, or at the
  // next two frames where the Largest Contentful Paint API is missing.
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
      var frame = document.getElementById("productCarouselFrame");
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

  // The x-ray backdrop: static, independent of the metal and the slides. No
  // product.assets.xray (Foramen/Disc today) means no backdrop at all, rather
  // than a broken image. Resolves once the image is loaded and decoded (or
  // failed), so callers can wait on it.
  function startXray(product) {
    var xray = document.getElementById("productCarouselXray");
    var xraySrc = product.assets && product.assets.xray;
    if (!xraySrc) {
      xray.hidden = true;
      return Promise.resolve();
    }
    // The low-res version for this viewport first (~25-50KB against ~320KB
    // for the original): it is what the first paint waits on.
    // loadRemainingAssets() swaps the high-res one in afterwards. A phone's
    // versions are cropped to the middle of the picture, which is why the
    // phone rule for .product-carousel__xray in css/style.css narrows the box
    // to match. Without EmjiveLoader, the original directly.
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
    return loader ? loader.imageReady(xray) : Promise.resolve();
  }

  // What the first paint did not need: the other metals' icons (so a pick
  // swaps the label thumbnail at once — the selected one's is already in),
  // the photo slides, and the 3D viewer.
  function loadRemainingAssets(product, carouselParts) {
    var icons = (product.assets && product.assets.icons) || {};
    window.EmjiveOrderRows.preload(Object.keys(icons)
      .filter(function (m) { return m !== state.selectedMetal; })
      .map(function (m) { return icons[m]; }));
    carouselParts.photoSlides.forEach(function (slide) { slide.loadImage(); });
    carouselParts.mountViewer();
    // The sharp x-ray replaces the small one once the model is on screen
    // (or, at the latest, VIEWER_SETTLE_WAIT_MS after the first paint), so
    // its 320KB never competes with the viewer, the environment map and the
    // model for the link.
    if (state.xraySrc && window.EmjiveLoader) {
      Promise.race([
        carouselParts.viewerSettled,
        new Promise(function (resolve) { setTimeout(resolve, VIEWER_SETTLE_WAIT_MS); })
      ]).then(function () {
        window.EmjiveLoader.upgradeImage(
          document.getElementById("productCarouselXray"),
          window.EmjiveLoader.versions(state.xraySrc, true).hi
        );
      });
    }
  }

  var VIEWER_SETTLE_WAIT_MS = 20000;

  /* ---- 1. label ------------------------------------------------------- */

  function renderLabel(product) {
    document.getElementById("productLabelName").textContent = product.name || "";
    renderLabelType(product);

    renderLabelThumb(product);
    renderLabelPrice(product);
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
  // image. Re-run from onMetalSelect too (not just the initial render), so
  // the thumbnail always matches whichever finish is currently selected.
  function renderLabelThumb(product) {
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
    var thumbSrc = (product.assets && product.assets.icons && product.assets.icons[state.selectedMetal]) || "";
    if (thumbSrc) {
      thumb.src = thumbSrc;
      thumb.hidden = false;
    } else {
      thumb.hidden = true;
    }
  }

  function renderLabelPrice(product) {
    var details = (product["per-metal-specs"] && product["per-metal-specs"][state.selectedMetal]) || {};
    document.getElementById("productLabelPrice").textContent =
      window.EmjiveSelection.formatPrice(details.price || 0);
  }

  /* ---- 2. carousel ------------------------------------------------------ */

  function renderCarousel(product) {
    var track = document.getElementById("productCarouselTrack");
    // .product-carousel--single lives on the outer frame, not
    // #productCarousel itself — see css/style.css's .product-carousel-frame
    // comment for why --tile (which that class's override also targets)
    // had to move up there.
    var carouselFrame = document.getElementById("productCarouselFrame");
    track.innerHTML = "";

    // (The static x-ray backdrop behind the filmstrip is startXray()'s: it is
    // requested ahead of everything this function builds.)

    var slideSources = [];
    var modelSlide = null;
    // Resolves once the slide the first paint shows — the model's poster, or
    // the icon of a model-less product — is in. render() lifts the arrival
    // loader on it.
    var posterReady = Promise.resolve();
    var photoSlides = [];
    // Resolves when the 3D model is on screen — or will never be (no viewer,
    // failed, no model at all). What render() holds the sharp x-ray back for:
    // that swap is polish, and should not share the link with the model.
    var settleViewer;
    var viewerSettled = new Promise(function (resolve) { settleViewer = resolve; });
    // window.EmjiveModelViewer is exposed by js/three-viewer.js — reused
    // here so the viewer construction/material logic lives in exactly one
    // place. It can return null if the browser couldn't grant a WebGL
    // context (see its own comment) — falls through to the same icon
    // fallback branch a product with no "assets.model" field at all uses,
    // rather than leaving the carousel empty.
    // Factored out of the assignment below so the freeze/restore pair at the
    // bottom of this function can rebuild an identical viewer later. Reads
    // state.selectedMetal at call time, so a rebuild picks up whatever metal
    // is selected then rather than the one the page opened on.
    function buildModelViewer() {
      // The viewer is a separate module: if it never arrived (its hashed file
      // gone after a deploy while this page's HTML was cached, a blocked
      // request) the carousel takes the icon fallback below, exactly as it
      // does for a browser with no WebGL.
      if (typeof window.EmjiveModelViewer !== "function") return null;
      // The model's wait goes through the carousel's one shared loader (see
      // loadHoldFor): held on the model's slide, handed to the viewer, which
      // releases it when the model is on screen or has failed or the viewer is
      // disposed. If no viewer comes back the hold is released here.
      var hold = carouselLoadHold(modelSlide);
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
      return window.EmjiveModelViewer(product, state.selectedMetal, {
        hdri: window.EmjiveSeries.hdriPath(state.seriesSlug),
        // The carousel's shared loader, held on this slide while the model
        // loads (false: none, e.g. reduced motion) — the viewer's box has no
        // visible edge, and the loader belongs to the whole strip anyway.
        loader: loadHold || false,
        // Only a circle of the viewer is the model's to drag: its radius
        // leaves a quarter of the viewer's width as a margin. A press outside
        // it pages the carousel or scrolls the page (js/carousel.js).
        hitCircle: 0.25,
        // Fires for an initial load/HDRI failure OR — since
        // three-viewer.js also treats a WebGL context loss as a failure
        // — for a model that HAD already loaded and was on screen: iOS
        // Safari can silently reclaim a GPU context under memory
        // pressure at any time, not just during load. Previously nothing
        // here handled this at all (unlike js/main.js's grid), so either
        // failure just left an empty, permanently blank 3D-viewer slide
        // with no fallback ever shown.
        onError: replaceModelSlideWithIcon,
        onReady: function () {
          settleViewer();
          syncBracketsFlag();
        },
        // The specs stage's metal -> grey sweep and dimensioned box (see
        // onStageChange). lineColor is the box's edges' base colour.
        blueprint: { lineColor: pageColor("--category-col", "#727272") }
      });
    }

    state.modelHandle = null;
    state.posterImg = null;
    if (product.assets && product.assets.model) {
      // Smaller than the photo slides on purpose, and only a circle of it
      // takes a drag (hitCircle, createModelViewer): the empty space around
      // is what a drag or swipe can start from to page the carousel or
      // scroll the page without landing on the viewer's own
      // TrackballControls.
      // Holds the model's poster until mountViewer() swaps the viewer in.
      modelSlide = el("div", "product-carousel__slide product-carousel__slide--model");
      posterReady = showPoster();
      track.appendChild(modelSlide);
      slideSources.push("model");
    } else {
      var fallbackIconSrc = product.assets && product.assets.icons && product.assets.icons[state.selectedMetal];
      if (fallbackIconSrc) {
        var iconSlide = window.EmjiveCarousel.imageSlide(fallbackIconSrc, product.name, { loaderHost: carouselFrameEl || carouselEl });
        // Kept so onMetalSelect can swap its src on a metal switch — this
        // slide isn't rebuilt then, only the 3D viewer path re-tints live,
        // so a static image needs its own explicit update.
        state.iconFallbackImg = iconSlide.querySelector("img");
        if (window.EmjiveLoader) posterReady = window.EmjiveLoader.imageReady(state.iconFallbackImg);
        track.appendChild(iconSlide);
        slideSources.push("icon");
      }
    }

    // The model slide before the viewer is in: its poster image (the same
    // one the viewer shows over its own canvas until the model is drawn), in
    // a box sized exactly like the viewer that replaces it, so the swap moves
    // nothing — the Modify sheet's stand-in for the same reason (js/modify-
    // modal.js posterBox(), .size-modal__model-poster in css/style.css).
    function showPoster() {
      modelSlide.innerHTML = "";
      state.posterImg = null;
      var src = posterSrcFor(product, state.selectedMetal);
      if (!src) return Promise.resolve();
      var box = el("div", "size-modal__model-poster");
      var img = document.createElement("img");
      img.src = src;
      img.alt = product.name || "";
      img.draggable = false;
      box.appendChild(img);
      modelSlide.appendChild(box);
      state.posterImg = img;
      return window.EmjiveLoader ? window.EmjiveLoader.imageReady(img) : Promise.resolve();
    }

    // Swaps the viewer in for the poster. Also what restoreModelViewer() calls
    // after a back/forward-cache restore. No WebGL context to be had (or the
    // viewer module never arrived) means the icon fallback, as always.
    function attachViewer() {
      if (state.modelHandle || !modelSlide) return;
      // The slide loses this class the moment replaceModelSlideWithIcon
      // takes it over, which is exactly the case that must NOT be rebuilt —
      // the visitor is looking at the icon fallback, and a viewer appended
      // underneath it would be an invisible second context.
      if (!modelSlide.classList.contains("product-carousel__slide--model")) return;
      var handle = buildModelViewer();
      if (!handle) {
        replaceModelSlideWithIcon();
        return;
      }
      state.modelHandle = handle;
      state.posterImg = null;
      modelSlide.innerHTML = "";
      modelSlide.appendChild(handle.el);
      // Wherever the show is now — a rebuild after the Modify sheet or Back
      // can land in specs.
      applyStageToViewer();
    }

    // Called by render() once the first paint's images are in. Waits for the
    // viewer chunk (already downloading since the HTML — see the modulepreload
    // injectLoadHints() adds), then builds it when the browser is idle:
    // creating a WebGL context and compiling shaders is a long task that
    // should not land on top of the images and text arriving.
    function mountViewer() {
      if (!modelSlide) {
        settleViewer();
        return;
      }
      if (!window.EmjiveLoadViewer) {
        replaceModelSlideWithIcon();
        return;
      }
      // The chunk, the environment map and the model are independent
      // downloads; the viewer asks for the last two only once it has been
      // built, which is after the chunk. Hinting them now runs all three at
      // once instead of one after another (the viewer's own requests then
      // reuse these, being the same URL fetched the same way).
      hintFetch(window.EmjiveSeries.hdriPath(state.seriesSlug));
      hintFetch(product.assets.model);
      window.EmjiveLoadViewer().then(function () {
        whenIdle(attachViewer);
      }, replaceModelSlideWithIcon);
    }

    // Swaps a failed model slide's contents for the same icon fallback a
    // model-less product gets, IN PLACE — the slide itself (its position in
    // the track and therefore the carousel's own bounds/offset math) never
    // changes, only what's rendered inside it,
    // so a failure arriving well after the carousel has already been
    // measured/scrolled can't desync its geometry. Reuses
    // state.iconFallbackImg (not a separate field) so onMetalSelect's
    // existing "if (state.iconFallbackImg) swap its src" branch already
    // handles a later metal switch with no further changes needed here.
    function replaceModelSlideWithIcon() {
      if (state.modelHandle) {
        state.modelHandle.dispose();
        state.modelHandle = null;
      }
      settleViewer();
      syncBracketsFlag();
      if (!modelSlide) return;
      modelSlide.classList.remove("product-carousel__slide--model");
      modelSlide.innerHTML = "";
      state.posterImg = null;
      var fallbackIconSrc = product.assets && product.assets.icons && product.assets.icons[state.selectedMetal];
      if (fallbackIconSrc) {
        var img = document.createElement("img");
        img.src = fallbackIconSrc;
        img.alt = product.name || "";
        img.loading = "lazy";
        img.draggable = false;
        modelSlide.appendChild(img);
        state.iconFallbackImg = img;
      }
    }

    /* ---- releasing the viewer while the page is frozen --------------------
       Same reasoning as js/gallery-stack.js's pagehide, from the other end
       of the same navigation. Pressing Back doesn't end this page: it goes
       into the back/forward cache holding its WebGL context, its decoded
       model and its PMREM environment, while the grid it returns to rebuilds
       several viewers of its own. Both pages' footprints counted against one
       page-wide iOS Safari budget is what tips it over.

       Deliberately NOT replaceModelSlideWithIcon: that's the permanent
       fallback for a viewer that genuinely failed, and it rewrites the slide
       so no rebuild is possible afterwards. This leaves the slide alone, so
       coming back from the cache restores the real thing.
       --------------------------------------------------------------------- */
    function releaseModelViewer() {
      hideScanBand();
      if (!state.modelHandle) return;
      state.modelHandle.dispose();
      if (state.modelHandle.el.parentNode) {
        state.modelHandle.el.parentNode.removeChild(state.modelHandle.el);
      }
      state.modelHandle = null;
    }

    function restoreModelViewer() {
      attachViewer();
    }

    if (modelSlide) {
      window.addEventListener("pagehide", releaseModelViewer);
      window.addEventListener("pageshow", function (e) {
        if (e.persisted) restoreModelViewer();
      });

      // The Modify sheet (js/modify-modal.js, opened from a row of the
      // selection bar's drawer) builds a viewer of its own — a second WebGL
      // context, a second PMREM environment and a second decode of a model
      // that can be over a hundred MB — while this page's carousel viewer
      // sits behind the sheet's backdrop, drawing nothing anyone is looking
      // at. The page's own model goes back to its poster for as long as the
      // sheet is up, and the real viewer is rebuilt once the sheet's own has
      // been freed ("emjive:modify-close" is dispatched after that, see
      // cleanup() there). Same swap as the back/forward-cache path above.
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
    }

    ((product.assets && product.assets.photos) || []).forEach(function (photo) {
      var slide = buildPhotoSlide(photo, product.name);
      photoSlides.push(slide);
      track.appendChild(slide);
      slideSources.push(photo.src);
    });

    carouselFrame.classList.toggle("product-carousel--single", slideSources.length <= 1);
    // Reserves extra room below --tile for the photo slides' caption
    // band — see css/style.css — rather than shrinking the photo slide
    // itself to fit a caption inside it, which would letterbox every
    // photo and break the flush, edge-to-edge tiling against its
    // neighbors in the filmstrip.
    carouselFrame.classList.toggle(
      "product-carousel--has-photos",
      ((product.assets && product.assets.photos) || []).length > 0
    );
    // Bounds aren't synced here — #productDetailContent is still [hidden]
    // at this point (render() calls this before unhiding it), so every
    // element would measure as zero-size. render() does the initial
    // carousel.sync(true) itself, right after unhiding.

    return {
      posterReady: posterReady,
      photoSlides: photoSlides,
      mountViewer: mountViewer,
      viewerSettled: viewerSettled
    };
  }

  // What stands in for the model until its viewer is built: the viewer's own
  // poster (fallback-img, the model's default-orbit capture, so it lines up
  // with the live canvas's first frame), else the metal's icon.
  function posterSrcFor(product, metal) {
    var assets = product.assets || {};
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

  // Real product photos (product.assets.photos), unlike the model/icon
  // slide, carry their own "on display:" legend — which finish/context
  // that specific shot is showing. The <img> itself stays a plain
  // full-bleed slide child (js/carousel.js's imageSlide), so it still fills
  // --tile edge-to-edge and tiles flush against its neighbors; the caption
  // is a separately-positioned sibling anchored to the slide's own
  // bottom-right corner in the extra band css/style.css's
  // .product-carousel--has-photos reserves below --tile — a real child of
  // product-carousel__slide either way, so it rides the carousel
  // drag/transform as one unit with its photo. Falls back to an em-dash for
  // an empty description, same convention renderSpecs's rows use for a
  // missing value.
  function buildPhotoSlide(photo, alt) {
    // Deferred: the photos are off screen, so they start downloading only
    // after the page's first paint (render() → loadRemainingAssets).
    var slide = window.EmjiveCarousel.imageSlide(photo.src, alt, { deferred: true, loaderHost: carouselFrameEl || carouselEl });
    slide.classList.add("product-carousel__slide--photo");
    slide.appendChild(el("p", "product-carousel__caption", "On display: " + (photo.description || "—")));
    return slide;
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
    if (metal === state.selectedMetal) return;
    state.selectedMetal = metal;
    renderLabelType(product);
    renderLabelPrice(product);
    // The text and thumbnail under the label bar's invert band would show
    // their old value a moment longer in Safari otherwise.
    window.EmjiveOrderRows.resampleBand(document.querySelector(".product-detail__label-bar"));
    // The label thumbnail (and, for model-less products, the carousel's
    // fallback slide) are static images — each needs its own explicit swap
    // to the new metal's icon.
    renderLabelThumb(product);
    if (state.iconFallbackImg) {
      state.iconFallbackImg.src = (product.assets && product.assets.icons && product.assets.icons[metal]) || "";
    }
    // The model's poster, if the viewer isn't in yet: the viewer is built for
    // whichever metal is selected when it arrives.
    if (state.posterImg) state.posterImg.src = posterSrcFor(product, metal);
    renderSpecs(product);
    renderPrinting();
    tintAfterPaint();
  }

  /* ---- specs: characteristics (metal-dependent) -------------------------- */

  // The weight and the cost breakdown for one metal, from the model's measured
  // volume (product.geometry, written by scripts/measure-models.js) and that
  // metal's constants in data/series.json's "metal-costs". Raw materials are
  // the metal bought, which is more than the finished piece weighs: the
  // process loses a share of it (lost-wax casting, binder jetting), so it is
  // weight x (1 + loss margin) x price per gram. Manufacturing is whatever
  // is left of the production cost (volume x production cost per cm3).
  // The weight is the finished piece's; it isn't shown, only what it costs.
  // Returns null if either input is missing.
  function computeCosts(volumeCm3, costs) {
    if (!(volumeCm3 > 0) || !costs) return null;
    var weight = volumeCm3 * costs["density-g-cm3"];
    var production = volumeCm3 * costs["production-per-cm3"];
    var raw = weight * (1 + costs["loss-margin"]) * costs["price-per-g"];
    return { raw: raw, manufacturing: production - raw, production: production };
  }

  function formatEuros(amount) {
    return "€ " + amount.toFixed(2);
  }

  // The figures that follow the chosen size: the dimensions, in
  // centimetres (drawn on the model itself as brackets when the viewer can,
  // .has-brackets — their row stays here, visually hidden, for screen
  // readers) and the cost diagram. A piece scaled
  // by a factor weighs and costs that factor cubed (the model is scaled the
  // same on every axis); the diagram's bars are shares of that cost — the raw
  // materials', the manufacturing's — so they always fill their column, and
  // move with the metal only.
  function renderSpecs(product) {
    var geometry = product.geometry || {};
    var dims = geometry["dimensions-mm"];
    var f = state.sizeFactor;
    var volume = geometry["volume-cm3"] * f * f * f;
    var costs = computeCosts(volume, state.metalCosts[state.selectedMetal]);
    var dl = document.getElementById("productSpecs");
    dl.innerHTML = "";
    var haveDims = Array.isArray(dims) && dims.length === 3 && dims.every(function (d) { return typeof d === "number" && isFinite(d); });
    appendSpec(dl, "dimensions", "Dimensions", haveDims ?
      dims.map(function (d) { return (Math.round(d * f * 10 + 1e-6) / 100).toFixed(2); }).join(" × ") + " cm" : "n/a");

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
  // fades in. This is the rest: the model, and the carousel holding it.
  //
  // Presentation -> specs is the one with the model in it, and its blank is
  // the model's own change. A full-width inversion band (the hero's frontier
  // band) travels the whole height of the screen over the transition, from
  // under the page to over it, and the model's metal -> grey sweep is
  // that band's passage across it: it starts when the band reaches the
  // model's foot and ends when it leaves its head, the cut under the band
  // all the way. So the first fade ends (--t0) as the band reaches the
  // model, the second begins (--t1) as it leaves it, and the model's fit
  // (the shrink that makes room for its dimensions, and the size scale)
  // follows from there on. The three are worked out from where the model is
  // on screen, so they hold on any screen.
  function wireStages() {
    var stageEl = document.getElementById("productStage");
    if (!stageEl) return;
    if (!window.EmjiveProductStages) return;
    window.EmjiveProductStages.mount(stageEl, { onChange: onStageChange });
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
    state.toSpecs = stage.toSpecs;
    state.along = stage.along || 0;
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
    // Presentation's things start going with the first pixel of scrolling, and
    // slide out to the sides of a model that has to be centred. Until they are
    // well on their way (HOLD_AT) the strip stays where the visitor paged it
    // to, whatever the page does; from then it is taken home, if it was paged
    // on, and held.
    if ((stage.toSpecs > 0 || stage.leave > 0) && !state.sizeSeeded && state.seedSize) state.seedSize();
    var hold = stage.toSpecs > 0 || stage.leave >= HOLD_AT;
    if (hold === state.carouselHeld) return;
    state.carouselHeld = hold;
    // Locked first: a strip taken home while held leaves the picker where
    // paging it put it (js/carousel.js).
    carousel.setLocked(hold);
    if (hold) carousel.goHome();
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

  // The height of the two bars at the bottom, in pixels: what a stage's
  // stretch of browsing takes the show up by (css/style.css --bars-h), read off
  // a probe that is as tall.
  var barsProbe = null;
  function barsPx() {
    if (!barsProbe) {
      barsProbe = el("div", null);
      barsProbe.setAttribute("aria-hidden", "true");
      barsProbe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--room-0)";
      document.getElementById("productStage").appendChild(barsProbe);
    }
    return barsProbe.offsetHeight;
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
    var slide = document.querySelector(".product-carousel__slide--model");
    if (!slide) return null;
    var r = slide.getBoundingClientRect();
    var mid = r.top + r.height / 2;
    return { top: mid - r.height * 0.33, bottom: mid + r.height * 0.33 };
  }

  // How far up the model stands (in pixels, from where it stands at rest) when
  // the page is `w` of the way through the first stretch and the transition,
  // and its place in specs is `place` up. One path, from the first pixel of
  // scrolling: it goes up with the show while the first stretch browses
  // (`room` by its end), and then goes on to its place, at the same speed at
  // first and slowing gently to a stop there — so that the show coming back
  // down to rest as specs arrives never takes the model with it. (The
  // browsing that follows starts before the transition ends,
  // js/product-stages.js, and takes it up from there.)
  function modelRise(w, place, room, ratio) {
    var wh = ratio / (ratio + 1);
    var x = clamp(w, 0, 1);
    if (x <= wh) return wh > 0 ? room * (x / wh) : 0;
    var u = (x - wh) / (1 - wh);
    var dist = place - room;
    if (dist > 1) return room + dist * (1 - Math.pow(1 - u, clamp(room / (ratio * dist), 1.5, 6)));
    return room + dist * u * u * (3 - 2 * u);
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
    var stageEl = document.getElementById("productStage");
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
    var room = barsPx();
    // The model's place in specs: its middle on the first quarter of the
    // screen's height — or just under the title bar, if the model is so tall
    // that its head would run under it — and then SPECS_GAP_REM lower, the
    // gap before the model. How far up that is from where the
    // model stands at rest (`place`): the slide's middle, less the lift and
    // the browsing it is under now.
    var slide = document.querySelector(".product-carousel__slide--model");
    var place = 0;
    if (slide && !state.flow) {
      var box = slide.getBoundingClientRect();
      var titleBar = document.querySelector(".product-detail__label-bar");
      // (The model, with its dimensions, stands about this tall: the share
      // of the tile it fills at the size it is fitted to.)
      var half = SPECS_HALF_HEIGHT * box.height;
      var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var middle = Math.max(SPECS_ANCHOR * screenHeight(),titleBar ? titleBar.getBoundingClientRect().bottom + half + 8 : 0) + SPECS_GAP_REM * rem;
      place = Math.max(0, box.top + box.height / 2 + state.lift + browsed - middle);
    }
    var path = modelRise(state.along, place, room, ratio);
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
        return modelRise((ratio + invEase(x)) / (ratio + 1), place, room, ratio);
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
    // The picker changes place (beside the model / under it) in the middle
    // of the blank, where nothing of it shows.
    stageEl.classList.toggle("is-specs-layout", !state.flow && t > (t0 + t1) / 2);
    state.fit = clamp((t - t1) / (1 - t1), 0, 1);
    // What the carousel is lifted by, on top of the show: the path less what
    // the show does by itself — it goes up for the first stretch's browsing
    // and comes back down as specs arrives (css/style.css --browse-px).
    var wh = ratio / (ratio + 1);
    var browsing = room * (wh > 0 ? clamp(state.along / wh, 0, 1) : 1) * (1 - state.fit);
    state.lift = path - browsing;
    stageEl.style.setProperty("--lift", state.lift.toFixed(1) + "px");
    stageEl.style.setProperty("--t0", t0.toFixed(4));
    stageEl.style.setProperty("--t1", t1.toFixed(4));
    if (band) band.classList.toggle("is-on", barOn);
    fitBrowse(stageEl);
    applyStageToViewer();
  }

  // The specs stage's column (size, picker, printing technology, costs, shipping,
  // returns) is tall, and starts under where the model stands: its end can be
  // under the bars at the bottom of the screen, out of reach (the page doesn't
  // scroll there). So the stage's stretch of scrolling takes the show up by
  // what it takes for the end to clear the bars by BROWSE_CLEAR_REM (a blank
  // four separation gaps tall) — never less than the two bars' own height
  // (css/style.css --browse-room). Measured as the column would stand
  // unshifted, so it holds still once it has moved.
  var BROWSE_CLEAR_REM = 16;
  var browseRoom = 0;
  function fitBrowse(stageEl) {
    var room = 0;
    var blocks = stageEl.querySelectorAll(".product-logistics__block");
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
  // The gap before the model in specs, on top of where it would stand: 8rem.
  var SPECS_GAP_REM = 8;
  var SIZE_BASE_MM = 62;
  var SIZE_MIN_MM = 40;
  var SIZE_MAX_MM = 70;
  function setModelSize(raw) {
    var mm = parseFloat(raw);
    var given = window.EmjiveSelection.isValidSize(raw) && isFinite(mm);
    state.sizeFactor = given ? clamp(mm, SIZE_MIN_MM, SIZE_MAX_MM) / SIZE_BASE_MM : 1;
    state.sizeText = given ? String(+mm.toFixed(2)) : "";
    if (state.modelHandle) state.modelHandle.setSize(state.sizeFactor);
    if (state.product) {
      renderSpecs(state.product);
      renderLabelType(state.product);
    }
  }

  // .has-brackets: the model shows its own dimensions, so the text row
  // among the specs is left to screen readers (css/style.css).
  function syncBracketsFlag() {
    var stageEl = document.getElementById("productStage");
    var live = !!(state.modelHandle && state.modelHandle.hasBrackets && state.modelHandle.hasBrackets());
    if (stageEl) stageEl.classList.toggle("has-brackets", live);
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

    // The specs stage's own size: a slider from 40 to 70 and, right of it, a
    // field to type an exact size in (any orderable size, in or out of the
    // slider's range). The two follow each other. What the field holds is what
    // the sheet opens with; it never works the other way round — the sheet
    // doesn't write back — so a visitor who never gave a size in specs keeps
    // getting an empty sheet, an earlier Add included. Same filtering as the
    // sheet's field; Enter opens the sheet with it. The slider's range is in
    // millimetres, the one unit with a size run today (a category with no
    // unit never gets this row at all).
    var specsSize = document.getElementById("productSizeInput");
    var specsRange = document.getElementById("productSizeRange");
    document.getElementById("productSizeUnit").textContent = unit;
    document.getElementById("productSize").hidden = false;
    // Until a size has been given the thumb rests mid-way, dimmed: there is
    // no size yet, only somewhere to start from.
    function syncRangeFromField() {
      var size = parseFloat(specsSize.value);
      var given = window.EmjiveSelection.isValidSize(specsSize.value) && isFinite(size);
      specsRange.classList.toggle("is-unset", !given);
      if (given) specsRange.value = String(Math.max(+specsRange.min, Math.min(+specsRange.max, size)));
    }
    specsRange.classList.add("is-unset");
    // The specs stage's "Find my size", under the slider and the field.
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
      syncRangeFromField();
      setModelSize(specsSize.value);
    };
    specsRange.addEventListener("input", function () {
      // Every tenth of a millimetre between the ends.
      specsSize.value = Number(specsRange.value).toFixed(1);
      specsRange.classList.remove("is-unset");
      setModelSize(specsSize.value);
    });
    specsSize.addEventListener("input", function () {
      var cleaned = window.EmjiveSelection.sanitizeSizeInput(specsSize.value);
      if (cleaned !== specsSize.value) specsSize.value = cleaned;
      syncRangeFromField();
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
      var details = (product["per-metal-specs"] && product["per-metal-specs"][state.selectedMetal]) || {};
      window.EmjiveSelection.addItem({
        // Which series this came from — product ids are only unique within
        // one, so the id alone no longer identifies a piece.
        series: state.seriesSlug,
        productId: product.id,
        name: product.name,
        category: product.category,
        metal: state.selectedMetal,
        // Stored in its one canonical form ("62.5" -> "62.50", "62." -> "62").
        size: window.EmjiveSelection.normalizeSize(customInput.value),
        price: details.price || 0,
        image: (product.assets && product.assets.icons && product.assets.icons[state.selectedMetal]) || ""
      });
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
