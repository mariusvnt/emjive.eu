/* ==========================================================================
   em·ji·ve — size finder
   The "Find my size" modal: a full-page dark overlay that works out a ring
   size, opened from the three places a size is given — the product page's
   specs stage and its Select sheet (js/product.js) and the Modify sheet
   (js/modify-modal.js). It replaced the inline size guide.

   Steps, one label in the upper part of the screen whose text swaps:
     ask        "Do you have a fitting ring at your disposal?" — Yes / No.
     calibrate  (Yes) A standard card (ISO ID-1) stands upright on a white
                band at the bottom of the screen, and a slider brings a white
                band down from the top until it touches the card's top edge
                (see "scale" below). A screen's real pixel size can't be read
                from the browser, so this is where the pixels-per-millimetre
                come from. On the first arrival the top band comes down from
                out of sight, the slider sliding 5% in, so it is clear how
                it moves. Once done, the calibration is kept on the device
                (localStorage, tied to the screen and zoom it was made on),
                and Yes goes straight to the measure from then on.
     measure    The ring goes on the screen, in the middle of three lines at
                120° from each other, running to infinity. Each line is
                dragged from anywhere on it, along its own normal only, until
                it touches the ring's inner edge. The three lines always make
                an equilateral triangle, and the ring's inner circle is that
                triangle's inscribed circle: its radius is the mean of the
                lines' distances from the screen's centre (the sum of a
                point's distances to an equilateral triangle's sides is its
                height, wherever the point is — so a ring that isn't quite
                centred measures the same), which is the same as averaging
                the triangle's edges (edge = 2√3 × radius). Three readings,
                one per line, average out each one's error.
     measure2   The same lines again, the ring left where it is: going out on
                the first pass (stop as a line vanishes inside the ring),
                coming in on this one (stop as it appears). The two are
                weighed (lineMm()).
     result     The inscribed circle's circumference, as the ring's inner
                circumference (a size here is that circumference, in mm),
                shown as a range round the final size: the mean of every
                round's size, a round being both passes. Once at least three
                rounds, any of them, agree, a single size instead (see
                measureResult()). The final size is what is filled in. On
                Validate the lines fade out and a plain white circle takes
                their place (where the triangle's inscribed circle is), fifty
                times as thick as the range over the number of rounds that
                agree (BAND_SCALE), so a change shows. The buttons are
                underneath: "Measure again to refine" (another round, the
                same ring, averaged in), which becomes "Measure another ring"
                (the rounds start over) once the size is settled, and "Use a
                different method".
     chart      (No, or a different method) The category's size guide, from
                data/series.json, as js/selection.js's fillSizeGuide builds it.

   A step back is the arrow in the top left corner; the cross in the top right
   closes. While a card or a ring lies on the screen (calibrate, measure) the
   only things that take a touch are the slider's dot (calibrate) or the
   lines (measure), Validate, the arrow and the cross.

   The card window and the lines are inversions drawn over everything else
   (css/style.css's .size-finder__card, .size-finder__line): the card's outside
   is inverted and its inside is left alone; a line inverts what it crosses.
   The result's circle is a plain white outline (.size-finder__outline).

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

  // ISO/IEC 7810 ID-1 — bank cards: the long side is what is matched.
  var CARD_LONG_MM = 85.6;
  // The calibration slider moves the top band evenly, from touching the bottom
  // band (the slider's left end) to just out of sight above the screen (its
  // right end). Validate waits for a gap of at least SCALE_MIN px per mm
  // (smaller than any screen has): a scale near nothing would measure nothing.
  var SCALE_MIN = 2;
  var SCALE_STEPS = 5000;
  // The calibration is kept on the device (see readCalibration()), so it is
  // asked for only the first time.
  var CALIBRATION_KEY = "emjive_calibration";
  var CALIBRATION_VERSION = 1;
  var SCALE_MAX = 60;
  // The three lines: each one device pixel thick (linePx()), and what is
  // measured is its inner edge's distance from the screen's centre along the
  // line's normal. There is no upper limit, so a ring can lie as off-centre
  // as the visitor likes, but a line can't be pulled past the centre
  // (LINE_MIN_MM): a line touches the ring's inner edge on both of its sides,
  // and on the far one the triangle would no longer surround the ring (it
  // would be an excircle's) and the mean would be wrong, which three numbers
  // can't tell. The lines' normals are LINE_ANGLES apart, which is what makes
  // the triangle equilateral. A line runs to infinity (css/style.css), is dragged from
  // anywhere along it, and moves in whole device pixels, so it is as crisp as
  // it can be (a slanted one is anti-aliased all the same). The measure is
  // taken twice, each line read once going out and once coming in (the
  // "measure" and "measure2" steps), and the two weighed (lineMm()). The
  // result is a circle drawn as an outline as thick as the result's range.
  // How much the first pass, going out, counts in a line's distance; the
  // second, coming in, counts for the rest.
  var FIRST_PASS_WEIGHT = 0.66;
  // The range round the size (see measureResult()): RANGE_SD standard
  // deviations of the rounds' mean. One round's scatter is taken to be
  // SCATTER_MM until the rounds show their own (so one round's range is
  // ±0.4 mm), that guess counting for SCATTER_WEIGHT rounds' worth of spread.
  var SCATTER_MM = 0.2;
  var SCATTER_WEIGHT = 2;
  var RANGE_SD = 2;
  // As soon as at least AGREE_ROUNDS rounds, any of them, all lie within
  // AGREE_MM of their own average, the range gives way to a single size (their
  // average), drawn as a circle SETTLED_PX thick.
  var AGREE_ROUNDS = 3;
  var AGREE_MM = 0.25;
  var SETTLED_PX = 0.75;
  // The result circle's band is the range drawn BAND_SCALE times as thick
  // (about its middle), so a change of range shows, over the number of rounds
  // that agree (the biggest agreeing group): it thins as they come to agree,
  // to the settled size's plain outline.
  var BAND_SCALE = 50;
  // A line, and the calibration slider's dot, follow only this share of the
  // pointer's movement, so they move slower than the finger and take more care
  // to place.
  var DRAG_GAIN = 0.5;
  var LINE_MIN_MM = 0;
  // Where the lines start on the first pass, near the centre.
  var LINE_START_MM = 1.5;
  // On the second pass they start far out: this fraction of the way to the
  // screen's farthest corner in the line's direction.
  var FAR_FRACTION = 0.5;
  // How far under the screen's centre the lines' centre stands, to leave the
  // label room above (rem).
  var CENTRE_DROP_REM = 3;
  var LINE_ANGLES = [0, 120, 240];
  var LINE_CURSORS = ["ns-resize", "nwse-resize", "nesw-resize"];
  // CSS's own reference, until the visitor has calibrated.
  var DEFAULT_SCALE = 96 / 25.4;
  // How long a step fades out before the next one takes its place.
  var SWAP_MS = 200;
  // The top band's coming down on the calibration's first arrival: how long it
  // takes, and how far in from its right end the slider's dot slides.
  var FIT_MS = 1100;
  var FIT_SLIDE = 0.05;

  var TEXT = {
    ask: "Do you have a fitting ring at your disposal?",
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

  // What each step shows: the parts that are visible, and the shape.
  var STEPS = {
    ask:       { parts: ["ask"], shape: null },
    calibrate: { parts: ["controls"], shape: "card" },
    measure:   { parts: ["controls"], shape: null },
    measure2:  { parts: ["controls"], shape: null },
    result:    { parts: ["result"], shape: null },
    chart:     { parts: ["chart"], shape: null }
  };

  var state = {
    built: false,
    isOpen: false,
    step: null,
    scale: DEFAULT_SCALE,
    // Each pass's three lines' distances from the centre (mm) — the first
    // going out, the second coming in — and whether the visitor has moved each
    // yet.
    lines: [[LINE_START_MM, LINE_START_MM, LINE_START_MM], [0, 0, 0]],
    touched: [[false, false, false], [false, false, false]],
    lastSize: null,
    // What the result screen shows while there is a lastSize: { size, count,
    // lo, hi } — the final size (lastSize), how many rounds it is the mean
    // of, and the range round it.
    lastResult: null,
    // The rounds measured on this ring: each { diameter (mm, both passes
    // weighed) }.
    rounds: [],
    // The steps behind, each with the size that was to be filled at the time.
    history: [],
    options: null,
    swapTimer: null,
    fitFrame: 0
  };
  var nodes = {};

  // This round, from the lines as they are.
  function currentRound() {
    return { diameter: diameterFromLines() };
  }

  // What the result shows, from the rounds: the final size, the mean of the
  // rounds' sizes (lastSize), and its range, in mm. The range is RANGE_SD
  // times the scatter of one round over √(rounds), each bound to the nearest
  // tenth. One round can't show its own scatter, so it is SCATTER_MM (±0.4
  // mm); from two rounds on, their spread takes over, blended with
  // SCATTER_MM as if it were SCATTER_WEIGHT rounds' worth (pooled variances),
  // so two rounds that happen to agree don't claim a range of nothing, and
  // rounds that disagree widen it. The more rounds, the more it is theirs.
  // Once a group of at least AGREE_ROUNDS rounds agree (see agreeingGroup())
  // the result is settled: a single size, the group's average, the rounds
  // outside it (one that went wrong, the ring moved) left out.
  function measureResult() {
    var sizes = state.rounds.map(function (round) { return Math.PI * round.diameter; });
    var n = sizes.length;
    var group = agreeingGroup(sizes);
    if (group) {
      var settled = Math.round(group.average * 10) / 10;
      return { size: settled, count: n, settled: true, lo: settled, hi: settled };
    }
    var mean = sizes.reduce(function (sum, size) { return sum + size; }, 0) / n;
    var squares = sizes.reduce(function (sum, size) { return sum + (size - mean) * (size - mean); }, 0);
    var variance = (SCATTER_WEIGHT * SCATTER_MM * SCATTER_MM + squares) / (SCATTER_WEIGHT + n - 1);
    var half = (RANGE_SD * Math.sqrt(variance)) / Math.sqrt(n);
    return {
      size: Math.round(mean * 10) / 10,
      count: n,
      settled: false,
      // How many rounds agree (one always does, with itself).
      agreeing: agreeingGroup(sizes, 1).count,
      lo: Math.round((mean - half) * 10) / 10,
      hi: Math.round((mean + half) * 10) / 10
    };
  }

  // The biggest group of at least minCount sizes (AGREE_ROUNDS unless given),
  // any of them, that all lie within AGREE_MM of the group's average, or null. Between groups as big,
  // the tightest. A group is a run of the sizes in order (the rounds are few,
  // so every run is tried).
  function agreeingGroup(sizes, minCount) {
    var min = minCount || AGREE_ROUNDS;
    var sorted = sizes.slice().sort(function (a, b) { return a - b; });
    var best = null;
    for (var i = 0; i < sorted.length; i++) {
      for (var j = i + min - 1; j < sorted.length; j++) {
        var run = sorted.slice(i, j + 1);
        var average = run.reduce(function (sum, size) { return sum + size; }, 0) / run.length;
        // Sorted: only the two ends can be furthest from the average.
        if (average - run[0] > AGREE_MM || run[run.length - 1] - average > AGREE_MM) continue;
        var spread = run[run.length - 1] - run[0];
        if (!best || run.length > best.count || (run.length === best.count && spread < best.spread)) {
          best = { count: run.length, spread: spread, average: average };
        }
      }
    }
    return best;
  }

  // The screen a calibration was made on: the device pixel ratio (which a
  // desktop browser's zoom changes too) and the screen's size, either way up.
  function screenId() {
    var w = global.screen ? global.screen.width : 0;
    var h = global.screen ? global.screen.height : 0;
    return [global.devicePixelRatio || 1, Math.min(w, h), Math.max(w, h)].join("x");
  }

  // The stored calibration (px per mm), or null: none yet, made on another
  // screen (or at another zoom), unreadable, or not a plausible scale —
  // localStorage can be blocked, stale or edited.
  function readCalibration() {
    try {
      var stored = JSON.parse(global.localStorage.getItem(CALIBRATION_KEY));
      if (!stored || stored.v !== CALIBRATION_VERSION || stored.screen !== screenId()) return null;
      var scale = Number(stored.scale);
      return isFinite(scale) && scale >= SCALE_MIN && scale <= SCALE_MAX ? scale : null;
    } catch (e) {
      return null;
    }
  }

  function saveCalibration(scale) {
    try {
      global.localStorage.setItem(CALIBRATION_KEY, JSON.stringify({ v: CALIBRATION_VERSION, scale: scale, screen: screenId() }));
    } catch (e) {
      // Storage blocked or full: the calibration is asked for again next time.
    }
  }

  // A size here is the ring's inner circumference, in mm, to a tenth.
  function sizeFromDiameter(mm) {
    return Math.round(Math.PI * mm * 10) / 10;
  }

  // The ring's inner diameter from the three lines: the inscribed circle's
  // radius is the mean of their distances (see the header).
  // A line's distance, read once on each pass, the two weighed: a visitor
  // stops a little late both ways (past the edge going out, past it again
  // coming in), but later coming in — a line that appears is seen later than
  // one that disappears — so the first pass, the nearer, counts for
  // FIRST_PASS_WEIGHT and the second for the rest, which cancels both
  // overshoots. Fitted to a size 52 ring read 52.6 going out and 50.5 coming
  // in, round after round.
  function lineMm(i) {
    return FIRST_PASS_WEIGHT * state.lines[0][i] + (1 - FIRST_PASS_WEIGHT) * state.lines[1][i];
  }

  function diameterFromLines() {
    return (2 * (lineMm(0) + lineMm(1) + lineMm(2))) / 3;
  }

  // The pass on screen: 0 going out (measure), 1 coming in (measure2).
  function pass() {
    return state.step === "measure2" ? 1 : 0;
  }

  // A line is one device pixel thick, and moves in them.
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

  // The lines' centre in px from the screen's top: under the screen's centre,
  // on a whole device pixel so a horizontal line is crisp.
  function centreY() {
    var rem = parseFloat(global.getComputedStyle(document.documentElement).fontSize) || 16;
    var dpr = global.devicePixelRatio || 1;
    return Math.round((nodes.root.clientHeight / 2 + CENTRE_DROP_REM * rem) * dpr) / dpr;
  }

  function placeCentre() {
    nodes.root.style.setProperty("--finder-cy", centreY() + "px");
  }

  // The second pass's starting places: each line far out, on its way in.
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
     (css/style.css .size-finder__thumb::before). The dot follows DRAG_GAIN of
     the pointer from where it was grabbed (so one swipe covers half the
     track). It is a slider for a keyboard and a screen reader too. */
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
      drag = { id: e.pointerId, x: e.clientX, from: (cfg.value - cfg.min) / (cfg.max - cfg.min) };
      thumb.setPointerCapture(e.pointerId);
      root.focus({ preventScroll: true });
    });
    thumb.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var rail = track.getBoundingClientRect();
      var at = drag.from + (DRAG_GAIN * (e.clientX - drag.x)) / rail.width;
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

  /* ---- the lines -------------------------------------------------------------
     A line is two elements in the same place: the bar (css/style.css
     .size-finder__line, an inversion over everything, taking no touch) and,
     under the label and the buttons, a wider invisible strip along it
     (.size-finder__line-hit) that takes the pointer — the line is dragged from
     anywhere on it. Both sit at the lines' centre turned by the line's angle,
     and are pushed out along its own normal — (sin a, -cos a) on the screen —
     by its distance, and run to infinity (their length is CSS). The pointer's
     movement is projected on that normal, so the line can only go in or out,
     and follows DRAG_GAIN of it from where it was grabbed. Also a slider for a keyboard and
     a screen reader: arrows, PageUp/PageDown and Home, "up" being away
     from the centre. */
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
    var drag = null;

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

    // The strip is too wide to ring, so a keyboard's focus shows on the bar.
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

    hit.addEventListener("pointerdown", function (e) {
      if (e.button) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: state.lines[pass()][index] };
      hit.setPointerCapture(e.pointerId);
      hit.focus({ preventScroll: true });
    });
    hit.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var along = (DRAG_GAIN * ((e.clientX - drag.x) * nx + (e.clientY - drag.y) * ny)) / state.scale;
      setDistance(drag.from + along);
    });
    function release(e) {
      if (drag && e.pointerId === drag.id) drag = null;
    }
    hit.addEventListener("pointerup", release);
    hit.addEventListener("pointercancel", release);
    hit.addEventListener("lostpointercapture", release);

    hit.addEventListener("keydown", function (e) {
      var now = state.lines[pass()][index];
      var step = linePx() / state.scale;
      var to = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") to = now + step;
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") to = now - step;
      else if (e.key === "PageUp") to = now + 10 * step;
      else if (e.key === "PageDown") to = now - 10 * step;
      else if (e.key === "Home") to = LINE_MIN_MM;
      if (to === null) return;
      e.preventDefault();
      setDistance(to);
    });

    return { bar: bar, hit: hit, render: render };
  }

  /* ---- scale ---------------------------------------------------------------
     The calibration is two inversions the screen's whole width: a band at the
     bottom, fixed, whose top edge (the marker above the slider) the card
     stands on, upright, and a band from the top that the slider brings down
     onto the card's top edge. The gap between them is then the card's long
     side, CARD_LONG_MM, which is where the px per mm come from. Only straight
     edges across the screen, which a solid card can be matched against: none
     of them is under the card. */

  // The bottom band's top edge, where the card stands, from the top of the
  // screen: just above the slider, where the marker stands (so it has to be
  // laid out).
  function cardEdgeY() {
    var edge = nodes.edge.getBoundingClientRect();
    return edge.top + edge.height / 2 - nodes.root.getBoundingClientRect().top;
  }

  // The top band's bottom edge for a scale, and the scale for that edge (px
  // from the top of the screen).
  function edgeFromScale(scale) {
    return cardEdgeY() - CARD_LONG_MM * scale;
  }

  function scaleFromEdge(y) {
    return (cardEdgeY() - y) / CARD_LONG_MM;
  }

  // The top band out of sight, at the top of the screen: the biggest scale.
  function scaleMax() {
    return scaleFromEdge(0);
  }

  // The slider moves the top band's edge evenly, from the bottom band's edge
  // (the slider's left end, the bands touching) up to the top of the screen
  // (its right end, the band just out of sight).
  function scaleFromSlider(position) {
    return scaleFromEdge((1 - position / SCALE_STEPS) * cardEdgeY());
  }

  function sliderFromScale(scale) {
    var bottom = cardEdgeY();
    if (!bottom) return 0;
    return Math.max(0, Math.min(SCALE_STEPS, (1 - edgeFromScale(scale) / bottom) * SCALE_STEPS));
  }

  // The gap between the bands is the card's height at the scale; its bottom
  // edge is fixed (css/style.css .size-finder__card).
  function renderCard() {
    nodes.card.style.height = CARD_LONG_MM * state.scale + "px";
    nodes.root.style.setProperty("--finder-edge", cardEdgeY() + "px");
    renderValidate();
  }

  // Where the top band comes down to on the calibration's first arrival, so
  // the way it moves is clear: the slider's dot FIT_SLIDE of the way in from
  // its right end.
  function scaleFit() {
    return scaleFromSlider((1 - FIT_SLIDE) * SCALE_STEPS);
  }

  function cancelFit() {
    cancelAnimationFrame(state.fitFrame);
    state.fitFrame = 0;
  }

  // The top band from out of sight at the top of the screen down to
  // scaleFit(): the slider's dot goes with it. Any touch of the slider, a
  // resize or leaving the step ends it where it is.
  function shrinkCardToFit() {
    cancelFit();
    var from = state.scale;
    var to = Math.min(from, Math.max(scaleFit(), SCALE_MIN));
    function set(scale) {
      state.scale = scale;
      nodes.slider.setValue(sliderFromScale(scale));
      renderCard();
    }
    if (global.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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

  // The result's circle: a plain white outline, a band round the middle of
  // the range, BAND_SCALE over the agreeing rounds times as thick as the range (as lengths on the
  // screen: the circumferences over π, in px at the calibrated scale), so a
  // change of range shows; drawn where the triangle's inscribed circle is.
  // That circle's centre
  // c is where each line's distance, n_i . c = p_i - r, holds; as the normals
  // are 120° apart (n_i . n_i summing to 3/2, the n_i to nothing) c = 2/3 ×
  // sum of p_i n_i.
  function renderOutline() {
    var cx = 0;
    var cy = 0;
    LINE_ANGLES.forEach(function (angle, i) {
      var a = (angle * Math.PI) / 180;
      cx += lineMm(i) * Math.sin(a);
      cy -= lineMm(i) * Math.cos(a);
    });
    var result = state.lastResult;
    var perMm = state.scale;
    var stroke = (BAND_SCALE / result.agreeing) * ((result.hi - result.lo) / (2 * Math.PI)) * perMm;
    var box = ((result.lo + result.hi) / (2 * Math.PI)) * perMm + stroke;
    // A settled size: a plain outline SETTLED_PX thick, centred on it.
    if (result.settled) {
      stroke = SETTLED_PX;
      box = (result.size / Math.PI) * perMm + SETTLED_PX;
    }
    nodes.outline.style.width = box + "px";
    nodes.outline.style.height = box + "px";
    // An inset shadow rather than a border: a border is snapped to whole
    // device pixels, a stroke of a fraction of one is not.
    nodes.outline.style.boxShadow = "inset 0 0 0 " + stroke + "px #fff";
    nodes.outline.style.transform =
      "translate(-50%, -50%) translate(" + (2 / 3) * cx * state.scale + "px, " + (2 / 3) * cy * state.scale + "px)";
  }

  // Validate waits for every line to have been moved by the visitor, and, on
  // the calibration, for a gap between the bands that a screen can have.
  function renderValidate() {
    var measuring = state.step === "measure" || state.step === "measure2";
    nodes.validate.disabled = (measuring && !state.touched[pass()].every(Boolean)) ||
      (state.step === "calibrate" && !(state.scale >= SCALE_MIN));
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

    // The ring's three lines. What takes the pointer (a strip along each)
    // goes first, under the label and the buttons so those stay reachable;
    // the bars themselves are added over everything further down.
    nodes.lines = LINE_ANGLES.map(function (angle, index) {
      var line = makeLine(index, renderValidate);
      root.appendChild(line.hit);
      return line;
    });

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
    // Refine until the size is settled, then another ring takes its place.
    var refine = button("Measure again to refine");
    var another = button("Measure another ring");
    var other = button("Use a different method");
    nodes.result.appendChild(refine);
    nodes.result.appendChild(another);
    nodes.result.appendChild(other);
    nodes.refine = refine;
    nodes.another = another;

    nodes.chart = el("div", "size-finder__chart size-guide");
    top.appendChild(nodes.chart);
    root.appendChild(top);

    // The slider (the calibration's only) and Validate — the calibration's and
    // the ring's alike — and, while calibrating, an invisible marker above
    // them: the height the card's bottom edge goes at.
    nodes.controls = el("div", "size-finder__controls");
    nodes.edge = el("div", "size-finder__edge");
    nodes.edge.setAttribute("aria-hidden", "true");
    nodes.controls.appendChild(nodes.edge);
    nodes.slider = makeSlider(function (value) {
      cancelFit();
      state.scale = scaleFromSlider(value);
      renderCard();
    });
    // The first touch of the slider ends the card's shrink, before it moves.
    nodes.slider.el.addEventListener("pointerdown", cancelFit);
    nodes.slider.el.addEventListener("keydown", cancelFit);
    var validate = button("Validate");
    nodes.validate = validate;
    nodes.controls.appendChild(nodes.slider.el);
    nodes.controls.appendChild(validate);
    root.appendChild(nodes.controls);
    root.appendChild(nodes.result);

    // The cross comes after the parts so nothing covers it, and before the
    // shapes so they still invert it.
    root.appendChild(back);
    root.appendChild(close);

    // The result's circle: a plain white outline, not an inversion.
    nodes.outline = el("div", "size-finder__outline");
    nodes.outline.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.outline);

    // The lines' bars, over everything: they invert what they cross.
    nodes.lines.forEach(function (line) { root.appendChild(line.bar); });

    // The card window, last so it is over everything.
    nodes.card = el("div", "size-finder__card");
    nodes.card.setAttribute("aria-hidden", "true");
    root.appendChild(nodes.card);

    nodes.primary = { ask: yes, calibrate: nodes.slider.el, measure: nodes.lines[0].hit, measure2: nodes.lines[0].hit, result: refine };

    // Straight to the measure when this screen has been calibrated before.
    yes.addEventListener("click", function () {
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
    no.addEventListener("click", function () {
      advance("chart", function () { state.lastSize = null; });
    });
    // Another round on the same ring: its size is averaged in.
    refine.addEventListener("click", function () {
      advance("measure", resetLines);
    });
    // A new ring: its rounds start over (the size measured stays the one to
    // fill until a new one is validated).
    another.addEventListener("click", function () {
      advance("measure", function () {
        state.rounds = [];
        resetLines();
      });
    });
    other.addEventListener("click", function () {
      advance("chart", function () { state.lastSize = null; });
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
        state.rounds = state.rounds.concat([currentRound()]);
        var result = measureResult();
        state.lastSize = result.size;
        state.lastResult = result;
      });
    });

    document.body.appendChild(root);
  }

  /* ---- steps ---------------------------------------------------------------- */

  // Moves on to a step, remembering this one (and the size to be filled, and
  // the rounds, as they were) for the arrow; `change` is whatever the move
  // changes. The rounds are only ever replaced, never changed in place, so
  // the one kept here stays as it was.
  function advance(step, change) {
    state.history.push({ step: state.step, lastSize: state.lastSize, lastResult: state.lastResult, rounds: state.rounds });
    if (change) change();
    go(step);
  }

  function goBack() {
    var entry = state.history.pop();
    if (!entry) return;
    state.lastSize = entry.lastSize;
    state.lastResult = entry.lastResult;
    state.rounds = entry.rounds;
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
    // The ring's lines are dragged on their own: the slider is the card's.
    nodes.slider.el.hidden = step !== "calibrate";
    nodes.back.hidden = state.history.length === 0;
    if (step !== "calibrate") cancelFit();

    var text = TEXT[step] || "";
    if (step === "result") {
      text = state.lastResult.settled
        ? "Measured size: " + state.lastSize.toFixed(1) + " mm."
        : "Measured range: " + state.lastResult.lo.toFixed(1) + " to " + state.lastResult.hi.toFixed(1) + " mm.";
    }
    var paragraphs = [].concat(text).filter(Boolean);
    nodes.label.innerHTML = "";
    paragraphs.forEach(function (paragraph) {
      nodes.label.appendChild(el("p", "size-finder__paragraph", paragraph));
    });
    nodes.label.hidden = !paragraphs.length;

    // The lines fade out on Validate, and the circle of the measure takes
    // their place.
    var measuring = step === "measure" || step === "measure2";
    nodes.lines.forEach(function (line) { line.bar.classList.toggle("is-on", measuring); });
    nodes.outline.classList.toggle("is-on", step === "result");
    if (measuring || step === "result") placeCentre();
    if (measuring) renderLines();
    if (step === "result") renderOutline();
    renderValidate();
    nodes.card.classList.toggle("is-on", def.shape === "card");

    if (step === "calibrate") {
      // First time in: the card at its biggest, which needs the marker laid
      // out, and from there it shrinks until its edges are in view.
      var arriving = state.scale === null;
      if (arriving) state.scale = scaleMax();
      nodes.slider.configure({ min: 0, max: SCALE_STEPS, step: 1, value: sliderFromScale(state.scale), label: "Card size" });
      renderCard();
      if (arriving) shrinkCardToFit();
    }

    // A settled size can't be refined any further: another ring instead.
    var settled = step === "result" && state.lastResult.settled;
    nodes.refine.hidden = settled;
    nodes.another.hidden = !settled;

    // Focus follows the step, unless the dialog has only just opened.
    var primary = nodes.primary[step] || nodes.chart.querySelector(".size-guide__scroll") || nodes.back;
    if (primary === nodes.refine && settled) primary = nodes.another;
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

  /* ---- open / close ----------------------------------------------------------- */

  function openFinder(options) {
    if (state.isOpen) return;
    build();
    state.options = options || {};
    state.lastSize = null;
    state.lastResult = null;
    state.rounds = [];
    state.history = [];
    state.scale = DEFAULT_SCALE;
    resetLines();
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
