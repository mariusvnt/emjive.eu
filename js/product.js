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
    iconFallbackImg: null
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function getIdFromQuery() {
    return new URLSearchParams(window.location.search).get("id");
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
      href: (slug ? window.EmjiveSeries.mainHref(slug) : "index.html") + "#products"
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

  // Product ids are only unique WITHIN a series now, so a bare ?id= (an old
  // bookmark, or a link built before this refactor) can't identify a product
  // on its own. Resolution order: the active series first — which is the
  // featured one unless ?series= says otherwise — then every other series in
  // index order. The scan costs nothing in the normal case, since step 1
  // hits, and it's bounded by the number of series. If two series ever share
  // an id and the URL carries no ?series=, the active one wins, which is the
  // friendliest resolution available.
  function findProduct(slug, id) {
    return window.EmjiveSeries.loadProducts(slug).then(function (products) {
      var product = products.find(function (p) { return p.id === id; });
      if (product) return { product: product, slug: slug };

      var others = window.EmjiveSeries.all()
        .map(function (s) { return s.slug; })
        .filter(function (s) { return s !== slug; });

      return others.reduce(function (chain, otherSlug) {
        return chain.then(function (found) {
          if (found) return found;
          return window.EmjiveSeries.loadProducts(otherSlug).then(function (list) {
            var hit = list.find(function (p) { return p.id === id; });
            return hit ? { product: hit, slug: otherSlug } : null;
          });
        });
      }, Promise.resolve(null));
    });
  }

  // How long the page will hold its first render for the 3D viewer chunk
  // before building the carousel without it (the icon slide).
  var VIEWER_WAIT_MS = 8000;

  // The viewer is a lazy chunk (js/viewer-entry.js, started eagerly on this
  // page), usually already in by the time the product data is. The carousel
  // is built once, so it waits for the chunk rather than settling for the icon
  // when the chunk is merely a moment behind. Resolves either way — a failed
  // or slow download just means the icon fallback.
  function viewerReady() {
    if (!window.EmjiveLoadViewer) return Promise.resolve();
    return Promise.race([
      window.EmjiveLoadViewer().catch(function () {}),
      new Promise(function (resolve) { setTimeout(resolve, VIEWER_WAIT_MS); })
    ]);
  }

  function init() {
    window.EmjiveSeries.ready
      .then(function (ctx) {
        state.metals = ctx.index.metals || [];
        return findProduct(ctx.slug, getIdFromQuery());
      })
      .then(function (found) {
        if (!found) return showNotFound();
        return viewerReady().then(function () {
          state.product = found.product;
          state.seriesSlug = found.slug;
          render(found.product);
        });
      })
      .catch(showLoadError);
  }

  // This one file serves every product, so the static <head> can't carry a
  // canonical URL (it would collapse all products into one) or a per-product
  // description. Crawlers that run the page's JS and read these get the
  // product's own address — with ?id= (and ?series= when it isn't the
  // featured series), never a stray #hash or an old bare-id link — and its
  // own summary, taken from the data already on the page.
  function updateSearchMetadata(product) {
    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = new URL(window.EmjiveSeries.productHref(product, state.seriesSlug), window.location.href).href;

    var description = document.querySelector('meta[name="description"]');
    if (description && product.description) description.setAttribute("content", product.description);
  }

  function render(product) {
    document.title = (product.name || "Product") + " — em·ji·ve";
    updateSearchMetadata(product);
    state.selectedMetal = product["default-metal"] || state.metals[0] || "steel";

    // Every metal's icon fetched and decoded up front, so a pick swaps the
    // label thumbnail (and a model-less product's slide) at once.
    var icons = (product.assets && product.assets.icons) || {};
    window.EmjiveOrderRows.preload(Object.keys(icons).map(function (m) { return icons[m]; }));

    renderLabel(product);
    renderCarousel(product);
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

    pageReady();
  }

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

    // Static backdrop behind the filmstrip, independent of the metal
    // picker/slides — no product.assets.xray yet (Foramen/Disc today)
    // means no backdrop at all, rather than a broken image.
    var xray = document.getElementById("productCarouselXray");
    var xraySrc = product.assets && product.assets.xray;
    if (xraySrc) {
      xray.src = xraySrc;
      xray.hidden = false;
    } else {
      xray.hidden = true;
    }

    var slideSources = [];
    var modelSlide = null;
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
        onError: replaceModelSlideWithIcon
      });
    }

    state.modelHandle = (product.assets && product.assets.model)
      ? buildModelViewer()
      : null;
    if (state.modelHandle) {
      // Smaller than the photo slides on purpose — leaves generous empty
      // space around the model to drag/swipe the carousel from without
      // that drag landing on the viewer's own TrackballControls instead.
      modelSlide = el("div", "product-carousel__slide product-carousel__slide--model");
      modelSlide.appendChild(state.modelHandle.el);
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
        track.appendChild(iconSlide);
        slideSources.push("icon");
      }
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
      if (!modelSlide) return;
      modelSlide.classList.remove("product-carousel__slide--model");
      modelSlide.innerHTML = "";
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
      if (state.modelHandle || !modelSlide) return;
      // The slide loses this class the moment replaceModelSlideWithIcon
      // takes it over, which is exactly the case that must NOT be rebuilt —
      // the visitor is looking at the icon fallback, and a viewer appended
      // underneath it would be an invisible second context.
      if (!modelSlide.classList.contains("product-carousel__slide--model")) return;
      state.modelHandle = buildModelViewer();
      if (state.modelHandle) modelSlide.appendChild(state.modelHandle.el);
      else replaceModelSlideWithIcon();
    }

    if (state.modelHandle) {
      window.addEventListener("pagehide", releaseModelViewer);
      window.addEventListener("pageshow", function (e) {
        if (e.persisted) restoreModelViewer();
      });
    }

    ((product.assets && product.assets.photos) || []).forEach(function (photo) {
      track.appendChild(buildPhotoSlide(photo, product.name));
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
    var slide = window.EmjiveCarousel.imageSlide(photo.src, alt);
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
