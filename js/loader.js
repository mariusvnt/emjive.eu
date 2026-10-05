/* ==========================================================================
   em·ji·ve — loader

   The logo loader as a shared component (.loader in css/style.css). Each of
   the mark's three parts crosses its CONTAINER from the right border to the
   left border, fading in on the way in and out on the way out, with a slow
   stretch as it passes the middle. Exposes window.EmjiveLoader:

     mount(host, { page })  -> hold   put a loader inside `host` (one per
                                      host; more mounts on the same host add
                                      holds to it). hold.done() releases it.
     mount(host, { target }) -> hold  a SHARED loader: many assets, one loader.
                                      Each hold names the element its asset
                                      is shown in (`target`) and only counts
                                      while that element is on screen — see
                                      "a loader shared by several assets".
     coverWithin(host, target, ready) -> Promise
                                      cover()'s counterpart for a shared loader:
                                      `target` fades in as soon as `ready`
                                      settles; `host`'s loader is held until then.
     cover(host, ready)     -> Promise  hide host's <img> children, show a
                                      loader, and reveal them (a quick fade)
                                      once `ready` settles and the loader has
                                      left. Resolves when revealed.
     imageReady(img)        -> Promise  loaded (or failed) and decoded.
     isPhone / versions / variant / setSrc / upgradeImage    responsive images:
                                      four versions of each big picture, a low
                                      one for the first paint and a high one
                                      swapped in afterwards (see "responsive
                                      images").
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
  // How much of a target must be on screen for its asset's wait to count in a
  // shared loader (see "a loader shared by several assets"). Not "any": a slide
  // with a sliver showing at the edge of the carousel is not something anyone
  // is waiting on.
  var VISIBLE_RATIO = 0.2;
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
      rate: 1,
      rampRaf: 0,
      forcedPosition: forcedPosition,
      bleed: !!bleed,
      clipAncestor: null,
      visibility: null,
      // A shared loader (mount's opts.target): the holds taken on it, and
      // whether a crossing is being finished off before it goes quiet.
      targeted: !!targeted,
      holdList: [],
      parking: false
    };
    states.set(host, s);
    function startTimer() {
      s.timer = setTimeout(function () { show(s); }, showDelayMs());
    }
    // A shared loader has no host-level "on screen" test: whether it should be
    // up is decided by its holds' targets (reevaluate), as they come and go.
    if (s.targeted) return s;
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
      // A rebuild (the loader's box was resized) must not snap a released
      // loader back to its loading pace.
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
    cancelAnimationFrame(s.rampRaf);
    if (s.visibility) s.visibility.disconnect();
    if (s.observer) s.observer.disconnect();
    s.holdList.forEach(function (h) { if (h.io) { h.io.disconnect(); h.io = null; } });
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

  function release(s, hold) {
    s.holds--;
    if (hold) {
      hold.released = true;
      if (hold.io) { hold.io.disconnect(); hold.io = null; }
    }
    // Never shown (still inside the show-delay): nothing to wait out.
    if (!s.shown) {
      if (s.holds <= 0) destroy(s);
      // A shared loader with other holds left: this one may have been the
      // only visible wait, in which case the pending show-delay is void.
      else if (s.targeted) reevaluate(s);
      return Promise.resolve();
    }
    // A shared loader that still has holds is not finished with: whether it
    // carries on or finishes its crossing and goes quiet depends on whether
    // any of the waits left are on screen.
    if (s.holds > 0 && s.targeted) {
      reevaluate(s);
      return Promise.resolve();
    }
    // Nothing left to wait for but the crossing in progress: let it finish
    // faster instead of at its leisurely loading pace. The guardrail is
    // unchanged — the loader still goes only inside the safe window, and
    // never with a part visible — it just gets there sooner (without this,
    // content that was ready could sit behind the cover for most of a cycle).
    if (s.holds <= 0) finishCrossing(s);
    return whenSafe(s).then(function () {
      // Re-checked here, not above: a hold taken while this one was waiting
      // for the safe window keeps the loader alive.
      if (s.holds <= 0) destroy(s);
    });
  }

  /* ---- a loader shared by several assets -------------------------------------
     The product page's carousel holds a 3D model and some photos, which load
     independently. Each used to have a loader of its own, so a visitor could
     watch two or three of them cross at once; now they share one, mounted on
     the carousel, and each asset just takes a hold on it (mount's opts.target).

     A hold only counts while its target — the slide the asset appears in — is
     on screen (IntersectionObserver, which respects the carousel's own
     clipping, so a slide scrolled out of the strip is off screen). The loader
     is "active" while at least one unreleased hold is visible, and:

       - the show-delay (--loader-delay) is counted from the moment it becomes
         active, and abandoned if it stops being so first. A wait nobody can
         see never shows anything.
       - once shown, it carries on for as long as it stays active. When the
         last visible wait is over — released, or scrolled out of view — it
         finishes the crossing it is in (the same speed-up and safe window as a
         release) and goes quiet, with the holds that remain still counted.
       - when a pending asset comes into view later, it starts again, after
         the delay, as a new cycle.
       - when the last hold is released it is removed, as ever.
     ----------------------------------------------------------------------- */

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
        // Something visible is waiting again while the crossing was being
        // finished off: back to the loading pace.
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

  // Finishes the crossing in progress, then puts the loader away (not
  // destroyed: holds remain) — unless something visible is waiting again by
  // the time it is safe to.
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

  // How much faster a released loader's crossing runs, and how long the speed-up
  // takes to build. The rate is eased in (smoothstep) rather than switched: a
  // step from 1x to 2.5x is a visible jolt in the parts' motion, a ramp reads
  // as the loader simply deciding to finish. The Web Animations playbackRate
  // setter keeps the current time, so the parts carry on from where they are
  // and only their speed changes (the stagger between them keeps its shape,
  // scaled).
  var FINISH_RATE = 2.5;
  var FINISH_RAMP_MS = 700;

  function setRate(s, rate) {
    s.rate = rate;
    s.anims.forEach(function (a) {
      try { a.playbackRate = rate; } catch (err) { /* no-op: keep the pace */ }
    });
  }

  function finishCrossing(s) {
    if (s.rampRaf || inSafeWindow(s)) return;
    var from = s.rate;
    var start = performance.now();
    (function step(now) {
      var p = Math.min(1, (now - start) / FINISH_RAMP_MS);
      setRate(s, from + (FINISH_RATE - from) * p * p * (3 - 2 * p));
      // Until it is at full speed — or the loader is gone (destroy() cancels
      // the pending frame).
      s.rampRaf = p < 1 ? requestAnimationFrame(step) : 0;
    })(start);
  }

  function mount(host, opts) {
    if (!host || !states || reduceQuery.matches) return NOOP_HOLD;
    var target = (opts && opts.target) || null;
    var s = states.get(host) || createState(host, !!(opts && opts.page), !!(opts && opts.bleed), !!target);
    s.holds++;
    var promise = null;
    // opts.watchdog === false is for loader-test.html, whose loaders are
    // meant to loop for as long as you care to watch.
    var watchdog = opts && opts.watchdog === false
      ? 0
      : setTimeout(function () { hold.done(); }, WATCHDOG_MS);
    var hold = {
      target: s.targeted ? target : null,
      // A hold with no target on a shared loader is always "in view".
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

  /* ---- responsive images ---------------------------------------------------
     The big pictures ship in four versions (scripts/make-image-variants.js
     writes them, scripts/validate-data.js insists they exist):

                      desktop                 smartphone
       low res        <name>_lo.webp          <name>_m_lo.webp
       high res       <name>.webp             <name>_m.webp

     The smartphone ones are cropped to the middle of the picture, which is
     all a phone ever shows, and so are smaller than the desktop ones. The low
     one is what a page's first paint is made of; the high one is fetched
     afterwards, once the page is loaded and idle, and swapped in without
     anyone noticing. A picture that is hidden or far down the page has no low
     version (hasLow false): it just gets the right high one.

     PHONE_QUERY is what "smartphone" means: a narrow window that is also tall
     and thin. The aspect clause is what the hero's crop is sized for (see
     PHONE_CROP in scripts/make-image-variants.js) — a square 640px window is
     not a phone, and a cropped picture would not fill it. The CSS rules that
     lay a cropped picture out use this exact query; keep them in step.

     isPhone()                      does the viewport match PHONE_QUERY?
     onPhoneChange(fn)              fn() when it starts or stops matching
     versions(src, hasLow)          -> { first, hi }: what to show first and what
                                    to swap in, for the viewport right now
     variant(src, suffix)           "a/b.webp", "m" -> "a/b_m.webp"
     setSrc(img, first, src)        point img at first (src, the full file, if
                                    that 404s)
     upgradeImage(img, hiSrc)       -> Promise<boolean>  swap in hiSrc once the
                                    img has loaded and the browser is idle;
                                    false when it chose not to */

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

  // Saving data, or a slow link: the small one stays. Costing a visitor on 3G
  // the second download for a sharpness they would wait seconds for is the
  // wrong trade.
  function lowBandwidth() {
    var conn = navigator.connection;
    return !!conn && (!!conn.saveData || /(^|-)(2g|3g)$/.test(conn.effectiveType || ""));
  }

  function whenIdle(fn) {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 3000 });
    else setTimeout(fn, 200);
  }

  function upgradeImage(img, hiSrc) {
    if (!img || !hiSrc || lowBandwidth()) return Promise.resolve(false);
    return imageReady(img).then(function () {
      return new Promise(function (resolve) { whenIdle(resolve); });
    }).then(function () {
      if (!img.isConnected || img.getAttribute("src") === hiSrc) return false;
      // Already sharp enough for the size it is shown at (and the screen's
      // density)? Then there is nothing to gain. A box with no size yet
      // (hidden) can't be judged, so it upgrades.
      var needed = img.clientWidth * (window.devicePixelRatio || 1);
      if (needed > 0 && img.naturalWidth >= needed) return false;
      var hi = new Image();
      hi.decoding = "async";
      hi.fetchPriority = "low";
      hi.src = hiSrc;
      // Decoded off-screen first, so the swap is one frame with nothing to
      // wait for; the box doesn't change size (same aspect ratio).
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

  // cover() for a shared loader: `target` (a slide) is hidden until `ready`
  // settles and then fades in AT ONCE — it does not wait for the loader to
  // leave, because the loader is not its own: it belongs to the whole strip
  // and goes when nothing visible is still loading.
  function coverWithin(host, target, ready) {
    if (!host || !target || reduceQuery.matches) return Promise.resolve();
    target.classList.add("loader-host", "is-loader-pending");
    var hold = mount(host, { target: target });
    return Promise.resolve(ready)
      .then(noop, noop)
      .then(function () {
        target.classList.remove("is-loader-pending");
        return hold.done();
      });
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

  // Announced once, on every page and whether or not it has an arrival loader
  // (reduced motion, a scroll restore): "the page's first paint is in". What
  // js/viewer-entry.js waits for before it starts the heavy 3D download on
  // the homepage.
  var pageReadyAnnounced = false;

  function pageReady() {
    if (!pageReadyAnnounced) {
      pageReadyAnnounced = true;
      window.dispatchEvent(new Event("emjive:pageready"));
    }
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
    coverWithin: coverWithin,
    imageReady: imageReady,
    isPhone: isPhone,
    onPhoneChange: onPhoneChange,
    versions: versions,
    variant: variant,
    setSrc: setSrc,
    upgradeImage: upgradeImage,
    pageReady: pageReady,
    // Has pageReady() been called yet? (For a script that starts after the
    // event it announces has already fired.)
    isPageReady: function () { return pageReadyAnnounced; }
  };
})();
