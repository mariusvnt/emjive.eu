// Bones hero: the scan band lifts, the x-ray wipes open on scroll, then (wheel
// view) the entrance: more pinned scroll over which the camera pulls back from
// the hand to the wheel round the wrist. Feeds js/gallery-stack.js through
// window.EmjiveHero.publishStage, rings(), orbit(), wipeTop() and setZoom().
// A skipped hero (data-hero="skip") lands at its end; the grid view doesn't
// show it.
//
// Loaded by js/studies.js from a runtime path, so:
//   1. No side effects on execution: it only sets window.EmjiveStudyHero,
//      letting the fragment, stylesheet and script load in parallel.
//   2. No bare imports: Vite never sees this file.
// Elements are looked up in init(), once the fragment is cloned in.

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

  // Counts as done this close to the end: a phone's toolbar moves innerHeight
  // by a few px, and the page's bottom must still read as arrived.
  var ENTRANCE_DONE = 0.995;

  // The lead: from LEAD_START of the entrance the shown progress runs ahead of
  // the scroll, so a scroll that stops short still lands on the wheel. It moves
  // only on a scroll and the way the scroll went, so it never shows as a motion
  // of its own; scrolling back, it rejoins the scroll by LEAD_START. Its
  // strength ramps up to LEAD_FULL, stronger when no finger holds the page (a
  // fling's inertia, a wheel, keys). The wheel view only.
  var LEAD_START = 0.5;
  var LEAD_FULL = 0.8;
  var LEAD_HELD = 1.5;
  var LEAD_FREE = 3;
  var fingers = 0;
  // { raw, shown, length } at the last update; null to restart on the scroll.
  var lead = null;

  // The wrist, as % of the full picture: centre of the wheel and of the
  // pull-back. The wheel's radius is the hand rings' mean distance from it, or
  // ORBIT_R_FALLBACK of the picture's height with none.
  var WRIST_X = 50.5;
  var WRIST_Y = 80.5;
  var ORBIT_R_FALLBACK = 0.39;
  // The longest fingertip, as % of the picture's height (orbit().top).
  var HAND_TOP_Y = 11.7;
  var XRAY_FADE_END = 0.8;

  // Skipped hero in the grid view: the end state is simply held. In the wheel
  // view a skipped hero is landed at its end instead (landAtEnd).
  function isSkipped() {
    var root = document.documentElement;
    return root.getAttribute("data-hero") === "skip" && root.getAttribute("data-gallery-view") === "grid";
  }

  // A fresh arrival on a skipped hero in the wheel view scrolls to the reveal's
  // end once hero.css has made it tall; until then the reveal reads as finished
  // so the wheel doesn't start its entrance.
  var awaitingEnd = false;
  var LAND_MS = 2000;

  function landAtEnd() {
    var root = document.documentElement;
    var until = Date.now() + LAND_MS;
    (function step() {
      if (!awaitingEnd) return;
      var tall = revealSection.offsetHeight > window.innerHeight * 1.5;
      if (!tall && Date.now() < until) {
        requestAnimationFrame(step);
        return;
      }
      awaitingEnd = false;
      // Only from the top: a visitor who already scrolled stays put.
      if (tall && (window.pageYOffset || window.scrollY || 0) === 0) {
        window.EmjiveHelpers.jumpScroll(root.scrollHeight);
      }
      updateReveal();
    })();
  }

  // The shown entrance for the scroll's raw one (0..1 over length px).
  function leadEntrance(raw, length) {
    // A restored scroll shows as left, not led by a jump the visitor didn't make.
    var memory = window.EmjiveScrollMemory;
    var last = memory && memory.isRestoring && memory.isRestoring() ? null : lead;
    var wheelView = document.documentElement.getAttribute("data-gallery-view") === "stack";
    var shown = raw;
    if (last && wheelView && raw > LEAD_START) {
      if (last.length !== length) {
        // A layout change, not a scroll: as many px left to the end.
        shown = 1 - (1 - last.shown) * last.length / length;
      } else if (raw > last.raw) {
        // Forward: what's left to show shrinks as a power of what's left to scroll.
        var from = Math.max(last.raw, LEAD_START);
        var fromShown = last.raw < LEAD_START ? from : last.shown;
        var gain = 1 + ((fingers ? LEAD_HELD : LEAD_FREE) - 1) * window.EmjiveHelpers.smoothstep(LEAD_START, LEAD_FULL, (from + raw) / 2);
        shown = from >= 1 ? 1 : 1 - (1 - fromShown) * Math.pow((1 - raw) / (1 - from), gain);
      } else if (raw < last.raw) {
        // Back: the lead shrinks with the distance to LEAD_START.
        shown = LEAD_START + (last.shown - LEAD_START) * (raw - LEAD_START) / (last.raw - LEAD_START);
      } else {
        shown = last.shown;
      }
      shown = Math.max(raw, Math.min(1, shown));
    }
    lead = { raw: raw, shown: shown, length: length };
    return shown;
  }

  function restOpacity() {
    var value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--reveal-xray-rest-opacity"));
    return isFinite(value) ? value : 0.3;
  }

  // The screen y (px) above which the x-ray is still hidden, for the wheel's
  // 3D rings on the hand (wipeTop()); null once fully open or out of the wheel view.
  var wipeTopPx = null;

  function showEnd() {
    wipeTopPx = null;
    lead = null;
    revealFrontier.style.bottom = "";
    revealXrayGroup.style.clipPath = "inset(0 0 0 0)";
    revealXrayGroup.style.opacity = String(restOpacity());
    revealNormal.style.clipPath = "inset(0 0 100% 0)";
    window.EmjiveHero.publishStage(1);
    // Far past any trigger: the selection bar is simply shown.
    window.EmjiveHero.publishScroll(1e6, true);
  }

  // The next updateReveal() also tells the wheel the layout changed (EmjiveHero.publishLayout).
  var layoutChanged = false;

  function updateReveal() {
    revealTicking = false;
    if (isSkipped() || awaitingEnd) {
      showEnd();
      announceLayout();
      return;
    }
    // Every layout and style read comes before the first write, so a frame
    // costs one layout: the x-ray group's box (setZoom() reuses it), the
    // section's shortfall and the rest opacity.
    var rect = revealSection.getBoundingClientRect();
    // Unclamped: keeps driving the selection bar past the pin's release.
    var rawScrolled = Math.max(0, -rect.top);
    // The wheel's entrance stretch (0 in the grid view).
    var entrancePx = revealEntrance ? revealEntrance.getBoundingClientRect().height : 0;
    // Against the pin's height (100vh), not innerHeight, which the phone's bars
    // change mid-scroll and would make the wipe jump.
    var pinHeight = revealPin ? revealPin.offsetHeight : window.innerHeight;
    var totalScroll = Math.max(0, rect.height - entrancePx - pinHeight);
    var scrolled = totalScroll > 0 ? Math.min(totalScroll, rawScrolled) : 0;

    // Phase 1: the band lifts by its own height to the pin's bottom edge.
    // Phase 2: the wipe, the band riding its boundary.
    var liftDistance = Math.min(revealFrontier.getBoundingClientRect().height, totalScroll);
    var headerHeight = siteHeader ? siteHeader.getBoundingClientRect().height : 0;
    // The page ends before the reveal by the phone's bar height (hero.css'
    // negative margin); the entrance ends there so it always completes.
    var shortfall = entrancePx > 0 ? Math.max(0, -(parseFloat(getComputedStyle(revealSection).marginBottom) || 0)) : 0;
    var rest = entrancePx > 0 ? restOpacity() : 0;
    var box = entrancePx > 0 ? layoutBox() : null;
    var wipeDistance = Math.max(totalScroll - liftDistance, 1);

    if (totalScroll <= 0 || scrolled <= liftDistance) {
      var liftFraction = liftDistance > 0 ? scrolled / liftDistance : 1;
      revealFrontier.style.bottom = "calc(" + (-(1 - liftFraction)) + " * var(--reveal-frontier-height))";
      revealXrayGroup.style.clipPath = "inset(100% 0 0 0)";
      revealNormal.style.clipPath = "inset(0 0 0 0)";
      wipeTopPx = box ? box.top + box.height : null;
    } else {
      var wipeProgress = Math.min(1, (scrolled - liftDistance) / wipeDistance);
      var revealedPct = wipeProgress * 100;
      revealFrontier.style.bottom = revealedPct + "%";
      // Complementary clips: the x-ray group reveals from the bottom up as the
      // photo is clipped away by the same amount.
      revealXrayGroup.style.clipPath = "inset(" + (100 - revealedPct) + "% 0 0 0)";
      revealNormal.style.clipPath = "inset(0 0 " + revealedPct + "% 0)";
      wipeTopPx = box && wipeProgress < 1 ? box.top + box.height * (1 - wipeProgress) : null;
    }

    // The selection bar enters from where the band passes behind the fixed
    // header, not at wipe end: the band's bottom sits at
    // innerHeight * (1 - wipeProgress), so it meets the header at
    // wipeProgress = 1 - headerHeight / innerHeight. Only the scroll distance is
    // published; js/selection-bar.js computes its own travel.
    var wipeProgressAtHeader = window.innerHeight > 0
      ? Math.max(0, 1 - headerHeight / window.innerHeight)
      : 1;
    var barTriggerScroll = liftDistance + wipeProgressAtHeader * wipeDistance;
    window.EmjiveHero.publishScroll(Math.max(0, rawScrolled - barTriggerScroll), totalScroll > 0);

    // Entrance progress (wheel view); without a stretch the reveal ends with the wipe.
    var entrance;
    if (entrancePx > 0) {
      var entranceLength = Math.max(1, entrancePx - shortfall);
      entrance = leadEntrance(Math.max(0, Math.min(1, (rawScrolled - totalScroll) / entranceLength)), entranceLength);
      if (entrance >= ENTRANCE_DONE) entrance = 1;
    } else {
      lead = null;
      entrance = totalScroll > 0 && rawScrolled >= totalScroll ? 1 : 0;
    }
    // Fades at the wheel's pace (EmjiveHero.mapStage holds it while the wheel rolls back).
    var faded = window.EmjiveHero.mapStage ? window.EmjiveHero.mapStage(entrance) : entrance;
    revealXrayGroup.style.opacity = entrancePx > 0
      ? String(1 - Math.min(1, faded / XRAY_FADE_END) * (1 - rest))
      : "";
    window.EmjiveHero.publishStage(entrance);
    announceLayout();
  }

  function announceLayout() {
    if (!layoutChanged) return;
    layoutChanged = false;
    if (window.EmjiveHero.publishLayout) window.EmjiveHero.publishLayout();
  }

  function requestRevealUpdate() {
    if (!revealTicking) {
      revealTicking = true;
      requestAnimationFrame(updateReveal);
    }
  }

  function layoutDidChange() {
    // Before init(), or without the fragment's elements, there is nothing to update.
    if (!revealNormal || !revealFrontier) return;
    layoutChanged = true;
    requestRevealUpdate();
  }

  // One .reveal__ring (its hand poster) per product with
  // hero-hand-visibility.visible, inside the x-ray group so it reveals with
  // the wipe, placed by inline --ring-* from that product. The wheel's 3D
  // scene draws over it once loaded and hides it. Always the full product
  // list: the rings are hero art, not a filtered listing.
  function updateHeroRings(products) {
    if (!revealXrayGroup) return;
    revealXrayGroup.querySelectorAll(".reveal__ring").forEach(function (existing) {
      existing.remove();
    });
    products.forEach(function (product) {
      var onHand = product["hero-hand-visibility"];
      if (!onHand || !onHand.visible) return;
      var handPoster = product.assets && product.assets["hand-poster"];
      if (!handPoster) return;
      var ring = document.createElement("img");
      ring.className = "reveal__ring";
      ring.alt = "";
      ring.decoding = "async";
      ring.src = handPoster;
      // Read back by rings() for the wheel.
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
    layoutDidChange();
  }

  // The x-ray group's laid-out box before any pull-back, plus the phone crop
  // (hero.css --hero-crop, --hero-crop-left). The last one measured is kept
  // for setZoom(), which runs right after updateReveal()'s writes.
  var lastBox = null;
  function layoutBox() {
    lastBox = measureBox();
    return lastBox;
  }

  function measureBox() {
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

  // A point given as % of the full picture, in screen px (crop applied like .reveal__ring).
  function pointOn(box, xPct, yPct) {
    return {
      x: box.left + box.width * ((xPct - box.cropLeft) / box.crop) / 100,
      y: box.top + box.height * yPct / 100
    };
  }

  function ringEls() {
    return revealXrayGroup ? revealXrayGroup.querySelectorAll(".reveal__ring") : [];
  }

  // hero.css has landed when the reveal is taller than its pin. Until then
  // (it can arrive last on a cold cache) nothing laid out is the hero's, and
  // orbit() and rings() report none.
  function styled() {
    return !!(revealSection && revealPin && revealSection.offsetHeight > revealPin.offsetHeight * 1.5);
  }

  window.EmjiveStudyHero = {
    init: function () {
      revealSection = document.getElementById("revealSection");
      revealXrayGroup = document.getElementById("revealXrayGroup");
      revealNormal = revealSection ? revealSection.querySelector(".reveal__img--normal") : null;
      revealFrontier = document.getElementById("revealFrontier");
      revealEntrance = revealSection ? revealSection.querySelector(".reveal__entrance") : null;
      revealPin = revealSection ? revealSection.querySelector(".reveal__pin") : null;
      // Fixed header, for the bar trigger in updateReveal().
      siteHeader = document.querySelector(".site-header");

      if (!revealSection || !revealXrayGroup || !revealNormal || !revealFrontier) return;

      window.addEventListener("scroll", requestRevealUpdate, { passive: true });
      window.addEventListener("resize", layoutDidChange);
      ["touchstart", "touchend", "touchcancel"].forEach(function (type) {
        window.addEventListener(type, function (e) { fingers = e.touches.length; }, { passive: true });
      });
      // Height changes without scroll or resize (hero.css landing late, the entrance
      // room), or a restored page keeps a stage measured on unstyled markup.
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(layoutDidChange).observe(revealSection);
      }
      layoutChanged = true;
      var memory = window.EmjiveScrollMemory;
      var landed = memory && memory.landing && memory.landing();
      var root = document.documentElement;
      awaitingEnd = !!(landed && landed.fresh && !(memory.isRestoring && memory.isRestoring()) &&
        root.getAttribute("data-hero") === "skip" && root.getAttribute("data-gallery-view") === "stack");
      updateReveal();
      if (awaitingEnd) landAtEnd();
    },

    onProducts: updateHeroRings,

    // For js/gallery-stack.js, which holds the arrival cover until the hero is laid out.
    isStyled: function () { return !revealSection || styled(); },
    refresh: function () { if (revealSection) updateReveal(); },
    wipeTop: function () { return wipeTopPx; },

    // The hand's rings for the wheel: [{ id, el, rotation, x, y, size }],
    // rotation in degrees, centre and unrotated width in screen px before any pull-back.
    rings: function () {
      if (!revealXrayGroup || !styled()) return [];
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

    // The wheel's circle round the wrist in screen px before any pull-back:
    // { x, y, r, top } (top: the fingertips' y). null without a styled hero.
    orbit: function () {
      if (!revealXrayGroup || !revealXrayGroup.offsetHeight || !styled()) return null;
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

    // Camera pull-back: scales the hand by `scale` about the wrist, moved by
    // (dx, dy) px. (1, 0, 0) is the laid-out hand.
    setZoom: function (scale, dx, dy) {
      if (!revealXrayGroup) return;
      if (scale === 1 && !dx && !dy) {
        revealXrayGroup.style.removeProperty("transform");
        revealXrayGroup.style.removeProperty("transform-origin");
        return;
      }
      var box = lastBox || layoutBox();
      // The wipe is over by now; a clip would cut off the arm below the group.
      revealXrayGroup.style.clipPath = "none";
      revealXrayGroup.style.transformOrigin = ((WRIST_X - box.cropLeft) / box.crop) + "% " + WRIST_Y + "%";
      revealXrayGroup.style.transform = "translateX(-50%) translate(" + dx.toFixed(2) + "px," + dy.toFixed(2) + "px) scale(" + scale.toFixed(5) + ")";
    },

    // Extra entrance length for the wheel to roll back to the hand, as a share of
    // the entrance; the published stage spans it.
    setEntranceRoom: function (share) {
      if (!revealSection) return;
      revealSection.style.setProperty("--reveal-entrance-room", String(share));
      requestRevealUpdate();
    },

    // data-hero / data-gallery-view just changed (js/gallery.js): reshape now,
    // not on the next scroll.
    setMode: function () {
      if (!revealSection) return;
      if (!isSkipped()) {
        revealXrayGroup.style.opacity = "";
      }
      updateReveal();
    }
  };
})();
