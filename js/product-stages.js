/* ==========================================================================
   em·ji·ve — the product page's three stages
   product.html's show is one tall track (.product-stage) holding one sticky
   stage (.product-stage__pin): scrolling down the track doesn't move the
   page, it moves the show along — presentation (description, carousel,
   metal picker), then specs (the model as a wireframe with its dimensions,
   the cost breakdown, a size field), then logistics (shipping and returns).
   Free scrub, no snapping, but not linear: each transition lingers at both
   ends and goes through its middle quickly, so the page eases out of one
   stage and into the next.

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
   data-stage-owner="presentation|specs|logistics" while another stage is
   showing scrolls to that one, so the keyboard can reach everything — but
   only focus a keyboard put there (:focus-visible). A click on the model
   focuses the carousel's viewport (a tab stop) without any such intent, and
   used to throw the page back to the stage that viewport belongs to.

   The show loops: scrolling on at the very end of logistics — a fresh wheel
   gesture, swipe or key, never the tail of the one that got there — scrolls
   back up to the start, the whole show rewinding.
   ========================================================================== */

(function () {
  "use strict";

  // Below this height there's no room to pin a title, a carousel and the
  // controls in one screen (a phone on its side): the stage is laid out as a
  // plain column instead. Same query as the "flow" block in css/style.css.
  var FLOW_QUERY = "(max-height: 560px)";

  // The share of each transition's scroll spent at either end with nothing
  // moving yet — the dwell that makes a stage feel like a place.
  var DWELL = 0.15;

  var STAGES = ["presentation", "specs", "logistics"];

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  // Zero speed and zero acceleration at both ends (Perlin's smootherstep).
  function ease(u) {
    var t = clamp01((u - DWELL) / (1 - 2 * DWELL));
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
      var travel = Math.max(0, stageEl.offsetHeight - pin.offsetHeight);
      var step = travel / 2;
      // The page can end a little short of the track's own end — iOS
      // Safari's toolbar collapsing makes the window taller than the
      // smallest viewport the track is sized from — so the last stage is
      // reached at whichever comes first: the track's end or the page's.
      var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      var end = Math.max(step + 1, Math.min(travel, maxScroll - trackStart));
      stops = [trackStart, trackStart + step, trackStart + end];
      return { scrolled: scrolled, step: step, end: end };
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
      if (!(m.step > 0)) {
        publish(0, 0, STAGES[0]);
        return;
      }
      var toSpecs = ease(m.scrolled / m.step);
      var toLogistics = ease((m.scrolled - m.step) / (m.end - m.step));
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
      var index = STAGES.indexOf(owner.getAttribute("data-stage-owner"));
      if (index !== -1 && STAGES[index] !== state.stage) scrollToStage(index);
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

    function loop() {
      if (looping) return;
      looping = true;
      window.scrollTo({ top: 0, left: 0 });
      // Done once back at the top, or give up after the longest a smooth
      // scroll takes.
      var until = performance.now() + 3000;
      (function wait() {
        if (window.pageYOffset < 2 || performance.now() > until) looping = false;
        else requestAnimationFrame(wait);
      })();
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
