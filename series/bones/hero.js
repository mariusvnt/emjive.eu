/* ==========================================================================
   Bones — hero behaviour: frontier band lift, then scroll-driven x-ray wipe,
   then (in the gallery's stack view) the entrance: a further stretch of
   scrolling, the pin still held, over which the camera pulls back from the
   hand — it shrinks towards the circle the gallery's rings stand on round
   the wrist, the arm below it carrying on down the screen, and fades back to
   a trace (js/gallery-stack.js, which this feeds through
   window.EmjiveHero.publishStage, and which takes the rings from rings(), the
   circle from orbit() and drives the pull-back through setZoom()).
   A hero already seen on this device (data-hero="skip") isn't played: the
   page lands at its end, in the stack view with the whole of it still above
   (scrolling back up goes back through the entrance and the wipe to its
   start); in the grid view the hero isn't shown at all.

   Loaded at runtime by js/series.js from this series' "hero.js" path in
   data/series.json. Two rules this file has to keep:

   1. NO SIDE EFFECTS at execution time. It only assigns
      window.EmjiveSeriesHero and waits to be called. That's what lets the
      loader fetch the fragment, the stylesheet and this script all in
      parallel — two round trips to first hero paint instead of three.
   2. NO BARE SPECIFIERS. This is loaded via a runtime string path, so
      Vite never sees it and can't resolve `import "three"`. A hero needing
      3D calls window.EmjiveModelViewer (set by the bundled module) instead.

   Element lookups happen inside init(), not at execution time — the hero
   DOM doesn't exist until the loader has cloned the fragment in.
   ========================================================================== */

