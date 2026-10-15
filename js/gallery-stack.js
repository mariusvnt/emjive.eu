/* ==========================================================================
   em·ji·ve — the gallery's stack (index.html only)

   The products come to the hand. Once the hero's x-ray wipe is over, the
   page stays pinned on the hand and the scrolling carries on into the
   entrance (series/<slug>/hero.js publishes its progress, 0 to 1, through
   window.EmjiveHero.onStage): the products rise from under the screen like a
   wave, left to right, while the rings on the hand pop off it and turn in
   place before flying to their own places, and the hand fades back. Then
   they float, spread over the screen, each rocking very slowly about the
   axis pointing at the visitor. A tap on one opens its page.

   Two ways of drawing the stack, the same layout and the same wave:
     - the 3D stack (js/stack-scene.js, a lazy chunk with three.js): every
       model in one shared canvas. It takes over from the pictures once it
       has loaded;
     - the image stack: each product's default view (fallback-img), the very
       picture its 3D model is framed to match — the first paint, and all of
       the stack where the 3D one can't run (no WebGL, reduced motion, the
       chunk failing). It doesn't float; it lays itself out again, with a
       glide, when the filter changes.

   window.EmjiveGalleryStack = { mount(stage, options) } -> {
     setFilter(ids), setActive(on)
   } — mounted by js/gallery.js. options: products, slug, active.
   ========================================================================== */

