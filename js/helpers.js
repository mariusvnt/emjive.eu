// Shared browser helpers (window.EmjiveHelpers): the small utilities more than
// one script needs, kept here instead of copied into each. Loaded first and
// blocking on every page, and by the dev pages that load the 3D modules, so
// every script (head ones and modules included) can rely on it.

(function () {
  "use strict";

  /* ---- elements ---- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---- numbers ---- */

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  function clamp01(x) {
    return clamp(x, 0, 1);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // 0 up to a, 1 from b, eased at both ends.
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  // 0..1 with zero speed and acceleration at both ends.
  function smootherstep(u) {
    var t = clamp01(u);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  // The u where smootherstep(u) is y, by bisection.
  function invSmootherstep(y) {
    var lo = 0;
    var hi = 1;
    for (var i = 0; i < 30; i++) {
      var mid = (lo + hi) / 2;
      if (smootherstep(mid) < y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* ---- timing ---- */

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // fn when the browser is idle, at most timeoutMs later; after fallbackMs
  // where requestIdleCallback is missing (Safari).
  function whenIdle(fn, timeoutMs, fallbackMs) {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: timeoutMs });
    else setTimeout(fn, fallbackMs);
  }

  // A function running fn once after the next paint, however often it's called
  // before then: rAF precedes the paint, the timeout follows it.
  function afterPaint(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        setTimeout(function () {
          queued = false;
          fn();
        }, 0);
      });
    };
  }

  // fn once el's own `prop` transition ends, or after ms (no transitionend in
  // a background tab). Returns a cancel.
  function afterTransition(el, prop, ms, fn) {
    var done = false;
    var timer = setTimeout(finish, ms);
    function onEnd(e) {
      if (e.target === el && e.propertyName === prop) finish();
    }
    function cancel() {
      done = true;
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
    }
    function finish() {
      if (done) return;
      cancel();
      fn();
    }
    el.addEventListener("transitionend", onEnd);
    return cancel;
  }

  function transitionDone(el, prop, ms) {
    return new Promise(function (resolve) { afterTransition(el, prop, ms, resolve); });
  }

  /* ---- images ---- */

  // Loaded (or broken) and decoded; the decode is raced so a hung one can't
  // hold what waits on it.
  function imageReady(img) {
    return new Promise(function (resolve) {
      function settle() {
        if (img.decode) {
          var timer = setTimeout(resolve, 1000);
          img.decode().then(function () { clearTimeout(timer); resolve(); },
            function () { clearTimeout(timer); resolve(); });
        } else {
          resolve();
        }
      }
      // complete is true for loaded and broken images, false for an unstarted lazy one.
      if (img.complete) settle();
      else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", resolve, { once: true });
      }
    });
  }

  /* ---- scrolling ---- */

  // Instant whatever html's scroll-behavior. behavior: "instant" is wrapped as
  // older browsers throw on it.
  function jumpScroll(top) {
    var html = document.documentElement;
    var previous = html.style.scrollBehavior;
    html.style.scrollBehavior = "auto";
    try {
      window.scrollTo({ top: top, left: 0, behavior: "instant" });
    } catch (e) {
      window.scrollTo(0, top);
    }
    if (previous) html.style.scrollBehavior = previous;
    else html.style.removeProperty("scroll-behavior");
  }

  /* ---- storage ----
     `area` is "localStorage" or "sessionStorage". Storage can throw (Safari
     private mode, a full quota, blocked site data): reads come back empty and
     writes report false. */

  function readStorage(area, key) {
    try { return window[area].getItem(key); } catch (e) { return null; }
  }

  // The stored JSON object, or null if absent, unparsable or not an object.
  function readStorageJson(area, key) {
    try {
      var parsed = JSON.parse(window[area].getItem(key));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeStorage(area, key, value) {
    try {
      window[area].setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeStorage(area, key) {
    try { window[area].removeItem(key); } catch (e) { /* nothing was kept */ }
  }

  /* ---- input ---- */

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // The value a key asks of a slider at `now`: arrows by step (up and right
  // raise it), PageUp/PageDown by page, Home/End to min/max when given; null
  // for any other key.
  function sliderKey(e, now, step, page, min, max) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp": return now + step;
      case "ArrowLeft":
      case "ArrowDown": return now - step;
      case "PageUp": return now + page;
      case "PageDown": return now - page;
      case "Home": return min === undefined ? null : min;
      case "End": return max === undefined ? null : max;
    }
    return null;
  }

  // One captured pointer at a time on `target`, primary button only.
  // start(e) returns the drag's state (nothing ignores the press); move(e, drag)
  // and end(drag) only see that pointer, which ends on up, cancel or a lost capture.
  function dragPointer(target, start, move, end) {
    var drag = null;
    var id = null;
    target.addEventListener("pointerdown", function (e) {
      if (e.button) return;
      var next = start(e);
      if (!next) return;
      e.preventDefault();
      drag = next;
      id = e.pointerId;
      try { target.setPointerCapture(id); } catch (err) { /* the pointer is already gone */ }
    });
    target.addEventListener("pointermove", function (e) {
      if (drag && e.pointerId === id) move(e, drag);
    });
    function release(e) {
      if (!drag || e.pointerId !== id) return;
      var ended = drag;
      drag = null;
      if (end) end(ended);
    }
    target.addEventListener("pointerup", release);
    target.addEventListener("pointercancel", release);
    target.addEventListener("lostpointercapture", release);
  }

  /* ---- network ---- */

  // JSON from url, POSTing `body` as JSON when given. Fails with the server's
  // { error } message, else the HTTP status.
  function requestJson(url, body) {
    var options = body === undefined ? undefined : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      });
    });
  }

  /* ---- catalog ---- */

  // A product's (or design view's) picture of one kind ("icons", "fallback-img",
  // "wheel-poster") in one metal; "" without one.
  function assetFor(product, kind, metal) {
    var assets = product && product.assets;
    return (assets && assets[kind] && assets[kind][metal]) || "";
  }

  // A viewer's stand-in: its first frame (fallback-img), else the icon.
  function posterFor(product, metal) {
    return assetFor(product, "fallback-img", metal) || assetFor(product, "icons", metal);
  }

  // The size, in mm, a product's model is drawn at and its per-metal prices are
  // given for. Mirrored in scripts/helpers.js (validate-data checks).
  var REFERENCE_SIZE_MM = 62;
  var DEFAULT_SIZE_RANGE = { min: 40, max: 80 };

  // A product's orderable sizes, { min, max } in mm; the default for a missing
  // or malformed "size-range".
  function sizeRange(product) {
    var range = (product && product["size-range"]) || {};
    var min = Number(range.min);
    var max = Number(range.max);
    return isFinite(min) && isFinite(max) && min > 0 && max >= min
      ? { min: min, max: max }
      : { min: DEFAULT_SIZE_RANGE.min, max: DEFAULT_SIZE_RANGE.max };
  }

  /* ---- plan views ---- */

  // The specs stage's outline views of a model, in its own frame:
  // scripts/auto-render.js draws them, js/product.js marks their measurements,
  // js/three-viewer.js turns the live model to them. `eye` is the camera's
  // side, `up` the drawing's up. As on a technical drawing: front looks
  // through the finger hole (+Z), top looks down with the front at the bottom,
  // side is from the right.
  var PLAN_VIEWS = {
    top: { eye: [0, 1, 0], up: [0, 0, -1] },
    front: { eye: [0, 0, 1], up: [0, 1, 0] },
    side: { eye: [1, 0, 0], up: [0, 1, 0] }
  };
  // The share of a tile the model's longest extent fills at its largest size.
  var PLAN_FILL = 0.64;
  // The stroke's room around a drawing, as a share of the longest extent.
  var PLAN_PAD = 0.006;

  // A product's plan views from geometry["axis-box"], null without it. All
  // three are drawn at one scale, centred on the box and cropped to one
  // rectangle, `crop` mm: the largest drawing's width and height plus the
  // stroke's room. Each view measures one of the box's three axes, the
  // three views one each (length, width and depth), the choice putting the
  // measured side over the other in as many views as possible. Its drawing
  // is w x h mm (along `right`, and `up`); `axis` (0, 1, 2: x, y, z) is the
  // axis it measures, `horizontal` whether that is the `right` one. `size` is
  // the box's x, y and z, mm. `render` is the square, mm across, the renderer
  // draws before cropping; `tile` the square, mm across, a tile of the column
  // stands for (the drawing's scale on the page).
  function planFrame(product) {
    var box = product && product.geometry && product.geometry["axis-box"];
    var size = box && Array.isArray(box.size) && box.size.length === 3 ? box.size.map(Number) : null;
    if (!size || !size.every(function (d) { return d > 0; })) return null;
    var maxFactor = Math.max(1, sizeRange(product).max / REFERENCE_SIZE_MM);
    var along = function (axis) {
      return Math.abs(axis[0]) * size[0] + Math.abs(axis[1]) * size[1] + Math.abs(axis[2]) * size[2];
    };
    var rightOf = function (u, e) {
      return [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
    };
    var axisOf = function (v) {
      return v[0] !== 0 ? 0 : v[1] !== 0 ? 1 : 2;
    };
    var names = Object.keys(PLAN_VIEWS);
    var axes = names.map(function (name) {
      var e = PLAN_VIEWS[name].eye;
      var u = PLAN_VIEWS[name].up;
      return [axisOf(rightOf(u, e)), axisOf(u)];
    });
    // Which of each view's two axes it measures: every axis once.
    var chosen = null;
    for (var mask = 0; mask < 8; mask++) {
      var picks = names.map(function (name, i) { return (mask >> i) & 1; });
      var used = picks.map(function (k, i) { return axes[i][k]; });
      if (used.indexOf(0) === -1 || used.indexOf(1) === -1 || used.indexOf(2) === -1) continue;
      var wins = 0;
      picks.forEach(function (k, i) {
        if (size[axes[i][k]] >= size[axes[i][1 - k]]) wins++;
      });
      if (!chosen || wins > chosen.wins) chosen = { picks: picks, wins: wins };
    }
    var views = {};
    names.forEach(function (name, i) {
      var e = PLAN_VIEWS[name].eye;
      var u = PLAN_VIEWS[name].up;
      var right = rightOf(u, e);
      views[name] = {
        eye: e, up: u, right: right, axis: axes[i][chosen.picks[i]], horizontal: chosen.picks[i] === 0,
        w: along(right), h: along(u)
      };
    });
    var longest = Math.max(size[0], size[1], size[2]);
    var crop = { w: 0, h: 0 };
    Object.keys(views).forEach(function (name) {
      crop.w = Math.max(crop.w, views[name].w);
      crop.h = Math.max(crop.h, views[name].h);
    });
    crop.w += 2 * PLAN_PAD * longest;
    crop.h += 2 * PLAN_PAD * longest;
    return {
      center: box.center.map(Number),
      size: size,
      crop: crop,
      render: Math.max(crop.w, crop.h) * 1.1,
      tile: longest * maxFactor / PLAN_FILL,
      views: views
    };
  }

  // An icon's 128px thumbnail version (scripts/make-image-variants.js).
  function thumbSrc(src) {
    return src && window.EmjiveLoader ? window.EmjiveLoader.variant(src, "128") : src;
  }

  // img shows src's thumbnail, falling back to src itself; none without src.
  function setThumb(img, src) {
    if (!src) img.removeAttribute("src");
    else if (window.EmjiveLoader) window.EmjiveLoader.setSrc(img, thumbSrc(src), src);
    else img.src = src;
  }

  // Decoded ahead, so a later swap to one shows at once; kept referenced so
  // they stay in memory.
  var preloaded = {};
  function preload(srcs) {
    srcs.forEach(function (src) {
      if (!src || preloaded[src]) return;
      var img = new Image();
      img.src = src;
      if (img.decode) img.decode().catch(function () {});
      preloaded[src] = img;
    });
  }

  /* ---- invert bands ---- */

  // Safari's backdrop-filter re-samples late when content under an invert band
  // changes in place; nudging the band's filter (.is-resampling) for two frames
  // forces it.
  var resampleTokens = new WeakMap();
  function resampleBand(el) {
    if (!el) return;
    var token = (resampleTokens.get(el) || 0) + 1;
    resampleTokens.set(el, token);
    el.classList.add("is-resampling");
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (resampleTokens.get(el) === token) el.classList.remove("is-resampling");
      });
    });
  }

  window.EmjiveHelpers = {
    el: el,
    clamp: clamp,
    clamp01: clamp01,
    lerp: lerp,
    smoothstep: smoothstep,
    smootherstep: smootherstep,
    invSmootherstep: invSmootherstep,
    easeOutCubic: easeOutCubic,
    easeInOutCubic: easeInOutCubic,
    wait: wait,
    whenIdle: whenIdle,
    afterPaint: afterPaint,
    afterTransition: afterTransition,
    transitionDone: transitionDone,
    imageReady: imageReady,
    jumpScroll: jumpScroll,
    readStorage: readStorage,
    readStorageJson: readStorageJson,
    writeStorage: writeStorage,
    removeStorage: removeStorage,
    reducedMotion: reducedMotion,
    sliderKey: sliderKey,
    dragPointer: dragPointer,
    requestJson: requestJson,
    assetFor: assetFor,
    posterFor: posterFor,
    REFERENCE_SIZE_MM: REFERENCE_SIZE_MM,
    sizeRange: sizeRange,
    PLAN_VIEWS: PLAN_VIEWS,
    planFrame: planFrame,
    thumbSrc: thumbSrc,
    setThumb: setThumb,
    preload: preload,
    resampleBand: resampleBand
  };
})();
