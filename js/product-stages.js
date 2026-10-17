/* ==========================================================================
   em·ji·ve — the product page's three stages
   product.html's show is one tall track (.product-stage) holding one sticky
   stage (.product-stage__pin): scrolling down the track doesn't move the
   page, it moves the show along — inspiration (the description and the
   photos, one under the other), then design (the model, the metal picker and
   the options of a product with several designs), then specs (the model in
   grey inside its dimensioned box, a size field, the printing technology, the
   cost breakdown, shipping and returns). Free scrub, no snapping, and not
   linear: each stage is a stretch of scrolling in which the show browses (it
   goes up by the room its stage needs, see below), and the transitions
   between them are eased at both ends, so the page eases out of one stage and
   into the next.

   The track, in order: the inspiration stretch (as long as it takes to browse
   the feed at FEED_PACE, --feed-hold below), the transition to design
   (--stage-step-in in css/style.css), the design stretch, the transition to
   specs (--stage-step) and the specs stretch (--end-hold below); the design
   stretch is --hold-ratio of the transition after it, which is set below
   (syncDesignHold) so that it is as long as it takes to browse design's room.

   window.EmjiveProductStages.mount(stageEl, { onChange }) reads the track's
   position on every scroll frame (the technique series/bones/hero.js uses
   for the homepage wipe) and publishes, as custom properties on the track
   (css/style.css fades everything from them), two eased numbers, 0 to 1:

     --to-design      inspiration -> design
     --to-specs       design -> specs

   and --leave, 0 to 1, how far design's things have gone on the way to
   specs: linear in the scroll from the very first pixel of the design
   stretch (not once it is over), ending where --to-specs reaches --t0 (set
   by js/product.js) — and, for the room to browse each stage, --browse-0,
   --browse-1 and --browse-2, 0 to 1 each, how far through that stage's
   stretch of scrolling the page is (0 before it, 1 from its end on) —
   css/style.css makes the show (or the feed) go up by that much of the room
   it has. Plus data-stage, the nearest stage ("inspiration", "design" or
   "specs"; "flow" on a screen too short to pin the stage, where the page is
   laid out as a plain column and none of this runs), and two classes for
   what CSS can't fade: .is-feed-gone once the feed has faded out
   (FEED_GONE_AT) and .is-design-out until design's things start to come in
   (DESIGN_FROM) — what is out of sight takes no taps and shows no loader.
   It calls onChange({ toDesign, toSpecs, leave, along, ramp, stage }) when
   they change, for what CSS can't do (js/product.js: the model). `along`, 0
   to 1, is how far the page is through the design stretch and the transition
   to specs together, linear in the scroll from the stretch's first pixel: the
   model's rise to its place in specs runs on it. `ramp` is the share of the
   design stretch its browsing eases in over (see entry(), below; the model's
   rise follows the same curve).

   Returns { scrollToStage(index), restart(), update() }. Focus moving into an element marked
   data-stage-owner="inspiration|design|specs" (or several, space apart)
   while another stage is showing scrolls to that one (the first), so the
   keyboard can reach everything — but only focus a keyboard put there
   (:focus-visible). A click on the model focuses its viewer without any such
   intent.

   The show doesn't loop: at the end of specs the page just ends, and a
   "Back to photos" button there (js/product.js) calls restart(), which takes
   the show back to the start — everything fades out to the page's background
   (.is-veiled, css/style.css), the page jumps to the top while nothing shows,
   and the first stage fades back in.
   ========================================================================== */

