/* ==========================================================================
   em·ji·ve — drag carousel
   The filmstrip behind product.html's carousel and the Modify sheet's small
   one (js/modify-modal.js), so both move identically. No visible arrows:
   navigation is either a tap on a slide, which centers it, or a real drag —
   free on a wide screen, one slide per swipe on a phone. Slide DOM is the
   caller's business; this only moves the track.

   window.EmjiveCarousel(carouselEl, { dragScroll }) wires one .product-carousel
   (holding .product-carousel__viewport > .product-carousel__track) and returns
   { sync(reset), center(index), goHome(), awayFromHome(), setLocked(locked) }.

   Every drag is read here, mouse, pen and touch alike, on the carousel's frame
   (.product-carousel-frame, which holds the carousel and whatever is laid over
   it) rather than on the strip alone, so nothing stacked over the strip can
   hide one; the strip's own band of the frame is what counts. Whichever axis
   the movement is nearer to, from its first few pixels, is the gesture's for
   good: within 45° of horizontal it pages the strip, within 45° of vertical
   (with dragScroll, the product page's) it scrolls the page. By touch that
   scroll is the browser's own (touch-action: pan-y on the strip: a scripted
   one fought the compositor's sticky stage on iOS Safari); with a mouse or a
   pen, which have no native drag scroll, it is scripted, grab-style, and
   glides on after a flick. The 3D model has the one exception: a press inside
   its circle (.emjive-3d-viewer__hit, js/three-viewer.js) is the model's, and
   a press anywhere else is this. Call sync(true) once
   the slides are in place and measurable: it recounts them from the track
   and rests the strip on the first slide, centered. A resize re-clamps on
   its own. center() centres a slide as a tap would; goHome() takes the strip
   back to its first slide, more gently; awayFromHome() says how far it is (0 to
   1, in slides); setLocked(true) holds the strip where it is and ignores drags,
   taps and keys until unlocked. With dragScroll, the frame is also told how far
   the strip is paged on (--paged, 0 to 1, and .is-paged) — see publishPaged.

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
  // The strip's way home when the page takes it there (goHome): gentler than a
  // tap's, as it runs while the page is being scrolled — a short glide over
  // that reads as a snap, all the more where a frame or two get dropped.
  var HOME_TRANSITION = "transform 0.5s cubic-bezier(0.4, 0, 0.6, 1)";

  // How far, in tiles, the strip has to be paged on from the first slide for
  // --paged to reach 1 (see publishPaged).
  var PAGED_SPAN = 0.3;

  // Below this much pointer movement, a release counts as a tap (center
  // whichever slide it started on) rather than a drag — same threshold
  // js/main.js's wireModelClickNavigation uses for the equivalent
  // click-vs-drag problem on the 3D models. Doubles as the axis-lock slop
  // below, so there's a single "did this actually move" threshold rather
  // than two competing ones.
  var TAP_THRESHOLD = 6;

  // How far the strip moves for each pixel a finger does sideways: less than
  // one, so a swipe reads as heavier and it takes a longer sweep to cross a
  // tile (the phone's paging goes by the finger's own distance, not this). A
  // mouse or a pen is 1:1.
  var TOUCH_GAIN = 0.7;

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

  // A press on one of these is theirs, not a drag's.
  var INTERACTIVE = "button, a, input, select, textarea, label, summary, [role=slider]";
  // How long a flick's glide takes to lose most of its speed (e-folding time,
  // ms), and the speed below which it ends (px/ms).
  var GLIDE_TAU = 350;
  var GLIDE_MIN = 0.02;

  function createCarousel(carouselEl, options) {
    var dragScroll = !!(options && options.dragScroll);
    var viewport = carouselEl.querySelector(".product-carousel__viewport");
    var track = carouselEl.querySelector(".product-carousel__track");
    // Where the drags are read: the frame around the carousel when it has
    // one (the product page's), else the strip itself.
    var host = carouselEl.closest(".product-carousel-frame") || viewport;
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
      var move = animate ? (transition || CENTER_TRANSITION) : "none";
      track.style.transition = move;
      track.style.transform = "translateX(" + offsetPx + "px)";
      scrollOffset = offsetPx;
      // Held (the page has taken the strip home to scroll on), what was paged
      // away from stays away: the picker does not come back before the
      // stage's own transition brings it (setLocked republishes on release).
      if (dragScroll && host !== viewport && !locked) publishPaged(offsetPx, animate ? move.slice("transform ".length) : "");
    }

    // The product page's frame is told how far the strip is paged on from the
    // first slide: --paged-px, in pixels, and --paged, 0 to 1 (PAGED_SPAN of a
    // tile and it is 1). Both are tweened with the strip itself (the same
    // timing, on registered properties in css/style.css), so what goes with it —
    // the metal picker — moves in step. .is-paged says it is far enough along
    // that what faded should not take taps.
    function publishPaged(offsetPx, timing) {
      var tile = measureTileWidth();
      var px = tile ? Math.max(0, computeBounds().max - offsetPx) : 0;
      var paged = tile ? Math.min(1, px / (tile * PAGED_SPAN)) : 0;
      host.style.transition = timing ? "--paged " + timing + ", --paged-px " + timing : "none";
      host.style.setProperty("--paged", paged.toFixed(4));
      host.style.setProperty("--paged-px", px.toFixed(1) + "px");
      host.classList.toggle("is-paged", paged > 0.5);
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
      // Locked, the strip is held home (the first slide centred) however the
      // tiles resize.
      if (locked && !reset) target = bounds.max;
      applyOffset(target, false);
    }

    // setLocked(true): the strip stops responding to drags, taps and keys
    // (the product page's stage, once the photos are leaving: it is about the
    // model alone). The caller takes it home first (goHome).
    var locked = false;
    function setLocked(lock) {
      lock = !!lock;
      if (lock === locked) return;
      locked = lock;
      carouselEl.classList.toggle("is-locked", lock);
      if (!lock && dragScroll && host !== viewport) publishPaged(scrollOffset, CENTER_TRANSITION.slice("transform ".length));
      // A sideways drag under way when the lock lands just ends where it is
      // (a scrolling gesture is not affected).
      if (lock && dragging) {
        dragging = false;
        trackedPointerId = null;
      }
    }

    // How far the strip is from home (the first slide centred), in slides, at
    // most 1.
    function awayFromHome() {
      var tile = measureTileWidth();
      if (!tile) return 0;
      return Math.min(1, Math.abs(computeBounds().max - scrollOffset) / tile);
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
    // (the page scrolls with it for a mouse or pen when dragScroll is on,
    // else it is handed off untouched to the browser's own touch-action: pan-y
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
    var dragGain = 1;
    // A vertical gesture that is scrolling the page (dragScroll): the last
    // pointer position and time it was followed to, and its speed (px/ms); and
    // the glide after it.
    var scrolling = false;
    var scrollLastY = 0;
    var scrollLastT = 0;
    var scrollVelocity = 0;
    var glideFrame = 0;
    var glideSpeed = 0;
    var glideTime = 0;

    // The slide under a point, found by geometry (what is stacked over the
    // strip doesn't matter), falling back to the event's own target.
    function slideAt(e) {
      var stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [];
      for (var i = 0; i < stack.length; i++) {
        if (stack[i].classList && stack[i].classList.contains("product-carousel__slide") && track.contains(stack[i])) return stack[i];
      }
      return e.target.closest(".product-carousel__slide");
    }

    // Whether a press is a drag's to read: not a control's, not the model's
    // (its circle, or for a viewer without one, the Modify sheet's, its whole
    // box), and inside the strip's band of the host.
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
    // Anything else that moves the page takes over from a glide.
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
        // Within 45° of horizontal is horizontal; anything else, vertical.
        axisLocked = Math.abs(dx) > Math.abs(dy);
        if (!axisLocked) {
          if (!dragScroll || e.pointerType === "touch") {
            // Vertical, and the page's scroll is the browser's own (a touch,
            // or the Modify sheet's carousel: touch-action: pan-y) — stop
            // tracking this pointer entirely; nothing here has touched the
            // carousel yet, so there's nothing to undo.
            trackedPointerId = null;
            return;
          }
          // Vertical: this scrolls the page, from where the press began.
          scrolling = true;
          scrollLastY = dragStartY;
          scrollLastT = e.timeStamp;
          scrollVelocity = 0;
          try { host.setPointerCapture(e.pointerId); } catch (err) { /* the pointer is already gone */ }
        } else if (locked || slideCount <= 1) {
          // Sideways with nothing to page (the model's stage holds the
          // strip): dropped.
          trackedPointerId = null;
          return;
        } else {
          dragging = true;
          applyOffset(scrollOffset, false); // kill any in-flight transition
          // On the track, not the viewport: the Modify sheet lets taps on
          // the viewport's empty space fall through to its backdrop (see
          // .size-modal__carousel in css/style.css), and the track is
          // exactly the slides. Captured events still bubble up to the
          // host listeners below either way.
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
        // A flick glides on; a pointer that stopped before it let go doesn't.
        startGlide(e.timeStamp - scrollLastT < 80 ? scrollVelocity : 0);
        return;
      }
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
        if (dragStartSlide && !locked) centerOnSlide(Array.prototype.indexOf.call(track.children, dragStartSlide));
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
      scrolling = false;
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
      // Centres slide `index`, with the same transition a tap uses.
      center: function (index) { centerOnSlide(index); },
      goHome: function () { centerOnSlide(0, HOME_TRANSITION); },
      awayFromHome: awayFromHome,
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
