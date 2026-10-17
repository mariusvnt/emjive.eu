/* ==========================================================================
   em·ji·ve — the gallery's stack (index.html only)

   The camera pulls back from the hand. Once the hero's x-ray wipe is over,
   the page stays pinned on the hand and the scrolling carries on into the
   entrance (series/<slug>/hero.js publishes its progress, 0 to 1, through
   window.EmjiveHero.onStage): the hand and its rings shrink, as if the
   camera were zooming out, and the x-ray fades back, showing that the other
   products were there all along — on a big circle round the wrist, which the
   rings on the hand were already almost on. Those slide along it to their
   own places as the camera pulls back.

   Then the circle is a plate to turn. The product at its top (noon) is
   focused: bigger, its model turning slowly on its own and turned by a drag
   on it (the viewers' own spin, coasting and easing back home, then turning
   on its own again after a pause), its name in the middle of the circle as
   a button to its page. A tap on another product turns the plate to bring
   it to the top; a drag round the circle turns the plate with the pointer,
   coasts, and settles with a product at the top. Each product stays upright
   wherever it is on the circle.

   Two ways of drawing the stack, the same circle and the same pull-back:
     - the 3D stack (js/stack-scene.js, a lazy chunk with three.js): every
       model in one shared canvas. It takes over from the pictures once it
       has loaded;
     - the image stack: each product's default view (fallback-img), the very
       picture its 3D model is framed to match — the first paint, and all of
       the stack where the 3D one can't run (no WebGL, reduced motion, the
       chunk failing). The focused one can't be turned.

   window.EmjiveGalleryStack = { mount(stage, options) } -> {
     setFilter(ids), setActive(on)
   } — mounted by js/gallery.js. options: products, slug, active.
   ========================================================================== */

