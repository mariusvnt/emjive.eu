/* ==========================================================================
   em·ji·ve — the product page's three stages
   product.html's show is one tall track (.product-stage) holding one sticky
   stage (.product-stage__pin): scrolling down the track doesn't move the
   page, it moves the show along — presentation (description, carousel,
   metal picker), then specs (the model as a wireframe with its dimensions,
   the cost breakdown, a size field), then logistics (shipping and returns).
   Free scrub, no snapping, and not linear: each stage is a stretch of
   scrolling in which nothing changes (so there is room to scroll about in
   it), and each transition between two is eased at both ends, so the page
   eases out of one stage and into the next. The track's length is the three
   stretches plus the two transitions; their proportion is --hold-ratio in
   css/style.css (a stretch is that share of a transition).

   window.EmjiveProductStages.mount(stageEl, { onChange }) reads the track's
   position on every scroll frame (the technique series/bones/hero.js uses
   for the homepage wipe) and publishes two eased numbers, 0 to 1:

     --to-specs       presentation -> specs
     --to-logistics   specs -> logistics

   as custom properties on the track — css/style.css fades everything from
   them — plus data-stage (the nearest stage: "presentation", "specs" or
   "logistics"; "flow" on a screen too short to pin the stage, where the
   page is laid out as a plain column and none of this runs), and calls
   onChange({ toSpecs, toLogistics, stage }) when they change, for what
   CSS can't do (js/product.js: the model, the carousel lock).

   Returns { scrollToStage(index) }. Focus moving into an element marked
   data-stage-owner="presentation|specs|logistics" (or two, space apart) while
   another stage is showing scrolls to that one (the first), so the keyboard can reach everything — but
   only focus a keyboard put there (:focus-visible). A click on the model
   focuses the carousel's viewport (a tab stop) without any such intent, and
   used to throw the page back to the stage that viewport belongs to.

   The show loops: scrolling on at the very end of logistics — a fresh wheel
   gesture, swipe or key, never the tail of the one that got there — takes
   the show back to the start: everything fades out to the page's background
   (.is-veiled, css/style.css), the page jumps to the top while nothing shows,
   and the first stage fades back in.
   ========================================================================== */

