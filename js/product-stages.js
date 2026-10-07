/* ==========================================================================
   em·ji·ve — the product page's two stages
   product.html's show is one tall track (.product-stage) holding one sticky
   stage (.product-stage__pin): scrolling down the track doesn't move the
   page, it moves the show along — presentation (description, carousel,
   metal picker), then specs (the model as a wireframe with its dimensions, a
   size field, the printing technology, the cost breakdown, shipping and
   returns). Free scrub, no snapping, and not linear: each stage is a stretch
   of scrolling in which the show browses (it goes up by the room its stage
   needs, see below), and the transition between the two is eased at both
   ends, so the page eases out of one stage and into the next. The track's
   length is the two stretches plus the transition; their proportion is
   --hold-ratio in css/style.css (a stretch is that share of the transition).

   window.EmjiveProductStages.mount(stageEl, { onChange }) reads the track's
   position on every scroll frame (the technique series/bones/hero.js uses
   for the homepage wipe) and publishes one eased number, 0 to 1:

     --to-specs       presentation -> specs

   as a custom property on the track — css/style.css fades everything from
   it — and --leave, 0 to 1, how far presentation's things have gone: it is
   linear in the scroll and starts with the very first pixel of it (not once
   the first stretch is over), and ends where --to-specs reaches --t0, where
   presentation's fade used to end (so everything after that is as it was) —
   and two more for the room to browse each stage: --browse-0 and
   --browse-1, 0 to 1 each, how far through that stage's stretch of scrolling
   the page is (0 before it, 1 from its end on) — css/style.css makes the show
   go up by that much of the room it has, and back down as the next stage
   comes in — plus data-stage (the nearest stage: "presentation" or "specs";
   "flow" on a screen too short to pin the stage, where the page is laid out
   as a plain column and none of this runs), and calls
   onChange({ toSpecs, leave, along, stage }) when they change, for what CSS
   can't do (js/product.js: the model, the carousel lock). `along`, 0 to 1,
   is how far the page is through the first stretch and the transition
   together, linear in the scroll from the first pixel: the model's rise to its
   place in specs runs on it.

   Returns { scrollToStage(index) }. Focus moving into an element marked
   data-stage-owner="presentation|specs" (or two, space apart) while another
   stage is showing scrolls to that one (the first), so the keyboard can reach
   everything — but only focus a keyboard put there (:focus-visible). A click
   on the model focuses the carousel's viewport (a tab stop) without any such
   intent, and used to throw the page back to the stage that viewport belongs
   to.

   The show loops: scrolling on at the very end of specs — a fresh wheel
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

  var STAGES = ["presentation", "specs"];

  // A stretch's entry: the show starts browsing from rest, speeding up over
  // the first third of the screen's height of scrolling and going on at a
  // constant pace after — the pace where it has got to, so there is no step in
  // the speed (the transition before it has come to rest, and a browse at full
  // pace from the first pixel was an abrupt start). `a` is the ramp's share of
  // the stretch (the third of the screen over the stretch's length, at most
  // all of it). Reaches 1 at u = 1, and is 0 at 0.
  var ENTRY_SCREENS = 1 / 3;
  // How fast the show browses once up to speed: 15px up for every 24px
  // scrolled. The second stage's stretch is then as long as it takes to cover
  // its room at that pace (plus the ramp), whatever the room is: the track is
  // longer for a taller column (--end-hold, set below), instead of the show
  // going faster to make it in a fixed stretch.
  var BROWSE_PACE = 15 / 24;
  // The second stretch starts before the transition ends, by this many
  // ramps (none: the model lands in its place from above as the transition
  // ends, and browsing takes it up from there).
  var LEAD_RAMPS = 0;
  function entry(u, a) {
    var t = clamp01(u);
    var y = t < a ? (t * t) / (2 * a) : t - a / 2;
    return y / (1 - a / 2);
  }

  // The u that ease(u) = y: ease is increasing, so bisect.
  function invEase(y) {
    var lo = 0;
    var hi = 1;
    for (var i = 0; i < 30; i++) {
      var mid = (lo + hi) / 2;
      if (ease(mid) < y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

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
    var state = { toSpecs: -1, leave: -1, along: -1, stage: "", browse: "" };
    // Where each stage sits, in page scroll, as last measured.
    var stops = [0, 0];

    // The screen's height as the CSS pin counts it — the small viewport
    // (svh), which stays the same while the browser's toolbars come and go.
    // window.innerHeight does not: on iOS Safari it changes as the toolbar
    // collapses with the scrolling itself, which would stretch or shrink
    // anything measured in screens (the entry's ramp) in the middle of a
    // scroll. vh is the fallback (the large viewport on iOS: constant too).
    var screenProbe = document.createElement("div");
    screenProbe.setAttribute("aria-hidden", "true");
    screenProbe.style.cssText = "position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none";
    document.body.appendChild(screenProbe);
    function screenPx() {
      return screenProbe.offsetHeight || window.innerHeight;
    }
    // --room-0, the first stage's room (the two bars and 4rem), in pixels.
    var roomProbe = document.createElement("div");
    roomProbe.setAttribute("aria-hidden", "true");
    roomProbe.style.cssText = "position:absolute;width:0;height:var(--room-0);visibility:hidden;pointer-events:none";
    stageEl.appendChild(roomProbe);

    // The second stretch's length in scroll, in pixels, as last set on the
    // track (--end-hold; 0: not set, the track's own, as long as the first) —
    // after the transition, not counting the ramp's length it has started
    // before it (BROWSE_PACE's note, above).
    // The room it has to cover is what js/product.js fits (--browse-room), and
    // never less than the first stage's; at BROWSE_PACE after the ramp (which
    // covers what a ramp of that length does: half its length at full pace).
    var endHold = 0;
    function syncEndHold() {
      var want = 0;
      if (!flow.matches) {
        var room = Math.max(roomProbe.offsetHeight, parseFloat(getComputedStyle(stageEl).getPropertyValue("--browse-room")) || 0);
        var ramp = screenPx() * ENTRY_SCREENS;
        want = Math.max(ramp / 2, room / BROWSE_PACE + ramp / 2 - ramp * LEAD_RAMPS);
      }
      if (Math.abs(want - endHold) < 0.5) return;
      endHold = want;
      if (want > 0) stageEl.style.setProperty("--end-hold", want.toFixed(1) + "px");
      else stageEl.style.removeProperty("--end-hold");
    }

    // How far the track has been scrolled past the pin's stick point, in pixels.
    function scrolledPx() {
      var stickAt = parseFloat(getComputedStyle(pin).top) || 0;
      return stickAt - stageEl.getBoundingClientRect().top;
    }

    function measure() {
      var scrolled = scrolledPx();
      var trackStart = window.pageYOffset - scrolled;
      // hold, transition, hold.
      var ratio = parseFloat(getComputedStyle(stageEl).getPropertyValue("--hold-ratio"));
      if (!(ratio >= 0)) ratio = 0.5;
      var travel = Math.max(0, stageEl.offsetHeight - pin.offsetHeight);
      var move;
      var hold2;
      if (endHold > 0) {
        // The end stretch is its own length (syncEndHold): the rest is the
        // first stretch and the transition, in their ratio.
        move = Math.max(0, travel - endHold) / (ratio + 1);
        hold2 = endHold;
      } else {
        move = travel / (2 * ratio + 1);
        hold2 = ratio * move;
      }
      var hold = ratio * move;
      stops = [trackStart, trackStart + hold + move];
      return { scrolled: scrolled, hold: hold, move: move, hold2: hold2 };
    }

    function publish(toSpecs, stage, browse, leave, along) {
      var key = browse.join(",");
      if (toSpecs === state.toSpecs && leave === state.leave && along === state.along && stage === state.stage && key === state.browse) return;
      state = { toSpecs: toSpecs, leave: leave, along: along, stage: stage, browse: key };
      stageEl.style.setProperty("--to-specs", toSpecs.toFixed(4));
      stageEl.style.setProperty("--leave", leave.toFixed(4));
      for (var k = 0; k < 2; k++) stageEl.style.setProperty("--browse-" + k, browse[k].toFixed(4));
      if (stageEl.getAttribute("data-stage") !== stage) stageEl.setAttribute("data-stage", stage);
      onChange({ toSpecs: toSpecs, leave: leave, along: along, stage: stage });
    }

    function update() {
      ticking = false;
      if (flow.matches) {
        publish(0, "flow", [0, 0], 0, 0);
        return;
      }
      syncEndHold();
      var m = measure();
      if (!(m.move > 0)) {
        publish(0, STAGES[0], [0, 0], 0, 0);
        return;
      }
      var toSpecs = ease((m.scrolled - m.hold) / m.move);
      var stage = toSpecs >= 0.5 ? STAGES[1] : STAGES[0];
      // Room to browse each stage: how far through its stretch of scrolling
      // the page is (each stretch is the hold before the stage's own
      // transition out; the last is the one at the end).
      var s = m.scrolled;
      function through(from, length) { return length > 0 ? clamp01((s - from) / length) : 1; }
      // Presentation's things start going with the first pixel of scrolling,
      // linearly, and are gone where the transition has reached --t0 (set by
      // js/product.js from where the model is on screen).
      var t0 = parseFloat(getComputedStyle(stageEl).getPropertyValue("--t0"));
      if (!(t0 > 0)) t0 = 0.3;
      var gone = m.hold + m.move * invEase(Math.min(t0, 1));
      var leave = gone > 0 ? clamp01(m.scrolled / gone) : 0;
      // The second stretch begins one ramp before the transition ends, and
      // runs on to the end of the track.
      var lead = m.hold2 > 0 ? Math.min(screenPx() * ENTRY_SCREENS * LEAD_RAMPS, m.move / 2) : 0;
      var length = m.hold2 + lead;
      var ramp = length > 0 ? Math.min(1, (screenPx() * ENTRY_SCREENS) / length) : 1;
      publish(toSpecs, stage, [through(0, m.hold), entry(through(m.hold + m.move - lead, length), ramp)], leave, clamp01(m.scrolled / (m.hold + m.move)));
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
      var top = stops[Math.max(0, Math.min(1, index))];
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
      return !flow.matches && state.stage === "specs" &&
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
