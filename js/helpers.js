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

  // Marks which ends of a sideways-scrolling strip are cut off
  // (.is-clipped-start, .is-clipped-end), for its edge fades (.edge-scroll
  // in css/style.css), kept up as it scrolls, resizes (shown, too: a strip
  // built hidden measures nothing), its text changes and the fonts load.
  function edgeFades(node) {
    function mark() {
      node.classList.toggle("is-clipped-start", node.scrollLeft > 1);
      node.classList.toggle("is-clipped-end", node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    }
    node.addEventListener("scroll", mark, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(mark).observe(node);
    if (typeof MutationObserver === "function") new MutationObserver(mark).observe(node, { childList: true, characterData: true, subtree: true });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(mark);
    mark();
  }

  // The root font size, px: what 1rem is.
  function remPx() {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  }

  // px rounded to whole device pixels (at least `min` of them, if given): a
  // hairline the browser can't draw one pixel wider here than there, a
  // translate that doesn't blur a horizontal hairline across two rows.
  function devicePx(px, min) {
    var ratio = window.devicePixelRatio || 1;
    return Math.max(min || 0, Math.round(px * ratio)) / ratio;
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

  // Cubic-bezier easing (control points (x1, y1), (x2, y2)), solved by
  // Newton-Raphson as browsers do for CSS.
  function cubicBezierEase(t, x1, y1, x2, y2) {
    function componentAt(u, a, b) {
      var v = 1 - u;
      return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u;
    }
    var u = t;
    for (var i = 0; i < 8; i++) {
      var x = componentAt(u, x1, x2) - t;
      var dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(dx) < 1e-6) break;
      u = clamp01(u - x / dx);
    }
    return componentAt(u, y1, y2);
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
  // The size, in mm, a ring is first shown and offered at, and its sized
  // renders are drawn at (scripts/auto-render.js).
  var DEFAULT_SIZE_MM = 60;
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

  // A size as the site shows it: a plain number, no unit, to a tenth ("62",
  // "62.5").
  function sizeText(mm) {
    return String(Math.round(mm * 10) / 10);
  }

  // A ring changes size by moving every point of its model this many mm away
  // from the finger axis (scripts/ring-size.js): the difference of the inner
  // radii.
  function sizeShift(mm) {
    return (mm - REFERENCE_SIZE_MM) / (2 * Math.PI);
  }

  // A measured "geometry" (or its "print") volume at a size, cm3: linear in
  // the size under the radial shift. Mirrored in scripts/helpers.js.
  function volumeAt(geometry, mm) {
    return geometry["volume-cm3"] + (geometry["volume-cm3-per-size-mm"] || 0) * (mm - REFERENCE_SIZE_MM);
  }

  // A geometry's axis-aligned box at a size, { center, size }: interpolated
  // between the sizes it was measured at, held at the ends. null without one.
  function axisBoxAt(geometry, mm) {
    var box = geometry && geometry["axis-box"];
    var sizes = box && box["sizes-mm"];
    if (!Array.isArray(sizes) || !sizes.length) return null;
    var i = 0;
    while (i < sizes.length - 2 && mm > sizes[i + 1]) i++;
    var j = Math.min(i + 1, sizes.length - 1);
    var t = j === i ? 0 : clamp01((mm - sizes[i]) / (sizes[j] - sizes[i]));
    var at = function (key) {
      return [0, 1, 2].map(function (k) { return lerp(Number(box[key][i][k]), Number(box[key][j][k]), t); });
    };
    return { center: at("center"), size: at("size") };
  }

  /* ---- plan views ---- */

  // The product page's outline views of a model, in the ring's own frame, where
  // z runs along the finger and y is up: scripts/auto-render.js draws them,
  // js/product.js marks their measurements, js/three-viewer.js turns the live
  // model to them. `eye` is the camera's side, `up` the drawing's up. As on a
  // technical drawing: front looks through the finger hole (+z), side is from
  // the right. `measures` lists the axes (0, 1, 2: x, y, z) a view carries a
  // measurement of: x and y on the front, z on the side. A model whose finger
  // runs along its own x says so ("finger-axis": "x"): planFrame turns the
  // ring's frame to the model's.
  var PLAN_VIEWS = {
    front: { eye: [0, 0, 1], up: [0, 1, 0], measures: [0, 1] },
    side: { eye: [1, 0, 0], up: [0, 1, 0], measures: [2] }
  };
  // The stroke's room around a drawing, as a share of the longest extent.
  var PLAN_PAD = 0.006;

  // The ring's x, y and z as vectors in the model's own frame: the model's
  // own unless its finger runs along the model's x.
  function ringAxes(product) {
    return product && product["finger-axis"] === "x"
      ? [[0, 0, -1], [0, 1, 0], [1, 0, 0]]
      : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }

  // A product's plan views at a size (mm, default the reference) from
  // geometry["axis-box"], null without it. Both are drawn at one scale,
  // centred on the box and cropped to one rectangle, `crop` mm: the largest
  // drawing's width and height plus the stroke's room. A view's drawing is
  // w x h mm (along `right`, and `up`); `measures` lists what it measures,
  // each { axis, horizontal }: the axis (0, 1, 2: the ring's x, y, z) and
  // whether it runs along `right` (else along `up`). `eye`, `up` and `right`
  // are in the model's frame. `size` is the box's extent along the ring's x,
  // y and z, mm. `render` is the square, mm across, the renderer draws
  // before cropping.
  function planFrame(product, mm) {
    var box = axisBoxAt(product && product.geometry, mm === undefined ? REFERENCE_SIZE_MM : mm);
    var boxSize = box && box.size;
    if (!boxSize || !boxSize.every(function (d) { return d > 0; })) return null;
    var along = function (axis) {
      return Math.abs(axis[0]) * boxSize[0] + Math.abs(axis[1]) * boxSize[1] + Math.abs(axis[2]) * boxSize[2];
    };
    var ring = ringAxes(product);
    var size = ring.map(along);
    var inModel = function (v) {
      return [0, 1, 2].map(function (k) { return v[0] * ring[0][k] + v[1] * ring[1][k] + v[2] * ring[2][k]; });
    };
    var rightOf = function (u, e) {
      return [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
    };
    var views = {};
    Object.keys(PLAN_VIEWS).forEach(function (name) {
      var ringRight = rightOf(PLAN_VIEWS[name].up, PLAN_VIEWS[name].eye);
      var e = inModel(PLAN_VIEWS[name].eye);
      var u = inModel(PLAN_VIEWS[name].up);
      var right = inModel(ringRight);
      views[name] = {
        eye: e, up: u, right: right,
        measures: PLAN_VIEWS[name].measures.map(function (axis) {
          return { axis: axis, horizontal: ringRight[axis] !== 0 };
        }),
        w: along(right), h: along(u)
      };
    });
    var longest = Math.max(boxSize[0], boxSize[1], boxSize[2]);
    var crop = { w: 0, h: 0 };
    Object.keys(views).forEach(function (name) {
      crop.w = Math.max(crop.w, views[name].w);
      crop.h = Math.max(crop.h, views[name].h);
    });
    crop.w += 2 * PLAN_PAD * longest;
    crop.h += 2 * PLAN_PAD * longest;
    return {
      center: box.center,
      size: size,
      crop: crop,
      render: Math.max(crop.w, crop.h) * 1.1,
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

  // img to show src, crossfading (--fade-standard) once src has decoded: a
  // copy of the old picture, the picture alone, laid over it fades out. A
  // model's pictures keep its silhouette in every metal, so only the metal
  // blends. At once when nothing shows yet (unloaded, hidden) or under
  // reduced motion.
  var CROSSFADE_MS = 300;
  var crossfadeTargets = new WeakMap();
  function crossfadeSrc(img, src) {
    crossfadeTargets.set(img, src);
    if (!src || img.getAttribute("src") === src) return;
    function shown() {
      return img.isConnected && img.complete && img.naturalWidth > 0 && img.getClientRects().length > 0 &&
        window.getComputedStyle(img).visibility !== "hidden";
    }
    if (reducedMotion.matches || !shown()) {
      img.src = src;
      return;
    }
    var next = new Image();
    next.src = src;
    (next.decode ? next.decode() : Promise.resolve()).catch(function () {}).then(function () {
      if (crossfadeTargets.get(img) !== src) return;
      if (!shown() || !img.offsetParent) {
        img.src = src;
        return;
      }
      var ghost = img.cloneNode(false);
      ghost.removeAttribute("id");
      ghost.alt = "";
      ghost.setAttribute("aria-hidden", "true");
      var style = ghost.style;
      style.position = "absolute";
      style.left = img.offsetLeft + "px";
      style.top = img.offsetTop + "px";
      style.width = img.offsetWidth + "px";
      style.height = img.offsetHeight + "px";
      style.margin = "0";
      style.background = "none";
      style.boxShadow = "none";
      style.webkitBackdropFilter = "none";
      style.backdropFilter = "none";
      style.pointerEvents = "none";
      var from = window.getComputedStyle(img).opacity;
      img.parentNode.insertBefore(ghost, img.nextSibling);
      img.src = src;
      function drop() {
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      }
      if (typeof ghost.animate !== "function") {
        drop();
        return;
      }
      ghost.animate([{ opacity: from }, { opacity: 0 }], { duration: CROSSFADE_MS, easing: "ease", fill: "forwards" })
        .finished.then(drop, drop);
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
    edgeFades: edgeFades,
    remPx: remPx,
    devicePx: devicePx,
    clamp: clamp,
    clamp01: clamp01,
    lerp: lerp,
    smoothstep: smoothstep,
    smootherstep: smootherstep,
    invSmootherstep: invSmootherstep,
    easeOutCubic: easeOutCubic,
    easeInOutCubic: easeInOutCubic,
    cubicBezierEase: cubicBezierEase,
    wait: wait,
    whenIdle: whenIdle,
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
    DEFAULT_SIZE_MM: DEFAULT_SIZE_MM,
    sizeRange: sizeRange,
    sizeText: sizeText,
    sizeShift: sizeShift,
    volumeAt: volumeAt,
    PLAN_VIEWS: PLAN_VIEWS,
    ringAxes: ringAxes,
    planFrame: planFrame,
    thumbSrc: thumbSrc,
    setThumb: setThumb,
    preload: preload,
    crossfadeSrc: crossfadeSrc,
    resampleBand: resampleBand
  };
})();
