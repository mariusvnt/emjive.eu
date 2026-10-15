/* ==========================================================================
   em·ji·ve — the homepage gallery (index.html only)

   Two views of the active series' products, one at a time — data-gallery-view
   on <html>, decided in the <head> by js/scroll-memory.js:
     stack  the camera pulls back from the x-ray hand to the products on a
            circle round its wrist, a plate the visitor turns to bring one to
            the top (js/gallery-stack.js, mounted from here);
     grid   a table, a product a row, built here: no 3D, each row's picture
            a strip of slides (the model's own view, then the photos) swiped
            sideways; a tap goes to the product's page.
   And the hero: data-hero="play" plays the reveal first, "skip" lands on the
   gallery at rest. It plays once per device — this file sets the seen flag
   once it has played out.

   Owns: loading the products, the grid, the control (the view switch) and the
   veil the switch crosses through, the filter's effect on both
   views (js/main.js owns the filter row and calls setFilter()), and telling
   js/scroll-memory.js what the visitor changes, so Back finds it again.

   window.EmjiveGallery = { setFilter(cats, onShowAll) -> counts | null }
   ========================================================================== */

(function () {
  "use strict";

  var grid = document.getElementById("productGrid");
  var stage = document.getElementById("galleryStage");
  var section = document.getElementById("products");
  if (!grid || !stage || !section || !window.EmjiveSeries) return;

  var html = document.documentElement;
  var viewToggle = document.getElementById("galleryViewToggle");

  // The same two keys js/scroll-memory.js reads in the <head>.
  var SEEN_KEY = "emjive_hero_seen";
  var VIEW_KEY = "emjive_gallery_view";
  // The veil's fade (--fade-standard), plus a margin for its fallback timer.
  var VEIL_MS = 300;
  // How long the arrival loader waits on the grid's first tiles at most.
  var FIRST_TILES_MS = 4000;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function writeLocal(name, value) {
    try { window.localStorage.setItem(name, value); } catch (e) { /* blocked: the default comes back next visit */ }
  }

  function view() {
    return html.getAttribute("data-gallery-view") === "grid" ? "grid" : "stack";
  }

  function heroMode() {
    return html.getAttribute("data-hero") === "skip" ? "skip" : "play";
  }

  function remember(patch) {
    var memory = window.EmjiveScrollMemory;
    if (memory && memory.remember) memory.remember(patch);
  }

  function hero() {
    return window.EmjiveSeriesHero && window.EmjiveSeriesHero.setMode ? window.EmjiveSeriesHero : null;
  }

  // Instant, whatever html { scroll-behavior: smooth } says — the page jumps
  // under the veil, where nobody sees it travel.
  function jumpTo(top) {
    var previous = html.style.scrollBehavior;
    html.style.scrollBehavior = "auto";
    try {
      window.scrollTo({ top: top, left: 0, behavior: "instant" });
    } catch (e) {
      window.scrollTo(0, top);
    }
    if (previous) html.style.scrollBehavior = previous;
    else html.style.removeProperty("scroll-behavior");
  }

  var state = {
    products: null,
    slug: null,
    tiles: [],
    stack: null,
    cats: [],
    onShowAll: null,
    emptyMsg: null,
    // Whether the grid has a Category column: the series has more than one.
    withCategory: false,
    // The entrance's progress, as the hero last published it.
    stage: null
  };

  /* ---- the veil -------------------------------------------------------------
     A switch of view changes the page wholesale — its height, what's in it,
     where it's scrolled — so it crosses through the page background: it fades
     in, `change` runs, it fades back out. */
  var veil = el("div", "gallery-veil");
  veil.setAttribute("aria-hidden", "true");
  document.body.appendChild(veil);
  var veilToken = 0;

  function throughVeil(change) {
    var token = ++veilToken;
    var done = false;
    function swap() {
      if (done || token !== veilToken) return;
      done = true;
      veil.removeEventListener("transitionend", onEnd);
      change();
      // Two frames: the page's new shape is laid out and painted under the
      // veil before it lifts.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (token === veilToken) veil.classList.remove("is-veiled");
        });
      });
    }
    function onEnd(e) {
      if (e.target === veil && e.propertyName === "opacity") swap();
    }
    veil.addEventListener("transitionend", onEnd);
    veil.classList.add("is-veiled");
    setTimeout(swap, VEIL_MS + 50);
  }

  /* ---- the control ----------------------------------------------------------- */

  function syncControls() {
    // What it shows (an icon and a word) is css/style.css's, keyed on the
    // same attribute; this is its name.
    if (!viewToggle) return;
    viewToggle.setAttribute("aria-label", view() === "grid" ? "switch to wheel" : "switch to list");
    // In the stack view it comes only once the visitor has scrolled down to
    // the wheel (the entrance as good as done: from the point the wheel counts
    // as landed, js/gallery-stack.js LAND_AT); the grid's button is always
    // there.
    viewToggle.classList.toggle("is-ready", view() === "grid" || (state.stage !== null && state.stage >= 0.9));
  }

  // Either view lands at rest: the hero has had its turn (a visitor leaving
  // it for the other view has had enough of it) — the grid at the top of the
  // page, the stack at the end of the hero, which is still there to scroll
  // back up into.
  function switchView(next) {
    if (next === view()) return;
    throughVeil(function () {
      html.setAttribute("data-gallery-view", next);
      html.setAttribute("data-hero", "skip");
      writeLocal(VIEW_KEY, next);
      writeLocal(SEEN_KEY, "1");
      remember({ view: next, hero: "skip" });
      if (state.stack) state.stack.setActive(next === "stack");
      // The stack's page is tall again by now (the attributes above).
      jumpTo(next === "stack" ? html.scrollHeight : 0);
      if (hero()) hero().setMode();
      placeEmptyMessage();
      syncControls();
    });
  }

  if (viewToggle) {
    viewToggle.addEventListener("click", function () {
      switchView(view() === "grid" ? "stack" : "grid");
    });
  }

  // The entrance's progress (series/<slug>/hero.js). Its end is where the
  // hero has been seen: from then on this device lands on the gallery.
  if (window.EmjiveHero) {
    window.EmjiveHero.onStage(function (progress) {
      state.stage = progress;
      syncControls();
      if (progress === 1 && heroMode() === "play") writeLocal(SEEN_KEY, "1");
    });
  }
  syncControls();

  /* ---- the grid ---------------------------------------------------------------
     A header row, then a row (a tile) a product: its index, its pictures in a
     strip (the model's own default view — the fallback-img the 3D viewer
     starts from elsewhere, or the icon for a product with no model — then the
     photos), dots under them when there's more than one, and its facts.
     Swiped natively (overflow + scroll snap): a swipe that scrolls never
     becomes a click, so a click anywhere on the tile is a tap meant for it. */
  function slide(src, alt, modifier) {
    var img = el("img", "grid-tile__slide " + modifier);
    img.src = src;
    img.alt = alt;
    img.width = 512;
    img.height = 512;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    return img;
  }

  function wireDots(slides, dots) {
    var buttons = Array.prototype.slice.call(dots.children);
    var current = -1;
    function sync() {
      var width = slides.clientWidth || 1;
      var index = Math.max(0, Math.min(buttons.length - 1, Math.round(slides.scrollLeft / width)));
      if (index === current) return;
      if (buttons[current]) buttons[current].classList.remove("is-current");
      buttons[index].classList.add("is-current");
      current = index;
    }
    slides.addEventListener("scroll", sync, { passive: true });
    buttons.forEach(function (button, i) {
      button.addEventListener("click", function (e) {
        // A dot pages the strip; it isn't a tap on the tile.
        e.stopPropagation();
        slides.scrollTo({ left: i * slides.clientWidth, behavior: "smooth" });
      });
    });
    sync();
  }

  // A tile is a link to the product's own page.
  function openProduct(product) {
    window.location.href = window.EmjiveSeries.productHref(product, state.slug);
  }

  // The columns of a row's facts, in order: Id (the name — also the row's
  // button for a keyboard), Category (only where the series has more than
  // one), Size (the range it is made in) and Price (what it starts at, over
  // all the metals: the price follows the size, js/selection.js priceAt).
  var FACTS = [
    { key: "name", label: "Id" },
    { key: "category", label: "Category" },
    { key: "size", label: "Size" },
    { key: "price", label: "Price" }
  ];

  function factKeys() {
    return FACTS.filter(function (fact) { return fact.key !== "category" || state.withCategory; });
  }

  // The header row: the same cells as a product's row, the labels in them,
  // so it lines up with the rows at every width (css/style.css). Only seen —
  // each row's facts carry their own labels for a screen reader.
  function buildHead() {
    var head = el("div", "grid-tile grid-tile--head");
    head.setAttribute("aria-hidden", "true");
    head.appendChild(el("span", "grid-tile__index", "No."));
    var body = el("div", "grid-tile__body");
    var facts = el("div", "grid-tile__facts");
    factKeys().forEach(function (fact) {
      facts.appendChild(el("span", "grid-tile__fact grid-tile__fact--" + fact.key, fact.label));
    });
    body.appendChild(facts);
    head.appendChild(body);
    return head;
  }

  function factValue(product, key) {
    var sel = window.EmjiveSelection;
    var name = product.name || "";
    if (key === "name") {
      var dd = el("dd");
      var open = el("button", "grid-tile__name", name);
      open.type = "button";
      open.setAttribute("aria-label", "Open " + name + (product.category ? ", " + product.category : ""));
      dd.appendChild(open);
      return dd;
    }
    if (key === "category") return el("dd", "", (product.category || "").toLowerCase());
    if (key === "size") {
      var range = sel.sizeRange(product);
      var unit = window.EmjiveSeries.categoryInfo(product.category).unit;
      return el("dd", "", range.min + " – " + range.max + (unit ? " " + unit : ""));
    }
    return el("dd", "", sel.formatPriceFrom(sel.priceFrom(product)));
  }

  function buildFacts(product) {
    var list = el("dl", "grid-tile__facts");
    factKeys().forEach(function (fact) {
      var row = el("div", "grid-tile__fact grid-tile__fact--" + fact.key);
      row.appendChild(el("dt", "visually-hidden", fact.label));
      row.appendChild(factValue(product, fact.key));
      list.appendChild(row);
    });
    return list;
  }

  // The index is the product's place in the series (01, 02 …): a catalogue
  // number, kept as the filter hides rows around it.
  function buildTile(product, index) {
    var tile = el("article", "grid-tile");
    var number = index + 1;
    var indexCell = el("span", "grid-tile__index", (number < 10 ? "0" : "") + number);
    indexCell.setAttribute("aria-hidden", "true");
    tile.appendChild(indexCell);
    var frame = el("div", "grid-tile__frame");
    var slides = el("div", "grid-tile__slides");
    var assets = product.assets || {};
    var metal = product["default-metal"];
    var name = product.name || "";
    var first = (assets.model && assets["fallback-img"] && assets["fallback-img"][metal]) ||
      (assets.icons && assets.icons[metal]);
    var firstImg = null;
    if (first) {
      firstImg = slide(first, name, "grid-tile__slide--model");
      slides.appendChild(firstImg);
    }
    (assets.photos || []).forEach(function (photo) {
      slides.appendChild(slide(photo.src, photo.description || name, "grid-tile__slide--photo"));
    });
    frame.appendChild(slides);

    if (slides.children.length > 1) {
      slides.tabIndex = 0;
      slides.setAttribute("role", "group");
      slides.setAttribute("aria-roledescription", "carousel");
      slides.setAttribute("aria-label", name + " pictures");
      var dots = el("span", "grid-tile__dots");
      dots.setAttribute("aria-hidden", "true");
      for (var i = 0; i < slides.children.length; i++) {
        var dot = el("button", "grid-tile__dot");
        dot.type = "button";
        dot.tabIndex = -1;
        dots.appendChild(dot);
      }
      frame.appendChild(dots);
      wireDots(slides, dots);
    }
    // The body: the picture, then beside it the item's facts, a column each
    // (css/style.css).
    var body = el("div", "grid-tile__body");
    body.appendChild(frame);
    body.appendChild(buildFacts(product));
    tile.appendChild(body);

    tile.addEventListener("click", function () { openProduct(product); });

    // The model's picture hides behind a loader until it has loaded, as the
    // old cards' did (js/loader.js).
    if (firstImg && window.EmjiveLoader) {
      window.EmjiveLoader.cover(frame, window.EmjiveLoader.imageReady(firstImg));
    }
    return { product: product, el: tile, firstImg: firstImg };
  }

  function renderGrid(products) {
    grid.innerHTML = "";
    state.withCategory = Object.keys(counts()).length > 1;
    grid.classList.toggle("has-category", state.withCategory);
    if (products.length) grid.appendChild(buildHead());
    state.tiles = products.map(function (product, index) {
      var tile = buildTile(product, index);
      grid.appendChild(tile.el);
      return tile;
    });
  }

  // A grid landing straight on the page (no hero first): its first tiles are
  // the first paint, so they are what the arrival loader waits for.
  function releaseLoaderOnTiles() {
    if (!window.EmjiveLoader) return;
    var top = window.innerHeight || 0;
    var waits = state.tiles.filter(function (tile) {
      if (!tile.firstImg || tile.el.hidden) return false;
      return tile.el.getBoundingClientRect().top < top;
    }).map(function (tile) { return window.EmjiveLoader.imageReady(tile.firstImg); });
    Promise.race([
      Promise.all(waits),
      new Promise(function (resolve) { setTimeout(resolve, FIRST_TILES_MS); })
    ]).then(function () { window.EmjiveLoader.pageReady(); });
  }

  /* ---- filtering ---------------------------------------------------------------
     js/main.js's filter row decides the categories; both views hide what
     doesn't match without rebuilding anything. Kept until the products are in
     when it comes first (a ?cat= in the address). */
  function counts() {
    var out = {};
    (state.products || []).forEach(function (product) {
      out[product.category] = (out[product.category] || 0) + 1;
    });
    return out;
  }

  function matches(product) {
    return !state.cats.length || state.cats.indexOf(product.category) !== -1;
  }

  // The empty filter's message, in whichever view is showing.
  function placeEmptyMessage() {
    if (!state.emptyMsg) return;
    var host = view() === "grid" ? grid : stage;
    if (state.emptyMsg.parentNode !== host) host.appendChild(state.emptyMsg);
  }

  function showEmpty(empty) {
    if (!empty) {
      if (state.emptyMsg) state.emptyMsg.hidden = true;
      return;
    }
    var text = "Nothing in " + state.cats.map(function (c) { return "." + c; }).join(" or ") + " in this series yet. ";
    if (!state.emptyMsg) {
      // Reuses .product-grid__loading as the empty state — it already spans
      // the full grid row, centered and muted.
      state.emptyMsg = el("p", "product-grid__loading");
      state.emptyMsg.setAttribute("role", "status");
      state.emptyMsg.appendChild(document.createTextNode(text));
      var showAll = el("button", "btn", "Show all");
      showAll.type = "button";
      showAll.addEventListener("click", function () {
        if (state.onShowAll) state.onShowAll();
      });
      state.emptyMsg.appendChild(showAll);
    } else {
      state.emptyMsg.firstChild.nodeValue = text;
    }
    state.emptyMsg.hidden = false;
    placeEmptyMessage();
  }

  function applyFilter() {
    var visible = 0;
    state.tiles.forEach(function (tile) {
      tile.el.hidden = !matches(tile.product);
      if (!tile.el.hidden) visible++;
    });
    if (state.stack) state.stack.setFilter(state.products.filter(matches).map(function (p) { return p.id; }));
    showEmpty(state.products.length > 0 && visible === 0);
  }

  /* ---- loading ---------------------------------------------------------------- */

  function showLoadFailure() {
    grid.innerHTML = "";
    // Where the visitor is looking: when the series index itself failed, no
    // hero will ever arrive, so its (empty) slot — the whole first screen —
    // carries the message. If the hero did load and only the products
    // failed, the message goes where the products would have been.
    var heroSlot = document.getElementById("seriesHero");
    var host;
    if (heroSlot && !heroSlot.children.length && view() === "stack") {
      host = heroSlot;
      host.classList.add("page-message--hero");
    } else {
      host = el("div", "page-message--grid");
      if (view() === "grid") grid.appendChild(host);
      else {
        host.classList.add("product-grid__loading");
        stage.appendChild(host);
      }
    }
    window.EmjiveMessage.show(host,
      "The gallery couldn't be loaded. Check your connection and try again.",
      { label: "Reload" }, "alert");
  }

  function signalContentReady() {
    if (window.EmjiveScrollMemory) window.EmjiveScrollMemory.contentReady();
  }

  window.EmjiveSeries.ready
    .then(function (ctx) {
      state.slug = ctx.slug;
      return window.EmjiveSeries.loadProducts(ctx.slug);
    })
    .then(function (products) {
      state.products = products;
      if (!products.length) {
        grid.appendChild(el("p", "product-grid__loading",
          "No products yet — add some to this series' products.json (see data/series.json)"));
      }
      renderGrid(products);
      if (window.EmjiveGalleryStack) {
        state.stack = window.EmjiveGalleryStack.mount(stage, {
          products: products,
          slug: state.slug,
          active: view() === "stack"
        });
      }
      applyFilter();
      window.dispatchEvent(new CustomEvent("emjive:gallery-filtered", { detail: { counts: counts() } }));
      if (view() === "grid" && heroMode() === "skip") releaseLoaderOnTiles();
      // The gallery is the last thing that changes this page's height, so
      // this is the signal js/scroll-memory.js is waiting on to finish
      // restoring a back-navigation's scroll position.
      signalContentReady();
    })
    .catch(function (err) {
      console.error("Could not load the gallery:", err);
      showLoadFailure();
      if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
      // Still signalled: a failed fetch means the height this page is ever
      // going to have is the height it has now.
      signalContentReady();
    });

  window.EmjiveGallery = {
    // cats: the categories to show ([] for all). onShowAll: what the empty
    // filter's "Show all" does (the filter row's own reset). Returns the
    // number of products per category, or null before the products are in
    // — they're reported then through "emjive:gallery-filtered".
    setFilter: function (cats, onShowAll) {
      state.cats = (cats || []).slice();
      if (onShowAll) state.onShowAll = onShowAll;
      if (!state.products) return null;
      applyFilter();
      return counts();
    }
  };
})();
