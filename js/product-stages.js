// The product page's three-stage show: a tall track (.product-stage) holding
// one sticky stage, where scrolling steps inspiration (description and photo
// feed) -> design (model, metal, design options) -> specs (blueprint model,
// size, dimensions, costs). Each stage is a stretch the show browses through,
// with eased transitions between them.
//
// Track order: inspiration stretch (--feed-hold), transition (--stage-step-in),
// design stretch (--hold-ratio of the next transition), transition
// (--stage-step), specs stretch (--end-hold). The stretches are sized here
// from the room each stage needs.
//
// window.EmjiveProductStages.mount(stageEl, { onChange }) publishes on the track:
//   --to-design, --to-specs   eased 0..1 transitions
//   --leave                   0..1, linear from the design stretch's start to --to-specs = --t0
//   --browse-0/1/2            0..1 through each stage's stretch
//   data-stage                "inspiration" | "design" | "specs" | "flow" (too short to pin)
//   .is-feed-gone, .is-design-out, .is-model-out   for what CSS can't fade
// and calls onChange({ toDesign, toSpecs, leave, along, ramp, stage }); `along`
// is linear through the design stretch and the transition to specs, `ramp`
// the design stretch's ease-in share.
// Returns { scrollToStage(index), restart(), update() }. Keyboard focus
// (:focus-visible) entering a data-stage-owner element of another stage
// scrolls there. restart() fades out, jumps to the top and fades back in.

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var clamp01 = H.clamp01;
  var ease = H.smootherstep;
  var invEase = H.invSmootherstep;

  // Too short to pin title, model and controls (a phone on its side): a plain
  // column instead. Same query as the "flow" block in css/style.css.
  var FLOW_QUERY = "(max-height: 560px)";

  var STAGES = ["inspiration", "design", "specs"];

  // The feed scrolls one for one, easing to rest over its last ramp before the
  // transition. With nothing to browse it still gets FEED_MIN_SCREENS.
  var FEED_PACE = 1;
  var FEED_MIN_SCREENS = 0.4;
  // Mirrors --i-out and --d-in in css/style.css.
  var FEED_GONE_AT = 0.45;
  var DESIGN_FROM = 0.55;

  // entry(u, a): browsing starts from rest, accelerating over the first ramp
  // (ENTRY_SCREENS of scroll, share `a` of the stretch) then constant pace,
  // without a speed step. entry(0) = 0, entry(1) = 1.
  var ENTRY_SCREENS = 1 / 3;
  // The design stretch's minimum, a rest for the model.
  var DESIGN_MIN_SCREENS = 0.25;
  // Specs browsing pace: 15px up per 24px scrolled. The track lengthens for a
  // taller column rather than browsing faster.
  var BROWSE_PACE = 15 / 24;
  // How many ramps the specs stretch starts before the transition ends.
  var LEAD_RAMPS = 0;
  function entry(u, a) {
    var t = clamp01(u);
    var y = t < a ? (t * t) / (2 * a) : t - a / 2;
    return y / (1 - a / 2);
  }
  // The mirror ramp: full pace, easing to rest over the last `a` (the feed's).
  function exit(u, a) {
    return 1 - entry(1 - u, a);
  }

  // The screen height as the pin counts it (svh), stable while the browser's
  // bars move; innerHeight changes mid-scroll on iOS. Shared with js/product.js.
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
    // Each stage's page scroll position, as last measured.
    var stops = [0, 0, 0];

    // CSS lengths in px, read off probes: --room-0 (minimum browse room),
    // --room-1, --stage-step, --stage-step-in.
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

    // Inspiration stretch (--feed-hold): --feed-room (js/product.js) at FEED_PACE
    // plus half the ramp, or FEED_MIN_SCREENS with nothing to browse.
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

    // Design stretch: --room-1 at BROWSE_PACE plus half the ramp, at least
    // DESIGN_MIN_SCREENS; set as --hold-ratio of --stage-step.
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

    // Specs stretch (--end-hold, 0 = unset): --browse-room (js/product.js), at
    // least --room-0, at BROWSE_PACE plus half the ramp.
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

    // Track scroll past the pin's stick point, in px.
    function scrolledPx() {
      var stickAt = parseFloat(getComputedStyle(pin).top) || 0;
      return stickAt - stageEl.getBoundingClientRect().top;
    }

    function measure() {
      var scrolled = scrolledPx();
      var trackStart = window.pageYOffset - scrolled;
      // Inspiration stretch and transition first; then design stretch, transition, specs stretch.
      var feed = feedHold;
      var stepIn = stepInProbe.offsetHeight;
      var offset = feed + stepIn;
      var ratio = parseFloat(getComputedStyle(stageEl).getPropertyValue("--hold-ratio"));
      if (!(ratio >= 0)) ratio = 0.5;
      var travel = Math.max(0, stageEl.offsetHeight - pin.offsetHeight - offset);
      var move;
      var hold2;
      if (endHold > 0) {
        // With --end-hold set, the rest splits between design stretch and transition by ratio.
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
      // --d-from (js/product.js, from the band's position) once set, else DESIGN_FROM.
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
      var browse0 = m.feed > 0 ? exit(clamp01(s / m.feed), Math.min(1, screenRamp / m.feed)) : 1;
      var toDesign = m.stepIn > 0 ? ease((s - m.feed) / m.stepIn) : (s >= m.feed ? 1 : 0);
      // From here, counted from the design stretch's first pixel.
      var s1 = s - m.offset;
      if (!(m.move > 0)) {
        publish({ toDesign: toDesign, toSpecs: 0, stage: STAGES[toDesign < 0.5 ? 0 : 1], browse: [browse0, 0, 0], leave: 0, along: 0, ramp: 1 });
        return;
      }
      var toSpecs = ease((s1 - m.hold) / m.move);
      var stage = toDesign < 0.5 ? STAGES[0] : toSpecs >= 0.5 ? STAGES[2] : STAGES[1];
      function through(from, length) { return length > 0 ? clamp01((s1 - from) / length) : 1; }
      // Design's controls leave linearly, gone where the transition reaches --t0
      // (js/product.js, from the model's position).
      var t0 = parseFloat(getComputedStyle(stageEl).getPropertyValue("--t0"));
      if (!(t0 > 0)) t0 = 0.3;
      var gone = m.hold + m.move * invEase(Math.min(t0, 1));
      var leave = gone > 0 ? clamp01(s1 / gone) : 0;
      var lead = m.hold2 > 0 ? Math.min(screenRamp * LEAD_RAMPS, m.move / 2) : 0;
      var length = m.hold2 + lead;
      var ramp = length > 0 ? Math.min(1, screenRamp / length) : 1;
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

    // Smooth via html's scroll-behavior (off under reduced motion).
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
      // Already in one of its stages: nowhere to go.
      var owned = owner.getAttribute("data-stage-owner").split(/\s+/);
      if (owned.indexOf(state.stage) !== -1) return;
      var index = STAGES.indexOf(owned[0]);
      if (index !== -1) scrollToStage(index);
    });

    /* ---- back to the start ---- */

    // The veil fade is CSS's; instant under reduced motion.
    var VEIL_MS = 550;
    var restarting = false;
    function restart() {
      if (restarting) return;
      if (H.reducedMotion.matches) {
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
    // A restored scroll lands straight in its stage.
    window.addEventListener("pageshow", requestUpdate);
    update();

    return { scrollToStage: scrollToStage, restart: restart, update: requestUpdate };
  }

  window.EmjiveProductStages = { mount: mount, screenPx: screenPx, entry: entry };
})();