(function () {
  "use strict";

  // Below this height there's no room to pin a title, the model and the
  // controls in one screen (a phone on its side): the stage is laid out as a
  // plain column instead. Same query as the "flow" block in css/style.css.
  var FLOW_QUERY = "(max-height: 560px)";

  var STAGES = ["inspiration", "design", "specs"];

  // The feed goes up one for one with the scrolling — it is read like a
  // page — easing to rest over its last ramp (ENTRY_SCREENS) before the
  // transition to design: a feed stopping dead at full speed felt like
  // hitting a wall. A product with nothing to browse (the description alone,
  // no photos) still gets FEED_MIN_SCREENS of scrolling in its first stage.
  var FEED_PACE = 1;
  var FEED_MIN_SCREENS = 0.4;
  // How far through the transition to design the feed is gone, and from where
  // design's things come in (css/style.css --i-out and --d-in: keep them the
  // same numbers).
  var FEED_GONE_AT = 0.45;
  var DESIGN_FROM = 0.55;

  // A stretch's entry: the show starts browsing from rest, speeding up over
  // the first third of the screen's height of scrolling and going on at a
  // constant pace after — the pace where it has got to, so there is no step in
  // the speed (the transition before it has come to rest, and a browse at full
  // pace from the first pixel was an abrupt start). `a` is the ramp's share of
  // the stretch (the third of the screen over the stretch's length, at most
  // all of it). Reaches 1 at u = 1, and is 0 at 0. The design stretch and the
  // specs stretch both begin with it.
  var ENTRY_SCREENS = 1 / 3;
  // The least the design stretch is, in screens: a rest for the model, even
  // when everything of design stands clear of the bars already.
  var DESIGN_MIN_SCREENS = 0.25;
  // How fast the show browses the specs column once up to speed: 15px up for
  // every 24px scrolled. The specs stretch is then as long as it takes to
  // cover its room at that pace (plus the ramp), whatever the room is: the
  // track is longer for a taller column (--end-hold, set below), instead of
  // the show going faster to make it in a fixed stretch.
  var BROWSE_PACE = 15 / 24;
  // The specs stretch starts before the transition ends, by this many
  // ramps (none: the model lands in its place from above as the transition
  // ends, and browsing takes it up from there).
  var LEAD_RAMPS = 0;
  function entry(u, a) {
    var t = clamp01(u);
    var y = t < a ? (t * t) / (2 * a) : t - a / 2;
    return y / (1 - a / 2);
  }
  // The same ramp at the other end: full pace from the first pixel, easing to
  // rest over the last `a` of the stretch (the feed's).
  function exit(u, a) {
    return 1 - entry(1 - u, a);
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

  // The screen's height as the CSS pin counts it — the small viewport (svh),
  // which stays the same while the browser's toolbars come and go.
  // window.innerHeight does not: on iOS Safari it changes as the toolbar
  // collapses with the scrolling itself, which would stretch or shrink
  // anything measured in screens (the ramps, and js/product.js's timing of
  // the fades from where the model is on screen — the metal picker among
  // them) in the middle of a scroll. vh is the fallback (the large viewport on
  // iOS: constant too). Shared with js/product.js.
  var screenProbe = null;
  function screenPx() {
    if (!screenProbe) {
      screenProbe = document.createElement("div");
      screenProbe.setAttribute("aria-hidden", "true");
      screenProbe.style.cssText = "position:fixed;top:0;left:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none";
      document.body.appendChild(screenProbe);
    }
    return screenProbe.offsetHeight || window.innerHeight;
  }

  function mount(stageEl, options) {
    var pin = stageEl.querySelector(".product-stage__pin");
    var onChange = (options && options.onChange) || function () {};
    var flow = window.matchMedia(FLOW_QUERY);
    var ticking = false;
    var state = { toDesign: -1, toSpecs: -1, leave: -1, along: -1, ramp: -1, stage: "", browse: "" };
    // Where each stage sits, in page scroll, as last measured.
    var stops = [0, 0, 0];

    // Lengths the CSS holds, in pixels, read off probes as tall as they are:
    // --room-0, the least a stage's browsing takes the show up by (the two
    // bars and 4rem), and --stage-step-in, the transition to design.
    function probe(height) {
      var el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:absolute;width:0;height:" + height + ";visibility:hidden;pointer-events:none";
      stageEl.appendChild(el);
      return el;
    }
    var roomProbe = probe("var(--room-0)");
    var designRoomProbe = probe("var(--room-1)");
    var stepProbe = probe("var(--stage-step)");
    var stepInProbe = probe("var(--stage-step-in)");

    // The inspiration stretch's length in scroll, in pixels, as last set on
    // the track (--feed-hold): the room the feed has to go up by (--feed-room,
    // fitted by js/product.js) at FEED_PACE, plus the half of the ramp it
    // eases out over (which covers what a ramp does: half its length at full
    // pace) — or FEED_MIN_SCREENS when there is nothing to browse.
    var feedHold = 0;
    function syncFeedHold() {
      var want = 0;
      if (!flow.matches) {
        var room = parseFloat(getComputedStyle(stageEl).getPropertyValue("--feed-room")) || 0;
        var ramp = screenPx() * ENTRY_SCREENS;
        want = room > 0.5 ? room / FEED_PACE + ramp / 2 : screenPx() * FEED_MIN_SCREENS;
      }
      if (Math.abs(want - feedHold) < 0.5) return;
      feedHold = want;
      if (want > 0) stageEl.style.setProperty("--feed-hold", want.toFixed(1) + "px");
      else stageEl.style.removeProperty("--feed-hold");
    }

    // The design stretch's length: the room design has to cover (--room-1,
    // fitted by js/product.js) at BROWSE_PACE, plus the half of the ramp it
    // eases in over, and never less than DESIGN_MIN_SCREENS. It is set as
    // --hold-ratio, its share of the transition to specs (--stage-step), which
    // the track's height and every place that reads the stretch go by.
    var holdRatio = -1;
    function syncDesignHold() {
      var want = -1;
      if (!flow.matches) {
        var step = stepProbe.offsetHeight;
        if (step > 0) {
          var ramp = screenPx() * ENTRY_SCREENS;
          want = Math.max(screenPx() * DESIGN_MIN_SCREENS, designRoomProbe.offsetHeight / BROWSE_PACE + ramp / 2) / step;
        }
      }
      if (Math.abs(want - holdRatio) < 0.0005) return;
      holdRatio = want;
      if (want >= 0) stageEl.style.setProperty("--hold-ratio", want.toFixed(4));
      else stageEl.style.removeProperty("--hold-ratio");
    }

    // The specs stretch's length in scroll, in pixels, as last set on the
    // track (--end-hold; 0: not set, the track's own, as long as the design
    // stretch) — after the transition, not counting the ramp's length it has
    // started before it (BROWSE_PACE's note, above).
    // The room it has to cover is what js/product.js fits (--browse-room), and
    // never less than --room-0; at BROWSE_PACE after the ramp (which
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
      // The inspiration stretch and the transition to design come first; the
      // rest is design's stretch, the transition to specs and specs' stretch.
      var feed = feedHold;
      var stepIn = stepInProbe.offsetHeight;
      var offset = feed + stepIn;
      var ratio = parseFloat(getComputedStyle(stageEl).getPropertyValue("--hold-ratio"));
      if (!(ratio >= 0)) ratio = 0.5;
      var travel = Math.max(0, stageEl.offsetHeight - pin.offsetHeight - offset);
      var move;
      var hold2;
      if (endHold > 0) {
        // The end stretch is its own length (syncEndHold): the rest is the
        // design stretch and the transition, in their ratio.
        move = Math.max(0, travel - endHold) / (ratio + 1);
        hold2 = endHold;
      } else {
        move = travel / (2 * ratio + 1);
        hold2 = ratio * move;
      }
      var hold = ratio * move;
      stops = [trackStart, trackStart + offset, trackStart + offset + hold + move];
      return { scrolled: scrolled, feed: feed, stepIn: stepIn, offset: offset, hold: hold, move: move, hold2: hold2 };
    }

    function publish(next) {
      var key = next.browse.join(",");
      if (next.toDesign === state.toDesign && next.toSpecs === state.toSpecs && next.leave === state.leave &&
          next.along === state.along && next.ramp === state.ramp && next.stage === state.stage && key === state.browse) return;
      state = { toDesign: next.toDesign, toSpecs: next.toSpecs, leave: next.leave, along: next.along, ramp: next.ramp, stage: next.stage, browse: key };
      stageEl.style.setProperty("--to-design", next.toDesign.toFixed(4));
      stageEl.style.setProperty("--to-specs", next.toSpecs.toFixed(4));
      stageEl.style.setProperty("--leave", next.leave.toFixed(4));
      for (var k = 0; k < 3; k++) stageEl.style.setProperty("--browse-" + k, next.browse[k].toFixed(4));
      if (stageEl.getAttribute("data-stage") !== next.stage) stageEl.setAttribute("data-stage", next.stage);
      var inFlow = next.stage === "flow";
      stageEl.classList.toggle("is-feed-gone", !inFlow && next.toDesign >= FEED_GONE_AT);
      // Where design's things start to come in is the page's (--d-from, set by
      // js/product.js from where the band is by the title bar); DESIGN_FROM
      // until it has.
      var dFrom = parseFloat(stageEl.style.getPropertyValue("--d-from"));
      stageEl.classList.toggle("is-design-out", !inFlow && next.toDesign <= (dFrom > 0 ? dFrom : DESIGN_FROM));
      stageEl.classList.toggle("is-model-out", !inFlow && next.toDesign <= 0);
      onChange({ toDesign: next.toDesign, toSpecs: next.toSpecs, leave: next.leave, along: next.along, ramp: next.ramp, stage: next.stage });
    }

    function update() {
      ticking = false;
      if (flow.matches) {
        publish({ toDesign: 1, toSpecs: 0, stage: "flow", browse: [0, 0, 0], leave: 0, along: 0, ramp: 1 });
        return;
      }
      syncFeedHold();
      syncDesignHold();
      syncEndHold();
      var m = measure();
      var s = m.scrolled;
      var screenRamp = screenPx() * ENTRY_SCREENS;
      // Inspiration: the feed browses, then fades out as design comes in.
      var browse0 = m.feed > 0 ? exit(clamp01(s / m.feed), Math.min(1, screenRamp / m.feed)) : 1;
      var toDesign = m.stepIn > 0 ? ease((s - m.feed) / m.stepIn) : (s >= m.feed ? 1 : 0);
      // From here on, everything counts from the first pixel of the design
      // stretch.
      var s1 = s - m.offset;
      if (!(m.move > 0)) {
        publish({ toDesign: toDesign, toSpecs: 0, stage: STAGES[toDesign < 0.5 ? 0 : 1], browse: [browse0, 0, 0], leave: 0, along: 0, ramp: 1 });
        return;
      }
      var toSpecs = ease((s1 - m.hold) / m.move);
      var stage = toDesign < 0.5 ? STAGES[0] : toSpecs >= 0.5 ? STAGES[2] : STAGES[1];
      // Room to browse each stage: how far through its stretch of scrolling
      // the page is (each stretch is the hold before the stage's own
      // transition out; the last is the one at the end).
      function through(from, length) { return length > 0 ? clamp01((s1 - from) / length) : 1; }
      // Design's things start going with the first pixel of its stretch,
      // linearly, and are gone where the transition has reached --t0 (set by
      // js/product.js from where the model is on screen).
      var t0 = parseFloat(getComputedStyle(stageEl).getPropertyValue("--t0"));
      if (!(t0 > 0)) t0 = 0.3;
      var gone = m.hold + m.move * invEase(Math.min(t0, 1));
      var leave = gone > 0 ? clamp01(s1 / gone) : 0;
      // The specs stretch begins LEAD_RAMPS ramps before the transition ends,
      // and runs on to the end of the track.
      var lead = m.hold2 > 0 ? Math.min(screenRamp * LEAD_RAMPS, m.move / 2) : 0;
      var length = m.hold2 + lead;
      var ramp = length > 0 ? Math.min(1, screenRamp / length) : 1;
      // Design's stretch eases in the same way as specs'.
      var ramp1 = m.hold > 0 ? Math.min(1, screenRamp / m.hold) : 1;
      publish({
        toDesign: toDesign,
        toSpecs: toSpecs,
        stage: stage,
        browse: [browse0, entry(through(0, m.hold), ramp1), entry(through(m.hold + m.move - lead, length), ramp)],
        leave: leave,
        along: clamp01(s1 / (m.hold + m.move)),
        ramp: ramp1
      });
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
      var top = stops[Math.max(0, Math.min(STAGES.length - 1, index))];
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

    /* ---- back to the start --------------------------------------------- */

    // Everything fades to the background (the veil class, a fade the CSS
    // owns), the page is taken to the top while nothing shows, and the veil
    // lifts, the first stage fading back in. Straight to the top under
    // reduced motion.
    var VEIL_MS = 550;
    var restarting = false;
    function restart() {
      if (restarting) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        return;
      }
      restarting = true;
      stageEl.classList.add("is-veiled");
      setTimeout(function () {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        update();
        requestAnimationFrame(function () {
          stageEl.classList.remove("is-veiled");
          setTimeout(function () { restarting = false; }, VEIL_MS);
        });
      }, VEIL_MS);
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    if (typeof flow.addEventListener === "function") flow.addEventListener("change", requestUpdate);
    // A restored scroll position (a reload part way down, Back) lands
    // straight in its stage.
    window.addEventListener("pageshow", requestUpdate);
    update();

    return { scrollToStage: scrollToStage, restart: restart, update: requestUpdate };
  }

  window.EmjiveProductStages = { mount: mount, screenPx: screenPx, entry: entry };
})();
