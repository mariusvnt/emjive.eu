// Drag carousel for product.html and the Modify sheet. No arrows: a tap
// centres a slide; a drag moves freely on wide screens, one slide per swipe
// on phones. Slide DOM is the caller's; this only moves the track.
//
// window.EmjiveCarousel(carouselEl, { dragScroll }) wires a .product-carousel
// (.product-carousel__viewport > .product-carousel__track) and returns
// { sync(reset), center(index), goHome(), awayFromHome(), setLocked(locked) }.
//   sync(true)       recount slides and rest on the first, centred (call once measurable)
//   goHome()         back to the first slide, gently
//   awayFromHome()   distance from it, in slides (0..1)
//   setLocked(true)  hold the strip and ignore drags, taps and keys
//
// Drags are read on the frame (.product-carousel-frame), within the strip's
// band, so overlays can't swallow them. The first few pixels lock the axis:
// within 45° of horizontal it pages; vertical (with dragScroll) scrolls the
// page, natively for touch (touch-action: pan-y; scripted scrolling fought
// the sticky stage on iOS) and scripted with a glide for mouse and pen. A
// press inside the 3D model's circle (.emjive-3d-viewer__hit) is the model's.
// With dragScroll the frame also gets --paged and .is-paged (publishPaged).
//
// window.EmjiveCarousel.imageSlide(src, alt, opts) builds an image slide.

