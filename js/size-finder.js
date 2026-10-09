/* ==========================================================================
   em·ji·ve — size finder
   The "Find my size" modal: a full-page dark overlay that works out a ring
   size, opened from the three places a size is given — the product page's
   specs stage and its Select sheet (js/product.js) and the Modify sheet
   (js/modify-modal.js). It replaced the inline size guide.

   Steps, one label in the upper part of the screen whose text swaps:
     ask        "Do you have a fitting ring at your disposal?" — Yes / No.
     calibrate  (Yes) A standard card (ISO ID-1) goes on the screen and a
                slider scales a card-shaped window until it matches it. A
                screen's real pixel size can't be read from the browser, so
                this is where the pixels-per-millimetre come from.
     measure    The ring goes on the screen, centred on the dot, and a slider
                scales a disc until it touches the ring's inner edge.
     result     The disc's diameter, as the ring's inner circumference (a
                size here is that circumference, in mm). Only the disc's
                outline stays on the screen, with the buttons underneath it:
                "Measure another ring" or "Use a different method".
     chart      (No, or a different method) The category's size guide, from
                data/series.json, as js/selection.js's fillSizeGuide builds it.

   A step back is the arrow in the top left corner; the cross in the top right
   closes. While a card or a ring lies on the screen (calibrate, measure) the
   only things that take a touch are the slider's dot, Validate, the arrow
   and the cross.

   Both shapes are inversions drawn over everything else (css/style.css's
   .size-finder__card and .size-finder__disc): outside the card window is
   inverted and inside is left alone; inside the disc is inverted and outside
   is left alone.

   window.EmjiveSizeFinder = { open(options), isOpen(), sizeFromDiameter(mm) }.
   options:
     guide        the category's "size-guide" (shown on the chart step)
     onFill(size) called once, with the last size validated, when the finder
                  closes — never when the last thing the visitor did was
                  choose No or "Use a different method", which also throw
                  away any size measured before
     returnFocus  element (or function returning one) focus goes back to

   It opens over a sheet that is itself a focus trap, hence the trap's
   `nested` option (js/focus-trap.js).
   ========================================================================== */

