/* ==========================================================================
   em·ji·ve — loader

   The logo loader as a shared component (.loader in css/style.css). Each of
   the mark's three parts crosses its CONTAINER from the right border to the
   left border, fading in on the way in and out on the way out, with a slow
   stretch as it passes the middle. Exposes window.EmjiveLoader:

     mount(host, { page })  -> hold   put a loader inside `host` (one per
                                      host; more mounts on the same host add
                                      holds to it). hold.done() releases it.
     cover(host, ready)     -> Promise  hide host's <img> children, show a
                                      loader, and reveal them (a quick fade)
                                      once `ready` settles and the loader has
                                      left. Resolves when revealed.
     imageReady(img)        -> Promise  loaded (or failed) and decoded.
     pageReady()                      the page's arrival loader may go.

   THE GUARDRAILS, which every path below goes through:
   - The loader never disappears while a part is visible. hold.done() resolves
     only inside the cycle's SAFE WINDOW: after the last (staggered) part has
     fully left and before the first one re-enters. Called mid-crossing, it
     waits for the crossing to finish; called in the blank gap, it is
     immediate.
   - A loader only SHOWS if its asset is still loading after --loader-delay
     (a :root token), counted from the moment its container first comes on
     screen — a lazy image far down a page, or a slide that hasn't been
     scrolled to, costs nothing until someone can see it. A hold released
     before that never creates anything visible, so a cached asset costs
     nothing either.
   - Every hold has a watchdog (WATCHDOG_MS) so a load that never reports
     can't keep a loader up forever.
   - Under prefers-reduced-motion nothing is mounted at all: every hold is
     an already-released no-op and nothing is hidden.

   Timing is read from the CSS custom properties on .loader, so everything is
   tuned in the stylesheet: --loader-cycle in seconds, and every phase
   (--loader-in, --loader-slow, --loader-out, --loader-gap, --loader-stagger)
   as a percentage of it. The gap is the blank time before the loop restarts;
   it is held exactly, and the other three phases are scaled together to
   fill whatever it leaves.

   Why JS and not @keyframes: keyframe percentages cannot be computed from
   custom properties, and the easing curves below are solved from the phase
   lengths. The offsets are derived here instead, as Web Animations.

   One keyframe set drives both transform and opacity, so the movement and
   the fade cannot drift out of sync — they share every offset and every
   easing curve:

     offset 0              container's right border, opacity 0   eased in
     offset in             just right of centre, 1                 (already
     offset in+slow        just left of centre, 1                  moving, slows
     offset in+slow+out    container's left border, opacity 0      to drift speed)
     offset 1              same: the rest of the cycle, blank    linear drift
                                                                  eased out

   Each eased leg is a quadratic curve — constant deceleration into the slow
   stretch, constant acceleration out of it — whose end next to the slow
   stretch has exactly the drift's own speed, so there is no jolt where a
   leg meets it. CSS only takes cubic Béziers, so each quadratic is written
   as the cubic that traces the same curve (degree elevation: handles a
   third and two thirds of the way along).

   The drift's speed is set as a share of the crossing's average speed
   (--loader-slow-speed), which makes the stretch's length follow from it
   (speed x --loader-slow) as a fraction of the travel distance. All of that
   is ratios, so the curves do not depend on the container's size; only the
   pixel distances do (half the container + half the mark), which is why the
   keyframes are rebuilt whenever the loader is resized — a ResizeObserver,
   not a window listener, because hosts can be zero-sized when the loader is
   mounted (the product page builds while its content is [hidden]; the
   Modify sheet before it has slid in).

   The parts are plain boxes (css/style.css shapes each with a mask and
   inverts whatever is underneath it), not SVG children: iOS Safari handles
   CSS/Web Animations on SVG child elements unreliably, and the invert needs
   a backdrop-filter, which only exists on boxes.

   mount(host, { bleed: true }) is for a container whose own edges are not
   visible — a 3D viewer's box in a carousel slide, which is deliberately
   smaller than its slide. The parts are not clipped at that box; they travel
   all the way to the edges of the nearest clipping ancestor (the carousel's
   viewport), which are the edges a visitor can actually see.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  var DEFAULT_DELAY_MS = 150;
  var WATCHDOG_MS = 15000;
  var SAFE_POLL_MS = 25;
  // Margin past the last part's own exit, so a removal never lands on its
  // final sub-pixel of opacity.
  var SAFE_MARGIN = 0.004;

  // The logo's dot, dot and V, in left-to-right order, which is also the
  // cascade order. Their shapes are masks in css/style.css.
  var PART_COUNT = 3;

  var NOOP_HOLD = { done: function () { return Promise.resolve(); } };

  function noop() {}

  function seconds(styles, name) {
    var raw = styles.getPropertyValue(name).trim();
    var n = parseFloat(raw);
    return raw.slice(-2) === "ms" ? n / 1000 : n;
  }

  /* "25%" -> 0.25 */
  function share(styles, name) {
    return parseFloat(styles.getPropertyValue(name)) / 100;
  }

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  /* ---- timing, solved from the tokens ----------------------------------- */

  function compute(el, partCount) {
    var styles = getComputedStyle(el);
    var cycle = seconds(styles, "--loader-cycle");
    var fIn = share(styles, "--loader-in");
    var fSlow = Math.max(share(styles, "--loader-slow"), 0.001);
    var fOut = share(styles, "--loader-out");
    var fGap = clamp01(share(styles, "--loader-gap"));
    var staggerShare = share(styles, "--loader-stagger");
    var slowSpeed = share(styles, "--loader-slow-speed");

    /* The gap is authoritative: in / slow / out are scaled together so
       they fill exactly what it leaves (a no-op when the four already add
       up to 100%). A gap of 100% would leave them nothing, so it's capped. */
    var scale = (1 - Math.min(fGap, 0.95)) / (fIn + fSlow + fOut);
    fIn *= scale;
    fSlow *= scale;
    fOut *= scale;
    var offIn = fIn;
    var offSlow = fIn + fSlow;
    var offOut = fIn + fSlow + fOut;

    /* The crossing covers 2 travels (border to border) in offOut of the
       cycle, so its average speed is 2 / offOut. The slow stretch moves at
       slowSpeed times that for fSlow of the cycle, covering 2 * drift
       travels in all (drift on each side of the middle). Capped so the legs
       keep some distance to cover: a stretch as long as the whole crossing
       would leave them nothing. */
    var drift = Math.min((slowSpeed * fSlow) / offOut, 0.9);

    /* Drift speed in travel-lengths per unit of cycle: 2 * drift across
       fSlow. A leg covers (1 - drift) of the travel in its own share, so
       its speed at the end next to the drift, as a multiple of the leg's
       average speed, is  k = driftSpeed / (legDistance / legShare). */
    var driftSpeed = (2 * drift) / fSlow;
    var kIn = (driftSpeed * fIn) / (1 - drift);
    var kOut = (driftSpeed * fOut) / (1 - drift);

    /* A quadratic leg covering 1 in unit time, starting at slope s0 and
       ending at slope s1, needs (s0 + s1) / 2 = 1. In: s1 = k (the drift's
       speed), so it starts at s0 = 2 - k. No rest at the border — the part
       is invisible there, and a standing start would only spend the leg's
       time crawling out of sight. As a cubic: handles (1/3, s0/3),
       (2/3, 1 - s1/3). Out is the mirror image: starts at k, ends at 2 - k.
       Clamped at 0 so the curve never runs backwards, which only happens
       when the slow stretch is faster than twice the leg's average speed. */
    function quadratic(startSlope, endSlope) {
      return "cubic-bezier(0.3333, " + clamp01(startSlope / 3).toFixed(4) +
        ", 0.6667, " + clamp01(1 - endSlope / 3).toFixed(4) + ")";
    }

    return {
      cycleMs: cycle * 1000,
      staggerMs: staggerShare * cycle * 1000,
      offIn: offIn,
      offSlow: offSlow,
      offOut: offOut,
      drift: drift,
      easeIn: quadratic(2 - kIn, kIn),
      easeOut: quadratic(kOut, 2 - kOut),
      // The last part leaves (partCount - 1) staggers after the first.
      safeStart: offOut + (partCount - 1) * staggerShare + SAFE_MARGIN
    };
  }

  function frame(offset, opacity, x, easing) {
    var f = {
      offset: offset,
      opacity: opacity,
      transform: "translateX(" + x.toFixed(2) + "px)"
    };
    if (easing) f.easing = easing;
    return f;
  }

  /* ---- one loader per host ----------------------------------------------- */

  var states = typeof WeakMap === "function" ? new WeakMap() : null;

  function showDelayMs() {
    var raw = getComputedStyle(root).getPropertyValue("--loader-delay").trim();
    var n = parseFloat(raw);
    if (isNaN(n)) return DEFAULT_DELAY_MS;
    return raw.slice(-2) === "ms" ? n : n * 1000;
  }

  function createState(host, page, bleed) {
    var el = document.createElement("div");
    el.className = "loader is-waiting" + (page ? " loader--page" : "") + (bleed ? " loader--bleed" : "");
    if (page) {
      el.setAttribute("role", "status");
      el.setAttribute("aria-label", "Loading");
    } else {
      el.setAttribute("aria-hidden", "true");
    }
    var markHtml = "";
    for (var i = 0; i < PART_COUNT; i++) markHtml += '<div class="loader__part"></div>';
    el.innerHTML = '<div class="loader__mark">' + markHtml + "</div>";

    // The loader is absolutely positioned in its host, so the host has to be
    // a containing block. Every host in the site already is; this covers a
    // static one without disturbing it (and is undone on removal). A host
    // that isn't attached yet reports "" and is left alone.
    var forcedPosition = false;
    if (!page && getComputedStyle(host).position === "static") {
      host.style.position = "relative";
      forcedPosition = true;
    }
    host.appendChild(el);

    var s = {
      host: host,
      el: el,
      mark: el.firstChild,
      parts: Array.prototype.slice.call(el.querySelectorAll(".loader__part")),
      holds: 0,
      shown: false,
      cfg: null,
      anims: [],
      timer: 0,
      observer: null,
      rebuildPending: 0,
      forcedPosition: forcedPosition,
      bleed: !!bleed,
      clipAncestor: null,
      visibility: null
    };
    states.set(host, s);
    function startTimer() {
      s.timer = setTimeout(function () { show(s); }, showDelayMs());
    }
    // The show-delay starts once the host is actually on screen (the page
    // loader's host, <body>, always is). IntersectionObserver respects
    // overflow clipping, so a slide scrolled out of its carousel counts as
    // off screen too.
    if (page || typeof IntersectionObserver !== "function") {
      startTimer();
    } else {
      s.visibility = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            s.visibility.disconnect();
            s.visibility = null;
            startTimer();
            return;
          }
        }
      });
      s.visibility.observe(host);
    }
    return s;
  }

  /* The nearest ancestor that clips its overflow — what a bleeding loader's
     parts actually disappear behind. */
  function findClipAncestor(el) {
    for (var n = el.parentElement; n && n !== root; n = n.parentElement) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(n).overflowX)) return n;
    }
    return null;
  }

  /* Distance from rest to fully out of sight. Normally the container's
     borders: half its width plus half the mark (all three parts share the
     mark's box). For a bleeding loader, the clipping ancestor's borders
     instead, measured from where the loader sits right now (a symmetric
     travel, so the wider of the two sides decides). */
  function travelDistance(s) {
    var markWidth = s.mark.getBoundingClientRect().width;
    if (!s.bleed) return s.el.clientWidth / 2 + markWidth / 2;
    var box = s.el.getBoundingClientRect();
    var centre = box.left + box.width / 2;
    var anc = s.clipAncestor ? s.clipAncestor.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    return Math.max(anc.right - centre, centre - anc.left) + markWidth / 2;
  }

  function build(s) {
    var saved = s.anims.map(function (a) { return a.currentTime; });
    s.anims.forEach(function (a) { a.cancel(); });

    var travel = travelDistance(s);
    var near = travel * s.cfg.drift;

    var keyframes = [
      frame(0, 0, travel, s.cfg.easeIn),
      frame(s.cfg.offIn, 1, near, "linear"),
      frame(s.cfg.offSlow, 1, -near, s.cfg.easeOut),
      frame(s.cfg.offOut, 0, -travel),
      frame(1, 0, -travel)
    ];

    s.anims = s.parts.map(function (part, i) {
      var a = part.animate(keyframes, {
        duration: s.cfg.cycleMs,
        delay: i * s.cfg.staggerMs,
        iterations: Infinity,
        fill: "backwards"
      });
      if (saved[i] != null) a.currentTime = saved[i];
      return a;
    });
  }

  function show(s) {
    s.timer = 0;
    if (states.get(s.host) !== s) return;
    s.cfg = compute(s.el, s.parts.length);
    if (s.bleed) s.clipAncestor = findClipAncestor(s.el);
    s.shown = true;
    build(s);
    s.el.classList.remove("is-waiting");
    if (typeof ResizeObserver === "function") {
      s.observer = new ResizeObserver(function () {
        cancelAnimationFrame(s.rebuildPending);
        s.rebuildPending = requestAnimationFrame(function () {
          if (states.get(s.host) === s) build(s);
        });
      });
      s.observer.observe(s.el);
      // A bleeding loader's travel also depends on the clipping ancestor's
      // size, which can change without the loader's own box moving.
      if (s.clipAncestor) s.observer.observe(s.clipAncestor);
    }
  }

  function destroy(s) {
    if (states.get(s.host) !== s) return;
    states.delete(s.host);
    clearTimeout(s.timer);
    cancelAnimationFrame(s.rebuildPending);
    if (s.visibility) s.visibility.disconnect();
    if (s.observer) s.observer.disconnect();
    s.anims.forEach(function (a) { a.cancel(); });
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    if (s.forcedPosition) s.host.style.position = "";
  }

  /* Where the cycle is, read off the first part (no delay, so its
     currentTime IS the cycle's clock). */
  function inSafeWindow(s) {
    var a = s.anims[0];
    if (!a || a.currentTime == null) return true;
    return (a.currentTime % s.cfg.cycleMs) / s.cfg.cycleMs >= s.cfg.safeStart;
  }

  function whenSafe(s) {
    return new Promise(function (resolve) {
      (function check() {
        if (states.get(s.host) !== s || inSafeWindow(s)) resolve();
        else setTimeout(check, SAFE_POLL_MS);
      })();
    });
  }

  function release(s) {
    s.holds--;
    // Never shown (still inside the show-delay): nothing to wait out.
    if (!s.shown) {
      if (s.holds <= 0) destroy(s);
      return Promise.resolve();
    }
    return whenSafe(s).then(function () {
      // Re-checked here, not above: a hold taken while this one was waiting
      // for the safe window keeps the loader alive.
      if (s.holds <= 0) destroy(s);
    });
  }

  function mount(host, opts) {
    if (!host || !states || reduceQuery.matches) return NOOP_HOLD;
    var s = states.get(host) || createState(host, !!(opts && opts.page), !!(opts && opts.bleed));
    s.holds++;
    var promise = null;
    // opts.watchdog === false is for loader-test.html, whose loaders are
    // meant to loop for as long as you care to watch.
    var watchdog = opts && opts.watchdog === false
      ? 0
      : setTimeout(function () { hold.done(); }, WATCHDOG_MS);
    var hold = {
      done: function () {
        if (!promise) {
          clearTimeout(watchdog);
          promise = release(s);
        }
        return promise;
      }
    };
    return hold;
  }

  /* ---- helpers for callers ------------------------------------------------ */

  function imageReady(img) {
    return new Promise(function (resolve) {
      function settle() {
        // Decoded before the reveal, so the fade-in never starts on a
        // frame that is still decoding. Raced: a decode that never settles
        // must not hold the loader up.
        if (img.decode) {
          var timer = setTimeout(resolve, 1000);
          img.decode().then(function () { clearTimeout(timer); resolve(); },
            function () { clearTimeout(timer); resolve(); });
        } else {
          resolve();
        }
      }
      // complete is true for a loaded image AND a broken one; a lazy image
      // that hasn't started fetching is not complete.
      if (img.complete) settle();
      else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", resolve, { once: true });
      }
    });
  }

  function cover(host, ready) {
    if (!host || reduceQuery.matches) return Promise.resolve();
    host.classList.add("loader-host", "is-loader-pending");
    var hold = mount(host);
    return Promise.resolve(ready)
      .then(noop, noop)
      .then(function () { return hold.done(); })
      .then(function () { host.classList.remove("is-loader-pending"); });
  }

  /* ---- the page's arrival loader ------------------------------------------
     Pages that wait on something (index, product, series) opt in with
     data-page-loader on <html>. This script runs in <head>, before <body>
     exists, so the cover is a pseudo-element on <html> (an opaque --bg layer
     one step under the loader, set right now so half-built content never
     flashes) and the loader itself is mounted on <body> as soon as it can be.
     Skipped when the homepage is restoring a back-navigation scroll
     (js/scroll-memory.js owns that, and hides the grid itself) and, because
     scripts don't rerun, on a bfcache restore. */

  var pageHold = null;
  var pageActive = false;
  var pageIsReady = false;

  function revealPage() {
    root.classList.add("emjive-page-revealing");
    var finished = false;
    function cleanup() {
      if (finished) return;
      finished = true;
      root.removeEventListener("transitionend", onEnd);
      root.classList.remove("emjive-page-loading", "emjive-page-revealing");
    }
    // transitionend bubbles up from every descendant too; only the cover's
    // own (a pseudo-element, reported on <html>) ends the reveal.
    function onEnd(e) {
      if (e.target === root && e.pseudoElement === "::before") cleanup();
    }
    root.addEventListener("transitionend", onEnd);
    // Backstop for a transitionend that never comes (hidden tab, or the
    // reduced-motion 0.01ms transition collapsing to nothing).
    setTimeout(cleanup, 600);
  }

  function pageReady() {
    if (!pageActive || pageIsReady) return;
    pageIsReady = true;
    if (!pageHold) return; // body not parsed yet; the mount below sees the flag
    pageHold.done().then(revealPage);
  }

  function startPage() {
    pageHold = mount(document.body, { page: true });
    if (pageIsReady) pageHold.done().then(revealPage);
  }

  if (root.hasAttribute("data-page-loader") &&
      !reduceQuery.matches &&
      !root.classList.contains("emjive-restoring-scroll")) {
    pageActive = true;
    root.classList.add("emjive-page-loading");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startPage);
    } else {
      startPage();
    }
    // A page script that fails before calling pageReady() must not leave the
    // cover up for good.
    setTimeout(pageReady, WATCHDOG_MS);
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) {
        pageIsReady = true;
        root.classList.remove("emjive-page-loading", "emjive-page-revealing");
      }
    });
  }

  window.EmjiveLoader = {
    mount: mount,
    cover: cover,
    imageReady: imageReady,
    pageReady: pageReady
  };
})();