(function (global) {
  "use strict";

  // Every way of centring a slide (tap, phone swipe) shares one symmetric ease-in-out.
  var CENTER_TRANSITION = "transform 0.25s cubic-bezier(0.4, 0, 0.6, 1)";
  // Shorter, for a phone swipe that springs back to its own slide (settleDrag).
  var CANCEL_TRANSITION = "transform 0.2s cubic-bezier(0.4, 0, 0.6, 1)";
  // Gentler, for goHome(), which runs while the page scrolls.
  var HOME_TRANSITION = "transform 0.5s cubic-bezier(0.4, 0, 0.6, 1)";

  // Tiles paged from the first slide at which --paged reaches 1.
  var PAGED_SPAN = 0.3;

  // Below this movement a release is a tap; also the axis-lock threshold.
  var TAP_THRESHOLD = 6;

  // Touch drags move the strip at this ratio (a heavier feel); mouse and pen 1:1.
  var TOUCH_GAIN = 0.7;

  // WebKit-style rubber-band resistance past either end.
  function rubberBand(overshoot, dimension) {
    var c = 0.55;
    return (overshoot * dimension * c) / (dimension + c * overshoot);
  }

  // Same breakpoint as css/style.css's phone rules.
  function isMobileCarousel() {
    return global.matchMedia("(max-width: 640px)").matches;
  }

  // A press on one of these is theirs, not a drag's.
  var INTERACTIVE = "button, a, input, select, textarea, label, summary, [role=slider]";
  // A flick's glide: e-folding time (ms) and end speed (px/ms).
  var GLIDE_TAU = 350;
  var GLIDE_MIN = 0.02;

  function createCarousel(carouselEl, options) {
    var dragScroll = !!(options && options.dragScroll);
    var viewport = carouselEl.querySelector(".product-carousel__viewport");
    var track = carouselEl.querySelector(".product-carousel__track");
    // Drags are read on the surrounding frame if there is one, else the strip.
    var host = carouselEl.closest(".product-carousel-frame") || viewport;
    var slideCount = 0;
    var scrollOffset = 0;

    function measureTileWidth() {
      var first = track.firstElementChild;
      return first ? first.getBoundingClientRect().width : 0;
    }

    // Bounds centre the first tile (max) and the last (min). The range stays
    // scrollable even when every tile would fit.
    function computeBounds() {
      var availableWidth = carouselEl.getBoundingClientRect().width;
      var tile = measureTileWidth();
      var max = (availableWidth - tile) / 2;
      var min = max - (slideCount - 1) * tile;
      return { min: min, max: max, width: availableWidth };
    }

    // `transition` overrides CENTER_TRANSITION.
    function applyOffset(offsetPx, animate, transition) {
      var move = animate ? (transition || CENTER_TRANSITION) : "none";
      track.style.transition = move;
      track.style.transform = "translateX(" + offsetPx + "px)";
      scrollOffset = offsetPx;
      // While locked, what was paged away stays away until setLocked(false) republishes.
      if (dragScroll && host !== viewport && !locked) publishPaged(offsetPx, animate ? move.slice("transform ".length) : "");
    }

    // --paged-px and --paged (0..1, 1 at PAGED_SPAN of a tile) on the frame, tweened
    // with the strip (registered properties in css/style.css) so the metal picker
    // moves in step. .is-paged: far enough that faded controls shouldn't take taps.
    function publishPaged(offsetPx, timing) {
      var tile = measureTileWidth();
      var px = tile ? Math.max(0, computeBounds().max - offsetPx) : 0;
      var paged = tile ? Math.min(1, px / (tile * PAGED_SPAN)) : 0;
      host.style.transition = timing ? "--paged " + timing + ", --paged-px " + timing : "none";
      host.style.setProperty("--paged", paged.toFixed(4));
      host.style.setProperty("--paged-px", px.toFixed(1) + "px");
      host.classList.toggle("is-paged", paged > 0.5);
    }

    // reset: rest on the first tile (after a rebuild). Otherwise re-clamp the
    // current offset into the new bounds (resize). Recounts slides either way.
    function sync(reset) {
      slideCount = track.children.length;
      if (slideCount === 0) return;
      var bounds = computeBounds();
      var target = reset ? bounds.max : Math.max(bounds.min, Math.min(bounds.max, scrollOffset));
      // Locked, it stays home whatever the resize.
      if (locked && !reset) target = bounds.max;
      applyOffset(target, false);
    }

    // Locked: no drags, taps or keys (the product page's model stages). The caller goHome()s first.
    var locked = false;
    function setLocked(lock) {
      lock = !!lock;
      if (lock === locked) return;
      locked = lock;
      carouselEl.classList.toggle("is-locked", lock);
      if (!lock && dragScroll && host !== viewport) publishPaged(scrollOffset, CENTER_TRANSITION.slice("transform ".length));
      // A sideways drag under way just ends; a scroll gesture is unaffected.
      if (lock && dragging) {
        dragging = false;
        trackedPointerId = null;
      }
    }

    // Distance from the first slide centred, in slides, at most 1.
    function awayFromHome() {
      var tile = measureTileWidth();
      if (!tile) return 0;
      return Math.min(1, Math.abs(computeBounds().max - scrollOffset) / tile);
    }

    // Centres slide `index` directly, however far away.
    function centerOnSlide(index, transition) {
      if (slideCount <= 1) return;
      var bounds = computeBounds();
      var tile = measureTileWidth();
      var target = Math.max(bounds.min, Math.min(bounds.max, bounds.max - index * tile));
      applyOffset(target, true, transition || CENTER_TRANSITION);
    }

    // Blocks the native image drag on desktop, which would fight the pointer drag
    // (img.draggable covers <img> slides; this covers the rest, like a viewer's poster).
    viewport.addEventListener("dragstart", function (e) { e.preventDefault(); });

    var dragging = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var dragStartOffset = 0;
    var dragBounds = null;
    // The slide pressed, read before pointer capture retargets events; centred on a tap.
    var dragStartSlide = null;
    // The pointer tracked from pointerdown to up/cancel, including before the axis is known.
    var trackedPointerId = null;
    // Set once movement passes TAP_THRESHOLD: true horizontal (the carousel drags),
    // false vertical (scripted page scroll for mouse/pen with dragScroll, else the
    // browser's pan-y). null while ambiguous, so a tap never picks an axis.
    var axisLocked = null;
    // Smoothed drag speed (px/ms), so one jittery move before release doesn't count as a flick.
    var dragLastX = 0;
    var dragLastT = 0;
    var dragVelocity = 0;
    var dragGain = 1;
    // A vertical gesture scrolling the page (dragScroll): last position, time and
    // speed, and the glide after it.
    var scrolling = false;
    var scrollLastY = 0;
    var scrollLastT = 0;
    var scrollVelocity = 0;
    var glideFrame = 0;
    var glideSpeed = 0;
    var glideTime = 0;

    // The slide under a point by geometry (overlays don't matter), else the target's.
    function slideAt(e) {
      var stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
      for (var i = 0; i < stack.length; i++) {
        if (stack[i].classList && stack[i].classList.contains("product-carousel__slide") && track.contains(stack[i])) return stack[i];
      }
      return e.target.closest(".product-carousel__slide");
    }

    // A press is ours unless on a control, on the model (its circle, or a whole
    // viewer without one), or outside the strip's band.
    function isOurs(e) {
      if (e.isPrimary === false) return false;
      if (e.pointerType === "mouse" && e.button !== 0) return false;
      if (locked && !dragScroll) return false;
      if (slideCount <= 1 && !dragScroll) return false;
      var target = e.target;
      if (!target || !target.closest) return false;
      if (target.closest(INTERACTIVE)) return false;
      var viewer = target.closest(".emjive-3d-viewer");
      if (viewer && (!viewer.classList.contains("has-hit-circle") || target.closest(".emjive-3d-viewer__hit"))) return false;
      if (host !== viewport) {
        var band = viewport.getBoundingClientRect();
        if (e.clientY < band.top || e.clientY > band.bottom) return false;
      }
      return true;
    }

    function stopGlide() {
      if (glideFrame) cancelAnimationFrame(glideFrame);
      glideFrame = 0;
    }
    function glideStep(now) {
      var dt = Math.min(now - glideTime, 50);
      glideTime = now;
      var before = window.pageYOffset;
      window.scrollBy({ top: glideSpeed * dt, left: 0, behavior: "instant" });
      glideSpeed *= Math.exp(-dt / GLIDE_TAU);
      if (Math.abs(glideSpeed) < GLIDE_MIN || window.pageYOffset === before) {
        glideFrame = 0;
        return;
      }
      glideFrame = requestAnimationFrame(glideStep);
    }
    function startGlide(speed) {
      if (Math.abs(speed) < GLIDE_MIN * 4 || global.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      glideSpeed = speed;
      glideTime = performance.now();
      glideFrame = requestAnimationFrame(glideStep);
    }
    // Any other page movement stops a glide.
    global.addEventListener("wheel", stopGlide, { passive: true });
    global.addEventListener("pointerdown", stopGlide, { passive: true });

    function onPointerDown(e) {
      if (!isOurs(e)) return;
      dragBounds = computeBounds();
      trackedPointerId = e.pointerId;
      axisLocked = null;
      scrolling = false;
      dragGain = e.pointerType === "touch" ? TOUCH_GAIN : 1;
      dragStartSlide = slideAt(e);
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffset = scrollOffset;
      dragLastX = e.clientX;
      dragLastT = e.timeStamp;
      dragVelocity = 0;
      // Nothing is committed until the axis is known (onPointerMove), so a vertical
      // scroll never nudges the strip sideways.
    }

    function onPointerMove(e) {
      if (e.pointerId !== trackedPointerId) return;
      var dx = e.clientX - dragStartX;
      var dy = e.clientY - dragStartY;

      if (axisLocked === null) {
        if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) return; // still ambiguous
        // Within 45° of horizontal is horizontal.
        axisLocked = Math.abs(dx) > Math.abs(dy);
        if (!axisLocked) {
          if (!dragScroll || e.pointerType === "touch") {
            // Vertical with the browser scrolling (touch, or no dragScroll): stop tracking.
            trackedPointerId = null;
            return;
          }
          // Vertical: scroll the page from where the press began.
          scrolling = true;
          scrollLastY = dragStartY;
          scrollLastT = e.timeStamp;
          scrollVelocity = 0;
          try { host.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is already gone */ }
        } else if (locked || slideCount <= 1) {
          // Sideways with nothing to page: dropped.
          trackedPointerId = null;
          return;
        } else {
          dragging = true;
          applyOffset(scrollOffset, false); // kill any in-flight transition
          // Captured on the track, not the viewport: the Modify sheet lets taps on the
          // viewport's empty space reach its backdrop.
          track.setPointerCapture(e.pointerId);
        }
      }
      if (scrolling) {
        var step = scrollLastY - e.clientY;
        window.scrollBy({ top: step, left: 0, behavior: "instant" });
        var elapsed = e.timeStamp - scrollLastT;
        if (elapsed > 0) scrollVelocity = scrollVelocity * 0.7 + (step / elapsed) * 0.3;
        scrollLastY = e.clientY;
        scrollLastT = e.timeStamp;
        return;
      }
      if (!dragging) return;

      var raw = dragStartOffset + dx * dragGain;
      var next;
      if (raw > dragBounds.max) {
        var startOvershoot = raw - dragBounds.max;
        next = dragBounds.max + rubberBand(startOvershoot, dragBounds.width);
      } else if (raw < dragBounds.min) {
        var endOvershoot = dragBounds.min - raw;
        next = dragBounds.min - rubberBand(endOvershoot, dragBounds.width);
      } else {
        next = raw;
      }
      applyOffset(next, false);

      var dt = e.timeStamp - dragLastT;
      if (dt > 0) {
        var instantVelocity = (e.clientX - dragLastX) / dt;
        dragVelocity = dragVelocity * 0.7 + instantVelocity * 0.3;
      }
      dragLastX = e.clientX;
      dragLastT = e.timeStamp;
    }

    function endDrag(e) {
      if (e.pointerId !== trackedPointerId) return;
      trackedPointerId = null;
      if (scrolling) {
        scrolling = false;
        // A flick glides on; a pointer that stopped first doesn't.
        startGlide(e.timeStamp - scrollLastT < 80 ? scrollVelocity : 0);
        return;
      }
      var wasDragging = dragging;
      dragging = false;
      if (!wasDragging) {
        // Never passed the threshold: a tap. Centre the slide it landed on.
        if (dragStartSlide && !locked) centerOnSlide(Array.prototype.indexOf.call(track.children, dragStartSlide));
        return;
      }
      settleDrag(e);
    }

    // A cancel (typically the browser taking a vertical scroll before the axis
    // locked) is never a tap: unresolved, it does nothing.
    function onPointerCancel(e) {
      if (e.pointerId !== trackedPointerId) return;
      trackedPointerId = null;
      scrolling = false;
      var wasDragging = dragging;
      dragging = false;
      if (!wasDragging) return;
      // A committed horizontal drag interrupted: settle by the strip's position
      // (a cancel's coordinates aren't reliable).
      settleDrag(null);
    }

    // Settles a horizontal drag: e is the pointerup, or null after a cancel.
    function settleDrag(e) {
      if (isMobileCarousel()) {
        var tile = measureTileWidth();
        var startIndex = Math.round((dragBounds.max - dragStartOffset) / tile);
        var direction = 0;
        if (e) {
          // On a phone a drag always lands on one slide: the next or previous past a
          // distance or a fast flick, else back where it started.
          var dx = e.clientX - dragStartX;
          var absDx = Math.abs(dx);
          var COMMIT_FRACTION = 0.15; // of a tile's width
          // Touch jitter can fake a high velocity on a tiny drag; a flick also needs this distance.
          var MIN_FLICK_DISTANCE = 18; // px
          var FLICK_VELOCITY = 0.6; // px/ms
          var committed = absDx > tile * COMMIT_FRACTION || (absDx > MIN_FLICK_DISTANCE && Math.abs(dragVelocity) > FLICK_VELOCITY);
          direction = committed ? (dx < 0 ? 1 : -1) : 0;
        }
        // After a cancel: the slide nearest the strip's position.
        var index = e ? startIndex + direction : Math.round((dragBounds.max - scrollOffset) / tile);
        index = Math.max(0, Math.min(slideCount - 1, index));
        // Back on its own slide: the shorter spring-back.
        centerOnSlide(index, index === startIndex ? CANCEL_TRANSITION : undefined);
      } else {
        // Wide screens: rest where released, clamped (springing back from a rubber-band).
        var target = Math.max(dragBounds.min, Math.min(dragBounds.max, scrollOffset));
        applyOffset(target, true);
      }
    }

    // Keyboard: the viewport is a focus stop; arrows page, Home/End jump.
    viewport.setAttribute("tabindex", "0");
    viewport.setAttribute("role", "group");
    viewport.setAttribute("aria-roledescription", "carousel");
    viewport.setAttribute("aria-label", "Product images");
    viewport.addEventListener("keydown", function (e) {
      var keys = { ArrowLeft: -1, ArrowRight: 1, Home: "first", End: "last" };
      if (locked || !(e.key in keys) || slideCount <= 1) return;
      var tile = measureTileWidth();
      if (!tile) return;
      var current = Math.round((computeBounds().max - scrollOffset) / tile);
      var step = keys[e.key];
      var next = step === "first" ? 0 : step === "last" ? slideCount - 1 : current + step;
      e.preventDefault();
      centerOnSlide(Math.max(0, Math.min(slideCount - 1, next)));
    });

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", endDrag);
    host.addEventListener("pointercancel", onPointerCancel);

    var resizeTicking = false;
    global.addEventListener("resize", function () {
      if (resizeTicking) return;
      resizeTicking = true;
      requestAnimationFrame(function () {
        resizeTicking = false;
        sync(false);
      });
    });

    return {
      sync: sync,
      // Centres slide `index` as a tap would.
      center: function (index) { centerOnSlide(index); },
      goHome: function () { centerOnSlide(0, HOME_TRANSITION); },
      awayFromHome: awayFromHome,
      setLocked: setLocked
    };
  }

  // An image slide. img.draggable = false: see the viewport's dragstart guard.
  // opts.deferred: built without downloading; the caller starts it with
  // slide.loadImage() (the product page's off-screen photos must not compete
  // with the first paint). opts.loaderHost: use that element's shared loader.
  function imageSlide(src, alt, opts) {
    var slide = document.createElement("div");
    slide.className = "product-carousel__slide";
    var img = document.createElement("img");
    img.alt = alt || "";
    img.loading = "lazy";
    img.draggable = false;
    slide.appendChild(img);

    var ready;
    if (opts && opts.deferred) {
      ready = new Promise(function (resolve) {
        slide.loadImage = function () {
          if (!img.getAttribute("src")) {
            img.src = src;
            if (global.EmjiveLoader) global.EmjiveLoader.imageReady(img).then(resolve);
            else resolve();
          }
        };
      });
    } else {
      img.src = src;
      ready = global.EmjiveLoader ? global.EmjiveLoader.imageReady(img) : null;
    }
    // A loader covers the slide until the photo loads, then it fades in. With
    // opts.loaderHost the strip's shared loader counts this wait only while the
    // slide is on screen, and the photo fades in as soon as it loads (coverWithin).
    if (global.EmjiveLoader) {
      if (opts && opts.loaderHost) global.EmjiveLoader.coverWithin(opts.loaderHost, slide, ready);
      else global.EmjiveLoader.cover(slide, ready);
    }
    return slide;
  }

  createCarousel.imageSlide = imageSlide;
  global.EmjiveCarousel = createCarousel;
})(window);
