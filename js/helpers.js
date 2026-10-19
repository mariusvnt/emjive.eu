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
  // "wheel-poster", "top-shot") in one metal; "" without one.
  function assetFor(product, kind, metal) {
    var assets = product && product.assets;
    return (assets && assets[kind] && assets[kind][metal]) || "";
  }

  // A viewer's stand-in: its first frame (fallback-img), else the icon.
  function posterFor(product, metal) {
    return assetFor(product, "fallback-img", metal) || assetFor(product, "icons", metal);
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
    posterFor: posterFor
  };
})();
