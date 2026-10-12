/* ==========================================================================
   em·ji·ve — the gallery's stack (index.html only)

   The products come to the hand. Once the hero's x-ray wipe is over, the
   page stays pinned on the hand and the scrolling carries on into the
   entrance (series/<slug>/hero.js publishes its progress, 0 to 1, through
   window.EmjiveHero.onStage): the products rise from under the screen like a
   wave, left to right, while the rings on the hand pop off it and fly to
   their own places, and the hand fades back. Then they float, spread over
   the screen. A tap on one takes it out of the stack: it flies to the top,
   where it becomes the gallery's old row — the live 3D model to turn, the
   bar behind it, the name — and a tap on the model, the bar or the name
   opens its page. The first such tap also turns gravity on: the others drop
   into a pile, and from then on the phone's own movements tilt it.

   Two ways of drawing the stack, the same layout and the same wave:
     - the 3D stack (js/stack-scene.js, a lazy chunk with three.js and a
       physics engine): every model in one shared canvas, bodies that float,
       fall and collide. It takes over from the pictures once it has loaded;
     - the image stack: each product's default view (fallback-img), the very
       picture its 3D model is framed to match — the first paint, and all of
       the stack where the 3D one can't run (no WebGL, reduced motion, the
       chunk failing). Nothing physical about it: it lays itself out again,
       with a glide, when the focused product changes.
   The focused product's own 3D viewer is js/three-viewer.js's, like the
   product page's (one WebGL context), whichever draws the rest.

   window.EmjiveGalleryStack = { mount(stage, options) } -> {
     setFilter(ids), setActive(on), reset()
   } — mounted by js/gallery.js. options: products, slug, active, focused
   (an id to start focused on: Back from its page), onFocusChange(id|null).
   ========================================================================== */

