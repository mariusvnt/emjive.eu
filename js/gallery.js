// Homepage gallery (index.html): one of two views, data-gallery-view on
// <html> (set in the <head> by js/scroll-memory.js):
//   stack  the wheel (js/gallery-stack.js, mounted here)
//   grid   the list, built here: one row per product, its pictures a deck dealt by swiping
// data-hero="play" plays the hero reveal first, "skip" lands at rest.
// Also owns product loading, the view toggle and its veil, the filter's
// effect on both views, and reporting changes to js/scroll-memory.js.
//
// window.EmjiveGallery = { setFilter(cats, onShowAll) -> counts | null }

(function () {
  "use strict";

  var grid = document.getElementById("productGrid");
  var stage = document.getElementById("galleryStage");
  var section = document.getElementById("products");
  if (!grid || !stage || !section || !window.EmjiveSeries) return;

  var html = document.documentElement;
  var viewToggle = document.getElementById("galleryViewToggle");

  // Read by js/scroll-memory.js in the <head>.
  var VIEW_KEY = "emjive_gallery_view";
  // The veil's fade (--fade-standard); its fallback timer adds a margin.
  var VEIL_MS = 300;
  // Longest the arrival loader waits on the list's first tiles.
  var FIRST_TILES_MS = 4000;

  var H = window.EmjiveHelpers;
  var el = H.el;

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

  var state = {
    products: null,
    slug: null,
    tiles: [],
    stack: null,
    cats: [],
    onShowAll: null,
    emptyMsg: null,
    stage: null
  };

  /* ---- arrival cover and the wheel ----
     The wheel is laid out from the hero and the screen, which can arrive late
     (hero.css last on a cold cache), so the wheel view isn't shown until its
     layout settles (settleLayout()): a landing holds js/loader.js's arrival
     cover; a restored scroll has js/scroll-memory.js hide the hero and wheel,
     and js/loader.js raises the cover only if that runs long. Given up after
     WHEEL_SETTLE_MS. */
  var WHEEL_SETTLE_MS = 5000;
  var wheelHold = view() === "stack" && window.EmjiveLoader && window.EmjiveLoader.holdPage
    ? window.EmjiveLoader.holdPage()
    : null;
  var wheelSettled = false;

  function releaseWheel() {
    var release = wheelHold;
    wheelHold = null;
    if (release) release();
  }

  function isRestoring() {
    var memory = window.EmjiveScrollMemory;
    return !!(memory && memory.isRestoring && memory.isRestoring());
  }

  // Checked now, again whenever something it waits on changes (the hero's
  // stage or layout, the scroll restore ending), and at the deadline. A check
  // can make the hero publish, hence the next one waits a frame.
  function releaseWhenWheelSettled() {
    var until = Date.now() + WHEEL_SETTLE_MS;
    var queued = false;
    function check() {
      queued = false;
      if (wheelSettled) return;
      if (!state.stack || view() !== "stack" || Date.now() > until ||
          (!isRestoring() && state.stack.settleLayout())) {
        wheelSettled = true;
        releaseWheel();
      }
    }
    function recheck() {
      if (queued || wheelSettled) return;
      queued = true;
      requestAnimationFrame(check);
    }
    if (window.EmjiveHero) {
      window.EmjiveHero.onStage(recheck);
      if (window.EmjiveHero.onLayout) window.EmjiveHero.onLayout(recheck);
    }
    window.addEventListener("emjive:restore-end", recheck);
    setTimeout(check, WHEEL_SETTLE_MS + 10);
    check();
  }

  /* ---- the veil: a view switch fades through the page background ---- */
  var veil = el("div", "gallery-veil");
  veil.setAttribute("aria-hidden", "true");
  document.body.appendChild(veil);
  var veilToken = 0;

  // The veil lifts once the page under it holds still (its height, offset and
  // viewport unchanged for VEIL_STILL_FRAMES frames: a phone settles its bars
  // after a jump), the wheel checked against the hand last, so nothing moves
  // into place in view. Given up at VEIL_STILL_CAP_MS.
  var VEIL_STILL_FRAMES = 3;
  var VEIL_STILL_CAP_MS = 1000;
  function liftWhenStill(token) {
    var cap = Date.now() + VEIL_STILL_CAP_MS;
    var last = "";
    var still = 0;
    (function check() {
      if (token !== veilToken) return;
      var sig = html.scrollHeight + ":" + Math.round(window.pageYOffset || 0) + ":" + window.innerHeight;
      still = sig === last ? still + 1 : 0;
      last = sig;
      if (still < VEIL_STILL_FRAMES && Date.now() < cap) {
        requestAnimationFrame(check);
        return;
      }
      if (state.stack && view() === "stack") state.stack.settleLayout();
      // A frame for that to paint under the veil.
      requestAnimationFrame(function () {
        if (token === veilToken) veil.classList.remove("is-veiled");
      });
    })();
  }

  function throughVeil(change) {
    var token = ++veilToken;
    var done = false;
    function swap() {
      if (done || token !== veilToken) return;
      done = true;
      veil.removeEventListener("transitionend", onEnd);
      change();
      liftWhenStill(token);
    }
    function onEnd(e) {
      if (e.target === veil && e.propertyName === "opacity") swap();
    }
    veil.addEventListener("transitionend", onEnd);
    veil.classList.add("is-veiled");
    setTimeout(swap, VEIL_MS + 50);
  }

  /* ---- the view toggle ---- */

  function syncControls() {
    // Its icon and word are CSS's (same attribute); this is its name.
    if (!viewToggle) return;
    viewToggle.setAttribute("aria-label", view() === "grid" ? "switch to wheel" : "switch to list");
    // Wheel view: shown once the entrance has played out (mapStage, the roll back left out).
    var stage = state.stage === null ? null : window.EmjiveHero.mapStage(state.stage);
    viewToggle.classList.toggle("is-ready", view() === "grid" || (stage !== null && stage >= 0.9));
  }

  // Either view lands at rest: the list at the top, the wheel at the hero's end.
  function switchView(next) {
    if (next === view()) return;
    throughVeil(function () {
      html.setAttribute("data-gallery-view", next);
      html.setAttribute("data-hero", "skip");
      // Blocked storage: the default comes back next visit.
      H.writeStorage("localStorage", VIEW_KEY, next);
      remember({ view: next, hero: "skip" });
      // The page is tall again by now (the attributes above). The offset and
      // the hand first, then the wheel, laid out against the hand where it is.
      H.jumpScroll(next === "stack" ? html.scrollHeight : 0);
      if (hero()) hero().setMode();
      if (state.stack) state.stack.setActive(next === "stack");
      placeEmptyMessage();
      syncControls();
    });
  }

  if (viewToggle) {
    viewToggle.addEventListener("click", function () {
      switchView(view() === "grid" ? "stack" : "grid");
    });
  }

  if (window.EmjiveHero) {
    window.EmjiveHero.onStage(function (progress) {
      state.stage = progress;
      syncControls();
    });
  }
  syncControls();

  /* ---- the list ----
     A header row, then one row per product: index, a deck of pictures (the
     model's fallback-img, or icon without a model, then the photos), and its
     facts. A sideways swipe or a tap on a card behind deals the deck; any other
     tap opens the product. */
  // Cards shown behind the front one; the rest wait under the last.
  var DECK_DEPTH = 3;
  // Sideways travel, in px, before a press deals a card.
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

  // A circular deck; each card's place (0 = front) is --pos for the CSS, capped at DECK_DEPTH.
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
        // The card leaving the front drops under the rest; the one coming from the back rises over them.
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

    // Within 45° of horizontal and DEAL_PX long, a press deals one card; nearer
    // vertical it's the page's scroll (touch-action: pan-y cancels the press).
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

    // A dealing swipe isn't a tap on the tile; nor is a tap on a card behind.
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

  function openProduct(product) {
    window.location.href = window.EmjiveSeries.productHref(product, state.slug);
  }

  // Row facts. Price is the lowest over all metals (it scales with size, js/selection.js priceAt).
  var FACTS = [
    { key: "name", label: "Id" },
    { key: "category", label: "Category" },
    { key: "size", label: "Size" },
    { key: "price", label: "Price" }
  ];

  // Visual only: each row's facts carry their own labels for screen readers.
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
      var range = H.sizeRange(product);
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

  // The index is the product's place in the series, kept when the filter hides rows.
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
    var first = (assets.model && H.assetFor(product, "fallback-img", metal)) || H.assetFor(product, "icons", metal);
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
    var body = el("div", "grid-tile__body");
    body.appendChild(frame);
    body.appendChild(buildFacts(product));
    tile.appendChild(body);

    tile.addEventListener("click", function () { openProduct(product); });

    if (firstImg && window.EmjiveLoader) {
      window.EmjiveLoader.cover(frame, H.imageReady(firstImg));
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

  // A list landing without the hero: its first visible tiles are the first paint.
  function releaseLoaderOnTiles() {
    if (!window.EmjiveLoader) return;
    var top = window.innerHeight || 0;
    var waits = state.tiles.filter(function (tile) {
      if (!tile.firstImg || tile.el.hidden) return false;
      return tile.el.getBoundingClientRect().top < top;
    }).map(function (tile) { return H.imageReady(tile.firstImg); });
    Promise.race([Promise.all(waits), H.wait(FIRST_TILES_MS)]).then(function () { window.EmjiveLoader.pageReady(); });
  }

  /* ---- filtering ----
     Both views hide non-matching items without rebuilding. A filter set before
     the products load (?cat=) is applied once they do. */
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
      // Built once, then only its text changes, so a focused "Show all" keeps focus.
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

  /* ---- loading ---- */

  function showLoadFailure() {
    grid.innerHTML = "";
    // Where the visitor is looking: the empty hero slot if the series index
    // failed, else where the products would have been.
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
        window.EmjiveMessage.show(none, "No items in this series yet.", null, "status");
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
      // The gallery is the last height change: js/scroll-memory.js finishes restoring on it.
      if (state.stack && view() === "stack" && isRestoring() && window.EmjiveScrollMemory.holdUntil) {
        window.EmjiveScrollMemory.holdUntil(function () { return state.stack.settleLayout(); });
      }
      signalContentReady();
      releaseWhenWheelSettled();
    })
    .catch(function (err) {
      console.error("Could not load the gallery:", err);
      wheelSettled = true;
      releaseWheel();
      showLoadFailure();
      if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
      // Still signalled: the page's height is now final.
      signalContentReady();
    });

  window.EmjiveGallery = {
    // cats: categories to show ([] for all). onShowAll: the empty message's
    // "Show all". Returns per-category counts, or null before products load
    // (reported then via "emjive:gallery-filtered").
    setFilter: function (cats, onShowAll) {
      state.cats = (cats || []).slice();
      if (onShowAll) state.onShowAll = onShowAll;
      if (!state.products) return null;
      applyFilter();
      return counts();
    }
  };
})();