(function () {
  "use strict";

  // ---- the entrance ---------------------------------------------------------
  // The rings on the hand slide along the circle to their own places over
  // this part of the entrance.
  var SLIDE_START = 0.15;
  var SLIDE_END = 0.85;
  // The other products come into sight over this part of it, as the x-ray
  // fades back (series/<slug>/hero.js).
  var APPEAR_START = 0.1;
  var APPEAR_END = 0.7;
  // The wheel counts as landed — the button in its middle there, the plate
  // and the focused model answering — from this point of the entrance, a bit
  // before its very end: the camera is 99.6% of the way back by then (its
  // ease is all but flat), and a page coming Back a little short of its old
  // offset (a phone's toolbar back, the screen shorter) still lands on it.
  var LAND_AT = 0.9;
  // A plate left turned rolls back to the hand before the camera moves in
  // (stageAt()): the first scrolling up from the landing only turns it, over
  // room added to the entrance — this share of its length for every place
  // it has to turn by, up to ROLL_MAX.
  var ROLL_PER_STEP = 0.1;
  var ROLL_MAX = 0.5;
  // The plate follows the scroll through its roll back on a spring (rad/s,
  // critically damped): whatever the scrolling — a wheel's notches, a flick
  // — it eases into each move and out of it.
  var ROLL_SPRING = 9;

  // ---- the circle -------------------------------------------------------------
  // A product's size, as a share of the arc of the circle each one has.
  var SPACING_FILL = 0.6;
  // The focused one's size, as a multiple of the others'.
  var FOCUS_SCALE = 2;
  // Sizes' bounds, in px.
  var SIZE_MIN = 40;
  var SIZE_MAX = 200;
  // The room kept between the circle (its focused product included) and the
  // edges of the space it lives in, in px.
  var MARGIN = 12;
  // Once the camera has pulled back on a landscape screen, the hand's
  // fingertips stay at least this far (px) under the header: there the circle
  // is sized by the screen's height and the hand is big, so it is lowered
  // under the circle by as much as that takes (handDrop). On a portrait
  // screen the wrist always stays on the circle's middle.
  var HAND_TOP_GAP = 24;

  // ---- turning ----------------------------------------------------------------
  // A press that moves further than this is a drag, not a tap.
  var TAP_SLOP = 6;
  // The share of the pointer's turn round the circle the plate follows: it
  // turns half as far, which reads as a heavier plate.
  var DRAG_GAIN = 0.5;
  // A plate let go coasts, slowing by this rate (1/s), until it is slow
  // enough (rad/s) to settle on the nearest place.
  var COAST_DECAY = 3.5;
  var SETTLE_SPEED = 0.8;
  // How long settling, and a turn to a tapped product, take.
  var SETTLE_MS = 450;
  var TURN_MS = 700;
  // The products finding their new places (the filter changed, the screen).
  var FLY_MS = 550;

  var reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  var TAU = Math.PI * 2;

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function clamp01(x) { return clamp(x, 0, 1); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  // An angle brought into (-PI, PI].
  function wrap(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  // The angle of (x, y) about (cx, cy), clockwise from noon.
  function angleAbout(cx, cy, x, y) {
    return Math.atan2(x - cx, cy - y);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
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
      // The plate's turn (radians, clockwise): slot k is at k * step + theta.
      theta: 0,
      items: [],
      byId: {},
      // The circle and the camera (orbitLayout()).
      L: null,
      // The focused item.
      focus: null,
      // The 3D stack, once it has taken over; and its build in flight.
      scene: null,
      sceneToken: 0,
      sceneLoading: false,
      // The Modify sheet is up: the stack holds still behind it.
      suspended: false,
      // The visitor has turned the plate (or tapped it).
      touched: false,
      // The room the entrance has been given for the plate's roll back to
      // the hand (syncRoom()), as a share of its length.
      room: 0,
      // How far the plate has rolled back as drawn (x, 0 to 1, and its
      // speed v): following the scroll's own (rollTarget()) on a spring.
      roll: { x: 0, v: 0 },
      // The turn a plate kept rolled back (keepRolledBack()) is still on its
      // way from, until the spring has brought it home; null otherwise.
      rollFrom: null,
      // The product this history entry left at the top (Back to the page:
      // js/scroll-memory.js), to turn the plate back to.
      restoreId: window.EmjiveScrollMemory && window.EmjiveScrollMemory.wheel
        ? window.EmjiveScrollMemory.wheel()
        : null
    };

    /* ---- the DOM ------------------------------------------------------------ */

    var lightEl = el("div", "stack-light");
    stage.appendChild(lightEl);

    // Over the focused product: where a drag that turns its model starts.
    var spinEl = el("div", "stack-spin");
    spinEl.setAttribute("aria-hidden", "true");
    stage.appendChild(spinEl);

    // In the middle of the circle, one button to the focused product's page:
    // an arrow, then its name. Every product's name is in it, one on top of
    // another (buildItem), the focused one showing: the names' cell is as wide
    // as the longest, so neither the arrow nor the names' right edge ever
    // moves, and a name fades out as the next fades in however fast the plate
    // goes past them.
    var orbitEl = el("div", "stack-orbit");
    var goEl = el("button", "stack-orbit__go");
    goEl.type = "button";
    goEl.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12 H21 M14 5 L21 12 L14 19" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');
    var namesEl = el("span", "stack-orbit__names");
    goEl.appendChild(namesEl);
    orbitEl.appendChild(goEl);
    stage.appendChild(orbitEl);

    // For the keyboard and screen readers: one link per product, to its page
    // (the stack itself is a picture).
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

      var nameEl = el("span", "stack-orbit__name", product.name || "");
      nameEl.setAttribute("aria-hidden", "true");
      namesEl.appendChild(nameEl);
      lightEl.appendChild(itemEl);

      var href = window.EmjiveSeries.productHref(product, slug);
      var li = el("li");
      var link = el("a", null, (product.name || "") + (product.category ? ", " + product.category : ""));
      link.href = href;
      li.appendChild(link);
      listEl.appendChild(li);

      return {
        id: String(product.id),
        product: product,
        href: href,
        el: itemEl,
        img: img,
        ringImg: ringImg,
        listItem: li,
        nameEl: nameEl,
        visible: true,
        // Its place on the circle (orbitLayout()).
        slot: 0,
        // Where it lies on the hand, if it does: { angle, dist, size, rot },
        // about the wrist, at the hero's own scale.
        hand: null,
        // Its pose as last drawn.
        pose: null
      };
    }

    products.forEach(function (product) {
      var item = buildItem(product);
      state.items.push(item);
      state.byId[item.id] = item;
    });

    function visibleItems() {
      return state.items.filter(function (item) { return item.visible; });
    }

    /* ---- geometry -------------------------------------------------------------
       The domain the circle lives in: under the header and the controls,
       over the selection bar's summary row, the screen's full width.

       Its height is the screen's with a phone's browser bars showing (100svh,
       viewHeight()), not window.innerHeight: the bars come and go as the
       page is scrolled — a fast scroll down to the wheel hides them — and
       the circle laid out again for each would jump. Laid out once for the
       smaller screen, it fits whichever way the bars are, and a resize that
       only moves them changes nothing (the resize handler, below). */
    var vhProbe = document.createElement("div");
    vhProbe.setAttribute("aria-hidden", "true");
    vhProbe.style.cssText = "position:absolute;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:100vh";
    vhProbe.style.height = "100svh";
    document.body.appendChild(vhProbe);

    function viewHeight() {
      return vhProbe.offsetHeight || window.innerHeight;
    }

    function barHeight() {
      var summary = document.querySelector(".selection-bar__summary");
      return summary ? summary.getBoundingClientRect().height : 56;
    }

    function domain() {
      var top = header ? header.getBoundingClientRect().bottom : 0;
      if (viewToggle) top = Math.max(top, viewToggle.getBoundingClientRect().bottom);
      return { left: 0, top: top, right: window.innerWidth, bottom: Math.max(top + 1, viewHeight() - barHeight()) };
    }

    function hero() {
      return window.EmjiveSeriesHero || null;
    }

    function heroRings() {
      var h = hero();
      return h && h.rings ? h.rings() : [];
    }

    // The slots the rings on the hand take: the ones that make them slide
    // the least along the circle, over every way of giving them out
    // (hand: [{ item, angle }], n slots).
    function assignHandSlots(hand, n, step) {
      var best = null;
      var bestCost = Infinity;
      var taken = [];
      var picks = [];
      (function search(i, cost) {
        if (cost >= bestCost) return;
        if (i === hand.length) {
          bestCost = cost;
          best = picks.slice();
          return;
        }
        for (var k = 0; k < n; k++) {
          if (taken[k]) continue;
          taken[k] = true;
          picks.push(k);
          search(i + 1, cost + Math.abs(wrap(k * step - hand[i].angle)));
          picks.pop();
          taken[k] = false;
        }
      })(0, 0);
      return best || [];
    }

    /* The circle, where it ends up and where it starts:
         c1, R1   its middle and radius once the camera has pulled back (the
                  middle of the domain; as big as fits with its focused
                  product);
         c0, r0   the same at the hero's own scale — the wrist, and how far
                  the rings on the hand are from it (hero.orbit());
         z        how far the camera pulls back (R1 / r0);
         s, S     a product's size, and the focused one's;
         step     the angle between two places.
       Then every visible product gets a place: the rings on the hand the
       nearest ones they can, the rest the free ones in catalog order. */
    function orbitLayout() {
      var list = visibleItems();
      var n = list.length;
      if (!n) {
        state.L = null;
        return;
      }
      var d = domain();
      var c1 = { x: (d.left + d.right) / 2, y: (d.top + d.bottom) / 2 };
      var half = Math.max(1, Math.min(d.right - d.left, d.bottom - d.top) / 2 - MARGIN);
      var step = TAU / n;
      var k = SPACING_FILL * step;
      var R1 = half / (1 + FOCUS_SCALE * k / 2);
      var s = k * R1;
      if (s > SIZE_MAX || s < SIZE_MIN) {
        s = clamp(s, SIZE_MIN, SIZE_MAX);
        R1 = Math.max(1, half - FOCUS_SCALE * s / 2);
      }
      var h = hero();
      var orbit = h && h.orbit ? h.orbit() : null;
      var c0 = orbit ? { x: orbit.x, y: orbit.y } : c1;
      var r0 = orbit && orbit.r > 0 ? orbit.r : R1;

      // The rings on the hand, about the wrist.
      var rings = {};
      heroRings().forEach(function (ring) { rings[String(ring.id)] = ring; });
      var hand = [];
      list.forEach(function (item) {
        item.hand = null;
        var ring = rings[item.id];
        if (!orbit || !ring || !item.ringImg || !ring.size) return;
        item.hand = {
          angle: angleAbout(c0.x, c0.y, ring.x, ring.y),
          dist: Math.sqrt(Math.pow(ring.x - c0.x, 2) + Math.pow(ring.y - c0.y, 2)),
          size: ring.size,
          rot: ring.rotation
        };
        hand.push({ item: item, angle: item.hand.angle });
      });
      state.items.forEach(function (item) { if (!item.visible) item.hand = null; });

      var taken = [];
      assignHandSlots(hand, n, step).forEach(function (slot, i) {
        hand[i].item.slot = slot;
        taken[slot] = true;
      });
      var next = 0;
      list.forEach(function (item) {
        if (item.hand) return;
        while (taken[next]) next++;
        item.slot = next;
        taken[next] = true;
      });

      // Where the fingertips land, pulled back, and how far the hand has to
      // go down to clear the header with them.
      var z = R1 / r0;
      var handDrop = 0;
      if (orbit && isFinite(orbit.top) && window.innerWidth > viewHeight()) {
        var headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        var tipY = c1.y + z * (orbit.top - c0.y);
        handDrop = Math.max(0, headerBottom + HAND_TOP_GAP - tipY);
      }

      state.L = {
        n: n, step: step, c0: c0, r0: r0, c1: c1, R1: R1, z: z, handDrop: handDrop, dom: d,
        s: s, S: s * FOCUS_SCALE, fromHero: !!orbit, ringsSeen: heroRings().length
      };
      list.forEach(function (item) {
        item.el.style.width = s + "px";
        item.el.style.height = s + "px";
      });
    }

    // The plate's turn as it lands: the product this history entry left at
    // the top brought back there, or the first place at the top.
    function homeTheta() {
      var item = state.restoreId ? state.byId[state.restoreId] : null;
      return item && item.visible && state.L ? -item.slot * state.L.step : 0;
    }

    // The layout is redone once what it is made of has arrived: the hero (its
    // circle, the rings on its hand) may land after the stack is mounted.
    function layoutStale() {
      var L = state.L;
      if (!L) return visibleItems().length > 0;
      var h = hero();
      if (!L.fromHero && h && h.orbit && h.orbit()) return true;
      return L.ringsSeen === 0 && heroRings().length > 0;
    }

    // What the layout was measured against has since moved: the hero laid out
    // otherwise (its stylesheet, a picture, the screen turned or resized with
    // no event for the stack to see) or the domain's edges. The wrist and the
    // circle are measured once, so left alone this is a wheel drawn for
    // another page — the hand off down the screen, the circle off up it —
    // until the next scroll back through the hero measures it again. Checked
    // at the moments that matter (landing, a page coming back, a resize), not
    // per scroll frame: it reads the layout.
    function layoutDrifted() {
      var L = state.L;
      if (!L || !L.fromHero) return false;
      var h = hero();
      var orbit = h && h.orbit ? h.orbit() : null;
      if (!orbit) return false;
      var d = domain();
      return Math.abs(orbit.x - L.c0.x) > 1 || Math.abs(orbit.y - L.c0.y) > 1 || Math.abs(orbit.r - L.r0) > 1 ||
        Math.abs(d.top - L.dom.top) > 1 || Math.abs(d.bottom - L.dom.bottom) > 1 || Math.abs(d.right - L.dom.right) > 1;
    }

    // The layout measured again where the plate stands: as the visitor left
    // it once they have turned it, otherwise as it lands (homeTheta()).
    function remeasure() {
      // Snapped: whatever glide the poses of the old layout were on (the
      // filter's, at mount) must not carry them to the new one on screen.
      blend = null;
      if (state.touched) {
        relayout(false);
        return;
      }
      orbitLayout();
      state.theta = homeTheta();
      if (state.scene && state.L) state.scene.setBaseSize(state.L.s);
      render();
    }

    function checkLayout() {
      if (state.active && layoutDrifted()) remeasure();
    }

    // Whether the wheel is laid out for good, the layout made right first if it
    // can be: the hero in and styled, its state published, nothing measured
    // against another page than the one that stands. The homepage keeps its
    // arrival cover down until it is (js/gallery.js), so a late stylesheet or
    // a restore settling never shows as a jump.
    function settleLayout() {
      if (!state.active || !window.EmjiveHero) return true;
      var h = hero();
      if (h && h.isStyled && h.isStyled() && h.refresh) h.refresh();
      if (heroPending()) return false;
      if (layoutStale() || layoutDrifted()) remeasure();
      syncWaiting();
      return true;
    }

    /* The hero isn't all in yet: its state not published, its stylesheet
       not applied, or the rings not on its hand (they are made when the
       products arrive, after the stack may have been mounted). The wheel
       laid out before that is the one without the hand — the products in
       catalog order, the first at the top — and its slots change once the
       rings are there (the ones that slide the least take the places nearest
       them: foramen at the top, not furcula), so it is not drawn until then
       (.is-waiting): the wheel lands on its own first product, never
       turning from another. Given up after HERO_WAIT_MS, for a hero that
       never comes whole. */
    var HERO_WAIT_MS = 8000;
    var heroWaitEnds = Date.now() + HERO_WAIT_MS;
    var heroIsIn = false;

    function heroPending() {
      if (heroIsIn) return false;
      var pending = false;
      if (Date.now() <= heroWaitEnds && window.EmjiveHero) {
        var h = hero();
        if (window.EmjiveHero.stage() === null) pending = true;
        else if (h && h.isStyled && !h.isStyled()) pending = true;
        else if (h && state.items.some(function (item) { return item.ringImg; }) && heroRings().length === 0) pending = true;
      }
      if (!pending) heroIsIn = true;
      return pending;
    }

    function syncWaiting() {
      var waiting = heroPending();
      stage.classList.toggle("is-waiting", waiting);
      // Not drawn: nothing to glide from when it is.
      if (waiting) blend = null;
    }

    /* ---- the camera -------------------------------------------------------------
       At entrance p, the hero's scale (s0 = 1, the wrist at c0) gives way to the
       circle's (z, the wrist at c1): a point (wx, wy) of the hero as laid out
       is on the screen at c(p) + scale(p) * (w - c0). The scale goes as z^e,
       which reads as an even pull-back. */
    function cameraAt(p) {
      var L = state.L;
      var e = easeInOutCubic(clamp01(p));
      return {
        scale: Math.pow(L.z, e),
        x: lerp(L.c0.x, L.c1.x, e),
        y: lerp(L.c0.y, L.c1.y, e),
        // The hand alone, lowered under the circle as the camera pulls back.
        handDrop: L.handDrop * e
      };
    }

    // A product's size at angle a on the circle (at the circle's scale): it
    // grows as it nears the top.
    function sizeFor(a) {
      var L = state.L;
      var near = 1 - smoothstep(0, L.step, Math.abs(wrap(a)));
      return lerp(L.s, L.S, near);
    }

    /* Where an item is at entrance p with the plate turned by theta, in px of
       the screen: its middle (x, y), its turn (rot, degrees clockwise), its
       size, what's left of its top shot (ring), how much of it shows
       (alpha). For the 3D stack, a ring off the hand also carries fromRing,
       the turn it lay at (ringRot) and how far it has come (u): the model
       swings from its top view to its rest as it slides. */
    function poseAt(item, p, theta) {
      var L = state.L;
      var cam = cameraAt(p);
      var slotAngle = item.slot * L.step + theta;
      var a;
      var dist;
      var worldSize;
      var pose = { rot: 0, ring: 0, alpha: 1, fromRing: false, ringRot: 0, u: 1 };
      if (item.hand) {
        var u = easeInOutCubic(clamp01((p - SLIDE_START) / (SLIDE_END - SLIDE_START)));
        // Along the circle the shortest way round, and out (or in) onto it.
        a = item.hand.angle + wrap(slotAngle - item.hand.angle) * u;
        dist = lerp(item.hand.dist, L.r0, u);
        worldSize = lerp(item.hand.size, sizeFor(slotAngle) / L.z, u);
        pose.rot = lerp(item.hand.rot, 0, u);
        pose.ring = 1 - smoothstep(0, 0.5, u);
        pose.fromRing = true;
        pose.ringRot = item.hand.rot;
        pose.u = u;
      } else {
        a = slotAngle;
        dist = L.r0;
        worldSize = sizeFor(slotAngle) / L.z;
        pose.alpha = smoothstep(APPEAR_START, APPEAR_END, p);
      }
      var wx = L.c0.x + dist * Math.sin(a);
      var wy = L.c0.y - dist * Math.cos(a);
      pose.x = cam.x + cam.scale * (wx - L.c0.x);
      pose.y = cam.y + cam.scale * (wy - L.c0.y);
      pose.size = cam.scale * worldSize;
      return pose;
    }

    /* ---- moving between layouts -----------------------------------------------
       Once landed, a new layout (the filter, the screen) is reached over
       FLY_MS from the poses as they were. */
    var blend = null;

    function lerpPose(from, to, t) {
      var out = {};
      Object.keys(to).forEach(function (key) { out[key] = to[key]; });
      out.x = lerp(from.x, to.x, t);
      out.y = lerp(from.y, to.y, t);
      out.size = lerp(from.size, to.size, t);
      out.alpha = lerp(from.alpha, to.alpha, t);
      return out;
    }

    /* ---- back to the hand -------------------------------------------------------
       The slots were given out with the plate unturned (orbitLayout()), so a
       whole turn (theta a multiple of TAU) is where the rings on the hand
       slide the least. A plate left turned elsewhere is rolled back there by
       the scroll before anything else moves, over room of its own: the hero's
       entrance is made longer by as much as the turn back needs
       (rollShare(), applied by syncRoom() through the hero's
       setEntranceRoom), and that room sits just above the landing
       (LAND_AT). Scrolling up from the landing, it only turns the plate —
       easing in and out — and the camera's pull-back and the rings' slide
       then play over the entrance exactly as they would unturned.
       Scrolling down plays it the other way. */
    function hasHand() {
      return state.items.some(function (item) { return item.visible && item.hand; });
    }

    // How much room the plate's turn back needs, as a share of the entrance.
    function rollShare() {
      if (!state.L || !hasHand()) return 0;
      return Math.min(ROLL_MAX, ROLL_PER_STEP * Math.abs(wrap(state.theta)) / state.L.step);
    }

    // The published entrance (raw, 0 to 1 over the whole stretch, the room
    // included) as the stack plays it: how far the camera and the rings have
    // come (p, 0 to 1 over the entrance proper) and how the plate is turned
    // (theta).
    function stageAt(raw) {
      var room = state.room;
      var p = raw;
      if (room > 0) {
        var u = raw * (1 + room);
        p = u >= LAND_AT + room ? u - room : Math.min(u, LAND_AT);
      }
      var eased = easeInOutCubic(clamp01(state.roll.x));
      var theta = state.theta;
      if (state.rollFrom !== null) theta = lerp(state.rollFrom, state.theta, eased);
      else if (room > 0) theta = lerp(state.theta, state.theta + wrap(-state.theta), eased);
      return { p: p, theta: theta };
    }

    // How far the scroll has the plate rolled back: 0 at the landing, 1
    // once past the room.
    function rollTarget() {
      if (state.rollFrom !== null) return 1;
      var room = state.room;
      if (room <= 0 || state.p === null) return 0;
      return clamp01((LAND_AT + room - state.p * (1 + room)) / room);
    }

    // One step of the plate's spring towards the scroll; whether it still
    // moves.
    function stepRoll(dt) {
      var r = state.roll;
      var target = rollTarget();
      if (reducedMotion.matches) {
        r.x = target;
        r.v = 0;
        return false;
      }
      r.v += (ROLL_SPRING * ROLL_SPRING * (target - r.x) - 2 * ROLL_SPRING * r.v) * dt;
      r.x += r.v * dt;
      if (Math.abs(target - r.x) < 1e-4 && Math.abs(r.v) < 1e-3) {
        r.x = target;
        r.v = 0;
        // A plate kept rolled back, home now as drawn too.
        if (state.rollFrom !== null) {
          state.rollFrom = null;
          r.x = 0;
        }
        return false;
      }
      return true;
    }

    function rollSettled() {
      return state.roll.v === 0 && state.roll.x === rollTarget();
    }

    // Scrolled past the room: the plate is rolled all the way back.
    function rolledBack() {
      return state.room > 0 && state.p !== null && state.p * (1 + state.room) <= LAND_AT;
    }

    // Landed: past the room, at the end of the entrance proper.
    function landedAt(raw) {
      return raw * (1 + state.room) >= LAND_AT + state.room;
    }

    // Rolled all the way back: the plate stays there. Its room goes (the
    // render after this, syncRoom(): below the visitor, so nothing they see
    // moves), and scrolling down again lands on it as it now is — the
    // product at the top, kept for Back, the one at home. The spring, if it
    // is still on its way, carries on there (rollFrom).
    function keepRolledBack() {
      state.rollFrom = state.theta;
      state.theta += wrap(-state.theta);
      var slot = focusedSlot(state.theta);
      var top = null;
      state.items.forEach(function (item) {
        if (item.visible && item.slot === slot) top = item;
      });
      if (top && state.touched && window.EmjiveScrollMemory && window.EmjiveScrollMemory.rememberWheel) {
        window.EmjiveScrollMemory.rememberWheel(top.id);
      }
    }

    // The room made to match the plate as it now rests. The page grows (or
    // shrinks) by it just above the landing: a visitor at the landing is
    // kept where they are against it — unless Back is restoring an offset,
    // which was saved with this room already there.
    function syncRoom() {
      var share = rollShare();
      if (Math.abs(share - state.room) < 1e-6) return;
      var h = hero();
      if (!h || !h.setEntranceRoom) return;
      var root = document.documentElement;
      // How far the visitor is from the page's end, which is the
      // entrance's: the room goes in above them, so that is what stays.
      var fromEnd = Math.max(0, root.scrollHeight - root.clientHeight - window.scrollY);
      var raw = state.p === null ? 0 : state.p;
      var u = raw * (1 + state.room);
      var keep = landedAt(raw) &&
        !(window.EmjiveScrollMemory && window.EmjiveScrollMemory.isRestoring && window.EmjiveScrollMemory.isRestoring());
      h.setEntranceRoom(share);
      var grown = share - state.room;
      state.room = share;
      if (keep) {
        // Shrinking, the browser has already pulled a visitor at the end up
        // with it; growing, it hasn't moved them. Either way, from the end.
        var previous = root.style.scrollBehavior;
        root.style.scrollBehavior = "auto";
        window.scrollTo(0, Math.max(0, root.scrollHeight - root.clientHeight - fromEnd));
        if (previous) root.style.scrollBehavior = previous;
        else root.style.removeProperty("scroll-behavior");
        u += grown;
      }
      // Until the hero publishes again, the entrance as it now stands.
      if (state.p !== null) state.p = clamp01(u / (1 + share));
    }

    function currentPose(item, raw) {
      var at = stageAt(raw);
      var pose = poseAt(item, at.p, at.theta);
      if (!blend) return pose;
      var from = blend.from[item.id];
      if (!from) return pose;
      return lerpPose(from, pose, easeInOutCubic(clamp01((performance.now() - blend.start) / FLY_MS)));
    }

    /* ---- the rings on the hand ------------------------------------------------ */

    // While the entrance is under way the rings are the stack's: the hero's
    // own are hidden (hero.css hides them for a skipped hero, so they are
    // shown by name when the page is scrolled back up to them).
    function showHeroRings(show) {
      heroRings().forEach(function (ring) {
        ring.el.style.visibility = show ? "visible" : "hidden";
      });
    }

    /* ---- drawing ------------------------------------------------------------- */

    // The image stack: one transform per picture (where it is, how it's
    // turned, how big against its box), its opacity, and its top shot's.
    function place(item, pose) {
      var size = state.L.s;
      item.el.style.transform = "translate3d(" + (pose.x - size / 2).toFixed(2) + "px," + (pose.y - size / 2).toFixed(2) + "px,0) " +
        "rotate(" + pose.rot.toFixed(2) + "deg) scale(" + (pose.size / size).toFixed(4) + ")";
      item.el.style.opacity = pose.alpha.toFixed(3);
      if (item.ringImg) {
        item.ringImg.style.opacity = pose.ring.toFixed(3);
        item.img.style.opacity = (1 - pose.ring).toFixed(3);
      }
    }

    // The slot at the top with the plate turned by theta.
    function focusedSlot(theta) {
      var L = state.L;
      return ((Math.round(-theta / L.step) % L.n) + L.n) % L.n;
    }

    function setFocus(item) {
      if (item === state.focus) return;
      // The old name fades out as the new one fades in.
      if (state.focus) state.focus.nameEl.classList.remove("is-shown");
      state.focus = item;
      if (item) item.nameEl.classList.add("is-shown");
      // Turned by the visitor: kept for this history entry, so Back to the
      // page finds the plate turned the same way (not while it rolls back to
      // the hand: it is still turned the visitor's way).
      if (item && landed && state.touched && window.EmjiveScrollMemory && window.EmjiveScrollMemory.rememberWheel) {
        window.EmjiveScrollMemory.rememberWheel(item.id);
      }
      var name = item ? (item.product.name || "") : "";
      goEl.setAttribute("aria-label", item ? name + ": go to its page" : "Go to page");
      syncSceneFocus();
    }

    // The 3D stack's focused model — turning on its own, turned by a drag —
    // only once the camera has pulled back to the circle: during the entrance
    // every model holds its default view.
    function syncSceneFocus() {
      if (!state.scene) return;
      state.scene.setFocus(landed && state.focus ? state.focus.id : null, spinEl);
    }

    var landed = false;

    function render() {
      var L = state.L;
      var h = hero();
      var p = state.p === null ? 0 : state.p;
      var started = p > 0;
      showHeroRings(!started);
      syncWaiting();
      if (!L || !state.active) {
        if (h && h.setZoom) h.setZoom(1, 0, 0);
        return;
      }
      var at = stageAt(p);
      var cam = cameraAt(at.p);
      if (h && h.setZoom) h.setZoom(cam.scale, cam.x - L.c0.x, cam.y - L.c0.y + cam.handDrop);

      var poses = {};
      var slot = focusedSlot(at.theta);
      var focus = null;
      state.items.forEach(function (item) {
        if (!item.visible) return;
        var pose = currentPose(item, p);
        item.pose = pose;
        poses[item.id] = pose;
        if (item.slot === slot) focus = item;
        // Before the entrance starts a ring is the hero's, and the item
        // taking it over isn't there yet (its top shot included, which the
        // 3D stack keeps visible on its own).
        var waiting = !started && item.hand;
        item.el.style.visibility = waiting ? "hidden" : "";
        if (item.ringImg) item.ringImg.style.visibility = waiting ? "hidden" : "";
        // The pictures follow in the 3D stack too: a ring's top shot shows
        // over its model until it has slid into it.
        place(item, pose);
      });
      if (state.scene) state.scene.setPoses(poses);
      setFocus(focus);

      // The name and its button in the middle of the circle, where the camera
      // has it.
      orbitEl.style.left = cam.x.toFixed(1) + "px";
      orbitEl.style.top = cam.y.toFixed(1) + "px";
      placeSpin();
      // The plate at rest: the room for its roll back to match.
      if (motion.mode === "idle") syncRoom();
    }

    // The drag target over the focused product, while the plate is still and
    // its model is there to turn.
    function placeSpin() {
      var pose = state.focus && state.focus.pose;
      var on = !!(pose && landed && state.scene && motion.mode === "idle" && !blend);
      spinEl.classList.toggle("is-on", on);
      if (!pose) return;
      var box = pose.size;
      spinEl.style.width = box.toFixed(1) + "px";
      spinEl.style.height = box.toFixed(1) + "px";
      spinEl.style.transform = "translate3d(" + (pose.x - box / 2).toFixed(1) + "px," + (pose.y - box / 2).toFixed(1) + "px,0)";
    }

    function setStage(p) {
      var was = state.p;
      state.p = p;
      var stale = layoutStale();
      if (stale || ((was === null || was === 0) && p > 0 && p < 1)) {
        orbitLayout();
        // The hero has arrived: the plate lands as this history entry left
        // it, or on the first place, as at the start.
        if (stale && !state.touched) state.theta = homeTheta();
        if (stale) blend = null;
      }
      // The first stage: the plate as the scroll has it, nothing to ease.
      if (was === null) {
        state.roll.x = rollTarget();
        state.roll.v = 0;
      }
      if (rolledBack()) keepRolledBack();
      if (!rollSettled()) kick();
      var nowLanded = landedAt(p);
      if (nowLanded !== landed) {
        landed = nowLanded;
        stage.classList.toggle("is-landed", landed);
        if (!landed) stopMotion();
        syncSceneFocus();
        // Arriving on the wheel is where a stale layout shows: checked here.
        if (landed) checkLayout();
      }
      render();
    }

    /* ---- turning the plate ------------------------------------------------------
       One loop, running only while something moves: a drag, a coast, a settle
       or a turn (a tween of theta), a blend between layouts. */
    var motion = { mode: "idle" };
    var loopRaf = 0;
    var lastTick = 0;

    function kick() {
      if (loopRaf) return;
      lastTick = performance.now();
      loopRaf = requestAnimationFrame(tick);
    }

    function stopMotion() {
      motion = { mode: "idle" };
    }

    function tweenTo(theta, ms, ease) {
      if (reducedMotion.matches || Math.abs(theta - state.theta) < 1e-4) {
        state.theta = theta;
        stopMotion();
        render();
        return;
      }
      motion = { mode: "tween", from: state.theta, to: theta, start: performance.now(), ms: ms, ease: ease || easeOutCubic };
      kick();
    }

    // To the nearest place, a product at the top.
    function settle() {
      var step = state.L.step;
      tweenTo(Math.round(state.theta / step) * step, SETTLE_MS);
    }

    function tick(now) {
      loopRaf = 0;
      var dt = Math.min((now - lastTick) / 1000, 1 / 15);
      lastTick = now;
      var going = false;
      if (motion.mode === "coast") {
        state.theta += motion.speed * dt;
        motion.speed *= Math.exp(-COAST_DECAY * dt);
        if (Math.abs(motion.speed) < SETTLE_SPEED) settle();
        going = true;
      }
      if (motion.mode === "tween") {
        var t = clamp01((now - motion.start) / motion.ms);
        state.theta = lerp(motion.from, motion.to, motion.ease(t));
        if (t >= 1) stopMotion();
        else going = true;
      }
      if (motion.mode === "drag") going = true;
      if (stepRoll(dt)) going = true;
      if (rolledBack()) keepRolledBack();
      if (blend) {
        if (now - blend.start >= FLY_MS) blend = null;
        else going = true;
      }
      render();
      if (going) loopRaf = requestAnimationFrame(tick);
    }

    // The band the products move in: a press there turns the plate.
    function inBand(x, y) {
      var L = state.L;
      if (!L) return false;
      var r = Math.sqrt(Math.pow(x - L.c1.x, 2) + Math.pow(y - L.c1.y, 2));
      return r > L.R1 - L.S / 2 - MARGIN && r < L.R1 + L.S / 2 + MARGIN;
    }

    // The product under (x, y), from the poses as drawn.
    function pick(x, y) {
      var best = null;
      var bestD = Infinity;
      state.items.forEach(function (item) {
        if (!item.visible || !item.pose) return;
        var d = Math.sqrt(Math.pow(x - item.pose.x, 2) + Math.pow(y - item.pose.y, 2));
        if (d < item.pose.size * 0.45 && d < bestD) {
          best = item;
          bestD = d;
        }
      });
      return best;
    }

    // A tap on a product not at the top turns the plate to bring it there.
    function turnToItem(item) {
      var L = state.L;
      tweenTo(state.theta + wrap(-(item.slot * L.step + state.theta)), TURN_MS, easeInOutCubic);
    }

    function ignoreTarget(target) {
      return target === spinEl || target.closest(".stack-orbit__go") || target.closest(".page-message");
    }

    // A drag on the focused product turns its model: the rectangle it is
    // measured against is taken again first (capture: before the drag's own
    // listener on the element reads it).
    stage.addEventListener("pointerdown", function (e) {
      if (e.target === spinEl && state.scene) state.scene.focusMoved();
    }, true);

    var drag = null;
    stage.addEventListener("pointerdown", function (e) {
      if (!landed || !state.L || ignoreTarget(e.target) || e.button > 0) return;
      if (!inBand(e.clientX, e.clientY)) return;
      var L = state.L;
      var angle = angleAbout(L.c1.x, L.c1.y, e.clientX, e.clientY);
      drag = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        angle: angle,
        moved: false,
        speed: 0,
        time: performance.now()
      };
      motion = { mode: "drag" };
      state.touched = true;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not capturable: the drag still runs */ }
      kick();
    });

    stage.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && Math.sqrt(Math.pow(e.clientX - drag.x, 2) + Math.pow(e.clientY - drag.y, 2)) <= TAP_SLOP) return;
      drag.moved = true;
      var L = state.L;
      var angle = angleAbout(L.c1.x, L.c1.y, e.clientX, e.clientY);
      var delta = wrap(angle - drag.angle) * DRAG_GAIN;
      drag.angle = angle;
      state.theta += delta;
      var now = performance.now();
      var dt = Math.max(1, now - drag.time) / 1000;
      drag.time = now;
      // How fast the plate turns, smoothed over the last few moves.
      drag.speed = lerp(drag.speed, delta / dt, 0.5);
    });

    function endDrag(e, cancelled) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      if (!d.moved) {
        stopMotion();
        var item = cancelled ? null : pick(e.clientX, e.clientY);
        if (item && item !== state.focus) turnToItem(item);
        else render();
        return;
      }
      // A pause before letting go is a plate held still.
      var speed = performance.now() - d.time > 80 ? 0 : d.speed;
      if (reducedMotion.matches || Math.abs(speed) < SETTLE_SPEED) {
        settle();
        return;
      }
      motion = { mode: "coast", speed: speed };
      kick();
    }
    stage.addEventListener("pointerup", function (e) { endDrag(e, false); });
    stage.addEventListener("pointercancel", function (e) { endDrag(e, true); });

    // On a touch screen a press in the band is the plate's, not the page's;
    // anywhere else (the middle, the corners) a swipe still scrolls the page
    // back up into the hero.
    stage.addEventListener("touchstart", function (e) {
      if (!landed || e.touches.length !== 1 || ignoreTarget(e.target)) return;
      var t = e.touches[0];
      if (inBand(t.clientX, t.clientY)) e.preventDefault();
    }, { passive: false });

    goEl.addEventListener("click", function () {
      if (state.focus) window.location.href = state.focus.href;
    });

    /* ---- new layouts ------------------------------------------------------------ */

    // The filter changed, or the screen: every product's new place, reached
    // with a glide once landed. The focused product stays at the top if it is
    // still there.
    function relayout(animate) {
      var from = {};
      state.items.forEach(function (item) {
        if (item.visible && item.pose) from[item.id] = item.pose;
      });
      var keep = state.focus && state.focus.visible ? state.focus : null;
      orbitLayout();
      if (!state.L) {
        render();
        return;
      }
      state.theta = keep ? -keep.slot * state.L.step : 0;
      stopMotion();
      if (state.scene) state.scene.setBaseSize(state.L.s);
      blend = animate && landed && !reducedMotion.matches ? { from: from, start: performance.now() } : null;
      render();
      if (blend) kick();
    }

    /* ---- the 3D stack ------------------------------------------------------------
       Built once the page has revealed and the browser is idle (or at once,
       when the gallery is what the page opened on), from the same items. It
       takes over from the pictures in one frame — every model where its
       picture is, turned the way its picture shows it. */
    var readyScene = null;

    function maybeHandOver() {
      if (!readyScene || !state.active || !state.L) return;
      var scene = readyScene;
      readyScene = null;
      var poses = {};
      var p = state.p === null ? 0 : state.p;
      state.items.forEach(function (item) {
        if (item.visible) poses[item.id] = currentPose(item, p);
      });
      scene.handOver(poses);
      state.scene = scene;
      syncSceneFocus();
      stage.classList.add("is-3d");
      render();
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
            return { id: item.id, product: item.product, size: state.L ? state.L.s : SIZE_MIN, ring: !!item.ringImg };
          }),
          hdri: window.EmjiveSeries.hdriPath(slug),
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
      render();
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
    // worth keeping there. Coming back, the pictures are the stack again
    // until the 3D one has rebuilt.
    window.addEventListener("pagehide", stopScene);
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      checkLayout();
      whenPageRevealed(startScene);
    });
    document.addEventListener("visibilitychange", function () {
      if (state.scene) state.scene.setPaused(document.visibilityState === "hidden" || state.suspended);
      // A page coming back after a long while (a tab the phone kept, its
      // screen turned meanwhile): measured again if it moved.
      if (document.visibilityState === "visible") checkLayout();
    });

    // A phone's browser bars coming or going resize the window but not the
    // layout (domain()): only the canvas follows them then, and the circle,
    // the hand and a turn under way are left as they are.
    var resizeTimer = 0;
    var laidOutFor = window.innerWidth + "x" + viewHeight();
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.scene) state.scene.resize();
        var size = window.innerWidth + "x" + viewHeight();
        if (size === laidOutFor) {
          if (layoutDrifted()) remeasure();
          else render();
          return;
        }
        laidOutFor = size;
        relayout(false);
      }, 150);
    });

    /* ---- start ----------------------------------------------------------------- */
    orbitLayout();
    state.theta = homeTheta();
    if (window.EmjiveHero) {
      // The hero's own part of the entrance (the x-ray fading back) keeps
      // pace with the camera's, the plate's roll back left out of it.
      if (window.EmjiveHero.setStageMap) {
        window.EmjiveHero.setStageMap(function (raw) {
          return state.active && state.L ? stageAt(raw).p : raw;
        });
      }
      window.EmjiveHero.onStage(setStage);
      var published = window.EmjiveHero.stage();
      setStage(published === null ? (document.documentElement.getAttribute("data-hero") === "skip" ? 1 : 0) : published);
    } else {
      setStage(1);
    }

    // The hero (its circle, the rings on its hand) may land after the stack is
    // mounted, and a page landed at the end of it publishes nothing more until
    // it is scrolled: the layout is redone as soon as the hero is there — the
    // rings on the hand taking their places, the plate turned back to the
    // first of them (or to the product this history entry left at the top) —
    // unless the visitor has already turned the plate.
    var heroWaitUntil = Date.now() + 8000;
    (function waitForHero() {
      if (state.touched || Date.now() > heroWaitUntil) return;
      if (layoutStale() || (state.active && layoutDrifted())) remeasure();
      else syncWaiting();
      setTimeout(waitForHero, 100);
    })();

    if (state.active) whenPageRevealed(startScene);

    return {
      // See settleLayout().
      settleLayout: settleLayout,

      // ids: the products to show. The hidden leave the circle; the rest find
      // new places on it.
      setFilter: function (ids) {
        var keep = {};
        (ids || []).forEach(function (id) { keep[String(id)] = true; });
        state.items.forEach(function (item) {
          item.visible = !!keep[item.id];
          item.el.hidden = !item.visible;
          item.listItem.hidden = !item.visible;
        });
        if (state.scene) state.scene.setVisible(Object.keys(keep));
        relayout(true);
      },

      // The view switched (js/gallery.js): the grid doesn't need any of this
      // drawn, nor its WebGL contexts kept — nor the hand pulled back.
      setActive: function (on) {
        if (on === state.active) return;
        state.active = on;
        if (!on) {
          stopMotion();
          stopScene();
          render();
          return;
        }
        relayout(false);
        whenPageRevealed(startScene);
      }
    };
  }

  window.EmjiveGalleryStack = { mount: mount };
})();