(function (global) {
  "use strict";

  if (!global.EmjiveSelection || !global.EmjiveFocusTrap) return;

  // ISO/IEC 7810 ID-1 — bank cards.
  var CARD_LONG_MM = 85.6;
  var CARD_SHORT_MM = 53.98;
  var CARD_RADIUS_MM = 3.18;
  // The calibration slider runs from SCALE_MIN px per mm (smaller than any
  // screen has) to a card bigger than the viewport, logarithmically so the
  // 3-7 px per mm that real screens have keeps a fine grip.
  var SCALE_MIN = 2;
  var SCALE_STEPS = 5000;
  // The disc: from a dot to a little past the biggest ring size.
  var DISC_MIN_MM = 3;
  var DISC_MAX_MM = 26;
  var DISC_STEP_MM = 0.005;
  // CSS's own reference, until the visitor has calibrated.
  var DEFAULT_SCALE = 96 / 25.4;
  // How long a step fades out before the next one takes its place.
  var SWAP_MS = 200;

  var TEXT = {
    ask: "Do you have a fitting ring at your disposal?",
    // An array is paragraphs.
    calibrate: [
      "Lay a standard-size card (like a credit card) on the screen with its bottom edge resting on top of the white space below, and slide down until the white outlines perfectly touch all of its edges.",
      "This step lets us calibrate the measurements to your device's exact screen size to get precise results."
    ],
    measure: "Now place the ring you want to measure on the dot below and slide up until the white outline perfectly touches the inner edges of your ring"
  };

  // What each step shows: the parts that are visible, and the shape.
  var STEPS = {
    ask:       { parts: ["ask"], shape: null },
    calibrate: { parts: ["controls"], shape: "card" },
    measure:   { parts: ["controls"], shape: "disc" },
    result:    { parts: ["result"], shape: null },
    chart:     { parts: ["chart"], shape: null }
  };

  var state = {
    built: false,
    isOpen: false,
    step: null,
    scale: DEFAULT_SCALE,
    diameter: DISC_MIN_MM,
    lastSize: null,
    // The steps behind, each with the size that was to be filled at the time.
    history: [],
    options: null,
    swapTimer: null
  };
  var nodes = {};

  // A size here is the ring's inner circumference, in mm, to a tenth.
  function sizeFromDiameter(mm) {
    return Math.round(Math.PI * mm * 10) / 10;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className) {
    var btn = el("button", "size-finder__button" + (className ? " " + className : ""), label);
    btn.type = "button";
    return btn;
  }

  /* ---- the slider ----------------------------------------------------------
     Not a native range input: only its dot takes a touch, so a card or a ring
     lying on the screen can't move it by landing on the track (which does
     nothing at all). The dot's hit area is twice its size, silently
     (css/style.css .size-finder__thumb::before). It is a slider for a keyboard
     and a screen reader too. */
  function makeSlider(onInput) {
    var root = el("div", "size-finder__slider");
    root.tabIndex = 0;
    root.setAttribute("role", "slider");
    var track = el("div", "size-finder__track");
    var thumb = el("div", "size-finder__thumb");
    root.appendChild(track);
    root.appendChild(thumb);
    var cfg = { min: 0, max: 1, step: 0.01, value: 0, text: null };
    var drag = null;

    function render() {
      root.style.setProperty("--pos", String((cfg.value - cfg.min) / (cfg.max - cfg.min)));
      root.setAttribute("aria-valuemin", String(cfg.min));
      root.setAttribute("aria-valuemax", String(cfg.max));
      root.setAttribute("aria-valuenow", String(cfg.value));
      if (cfg.text) root.setAttribute("aria-valuetext", cfg.text(cfg.value));
      else root.removeAttribute("aria-valuetext");
    }

    function setValue(value, fire) {
      value = Math.max(cfg.min, Math.min(cfg.max, value));
      value = cfg.min + Math.round((value - cfg.min) / cfg.step) * cfg.step;
      value = Math.max(cfg.min, Math.min(cfg.max, +value.toFixed(4)));
      if (value === cfg.value) return;
      cfg.value = value;
      render();
      if (fire) onInput(value);
    }

    thumb.addEventListener("pointerdown", function (e) {
      if (e.button) return;
      e.preventDefault();
      var box = thumb.getBoundingClientRect();
      drag = { id: e.pointerId, grab: e.clientX - (box.left + box.width / 2) };
      thumb.setPointerCapture(e.pointerId);
      root.focus({ preventScroll: true });
    });
    thumb.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var rail = track.getBoundingClientRect();
      var at = (e.clientX - drag.grab - rail.left) / rail.width;
      setValue(cfg.min + Math.max(0, Math.min(1, at)) * (cfg.max - cfg.min), true);
    });
    function release(e) {
      if (drag && e.pointerId === drag.id) drag = null;
    }
    thumb.addEventListener("pointerup", release);
    thumb.addEventListener("pointercancel", release);
    thumb.addEventListener("lostpointercapture", release);

    root.addEventListener("keydown", function (e) {
      var big = (cfg.max - cfg.min) / 10;
      var to = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") to = cfg.value + cfg.step;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") to = cfg.value - cfg.step;
      else if (e.key === "PageUp") to = cfg.value + big;
      else if (e.key === "PageDown") to = cfg.value - big;
      else if (e.key === "Home") to = cfg.min;
      else if (e.key === "End") to = cfg.max;
      if (to === null) return;
      e.preventDefault();
      setValue(to, true);
    });

    return {
      el: root,
      // A new range, label and value; nothing is reported.
      configure: function (next) {
        cfg = { min: next.min, max: next.max, step: next.step, value: next.value, text: next.text || null };
        root.setAttribute("aria-label", next.label);
        render();
      },
      setValue: function (value) { setValue(value, false); }
    };
  }

  /* ---- scale ------------------------------------------------------------- */

  // The card is always upright (its short side across): the natural way to
  // lay one down against an edge, whatever the shape of the screen or the
  // window, and a landscape card would be wider than a phone's screen.
  function cardMm() {
    return { w: CARD_SHORT_MM, h: CARD_LONG_MM };
  }

  // Where the card's bottom edge goes, from the top of the screen: just above
  // the slider, where the marker stands (so it has to be laid out). Below it the
  // screen is outside the card, hence inverted: the white space the card rests on.
  function cardEdgeY() {
    var edge = nodes.edge.getBoundingClientRect();
    return edge.top + edge.height / 2 - nodes.root.getBoundingClientRect().top;
  }

  // The scale at which the card, standing on its edge, runs past the top and
  // the sides of the viewport, a little over.
  function scaleMax() {
    var card = cardMm();
    return 1.15 * Math.max(nodes.root.clientWidth / card.w, cardEdgeY() / card.h);
  }

  function scaleFromSlider(position) {
    var max = Math.max(scaleMax(), SCALE_MIN * 1.01);
    return SCALE_MIN * Math.pow(max / SCALE_MIN, position / SCALE_STEPS);
  }

  function sliderFromScale(scale) {
    var max = Math.max(scaleMax(), SCALE_MIN * 1.01);
    var position = Math.log(scale / SCALE_MIN) / Math.log(max / SCALE_MIN) * SCALE_STEPS;
    return Math.max(0, Math.min(SCALE_STEPS, position));
  }

  function renderCard() {
    var card = cardMm();
    nodes.card.style.width = card.w * state.scale + "px";
    nodes.card.style.height = card.h * state.scale + "px";
    nodes.card.style.borderRadius = CARD_RADIUS_MM * state.scale + "px";
    // The card stands on its edge, and grows and shrinks up from it.
    nodes.root.style.setProperty("--finder-edge", cardEdgeY() + "px");
  }

  // The measured disc's outline, kept on the result screen; the buttons stand
  // under it (--finder-outline-r).
  function renderOutline() {
    var px = state.diameter * state.scale;
    nodes.outline.style.width = px + "px";
    nodes.outline.style.height = px + "px";
    nodes.root.style.setProperty("--finder-outline-r", px / 2 + "px");
  }

  function renderDisc() {
    var px = state.diameter * state.scale;
    nodes.disc.style.width = px + "px";
    nodes.disc.style.height = px + "px";
    // The controls stand under the biggest the disc gets, so they stay put.
    nodes.root.style.setProperty("--finder-r", (DISC_MAX_MM / 2) * state.scale + "px");
  }

  /* ---- build the DOM once, on first use ------------------------------------ */

  function build() {
    if (state.built) return;
    state.built = true;

    var root = el("div", "size-finder");
    root.id = "sizeFinder";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Find my size");
    root.setAttribute("aria-hidden", "true");
    root.tabIndex = -1;
    nodes.root = root;

    var close = el("button", "size-finder__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 3 L21 21 M21 3 L3 21" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    close.addEventListener("click", closeFinder);

    var back = el("button", "size-finder__back");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12 H3 M10 5 L3 12 L10 19" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    back.addEventListener("click", goBack);
    nodes.back = back;

    // The upper part of the screen: the label, and what goes under it.
    var top = el("div", "size-finder__top");
    nodes.top = top;
    nodes.label = el("div", "size-finder__label");
    nodes.label.setAttribute("aria-live", "polite");
    top.appendChild(nodes.label);

    nodes.ask = el("div", "size-finder__choices");
    var yes = button("Yes");
    var no = button("No");
    nodes.ask.appendChild(yes);
    nodes.ask.appendChild(no);
    top.appendChild(nodes.ask);

    // The result's buttons: not in the top part, they stand under the outline.
    nodes.result = el("div", "size-finder__choices size-finder__choices--stack size-finder__result");
    var again = button("Measure another ring");
    var other = button("Use a different method");
    nodes.result.appendChild(again);
    nodes.result.appendChild(other);

    nodes.chart = el("div", "size-finder__chart size-guide");
    top.appendChild(nodes.chart);
    root.appendChild(top);

    // The slider and Validate — the calibration's and the ring's alike — and,
    // while calibrating, an invisible marker above them: the height the card's
    // bottom edge goes at.
    nodes.controls = el("div", "size-finder__controls");
    nodes.edge = el("div", "size-finder__edge");
    nodes.edge.setAttribute("aria-hidden", "true");
    nodes.controls.appendChild(nodes.edge);
    nodes.slider = makeSlider(function (value) {
      if (state.step === "calibrate") {
        state.scale = scaleFromSlider(value);
        renderCard();
      } else if (state.step === "measure") {
        state.diameter = value;
        renderDisc();
      }
    });
    var validate = button("Validate");
    nodes.controls.appendChild(nodes.slider.el);
    nodes.controls.appendChild(validate);
    root.appendChild(nodes.controls);
    root.appendChild(nodes.result);

    nodes.outline = el("div", "size-finder__outline");
    nodes.outline.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.outline);

    // The cross comes after the parts so nothing covers it, and before the
    // shapes so they still invert it.
    root.appendChild(back);
    root.appendChild(close);

    // The two shapes, last so they are over everything.
    nodes.card = el("div", "size-finder__card");
    nodes.card.setAttribute("aria-hidden", "true");
    nodes.disc = el("div", "size-finder__disc");
    nodes.disc.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.card);
    root.appendChild(nodes.disc);

    nodes.primary = { ask: yes, calibrate: nodes.slider.el, measure: nodes.slider.el, result: again };

    yes.addEventListener("click", function () {
      advance("calibrate", function () { state.scale = null; });
    });
    no.addEventListener("click", function () {
      advance("chart", function () { state.lastSize = null; });
    });
    again.addEventListener("click", function () {
      advance("measure", function () { state.diameter = DISC_MIN_MM; });
    });
    other.addEventListener("click", function () {
      advance("chart", function () { state.lastSize = null; });
    });
    validate.addEventListener("click", function () {
      if (state.step === "calibrate") {
        advance("measure", function () { state.diameter = DISC_MIN_MM; });
        return;
      }
      advance("result", function () { state.lastSize = sizeFromDiameter(state.diameter); });
    });

    document.body.appendChild(root);
  }

  /* ---- steps ---------------------------------------------------------------- */

  // Moves on to a step, remembering this one (and the size to be filled as it
  // was) for the arrow; `change` is whatever the move changes.
  function advance(step, change) {
    state.history.push({ step: state.step, lastSize: state.lastSize });
    if (change) change();
    go(step);
  }

  function goBack() {
    var entry = state.history.pop();
    if (!entry) return;
    state.lastSize = entry.lastSize;
    go(entry.step);
  }

  // Puts a step on screen. The first one (opening) is placed at once; the
  // others fade the label and the parts out, swap, and fade back in.
  function go(step, immediate) {
    clearTimeout(state.swapTimer);
    state.step = step;
    if (immediate) {
      apply(step);
      return;
    }
    nodes.root.classList.add("is-swapping");
    state.swapTimer = setTimeout(function () {
      apply(step);
      nodes.root.classList.remove("is-swapping");
    }, SWAP_MS);
  }

  function apply(step) {
    var def = STEPS[step];
    nodes.root.setAttribute("data-step", step);
    nodes.ask.hidden = def.parts.indexOf("ask") === -1;
    nodes.result.hidden = def.parts.indexOf("result") === -1;
    nodes.chart.hidden = def.parts.indexOf("chart") === -1;
    nodes.edge.hidden = step !== "calibrate";
    nodes.controls.hidden = def.parts.indexOf("controls") === -1;
    nodes.back.hidden = state.history.length === 0;

    var text = TEXT[step] || "";
    if (step === "result") {
      text = "Your size is " + state.lastSize + "mm, that's the inner circumference of the ring you used";
    }
    var paragraphs = [].concat(text).filter(Boolean);
    nodes.label.innerHTML = "";
    paragraphs.forEach(function (paragraph) {
      nodes.label.appendChild(el("p", "size-finder__paragraph", paragraph));
    });
    nodes.label.hidden = !paragraphs.length;

    nodes.outline.classList.toggle("is-on", step === "result");
    if (step === "result") renderOutline();
    nodes.card.classList.toggle("is-on", def.shape === "card");
    nodes.disc.classList.toggle("is-on", def.shape === "disc");

    if (step === "calibrate") {
      // First time in: the card at its biggest, which needs the marker laid out.
      if (state.scale === null) state.scale = scaleMax();
      nodes.slider.configure({ min: 0, max: SCALE_STEPS, step: 1, value: sliderFromScale(state.scale), label: "Card size" });
      renderCard();
    } else if (step === "measure") {
      nodes.slider.configure({
        min: DISC_MIN_MM,
        max: DISC_MAX_MM,
        step: DISC_STEP_MM,
        value: state.diameter,
        label: "Circle size",
        text: function (value) { return value.toFixed(3) + " mm across"; }
      });
      renderDisc();
    }

    // Focus follows the step, unless the dialog has only just opened.
    var primary = nodes.primary[step] || nodes.chart.querySelector(".size-guide__scroll") || nodes.back;
    if (primary && !primary.hidden && state.isOpen && !nodes.root.classList.contains("is-opening")) {
      primary.focus({ preventScroll: true });
    }
  }

  function onResize() {
    if (state.step === "calibrate") {
      nodes.slider.setValue(sliderFromScale(state.scale));
      renderCard();
    }
  }

  /* ---- open / close ----------------------------------------------------------- */

  function openFinder(options) {
    if (state.isOpen) return;
    build();
    state.options = options || {};
    state.lastSize = null;
    state.history = [];
    state.scale = DEFAULT_SCALE;
    state.diameter = DISC_MIN_MM;
    global.EmjiveSelection.fillSizeGuide(nodes.chart, state.options.guide);

    nodes.root.classList.add("is-opening");
    go("ask", true);
    nodes.root.classList.remove("is-swapping");
    nodes.root.classList.add("is-open");
    nodes.root.setAttribute("aria-hidden", "false");
    state.isOpen = true;
    global.addEventListener("resize", onResize);

    // After .is-open (the overlay is visibility: hidden until then, and
    // focus() on a hidden element does nothing).
    global.EmjiveFocusTrap.activate(nodes.root, {
      nested: global.EmjiveFocusTrap.isActive(),
      returnFocus: state.options.returnFocus,
      onEscape: closeFinder
    });
    nodes.root.classList.remove("is-opening");
  }

  function closeFinder() {
    if (!state.isOpen) return;
    state.isOpen = false;
    clearTimeout(state.swapTimer);
    global.removeEventListener("resize", onResize);
    nodes.root.classList.remove("is-open");
    nodes.root.classList.remove("is-swapping");
    nodes.root.setAttribute("aria-hidden", "true");
    global.EmjiveFocusTrap.release();
    var size = state.lastSize;
    var fill = state.options && state.options.onFill;
    state.lastSize = null;
    state.options = null;
    if (size !== null && fill) fill(size);
  }

  global.EmjiveSizeFinder = {
    open: openFinder,
    isOpen: function () { return state.isOpen; },
    sizeFromDiameter: sizeFromDiameter
  };
})(window);
