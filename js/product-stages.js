// The product page's two-stage show: a tall track (.product-stage) holding
// one sticky stage, where scrolling steps inspiration (description and photo
// feed) -> design (the model and its configuration: design options, metal,
// size, plan views; then the information). Each stage is a stretch the
// show browses through, with an eased transition between them.
//
// Track order: inspiration stretch (--feed-hold), transition
// (--stage-step-in), design stretch (--design-hold). The stretches are sized
// here from the room each stage needs.
//
// window.EmjiveProductStages.mount(stageEl, { onChange }) publishes on the track:
//   --to-design               eased 0..1 transition
//   --browse-0                0..1 through the inspiration stretch
//   --design-browse           px the show is browsed up through the design
//                             stretch (in px, read with the room it covers,
//                             so a room changing never moves the show)
//   data-stage                "inspiration" | "design" | "flow" (too short to pin)
//   .is-feed-gone, .is-design-out, .is-model-out   for what CSS can't fade
// and calls onChange({ toDesign, stage }).
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
  // The design stretch's minimum, a rest at the end.
  var DESIGN_MIN_SCREENS = 0.25;
  // Design browsing pace: 15px up per 24px scrolled. The track lengthens for a
  // taller column rather than browsing faster.
  var BROWSE_PACE = 15 / 24;
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
    var state = { toDesign: -1, stage: "", browse: "" };
    // --design-room in px as the design stretch was last sized from it.
    var designRoom = 0;
    // Each stage's page scroll position, as last measured.
    var stops = [0, 0];

    // CSS lengths in px, read off probes: --design-room, --stage-step-in.
    function probe(height) {
      var el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = "position:absolute;width:0;height:" + height + ";visibility:hidden;pointer-events:none";
      stageEl.appendChild(el);
      return el;
    }
    var designRoomProbe = probe("var(--design-room)");
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

    // Design stretch (--design-hold): --design-room (js/product.js) at
    // BROWSE_PACE plus half the ramp, at least DESIGN_MIN_SCREENS.
    var designHold = 0;
    function syncDesignHold() {
      var want = 0;
      designRoom = flow.matches ? 0 : designRoomProbe.offsetHeight;
      if (!flow.matches) {
        var ramp = screenPx() * ENTRY_SCREENS;
        want = Math.max(screenPx() * DESIGN_MIN_SCREENS, designRoom / BROWSE_PACE + ramp / 2);
      }
      if (Math.abs(want - designHold) < 0.5) return;
      designHold = want;
      if (want > 0) stageEl.style.setProperty("--design-hold", want.toFixed(1) + "px");
      else stageEl.style.removeProperty("--design-hold");
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
      // The design stretch is whatever the track has left past the transition.
      var hold = Math.max(0, stageEl.offsetHeight - pin.offsetHeight - offset);
      stops = [trackStart, trackStart + offset];
      return { scrolled: scrolled, feed: feed, stepIn: stepIn, offset: offset, hold: hold };
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
      var browse0 = m.feed > 0 ? exit(clamp01(s / m.feed), Math.min(1, screenRamp / m.feed)) : 1;
      var toDesign = m.stepIn > 0 ? ease((s - m.feed) / m.stepIn) : (s >= m.feed ? 1 : 0);
      // Counted from the design stretch's first pixel. On the device's
      // pixels: the show's translate (--design-browse) keeps the plan
      // views' hairlines sharp.
      var s1 = s - m.offset;
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
