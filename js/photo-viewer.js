// The photo viewer: one photo full screen, opened from the product page's
// museum wall (js/product-wall.js) and the size finder's sizing strip
// (js/size-finder.js). With several photos, arrows at the sides move to the
// one before (when there is one) and after (when there is one), as do the
// arrow keys and a sideways swipe. What opened it stays visible, dimmed.
// Closed by its cross, a tap beside the photo or Escape (EmjiveFocusTrap,
// which also locks the page, or hands back to a dialog underneath). Built on
// first use.
//
// window.EmjivePhotoViewer = { open(photos, index, options), isOpen() }
//   photos         [{ src, alt }]
//   options.from   element or function focus returns to

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;

  // A swipe at least this long (px) turns the photo; a shorter one is a tap.
  var SWIPE_PX = 40;

  var viewer = null;

  function arrowButton(className, label, icon, step) {
    var btn = el("button", "photo-viewer__arrow " + className);
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = icon;
    btn.addEventListener("click", function () { show(viewer.index + step); });
    return btn;
  }

  function build() {
    var root = el("div", "photo-viewer");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Photo");
    root.setAttribute("aria-hidden", "true");
    root.tabIndex = -1;
    var backdrop = el("div", "photo-viewer__backdrop");
    // Not when the tap ended a swipe.
    backdrop.addEventListener("click", function () {
      if (!viewer.swiped) close();
    });
    var img = el("img", "photo-viewer__img");
    img.decoding = "async";
    img.draggable = false;
    var prev = arrowButton("photo-viewer__arrow--prev", "Previous photo", H.ICON_BACK, -1);
    var next = arrowButton("photo-viewer__arrow--next", "Next photo", H.ICON_NEXT, 1);
    var cross = el("button", "photo-viewer__close");
    cross.type = "button";
    cross.setAttribute("aria-label", "Close");
    cross.innerHTML = H.ICON_CLOSE;
    cross.addEventListener("click", close);
    root.appendChild(backdrop);
    root.appendChild(img);
    root.appendChild(prev);
    root.appendChild(next);
    root.appendChild(cross);

    root.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      show(viewer.index + (e.key === "ArrowLeft" ? -1 : 1));
    });

    // Sideways swipes, touch and pen only: a mouse has the arrows.
    var startX = null;
    root.addEventListener("pointerdown", function (e) {
      viewer.swiped = false;
      startX = e.pointerType === "mouse" ? null : e.clientX;
    });
    root.addEventListener("pointerup", function (e) {
      if (startX === null || viewer.photos.length < 2) return;
      var dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) < SWIPE_PX) return;
      viewer.swiped = true;
      show(viewer.index + (dx > 0 ? -1 : 1));
    });
    root.addEventListener("pointercancel", function () { startX = null; });

    document.body.appendChild(root);
    viewer = { root: root, img: img, prev: prev, next: next, cross: cross, photos: [], index: 0, isOpen: false, swiped: false };
  }

  // Shows photo `index`, if there is one; an arrow with nothing past it hides,
  // its focus passing to the other arrow or the cross.
  function show(index) {
    if (index < 0 || index >= viewer.photos.length) return;
    viewer.index = index;
    var photo = viewer.photos[index];
    viewer.img.src = photo.src;
    viewer.img.alt = photo.alt || "";
    var several = viewer.photos.length > 1;
    var active = document.activeElement;
    viewer.prev.hidden = !several || index === 0;
    viewer.next.hidden = !several || index === viewer.photos.length - 1;
    if (active && active.hidden) {
      var other = active === viewer.prev ? viewer.next : viewer.prev;
      (other.hidden ? viewer.cross : other).focus({ preventScroll: true });
    }
  }

  function open(photos, index, options) {
    if (!photos || !photos.length) return;
    if (!viewer) build();
    if (viewer.isOpen) return;
    options = options || {};
    viewer.photos = photos;
    viewer.root.classList.toggle("has-arrows", photos.length > 1);
    show(index || 0);
    viewer.isOpen = true;
    viewer.root.classList.add("is-open");
    viewer.root.setAttribute("aria-hidden", "false");
    // After .is-open: focus() is a no-op while hidden.
    if (window.EmjiveFocusTrap) {
      window.EmjiveFocusTrap.activate(viewer.root, {
        nested: window.EmjiveFocusTrap.isActive(),
        returnFocus: options.from,
        onEscape: close
      });
    }
  }

  function close() {
    if (!viewer || !viewer.isOpen) return;
    viewer.isOpen = false;
    viewer.root.classList.remove("is-open");
    viewer.root.setAttribute("aria-hidden", "true");
    if (window.EmjiveFocusTrap) window.EmjiveFocusTrap.release();
  }

  window.EmjivePhotoViewer = {
    open: open,
    isOpen: function () { return !!(viewer && viewer.isOpen); }
  };
})();
