// The product page's museum wall (inspiration stage): the item's photos hung as
// frames of varied size and format, their centres on one line, wide gaps
// between, each with its wall label; empty frames hold the places of photos
// still to come. The hang is seeded by the item's name, so each item keeps its
// own wall. CSS lays it out (horizontally, or turned vertical on phones) from
// the numbers set here; js/product.js walks it with the scroll. On phones the
// labels are read off one placard fixed on screen instead, showing the frame
// being passed. A photo's frame opens it full screen (the photo viewer).
//
// window.EmjiveProductWall:
//   build(track, product, placard)  fills the track and the placard; returns
//                                   { firstReady, loadRest }
//   showPlacard(index)              the placard shows that frame's label
//   isVertical()                    whether the wall is turned vertical (phones)

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;

  // Sizes as a share of the wall's cross-axis (its height, or its width when
  // vertical): small, medium, large. Neighbours never share one; every wall
  // has a large.
  var SIZES = [0.35, 0.46, 0.59];
  var LARGE = 2;
  // Formats (width / height); neighbours never share one.
  var FORMATS = [1, 4 / 5, 3 / 4, 5 / 4, 3 / 2];
  // The gap before each frame, as a share of the wall's length axis.
  var GAP_MIN = 0.3;
  var GAP_MAX = 0.48;
  // An item always shows at least MIN_WORKS frames; one without photos shows
  // EMPTY_MIN to EMPTY_MAX empty ones.
  var MIN_WORKS = 2;
  var EMPTY_MIN = 3;
  var EMPTY_MAX = 4;
  // An empty frame's label: its place on the wall.
  function emptyLabel(i) {
    return "photo " + (i + 1);
  }

  // The placard's items, one per frame (build), and the one showing.
  var placardItems = [];
  var placardAt = -1;

  // Mirrors the phone breakpoint of the wall in css/style.css.
  var verticalQuery = window.matchMedia("(max-width: 640px)");

  function isVertical() {
    return verticalQuery.matches;
  }

  function pick(rand, list) {
    return list[Math.floor(rand() * list.length)];
  }

  function without(list, values) {
    return list.filter(function (v) { return values.indexOf(v) === -1; });
  }

  // Each frame's size index, format and gap, the same on every visit.
  function hang(product, photoCount) {
    var rand = H.seededRandom("wall:" + (product.name || ""));
    var count = photoCount
      ? Math.max(MIN_WORKS, photoCount)
      : EMPTY_MIN + Math.floor(rand() * (EMPTY_MAX - EMPTY_MIN + 1));
    var largeAt = Math.floor(rand() * count);
    var indices = SIZES.map(function (s, i) { return i; });
    var works = [];
    var prevSize = -1;
    var prevFormat = 0;
    for (var i = 0; i < count; i++) {
      var size = i === largeAt
        ? LARGE
        : pick(rand, without(indices, [prevSize, i + 1 === largeAt ? LARGE : -1]));
      var format = pick(rand, without(FORMATS, [prevFormat]));
      works.push({ size: SIZES[size], ratio: format, gap: i ? H.lerp(GAP_MIN, GAP_MAX, rand()) : 0 });
      prevSize = size;
      prevFormat = format;
    }
    return works;
  }

  // The label reads as the facts under a grid tile: from a photo's
  // "name.category.metal.size", the name, then the metal, then "size" and the
  // size (appendSize). Any other text is shown whole, as the name.
  function captionFor(text) {
    var caption = el("figcaption", "product-wall__label");
    var parts = /^([^.]+)\.[^.]+\.([^.]+)\.(\d+(?:\.\d+)?)$/.exec(text);
    if (!parts) {
      caption.appendChild(labelLine(text, true));
      return caption;
    }
    caption.appendChild(labelLine(parts[1], true));
    caption.appendChild(labelLine(parts[2]));
    var size = labelLine("size ");
    window.EmjiveSelection.appendSize(size, parts[3]);
    caption.appendChild(size);
    return caption;
  }

  function labelLine(text, isName) {
    return el("span", "product-wall__label-line" + (isName ? " product-wall__label-line--name" : ""), text);
  }

  // The first photo is requested at once (the first paint waits on it); the
  // rest on loadRest(), each behind its own loader. All are loaded eagerly
  // then: a frame off to the side may never come near enough for lazy loading.
  function build(track, product, placard) {
    track.innerHTML = "";
    if (placard) placard.innerHTML = "";
    placardItems = [];
    placardAt = -1;
    var photos = (product.assets && product.assets.photos) || [];
    var loaders = [];
    var works = hang(product, photos.length);
    // The vertical wall's ends repeat the gaps next to them (css/style.css).
    track.style.setProperty("--gap-first", works[1].gap.toFixed(4));
    track.style.setProperty("--gap-last", works[works.length - 1].gap.toFixed(4));
    works.forEach(function (work, i) {
      var photo = photos[i] || null;
      var figure = el("figure", "product-wall__work");
      figure.style.setProperty("--h", String(work.size));
      figure.style.setProperty("--ratio", work.ratio.toFixed(4));
      figure.style.setProperty("--gap", work.gap.toFixed(4));
      // A photo's frame is the button that opens it full screen.
      var frame = el(photo ? "button" : "div", "product-wall__frame");
      figure.appendChild(frame);
      track.appendChild(figure);
      if (!photo) {
        figure.classList.add("is-empty");
        figure.setAttribute("aria-hidden", "true");
        var label = el("figcaption", "product-wall__label");
        label.appendChild(labelLine(emptyLabel(i)));
        figure.appendChild(label);
        addPlacardItem(placard, label, true);
        return;
      }
      var img = document.createElement("img");
      img.alt = (product.name || "") + (photo.description ? " — " + photo.description : "");
      img.decoding = "async";
      img.draggable = false;
      if (i === 0) img.fetchPriority = "high";
      if (photo.focus) img.style.objectPosition = photo.focus;
      frame.appendChild(img);
      frame.type = "button";
      frame.setAttribute("aria-haspopup", "dialog");
      frame.addEventListener("click", function () { openViewer(photo.src, img.alt, frame); });
      var caption = photo.description ? captionFor(photo.description) : el("figcaption", "product-wall__label");
      figure.appendChild(caption);
      addPlacardItem(placard, caption, false);
      var started = null;
      loaders.push(function load() {
        if (started) return started;
        img.src = photo.src;
        started = H.imageReady(img);
        if (window.EmjiveLoader && i > 0) window.EmjiveLoader.cover(frame, started);
        started.then(function () { figure.classList.add("is-loaded"); });
        return started;
      });
    });
    return {
      firstReady: loaders.length ? loaders[0]() : Promise.resolve(),
      loadRest: function () { loaders.forEach(function (load) { load(); }); }
    };
  }

  // The placard's copy of a frame's label, its words only.
  function addPlacardItem(placard, label, empty) {
    if (!placard) return;
    var item = el("div", "product-wall__placard-item" + (empty ? " is-empty" : ""));
    Array.prototype.forEach.call(label.childNodes, function (node) { item.appendChild(node.cloneNode(true)); });
    placard.appendChild(item);
    placardItems.push(item);
  }

  function showPlacard(index) {
    if (index === placardAt) return;
    if (placardItems[placardAt]) placardItems[placardAt].classList.remove("is-current");
    placardAt = index;
    if (placardItems[index]) placardItems[index].classList.add("is-current");
  }

  /* ---- the photo viewer ----
     A photo full screen over the dimmed page, closed by its cross, a tap
     beside it or Escape (EmjiveFocusTrap, which also locks the page). Built
     on first use. */

  var viewer = null;

  function buildViewer() {
    var root = el("div", "photo-viewer");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Photo");
    root.setAttribute("aria-hidden", "true");
    root.tabIndex = -1;
    var backdrop = el("div", "photo-viewer__backdrop");
    backdrop.addEventListener("click", closeViewer);
    var img = el("img", "photo-viewer__img");
    img.decoding = "async";
    img.draggable = false;
    var close = el("button", "photo-viewer__close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = H.ICON_CLOSE;
    close.addEventListener("click", closeViewer);
    root.appendChild(backdrop);
    root.appendChild(img);
    root.appendChild(close);
    document.body.appendChild(root);
    viewer = { root: root, img: img, isOpen: false };
  }

  function openViewer(src, alt, from) {
    if (!viewer) buildViewer();
    if (viewer.isOpen) return;
    viewer.img.src = src;
    viewer.img.alt = alt;
    viewer.isOpen = true;
    viewer.root.classList.add("is-open");
    viewer.root.setAttribute("aria-hidden", "false");
    // After .is-open: focus() is a no-op while hidden.
    if (window.EmjiveFocusTrap) {
      window.EmjiveFocusTrap.activate(viewer.root, { returnFocus: from, onEscape: closeViewer });
    }
  }

  function closeViewer() {
    if (!viewer || !viewer.isOpen) return;
    viewer.isOpen = false;
    viewer.root.classList.remove("is-open");
    viewer.root.setAttribute("aria-hidden", "true");
    if (window.EmjiveFocusTrap) window.EmjiveFocusTrap.release();
  }

  window.EmjiveProductWall = { build: build, showPlacard: showPlacard, isVertical: isVertical };
})();