(function () {
  "use strict";

  // Below this height there's no room to pin a title, a carousel and the
  // controls in one screen (a phone on its side): the stage is laid out as a
  // plain column instead. Same query as the "flow" block in css/style.css.
  var FLOW_QUERY = "(max-height: 560px)";

  var STAGES = ["presentation", "specs", "logistics"];

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  // Zero speed and zero acceleration at both ends (Perlin's smootherstep).
  function ease(u) {
    var t = clamp01(u);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function mount(stageEl, options) {
    var pin = stageEl.querySelector(".product-stage__pin");
    var onChange = (options && options.onChange) || function () {};
    var flow = window.matchMedia(FLOW_QUERY);
    var ticking = false;
    var state = { toSpecs: -1, toLogistics: -1, stage: "" };
    // Where each stage sits, in page scroll, as last measured.
    var stops = [0, 0, 0];

    function measure() {
      var rect = stageEl.getBoundingClientRect();
      // The pin's sticky top: the track has moved past it by this much.
      var stickAt = parseFloat(getComputedStyle(pin).top) || 0;
      var scrolled = stickAt - rect.top;
      var trackStart = window.pageYOffset - scrolled;
      // hold, transition, hold, transition, hold.
      var ratio = parseFloat(getComputedStyle(stageEl).getPropertyValue("--hold-ratio"));
      if (!(ratio >= 0)) ratio = 0.5;
      var travel = Math.max(0, stageEl.offsetHeight - pin.offsetHeight);
      var move = travel / (3 * ratio + 2);
      var hold = ratio * move;
      stops = [trackStart, trackStart + hold + move, trackStart + 2 * hold + 2 * move];
      return { scrolled: scrolled, hold: hold, move: move };
    }

    function publish(toSpecs, toLogistics, stage) {
      if (toSpecs === state.toSpecs && toLogistics === state.toLogistics && stage === state.stage) return;
      state = { toSpecs: toSpecs, toLogistics: toLogistics, stage: stage };
      stageEl.style.setProperty("--to-specs", toSpecs.toFixed(4));
      stageEl.style.setProperty("--to-logistics", toLogistics.toFixed(4));
      if (stageEl.getAttribute("data-stage") !== stage) stageEl.setAttribute("data-stage", stage);
      onChange({ toSpecs: toSpecs, toLogistics: toLogistics, stage: stage });
    }

    function update() {
      ticking = false;
      if (flow.matches) {
        publish(0, 0, "flow");
        return;
      }
      var m = measure();
      if (!(m.move > 0)) {
        publish(0, 0, STAGES[0]);
        return;
      }
      var toSpecs = ease((m.scrolled - m.hold) / m.move);
      var toLogistics = ease((m.scrolled - 2 * m.hold - m.move) / m.move);
      var stage = toLogistics >= 0.5 ? STAGES[2] : toSpecs >= 0.5 ? STAGES[1] : STAGES[0];
      publish(toSpecs, toLogistics, stage);
    }

    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }

    // html's own scroll-behavior: smooth carries this (and the
    // reduced-motion block in css/style.css turns it off).
    function scrollToStage(index) {
      if (flow.matches) return;
      measure();
      var top = stops[Math.max(0, Math.min(2, index))];
      window.scrollTo({ top: Math.max(0, Math.round(top)), left: 0 });
    }

    stageEl.addEventListener("focusin", function (e) {
      if (flow.matches) return;
      if (!e.target.matches(":focus-visible")) return;
      var owner = e.target.closest("[data-stage-owner]");
      if (!owner) return;
      // One stage, or several (space apart): inside one of them, nowhere to go.
      var owned = owner.getAttribute("data-stage-owner").split(/\s+/);
      if (owned.indexOf(state.stage) !== -1) return;
      var index = STAGES.indexOf(owned[0]);
      if (index !== -1) scrollToStage(index);
    });

    /* ---- looping ------------------------------------------------------- */

    // A gesture only counts as fresh once the page has been still for this
    // long: a trackpad's momentum goes on firing wheel events after the page
    // has reached the end, and must not carry straight on into the loop.
    var LOOP_QUIET_MS = 300;
    var LOOP_SWIPE_PX = 36;
    var lastActivity = 0;
    var looping = false;
    var touchY = null;

    function atEnd() {
      return !flow.matches && state.stage === "logistics" &&
        window.pageYOffset >= document.documentElement.scrollHeight - window.innerHeight - 2;
    }

    // The loop: everything fades to the background (the veil class, a fade
    // the CSS owns), the page is taken to the top while nothing shows, and
    // the veil lifts, the first stage fading back in. Straight to the top
    // under reduced motion.
    var VEIL_MS = 550;
    function loop() {
      if (looping) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        return;
      }
      looping = true;
      stageEl.classList.add("is-veiled");
      setTimeout(function () {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        update();
        requestAnimationFrame(function () {
          stageEl.classList.remove("is-veiled");
          setTimeout(function () { looping = false; }, VEIL_MS);
        });
      }, VEIL_MS);
    }

    // Anything that moves or tries to move the page restarts the quiet
    // clock; a gesture at the end counts only if the clock had run out
    // before it began.
    function freshGesture() {
      var now = performance.now();
      var fresh = now - lastActivity > LOOP_QUIET_MS;
      lastActivity = now;
      return fresh;
    }

    window.addEventListener("wheel", function (e) {
      var fresh = freshGesture();
      if (e.deltaY > 0 && fresh && atEnd()) loop();
    }, { passive: true });
    window.addEventListener("touchstart", function (e) {
      touchY = e.touches.length === 1 ? e.touches[0].clientY : null;
    }, { passive: true });
    window.addEventListener("touchmove", function (e) {
      if (touchY === null || !atEnd()) return;
      if (touchY - e.touches[0].clientY > LOOP_SWIPE_PX) {
        touchY = null;
        loop();
      }
    }, { passive: true });
    window.addEventListener("keydown", function (e) {
      var typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
      var down = e.key === "ArrowDown" || e.key === "PageDown" || e.key === "End" || (e.key === " " && !typing);
      if (typing || !down) return;
      var fresh = freshGesture();
      if (fresh && atEnd()) {
        e.preventDefault();
        loop();
      }
    });
    // The page moving by itself (the scroll of an earlier gesture, a loop)
    // is activity too.
    window.addEventListener("scroll", function () { lastActivity = performance.now(); }, { passive: true });

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    if (typeof flow.addEventListener === "function") flow.addEventListener("change", requestUpdate);
    // A restored scroll position (a reload part way down, Back) lands
    // straight in its stage.
    window.addEventListener("pageshow", requestUpdate);
    update();

    return { scrollToStage: scrollToStage };
  }

  window.EmjiveProductStages = { mount: mount };
})();
