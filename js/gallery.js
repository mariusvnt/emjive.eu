/* ==========================================================================
   em·ji·ve — the homepage gallery (index.html only)

   Two views of the active series' products, one at a time — data-gallery-view
   on <html>, decided in the <head> by js/scroll-memory.js:
     stack  the camera pulls back from the x-ray hand to the products on a
            circle round its wrist, a plate the visitor turns to bring one to
            the top (js/gallery-stack.js, mounted from here);
     grid   a table, a product a row, built here: no 3D, each row's picture
            a deck of cards (the model's own view, then the photos) dealt
            with a swipe sideways; a tap goes to the product's page.
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
    // as landed, js/gallery-stack.js LAND_AT — of the entrance as the wheel
    // plays it, EmjiveHero.mapStage, its roll back to the hand left out);
    // the grid's button is always there.
    var stage = state.stage === null ? null : window.EmjiveHero.mapStage(state.stage);
    viewToggle.classList.toggle("is-ready", view() === "grid" || (stage !== null && stage >= 0.9));
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
     A header row, then a row (a tile) a product: its index, its pictures as a
     deck of cards seen from an angle (the model's own default view — the
     fallback-img the 3D viewer starts from elsewhere, or the icon for a
     product with no model — on top, then the photos), and its facts. Each
     card behind sits a little
     further right and a little smaller, a sliver of it out past the right
     edge of the one before (css/style.css). A swipe sideways deals the deck —
     the front card goes to the back, or the back one comes to the front — and
     so does a tap on a card behind; a tap on the front card, or anywhere else
     on the tile, opens the product. */
  // How many cards show behind the front one; any more wait under the last.
  var DECK_DEPTH = 3;
  // How far a press travels sideways before it deals a card, in px.
  var DEAL_PX = 24;

  function card(src, alt, modifier) {
    var img = el("img", "grid-tile__card " + modifier);
    img.src = src;
    img.alt = alt;
    img.width = 512;
    img.height = 512;
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    return img;
  }

  // The deck goes round: dealing on from the last card brings the first back
  // to the front. Each card's place in it (0 the front) is --pos, which
  // css/style.css turns into where it sits and how small; the cards past
  // DECK_DEPTH share the last place, under it.
  function wireDeck(frame, deck) {
    var cards = Array.prototype.slice.call(deck.children);
    var count = cards.length;
    var current = 0;
    var press = null;
    var dealt = false;

    function place() {
      cards.forEach(function (c, i) {
        var pos = (i - current + count) % count;
        c.style.setProperty("--pos", Math.min(pos, DECK_DEPTH));
        // The card leaving the front drops under the rest at once and slides
        // back beneath them; the one coming from the back rises over them.
        c.style.zIndex = String(count - pos);
        c.classList.toggle("is-front", pos === 0);
      });
    }

    function deal(index) {
      current = ((index % count) + count) % count;
      place();
    }

    frame.style.setProperty("--deck-depth", Math.min(count - 1, DECK_DEPTH));
    place();

    // Swiped, mouse, pen and touch alike: within 45° of horizontal and
    // DEAL_PX long, a press deals one card — leftwards the next, rightwards
    // the one before; nearer the vertical it is the page's scroll (by touch
    // the browser's own, touch-action: pan-y, which cancels the press).
    deck.addEventListener("pointerdown", function (e) {
      press = { id: e.pointerId, x: e.clientX, y: e.clientY };
      dealt = false;
    });
    deck.addEventListener("pointermove", function (e) {
      if (!press || e.pointerId !== press.id) return;
      var dx = e.clientX - press.x;
      var dy = e.clientY - press.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DEAL_PX) return;
      press = null;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      dealt = true;
      deal(current + (dx < 0 ? 1 : -1));
    });
    function release(e) {
      if (press && e.pointerId === press.id) press = null;
    }
    deck.addEventListener("pointerup", release);
    deck.addEventListener("pointercancel", release);

    // A swipe that dealt isn't a tap on the tile; nor is a tap on a card
    // behind, which brings that card to the front.
    deck.addEventListener("click", function (e) {
      if (dealt) {
        dealt = false;
        e.stopPropagation();
        return;
      }
      var target = e.target.closest ? e.target.closest(".grid-tile__card") : null;
      if (target && !target.classList.contains("is-front")) {
        e.stopPropagation();
        deal(cards.indexOf(target));
      }
    });

    deck.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      deal(current + (e.key === "ArrowRight" ? 1 : -1));
    });
  }

  // A tile is a link to the product's own page.
  function openProduct(product) {
    window.location.href = window.EmjiveSeries.productHref(product, state.slug);
  }

  // The columns of a row's facts, in order: Id (the name — also the row's
  // button for a keyboard), Category (even where the series has only one),
  // Size (the range it is made in) and Price (what it starts at, over all the
  // metals: the price follows the size, js/selection.js priceAt).
  var FACTS = [
    { key: "name", label: "Id" },
    { key: "category", label: "Category" },
    { key: "size", label: "Size" },
    { key: "price", label: "Price" }
  ];

  // The header row: the same cells as a product's row, the labels in them,
  // so it lines up with the rows at every width (css/style.css). Only seen —
  // each row's facts carry their own labels for a screen reader.
  function buildHead() {
    var head = el("div", "grid-tile grid-tile--head");
    head.setAttribute("aria-hidden", "true");
    head.appendChild(el("span", "grid-tile__index", "No."));
    var body = el("div", "grid-tile__body");
    var facts = el("div", "grid-tile__facts");
    FACTS.forEach(function (fact) {
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
    FACTS.forEach(function (fact) {
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
    var deck = el("div", "grid-tile__deck");
    var assets = product.assets || {};
    var metal = product["default-metal"];
    var name = product.name || "";
    var first = (assets.model && assets["fallback-img"] && assets["fallback-img"][metal]) ||
      (assets.icons && assets.icons[metal]);
    var firstImg = null;
    if (first) {
      firstImg = card(first, name, "grid-tile__card--model");
      deck.appendChild(firstImg);
    }
    (assets.photos || []).forEach(function (photo) {
      deck.appendChild(card(photo.src, photo.description || name, "grid-tile__card--photo"));
    });
    frame.appendChild(deck);

    if (deck.children.length > 1) {
      deck.tabIndex = 0;
      deck.setAttribute("role", "group");
      deck.setAttribute("aria-roledescription", "carousel");
      deck.setAttribute("aria-label", name + " pictures");
      wireDeck(frame, deck);
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
    var inGrid = view() === "grid";
    var host = inGrid ? grid : stage;
    state.emptyMsg.classList.toggle("page-message--grid", inGrid);
    state.emptyMsg.classList.toggle("page-message--stage", !inGrid);
    if (state.emptyMsg.parentNode !== host) host.appendChild(state.emptyMsg);
  }

  function showEmpty(empty) {
    if (!empty) {
      if (state.emptyMsg) state.emptyMsg.hidden = true;
      return;
    }
    var text = "Nothing in " + state.cats.map(function (c) { return "." + c; }).join(" or ") + " in this series yet. ";
    if (!state.emptyMsg) {
      // The site's one message component (EmjiveMessage); placeEmptyMessage
      // below gives it the grid's or the stage's placement. Built once, then
      // only its text changes, so a focused "Show all" keeps its focus.
      state.emptyMsg = el("div");
      window.EmjiveMessage.show(state.emptyMsg, text, {
        label: "Show all",
        onClick: function () { if (state.onShowAll) state.onShowAll(); }
      }, "status");
    } else {
      state.emptyMsg.querySelector(".page-message__text").textContent = text;
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
      var inGrid = view() === "grid";
      host = el("div", inGrid ? "page-message--grid" : "page-message--stage");
      (inGrid ? grid : stage).appendChild(host);
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
        var none = el("div", "page-message--grid");
        window.EmjiveMessage.show(none,
          "No products yet — add some to this series' products.json (see data/series.json)",
          null, "status");
        grid.appendChild(none);
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