(function () {
  "use strict";

  var revealSection = null;
  var revealXrayGroup = null;
  var revealNormal = null;
  var revealFrontier = null;
  var revealEntrance = null;
  var revealPin = null;
  var siteHeader = null;
  var revealTicking = false;

  // The entrance (js/gallery-stack.js) counts as done this close to its end:
  // on a phone the toolbar coming and going moves innerHeight by a few px,
  // and the very bottom of the page must still read as "arrived".
  var ENTRANCE_DONE = 0.995;

  // The wrist, as a % of the full picture's width and height: the middle of
  // the circle the gallery's rings stand on (orbit()), which is also the
  // point the camera pulls back from. The circle's radius is how far the
  // rings on the hand are from it, on average, so they start on it (or
  // ORBIT_R_FALLBACK of the picture's height, with none on the hand).
  var WRIST_X = 50.5;
  var WRIST_Y = 80.5;
  var ORBIT_R_FALLBACK = 0.39;
  // The top of the hand (its longest fingertip), as a % of the picture's
  // height: orbit() hands it over, so the gallery can keep the fingers on
  // screen once the camera has pulled back.
  var HAND_TOP_Y = 11.7;
  // The x-ray has faded to its rest opacity by this point of the entrance.
  var XRAY_FADE_END = 0.8;

  // The hero skipped in the grid view (data-hero="skip" on <html>,
  // js/scroll-memory.js): the hero isn't shown, and the reveal's end state is
  // simply held — the selection bar there, the entrance done. In the stack
  // view a skipped hero is the whole reveal, landed at its end (landAtEnd).
  function isSkipped() {
    var root = document.documentElement;
    return root.getAttribute("data-hero") === "skip" && root.getAttribute("data-gallery-view") === "grid";
  }

  // A visitor arriving on a skipped hero in the stack view (a fresh history
  // entry; Back restores its own offset) is taken to the end of the reveal
  // once the stylesheet has made it tall, and until then the reveal reads as
  // finished — the stack must not start its entrance for the frames before.
  var awaitingEnd = false;
  var LAND_MS = 2000;

  function landAtEnd() {
    var root = document.documentElement;
    var until = Date.now() + LAND_MS;
    (function step() {
      if (!awaitingEnd) return;
      // Hero.css has landed when the reveal is taller than its own pin.
      var tall = revealSection.offsetHeight > window.innerHeight * 1.5;
      if (!tall && Date.now() < until) {
        requestAnimationFrame(step);
        return;
      }
      awaitingEnd = false;
      // Only from the top: a visitor who has already scrolled is left where
      // they are.
      if (tall && (window.pageYOffset || window.scrollY || 0) === 0) {
        var previous = root.style.scrollBehavior;
        root.style.scrollBehavior = "auto";
        window.scrollTo(0, root.scrollHeight);
        if (previous) root.style.scrollBehavior = previous;
        else root.style.removeProperty("scroll-behavior");
      }
      updateReveal();
    })();
  }

  function restOpacity() {
    var value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reveal-xray-rest-opacity"));
    return isFinite(value) ? value : 0.3;
  }

  function showEnd() {
    revealFrontier.style.bottom = "";
    revealXrayGroup.style.clipPath = "inset(0 0 0 0)";
    revealXrayGroup.style.opacity = String(restOpacity());
    revealNormal.style.clipPath = "inset(0 0 100% 0)";
    window.EmjiveHero.publishStage(1);
    // Far past any trigger: the selection bar is simply there.
    window.EmjiveHero.publishScroll(1e6, true);
  }

  function updateReveal() {
    revealTicking = false;
    if (isSkipped() || awaitingEnd) {
      showEnd();
      return;
    }
    var rect = revealSection.getBoundingClientRect();
    // Unclamped — needed below to keep driving the selection bar's
    // entrance once scrolling continues past totalScroll, after the
    // pin itself has already released.
    var rawScrolled = Math.max(0, -rect.top);
    // The gallery's entrance stretch at the end of the reveal (0 in the grid
    // view): the wipe plays over everything before it.
    var entrancePx = revealEntrance ? revealEntrance.getBoundingClientRect().height : 0;
    // How long the pin holds: the reveal's height less the pin's own (100vh,
    // the screen without a phone's browser bars) — not window.innerHeight,
    // which the bars change as they come and go: measured against it, a fast
    // scroll hiding them made the wipe and the entrance jump. Clamped to
    // >= 0, which could otherwise fall through to the "fully revealed"
    // branch below even at scroll position 0.
    var pinHeight = revealPin ? revealPin.offsetHeight : window.innerHeight;
    var totalScroll = Math.max(0, rect.height - entrancePx - pinHeight);
    var scrolled = totalScroll > 0 ? Math.min(totalScroll, rawScrolled) : 0;

    // Phase 1: the frontier band lifts up from below the viewport until
    // it's flush with the pin's bottom edge (the normal image's bottom) —
    // this takes exactly one band-height of scrolling. Phase 2 only then
    // starts the x-ray wipe, with the band riding the reveal boundary.
    var liftDistance = Math.min(revealFrontier.getBoundingClientRect().height, totalScroll);
    // Every layout read happens up here, before the first style write below.
    // The header was measured at the bottom of this function, after the
    // clip-path/bottom writes — which made the browser lay the page out a
    // second time per scroll frame.
    var headerHeight = siteHeader ? siteHeader.getBoundingClientRect().height : 0;
    var wipeDistance = Math.max(totalScroll - liftDistance, 1);

    if (totalScroll <= 0 || scrolled <= liftDistance) {
      var liftFraction = liftDistance > 0 ? scrolled / liftDistance : 1;
      revealFrontier.style.bottom = "calc(" + (-(1 - liftFraction)) + " * var(--reveal-frontier-height))";
      revealXrayGroup.style.clipPath = "inset(100% 0 0 0)";
      revealNormal.style.clipPath = "inset(0 0 0 0)";
    } else {
      var wipeProgress = Math.min(1, (scrolled - liftDistance) / wipeDistance);
      var revealedPct = wipeProgress * 100;
      revealFrontier.style.bottom = revealedPct + "%";
      // Complementary clips so the two never occupy the same region at
      // once — the x-ray (and ring, both inside revealXrayGroup) reveal
      // from the bottom up, the normal image gets clipped away from the
      // bottom by that same amount, regardless of any transparency in
      // the x-ray image.
      revealXrayGroup.style.clipPath = "inset(" + (100 - revealedPct) + "% 0 0 0)";
      revealNormal.style.clipPath = "inset(0 0 " + revealedPct + "% 0)";
    }

    // The floating selection bar's entrance continues directly off the
    // point where the frontier band's leading edge would pass behind the
    // fixed header — not where the wipe hits 100%, which is where the band
    // reaches the literal top of the viewport, already invisible (covered
    // by the header, z-index 80 vs. the band's own 2) well before that
    // point on any page with one. Same technique as liftDistance/
    // wipeDistance/wipeProgress above (measure the real element, turn a
    // scroll distance into a 0-1 progress): the band's own bottom edge
    // sits at screen-Y = innerHeight * (1 - wipeProgress) while riding the
    // wipe (the "bottom: X%" set on it above, expressed against that same
    // window height), so solving for the wipeProgress at which that equals
    // the header's own height gives the exact scroll position this phase
    // should start from, however tall the header happens to be at the
    // current viewport width — falls back to the literal wipe-complete
    // point (headerHeight 0) if there's no header on this page at all.
    //
    // Only the resulting scroll distance is published, not the transform:
    // how far the bar itself has to travel is the bar's own business (it
    // measures its summary row), and js/selection-bar.js subscribes to
    // this via window.EmjiveHero. Everything above the publish call is
    // hero geometry, which is why the header measurement stays here.
    var wipeProgressAtHeader = window.innerHeight > 0
      ? Math.max(0, 1 - headerHeight / window.innerHeight)
      : 1;
    var barTriggerScroll = liftDistance + wipeProgressAtHeader * wipeDistance;
    window.EmjiveHero.publishScroll(Math.max(0, rawScrolled - barTriggerScroll), totalScroll > 0);

    // The gallery's entrance: how far through its stretch the page is, the
    // hand fading back as the products come up over it. With no stretch (the
    // grid), the reveal simply ends where the wipe does.
    var entrance;
    if (entrancePx > 0) {
      // The page ends before the reveal by a phone's browser bars' height
      // (hero.css: the reveal's negative margin): the entrance ends where
      // the page does with the bars hidden, so it is always played out.
      var shortfall = Math.max(0, -(parseFloat(getComputedStyle(revealSection).marginBottom) || 0));
      var entranceLength = Math.max(1, entrancePx - shortfall);
      entrance = Math.max(0, Math.min(1, (rawScrolled - totalScroll) / entranceLength));
      if (entrance >= ENTRANCE_DONE) entrance = 1;
    } else {
      entrance = totalScroll > 0 && rawScrolled >= totalScroll ? 1 : 0;
    }
    // The x-ray fades at the gallery's own pace (EmjiveHero.mapStage: a
    // wheel rolling back to the hand holds the camera, and this with it).
    var faded = window.EmjiveHero.mapStage ? window.EmjiveHero.mapStage(entrance) : entrance;
    revealXrayGroup.style.opacity = entrancePx > 0
      ? String(1 - Math.min(1, faded / XRAY_FADE_END) * (1 - restOpacity()))
      : "";
    window.EmjiveHero.publishStage(entrance);
  }

  function requestRevealUpdate() {
    if (!revealTicking) {
      revealTicking = true;
      requestAnimationFrame(updateReveal);
    }
  }

  // Product image(s) riding the x-ray hand (inside revealXrayGroup, so each
  // reveals in lockstep with the wipe above) — built from this series' own
  // products, handed over by js/series.js once they load. Not a single fixed
  // element: any number of products can have "hero-hand-visibility.visible":
  // true at once, so this creates one <img class="reveal__ring"> per visible
  // product rather than assuming there's only ever one. Each one's
  // position/size/rotation comes from that SAME product's own
  // hero-hand-visibility.x/y/scale/rotation (a
  // % of the hand image's own width/height, and degrees) — set as inline
  // custom properties on that specific <img>, not shared globally, so
  // multiple rings on screen at once don't fight over one set of values the
  // way hero.css's --ring-x/--ring-y/--ring-size/--ring-rotation
  // (fallback-only, see their own comment) would if applied to all at once.
  //
  // Deliberately gets the FULL product list, never a filtered one: the rings
  // on the hand are hero art, not a listing of what's currently on show.
  function updateHeroRings(products) {
    if (!revealXrayGroup) return;
    revealXrayGroup.querySelectorAll(".reveal__ring").forEach(function (existing) {
      existing.remove();
    });
    products.forEach(function (product) {
      var onHand = product["hero-hand-visibility"];
      if (!onHand || !onHand.visible) return;
      var topShot = product.assets && product.assets["top-shot"] && product.assets["top-shot"][product["default-metal"]];
      if (!topShot) return;
      var ring = document.createElement("img");
      ring.className = "reveal__ring";
      ring.alt = "";
      ring.decoding = "async";
      ring.src = topShot;
      // Which product it is, and how it lies on the hand: the gallery's
      // stack takes each ring off the hand by these (rings() below).
      ring.setAttribute("data-product-id", product.id);
      ring.setAttribute("data-rotation", String(onHand.rotation || 0));
      ring.setAttribute("data-x", String(onHand.x));
      ring.setAttribute("data-y", String(onHand.y));
      ring.setAttribute("data-scale", String(onHand.scale));
      ring.style.setProperty("--ring-x", onHand.x + "%");
      ring.style.setProperty("--ring-y", onHand.y + "%");
      ring.style.setProperty("--ring-size", onHand.scale + "%");
      ring.style.setProperty("--ring-rotation", onHand.rotation + "deg");
      revealXrayGroup.appendChild(ring);
    });
  }

  // The x-ray group's box on the screen as laid out, before any pull-back
  // (setZoom) — its transform is only ever the pull-back's and the centring
  // translateX(-50%), so its layout box is what the pull-back starts from.
  // And the phone's crop of the picture (hero.css: what share of the full
  // width is left, and where it starts, in %).
  function layoutBox() {
    var pin = revealXrayGroup.offsetParent || revealXrayGroup.parentNode;
    var stage = pin.getBoundingClientRect();
    var w = revealXrayGroup.offsetWidth;
    var h = revealXrayGroup.offsetHeight;
    var style = getComputedStyle(document.documentElement);
    var crop = parseFloat(style.getPropertyValue("--hero-crop"));
    var cropLeft = parseFloat(style.getPropertyValue("--hero-crop-left"));
    return {
      left: stage.left + (stage.width - w) / 2,
      top: stage.top + stage.height - h,
      width: w,
      height: h,
      crop: isFinite(crop) && crop > 0 ? crop : 1,
      cropLeft: isFinite(cropLeft) ? cropLeft : 0
    };
  }

  // A point given as a % of the FULL picture, as the screen shows it (the
  // phone's crop re-expresses x the way hero.css's .reveal__ring does).
  function pointOn(box, xPct, yPct) {
    return {
      x: box.left + box.width * ((xPct - box.cropLeft) / box.crop) / 100,
      y: box.top + box.height * yPct / 100
    };
  }

  function ringEls() {
    return revealXrayGroup ? revealXrayGroup.querySelectorAll(".reveal__ring") : [];
  }

  window.EmjiveSeriesHero = {
    init: function () {
      revealSection = document.getElementById("revealSection");
      revealXrayGroup = document.getElementById("revealXrayGroup");
      revealNormal = revealSection ? revealSection.querySelector(".reveal__img--normal") : null;
      revealFrontier = document.getElementById("revealFrontier");
      revealEntrance = revealSection ? revealSection.querySelector(".reveal__entrance") : null;
      revealPin = revealSection ? revealSection.querySelector(".reveal__pin") : null;
      // Fixed, so it visually sits (z-index 80) over whatever scrolls
      // underneath it — see the bar-trigger comment in updateReveal().
      siteHeader = document.querySelector(".site-header");

      if (!revealSection || !revealXrayGroup || !revealNormal || !revealFrontier) return;

      window.addEventListener("scroll", requestRevealUpdate, { passive: true });
      window.addEventListener("resize", requestRevealUpdate);
      var memory = window.EmjiveScrollMemory;
      var landed = memory && memory.landing && memory.landing();
      var root = document.documentElement;
      awaitingEnd = !!(landed && landed.fresh && !(memory.isRestoring && memory.isRestoring()) &&
        root.getAttribute("data-hero") === "skip" && root.getAttribute("data-gallery-view") === "stack");
      updateReveal();
      if (awaitingEnd) landAtEnd();
    },

    onProducts: updateHeroRings,

    // The rings on the hand, for js/gallery-stack.js to take off it:
    // [{ id, el, rotation, x, y, size }] — rotation in degrees, as the ring
    // lies; its middle and its width (the ring's own, unturned) in px of the
    // screen, as laid out before any pull-back.
    rings: function () {
      if (!revealXrayGroup) return [];
      var box = layoutBox();
      return Array.prototype.map.call(ringEls(), function (el) {
        var at = pointOn(box, parseFloat(el.getAttribute("data-x")) || 0, parseFloat(el.getAttribute("data-y")) || 0);
        return {
          id: el.getAttribute("data-product-id"),
          el: el,
          rotation: parseFloat(el.getAttribute("data-rotation")) || 0,
          x: at.x,
          y: at.y,
          size: box.width * ((parseFloat(el.getAttribute("data-scale")) || 0) / box.crop) / 100
        };
      });
    },

    // The circle round the wrist the gallery's rings stand on, in px of the
    // screen as laid out before any pull-back: { x, y, r }, and how high the
    // hand reaches (top: its fingertips' y). null without a hero to measure.
    orbit: function () {
      if (!revealXrayGroup || !revealXrayGroup.offsetHeight) return null;
      var box = layoutBox();
      var wrist = pointOn(box, WRIST_X, WRIST_Y);
      var rings = this.rings();
      var r = ORBIT_R_FALLBACK * box.height;
      if (rings.length) {
        r = rings.reduce(function (sum, ring) {
          return sum + Math.sqrt(Math.pow(ring.x - wrist.x, 2) + Math.pow(ring.y - wrist.y, 2));
        }, 0) / rings.length;
      }
      return { x: wrist.x, y: wrist.y, r: r, top: pointOn(box, WRIST_X, HAND_TOP_Y).y };
    },

    // The camera pulling back (js/gallery-stack.js): the hand shrinks by
    // `scale` about the wrist, which moves by (dx, dy) px. (1, 0, 0) is the
    // hand as laid out.
    setZoom: function (scale, dx, dy) {
      if (!revealXrayGroup) return;
      if (scale === 1 && !dx && !dy) {
        revealXrayGroup.style.removeProperty("transform");
        revealXrayGroup.style.removeProperty("transform-origin");
        return;
      }
      var box = layoutBox();
      // Pulled back, the wipe is long over (its clip is inset(0) by then), and
      // a clip to the group's box would cut off the arm hanging below it.
      revealXrayGroup.style.clipPath = "none";
      revealXrayGroup.style.transformOrigin = ((WRIST_X - box.cropLeft) / box.crop) + "% " + WRIST_Y + "%";
      revealXrayGroup.style.transform = "translateX(-50%) translate(" + dx.toFixed(2) + "px," + dy.toFixed(2) + "px) scale(" + scale.toFixed(5) + ")";
    },

    // Room added to the entrance for the wheel to roll back to the hand in
    // (js/gallery-stack.js), as a share of the entrance's own length: the
    // reveal grows by it at its end, and the published stage runs over
    // the whole stretch, room included.
    setEntranceRoom: function (share) {
      if (!revealSection) return;
      revealSection.style.setProperty("--reveal-entrance-room", String(share));
      requestRevealUpdate();
    },

    // data-hero / data-gallery-view on <html> just changed (js/gallery.js: a
    // replay, or a switch of view): the reveal takes its new shape at once,
    // in the same frame, rather than on the next scroll.
    setMode: function () {
      if (!revealSection) return;
      if (!isSkipped()) {
        revealXrayGroup.style.opacity = "";
      }
      updateReveal();
    }
  };
})();
