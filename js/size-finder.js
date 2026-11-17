// "Unsure about size?": a full-screen overlay helping to a ring size, opened
// from the product page (size row, Select sheet) and the Modify sheet.
//
// Steps:
//   ask        three ways, one under the other: the sizing strip (its Add
//              puts it in the selection and closes), measuring a ring (Go),
//              and the size chart itself. A desktop (a fine pointer that hovers) has no
//              screen to lay a ring on: no measuring there.
//   calibrate  (measuring, first time) a slider lowers a top band onto an upright
//              ID-1 card, giving px per mm (the browser can't report it); kept
//              in localStorage per screen and zoom
//   measure    the ring on screen, three lines at 120° dragged out until they
//              vanish inside it. The lines form an equilateral triangle whose
//              inscribed circle is the ring's inner edge; its radius is the
//              mean of the lines' distances from the centre, wherever the ring
//              sits.
//   measure2   the same lines dragged back in until they reappear; both passes
//              are weighed (lineMm()).
//   result     the inner circumference (the size, in mm), drawn as a circle;
//              Measure again, or All sizing options (ask, as at opening)
// Only the slider dot, the lines and the buttons take touches while a card or
// ring lies on the screen. The card window and the lines are inversions
// (.size-finder__card, .size-finder__line).
//
// window.EmjiveSizeFinder = { open(options), isOpen(), sizeFromDiameter(mm) }
//   options.guide        the category's "size-guide"
//   options.strip        the category's "sizing-strip" (no strip without it)
//   options.onAdd()      after the strip's Add, once the finder has closed
//   options.onFill(size) on close, with the last validated size; not after
//                        the strip or going back to the options, which discard it
//   options.returnFocus  element or function
// Opens over a sheet's focus trap, hence the trap's `nested` option.

