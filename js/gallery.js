// Homepage gallery (index.html): one of two views, data-gallery-view on
// <html> (set in the <head> by js/scroll-memory.js):
//   stack  the wheel (js/gallery-stack.js, mounted here)
//   grid   the grid, built here: two tiles per product, its pictures (a deck dealt by
//          swiping) over its material picker and its facts
// data-hero="play" plays the hero reveal first, "skip" lands at rest.
// Also owns product loading, the view toggle and its veil, and reporting
// changes to js/scroll-memory.js, the gallery being reached included.

(function () {
  "use strict";

  var grid = document.getElementById("productGrid");
  var stage = document.getElementById("galleryStage");
  var section = document.getElementById("gallery");
  if (!grid || !stage || !section || !window.EmjiveStudies) return;

  var html = document.documentElement;
  var viewToggle = document.getElementById("galleryViewToggle");

  // Read by js/scroll-memory.js in the <head>.
  var VIEW_KEY = "emjive_gallery_view";
  var REACHED_KEY = "emjive_gallery_reached";
  // The veil's fade (--fade-standard); its fallback timer adds a margin.
  var VEIL_MS = 300;
  // Longest the arrival loader waits on the grid's first items.
  var FIRST_ITEMS_MS = 4000;

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
    return window.EmjiveStudyHero && window.EmjiveStudyHero.setMode ? window.EmjiveStudyHero : null;
  }

  var state = {
    products: null,
    slug: null,
    items: [],
    stack: null,
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

  // The wheel's entrance has played out (mapStage, the roll back left out).
  function wheelLanded() {
    var stage = state.stage === null ? null : window.EmjiveHero.mapStage(state.stage);
    return stage !== null && stage >= 0.9;
  }

  function syncControls() {
    if (view() === "stack" && wheelLanded()) markReached();
    // Its icon and word are CSS's (same attribute); this is its name.
    if (!viewToggle) return;
    viewToggle.setAttribute("aria-label", view() === "grid" ? "switch to wheel" : "switch to grid");
    // Wheel view: shown once landed.
    viewToggle.classList.toggle("is-ready", view() === "grid" || wheelLanded());
  }

  /* ---- reaching the gallery ----
     Once the visitor has been in it (the wheel landed, the grid's top at the
     screen's, or the hero skipped), every landing from the site skips the
     hero for the rest of the visit: js/scroll-memory.js reads the mark,
     which a new tab doesn't have. */
  var reached = false;
  function markReached() {
    if (reached) return;
    reached = true;
    H.writeStorage("sessionStorage", REACHED_KEY, "1");
  }

  function watchGridTop() {
    if (typeof IntersectionObserver !== "function") return;
    var observer = new IntersectionObserver(function (entries) {
      if (view() !== "grid" || entries[entries.length - 1].boundingClientRect.top > 0) return;
      markReached();
      observer.disconnect();
    }, { rootMargin: "0px 0px -100% 0px" });
    observer.observe(section);
  }

  // Either view lands at rest: the grid at the top, the wheel at the hero's end.
  function switchView(next) {
    if (next === view()) return;
    throughVeil(function () {
      html.setAttribute("data-gallery-view", next);
      html.setAttribute("data-hero", "skip");
      markReached();
      // Blocked storage: the default comes back next visit.
      H.writeStorage("localStorage", VIEW_KEY, next);
      remember({ view: next, hero: "skip" });
      // The page is tall again by now (the attributes above). The offset and
      // the hand first, then the wheel, laid out against the hand where it is.
      H.jumpScroll(next === "stack" ? html.scrollHeight : 0);
      if (hero()) hero().setMode();
      if (state.stack) state.stack.setActive(next === "stack");
      syncControls();
      // Its faces crossfade (data-gallery-view): back to its colour with them.
      if (viewToggle) viewToggle.classList.remove("is-pressed");
    });
  }

  if (viewToggle) {
    viewToggle.addEventListener("click", function () {
      viewToggle.classList.add("is-pressed");
      switchView(view() === "grid" ? "stack" : "grid");
    });
  }

  if (window.EmjiveHero) {
    window.EmjiveHero.onStage(function (progress) {
      state.stage = progress;
      syncControls();
    });
  }
  if (heroMode() === "skip") markReached();
  else watchGridTop();
  syncControls();

  /* ---- the grid ----
     Each product takes two tiles: a square deck of pictures (the model's
     fallback-img, or icon without a model, then the photos), and its facts
     under it. A sideways swipe or a tap on a card behind deals the deck; any
     other tap opens the product. */
  // Cards shown behind the front one; the rest wait under the last.
  var DECK_DEPTH = 3;
  // Sideways travel, in px, before a press deals a card.
  var DEAL_PX = 24;

  function card(src, alt, modifier) {
    var img = el("img", "grid-item__card " + modifier);
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

    // A dealing swipe isn't a tap on the item; nor is a tap on a card behind.
    deck.addEventListener("click", function (e) {
      if (dealt) {
        dealt = false;
        e.stopPropagation();
        return;
      }
      var target = e.target.closest ? e.target.closest(".grid-item__card") : null;
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
    window.location.href = window.EmjiveStudies.productHref(product, state.slug);
  }

  // An item's facts, stacked; only the size's label is shown. Price runs
  // over the item's metal, smallest size to largest (it scales with size,
  // js/selection.js priceAt).
  var FACTS = [
    { key: "name", label: "Id" },
    { key: "category", label: "Category" },
    { key: "size", label: "size", shown: true },
    { key: "price", label: "Price" }
  ];

  function factValue(product, key) {
    var name = product.name || "";
    if (key === "name") {
      var dd = el("dd");
      var open = el("button", "grid-item__name", name);
      open.type = "button";
      open.setAttribute("aria-label", "Open " + name + (product.category ? ", " + product.category : ""));
      dd.appendChild(open);
      return dd;
    }
    if (key === "category") return el("dd", "", (product.category || "").toLowerCase());
    if (key === "size") {
      var range = H.sizeRange(product);
      return el("dd", "", range.min + " – " + range.max);
    }
    return el("dd", "", priceText(product, window.EmjiveStudies.metalFor(product)));
  }

  function priceText(product, metal) {
    var sel = window.EmjiveSelection;
    return sel.formatPriceRange(sel.priceSpan(product, metal));
  }

  // The deck's first card: the model's fallback-img, or its icon without a model.
  function cardPicture(product, metal) {
    var assets = product.assets || {};
    return (assets.model && H.assetFor(product, "fallback-img", metal)) || H.assetFor(product, "icons", metal);
  }

  function buildFacts(product) {
    var list = el("dl", "grid-item__facts");
    FACTS.forEach(function (fact) {
      var row = el("div", "grid-item__fact grid-item__fact--" + fact.key);
      row.appendChild(el("dt", fact.shown ? "" : "visually-hidden", fact.label));
      row.appendChild(factValue(product, fact.key));
      list.appendChild(row);
    });
    return list;
  }

  /* An item's own material (EmjiveStudies.chooseMetal): the metals' swatches
     in a row under its pictures, its metal's dotted and named right after
     it. The room for the name opens after the active swatch (each swatch an
     option with an invisible copy of its name, opened on the active one),
     and one label moves into it, hidden while it crosses the swatches. A
     pick changes its picture, its price, the wheel's and its page's metal,
     and no other item's. */
  function buildPicker(entry) {
    var metals = window.EmjiveStudies.metals || [];
    if (metals.length < 2) return null;
    var product = entry.product;
    var picker = el("div", "grid-item__material");
    var row = el("div", "grid-item__swatches");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", (product.name || "") + " material");
    var options = metals.map(function (metal) {
      var option = el("div", "grid-item__option");
      var button = el("button", "grid-item__swatch");
      button.type = "button";
      button.setAttribute("aria-label", metal);
      var swatch = el("span", "product-dial__swatch");
      swatch.setAttribute("data-metal", metal);
      button.appendChild(swatch);
      button.addEventListener("click", function () { choose(metal); });
      var room = el("span", "grid-item__metal");
      room.setAttribute("aria-hidden", "true");
      room.appendChild(el("span", "", metal));
      option.appendChild(button);
      option.appendChild(room);
      row.appendChild(option);
      return { el: option, button: button };
    });
    var label = el("span", "grid-item__label", entry.metal || "");
    label.setAttribute("aria-hidden", "true");
    row.appendChild(label);
    picker.appendChild(row);
    var swapTimer = 0;
    // A tap anywhere on the picker, between swatches included, isn't one on the item.
    picker.addEventListener("click", function (e) { e.stopPropagation(); });

    function paint() {
      options.forEach(function (option, i) {
        var on = metals[i] === entry.metal;
        option.el.classList.toggle("is-active", on);
        option.button.setAttribute("aria-pressed", on ? "true" : "false");
      });
      row.style.setProperty("--active", String(Math.max(0, metals.indexOf(entry.metal))));
    }

    // The label slides to the new swatch (CSS) and fades out and back in on
    // the way; its text changes halfway, while it's hidden.
    function moveLabel(metal) {
      label.classList.remove("is-moving");
      void label.offsetWidth;
      label.classList.add("is-moving");
      clearTimeout(swapTimer);
      var ms = parseFloat(getComputedStyle(label).animationDuration) * 1000 || 0;
      swapTimer = setTimeout(function () { label.textContent = metal; }, ms / 2);
    }

    function choose(metal) {
      if (metal === entry.metal) return;
      entry.metal = metal;
      window.EmjiveStudies.chooseMetal(product, metal);
      moveLabel(metal);
      paint();
      var src = cardPicture(product, metal);
      if (entry.firstImg && src) H.crossfadeSrc(entry.firstImg, src);
      entry.price.textContent = priceText(product, metal);
      if (state.stack) state.stack.setMetal(product.id, metal);
    }

    label.addEventListener("animationend", function () { label.classList.remove("is-moving"); });
    paint();
    return picker;
  }

  // Mirrored for the static grid by galleryItemMarkup() in vite.config.js.
  function buildItem(product) {
    var item = el("article", "grid-item");
    var frame = el("div", "grid-item__frame");
    var deck = el("div", "grid-item__deck");
    var assets = product.assets || {};
    var name = product.name || "";
    var metal = window.EmjiveStudies.metalFor(product);
    var first = cardPicture(product, metal);
    var firstImg = null;
    if (first) {
      firstImg = card(first, name, "grid-item__card--model");
      deck.appendChild(firstImg);
    }
    (assets.photos || []).forEach(function (photo) {
      deck.appendChild(card(photo.src, photo.description || name, "grid-item__card--photo"));
    });
    frame.appendChild(deck);

    if (deck.children.length > 1) {
      deck.tabIndex = 0;
      deck.setAttribute("role", "group");
      deck.setAttribute("aria-roledescription", "carousel");
      deck.setAttribute("aria-label", name + " pictures");
      wireDeck(frame, deck);
    }
    item.appendChild(frame);
    var facts = buildFacts(product);
    var entry = { product: product, el: item, firstImg: firstImg, metal: metal, price: facts.querySelector(".grid-item__fact--price dd") };
    var picker = buildPicker(entry);
    if (picker) item.appendChild(picker);
    item.appendChild(facts);

    item.addEventListener("click", function () { openProduct(product); });

    if (firstImg && window.EmjiveLoader) {
      window.EmjiveLoader.cover(frame, H.imageReady(firstImg));
    }
    return entry;
  }

  // Swapped in at once over the build's static grid (emitGalleryContent in
  // vite.config.js), so the page never shrinks under a restored scroll offset.
  function renderGrid(products) {
    state.items = products.map(buildItem);
    grid.replaceChildren.apply(grid, state.items.map(function (item) { return item.el; }));
  }

  // A grid landing without the hero: its first visible items are the first paint.
  function releaseLoaderOnItems() {
    if (!window.EmjiveLoader) return;
    var top = window.innerHeight || 0;
    var waits = state.items.filter(function (item) {
      if (!item.firstImg) return false;
      return item.el.getBoundingClientRect().top < top;
    }).map(function (item) { return H.imageReady(item.firstImg); });
    Promise.race([Promise.all(waits), H.wait(FIRST_ITEMS_MS)]).then(function () { window.EmjiveLoader.pageReady(); });
  }

  /* ---- loading ---- */

  function showLoadFailure() {
    grid.innerHTML = "";
    // Where the visitor is looking: the empty hero slot if the studies index
    // failed, else where the products would have been.
    var heroSlot = document.getElementById("studyHero");
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

  window.EmjiveStudies.ready
    .then(function (ctx) {
      state.slug = ctx.slug;
      return window.EmjiveStudies.loadProducts(ctx.slug);
    })
    .then(function (products) {
      state.products = products;
      if (!products.length) {
        var none = el("div", "page-message--grid");
        window.EmjiveMessage.show(none, "No items in this study yet.", null, "status");
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
      if (view() === "grid" && heroMode() === "skip") releaseLoaderOnItems();
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
})();
