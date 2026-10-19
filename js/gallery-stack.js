// The homepage wheel (index.html, "stack" in code). After the hero's wipe,
// the entrance (progress 0..1 via window.EmjiveHero.onStage) pulls the camera
// back from the hand: the hand shrinks, the x-ray fades, and the products
// appear on a circle round the wrist, the hand's rings sliding to their places.
//
// Landed, the circle is a plate to turn: the product at the top is focused
// (larger, its model self-turning and draggable like a viewer's, its name a
// button to its page). A tap on another turns it to the top; a drag turns the
// plate, which coasts and settles on a product.
//
// Two renderings of the same layout:
//   3D     js/stack-scene.js (lazy, three.js), taking over once loaded
//   images each product's wheel-poster (drawn like the 3D scene, so the
//          handover changes nothing; fallback-img without one): the first
//          paint, and all of it without WebGL, under reduced motion, or if
//          the chunk fails (the focused model can't turn then)
//
// window.EmjiveGalleryStack = { mount(stage, { products, slug, active }) }
//   -> { settleLayout(), setFilter(ids), setActive(on) }, mounted by js/gallery.js.

(function () {
  "use strict";

  // ---- the entrance ----
  // The hand's rings slide to their places over this part of it.
  var SLIDE_START = 0.15;
  var SLIDE_END = 0.85;
  // The other products appear over this part, as the x-ray fades (hero.js).
  var APPEAR_START = 0.1;
  var APPEAR_END = 0.7;
  // Landed from here: the camera is 99.6% back (its ease nearly flat), and a
  // Back landing slightly short (a phone's toolbar returning) still counts.
  var LAND_AT = 0.9;
  // A plate left turned rolls back to the hand before the camera moves in
  // (stageAt()), over room added to the entrance: this share per slot turned, up to ROLL_MAX.
  var ROLL_PER_STEP = 0.1;
  var ROLL_MAX = 0.5;
  // The roll follows the scroll on a critically damped spring (rad/s), easing
  // any input (wheel notches, flicks).
  var ROLL_SPRING = 9;

  // ---- the circle ----
  // A product's size, as a share of its arc.
  var SPACING_FILL = 0.6;
  // The focused product's size, as a multiple of the others'.
  var FOCUS_SCALE = 2;
  // Size bounds, px.
  var SIZE_MIN = 40;
  var SIZE_MAX = 200;
  // Margin between the circle (focused product included) and its domain's edges, px.
  var MARGIN = 12;
  // Landscape, pulled back: the fingertips stay at least this far (px) under the
  // header, lowering the hand under the circle (handDrop). Portrait keeps the
  // wrist on the circle's centre.
  var HAND_TOP_GAP = 24;

  // ---- turning ----
  // Movement beyond this is a drag, not a tap.
  var TAP_SLOP = 6;
  // The plate turns at half the pointer's angle: a heavier feel.
  var DRAG_GAIN = 0.5;
  // A released plate coasts, decaying at this rate (1/s), until slow enough (rad/s) to settle.
  var COAST_DECAY = 3.5;
  var SETTLE_SPEED = 0.8;
  // Settle and tap-to-turn durations.
  var SETTLE_MS = 450;
  var TURN_MS = 700;
  // Glide to a new layout (filter, resize).
  var FLY_MS = 550;

  var H = window.EmjiveHelpers;
  var el = H.el;
  var clamp = H.clamp;
  var clamp01 = H.clamp01;
  var lerp = H.lerp;
  var easeInOutCubic = H.easeInOutCubic;
  var easeOutCubic = H.easeOutCubic;
  var smoothstep = H.smoothstep;
  var reducedMotion = H.reducedMotion;

  var TAU = Math.PI * 2;

  // An angle wrapped into (-PI, PI].
  function wrap(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }
  // The angle of (x, y) about (cx, cy), clockwise from noon.
  function angleAbout(cx, cy, x, y) {
    return Math.atan2(x - cx, cy - y);
  }

  function mount(stage, options) {
    var products = options.products || [];
    var slug = options.slug;
    var header = document.querySelector(".site-header");
    var viewToggle = document.getElementById("galleryViewToggle");

    var state = {
      active: options.active !== false,
      // Entrance progress (null: not published yet).
      p: null,
      // The plate's turn (radians, clockwise): slot k sits at k * step + theta.
      theta: 0,
      items: [],
      byId: {},
      // Circle and camera (orbitLayout()).
      L: null,
      focus: null,
      // The 3D scene once it has taken over, and its build in flight.
      scene: null,
      sceneToken: 0,
      sceneLoading: false,
      // The Modify sheet is open: hold still.
      suspended: false,
      // The visitor has turned or tapped the plate.
      touched: false,
      // Entrance room given to the roll back (syncRoom()), as a share of its length.
      room: 0,
      // The roll as drawn (x 0..1, speed v), springing toward rollTarget().
      roll: { x: 0, v: 0 },
      // The turn a kept roll-back (keepRolledBack()) is still springing from; null otherwise.
      rollFrom: null,
      // The product this history entry left on top (js/scroll-memory.js).
      restoreId: window.EmjiveScrollMemory && window.EmjiveScrollMemory.wheel
        ? window.EmjiveScrollMemory.wheel()
        : null
    };

    /* ---- the DOM ---- */

    var lightEl = el("div", "stack-light");
    stage.appendChild(lightEl);

    // Over the focused product: where a drag that turns its model starts.
    var spinEl = el("div", "stack-spin");
    spinEl.setAttribute("aria-hidden", "true");
    stage.appendChild(spinEl);

    // One button in the circle's middle to the focused product's page: an arrow,
    // then every product's name stacked (buildItem), the focused one shown. The
    // cell is as wide as the longest name, so nothing shifts as names crossfade.
    var orbitEl = el("div", "stack-orbit");
    var goEl = el("button", "stack-orbit__go");
    goEl.type = "button";
    goEl.insertAdjacentHTML("afterbegin", '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12 H21 M14 5 L21 12 L14 19" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');
    var namesEl = el("span", "stack-orbit__names");
    goEl.appendChild(namesEl);
    orbitEl.appendChild(goEl);
    stage.appendChild(orbitEl);

    // One link per product for keyboard and screen readers (the wheel is a picture).
    var listEl = el("ul", "visually-hidden");
    listEl.setAttribute("aria-label", "Products");
    stage.appendChild(listEl);

    function buildItem(product) {
      var assets = product.assets || {};
      var metal = product["default-metal"];
      var src = (assets.model && (H.assetFor(product, "wheel-poster", metal) || H.assetFor(product, "fallback-img", metal))) ||
        H.assetFor(product, "icons", metal);
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
      var topShot = onHand && onHand.visible && H.assetFor(product, "top-shot", metal);
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
        // Its slot on the circle (orbitLayout()).
        slot: 0,
        // Its place on the hand, if any: { angle, dist, size, rot } about the wrist, at hero scale.
        hand: null,
        // Its last drawn pose.
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

    /* ---- geometry ----
       The domain: under the header and the view toggle, above the selection
       bar's summary, full width. Its height uses 100svh (viewHeight()), not
       innerHeight, so the circle doesn't jump as the phone's browser bars come
       and go; resizes that only move them change nothing. */
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

    // The slots for the hand's rings that minimize their total slide along the
    // circle (hand: [{ item, angle }], n slots): slots[i] is ring i's. The
    // Hungarian algorithm, rings as rows (at most n), polynomial however many
    // rings sit on the hand.
    function assignHandSlots(hand, n, step) {
      var k = hand.length;
      if (!k || k > n) return [];
      function cost(i, j) {
        return Math.abs(wrap(j * step - hand[i].angle));
      }
      // 1-based potentials (u rows, v columns), each column's row (p) and the
      // augmenting path back (way); column 0 is the free start.
      var u = new Array(k + 1).fill(0);
      var v = new Array(n + 1).fill(0);
      var p = new Array(n + 1).fill(0);
      var way = new Array(n + 1).fill(0);
      for (var i = 1; i <= k; i++) {
        p[0] = i;
        var j0 = 0;
        var minv = new Array(n + 1).fill(Infinity);
        var used = new Array(n + 1).fill(false);
        do {
          used[j0] = true;
          var i0 = p[j0];
          var delta = Infinity;
          var j1 = 0;
          for (var j = 1; j <= n; j++) {
            if (used[j]) continue;
            var reduced = cost(i0 - 1, j - 1) - u[i0] - v[j];
            if (reduced < minv[j]) {
              minv[j] = reduced;
              way[j] = j0;
            }
            if (minv[j] < delta) {
              delta = minv[j];
              j1 = j;
            }
          }
          for (var c = 0; c <= n; c++) {
            if (used[c]) {
              u[p[c]] += delta;
              v[c] -= delta;
            } else {
              minv[c] -= delta;
            }
          }
          j0 = j1;
        } while (p[j0] !== 0);
        do {
          var prev = way[j0];
          p[j0] = p[prev];
          j0 = prev;
        } while (j0);
      }
      var slots = [];
      for (var col = 1; col <= n; col++) {
        if (p[col]) slots[p[col] - 1] = col - 1;
      }
      return slots;
    }

    /* The circle at both ends of the pull-back:
         c1, R1   centre and radius pulled back (the domain's centre, as large as
                  fits with the focused product)
         c0, r0   the same at hero scale: the wrist and the rings' distance (hero.orbit())
         z        the pull-back factor (R1 / r0)
         s, S     product size, and the focused one's
         step     angle between slots
       The hand's rings take the nearest slots, the rest the free ones in catalog order. */
    function orbitLayout() {
      var list = visibleItems();
      var n = list.length;
      // Nothing to show (a filter left none): the last layout stays, so the
      // camera, and the hand with it, holds where it is.
      if (!n) return;
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

      // The hand's rings, about the wrist.
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

      // Where the fingertips land pulled back, and how far the hand drops to clear the header.
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

    // The plate's landing turn: this entry's saved product on top, or the first slot.
    function homeTheta() {
      var item = state.restoreId ? state.byId[state.restoreId] : null;
      return item && item.visible && state.L ? -item.slot * state.L.step : 0;
    }

    // The hero (its circle, its rings) may land after the wheel is mounted: relayout then.
    function layoutStale() {
      var L = state.L;
      if (!L) return visibleItems().length > 0;
      var h = hero();
      if (!L.fromHero && h && h.orbit && h.orbit()) return true;
      return L.ringsSeen === 0 && heroRings().length > 0;
    }

    // The hero or the domain moved since the layout was measured (late
    // stylesheet, a picture, rotation or resize without an event): the wheel
    // would be drawn for another layout. Checked at landing, pageshow and resize,
    // not per frame, since it reads layout.
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

    // Re-measures at the plate's current turn if the visitor turned it, else at homeTheta().
    function remeasure() {
      // Snap: no glide from the old layout's poses.
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

    // Whether the wheel is laid out for good, fixing the layout first if it can.
    // js/gallery.js holds the arrival cover until it is, so late changes never jump.
    function settleLayout() {
      if (!state.active || !window.EmjiveHero) return true;
      var h = hero();
      if (h && h.isStyled && h.isStyled() && h.refresh) h.refresh();
      if (heroPending()) return false;
      if (layoutStale() || layoutDrifted()) remeasure();
      syncWaiting();
      return true;
    }

    /* The hero isn't complete yet: stage unpublished, stylesheet missing, or
       rings not yet on the hand (they come with the products). Slots change once
       the rings arrive, so the wheel stays undrawn until then (.is-waiting)
       rather than visibly re-turning. Given up after HERO_WAIT_MS. */
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
      // Undrawn: nothing to glide from.
      if (waiting) blend = null;
    }

    /* ---- the camera ----
       At entrance p, a hero point w is drawn at c(p) + scale(p) * (w - c0), the
       scale going as z^e, an even-feeling pull-back. */
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

    // A product's size at angle a on the circle, growing toward the top.
    function sizeFor(a) {
      var L = state.L;
      var near = 1 - smoothstep(0, L.step, Math.abs(wrap(a)));
      return lerp(L.s, L.S, near);
    }

    /* An item's pose at entrance p and plate turn theta, in screen px: centre
       (x, y), rot (degrees clockwise), size, ring (top shot's remaining share),
       alpha. A ring leaving the hand also carries fromRing, ringRot and u for
       the 3D scene's swing from top view to rest. */
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
        // The shortest way round the circle, and out (or in) onto it.
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

    /* ---- between layouts: once landed, a new layout glides in over FLY_MS ---- */
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

    /* ---- back to the hand ----
       Slots are assigned unturned (orbitLayout()), so theta = 0 (mod TAU) is
       where the rings slide least. A plate left turned is rolled back first by
       the scroll, over room of its own added to the entrance just above LAND_AT
       (rollShare(), syncRoom(), the hero's setEntranceRoom); the pull-back then
       plays as if unturned. */
    function hasHand() {
      return state.items.some(function (item) { return item.visible && item.hand; });
    }

    // The roll back's room, as a share of the entrance.
    function rollShare() {
      if (!state.L || !hasHand()) return 0;
      return Math.min(ROLL_MAX, ROLL_PER_STEP * Math.abs(wrap(state.theta)) / state.L.step);
    }

    // The published progress (raw, over the whole stretch, room included) as the
    // wheel plays it: p over the entrance proper, and the plate's theta.
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

    // The scroll's roll-back target: 0 at the landing, 1 past the room.
    function rollTarget() {
      if (state.rollFrom !== null) return 1;
      var room = state.room;
      if (room <= 0 || state.p === null) return 0;
      return clamp01((LAND_AT + room - state.p * (1 + room)) / room);
    }

    // One spring step toward the scroll; true while still moving.
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
        // A kept roll-back, now home as drawn too.
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

    // Scrolled past the room: fully rolled back.
    function rolledBack() {
      return state.room > 0 && state.p !== null && state.p * (1 + state.room) <= LAND_AT;
    }

    // Landed: past the room, at the entrance's end.
    function landedAt(raw) {
      return raw * (1 + state.room) >= LAND_AT + state.room;
    }

    // Fully rolled back: the plate stays there and its room is removed (below
    // the visitor, invisibly), so scrolling down lands on it as is. The spring
    // carries on from rollFrom if still moving.
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

    // Resizes the room to the plate's current turn. It sits just above the
    // landing, so a visitor at the landing is kept in place, except during a
    // Back restore, whose offset already includes it.
    function syncRoom() {
      var share = rollShare();
      if (Math.abs(share - state.room) < 1e-6) return;
      var h = hero();
      if (!h || !h.setEntranceRoom) return;
      var root = document.documentElement;
      // The room goes in above the visitor: preserve the distance from the page's end.
      var fromEnd = Math.max(0, root.scrollHeight - root.clientHeight - window.scrollY);
      var raw = state.p === null ? 0 : state.p;
      var u = raw * (1 + state.room);
      var keep = landedAt(raw) &&
        !(window.EmjiveScrollMemory && window.EmjiveScrollMemory.isRestoring && window.EmjiveScrollMemory.isRestoring());
      h.setEntranceRoom(share);
      var grown = share - state.room;
      state.room = share;
      if (keep) {
        // Shrinking already pulled the visitor up; growing didn't. Either way, from the end.
        H.jumpScroll(Math.max(0, root.scrollHeight - root.clientHeight - fromEnd));
        u += grown;
      }
      // Until the hero publishes again.
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

    /* ---- the hand's rings ---- */

    // During the entrance the wheel draws the rings; the hero's are hidden
    // (hero.css hides them for a skipped hero, so they're shown explicitly).
    function showHeroRings(show) {
      heroRings().forEach(function (ring) {
        ring.el.style.visibility = show ? "visible" : "hidden";
      });
    }

    /* ---- drawing ---- */

    // The image rendering: one transform and opacity per picture, plus its top shot's.
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

    // The slot at the top for plate turn theta.
    function focusedSlot(theta) {
      var L = state.L;
      return ((Math.round(-theta / L.step) % L.n) + L.n) % L.n;
    }

    function setFocus(item) {
      if (item === state.focus) return;
      // Old name fades out as the new one fades in.
      if (state.focus) state.focus.nameEl.classList.remove("is-shown");
      state.focus = item;
      if (item) item.nameEl.classList.add("is-shown");
      // Visitor-turned: saved for this history entry (not mid-roll-back, still their turn).
      if (item && landed && state.touched && window.EmjiveScrollMemory && window.EmjiveScrollMemory.rememberWheel) {
        window.EmjiveScrollMemory.rememberWheel(item.id);
      }
      var name = item ? (item.product.name || "") : "";
      goEl.setAttribute("aria-label", item ? name + ": go to its page" : "Go to page");
      syncSceneFocus();
    }

    // The 3D focus only once landed: during the entrance models hold their default view.
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
        // Before the entrance the ring is the hero's; its item stays hidden.
        var waiting = !started && item.hand;
        item.el.style.visibility = waiting ? "hidden" : "";
        if (item.ringImg) item.ringImg.style.visibility = waiting ? "hidden" : "";
        // The pictures follow in 3D too: a ring's top shot shows over its model until it slides off.
        place(item, pose);
      });
      if (state.scene) state.scene.setPoses(poses);
      setFocus(focus);

      // The centre button follows the camera.
      orbitEl.style.left = cam.x.toFixed(1) + "px";
      orbitEl.style.top = cam.y.toFixed(1) + "px";
      placeSpin();
      // At rest, the roll-back room follows the plate.
      if (motion.mode === "idle") syncRoom();
    }

    // The model drag target over the focused product, while the plate is still.
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
        // The hero arrived: land as this entry left it, or on the first slot.
        if (stale && !state.touched) state.theta = homeTheta();
        if (stale) blend = null;
      }
      // First stage: the roll starts where the scroll is.
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
        // Arriving on the wheel is where a stale layout would show.
        if (landed) checkLayout();
        if (landed && keyboardItem && state.L) {
          turnToItem(keyboardItem);
          keyboardItem = null;
        }
      }
      render();
    }

    /* ---- turning the plate ----
       One loop, running only while something moves: drag, coast, settle, turn, layout glide. */
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

    // To the nearest slot.
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

    // The products' band: a press there turns the plate.
    function inBand(x, y) {
      var L = state.L;
      if (!L) return false;
      var r = Math.sqrt(Math.pow(x - L.c1.x, 2) + Math.pow(y - L.c1.y, 2));
      return r > L.R1 - L.S / 2 - MARGIN && r < L.R1 + L.S / 2 + MARGIN;
    }

    // The product under (x, y), from the drawn poses.
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

    // Turns the plate to bring a tapped product to the top.
    function turnToItem(item) {
      var L = state.L;
      tweenTo(state.theta + wrap(-(item.slot * L.step + state.theta)), TURN_MS, easeInOutCubic);
    }

    function ignoreTarget(target) {
      return target === spinEl || target.closest(".stack-orbit__go") || target.closest(".page-message");
    }

    // Refresh the model drag's reference rect first (capture: before the scene's listener).
    stage.addEventListener("pointerdown", function (e) {
      if (e.target === spinEl && state.scene) state.scene.focusMoved();
    }, true);

    var drag = null;
    stage.addEventListener("pointerdown", function (e) {
      if (!landed || !state.L || !state.focus || ignoreTarget(e.target) || e.button > 0) return;
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
      // Smoothed turning speed.
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
      // A pause before release means held still.
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

    // On touch, a press in the band is the plate's; elsewhere a swipe still scrolls.
    stage.addEventListener("touchstart", function (e) {
      if (!landed || e.touches.length !== 1 || ignoreTarget(e.target)) return;
      var t = e.touches[0];
      if (inBand(t.clientX, t.clientY)) e.preventDefault();
    }, { passive: false });

    goEl.addEventListener("click", function () {
      if (state.focus) window.location.href = state.focus.href;
    });

    // The list's links are hidden, so a keyboard on one is shown on the wheel:
    // it lands (the page's end) and turns to that product, and the centre
    // button, which names it, carries the focus ring.
    var keyboardItem = null;
    listEl.addEventListener("focusin", function (e) {
      if (!e.target.matches(":focus-visible")) return;
      var item = state.items.find(function (it) { return it.listItem.contains(e.target); });
      if (!item) return;
      orbitEl.classList.add("is-list-focus");
      if (landed && state.L) {
        turnToItem(item);
      } else {
        keyboardItem = item;
        H.jumpScroll(document.documentElement.scrollHeight);
      }
    });
    listEl.addEventListener("focusout", function () {
      orbitEl.classList.remove("is-list-focus");
      keyboardItem = null;
    });

    /* ---- new layouts ---- */

    // Filter or screen change: new slots, glided to once landed; the focused product stays on top if still shown.
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

    /* ---- the 3D scene ----
       Built once the page has revealed and the browser is idle, then takes over
       from the pictures in one frame. */
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
          // Context reclaimed (iOS under memory pressure): back to the pictures.
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
        // The image rendering stays. Silent if merely abandoned (list view, page hide).
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
        window.addEventListener("emjive:pageready", function () { H.whenIdle(fn, 2000, 300); }, { once: true });
      } else {
        H.whenIdle(fn, 2000, 300);
      }
    }

    /* ---- page lifecycle ---- */

    // The Modify sheet builds its own viewer: hold still behind it.
    window.addEventListener("emjive:modify-open", function () {
      state.suspended = true;
      if (state.scene) state.scene.setPaused(true);
    });
    window.addEventListener("emjive:modify-close", function () {
      state.suspended = false;
      if (state.scene) state.scene.setPaused(false);
    });

    // Nothing 3D is kept on a bfcache page; on return the pictures stand in until it rebuilds.
    window.addEventListener("pagehide", stopScene);
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      checkLayout();
      whenPageRevealed(startScene);
    });
    document.addEventListener("visibilitychange", function () {
      if (state.scene) state.scene.setPaused(document.visibilityState === "hidden" || state.suspended);
      // A tab returning after long (maybe rotated meanwhile): re-measure if moved.
      if (document.visibilityState === "visible") checkLayout();
    });

    // Browser-bar resizes don't change the layout (domain()): only the canvas follows.
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

    /* ---- start ---- */
    orbitLayout();
    state.theta = homeTheta();
    if (window.EmjiveHero) {
      // The hero's part of the entrance keeps pace with the camera, the roll back left out.
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

    // The hero may land after mounting and, landed at its end, publishes no
    // stage until scrolled: re-measure when its layout changes
    // (EmjiveHero.onLayout) or the domain's edges resize, unless the visitor
    // already turned the plate. The hero's wait gives up at HERO_WAIT_MS.
    function onLayoutChange() {
      if (state.touched) return;
      if (layoutStale() || (state.active && layoutDrifted())) remeasure();
      else syncWaiting();
    }
    if (window.EmjiveHero && window.EmjiveHero.onLayout) window.EmjiveHero.onLayout(onLayoutChange);
    if (typeof ResizeObserver === "function") {
      var edges = new ResizeObserver(onLayoutChange);
      [header, viewToggle, vhProbe, document.querySelector(".selection-bar__summary")].forEach(function (node) {
        if (node) edges.observe(node);
      });
    }
    setTimeout(syncWaiting, Math.max(0, heroWaitEnds - Date.now()) + 50);

    if (state.active) whenPageRevealed(startScene);

    return {
      settleLayout: settleLayout,

      // ids: products to show; hidden ones leave the circle, the rest re-slot.
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

      // View switched (js/gallery.js): the list needs none of this, nor its WebGL contexts.
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
