// The logo loader (.loader in css/style.css): the mark's three parts cross
// their container right to left, fading in and out, slowing past the middle.
// window.EmjiveLoader:
//   mount(host, { page, bleed, target, watchdog }) -> hold   hold.done() releases it;
//                        more mounts on a host add holds. `target`: a shared loader
//                        (see below). `bleed`: parts travel to the nearest clipping
//                        ancestor instead of the host's edges.
//   cover(host, ready)              hide host's <img>s behind a loader until `ready`
//                                   settles and the loader has left
//   isPhone, onPhoneChange, versions, variant, setSrc, upgradeImage   responsive images
//   pageReady(), holdPage(), isPageReady()   the page's arrival loader
//
// Guardrails:
//   - It never disappears with a part visible: done() resolves only in the
//     cycle's safe window, after the last part left and before the first re-enters.
//   - It only shows if still loading --loader-delay after its host comes on screen.
//   - A watchdog (WATCHDOG_MS) ends every hold.
//   - Nothing mounts under prefers-reduced-motion.
//
// Timing comes from .loader's custom properties (--loader-cycle, and the
// in/slow/out/gap/stagger phases as shares of it), hence Web Animations rather
// than @keyframes, whose offsets can't be computed. One keyframe set drives
// transform and opacity together:
//   0              right border, opacity 0    eased in
//   in             just right of centre, 1    linear drift
//   in+slow        just left of centre, 1     eased out
//   in+slow+out    left border, opacity 0
//   1              same (blank until the next cycle)
// Each eased leg is a quadratic (as a degree-elevated cubic-bezier) meeting the
// drift at the drift's speed, so there is no jolt. Only the pixel distances
// depend on size, so keyframes rebuild on resize (ResizeObserver: hosts can be
// zero-sized at mount). Parts are plain boxes, not SVG children: iOS animates
// SVG children unreliably, and their invert needs a backdrop-filter.
(function () {
  "use strict";

  var root = document.documentElement;
  var H = window.EmjiveHelpers;
  var clamp01 = H.clamp01;
  var reduceQuery = H.reducedMotion;

  var DEFAULT_DELAY_MS = 150;
  var WATCHDOG_MS = 15000;
  var SAFE_POLL_MS = 25;
  // Share of a target that must be visible for its wait to count (not a sliver at a clipping edge).
  var VISIBLE_RATIO = 0.2;
  // Past the last part's exit, so removal never lands on its last sub-pixel of opacity.
  var SAFE_MARGIN = 0.004;

  // Dot, dot and V, left to right (masks in css/style.css).
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

  /* ---- timing, solved from the tokens ---- */

  function compute(el, partCount) {
    var styles = getComputedStyle(el);
    var cycle = seconds(styles, "--loader-cycle");
    var fIn = share(styles, "--loader-in");
    var fSlow = Math.max(share(styles, "--loader-slow"), 0.001);
    var fOut = share(styles, "--loader-out");
    var fGap = clamp01(share(styles, "--loader-gap"));
    var staggerShare = share(styles, "--loader-stagger");
    var slowSpeed = share(styles, "--loader-slow-speed");

    /* The gap is held exactly; in/slow/out scale to fill the rest (gap capped at 95%). */
    var scale = (1 - Math.min(fGap, 0.95)) / (fIn + fSlow + fOut);
    fIn *= scale;
    fSlow *= scale;
    fOut *= scale;
    var offIn = fIn;
    var offSlow = fIn + fSlow;
    var offOut = fIn + fSlow + fOut;

    /* Border to border is 2 travels in offOut, so average speed 2 / offOut; the
       drift runs at slowSpeed times that for fSlow, covering 2 * drift travels.
       Capped so the legs keep distance to cover. */
    var drift = Math.min((slowSpeed * fSlow) / offOut, 0.9);

    /* Drift speed in travels per cycle; k is the leg's end speed over its average. */
    var driftSpeed = (2 * drift) / fSlow;
    var kIn = (driftSpeed * fIn) / (1 - drift);
    var kOut = (driftSpeed * fOut) / (1 - drift);

    /* A unit quadratic leg from slope s0 to s1 needs (s0 + s1) / 2 = 1. In ends
       at the drift's speed k, so starts at 2 - k (no rest at the border, where
       the part is invisible); out mirrors it. As a cubic: handles (1/3, s0/3),
       (2/3, 1 - s1/3), clamped so it never runs backwards. */
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

  /* ---- one loader per host ---- */

  var states = typeof WeakMap === "function" ? new WeakMap() : null;

  function showDelayMs() {
    var raw = getComputedStyle(root).getPropertyValue("--loader-delay").trim();
    var n = parseFloat(raw);
    if (isNaN(n)) return DEFAULT_DELAY_MS;
    return raw.slice(-2) === "ms" ? n : n * 1000;
  }

  function createState(host, page, bleed, targeted) {
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

    // The host must be a containing block: a static one is made relative (undone
    // on removal). Unattached hosts report "" and are left alone.
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
      rate: 1,
      rampRaf: 0,
      forcedPosition: forcedPosition,
      bleed: !!bleed,
      clipAncestor: null,
      visibility: null,
      // Shared loader (opts.target): its holds, and whether it is finishing a crossing to go quiet.
      targeted: !!targeted,
      holdList: [],
      parking: false
    };
    states.set(host, s);
    function startTimer() {
      s.timer = setTimeout(function () { show(s); }, showDelayMs());
    }
    // A shared loader's visibility follows its holds' targets (reevaluate).
    if (s.targeted) return s;
    // The show-delay starts once the host is on screen (IntersectionObserver
    // respects overflow clipping, so an off-screen slide counts as hidden).
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

  /* The nearest ancestor clipping its overflow: where a bleeding loader's parts vanish. */
  function findClipAncestor(el) {
    for (var n = el.parentElement; n && n !== root; n = n.parentElement) {
      if (/hidden|clip|auto|scroll/.test(getComputedStyle(n).overflowX)) return n;
    }
    return null;
  }

  /* Rest to out of sight: half the container plus half the mark, or for a
     bleeding loader the farther side of the clipping ancestor. */
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
      // Keep a released loader's faster pace across rebuilds.
      if (s.rate !== 1) a.playbackRate = s.rate;
      return a;
    });
  }

  function show(s) {
    s.timer = 0;
    if (states.get(s.host) !== s) return;
    if (s.targeted && !isActive(s)) return;
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
      // A bleeding loader's travel also depends on the clipping ancestor's size.
      if (s.clipAncestor) s.observer.observe(s.clipAncestor);
    }
  }

  function destroy(s) {
    if (states.get(s.host) !== s) return;
    states.delete(s.host);
    clearTimeout(s.timer);
    cancelAnimationFrame(s.rebuildPending);
    cancelAnimationFrame(s.rampRaf);
    if (s.visibility) s.visibility.disconnect();
    if (s.observer) s.observer.disconnect();
    s.holdList.forEach(function (h) { if (h.io) { h.io.disconnect(); h.io = null; } });
    s.anims.forEach(function (a) { a.cancel(); });
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    if (s.forcedPosition) s.host.style.position = "";
  }

  /* The first part has no delay, so its currentTime is the cycle's clock. */
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

  function release(s, hold) {
    s.holds--;
    if (hold) {
      hold.released = true;
      if (hold.io) { hold.io.disconnect(); hold.io = null; }
    }
    // Never shown: nothing to wait out.
    if (!s.shown) {
      if (s.holds <= 0) destroy(s);
      // Other holds remain: this may have been the only visible wait.
      else if (s.targeted) reevaluate(s);
      return Promise.resolve();
    }
    // Holds remain: carry on or go quiet depending on what's on screen.
    if (s.holds > 0 && s.targeted) {
      reevaluate(s);
      return Promise.resolve();
    }
    // Only the crossing left: speed it up, still leaving only in the safe window,
    // so ready content doesn't sit behind it for most of a cycle.
    if (s.holds <= 0) finishCrossing(s);
    return whenSafe(s).then(function () {
      // Re-checked: a hold taken meanwhile keeps the loader.
      if (s.holds <= 0) destroy(s);
    });
  }

  /* ---- a loader shared by several assets ----
     One loader on a frame (the product page's design frame), each load taking
     a hold naming what it waits for (opts.target). A hold counts only while
     its target is on screen, and the loader is active while any unreleased
     hold is visible:
       - the show-delay runs from becoming active, and is dropped if it stops;
       - when no visible wait remains, it finishes its crossing and goes quiet,
         remaining holds still counted;
       - a pending asset scrolling into view starts it again after the delay;
       - the last release removes it. */

  function isActive(s) {
    for (var i = 0; i < s.holdList.length; i++) {
      var h = s.holdList[i];
      if (!h.released && h.visible) return true;
    }
    return false;
  }

  function reevaluate(s) {
    if (states.get(s.host) !== s) return;
    if (isActive(s)) {
      if (s.shown) {
        // A visible wait again while finishing: back to the loading pace.
        if (s.rate !== 1) {
          cancelAnimationFrame(s.rampRaf);
          s.rampRaf = 0;
          setRate(s, 1);
        }
      } else if (!s.timer) {
        s.timer = setTimeout(function () { show(s); }, showDelayMs());
      }
      return;
    }
    if (!s.shown) {
      clearTimeout(s.timer);
      s.timer = 0;
    } else {
      park(s);
    }
  }

  // Finish the crossing, then hide (not destroy: holds remain) unless something visible waits again.
  function park(s) {
    if (s.parking) return;
    s.parking = true;
    finishCrossing(s);
    whenSafe(s).then(function () {
      s.parking = false;
      if (states.get(s.host) !== s || !s.shown || s.holds <= 0 || isActive(s)) return;
      hide(s);
    });
  }

  function hide(s) {
    s.shown = false;
    s.rate = 1;
    cancelAnimationFrame(s.rampRaf);
    cancelAnimationFrame(s.rebuildPending);
    s.rampRaf = 0;
    if (s.observer) { s.observer.disconnect(); s.observer = null; }
    s.anims.forEach(function (a) { a.cancel(); });
    s.anims = [];
    s.el.classList.add("is-waiting");
  }

  function watchTarget(s, hold) {
    if (typeof IntersectionObserver !== "function") {
      hold.visible = true;
      reevaluate(s);
      return;
    }
    hold.io = new IntersectionObserver(function (entries) {
      var e = entries[entries.length - 1];
      var visible = e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO;
      if (visible === hold.visible) return;
      hold.visible = visible;
      reevaluate(s);
    }, { threshold: [0, VISIBLE_RATIO] });
    hold.io.observe(hold.target);
  }

  // Released crossings speed up to FINISH_RATE, eased in (smoothstep) to avoid a
  // visible jolt; playbackRate keeps currentTime, so parts carry on from where they are.
  var FINISH_RATE = 2.5;
  var FINISH_RAMP_MS = 700;

  function setRate(s, rate) {
    s.rate = rate;
    s.anims.forEach(function (a) {
      try { a.playbackRate = rate; } catch (err) { /* keep the pace */ }
    });
  }

  function finishCrossing(s) {
    if (s.rampRaf || inSafeWindow(s)) return;
    var from = s.rate;
    var start = performance.now();
    (function step(now) {
      var p = Math.min(1, (now - start) / FINISH_RAMP_MS);
      setRate(s, from + (FINISH_RATE - from) * H.smoothstep(0, 1, p));
      // Until full speed, or until destroy() cancels it.
      s.rampRaf = p < 1 ? requestAnimationFrame(step) : 0;
    })(start);
  }

  function mount(host, opts) {
    if (!host || !states || reduceQuery.matches) return NOOP_HOLD;
    var target = (opts && opts.target) || null;
    var s = states.get(host) || createState(host, !!(opts && opts.page), !!(opts && opts.bleed), !!target);
    s.holds++;
    var promise = null;
    // false for loader-test.html, whose loaders loop indefinitely.
    var watchdog = opts && opts.watchdog === false
      ? 0
      : setTimeout(function () { hold.done(); }, WATCHDOG_MS);
    var hold = {
      target: s.targeted ? target : null,
      // A shared loader's hold without a target always counts as in view.
      visible: !(s.targeted && target),
      released: false,
      io: null,
      done: function () {
        if (!promise) {
          clearTimeout(watchdog);
          promise = release(s, hold);
        }
        return promise;
      }
    };
    if (s.targeted) {
      s.holdList.push(hold);
      if (hold.target) watchTarget(s, hold);
      else reevaluate(s);
    }
    return hold;
  }

  /* ---- responsive images ----
     Big pictures ship in four versions (scripts/make-image-variants.js):
                      desktop                 smartphone (cropped to the centre)
       low res        <name>_lo.webp          <name>_m_lo.webp
       high res       <name>.webp             <name>_m.webp
     The low one is the first paint; the high one swaps in once the page is
     idle. Pictures hidden or far down have no low version (hasLow false).

     PHONE_QUERY defines a smartphone: narrow and tall (a square 640px window
     wouldn't be filled by the cropped hero). The CSS for cropped pictures uses
     the same query; validate-data checks they match.

     isPhone()                 does the viewport match PHONE_QUERY
     onPhoneChange(fn)         fn() when that changes
     versions(src, hasLow)     -> { first, hi } for the current viewport
     variant(src, suffix)      "a/b.webp", "m" -> "a/b_m.webp"
     setSrc(img, first, src)   img -> first, falling back to src on error
     upgradeImage(img, hiSrc)  -> Promise<boolean>: swap in hiSrc once loaded and
                               idle; false when skipped */

  var PHONE_QUERY = "(max-width: 640px) and (max-aspect-ratio: 3/5)";
  var phoneMedia = window.matchMedia(PHONE_QUERY);

  function isPhone() {
    return phoneMedia.matches;
  }

  function onPhoneChange(fn) {
    if (phoneMedia.addEventListener) phoneMedia.addEventListener("change", fn);
    else if (phoneMedia.addListener) phoneMedia.addListener(fn);
  }

  function variant(src, suffix) {
    return String(src).replace(/(.[A-Za-z0-9]+)$/, "_" + suffix + "$1");
  }

  function versions(src, hasLow) {
    if (isPhone()) return { first: variant(src, hasLow ? "m_lo" : "m"), hi: variant(src, "m") };
    return { first: hasLow ? variant(src, "lo") : src, hi: src };
  }

  function setSrc(img, first, src) {
    function cleanup() {
      img.removeEventListener("error", fallback);
      img.removeEventListener("load", cleanup);
    }
    function fallback() {
      cleanup();
      if (img.getAttribute("src") !== src) img.src = src;
    }
    img.addEventListener("error", fallback);
    img.addEventListener("load", cleanup);
    img.src = first;
  }

  // Save-data or a slow link: keep the low version.
  function lowBandwidth() {
    var conn = navigator.connection;
    return !!conn && (!!conn.saveData || /(^|-)(2g|3g)$/.test(conn.effectiveType || ""));
  }

  function upgradeImage(img, hiSrc) {
    if (!img || !hiSrc || lowBandwidth()) return Promise.resolve(false);
    return H.imageReady(img).then(function () {
      return new Promise(function (resolve) { H.whenIdle(resolve, 3000, 200); });
    }).then(function () {
      if (!img.isConnected || img.getAttribute("src") === hiSrc) return false;
      // Already sharp enough at its displayed size? A box without a size yet upgrades.
      var needed = img.clientWidth * (window.devicePixelRatio || 1);
      if (needed > 0 && img.naturalWidth >= needed) return false;
      var hi = new Image();
      hi.decoding = "async";
      hi.fetchPriority = "low";
      hi.src = hiSrc;
      // Decoded first, so the swap is one frame; same aspect ratio, so no layout change.
      return hi.decode().then(function () {
        if (!img.isConnected) return false;
        img.src = hiSrc;
        return true;
      }, function () { return false; });
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

  /* ---- the page's arrival loader ----
     Opted into with data-page-loader on <html>. This runs in <head>, so the
     cover is a pseudo-element on <html> (set now, so half-built content never
     flashes) and the loader mounts on <body> once it exists. On a homepage
     scroll restore, js/scroll-memory.js hides the page itself and the cover
     only rises if that runs long. holdPage() keeps the cover down past
     pageReady(). Skipped on bfcache restores. */

  var pageHold = null;
  var pageActive = false;
  var pageIsReady = false;
  // pageReady() has been called, and the holds still pending (holdPage()).
  var pageWanted = false;
  var pageHolds = 0;

  function revealPage() {
    root.classList.add("emjive-page-revealing");
    var finished = false;
    function cleanup() {
      if (finished) return;
      finished = true;
      root.removeEventListener("transitionend", onEnd);
      root.classList.remove("emjive-page-loading", "emjive-page-revealing");
    }
    // transitionend bubbles; only the cover's own (::before on <html>) ends the reveal.
    function onEnd(e) {
      if (e.target === root && e.pseudoElement === "::before") cleanup();
    }
    root.addEventListener("transitionend", onEnd);
    // In case transitionend never comes (hidden tab, reduced-motion 0.01ms transition).
    setTimeout(cleanup, 600);
  }

  // "emjive:pageready", fired once on every page, loader or not: the first
  // paint is in. js/viewer-entry.js waits on it.
  var pageReadyAnnounced = false;

  function pageReady() {
    if (!pageReadyAnnounced) {
      pageReadyAnnounced = true;
      window.dispatchEvent(new Event("emjive:pageready"));
    }
    pageWanted = true;
    if (!pageActive || pageIsReady || pageHolds > 0) return;
    pageIsReady = true;
    if (!pageHold) return; // body not parsed yet; startPage() sees the flag
    pageHold.done().then(revealPage);
  }

  // Keeps the cover down past pageReady() until released (layouts measured
  // from late arrivals, like the wheel). The returned release is idempotent;
  // the watchdog lifts the cover regardless.
  function holdPage() {
    if (!pageActive || pageIsReady) return noop;
    var released = false;
    pageHolds++;
    return function () {
      if (released) return;
      released = true;
      pageHolds = Math.max(0, pageHolds - 1);
      if (pageWanted) pageReady();
    };
  }

  function startPage() {
    pageHold = mount(document.body, { page: true });
    if (pageIsReady) pageHold.done().then(revealPage);
  }

  function coverPageNow() {
    pageActive = true;
    root.classList.add("emjive-page-loading");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startPage);
    } else {
      startPage();
    }
    // A page script failing before pageReady() must not leave the cover up.
    setTimeout(function () {
      pageHolds = 0;
      pageReady();
    }, WATCHDOG_MS);
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) {
        pageIsReady = true;
        root.classList.remove("emjive-page-loading", "emjive-page-revealing");
      }
    });
  }

  var pageLoaderWanted = root.hasAttribute("data-page-loader") && !reduceQuery.matches;

  // Raised at first paint, except during a homepage scroll restore, where it
  // rises only if the restore is still running RESTORE_COVER_MS in.
  var RESTORE_COVER_MS = 400;

  if (pageLoaderWanted) {
    if (!root.classList.contains("emjive-restoring-scroll")) {
      coverPageNow();
    } else {
      setTimeout(function () {
        var memory = window.EmjiveScrollMemory;
        if (pageActive || !memory || !memory.isRestoring || !memory.isRestoring()) return;
        coverPageNow();
        // Released when the restore ends (js/scroll-memory.js).
        var release = holdPage();
        window.addEventListener("emjive:restore-end", release, { once: true });
        if (!memory.isRestoring()) release();
      }, RESTORE_COVER_MS);
    }
  }

  window.EmjiveLoader = {
    mount: mount,
    cover: cover,
    isPhone: isPhone,
    onPhoneChange: onPhoneChange,
    versions: versions,
    variant: variant,
    setSrc: setSrc,
    upgradeImage: upgradeImage,
    pageReady: pageReady,
    holdPage: holdPage,
    // For scripts starting after the event has fired.
    isPageReady: function () { return pageReadyAnnounced; }
  };
})();
