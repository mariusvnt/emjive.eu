/* ==========================================================================
   J&MV — product detail page
   Resolves ?id= against the active series' products.json and renders the label, carousel,
   metal picker, description, characteristics and size/selection flow.
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
  // inside the track change per product.
  var carousel = window.EmjiveCarousel(document.getElementById("productCarousel"));

  var state = {
    product: null,
    metals: [],
    selectedMetal: null,
    modelHandle: null,
    // The model slide's poster <img> while the viewer isn't in yet.
    posterImg: null,
    // The x-ray backdrop's original file (the page shows a version of it
    // chosen for the viewport — see startXray) and whether the viewport
    // watcher is wired.
    xraySrc: "",
    xrayWatching: false,
    iconFallbackImg: null
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
    document.getElementById("productDescription").textContent =
      product.description || "No description yet.";
    wireSelectButton(product);
    wireDisclosures();

    loadingEl.hidden = true;
    contentEl.hidden = false;

    // Carousel geometry (js/carousel.js's getBoundingClientRect calls) can
    // only be measured once #productDetailContent is actually visible —
    // while it's [hidden], every element in it has a zero-size box, which
    // would read as a zero-width tile/carousel and rest at offset 0
    // instead of centering the first tile.
    carousel.sync(true);

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
    document.getElementById("productLabelType").textContent = labelTypeText(product);

    renderLabelThumb(product);
    renderLabelPrice(product);
  }

  // ".category.metal", like the rows' label in the selection lists.
  function labelTypeText(product) {
    return (product.category ? "." + product.category.toLowerCase() : "") +
      (state.selectedMetal ? "." + state.selectedMetal : "");
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
      try {
        return createModelViewer();
      } catch (err) {
        console.error("3D viewer could not start:", err);
        return null;
      }
    }

    function createModelViewer() {
      return window.EmjiveModelViewer(product, state.selectedMetal, {
        hdri: window.EmjiveSeries.hdriPath(state.seriesSlug),
        // The viewer's box is smaller than its slide and has no visible
        // edge, so its loader runs the carousel's full width rather than
        // vanishing at an invisible line (see mount()'s bleed in js/loader.js).
        loaderBleed: true,
        // Fires for an initial load/HDRI failure OR — since
        // three-viewer.js also treats a WebGL context loss as a failure
        // — for a model that HAD already loaded and was on screen: iOS
        // Safari can silently reclaim a GPU context under memory
        // pressure at any time, not just during load. Previously nothing
        // here handled this at all (unlike js/main.js's grid), so either
        // failure just left an empty, permanently blank 3D-viewer slide
        // with no fallback ever shown.
        onError: replaceModelSlideWithIcon,
        onReady: settleViewer
      });
    }

    state.modelHandle = null;
    state.posterImg = null;
    if (product.assets && product.assets.model) {
      // Smaller than the photo slides on purpose — leaves generous empty
      // space around the model to drag/swipe the carousel from without
      // that drag landing on the viewer's own TrackballControls instead.
      // Holds the model's poster until mountViewer() swaps the viewer in.
      modelSlide = el("div", "product-carousel__slide product-carousel__slide--model");
      posterReady = showPoster();
      track.appendChild(modelSlide);
      slideSources.push("model");
    } else {
      var fallbackIconSrc = product.assets && product.assets.icons && product.assets.icons[state.selectedMetal];
      if (fallbackIconSrc) {
        var iconSlide = window.EmjiveCarousel.imageSlide(fallbackIconSrc, product.name);
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
       Same reasoning as js/main.js's releaseAllViewers, from the other end
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
  // an empty description, same convention appendSpecRow's
  // weight/composition rows already use.
  function buildPhotoSlide(photo, alt) {
    // Deferred: the photos are off screen, so they start downloading only
    // after the page's first paint (render() → loadRemainingAssets).
    var slide = window.EmjiveCarousel.imageSlide(photo.src, alt, { deferred: true });
    slide.classList.add("product-carousel__slide--photo");
    slide.appendChild(el("p", "product-carousel__caption", "On display: " + (photo.description || "—")));
    return slide;
  }

  /* ---- 3. metal selection ------------------------------------------------ */

  // The bars, their selected state and the change animation are
  // js/metal-picker.js; this just reacts to a pick.
  function renderMetalOptions(product) {
    window.EmjiveMetalPicker.mount(document.getElementById("productMetals"), {
      metals: state.metals,
      selected: state.selectedMetal,
      onSelect: function (metal) { onMetalSelect(product, metal); }
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
    document.getElementById("productLabelType").textContent = labelTypeText(product);
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
    tintAfterPaint();
  }

  /* ---- 6. characteristics (metal-dependent) ------------------------------ */

  function renderSpecs(product) {
    var details = (product["per-metal-specs"] && product["per-metal-specs"][state.selectedMetal]) || {};
    var dl = document.getElementById("productSpecs");
    dl.innerHTML = "";
    appendSpecRow(dl, "Metal", capitalize(state.selectedMetal));
    appendSpecRow(dl, "Price", window.EmjiveSelection.formatPrice(details.price || 0));
    appendSpecRow(dl, "Weight", details.weight || "—");
    appendSpecRow(dl, "Composition", details.composition || "—");
  }

  function appendSpecRow(dl, label, value) {
    dl.appendChild(el("dt", null, label));
    dl.appendChild(el("dd", null, value));
  }

  /* ---- 5–7. expandable sections ------------------------------------------ */

  // Each section is independent (opening one leaves the others alone). The
  // button's aria-expanded drives the "+" → "-" in CSS; .is-open on its
  // panel drives the reveal.
  function wireDisclosures() {
    document.querySelectorAll(".disclosure__toggle").forEach(function (btn) {
      var panel = document.getElementById(btn.getAttribute("aria-controls"));
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") !== "true";
        // Measured before the panel starts growing: its top doesn't move
        // while it does, so the section's final bottom is known up front.
        var scroll = open ? disclosureScrollPlan(btn, panel) : null;
        btn.setAttribute("aria-expanded", String(open));
        panel.classList.toggle("is-open", open);
        if (scroll) glideScroll(panel, scroll);
      });
    });
  }

  // How far to scroll (and what height the panel will settle at) so the
  // opened section is fully visible between the header and the selection bar:
  // just enough to bring its bottom above the bar — plus the next section's
  // heading, when there's room for it with this section's own heading still
  // in view — or, when it's too tall to fit there at all, its heading right
  // under the header. null = no scroll.
  function disclosureScrollPlan(btn, panel) {
    // .disclosure__inner is clipped to 0 while closed; its one child isn't.
    var content = panel.firstElementChild.firstElementChild;
    var fullHeight = content.offsetHeight + parseFloat(getComputedStyle(content).marginBottom);
    // The topmost of the two stacked bars: the glass Select bar, riding on
    // the selection bar.
    var barTop = window.innerHeight;
    [".product-select-bar", ".selection-bar"].forEach(function (sel) {
      var b = document.querySelector(sel);
      if (b && !b.hidden) barTop = Math.min(barTop, b.getBoundingClientRect().top);
    });
    var headerBottom = document.querySelector(".site-header").getBoundingClientRect().bottom;
    var top = btn.getBoundingClientRect().top;
    var bottom = panel.getBoundingClientRect().top + fullHeight;

    var nextToggle = btn.closest("section").nextElementSibling;
    nextToggle = nextToggle && nextToggle.querySelector(".disclosure__toggle");
    var withNext = bottom + (nextToggle ? nextToggle.offsetHeight : 0);
    var room = barTop - headerBottom;

    var delta;
    if (withNext - top <= room) delta = Math.max(0, withNext - barTop);
    else if (bottom - top <= room) delta = Math.max(0, bottom - barTop);
    else delta = top - headerBottom;
    return delta ? { delta: delta, fullHeight: fullHeight } : null;
  }

  // Scrolls in step with the panel's growth, off its measured height rather
  // than a timer — the page only gets tall enough to scroll that far as the
  // panel opens, so a one-shot scrollTo would be clamped. Same approach as
  // selection-bar.js's animateDrawerScroll.
  var glideRun = 0;

  function glideScroll(panel, plan) {
    var run = ++glideRun;
    var from = window.pageYOffset;
    var until = performance.now() + 450;
    function to(y) { window.scrollTo({ top: y, left: 0, behavior: "instant" }); }
    function cancel() { glideRun++; }
    // The visitor taking over the scroll ends the glide.
    window.addEventListener("wheel", cancel, { passive: true, once: true });
    window.addEventListener("touchstart", cancel, { passive: true, once: true });
    function step() {
      if (run !== glideRun) return;
      var p = Math.min(1, panel.getBoundingClientRect().height / plan.fullHeight);
      if (p >= 1 || performance.now() > until) {
        to(from + plan.delta);
        return;
      }
      to(from + plan.delta * p);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
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
    var guideToggle = document.getElementById("sizeModalGuideToggle");
    var guidePanel = document.getElementById("sizeModalGuide");

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

    guideToggle.addEventListener("click", function () {
      var isOpen = guidePanel.classList.toggle("is-open");
      guideToggle.setAttribute("aria-expanded", String(isOpen));
    });

    function openModal() {
      customInput.value = "";
      guidePanel.classList.remove("is-open");
      guideToggle.setAttribute("aria-expanded", "false");
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