(function () {
  "use strict";

  // ---- the entrance ---------------------------------------------------------
  // How much of the entrance the items' starts are spread over, left to
  // right: the last one sets off at this point and still lands at the end.
  var WAVE_SPREAD = 0.45;
  // A ring's pop off the hand takes this much of the entrance, turning in
  // place at its size on the hand; it then flies for the rest.
  var POP_END = 0.25;
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

  // ---- moving ---------------------------------------------------------------
  // The image stack's glide to a new place (css/style.css .stack-item.is-moving
  // has the same).
  var FLY_MS = 550;
  // A press that moves further than this is a scroll, not a tap.
  var TAP_SLOP = 6;

  var reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function clamp01(x) { return clamp(x, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
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
       ring  how much of a ring's top shot still shows (1 to 0) */
  function waveAt(item, p) {
    if (p >= 1) return { u: 1, spin: 0, ring: 0 };
    if (item.ringStart) {
      if (p <= POP_END) {
        return { u: 0, spin: 0, ring: 1 };
      }
      var f = clamp01((p - POP_END) / (1 - POP_END));
      return { u: easeInOutCubic(f), spin: 0, ring: 1 - smoothstep(0, 0.5, f) };
    }
    var t = clamp01((p - item.delay) / (1 - WAVE_SPREAD));
    return { u: easeOutBack(t), spin: 1 - t, ring: 0 };
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
      size: lerp(s.size, t.size, u),
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
      // The 3D stack, once it has taken over; and its build in flight.
      scene: null,
      sceneToken: 0,
      sceneLoading: false,
      // The Modify sheet is up: the stack holds still behind it.
      suspended: false,
      // Items gliding in the image stack (no handover to 3D meanwhile).
      moving: 0
    };

    /* ---- the DOM ------------------------------------------------------------ */

    var lightEl = el("div", "stack-light");
    stage.appendChild(lightEl);

    // For the keyboard and screen readers: one link per product, to its page,
    // as a tap on it goes (the stack itself is a picture).
    var listEl = el("ul", "visually-hidden");
    listEl.setAttribute("aria-label", "Products");
    stage.appendChild(listEl);

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

      var href = window.EmjiveSeries.productHref(product, slug);
      var li = el("li");
      var link = el("a", null, (product.name || "") + (product.category ? ", " + product.category : ""));
      link.href = href;
      li.appendChild(link);
      listEl.appendChild(li);

      var item = {
        id: String(product.id),
        product: product,
        href: href,
        el: itemEl,
        img: img,
        ringImg: ringImg,
        listItem: li,
        visible: true,
        target: { x: 0, y: 0, rot: 0, size: SIZE_MIN },
        tumble: TUMBLE_DEG,
        delay: 0,
        // Measured off the hand when the entrance begins: { x, y, rot, size }.
        ringStart: null
      };
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

    // A grid of cells over the domain, the column count the one that gives
    // the items the most room, the last row centred; each item somewhere in
    // its cell (seeded), slightly turned.
    function layout() {
      var list = state.items.filter(function (item) { return item.visible; });
      var n = list.length;
      if (!n) return;
      var d = domain();
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
    // own are hidden (hero.css hides them for a skipped hero, so they are
    // shown by name when the page is scrolled back up to them).
    function showHeroRings(show) {
      heroRings().forEach(function (ring) {
        ring.el.style.visibility = show ? "visible" : "hidden";
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
        if (!item.visible || item.gliding) return;
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
      var nowLanded = p === 1;
      if (nowLanded !== landed) {
        landed = nowLanded;
        stage.classList.toggle("is-landed", landed);
      }
      render();
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

    // The image stack's items find their new places (the filter changed, the
    // screen turned).
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
        if (!item.visible) return;
        if (animate && !reducedMotion.matches) glide(item, poseAt(item, 1));
        else place(item, poseAt(item, 1));
      });
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
      // The empty filter's message has its own business.
      if (e.target.closest(".product-grid__loading")) return;
      if (Math.sqrt(Math.pow(e.clientX - downX, 2) + Math.pow(e.clientY - downY, 2)) > TAP_SLOP) return;
      var id = pick(e.clientX, e.clientY, e.target);
      var item = id !== null && id !== undefined ? state.byId[String(id)] : null;
      if (item) window.location.href = item.href;
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

    var readyScene = null;

    function maybeHandOver() {
      if (!readyScene || state.moving > 0 || !state.active) return;
      var scene = readyScene;
      readyScene = null;
      var poses = {};
      var p = state.p === null ? 0 : state.p;
      state.items.forEach(function (item) {
        if (item.visible) poses[item.id] = poseAt(item, p);
      });
      scene.handOver(poses, { entrance: p });
      state.scene = scene;
      stage.classList.add("is-3d");
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

    // The Modify sheet (from the bar's drawer) builds a viewer of its own: the
    // stack holds still behind it.
    window.addEventListener("emjive:modify-open", function () {
      state.suspended = true;
      if (state.scene) state.scene.setPaused(true);
    });
    window.addEventListener("emjive:modify-close", function () {
      state.suspended = false;
      if (state.scene) state.scene.setPaused(false);
    });

    // A page kept in the back/forward cache is a live page: nothing 3D is
    // worth keeping there (js/main.js's old grid did the same). Coming back,
    // the pictures are the stack again until the 3D one has rebuilt.
    window.addEventListener("pagehide", stopScene);
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      whenPageRevealed(startScene);
    });
    document.addEventListener("visibilitychange", function () {
      if (state.scene) state.scene.setPaused(document.visibilityState === "hidden" || state.suspended);
    });

    var resizeTimer = 0;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.p !== null && state.p > 0 && state.p < 1) measureRings();
        relayout(false);
        if (state.scene) state.scene.resize();
      }, 150);
    });

    /* ---- start ----------------------------------------------------------------- */
    layout();
    if (window.EmjiveHero) {
      window.EmjiveHero.onStage(setStage);
      var published = window.EmjiveHero.stage();
      setStage(published === null ? (document.documentElement.getAttribute("data-hero") === "skip" ? 1 : 0) : published);
    } else {
      setStage(1);
    }

    if (state.active) whenPageRevealed(startScene);

    return {
      // ids: the products to show. The hidden leave the stack; the rest find
      // new places.
      setFilter: function (ids) {
        var keep = {};
        (ids || []).forEach(function (id) { keep[String(id)] = true; });
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
          stopScene();
          return;
        }
        relayout(false);
        whenPageRevealed(startScene);
      }
    };
  }

  window.EmjiveGalleryStack = { mount: mount };
})();