(function (global) {
  "use strict";

  if (!global.EmjiveSelection || !global.EmjiveFocusTrap) return;

  var H = global.EmjiveHelpers;
  var el = H.el;

  // ISO/IEC 7810 ID-1 (bank card): its long side is matched.
  var CARD_LONG_MM = 85.6;
  // The slider moves the top band evenly from touching the bottom band to just
  // above the screen. Validate needs at least SCALE_MIN px/mm.
  var SCALE_MIN = 2;
  var SCALE_STEPS = 5000;
  // Stored calibration (readCalibration()).
  var CALIBRATION_KEY = "emjive_calibration";
  var CALIBRATION_VERSION = 1;
  var SCALE_MAX = 60;
  // A line is one device pixel thick (linePx()); its inner edge's distance from
  // the centre along its normal is what's measured. It can't cross the centre
  // (LINE_MIN_MM): past it the triangle wouldn't surround the ring.
  // Share of the outgoing pass in a line's distance; the incoming pass is the rest.
  var FIRST_PASS_WEIGHT = 0.66;
  // The result circle's thickness.
  var OUTLINE_PX = 0.75;
  // Dragged elements follow only this share of the pointer, for precision.
  var DRAG_GAIN = 0.5;
  var LINE_MIN_MM = 0;
  // First-pass start, near the centre.
  var LINE_START_MM = 1.5;
  // Second-pass start: this share of the way to the farthest screen corner.
  var FAR_FRACTION = 0.5;
  // The lines' centre sits this far below the screen's centre, leaving room for the label (rem).
  var CENTRE_DROP_REM = 3;
  var LINE_ANGLES = [0, 120, 240];
  var LINE_CURSORS = ["ns-resize", "nwse-resize", "nesw-resize"];
  // CSS's reference px per mm, until calibrated.
  var DEFAULT_SCALE = 96 / 25.4;
  // A step's fade-out before the next.
  var SWAP_MS = 200;
  // First calibration: the top band slides down over FIT_MS, the slider dot
  // ending FIT_SLIDE in from its right end.
  var FIT_MS = 1100;
  var FIT_SLIDE = 0.05;
  var desktopMedia = global.matchMedia("(hover: hover) and (pointer: fine)");

  var TEXT = {
    // An array is paragraphs.
    calibrate: [
      "Stand a standard card (like a credit card) upright on the white band at the bottom of the screen.",
      "Slide until the white band at the top just touches the card."
    ],
    measure: [
      "Put the ring on the screen.",
      "Drag each line away from the center, stop as soon as it disappears inside the ring."
    ],
    measure2: [
      "Don't move the ring.",
      "Drag each line toward the ring, stop as soon as it appears inside the ring."
    ]
  };

  var STEPS = {
    ask:       { parts: ["ask"], shape: null },
    calibrate: { parts: ["controls"], shape: "card" },
    measure:   { parts: ["controls"], shape: null },
    measure2:  { parts: ["controls"], shape: null },
    result:    { parts: ["result"], shape: null }
  };

  var state = {
    built: false,
    isOpen: false,
    step: null,
    scale: DEFAULT_SCALE,
    // Each pass's three line distances (mm), outgoing then incoming, and which the visitor has moved.
    lines: [[LINE_START_MM, LINE_START_MM, LINE_START_MM], [0, 0, 0]],
    touched: [[false, false, false], [false, false, false]],
    lastSize: null,
    // Previous steps, with the state to restore, for the back arrow.
    history: [],
    options: null,
    swapTimer: null,
    fitFrame: 0
  };
  var nodes = {};

  // A calibration's screen: device pixel ratio (desktop zoom changes it) and screen size, either orientation.
  function screenId() {
    var w = global.screen ? global.screen.width : 0;
    var h = global.screen ? global.screen.height : 0;
    return [global.devicePixelRatio || 1, Math.min(w, h), Math.max(w, h)].join("x");
  }

  // Stored px per mm, or null if absent, from another screen or zoom, or implausible.
  function readCalibration() {
    var stored = H.readStorageJson("localStorage", CALIBRATION_KEY);
    if (!stored || stored.v !== CALIBRATION_VERSION || stored.screen !== screenId()) return null;
    var scale = Number(stored.scale);
    return isFinite(scale) && scale >= SCALE_MIN && scale <= SCALE_MAX ? scale : null;
  }

  // Blocked or full storage: asked again next time.
  function saveCalibration(scale) {
    H.writeStorage("localStorage", CALIBRATION_KEY, JSON.stringify({ v: CALIBRATION_VERSION, scale: scale, screen: screenId() }));
  }

  // A size is the ring's inner circumference in mm, to a tenth.
  function sizeFromDiameter(mm) {
    return Math.round(Math.PI * mm * 10) / 10;
  }

  // The inscribed circle's diameter from the lines. Each line's distance weighs
  // both passes: visitors overshoot both ways, more when a line appears than
  // when it vanishes, so FIRST_PASS_WEIGHT cancels both (fitted on a size 52
  // ring reading 52.6 out, 50.5 in).
  function lineMm(i) {
    return FIRST_PASS_WEIGHT * state.lines[0][i] + (1 - FIRST_PASS_WEIGHT) * state.lines[1][i];
  }

  function diameterFromLines() {
    return (2 * (lineMm(0) + lineMm(1) + lineMm(2))) / 3;
  }

  // 0 outgoing (measure), 1 incoming (measure2).
  function pass() {
    return state.step === "measure2" ? 1 : 0;
  }

  // One device pixel thick, moved in device pixels.
  function linePx() {
    return 1 / (global.devicePixelRatio || 1);
  }

  function snapMm(mm) {
    var step = linePx() / state.scale;
    return Math.round(mm / step) * step;
  }

  function resetLines() {
    var start = snapMm(LINE_START_MM);
    state.lines = [[start, start, start], [0, 0, 0]];
    state.touched = [[false, false, false], [false, false, false]];
  }

  // The lines' centre from the screen's top, on a device pixel so a horizontal line is crisp.
  function centreY() {
    var rem = parseFloat(global.getComputedStyle(document.documentElement).fontSize) || 16;
    var dpr = global.devicePixelRatio || 1;
    return Math.round((nodes.root.clientHeight / 2 + CENTRE_DROP_REM * rem) * dpr) / dpr;
  }

  function placeCentre() {
    nodes.root.style.setProperty("--finder-cy", centreY() + "px");
  }

  // Second-pass starting places, far out.
  function startComing() {
    var cy = centreY();
    var w = nodes.root.clientWidth / 2;
    var h = nodes.root.clientHeight;
    var corners = [[-w, -cy], [w, -cy], [-w, h - cy], [w, h - cy]];
    state.lines[1] = LINE_ANGLES.map(function (deg) {
      var a = (deg * Math.PI) / 180;
      var reach = Math.max.apply(null, corners.map(function (c) {
        return c[0] * Math.sin(a) - c[1] * Math.cos(a);
      }));
      return snapMm((FAR_FRACTION * reach) / state.scale);
    });
    state.touched[1] = [false, false, false];
  }

  function button(label, className) {
    var btn = el("button", "size-finder__button" + (className ? " " + className : ""), label);
    btn.type = "button";
    return btn;
  }

  // One of the first screen's ways, a label | value row as the product
  // page's information: its title the label, the rest appended to the value.
  function way(title) {
    var row = el("section", "product-info__item size-finder__way");
    var label = el("h2", "product-info__label", title);
    var value = el("div", "product-info__value");
    row.appendChild(label);
    row.appendChild(value);
    return { el: row, title: label, value: value };
  }

  // A way's closing button: its words (`label`, changeable), then the arrow out.
  function wayButton(text) {
    var btn = button("", "size-finder__way-button");
    var label = el("span", "", text);
    btn.appendChild(label);
    btn.insertAdjacentHTML("beforeend", H.ICON_OUT);
    return { button: btn, label: label };
  }

  /* ---- the sizing strip ---- */

  // Its way for this opening: photos rebuilt only for another strip.
  function fillStrip(strip) {
    nodes.stripWay.el.hidden = !strip;
    if (!strip) return;
    nodes.add.label.textContent = "Add (" + global.EmjiveSelection.formatPrice(strip.price) + ")";
    if (nodes.photos.dataset.for === strip.image) return;
    nodes.photos.dataset.for = strip.image;
    nodes.photos.innerHTML = "";
    // Each opens full screen, the others a swipe or an arrow away.
    var shown = strip.photos.map(function (src, i) {
      return { src: src, alt: "Sizing strip, photo " + (i + 1) };
    });
    shown.forEach(function (photo, i) {
      var tile = el("button", "size-finder__photo");
      tile.type = "button";
      tile.setAttribute("aria-label", "Open " + photo.alt);
      tile.setAttribute("aria-haspopup", "dialog");
      var img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      img.src = photo.src;
      tile.appendChild(img);
      tile.addEventListener("click", function () {
        global.EmjivePhotoViewer.open(shown, i, { from: tile });
      });
      nodes.photos.appendChild(tile);
    });
  }

  // Into the selection, then closed: the bar shows the new row.
  function addStrip() {
    var strip = state.options && state.options.strip;
    if (!strip) return;
    state.lastSize = null;
    global.EmjiveSelection.addItem({
      kind: "sizing-strip",
      productId: "sizing-strip",
      name: strip.name,
      category: strip.category,
      includes: strip.includes,
      metal: "",
      size: "",
      price: strip.price,
      image: strip.image
    });
    // After the close, so a sheet underneath gets its focus trap back first.
    var onAdd = state.options.onAdd;
    closeFinder();
    if (onAdd) onAdd();
  }

  /* ---- the slider ----
     Custom, not a range input: only its dot takes touches, so a card on the
     track can't move it (its hit area is doubled in CSS). Follows DRAG_GAIN of
     the pointer. Keyboard and screen-reader accessible. */
  function makeSlider(onInput) {
    var root = el("div", "size-finder__slider");
    root.tabIndex = 0;
    root.setAttribute("role", "slider");
    var track = el("div", "size-finder__track");
    var thumb = el("div", "size-finder__thumb");
    root.appendChild(track);
    root.appendChild(thumb);
    var cfg = { min: 0, max: 1, step: 0.01, value: 0, text: null };

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

    H.dragPointer(thumb, function (e) {
      root.focus({ preventScroll: true });
      return { x: e.clientX, from: (cfg.value - cfg.min) / (cfg.max - cfg.min) };
    }, function (e, drag) {
      var rail = track.getBoundingClientRect();
      var at = drag.from + (DRAG_GAIN * (e.clientX - drag.x)) / rail.width;
      setValue(cfg.min + H.clamp01(at) * (cfg.max - cfg.min), true);
    });

    root.addEventListener("keydown", function (e) {
      var to = H.sliderKey(e, cfg.value, cfg.step, (cfg.max - cfg.min) / 10, cfg.min, cfg.max);
      if (to === null) return;
      e.preventDefault();
      setValue(to, true);
    });

    return {
      el: root,
      // New range, label and value; nothing reported.
      configure: function (next) {
        cfg = { min: next.min, max: next.max, step: next.step, value: next.value, text: next.text || null };
        root.setAttribute("aria-label", next.label);
        render();
      },
      setValue: function (value) { setValue(value, false); }
    };
  }

  /* ---- the lines ----
     Each is a visual bar (an inversion, no touches) plus a wider invisible hit
     strip under the label and buttons. Both rotate by the line's angle and move
     along its normal (sin a, -cos a); pointer motion is projected on it, at
     DRAG_GAIN. Keyboard: arrows, PageUp/PageDown, Home ("up" is outward). */
  function makeLine(index, onMove) {
    var angle = (LINE_ANGLES[index] * Math.PI) / 180;
    var nx = Math.sin(angle);
    var ny = -Math.cos(angle);
    var bar = el("div", "size-finder__line");
    bar.setAttribute("aria-hidden", "true");
    var hit = el("div", "size-finder__line-hit");
    hit.style.cursor = LINE_CURSORS[index];
    hit.tabIndex = 0;
    hit.setAttribute("role", "slider");
    hit.setAttribute("aria-label", "Line " + (index + 1));
    hit.setAttribute("aria-valuemin", String(LINE_MIN_MM));

    function render() {
      var px = linePx();
      var mm = state.lines[pass()][index];
      bar.style.height = px + "px";
      bar.style.marginTop = -px / 2 + "px";
      var distance = mm * state.scale + px / 2;
      var transform = "rotate(" + LINE_ANGLES[index] + "deg) translateY(" + -distance + "px)";
      bar.style.transform = transform;
      hit.style.transform = transform;
      hit.setAttribute("aria-valuenow", String(mm));
      hit.setAttribute("aria-valuetext", mm.toFixed(2) + " mm from the centre");
    }

    // The strip is too wide to ring, so keyboard focus shows on the bar.
    hit.addEventListener("focus", function () {
      bar.classList.toggle("is-focused", hit.matches(":focus-visible"));
    });
    hit.addEventListener("blur", function () { bar.classList.remove("is-focused"); });

    function setDistance(value) {
      value = Math.max(LINE_MIN_MM, snapMm(value));
      if (Math.abs(value - state.lines[pass()][index]) < 1e-9) return;
      state.lines[pass()][index] = value;
      state.touched[pass()][index] = true;
      render();
      onMove();
    }

    H.dragPointer(hit, function (e) {
      hit.focus({ preventScroll: true });
      return { x: e.clientX, y: e.clientY, from: state.lines[pass()][index] };
    }, function (e, drag) {
      var along = (DRAG_GAIN * ((e.clientX - drag.x) * nx + (e.clientY - drag.y) * ny)) / state.scale;
      setDistance(drag.from + along);
    });

    hit.addEventListener("keydown", function (e) {
      var step = linePx() / state.scale;
      var to = H.sliderKey(e, state.lines[pass()][index], step, 10 * step, LINE_MIN_MM);
      if (to === null) return;
      e.preventDefault();
      setDistance(to);
    });

    return { bar: bar, hit: hit, render: render };
  }

  /* ---- scale ----
     Two full-width inversion bands: the fixed bottom one the card stands on,
     and the top one the slider lowers onto the card's top edge. The gap is
     CARD_LONG_MM, giving px per mm. */

  // The bottom band's top edge (where the card stands), from the screen's top; needs layout.
  function cardEdgeY() {
    var edge = nodes.edge.getBoundingClientRect();
    return edge.top + edge.height / 2 - nodes.root.getBoundingClientRect().top;
  }

  // The top band's edge for a scale, and the reverse (px from the screen's top).
  function edgeFromScale(scale) {
    return cardEdgeY() - CARD_LONG_MM * scale;
  }

  function scaleFromEdge(y) {
    return (cardEdgeY() - y) / CARD_LONG_MM;
  }

  // Top band just out of sight: the largest scale.
  function scaleMax() {
    return scaleFromEdge(0);
  }

  function scaleFromSlider(position) {
    return scaleFromEdge((1 - position / SCALE_STEPS) * cardEdgeY());
  }

  function sliderFromScale(scale) {
    var bottom = cardEdgeY();
    if (!bottom) return 0;
    return Math.max(0, Math.min(SCALE_STEPS, (1 - edgeFromScale(scale) / bottom) * SCALE_STEPS));
  }

  // The card window's height at the scale; its bottom edge is fixed in CSS.
  function renderCard() {
    nodes.card.style.height = CARD_LONG_MM * state.scale + "px";
    nodes.root.style.setProperty("--finder-edge", cardEdgeY() + "px");
    renderValidate();
  }

  // First arrival's target: the dot FIT_SLIDE in from the right.
  function scaleFit() {
    return scaleFromSlider((1 - FIT_SLIDE) * SCALE_STEPS);
  }

  function cancelFit() {
    cancelAnimationFrame(state.fitFrame);
    state.fitFrame = 0;
  }

  // Lowers the top band from out of sight to scaleFit(), the dot following;
  // any slider touch, resize or step change stops it.
  function shrinkCardToFit() {
    cancelFit();
    var from = state.scale;
    var to = Math.min(from, Math.max(scaleFit(), SCALE_MIN));
    function set(scale) {
      state.scale = scale;
      nodes.slider.setValue(sliderFromScale(scale));
      renderCard();
    }
    if (H.reducedMotion.matches) {
      set(to);
      return;
    }
    var start = null;
    function frame(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / FIT_MS);
      set(from + (to - from) * (1 - Math.pow(1 - t, 3)));
      state.fitFrame = t < 1 ? requestAnimationFrame(frame) : 0;
    }
    state.fitFrame = requestAnimationFrame(frame);
  }

  function renderLines() {
    nodes.lines.forEach(function (line) { line.render(); });
  }

  // The result circle, centred on the triangle's inscribed circle. Its centre c
  // satisfies n_i . c = p_i - r for each line; with normals 120° apart,
  // c = 2/3 x sum(p_i n_i).
  function renderOutline() {
    var cx = 0;
    var cy = 0;
    LINE_ANGLES.forEach(function (angle, i) {
      var a = (angle * Math.PI) / 180;
      cx += lineMm(i) * Math.sin(a);
      cy -= lineMm(i) * Math.cos(a);
    });
    var box = (state.lastSize / Math.PI) * state.scale + OUTLINE_PX;
    nodes.outline.style.width = box + "px";
    nodes.outline.style.height = box + "px";
    // An inset shadow, not a border: borders snap to whole device pixels.
    nodes.outline.style.boxShadow = "inset 0 0 0 " + OUTLINE_PX + "px #fff";
    nodes.outline.style.transform =
      "translate(-50%, -50%) translate(" + (2 / 3) * cx * state.scale + "px, " + (2 / 3) * cy * state.scale + "px)";
  }

  // Validate needs every line moved, or a plausible calibration gap.
  function renderValidate() {
    var measuring = state.step === "measure" || state.step === "measure2";
    nodes.validate.disabled = (measuring && !state.touched[pass()].every(Boolean)) ||
      (state.step === "calibrate" && !(state.scale >= SCALE_MIN));
  }

  /* ---- DOM, built once on first use ---- */

  function build() {
    if (state.built) return;
    state.built = true;

    var root = el("div", "size-finder");
    root.id = "sizeFinder";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Unsure about size?");
    root.setAttribute("aria-hidden", "true");
    root.tabIndex = -1;
    nodes.root = root;

    var close = el("button", "size-finder__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = H.ICON_CLOSE;
    close.addEventListener("click", closeFinder);

    var back = el("button", "size-finder__back");
    back.type = "button";
    back.setAttribute("aria-label", "Back");
    back.innerHTML = H.ICON_BACK;
    back.addEventListener("click", goBack);
    nodes.back = back;

    // The lines' hit strips first, under the label and buttons; their bars go on top later.
    nodes.lines = LINE_ANGLES.map(function (angle, index) {
      var line = makeLine(index, renderValidate);
      root.appendChild(line.hit);
      return line;
    });

    var top = el("div", "size-finder__top");
    nodes.top = top;
    nodes.label = el("div", "size-finder__label");
    nodes.label.setAttribute("aria-live", "polite");
    top.appendChild(nodes.label);

    // The first screen's ways: the strip (text, photos, Add), the online tool
    // measuring a ring (text, Go); the chart's way follows as its own part.
    nodes.ask = el("div", "size-finder__ways");
    nodes.stripWay = way("Sizing strip");
    nodes.stripWay.value.appendChild(el("p", "product-info__text", "Buy a sizing strip and the shipping will be offered on your next order."));
    nodes.photos = el("div", "size-finder__photos");
    nodes.stripWay.value.appendChild(nodes.photos);
    nodes.add = wayButton("Add");
    var add = nodes.add.button;
    nodes.stripWay.value.appendChild(add);
    nodes.measureWay = way("Online tool");
    nodes.measureWay.value.appendChild(el("p", "product-info__text",
      "Follow on-screen instructions to measure one of your rings. The more carefully the instructions are followed, the more precise the tool is."));
    var toMeasure = wayButton("Go").button;
    nodes.measureWay.value.appendChild(toMeasure);
    nodes.ask.appendChild(nodes.stripWay.el);
    nodes.ask.appendChild(nodes.measureWay.el);
    top.appendChild(nodes.ask);

    // The result's buttons stand under the circle, not in the top part.
    nodes.result = el("div", "size-finder__choices size-finder__choices--stack size-finder__result");
    var again = button("Measure again");
    var toOptions = button("All sizing options");
    nodes.result.appendChild(again);
    nodes.result.appendChild(toOptions);

    nodes.chart = el("div", "size-finder__chart size-guide");
    var chartWay = way("Size chart");
    chartWay.value.appendChild(nodes.chart);
    nodes.chartWay = chartWay.el;
    top.appendChild(nodes.chartWay);
    root.appendChild(top);

    // Slider (calibration only), Validate, and an invisible marker for the card's bottom edge.
    nodes.controls = el("div", "size-finder__controls");
    nodes.edge = el("div", "size-finder__edge");
    nodes.edge.setAttribute("aria-hidden", "true");
    nodes.controls.appendChild(nodes.edge);
    nodes.slider = makeSlider(function (value) {
      cancelFit();
      state.scale = scaleFromSlider(value);
      renderCard();
    });
    // A slider touch stops the arrival animation first.
    nodes.slider.el.addEventListener("pointerdown", cancelFit);
    nodes.slider.el.addEventListener("keydown", cancelFit);
    var validate = button("Validate");
    nodes.validate = validate;
    nodes.controls.appendChild(nodes.slider.el);
    nodes.controls.appendChild(validate);
    root.appendChild(nodes.controls);
    root.appendChild(nodes.result);

    // After the parts so nothing covers them, before the shapes so they're inverted.
    root.appendChild(back);
    root.appendChild(close);

    nodes.outline = el("div", "size-finder__outline");
    nodes.outline.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.outline);

    // Bars over everything: they invert what they cross.
    nodes.lines.forEach(function (line) { root.appendChild(line.bar); });

    // The card window, topmost.
    nodes.card = el("div", "size-finder__card");
    nodes.card.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.card);

    nodes.primary = { calibrate: nodes.slider.el, measure: nodes.lines[0].hit, measure2: nodes.lines[0].hit, result: again };

    add.addEventListener("click", addStrip);
    // Straight to measuring when this screen is already calibrated.
    toMeasure.addEventListener("click", function () {
      var stored = readCalibration();
      if (stored) {
        advance("measure", function () {
          state.scale = stored;
          resetLines();
        });
        return;
      }
      advance("calibrate", function () { state.scale = null; });
    });
    // The last size stays until a new one is validated.
    again.addEventListener("click", function () {
      advance("measure", resetLines);
    });
    // The first screen as at opening: no way back, no size kept.
    toOptions.addEventListener("click", function () {
      state.history = [];
      state.lastSize = null;
      go("ask");
    });
    validate.addEventListener("click", function () {
      if (state.step === "calibrate") {
        cancelFit();
        saveCalibration(state.scale);
        advance("measure", resetLines);
        return;
      }
      if (state.step === "measure") {
        advance("measure2", startComing);
        return;
      }
      advance("result", function () {
        state.lastSize = sizeFromDiameter(diameterFromLines());
      });
    });

    document.body.appendChild(root);
  }

  /* ---- steps ---- */

  // Moves to a step, saving the current one for the back arrow.
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

  // Opening places the step at once; later steps fade out, swap and fade in.
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
    nodes.chartWay.hidden = step !== "ask";
    nodes.edge.hidden = step !== "calibrate";
    nodes.controls.hidden = def.parts.indexOf("controls") === -1;
    nodes.slider.el.hidden = step !== "calibrate";
    nodes.back.hidden = state.history.length === 0;
    if (step !== "calibrate") cancelFit();

    var text = TEXT[step] || "";
    if (step === "result") text = "Measured size: " + H.sizeText(state.lastSize) + ".";
    var paragraphs = [].concat(text).filter(Boolean);
    nodes.label.innerHTML = "";
    paragraphs.forEach(function (paragraph) {
      nodes.label.appendChild(el("p", "size-finder__paragraph", paragraph));
    });
    nodes.label.hidden = !paragraphs.length;

    // On Validate the lines fade out and the result circle takes their place.
    var measuring = step === "measure" || step === "measure2";
    nodes.lines.forEach(function (line) { line.bar.classList.toggle("is-on", measuring); });
    nodes.outline.classList.toggle("is-on", step === "result");
    if (measuring || step === "result") placeCentre();
    if (measuring) renderLines();
    if (step === "result") renderOutline();
    renderValidate();
    nodes.card.classList.toggle("is-on", def.shape === "card");

    if (step === "calibrate") {
      // First arrival: the card starts at its largest (needs the marker laid out) and shrinks into view.
      var arriving = state.scale === null;
      if (arriving) state.scale = scaleMax();
      nodes.slider.configure({ min: 0, max: SCALE_STEPS, step: 1, value: sliderFromScale(state.scale), label: "Card size" });
      renderCard();
      if (arriving) shrinkCardToFit();
    }

    // Focus follows the step, except right at opening.
    var primary = step === "ask" ? nodes.ask.querySelector(".size-finder__way:not([hidden]) .size-finder__way-button") : nodes.primary[step];
    if (primary && !primary.hidden && state.isOpen && !nodes.root.classList.contains("is-opening")) {
      primary.focus({ preventScroll: true });
    }
  }

  function onResize() {
    if (state.step === "measure" || state.step === "measure2" || state.step === "result") placeCentre();
    if (state.step === "calibrate") {
      cancelFit();
      nodes.slider.setValue(sliderFromScale(state.scale));
      renderCard();
    }
  }

  /* ---- open / close ---- */

  function openFinder(options) {
    if (state.isOpen) return;
    build();
    state.options = options || {};
    state.lastSize = null;
    state.history = [];
    state.scale = DEFAULT_SCALE;
    resetLines();
    global.EmjiveSelection.fillSizeGuide(nodes.chart, state.options.guide);
    fillStrip(state.options.strip);
    nodes.measureWay.el.hidden = desktopMedia.matches;

    nodes.root.classList.add("is-opening");
    go("ask", true);
    nodes.root.classList.remove("is-swapping");
    nodes.root.classList.add("is-open");
    nodes.root.setAttribute("aria-hidden", "false");
    state.isOpen = true;
    global.addEventListener("resize", onResize);

    // After .is-open: focus() is a no-op while hidden.
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
    cancelFit();
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