(function () {
  "use strict";

  // ---- the entrance ---------------------------------------------------------
  // How much of the entrance the items' starts are spread over, left to
  // right: the last one sets off at this point and still lands at the end.
  var WAVE_SPREAD = 0.45;
  // A ring's pop off the hand takes this much of the entrance; it then flies
  // for the rest. It swells to POP_SCALE while it pops.
  var POP_END = 0.25;
  var POP_SCALE = 1.3;
  // How far an item is turned as it sets off (it untwists as it rises).
  var TUMBLE_DEG = 25;

  // ---- the layout ---------------------------------------------------------
  // Each item rests turned by up to this much.
  var TILT_DEG = 8;
  // An item's size as a share of its cell, and its bounds in px.
  var SIZE_IN_CELL = 0.74;
  var SIZE_MIN = 56;
  var SIZE_MAX = 240;
  // How far an item may wander from its cell's middle, as a share of the
  // room it has there.
  var JITTER = 0.6;
  // Between the focus row and the stack under it (the image stack).
  var FOCUS_GAP = 12;

  // ---- focusing -------------------------------------------------------------
  // The flight to the focus row and back (css/style.css .stack-item.is-moving
  // has the same).
  var FLY_MS = 550;
  // The focus row's figure fading over the landed model, or off it.
  var FADE_MS = 150;
  // A press that moves further than this is a scroll, not a tap.
  var TAP_SLOP = 6;

  // ---- device motion --------------------------------------------------------
  var STANDARD_GRAVITY = 9.81;
  // Low-pass on the sensor: each reading moves the gravity this share of the
  // way towards itself.
  var MOTION_SMOOTHING = 0.15;
  // A shake can push past 1 g, but not without bound.
  var MOTION_MAX_G = 2.5;

  var reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function clamp01(x) { return clamp(x, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  // Overshoots its end a little and settles back: the wave's crest.
  function easeOutBack(t) {
    var c1 = 1.4;
    var c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  // A seeded random sequence: the layout is the same on every visit.
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---- the wave -------------------------------------------------------------
     One item's progress at entrance p, shared by both stacks:
       u     how far it has come from its start to its place (0 to 1, a
             little past 1 on the crest)
       spin  how much of its tumble it still has (1 to 0)
       ring  how much of a ring's top shot still shows (1 to 0)
       pop   a ring's swell while it pops off the hand */
  function waveAt(item, p) {
    if (p >= 1) return { u: 1, spin: 0, ring: 0, pop: 1 };
    if (item.ringStart) {
      if (p <= POP_END) {
        return { u: 0, spin: 0, ring: 1, pop: 1 + (POP_SCALE - 1) * easeOutCubic(clamp01(p / POP_END)) };
      }
      var f = clamp01((p - POP_END) / (1 - POP_END));
      return { u: easeInOutCubic(f), spin: 0, ring: 1 - smoothstep(0, 0.5, f), pop: POP_SCALE };
    }
    var t = clamp01((p - item.delay) / (1 - WAVE_SPREAD));
    return { u: easeOutBack(t), spin: 1 - t, ring: 0, pop: 1 };
  }

  // Where an item is at entrance p, in px of the screen: its middle (x, y),
  // its turn (rot, degrees clockwise), its size, and what's left of its top
  // shot. For the 3D stack, which turns a model in three dimensions rather
  // than a picture in two: spin, the wave's tumble on top of the item's rest;
  // and for a ring off the hand, fromRing, the turn it lay at (ringRot) and
  // how far it has come (u) — the model swings from its top view to its
  // place as it flies.
  function poseAt(item, p) {
    var w = waveAt(item, p);
    var t = item.target;
    var s = item.ringStart || { x: t.x, y: window.innerHeight + t.size, rot: t.rot, size: t.size };
    var u = clamp01(w.u);
    var spin = w.spin * item.tumble;
    return {
      x: lerp(s.x, t.x, u),
      // The crest's overshoot, upward only.
      y: lerp(s.y, t.y, w.u),
      rot: lerp(s.rot, t.rot, u) + spin,
      spin: spin,
      size: lerp(s.size * w.pop, t.size, u),
      ring: w.ring,
      fromRing: !!item.ringStart,
      ringRot: s.rot,
      u: u
    };
  }

  function mount(stage, options) {
    var products = options.products || [];
    var slug = options.slug;
    var header = document.querySelector(".site-header");
    var viewToggle = document.getElementById("galleryViewToggle");

    var state = {
      active: options.active !== false,
      // The entrance's progress (null: nothing published yet).
      p: null,
      items: [],
      byId: {},
      focused: null,
      // Bumped by every focus change, so a slower continuation of an earlier
      // one can tell it has been overtaken.
      focusToken: 0,
      // Taps have turned gravity on (the 3D stack's).
      gravity: false,
      // The 3D stack, once it has taken over; and its build in flight.
      scene: null,
      sceneToken: 0,
      sceneLoading: false,
      // The Modify sheet is up: the focused viewer's context is lent to it.
      suspended: false,
      // Items gliding in the image stack (no handover to 3D meanwhile).
      moving: 0
    };

    /* ---- the DOM ------------------------------------------------------------ */

    var lightEl = el("div", "stack-light");
    stage.appendChild(lightEl);

    var focusEl = el("div", "stack-focus");
    var card = el("article", "product-card");
    var barLink = el("a", "product-card__bar-link");
    // A same-destination duplicate of the label below, which stays the real
    // keyboard-reachable link — as on the old rows.
    barLink.setAttribute("aria-hidden", "true");
    barLink.tabIndex = -1;
    var figure = el("div", "product-card__figure");
    var poster = el("img");
    poster.alt = "";
    poster.width = 512;
    poster.height = 512;
    poster.decoding = "async";
    poster.draggable = false;
    figure.appendChild(poster);
    var label = el("a", "product-card__label");
    var labelName = el("span", "product-card__label-name");
    var labelType = el("span", "product-card__label-type");
    label.appendChild(labelName);
    label.appendChild(labelType);
    card.appendChild(barLink);
    card.appendChild(figure);
    card.appendChild(label);
    focusEl.appendChild(card);
    stage.appendChild(focusEl);

    // For the keyboard and screen readers: one button per product, which
    // takes it out of the stack just as a tap does (the stack itself is a
    // picture).
    var listEl = el("ul", "visually-hidden");
    listEl.setAttribute("aria-label", "Products");
    stage.appendChild(listEl);
    var statusEl = el("p", "visually-hidden");
    statusEl.setAttribute("role", "status");
    stage.appendChild(statusEl);

    function buildItem(product) {
      var assets = product.assets || {};
      var metal = product["default-metal"];
      var src = (assets.model && assets["fallback-img"] && assets["fallback-img"][metal]) ||
        (assets.icons && assets.icons[metal]) || "";
      var itemEl = el("div", "stack-item");
      itemEl.setAttribute("aria-hidden", "true");
      var img = el("img", "stack-item__img");
      img.alt = "";
      img.src = src;
      img.width = 512;
      img.height = 512;
      img.decoding = "async";
      img.draggable = false;
      itemEl.appendChild(img);
      var onHand = product["hero-hand-visibility"];
      var topShot = onHand && onHand.visible && assets["top-shot"] && assets["top-shot"][metal];
      var ringImg = null;
      if (topShot) {
        ringImg = el("img", "stack-item__ring");
        ringImg.alt = "";
        ringImg.src = topShot;
        ringImg.decoding = "async";
        ringImg.draggable = false;
        itemEl.appendChild(ringImg);
      }
      itemEl.dataset.id = product.id;
      lightEl.appendChild(itemEl);

      var li = el("li");
      var button = el("button", null, (product.name || "") + (product.category ? ", " + product.category : ""));
      button.type = "button";
      li.appendChild(button);
      listEl.appendChild(li);

      var item = {
        id: String(product.id),
        product: product,
        href: window.EmjiveSeries.productHref(product, slug),
        poster: src,
        el: itemEl,
        img: img,
        ringImg: ringImg,
        listItem: li,
        listButton: button,
        visible: true,
        target: { x: 0, y: 0, rot: 0, size: SIZE_MIN },
        tumble: TUMBLE_DEG,
        delay: 0,
        // Measured off the hand when the entrance begins: { x, y, rot, size }.
        ringStart: null
      };
      button.addEventListener("click", function () {
        focus(item, { fromKeyboard: true });
      });
      return item;
    }

    products.forEach(function (product) {
      var item = buildItem(product);
      state.items.push(item);
      state.byId[item.id] = item;
    });

    /* ---- geometry -------------------------------------------------------------
       The domain the stack lives in: under the header and the controls,
       over the selection bar's summary row, the screen's full width. */
    function barHeight() {
      var summary = document.querySelector(".selection-bar__summary");
      return summary ? summary.getBoundingClientRect().height : 56;
    }

    function domain() {
      var top = header ? header.getBoundingClientRect().bottom : 0;
      if (viewToggle) top = Math.max(top, viewToggle.getBoundingClientRect().bottom);
      return { left: 0, top: top, right: window.innerWidth, bottom: Math.max(top + 1, window.innerHeight - barHeight()) };
    }

    // The focus row sits at the top of the domain; the model lands exactly on
    // its figure's box.
    function placeFocusRow() {
      focusEl.style.setProperty("--focus-top", domain().top + "px");
    }

    function slotRect() {
      var r = figure.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: 0, size: r.width };
    }

    // The image stack makes room under the focus row for the focused product.
    function stackDomain() {
      var d = domain();
      if (state.focused && !state.scene) d.top = figure.getBoundingClientRect().bottom + FOCUS_GAP;
      return d;
    }

    // A grid of cells over the domain, the column count the one that gives
    // the items the most room, the last row centred; each item somewhere in
    // its cell (seeded), slightly turned.
    function layout() {
      var list = state.items.filter(function (item) { return item.visible && item !== state.focused; });
      var n = list.length;
      if (!n) return;
      var d = stackDomain();
      var w = d.right - d.left;
      var h = Math.max(1, d.bottom - d.top);
      var best = { cols: 1, cell: 0 };
      for (var c = 1; c <= n; c++) {
        var r = Math.ceil(n / c);
        var cell = Math.min(w / c, h / r);
        if (cell > best.cell) best = { cols: c, cell: cell };
      }
      var cols = best.cols;
      var rows = Math.ceil(n / cols);
      var cellW = w / cols;
      var cellH = h / rows;
      var size = clamp(Math.min(cellW, cellH) * SIZE_IN_CELL, SIZE_MIN, SIZE_MAX);
      var order = list.slice().sort(function (a, b) {
        return hash(a.id + "|" + slug) - hash(b.id + "|" + slug);
      });
      order.forEach(function (item, i) {
        var row = Math.floor(i / cols);
        var col = i % cols;
        var inRow = row === rows - 1 ? n - row * cols : cols;
        var x0 = d.left + (w - inRow * cellW) / 2;
        var rand = seeded(hash(item.id + "|" + slug + "|" + n));
        item.target = {
          x: x0 + (col + 0.5) * cellW + (rand() * 2 - 1) * JITTER * Math.max(0, cellW - size) / 2,
          y: d.top + (row + 0.5) * cellH + (rand() * 2 - 1) * JITTER * Math.max(0, cellH - size) / 2,
          rot: (rand() * 2 - 1) * TILT_DEG,
          size: size
        };
        item.tumble = (rand() < 0.5 ? -1 : 1) * TUMBLE_DEG;
        item.delay = clamp01((item.target.x - d.left) / w) * WAVE_SPREAD;
        item.el.style.width = size + "px";
        item.el.style.height = size + "px";
      });
    }

    /* ---- the rings on the hand --------------------------------------------- */
    function heroRings() {
      var hero = window.EmjiveSeriesHero;
      return hero && hero.rings ? hero.rings() : [];
    }

    // Where each ring lies on the hand, as the item that takes it over will
    // start: its middle, its turn, its width (the ring's own, unturned).
    function measureRings() {
      state.items.forEach(function (item) { item.ringStart = null; });
      heroRings().forEach(function (ring) {
        var item = state.byId[String(ring.id)];
        if (!item || !item.ringImg) return;
        var r = ring.el.getBoundingClientRect();
        var width = ring.el.offsetWidth;
        if (!width) return;
        item.ringStart = { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: ring.rotation, size: width };
      });
    }

    // While the entrance is under way the rings are the stack's: the hero's
    // own are hidden (hero.css hides them for a skipped hero).
    function showHeroRings(show) {
      heroRings().forEach(function (ring) {
        ring.el.style.visibility = show ? "" : "hidden";
      });
    }

    /* ---- drawing the image stack ------------------------------------------- */
    function place(item, pose) {
      var size = item.target.size;
      var ring = pose.ring || 0;
      item.el.style.transform = "translate3d(" + (pose.x - size / 2).toFixed(2) + "px," + (pose.y - size / 2).toFixed(2) + "px,0) " +
        "rotate(" + pose.rot.toFixed(2) + "deg) scale(" + (pose.size / size).toFixed(4) + ")";
      if (item.ringImg) {
        item.ringImg.style.opacity = ring.toFixed(3);
        item.img.style.opacity = (1 - ring).toFixed(3);
      }
    }

    function render() {
      var p = state.p === null ? 0 : state.p;
      var started = p > 0;
      showHeroRings(!started);
      state.items.forEach(function (item) {
        if (!item.visible || item === state.focused || item.held || item.gliding) return;
        // Before the entrance starts a ring is the hero's, and the item
        // taking it over isn't there yet (its top shot included, which the
        // 3D stack keeps visible on its own).
        var waiting = !started && item.ringStart;
        item.el.style.visibility = waiting ? "hidden" : "";
        if (item.ringImg) item.ringImg.style.visibility = waiting ? "hidden" : "";
        place(item, poseAt(item, p));
      });
      if (state.scene) state.scene.setEntrance(p);
    }

    var landed = false;
    function setStage(p) {
      var was = state.p;
      state.p = p;
      // The rings are measured as they're taken off the hand, while the pin
      // holds the hand still.
      if ((was === null || was === 0) && p > 0 && p < 1) measureRings();
      if (was === 1 && p < 1) {
        // Scrolling back up into the entrance: anything focused goes back
        // first, and the 3D stack's items go back the way they came from
        // wherever they are now.
        unfocus({ instant: true });
        if (state.scene) syncTargetsFromScene();
      }
      var nowLanded = p === 1;
      if (nowLanded !== landed) {
        landed = nowLanded;
        stage.classList.toggle("is-landed", landed);
      }
      render();
    }

    /* ---- the focus row ----------------------------------------------------- */
    function setFocusContent(item) {
      var product = item.product;
      poster.src = item.poster;
      poster.alt = product.name || "";
      poster.hidden = false;
      labelName.textContent = product.name || "";
      labelType.textContent = product.category ? "." + product.category.toLowerCase() : "";
      barLink.href = item.href;
      label.href = item.href;
      var r = figure.getBoundingClientRect();
      focusEl.style.setProperty("--focus-origin", (r.left + r.width / 2) + "px");
    }

    // A click on the model (not a drag that turned it) opens the product's
    // page — the viewer's own controls take the drag. Same 6px rule as the
    // old rows, and only for a pointer that went down here.
    var navPointer = null;
    var navX = 0;
    var navY = 0;
    figure.addEventListener("pointerdown", function (e) {
      navPointer = e.pointerId;
      navX = e.clientX;
      navY = e.clientY;
    });
    figure.addEventListener("pointercancel", function (e) {
      if (e.pointerId === navPointer) navPointer = null;
    });
    figure.addEventListener("pointerup", function (e) {
      if (e.pointerId !== navPointer) return;
      navPointer = null;
      if (!state.focused || !focusEl.classList.contains("is-shown")) return;
      if (Math.sqrt(Math.pow(e.clientX - navX, 2) + Math.pow(e.clientY - navY, 2)) <= TAP_SLOP) {
        window.location.href = state.focused.href;
      }
    });

    /* ---- the focused product's viewer -----------------------------------------
       The grid cards' recipe: built over the poster, transparent, and swapped
       in in one frame once its model has drawn; the poster comes back if it
       fails or goes. One at a time. */
    var viewer = { handle: null, hold: null, token: 0 };

    function startViewer(item) {
      var token = ++viewer.token;
      var assets = item.product.assets || {};
      if (!assets.model || state.suspended || !window.EmjiveLoadViewer) return;
      window.EmjiveLoadViewer().then(function (factory) {
        if (token !== viewer.token || state.focused !== item || state.suspended || typeof factory !== "function") return;
        var hold = window.EmjiveLoader ? window.EmjiveLoader.mount(figure) : null;
        var handle = null;
        try {
          handle = factory(item.product, item.product["default-metal"], {
            hdri: window.EmjiveSeries.hdriPath(slug),
            poster: false,
            loader: hold || false,
            maxPixelRatio: 1.5,
            onReady: function () {
              if (viewer.handle !== handle) return;
              handle.el.style.opacity = "1";
              poster.hidden = true;
            },
            onError: function () {
              if (viewer.handle === handle) stopViewer();
            }
          });
        } catch (err) {
          console.error("emjive: the focused model's viewer could not start", err);
        }
        if (!handle) {
          if (hold) hold.done();
          return;
        }
        viewer.handle = handle;
        viewer.hold = hold;
        handle.el.style.opacity = "0";
        figure.appendChild(handle.el);
      }, function () {});
    }

    function stopViewer() {
      viewer.token++;
      if (viewer.hold) {
        viewer.hold.done();
        viewer.hold = null;
      }
      if (viewer.handle) {
        viewer.handle.dispose();
        if (viewer.handle.el.parentNode) viewer.handle.el.parentNode.removeChild(viewer.handle.el);
        viewer.handle = null;
      }
      poster.hidden = false;
    }

    /* ---- moving items in the image stack -----------------------------------
       A glide is the transform transition (.stack-item.is-moving). A newer
       glide of the same item retargets the running one; only the newest ends
       it (an earlier one's promise just resolves at its own end). */
    function glide(item, pose) {
      var token = item.glideToken = (item.glideToken || 0) + 1;
      if (!item.gliding) {
        item.gliding = true;
        state.moving++;
      }
      item.el.style.visibility = "";
      item.el.classList.add("is-moving");
      void item.el.offsetWidth;
      place(item, pose);
      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          item.el.removeEventListener("transitionend", onEnd);
          if (token === item.glideToken) {
            item.gliding = false;
            item.el.classList.remove("is-moving");
            state.moving = Math.max(0, state.moving - 1);
            maybeHandOver();
          }
          resolve();
        }
        function onEnd(e) {
          if (e.target === item.el && e.propertyName === "transform") finish();
        }
        item.el.addEventListener("transitionend", onEnd);
        setTimeout(finish, FLY_MS + 80);
      });
    }

    // The image stack's items find their new places (the focus row came or
    // went, the filter changed, the screen turned). An item held at the focus
    // row while the figure fades off it goes once that's done (letGo).
    function relayout(animate) {
      layout();
      if (!landed) {
        render();
        return;
      }
      if (state.scene) {
        state.scene.setTargets(targets());
        return;
      }
      state.items.forEach(function (item) {
        if (!item.visible || item === state.focused || item.held) return;
        if (animate && !reducedMotion.matches) glide(item, poseAt(item, 1));
        else place(item, poseAt(item, 1));
      });
    }

    function after(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* ---- focus and unfocus ----------------------------------------------------
       In: the item flies to the focus row's figure (the 3D stack's model in
       its canvas, or the picture), the figure fades in over it, the bar and
       the name come, the live viewer is built. Out: the name and the bar go,
       the item is put back where the figure is and the figure fades off it,
       and it goes back into the stack (falling, in the 3D one). */
    function focus(item, opts) {
      opts = opts || {};
      if (!item || !item.visible || item === state.focused || !landed) return;
      var token = ++state.focusToken;
      var previous = state.focused;
      if (previous) letGo(previous, false);
      state.focused = item;
      if (options.onFocusChange) options.onFocusChange(item.id);
      statusEl.textContent = (item.product.name || "") + " — open its page from its name";

      placeFocusRow();
      var slot = slotRect();
      var instant = !!opts.instant || reducedMotion.matches;

      // Lands only once the previous figure has faded off its own model.
      var cleared = previous && !instant ? after(FADE_MS) : Promise.resolve();
      var flown;
      if (state.scene) {
        flown = state.scene.takeOut(item.id, slot, instant);
      } else if (instant) {
        item.el.style.visibility = "hidden";
        flown = Promise.resolve();
      } else {
        flown = glide(item, slot);
      }
      if (!state.scene) relayout(!instant);

      Promise.all([flown, cleared]).then(function () {
        if (token !== state.focusToken) return;
        setFocusContent(item);
        focusEl.classList.add("is-shown");
        return after(instant ? 0 : FADE_MS);
      }).then(function () {
        if (token !== state.focusToken) return;
        if (state.scene) state.scene.hide(item.id);
        else item.el.style.visibility = "hidden";
        focusEl.classList.add("is-labelled");
        startViewer(item);
        if (opts.fromKeyboard) label.focus();
      });
    }

    // Puts `item` back into the stack from the focus row. relayoutAfter:
    // nothing takes its place (an unfocus, not a swap).
    function letGo(item, relayoutAfter, instant) {
      instant = instant || reducedMotion.matches;
      focusEl.classList.remove("is-labelled");
      stopViewer();
      var slot = slotRect();
      item.held = true;
      if (state.scene) {
        state.scene.showAt(item.id, slot);
      } else {
        item.el.style.visibility = "";
        place(item, slot);
      }
      focusEl.classList.remove("is-shown");
      var settle = function () {
        item.held = false;
        // Focused again meanwhile (a quick tap back on it): it stays.
        if (state.focused === item) return;
        if (state.scene) state.scene.release(item.id);
        else if (instant) place(item, poseAt(item, 1));
        else glide(item, poseAt(item, 1));
      };
      if (relayoutAfter) relayout(!instant);
      if (instant) settle();
      else setTimeout(settle, FADE_MS);
    }

    function unfocus(opts) {
      opts = opts || {};
      var item = state.focused;
      if (!item) return;
      state.focusToken++;
      state.focused = null;
      if (options.onFocusChange) options.onFocusChange(null);
      statusEl.textContent = "";
      var hadFocus = focusEl.contains(document.activeElement);
      letGo(item, true, !!opts.instant);
      if (hadFocus || opts.fromKeyboard) item.listButton.focus();
    }

    /* ---- gravity and the phone's movements --------------------------------------
       The first tap on a product turns gravity on — and, where there is one,
       the motion sensor, whose permission (iOS) can only be asked inside that
       tap. Gravity is the sensor's, rotated from the device's axes to the
       screen's; with no sensor, or a refusal, it simply points down. */
    var motion = { asked: false, g: null, flip: null };

    function enableGravity(fromGesture) {
      if (!state.gravity) {
        state.gravity = true;
        if (state.scene) state.scene.enableGravity();
      }
      if (!fromGesture || motion.asked) return;
      var DeviceMotion = window.DeviceMotionEvent;
      if (!DeviceMotion) return;
      motion.asked = true;
      if (typeof DeviceMotion.requestPermission === "function") {
        // Called synchronously from the tap, as iOS demands. A request that
        // fails (not in a gesture after all, a transient error) is asked
        // again on the next tap; a refusal stands until the page is reloaded.
        DeviceMotion.requestPermission().then(function (answer) {
          if (answer === "granted") listenToMotion();
          else console.warn("emjive: motion access was " + answer + "; the stack stays upright");
        }).catch(function (err) {
          motion.asked = false;
          console.warn("emjive: could not ask for motion access", err);
        });
      } else {
        // iOS shows the method only on secure pages (https, or localhost):
        // over plain http it is missing, no prompt can appear and the sensor
        // stays silent.
        if (window.isSecureContext === false) {
          console.warn("emjive: device motion needs a secure page (https) on iOS; the stack stays upright");
        }
        listenToMotion();
      }
    }

    function screenAngle() {
      var o = window.screen && window.screen.orientation;
      if (o && typeof o.angle === "number") return o.angle;
      return typeof window.orientation === "number" ? window.orientation : 0;
    }

    // accelerationIncludingGravity is the reaction to gravity, in the
    // device's axes (x right, y up, z out of the screen): gravity itself is
    // its opposite, turned by the screen's angle into the screen's axes.
    // Browsers have disagreed on its sign (iOS Safari has long reported the
    // other one), so the first steady reading decides: the phone is held up
    // in front of the visitor, so "down" is towards the screen's bottom.
    function onMotion(e) {
      var a = e.accelerationIncludingGravity;
      if (!a || a.x === null || a.y === null || a.z === null) return;
      var angle = screenAngle() * Math.PI / 180;
      var gx = -a.x / STANDARD_GRAVITY;
      var gy = -a.y / STANDARD_GRAVITY;
      var gz = -a.z / STANDARD_GRAVITY;
      var sx = gx * Math.cos(angle) - gy * Math.sin(angle);
      var sy = gx * Math.sin(angle) + gy * Math.cos(angle);
      if (motion.flip === null) {
        if (Math.abs(sy) < 0.3) return;
        motion.flip = sy > 0;
      }
      if (motion.flip) {
        sx = -sx;
        sy = -sy;
        gz = -gz;
      }
      var g = motion.g || { x: sx, y: sy, z: gz };
      g.x += (sx - g.x) * MOTION_SMOOTHING;
      g.y += (sy - g.y) * MOTION_SMOOTHING;
      g.z += (gz - g.z) * MOTION_SMOOTHING;
      var length = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
      if (length > MOTION_MAX_G) {
        g.x *= MOTION_MAX_G / length;
        g.y *= MOTION_MAX_G / length;
        g.z *= MOTION_MAX_G / length;
      }
      motion.g = g;
      if (state.scene && state.gravity) state.scene.setGravity(g.x, g.y, g.z);
    }

    function listenToMotion() {
      window.addEventListener("devicemotion", onMotion);
    }

    /* ---- taps on the stack ----------------------------------------------------- */
    var downX = 0;
    var downY = 0;
    stage.addEventListener("pointerdown", function (e) {
      downX = e.clientX;
      downY = e.clientY;
    }, true);

    function pick(x, y, target) {
      if (state.scene) return state.scene.pick(x, y);
      var itemEl = target && target.closest ? target.closest(".stack-item") : null;
      return itemEl ? itemEl.dataset.id : null;
    }

    stage.addEventListener("click", function (e) {
      if (!landed) return;
      // The focus row's figure and links have their own business; the empty
      // filter's message too.
      if (e.target.closest(".product-card__figure, .product-card__bar-link, .product-card__label, .product-grid__loading")) return;
      if (Math.sqrt(Math.pow(e.clientX - downX, 2) + Math.pow(e.clientY - downY, 2)) > TAP_SLOP) return;
      var id = pick(e.clientX, e.clientY, e.target);
      var item = id !== null && id !== undefined ? state.byId[String(id)] : null;
      if (item) {
        enableGravity(true);
        focus(item);
      } else {
        unfocus();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !state.focused) return;
      if (window.EmjiveFocusTrap && window.EmjiveFocusTrap.isActive && window.EmjiveFocusTrap.isActive()) return;
      // The header menu or the bar's drawer takes this Escape (js/series.js).
      if (document.querySelector(".site-header__menu.is-open, .selection-bar__drawer.is-open")) return;
      unfocus({ fromKeyboard: true });
    });

    /* ---- the 3D stack ------------------------------------------------------------
       Built once the page has revealed and the browser is idle (or at once,
       when the gallery is what the page opened on), from the same items. It
       takes over from the pictures in one frame — every model where its
       picture is, turned the way its picture shows it — but only while
       nothing in the image stack is gliding; otherwise as soon as it stops. */
    function targets() {
      var out = {};
      state.items.forEach(function (item) {
        if (item.visible) out[item.id] = item.target;
      });
      return out;
    }

    function syncTargetsFromScene() {
      var where = state.scene.positions();
      state.items.forEach(function (item) {
        if (where[item.id]) {
          item.target.x = where[item.id].x;
          item.target.y = where[item.id].y;
        }
      });
    }

    var readyScene = null;

    function maybeHandOver() {
      if (!readyScene || state.moving > 0 || !state.active) return;
      var scene = readyScene;
      readyScene = null;
      var poses = {};
      var p = state.p === null ? 0 : state.p;
      state.items.forEach(function (item) {
        if (item.visible && item !== state.focused) poses[item.id] = poseAt(item, p);
      });
      scene.handOver(poses, {
        focused: state.focused ? state.focused.id : null,
        gravity: state.gravity,
        entrance: p
      });
      state.scene = scene;
      stage.classList.add("is-3d");
      if (state.gravity && motion.g) scene.setGravity(motion.g.x, motion.g.y, motion.g.z);
    }

    function wantScene() {
      return state.active && !reducedMotion.matches &&
        typeof window.EmjiveLoadStack === "function" && typeof window.EmjiveLoadViewer === "function" &&
        state.items.length > 0;
    }

    function startScene() {
      if (state.scene || state.sceneLoading || readyScene || !wantScene()) return;
      state.sceneLoading = true;
      var token = ++state.sceneToken;
      Promise.all([window.EmjiveLoadViewer(), window.EmjiveLoadStack()]).then(function (loaded) {
        var create = loaded[1];
        if (token !== state.sceneToken || !state.active || typeof create !== "function") return null;
        var scene = create({
          host: stage,
          items: state.items.map(function (item) {
            return { id: item.id, product: item.product, size: item.target.size, ring: !!item.ringImg };
          }),
          hdri: window.EmjiveSeries.hdriPath(slug),
          domain: domain,
          slot: slotRect,
          poseAt: function (id, p) {
            var item = state.byId[id];
            return item ? poseAt(item, p) : null;
          },
          targets: targets,
          // Its context reclaimed (iOS does, under memory pressure): the
          // pictures take the stack back.
          onLost: function () { setTimeout(stopScene, 0); }
        });
        if (!scene) return null;
        return scene.ready.then(function () {
          if (token !== state.sceneToken || !state.active) {
            scene.dispose();
            return null;
          }
          readyScene = scene;
          maybeHandOver();
        }, function (err) {
          scene.dispose();
          throw err;
        });
      }).catch(function (err) {
        // The image stack simply stays: it's the whole stack, without 3D.
        // (Not worth a word if it was only given up — the grid, a page hide.)
        if (token === state.sceneToken) console.error("emjive: the 3D stack could not start", err);
      }).then(function () {
        if (token === state.sceneToken) state.sceneLoading = false;
      });
    }

    function stopScene() {
      state.sceneToken++;
      state.sceneLoading = false;
      if (readyScene) {
        readyScene.dispose();
        readyScene = null;
      }
      if (!state.scene) return;
      state.scene.dispose();
      state.scene = null;
      stage.classList.remove("is-3d");
      relayout(false);
    }

    function whenPageRevealed(fn) {
      if (window.EmjiveLoader && !window.EmjiveLoader.isPageReady()) {
        window.addEventListener("emjive:pageready", function () { idle(fn); }, { once: true });
      } else {
        idle(fn);
      }
    }

    function idle(fn) {
      if ("requestIdleCallback" in window) window.requestIdleCallback(fn, { timeout: 2000 });
      else setTimeout(fn, 300);
    }

    /* ---- the page's own comings and goings --------------------------------------- */

    // The Modify sheet (from the bar's drawer, or the grid's Select) builds a
    // viewer of its own: the focused one gives its context back meanwhile, and
    // the stack holds still behind the sheet.
    window.addEventListener("emjive:modify-open", function () {
      state.suspended = true;
      stopViewer();
      if (state.scene) state.scene.setPaused(true);
    });
    window.addEventListener("emjive:modify-close", function () {
      state.suspended = false;
      if (state.scene) state.scene.setPaused(false);
      if (state.focused && focusEl.classList.contains("is-labelled")) startViewer(state.focused);
    });

    // A page kept in the back/forward cache is a live page: nothing 3D is
    // worth keeping there (js/main.js's old grid did the same). Coming back,
    // the pictures are the stack again until the 3D one has rebuilt.
    window.addEventListener("pagehide", function () {
      stopViewer();
      stopScene();
    });
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      if (state.focused) startViewer(state.focused);
      whenPageRevealed(startScene);
    });
    document.addEventListener("visibilitychange", function () {
      if (state.scene) state.scene.setPaused(document.visibilityState === "hidden" || state.suspended);
    });

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        placeFocusRow();
        if (state.p !== null && state.p > 0 && state.p < 1) measureRings();
        relayout(false);
        if (state.focused) setFocusContent(state.focused);
        if (state.scene) state.scene.resize();
      }, 150);
    });

    /* ---- start ----------------------------------------------------------------- */
    placeFocusRow();
    layout();
    if (window.EmjiveHero) {
      window.EmjiveHero.onStage(setStage);
      var published = window.EmjiveHero.stage();
      setStage(published === null ? (document.documentElement.getAttribute("data-hero") === "skip" ? 1 : 0) : published);
    } else {
      setStage(1);
    }

    // Back from the focused product's page: it is focused again, straight
    // away — and the tap that focused it had turned gravity on.
    if (options.focused && state.byId[String(options.focused)] && landed) {
      state.gravity = true;
      focus(state.byId[String(options.focused)], { instant: true });
    }

    if (state.active) whenPageRevealed(startScene);

    return {
      // ids: the products to show. The hidden leave the stack (and the
      // focus row, if one was there); the rest find new places.
      setFilter: function (ids) {
        var keep = {};
        (ids || []).forEach(function (id) { keep[String(id)] = true; });
        if (state.focused && !keep[state.focused.id]) unfocus({ instant: true });
        state.items.forEach(function (item) {
          item.visible = !!keep[item.id];
          item.el.hidden = !item.visible;
          item.listItem.hidden = !item.visible;
        });
        relayout(true);
        if (state.scene) state.scene.setVisible(Object.keys(keep));
      },

      // The view switched (js/gallery.js): the grid doesn't need any of this
      // drawn, nor its WebGL contexts kept.
      setActive: function (on) {
        if (on === state.active) return;
        state.active = on;
        if (!on) {
          unfocus({ instant: true });
          stopScene();
          return;
        }
        placeFocusRow();
        relayout(false);
        whenPageRevealed(startScene);
      },

      // The hero plays again: back to before the entrance — nothing focused,
      // no gravity, the rings back on the hand — and everything follows the
      // entrance again as it's scrolled through.
      reset: function () {
        unfocus({ instant: true });
        state.gravity = false;
        if (state.scene) state.scene.reset();
        layout();
        setStage(0);
      }
    };
  }

  window.EmjiveGalleryStack = { mount: mount };
})();
