/* ==========================================================================
   em·ji·ve — loader animation

   Drives the logo loader (.loader in css/style.css; markup in
   loader-test.html): each of the mark's three parts crosses the screen from
   the right edge to the left edge, fading in on the way in and out on the
   way out, with a slow stretch as it passes the middle. Timing is read from
   the CSS custom properties on .loader, so everything is tuned in the
   stylesheet: --loader-cycle in seconds, and every phase (--loader-in,
   --loader-slow, --loader-out, --loader-gap, --loader-stagger) as a
   percentage of it. The gap is the blank time before the loop restarts; it
   is held exactly, and the other three phases are scaled together to fill
   whatever it leaves.

   Why JS and not @keyframes: keyframe percentages cannot be computed from
   custom properties, and the easing curves below are solved from the phase
   lengths. The offsets are derived here instead, as Web Animations.

   One keyframe set drives both transform and opacity, so the movement and
   the fade cannot drift out of sync — they share every offset and every
   easing curve:

     offset 0              right edge, opacity 0    eased in (already moving,
     offset in             just right of centre, 1    slows to drift speed)
     offset in+slow        just left of centre, 1   linear drift, the slow part
     offset in+slow+out    left edge, opacity 0     eased out (leaves at drift
     offset 1              same: the rest of the      speed, speeds up)
                           cycle, blank before the loop

   Each eased leg is a quadratic curve — constant deceleration into the slow
   stretch, constant acceleration out of it — whose end next to the slow
   stretch has exactly the drift's own speed, so there is no jolt where a
   leg meets it. CSS only takes cubic Béziers, so each quadratic is written
   as the cubic that traces the same curve (degree elevation: handles a
   third and two thirds of the way along).
   The drift's speed is set as a share of the crossing's average speed
   (--loader-slow-speed), which makes the stretch's length follow from it
   (speed x --loader-slow) as a fraction of the travel distance. All of that
   is ratios, so the curves do not depend on the screen size; only the pixel
   distances do, which is why the keyframes are rebuilt on resize.

   Without JS, or under prefers-reduced-motion, the loader shows the
   finished mark, still.
   ========================================================================== */
(function () {
  "use strict";

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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

  function startLoader(root) {
    var mark = root.querySelector(".loader__mark");
    var parts = Array.prototype.slice.call(root.querySelectorAll(".loader__part"));
    if (!mark || !parts.length) return;

    var styles = getComputedStyle(root);
    var cycle = seconds(styles, "--loader-cycle");
    var fIn = share(styles, "--loader-in");
    var fSlow = Math.max(share(styles, "--loader-slow"), 0.001);
    var fOut = share(styles, "--loader-out");
    var fGap = clamp01(share(styles, "--loader-gap"));
    var stagger = share(styles, "--loader-stagger") * cycle;
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

    /* The crossing covers 2 travels (right edge to left edge) in offOut of
       the cycle, so its average speed is 2 / offOut. The slow stretch moves
       at slowSpeed times that for fSlow of the cycle, covering 2 * drift
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
       speed), so it starts at s0 = 2 - k. No rest at the edge — the part is
       invisible there, and a standing start would only spend the leg's time
       crawling out of sight. As a cubic: handles (1/3, s0/3), (2/3, 1 - s1/3).
       Out is the mirror image: starts at k, ends at 2 - k. Clamped at 0 so
       the curve never runs backwards, which only happens when the slow
       stretch is faster than twice the leg's average speed. */
    function quadratic(startSlope, endSlope) {
      return "cubic-bezier(0.3333, " + clamp01(startSlope / 3).toFixed(4) +
        ", 0.6667, " + clamp01(1 - endSlope / 3).toFixed(4) + ")";
    }
    var easeIn = quadratic(2 - kIn, kIn);
    var easeOut = quadratic(kOut, 2 - kOut);

    var animations = [];

    function frame(offset, opacity, x, easing) {
      var f = {
        offset: offset,
        opacity: opacity,
        transform: "translateX(" + x.toFixed(2) + "px)"
      };
      if (easing) f.easing = easing;
      return f;
    }

    function build() {
      var saved = animations.map(function (a) { return a.currentTime; });
      animations.forEach(function (a) { a.cancel(); });

      /* Distance from rest to fully off-screen: half the screen plus half
         the mark (all three parts share the mark's box). */
      var travel = window.innerWidth / 2 + mark.getBoundingClientRect().width / 2;
      var near = travel * drift;

      var keyframes = [
        frame(0, 0, travel, easeIn),
        frame(offIn, 1, near, "linear"),
        frame(offSlow, 1, -near, easeOut),
        frame(offOut, 0, -travel),
        frame(1, 0, -travel)
      ];

      animations = parts.map(function (part, i) {
        var a = part.animate(keyframes, {
          duration: cycle * 1000,
          delay: i * stagger * 1000,
          iterations: Infinity,
          fill: "backwards"
        });
        if (saved[i] != null) a.currentTime = saved[i];
        return a;
      });
    }

    build();

    var pending = 0;
    window.addEventListener("resize", function () {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(build);
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(".loader"), startLoader);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
