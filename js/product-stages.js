// The product page's two-stage show: a tall track (.product-stage) holding
// one sticky stage, where scrolling steps inspiration (description and museum
// wall) -> design (the model and its configuration: design options, metal,
// size, plan views; then the information). Each stage is a stretch the
// show browses through, with an eased transition between them.
//
// Track order: inspiration stretch (--feed-hold), transition
// (--stage-step-in), a rest (--design-rest), design stretch (--design-hold).
// The stretches are sized here from the room each stage needs.
//
// window.EmjiveProductStages.mount(stageEl, { onChange, steady }) publishes on the track:
//   --to-design               eased 0..1 transition
//   --browse-0                0..1 through the inspiration stretch
//   --design-browse           px the show is browsed up through the design
//                             stretch (in px, read with the room it covers,
//                             so a room changing never moves the show)
//   data-stage                "inspiration" | "design" | "flow" (too short to pin)
//   .is-feed-gone, .is-design-out, .is-model-out   for what CSS can't fade
// and calls onChange({ toDesign, stage }). While steady() (the vertical wall,
// scrolled along with the page) every change of pace is a smoothstep over
// STEADY_RAMP_SCREENS: the wall eases from its pace to rest at its end, then
// the band eases in from rest to the scroll's own pace (--stage-step-in,
// css/style.css), crossing the wall as it holds still.
// Returns { scrollToStage(index), update() }. Keyboard focus
// (:focus-visible) entering a data-stage-owner element of another stage
// scrolls there.

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var clamp01 = H.clamp01;
  var ease = H.smootherstep;

  // Too short to pin title, model and controls (a phone on its side): a plain
  // column instead. Same query as the "flow" block in css/style.css.
  var FLOW_QUERY = "(max-height: 560px)";

  var STAGES = ["inspiration", "design"];

  // Both stretches browse one px per px scrolled: the wall walked (sideways,
  // or up when turned vertical), easing to rest over its last ramp before the
  // transition, and design browsed up. The track lengthens for more room. With
  // nothing to browse the wall still gets FEED_MIN_SCREENS.
  var FEED_MIN_SCREENS = 0.4;
  // While steady, the length of each change of pace. Mirrored in
  // --stage-step-in's phone value (css/style.css).
  var STEADY_RAMP_SCREENS = 0.5;
  // Mirrors --i-out and --d-in in css/style.css.
  var FEED_GONE_AT = 0.45;
  var DESIGN_FROM = 0.55;

  // entry(u, a): browsing starts from rest, accelerating over the first ramp
  // (ENTRY_SCREENS of scroll, share `a` of the stretch) then constant pace,
  // without a speed step. entry(0) = 0, entry(1) = 1.
  var ENTRY_SCREENS = 1 / 3;
  // The design stretch's minimum, a rest at the end.
  var DESIGN_MIN_SCREENS = 0.25;
  function entry(u, a) {
    var t = clamp01(u);
    var y = t < a ? (t * t) / (2 * a) : t - a / 2;
    return y / (1 - a / 2);
  }
  // The mirror ramp: full pace, easing to rest over the last `a` (the feed's).
  function exit(u, a) {
    return 1 - entry(1 - u, a);
  }
  // Distance (in shares of its length) at t through a pace rising from 0 to 1
  // along a smoothstep, so neither end jolts. settle(1) = 1/2; the mirror,
  // 1 to 0, is t - settle(t).
  function settle(t) {
    var t3 = t * t * t;
    return t3 - (t3 * t) / 2;
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
    var steady = (options && options.steady) || function () { return false; };
    var flow = window.matchMedia(FLOW_QUERY);
    var ticking = false;
    var state = { toDesign: -1, stage: "", browse: "" };
    // --design-room in px as the design stretch was last sized from it.
    var designRoom = 0;
    // Each stage's page scroll position, as last measured.
    var stops = [0, 0];

    // CSS lengths in px, read off probes: --design-room, --stage-step-in, --design-rest.
    function probe(height) {
      var el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:absolute;width:0;height:" + height + ";visibility:hidden;pointer-events:none";
      stageEl.appendChild(el);
      return el;
    }
    var designRoomProbe = probe("var(--design-room)");
    var stepInProbe = probe("var(--stage-step-in)");
    var restProbe = probe("var(--design-rest)");

    // Inspiration stretch (--feed-hold): --feed-room (js/product.js) plus half
    // the ramp (none while steady), or FEED_MIN_SCREENS with nothing to browse.
    // While steady: the slow-down to rest takes the walk plus half its length.
    var feedHold = 0;
    var feedRoom = 0;
    var glideLen = 0;
    function syncFeedHold() {
      var want = 0;
      feedRoom = 0;
      glideLen = 0;
      if (!flow.matches) {
        var room = parseFloat(getComputedStyle(stageEl).getPropertyValue("--feed-room")) || 0;
        if (room > 0.5) feedRoom = room;
        if (feedRoom && steady()) {
          glideLen = Math.min(screenPx() * STEADY_RAMP_SCREENS, 2 * room);
          want = room + glideLen / 2;
        } else {
          var ramp = screenPx() * ENTRY_SCREENS;
          want = feedRoom ? room + ramp / 2 : screenPx() * FEED_MIN_SCREENS;
        }
      }
      if (Math.abs(want - feedHold) < 0.5) return;
      feedHold = want;
      if (want > 0) stageEl.style.setProperty("--feed-hold", want.toFixed(1) + "px");
      else stageEl.style.removeProperty("--feed-hold");
    }

    // Design stretch (--design-hold): --design-room (js/product.js) plus half
    // the ramp, at least DESIGN_MIN_SCREENS.
    var designHold = 0;
    function syncDesignHold() {
      var want = 0;
      designRoom = flow.matches ? 0 : designRoomProbe.offsetHeight;
      if (!flow.matches) {
        var ramp = screenPx() * ENTRY_SCREENS;
        want = Math.max(screenPx() * DESIGN_MIN_SCREENS, designRoom + ramp / 2);
      }
      if (Math.abs(want - designHold) < 0.5) return;
      designHold = want;
      if (want > 0) stageEl.style.setProperty("--design-hold", want.toFixed(1) + "px");
      else stageEl.style.removeProperty("--design-hold");
    }

    // While steady: px walked `s` into the inspiration stretch, one for one
    // until the slow-down to rest.
    function steadyWalk(s, feed) {
      var from = feed - glideLen;
      if (s <= from) return Math.max(0, s);
      var t = clamp01((s - from) / glideLen);
      return from + glideLen * (t - settle(t));
    }

    // While steady: the transition at `x` px into it, the band easing in
    // over the first STEADY_RAMP_SCREENS, then one for one.
    function steadyStep(x, stepIn) {
      var ramp = Math.min(screenPx() * STEADY_RAMP_SCREENS, stepIn);
      var d = x < ramp ? ramp * settle(x / ramp) : ramp / 2 + x - ramp;
      return clamp01(d / (stepIn - ramp / 2));
    }

    // Track scroll past the pin's stick point, in px.
    function scrolledPx() {
      var stickAt = parseFloat(getComputedStyle(pin).top) || 0;
      return stickAt - stageEl.getBoundingClientRect().top;
    }

    function measure() {
      var scrolled = scrolledPx();
      var trackStart = window.pageYOffset - scrolled;
      var feed = feedHold;
      var stepIn = stepInProbe.offsetHeight;
      var offset = feed + stepIn;
      var rest = restProbe.offsetHeight;
      // The design stretch is whatever the track has left past the rest.
      var hold = Math.max(0, stageEl.offsetHeight - pin.offsetHeight - offset - rest);
      stops = [trackStart, trackStart + offset];
      return { scrolled: scrolled, feed: feed, stepIn: stepIn, offset: offset, rest: rest, hold: hold };
    }

    function publish(next) {
      var key = next.browse.join(",");
      if (next.toDesign === state.toDesign && next.stage === state.stage && key === state.browse) return;
      state = { toDesign: next.toDesign, stage: next.stage, browse: key };
      stageEl.style.setProperty("--to-design", next.toDesign.toFixed(4));
      stageEl.style.setProperty("--browse-0", next.browse[0].toFixed(4));
      stageEl.style.setProperty("--design-browse", next.browse[1].toFixed(3) + "px");
      if (stageEl.getAttribute("data-stage") !== next.stage) stageEl.setAttribute("data-stage", next.stage);
      var inFlow = next.stage === "flow";
      stageEl.classList.toggle("is-feed-gone", !inFlow && next.toDesign >= FEED_GONE_AT);
      // --d-from (js/product.js, from the band's position) once set, else DESIGN_FROM.
      var dFrom = parseFloat(stageEl.style.getPropertyValue("--d-from"));
      stageEl.classList.toggle("is-design-out", !inFlow && next.toDesign <= (dFrom > 0 ? dFrom : DESIGN_FROM));
      stageEl.classList.toggle("is-model-out", !inFlow && next.toDesign <= 0);
      onChange({ toDesign: next.toDesign, stage: next.stage });
    }

    function update() {
      ticking = false;
      if (flow.matches) {
        publish({ toDesign: 1, stage: "flow", browse: [0, 0] });
        return;
      }
      syncFeedHold();
      syncDesignHold();
      var m = measure();
      var s = m.scrolled;
      var screenRamp = screenPx() * ENTRY_SCREENS;
      var even = glideLen > 0;
      var browse0 = 1;
      if (even) browse0 = clamp01(steadyWalk(Math.min(s, m.feed), m.feed) / feedRoom);
      else if (m.feed > 0) browse0 = exit(clamp01(s / m.feed), Math.min(1, screenRamp / m.feed));
      var x = Math.max(0, s - m.feed);
      var toDesign = m.stepIn > 0 ? (even ? steadyStep(x, m.stepIn) : ease(x / m.stepIn)) : (s >= m.feed ? 1 : 0);
      // Counted from the design stretch's first pixel, past the rest. On
      // the device's pixels: the show's translate (--design-browse) keeps
      // the plan views' hairlines sharp.
      var s1 = s - m.offset - m.rest;
      var browse1 = m.hold > 0 ? H.devicePx(designRoom * entry(clamp01(s1 / m.hold), Math.min(1, screenRamp / m.hold))) : 0;
      publish({ toDesign: toDesign, stage: STAGES[toDesign < 0.5 ? 0 : 1], browse: [browse0, browse1] });
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
      var owned = owner.getAttribute("data-stage-owner");
      if (owned === state.stage) return;
      var index = STAGES.indexOf(owned);
      if (index !== -1) scrollToStage(index);
    });

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    if (typeof flow.addEventListener === "function") flow.addEventListener("change", requestUpdate);
    // A restored scroll lands straight in its stage.
    window.addEventListener("pageshow", requestUpdate);
    update();

    return { scrollToStage: scrollToStage, update: requestUpdate };
  }

  window.EmjiveProductStages = { mount: mount, screenPx: screenPx };
})();
