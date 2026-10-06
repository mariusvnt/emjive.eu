/* ==========================================================================
   em·ji·ve — drag carousel
   The filmstrip behind product.html's carousel and the Modify sheet's small
   one (js/modify-modal.js), so both move identically. No visible arrows:
   navigation is either a tap on a slide, which centers it, or a real drag —
   free on a wide screen, one slide per swipe on a phone. Slide DOM is the
   caller's business; this only moves the track.

   window.EmjiveCarousel(carouselEl) wires one .product-carousel (holding
   .product-carousel__viewport > .product-carousel__track) and returns
   { sync(reset), center(index), setLocked(locked) }. Call sync(true) once
   the slides are in place and measurable: it recounts them from the track
   and rests the strip on the first slide, centered. A resize re-clamps on
   its own. center() centres a slide as a tap would; setLocked(true) holds
   the strip where it is and ignores drags, taps and keys until unlocked.

   window.EmjiveCarousel.imageSlide(src, alt) builds a plain image slide.
   It lives here rather than with either caller because what it guards
   against (the browser's native image drag) is a drag concern.
   ========================================================================== */

(function (global) {
  "use strict";

  // Shared by every way a slide gets centered — tapping it directly, or a
  // phone-style paging drag settling onto it — so both read as the same
  // gesture language rather than two different animation feels. A
  // perfectly symmetric ease-in-out curve (control points mirrored around
  // the curve's own center: (0.4, 0) and its point-reflection (0.6, 1)) —
  // a real zero-velocity start easing into an equally gentle, symmetric
  // stop, rather than a front-loaded curve that reads as an abrupt jump
  // once it's covering a full tile's width.
  var CENTER_TRANSITION = "transform 0.25s cubic-bezier(0.4, 0, 0.6, 1)";
  // Same symmetric curve, shorter — used only when a phone drag cancels
  // a slide change (doesn't commit, so it settles back on the slide it
  // started on) rather than actually landing on a different one; see
  // settleDrag below.
  var CANCEL_TRANSITION = "transform 0.2s cubic-bezier(0.4, 0, 0.6, 1)";

  // Below this much pointer movement, a release counts as a tap (center
  // whichever slide it started on) rather than a drag — same threshold
  // js/main.js's wireModelClickNavigation uses for the equivalent
  // click-vs-drag problem on the 3D models. Doubles as the axis-lock slop
  // below, so there's a single "did this actually move" threshold rather
  // than two competing ones.
  var TAP_THRESHOLD = 6;

  // WebKit-style rubber-band damping for drag-past-the-bounds overshoot,
  // at either end — the further past a bound you drag, the harder it gets
  // to pull further, rather than tracking the pointer 1:1.
  function rubberBand(overshoot, dimension) {
    var c = 0.55;
    return (overshoot * dimension * c) / (dimension + c * overshoot);
  }

  // Same breakpoint css/style.css's .product-grid rule uses for its own
  // phone-vs-wide-screen switch — the only responsive threshold anywhere
  // on the site, reused here rather than inventing a second one.
  function isMobileCarousel() {
    return global.matchMedia("(max-width: 640px)").matches;
  }

  function createCarousel(carouselEl) {
    var viewport = carouselEl.querySelector(".product-carousel__viewport");
    var track = carouselEl.querySelector(".product-carousel__track");
    var slideCount = 0;
    var scrollOffset = 0;

    function measureTileWidth() {
      var first = track.firstElementChild;
      return first ? first.getBoundingClientRect().width : 0;
    }

    // Bounds are expressed as "the first/last tile centered in the
    // carousel", not "flush to an edge" or "hug to fit" — offset decreases
    // as later tiles get centered, so max (least scrolled) centers the
    // first tile and min (most scrolled) centers the last one. This holds
    // even when the whole filmstrip would technically fit within the
    // available width (max > min: still a real, non-zero scroll range) —
    // the carousel always rests on the first tile centered and stays
    // scrollable through the rest, rather than collapsing to a static
    // "show everything" layout once there's enough room.
    function computeBounds() {
      var availableWidth = carouselEl.getBoundingClientRect().width;
      var tile = measureTileWidth();
      var max = (availableWidth - tile) / 2;
      var min = max - (slideCount - 1) * tile;
      return { min: min, max: max, width: availableWidth };
    }

    // transition, when given, overrides the default snap — see
    // CENTER_TRANSITION above, the sole caller that does.
    function applyOffset(offsetPx, animate, transition) {
      track.style.transition = animate ? (transition || "transform 0.25s cubic-bezier(0.4, 0, 0.6, 1)") : "none";
      track.style.transform = "translateX(" + offsetPx + "px)";
      scrollOffset = offsetPx;
    }

    // reset (true right after the slides were (re)built) snaps to the
    // starting position (first tile centered). Otherwise (on resize) the
    // current position is re-clamped into the new bounds instead — resizing
    // changes tile size (and thus the scroll range) without any re-render.
    // Recounts first either way, so a caller never has to report its
    // slide count separately.
    function sync(reset) {
      slideCount = track.children.length;
      if (slideCount === 0) return;
      var bounds = computeBounds();
      var target = reset ? bounds.max : Math.max(bounds.min, Math.min(bounds.max, scrollOffset));
      // Locked, the strip stays on its slide however the tiles resize.
      if (locked && !reset) target = Math.max(bounds.min, bounds.max - lockedIndex * measureTileWidth());
      applyOffset(target, false);
    }

    // setLocked(true): the strip stops responding to drags, taps and keys
    // and holds the slide it's on (the product page's specs stage, which is
    // about the model alone). The caller centres the slide it wants first.
    var locked = false;
    var lockedIndex = 0;
    function currentIndex() {
      var tile = measureTileWidth();
      return tile ? Math.max(0, Math.round((computeBounds().max - scrollOffset) / tile)) : 0;
    }
    function setLocked(lock) {
      lock = !!lock;
      if (lock === locked) return;
      locked = lock;
      carouselEl.classList.toggle("is-locked", lock);
      if (!lock) return;
      lockedIndex = currentIndex();
      // A drag under way when the lock lands just ends where it is.
      if (trackedPointerId !== null) {
        trackedPointerId = null;
        if (dragging) {
          dragging = false;
          centerOnSlide(lockedIndex);
        }
      }
    }

    // Centers a given slide — either a direct tap on it, or where a phone's
    // paging drag settles — jumping straight there however far from center
    // it started, not a step-by-one-tile page. index 0 centers the first
    // tile (offset bounds.max), the last index centers the last tile
    // (bounds.min), same mapping computeBounds' own comment describes.
    // CENTER_TRANSITION by default, so every way a slide gets centered
    // moves identically — transition overrides that (see
    // CANCEL_TRANSITION's use in settleDrag, the sole caller that does).
    function centerOnSlide(index, transition) {
      if (slideCount <= 1) return;
      var bounds = computeBounds();
      var tile = measureTileWidth();
      var target = Math.max(bounds.min, Math.min(bounds.max, bounds.max - index * tile));
      applyOffset(target, true, transition || CENTER_TRANSITION);
    }

    // Otherwise a mouse drag starting on a photo kicks off the browser's
    // own native image-drag-and-drop gesture (desktop only — touch drags
    // don't trigger it), which fights with the custom pointer-drag scroll
    // below. img.draggable = false (set in imageSlide) covers real <img>
    // slides; this covers anything else a browser might still try to drag
    // (e.g. the 3D viewer's poster image while it's loading).
    viewport.addEventListener("dragstart", function (e) { e.preventDefault(); });

    var dragging = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var dragStartOffset = 0;
    var dragBounds = null;
    // The slide the pointer actually landed on at dragStart (from that
    // event's own target, before pointer capture below starts pinning
    // every subsequent event's target to the track) — used by endDrag to
    // know which slide to center on a tap.
    var dragStartSlide = null;
    // Which pointer (if any) is currently being tracked from pointerdown
    // through its eventual pointerup/cancel — including the ambiguous
    // window right after pointerdown, before axisLocked below is decided.
    var trackedPointerId = null;
    // Set the moment a tracked pointer's movement first exceeds
    // TAP_THRESHOLD on either axis: true if it turned out horizontal
    // (dragging becomes true, the carousel takes over), false if vertical
    // (handed off untouched to the browser's own touch-action: pan-y
    // scroll — see .product-carousel__viewport). Stays null while still
    // ambiguous, so a real tap (which never crosses the slop at all)
    // never has to pick an axis.
    var axisLocked = null;
    // Recent drag speed (px/ms), exponentially smoothed frame to frame so
    // a single jittery pointermove right before release doesn't dominate
    // it — used to tell a deliberate flick from a slow drag in settleDrag.
    var dragLastX = 0;
    var dragLastT = 0;
    var dragVelocity = 0;

    function onPointerDown(e) {
      // A drag that starts on the 3D model slide should rotate the model
      // (the viewer's own TrackballControls, js/three-viewer.js), not page
      // the carousel.
      if (locked || slideCount <= 1 || e.target.closest(".emjive-3d-viewer")) return;
      dragBounds = computeBounds();
      trackedPointerId = e.pointerId;
      axisLocked = null;
      dragStartSlide = e.target.closest(".product-carousel__slide");
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOffset = scrollOffset;
      dragLastX = e.clientX;
      dragLastT = e.timeStamp;
      dragVelocity = 0;
      // Deliberately no setPointerCapture/dragging=true/applyOffset here
      // yet — which axis this gesture is on isn't known until it clears
      // TAP_THRESHOLD in onPointerMove below. Committing to the carousel
      // this early used to mean a touch that turned out to be a vertical
      // scroll still nudged the filmstrip sideways on its natural
      // diagonal wobble before the browser recognized the scroll,
      // fighting the page's own touch-action: pan-y the whole time.
    }

    function onPointerMove(e) {
      if (e.pointerId !== trackedPointerId) return;
      var dx = e.clientX - dragStartX;
      var dy = e.clientY - dragStartY;

      if (axisLocked === null) {
        if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) return; // still ambiguous
        axisLocked = Math.abs(dx) > Math.abs(dy);
        if (!axisLocked) {
          // Vertical — hand off to the browser's native pan-y scroll and
          // stop tracking this pointer entirely; nothing here has
          // touched the carousel yet, so there's nothing to undo.
          trackedPointerId = null;
          return;
        }
        dragging = true;
        applyOffset(scrollOffset, false); // kill any in-flight transition
        // On the track, not the viewport: the Modify sheet lets taps on
        // the viewport's empty space fall through to its backdrop (see
        // .size-modal__carousel in css/style.css), and the track is
        // exactly the slides. Captured events still bubble up to the
        // viewport listeners below either way.
        track.setPointerCapture(e.pointerId);
      }
      if (!dragging) return;

      var raw = dragStartOffset + dx;
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
      var wasDragging = dragging;
      dragging = false;
      if (!wasDragging) {
        // Never crossed the axis-lock slop in onPointerMove — a tap, not
        // a drag. (If it turned out vertical instead, onPointerMove
        // already cleared trackedPointerId itself and this function
        // returned above before ever reaching here — nothing to do,
        // since the carousel never touched the track for that gesture.)
        // Any sub-threshold jitter was never applied in the first place
        // (onPointerMove returns early until the slop is cleared), so
        // there's nothing to snap back from — just center whichever
        // slide it landed on.
        if (dragStartSlide) centerOnSlide(Array.prototype.indexOf.call(track.children, dragStartSlide));
        return;
      }
      settleDrag(e);
    }

    // A pointercancel means the browser interrupted this pointer's normal
    // processing itself — most commonly a vertical scroll on a phone:
    // touch-action: pan-y lets the browser take that over natively, and
    // it can send the cancel before our own onPointerMove ever sees
    // enough movement to axis-lock (a fast vertical swipe is recognized
    // and handed to native scrolling almost immediately). That used to
    // reach endDrag with dragging still false, which read as "a tap" and
    // centered whatever slide the touch started on — including jumping
    // to it from wherever the strip currently was, if that slide wasn't
    // the one already centered. A cancel should never be read as a tap:
    // it's specifically the "this wasn't a deliberate pointer gesture on
    // this element" signal, so an unresolved one is a pure no-op here.
    function onPointerCancel(e) {
      if (e.pointerId !== trackedPointerId) return;
      trackedPointerId = null;
      var wasDragging = dragging;
      dragging = false;
      if (!wasDragging) return;
      // Did commit to a horizontal drag before being interrupted — settle
      // it same as a real release, except by the strip's own current
      // (already live-updated) position rather than this event's
      // coordinates, which a cancel doesn't reliably carry.
      settleDrag(null);
    }

    // Shared release-settling for a real horizontal drag, whether it
    // ended in a clean pointerup (e is that event, used for the mobile
    // page's direction/distance) or was interrupted mid-drag (e is null —
    // see onPointerCancel above, which settles by position instead).
    function settleDrag(e) {
      if (isMobileCarousel()) {
        var tile = measureTileWidth();
        var startIndex = Math.round((dragBounds.max - dragStartOffset) / tile);
        var direction = 0;
        if (e) {
          // A real drag on a phone always resolves to exactly one slide
          // step, centered — never free-floating between two slides the
          // way a wide-screen drag can. Commits to the next/previous
          // slide (whichever direction it was dragged) only past a real
          // distance or a fast-enough flick; short/slow drags spring
          // back to the slide they started on, same as a cancelled swipe
          // would.
          var dx = e.clientX - dragStartX;
          var absDx = Math.abs(dx);
          var COMMIT_FRACTION = 0.15; // of a tile's width
          // A short drag can still smooth out to a spuriously high
          // velocity from raw touch-event jitter (coalesced touchmove
          // samples a few sub-16ms apart) — MIN_FLICK_DISTANCE stops
          // that noise from reading as a deliberate flick on what's
          // really just a tiny, unsteady scroll, which was paging a full
          // slide on barely any movement.
          var MIN_FLICK_DISTANCE = 18; // px
          var FLICK_VELOCITY = 0.6; // px/ms
          var committed = absDx > tile * COMMIT_FRACTION || (absDx > MIN_FLICK_DISTANCE && Math.abs(dragVelocity) > FLICK_VELOCITY);
          direction = committed ? (dx < 0 ? 1 : -1) : 0;
        }
        // No event to read a direction from (an interruption) — nearest
        // slide by the strip's own current position instead.
        var index = e ? startIndex + direction : Math.round((dragBounds.max - scrollOffset) / tile);
        index = Math.max(0, Math.min(slideCount - 1, index));
        // Landing back on the same slide it started on means the drag
        // cancelled the slide change rather than committing to one —
        // shorter transition for that spring-back than an actual change
        // to a different slide gets.
        centerOnSlide(index, index === startIndex ? CANCEL_TRANSITION : undefined);
      } else {
        // Free positioning: lands exactly where the drag left it, no
        // momentum coast — just clamped back into bounds, which also
        // springs it back if it was rubber-banded past either end.
        var target = Math.max(dragBounds.min, Math.min(dragBounds.max, scrollOffset));
        applyOffset(target, true);
      }
    }

    // Keyboard: the viewport is a focus stop and the arrow keys (Home/End to
    // jump) page through the slides, using the same centring a tap does.
    // Dragging and tapping were pointer-only, which left every slide after the
    // first unreachable without a mouse or touch. Nothing is drawn for it —
    // the strip simply moves, and the page's focus ring marks the stop.
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

    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", onPointerCancel);

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
      // Centres slide `index`, with the same transition a tap uses.
      center: function (index) { centerOnSlide(index); },
      setLocked: setLocked
    };
  }

  // A plain full-bleed image slide. img.draggable = false because otherwise
  // dragging a photo on desktop kicks off the browser's native
  // image-drag-and-drop gesture instead of (or fighting with) the custom
  // pointer-drag above — the viewport's dragstart guard is the rest of
  // that fix.
  //
  // opts.deferred: true builds the slide without starting the download. The
  // product page uses it for the photos, which sit off screen and must not
  // compete with the image the page's first paint is waiting on; the caller
  // starts them with slide.loadImage() once that has arrived. The slide's
  // loader waits for that too, so it still covers the box until the photo is in.
  //
  // opts.loaderHost: the element whose shared loader this slide's wait goes
  // through, instead of a loader of the slide's own (see below).
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
    // A loader over the slide until the photo has loaded, then the photo
    // fades in (js/loader.js). Every slide is a fixed square, so this
    // crosses exactly the slide's own box.
    //
    // opts.loaderHost: a loader shared by the whole strip instead — the
    // product page's, which is mounted on the carousel and also carries the
    // 3D model's wait. The slide then holds it only while it is on screen and
    // loading, and the photo fades in the moment it has loaded, whether or not
    // that loader is still crossing (see coverWithin in js/loader.js).
    if (global.EmjiveLoader) {
      if (opts && opts.loaderHost) global.EmjiveLoader.coverWithin(opts.loaderHost, slide, ready);
      else global.EmjiveLoader.cover(slide, ready);
    }
    return slide;
  }

  createCarousel.imageSlide = imageSlide;
  global.EmjiveCarousel = createCarousel;
})(window);
