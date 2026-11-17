// Option dials (js/product.js, js/modify-modal.js): a circular button
// showing the active option, the dial's name under it, opening a disc over three
// blurs, divided into one section per option, each always in the same
// place, the active one dotted (the button's circle shrinking to the dot,
// turning round the middle to it).
// Pointing into a section makes its option the active one; the disc's
// middle changes nothing. Each section shows its option's preview on a
// ring: the shape's a design's icon, the material's a metal's round swatch.
// Two options sit in the upper half, PAIR_SPREAD_DEG apart, each taking its
// half of the disc (left, right) rather than a north and a south section;
// an odd number leaves its extra one in the upper half, the easier to see.
//
// The button holds every option's preview, stacked, crossfading to the
// active one. Closed, the blurs show within its circle.
//
// The size has its own dial (mountSize, below).
//
// window.EmjiveOptionDial.mount(host, { name, options, selected, onSelect, onShow })
//   options: [{ key, label, preview() }], preview() a new node per call
//   onShow(label, linger): the active option's name while open; once closed,
//     the name again with linger true if the visitor picked one while it was
//     open (so a tap that picks still shows what it picked), else ""
//   -> { select(key), setOptions(options) }  (select() does not call onSelect)
// window.EmjiveOptionDial.nameShower(node) -> an onShow for the dials that
//   share one name line: shown while given, held LINGER_MS on a linger.
// A fine pointer that hovers: hovering opens, and once it has rested
// HOVER_SAFE_MS the section under it picks its option; a click in the
// middle closes, leaving closes. Touch: a tap opens (a tap in a section
// picks it and closes, one outside closes); a press held HOLD_MS, or dragged,
// opens it under the finger, which picks each section it enters (a hold
// released unmoved leaves it open). A tap in the middle closes, changing
// nothing. Keyboard: Enter or Space opens and closes, the arrows step
// through the options, Escape closes.

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;
  var remPx = H.remPx;

  // The disc, in rem: the neutral middle's radius (the button's, and a
  // little), and the previews' radius, at least ICON_RING_MIN_REM and with
  // ICON_PITCH_REM between neighbours, the sections reaching as far again.
  var INNER_REM = 1.625;
  var ICON_RING_MIN_REM = 3;
  var ICON_PITCH_REM = 2.2;
  var PAIR_SPREAD_DEG = 120;
  var HOLD_MS = 250;
  // Hovering opens at once but picks only after this long, so crossing a
  // dial to reach another changes nothing.
  var HOVER_SAFE_MS = 200;
  var DRAG_SLOP_PX = 8;
  // Leaving the dial closes it after this long; coming back keeps it.
  var LEAVE_MS = 200;
  // How long a picked option's name stays once its dial has closed.
  var LINGER_MS = 2000;
  var hoverMedia = window.matchMedia("(hover: hover) and (pointer: fine)");

  function mount(host, opts) {
    var name = opts.name || "";
    var onSelect = opts.onSelect || function () {};
    var onShow = opts.onShow || function () {};
    var options = [];
    var selected = opts.selected;
    var isOpen = false;
    var pickedOpen = false;
    var leaveTimer = 0;
    var outer = 0;
    // The dot's angle, in degrees, carried on by the shorter way round.
    var turn = 0;

    host.classList.add("product-dial", "product-dial--icons");
    host.innerHTML = "";
    var button = el("button", "product-dial__button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    var face = el("span", "product-dial__preview");
    face.setAttribute("aria-hidden", "true");
    button.appendChild(face);
    var title = el("span", "product-dial__title", name);
    title.setAttribute("aria-hidden", "true");
    // The disc: its blurs (the strongest the smallest), then what opens out
    // from the middle: its sections.
    var wheel = el("div", "product-dial__wheel");
    wheel.setAttribute("aria-hidden", "true");
    var blur = el("span", "product-dial__blur");
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    wheel.appendChild(blur);
    var disc = el("div", "product-dial__disc");
    var sections = el("div", "product-dial__sections");
    disc.appendChild(sections);
    wheel.appendChild(disc);
    // The button's circle, which open becomes the dot, turned to the active section.
    var turner = el("span", "product-dial__turn");
    turner.setAttribute("aria-hidden", "true");
    turner.appendChild(el("span", "product-dial__ring"));
    host.appendChild(button);
    host.appendChild(title);
    host.appendChild(wheel);
    host.appendChild(turner);

    // A pair of options (pairMode): left and right of the top.
    function pairMode() {
      return options.length === 2;
    }

    // How many of n options at offset + i * step lie in the upper half.
    function upperCount(n, offset) {
      var count = 0;
      for (var i = 0; i < n; i++) {
        if (Math.cos(offset + (i * 2 * Math.PI) / n) > 1e-6) count++;
      }
      return count;
    }

    // The first option's direction: the top, or half a step left of it when
    // that puts more options in the upper half (an odd count of 3, 7...).
    function ringOffset() {
      var n = options.length;
      if (n < 3 || n % 2 === 0) return 0;
      var half = -Math.PI / n;
      return upperCount(n, half) > upperCount(n, 0) ? half : 0;
    }

    // Option i's direction, radians from the top, clockwise.
    function angleOf(i) {
      if (pairMode()) return ((i === 0 ? -1 : 1) * PAIR_SPREAD_DEG * Math.PI) / 360;
      return ringOffset() + (i * 2 * Math.PI) / Math.max(1, options.length);
    }

    function indexOf(key) {
      for (var i = 0; i < options.length; i++) {
        if (options[i].key === key) return i;
      }
      return -1;
    }

    function setOptions(next) {
      close(false);
      options = next.slice();
      var count = Math.max(1, options.length);
      var ring = Math.max(ICON_RING_MIN_REM, (count * ICON_PITCH_REM) / (2 * Math.PI));
      outer = 2 * ring - INNER_REM;
      host.style.setProperty("--dial-outer", outer.toFixed(3) + "rem");
      host.style.setProperty("--dial-inner", INNER_REM + "rem");
      // The dot sits on the active section's preview.
      host.style.setProperty("--dial-dot-r", ring.toFixed(3) + "rem");
      face.innerHTML = "";
      options.forEach(function (option) {
        var layer = el("span", "product-dial__face");
        layer.setAttribute("data-key", option.key);
        layer.appendChild(option.preview());
        face.appendChild(layer);
      });
      sections.innerHTML = "";
      options.forEach(function (option, i) {
        var mid = angleOf(i);
        var section = el("span", "product-dial__section");
        section.setAttribute("data-key", option.key);
        section.style.setProperty("--dial-x", Math.sin(mid).toFixed(4));
        section.style.setProperty("--dial-y", (-Math.cos(mid)).toFixed(4));
        section.appendChild(option.preview());
        sections.appendChild(section);
      });
      host.style.setProperty("--dial-ring", ring.toFixed(3) + "rem");
      paint();
    }

    function paint() {
      var i = Math.max(0, indexOf(selected));
      var option = options[i];
      Array.prototype.forEach.call(face.children, function (layer) {
        layer.classList.toggle("is-shown", !!option && layer.getAttribute("data-key") === option.key);
      });
      button.setAttribute("aria-label", name + (option ? ": " + option.label : ""));
      var target = (angleOf(i) * 180) / Math.PI;
      turn += ((((target - turn) % 360) + 540) % 360) - 180;
      host.style.setProperty("--dial-turn", turn.toFixed(2) + "deg");
      Array.prototype.forEach.call(sections.querySelectorAll(".product-dial__section"), function (section) {
        section.classList.toggle("is-active", !!option && section.getAttribute("data-key") === option.key);
      });
      if (isOpen) onShow(option ? option.label : "");
    }

    function select(key) {
      if (key === selected) return;
      selected = key;
      paint();
    }

    function pick(key) {
      if (key === selected || indexOf(key) === -1) return;
      selected = key;
      if (isOpen) pickedOpen = true;
      paint();
      onSelect(key);
    }

    function step(by) {
      var n = options.length;
      if (!n) return;
      var i = indexOf(selected);
      pick(options[(((i + by) % n) + n) % n].key);
    }

    function open() {
      clearTimeout(leaveTimer);
      if (isOpen) return;
      isOpen = true;
      pickedOpen = false;
      host.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      var option = options[indexOf(selected)];
      onShow(option ? option.label : "");
    }

    function close() {
      clearTimeout(leaveTimer);
      clearTimeout(hoverTimer);
      if (!isOpen) return;
      isOpen = false;
      host.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      var option = options[indexOf(selected)];
      if (pickedOpen && option) onShow(option.label, true);
      else onShow("");
    }

    function onOutside(e) {
      if (!host.contains(e.target)) close();
    }

    // The option whose section holds the point; null in the disc's middle.
    function keyAt(x, y) {
      var r = button.getBoundingClientRect();
      var dx = x - (r.left + r.width / 2);
      var dy = y - (r.top + r.height / 2);
      if (!options.length || dx * dx + dy * dy < Math.pow(INNER_REM * remPx(), 2)) return null;
      var n = options.length;
      if (pairMode()) return options[dx < 0 ? 0 : 1].key;
      var turn = Math.atan2(dx, -dy) - ringOffset();
      var i = Math.round(turn / ((2 * Math.PI) / n));
      return options[((i % n) + n) % n].key;
    }

    /* ---- the button: a click (mouse, keyboard, or a touch's tap) ---- */

    var suppressClick = false;
    button.addEventListener("click", function () {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (isOpen) close();
      else open();
    });
    button.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        close();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        open();
        step(1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        open();
        step(-1);
      }
    });
    host.addEventListener("focusout", function (e) {
      if (isOpen && e.relatedTarget && !host.contains(e.relatedTarget)) close();
    });

    /* ---- hover: the section under the mouse, once it has rested ---- */

    var hoverTimer = 0;
    var hoverReady = false;
    var hoverAt = null;
    function pickHovered() {
      if (!isOpen || !hoverAt) return;
      var key = keyAt(hoverAt.x, hoverAt.y);
      if (key) pick(key);
    }
    host.addEventListener("pointerenter", function (e) {
      if (e.pointerType !== "mouse" || !hoverMedia.matches) return;
      var wasOpen = isOpen;
      open();
      if (wasOpen) return;
      hoverReady = false;
      hoverAt = { x: e.clientX, y: e.clientY };
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        hoverReady = true;
        pickHovered();
      }, HOVER_SAFE_MS);
    });
    host.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse" || !isOpen) return;
      hoverAt = { x: e.clientX, y: e.clientY };
      if (hoverReady) pickHovered();
    });
    host.addEventListener("pointerleave", function (e) {
      if (e.pointerType !== "mouse" || !hoverMedia.matches || !isOpen) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(close, LEAVE_MS);
    });

    /* ---- a tap or a click in the open disc ---- */

    // Its own press and release, not a click: a touch's click can be
    // retargeted off the disc.
    var wheelPress = null;
    wheel.addEventListener("pointerdown", function (e) {
      wheelPress = e.pointerId;
    });
    wheel.addEventListener("pointerup", function (e) {
      if (wheelPress !== e.pointerId) return;
      wheelPress = null;
      var key = keyAt(e.clientX, e.clientY);
      if (key) pick(key);
      close();
    });
    wheel.addEventListener("pointercancel", function () { wheelPress = null; });

    /* ---- touch: hold, drag, release ---- */

    var press = null;
    function startDrag() {
      if (!press || press.dragging) return;
      clearTimeout(press.timer);
      press.dragging = true;
      open();
    }
    button.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, moved: false, timer: setTimeout(startDrag, HOLD_MS) };
      button.setPointerCapture(e.pointerId);
    });
    button.addEventListener("pointermove", function (e) {
      if (!press || e.pointerId !== press.id) return;
      if (!press.moved) {
        var dx = e.clientX - press.x;
        var dy = e.clientY - press.y;
        if (dx * dx + dy * dy < DRAG_SLOP_PX * DRAG_SLOP_PX) return;
        press.moved = true;
        startDrag();
      }
      var key = keyAt(e.clientX, e.clientY);
      if (key) pick(key);
    });
    function endPress(e) {
      if (!press || e.pointerId !== press.id) return;
      clearTimeout(press.timer);
      var dragging = press.dragging;
      var moved = press.moved;
      press = null;
      if (!dragging) return;
      // The click that follows the release isn't a tap.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      if (moved) close();
    }
    button.addEventListener("pointerup", endPress);
    button.addEventListener("pointercancel", endPress);
    // A long press is the dial's: no context menu or image callout, which
    // would cancel it.
    host.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    setOptions(opts.options || []);
    return { select: select, setOptions: setOptions };
  }

  /* ---- the size dial ----
     A circle holding the size, "Size" under it. Open, the size gives way to a
     vertical line from the range's least size (its foot) to its most (its
     head), the circle shrinking onto it at the size as its tick. Sliding up
     raises the size, down lowers it, by the pointer's travel at the line's
     pitch times a gain that falls with its speed (smoothed over
     SIZE_SPEED_MS): 1 at SIZE_FAST_PX_MS and over, SIZE_FINE_GAIN at
     SIZE_SLOW_PX_MS and under, for fine settings. A fine pointer that
     hovers: hovering opens, a press slides, leaving closes. Touch: a tap
     opens (then a slide on the line moves the size, a tap elsewhere
     closes); a press held HOLD_MS, or slid, opens it under the finger and
     slides, closing on release (a hold released unmoved leaves it open).
     Keyboard: the arrows, Shift+arrows and PageUp/PageDown step the size;
     Enter or Space opens and closes, Escape closes.

     mountSize(host, { range, onChange, onShow, onFind })
       range         { min, max }, mm (EmjiveHelpers.sizeRange)
       onChange(mm)  the visitor moved it (to a tenth of a mm, in the range)
       onShow(text)  the size while open, "" once closed
       onFind()      "Unsure about size?" (none without it)
     -> { set(mm, given), finder }: set() shows mm, as the visitor's size
        (given) or a stand-in; finder is the "Unsure about size?" button, for the
        caller to place, or null. */
  var SIZE_KEY_STEP = 0.5;
  var SIZE_KEY_FINE = 0.1;
  var SIZE_KEY_PAGE = 5;
  var SIZE_SLOP_PX = 6;
  var SIZE_FAST_PX_MS = 0.2;
  var SIZE_SLOW_PX_MS = 0.03;
  var SIZE_FINE_GAIN = 0.2;
  var SIZE_SPEED_MS = 60;

  function mountSize(host, opts) {
    var onChange = opts.onChange || function () {};
    var onShow = opts.onShow || function () {};
    var isOpen = false;
    var leaveTimer = 0;
    var range = opts.range || H.sizeRange(null);
    var current = H.DEFAULT_SIZE_MM;

    host.classList.add("product-dial", "product-dial--size");
    host.innerHTML = "";
    var button = el("button", "product-dial__button");
    button.type = "button";
    button.setAttribute("role", "slider");
    button.setAttribute("aria-label", "Size");
    button.setAttribute("aria-orientation", "vertical");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-valuemin", String(range.min));
    button.setAttribute("aria-valuemax", String(range.max));
    var value = el("span", "product-size-dial__value");
    value.setAttribute("aria-hidden", "true");
    button.appendChild(value);
    var title = el("span", "product-dial__title", "Size");
    title.setAttribute("aria-hidden", "true");
    var wheel = el("span", "product-dial__wheel");
    wheel.setAttribute("aria-hidden", "true");
    var blur = el("span", "product-dial__blur");
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    wheel.appendChild(blur);
    var menu = el("div", "product-size-dial__menu");
    var track = el("span", "product-size-dial__track");
    track.setAttribute("aria-hidden", "true");
    track.appendChild(el("span", "product-size-dial__line"));
    menu.appendChild(track);
    // The button's circle, which open becomes the line's tick.
    var ring = el("span", "product-dial__ring product-size-dial__ring");
    ring.setAttribute("aria-hidden", "true");
    menu.appendChild(ring);
    var finder = null;
    if (opts.onFind) {
      finder = el("button", "product-size__finder-toggle", "Unsure about size?");
      finder.type = "button";
      finder.addEventListener("click", function () {
        close();
        opts.onFind();
      });
    }
    host.appendChild(button);
    host.appendChild(title);
    host.appendChild(wheel);
    host.appendChild(menu);

    function shownText() {
      return H.sizeText(current);
    }

    // Its number, the tick's place on the line (--size-at, its share of
    // the way up), and its text while open.
    function set(mm, given) {
      current = H.clamp(mm, range.min, range.max);
      value.textContent = H.sizeText(current);
      host.style.setProperty("--size-at", ((current - range.min) / (range.max - range.min)).toFixed(4));
      host.classList.toggle("is-unset", !given);
      button.setAttribute("aria-valuenow", String(current));
      button.setAttribute("aria-valuetext", shownText());
      if (isOpen) onShow(shownText());
    }

    function move(mm) {
      if (mousePress) mousePress.slid = true;
      mm = H.clamp(Math.round(mm * 10) / 10, range.min, range.max);
      set(mm, true);
      onChange(mm);
    }

    function open() {
      clearTimeout(leaveTimer);
      if (isOpen) return;
      isOpen = true;
      host.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      onShow(shownText());
    }
    function close() {
      clearTimeout(leaveTimer);
      if (!isOpen) return;
      isOpen = false;
      host.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", onOutside, true);
      onShow("");
    }
    function onOutside(e) {
      if (!host.contains(e.target)) close();
    }

    /* ---- sliding ---- */

    var slide = null;
    function slideFrom(e, target) {
      slide = { id: e.pointerId, lastY: e.clientY, lastT: e.timeStamp, speed: SIZE_FAST_PX_MS, mm: current };
      target.setPointerCapture(e.pointerId);
    }
    function slideTo(e) {
      if (!slide || e.pointerId !== slide.id) return;
      // The events' own times: a busy frame that delays handling doesn't read as a slow finger.
      var dt = Math.max(1, e.timeStamp - slide.lastT);
      var dy = e.clientY - slide.lastY;
      slide.lastY = e.clientY;
      slide.lastT = e.timeStamp;
      var pitch = track.offsetHeight / (range.max - range.min);
      if (dy === 0 || !(pitch > 0)) return;
      slide.speed += (Math.abs(dy) / dt - slide.speed) * (1 - Math.exp(-dt / SIZE_SPEED_MS));
      var gain = SIZE_FINE_GAIN + (1 - SIZE_FINE_GAIN) * H.smoothstep(SIZE_SLOW_PX_MS, SIZE_FAST_PX_MS, slide.speed);
      slide.mm = H.clamp(slide.mm - (dy / pitch) * gain, range.min, range.max);
      move(slide.mm);
    }

    /* ---- the button ---- */

    var press = null;
    var suppressClick = false;
    // A mouse press on the open dial that doesn't slide: its click closes it.
    var mousePress = null;
    function startPress() {
      if (!press || press.dragging) return;
      clearTimeout(press.timer);
      press.dragging = true;
      open();
    }
    button.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") {
        mousePress = { wasOpen: isOpen, slid: false };
        open();
        slideFrom(e, button);
        return;
      }
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false, moved: false, timer: setTimeout(startPress, HOLD_MS) };
      slideFrom(e, button);
    });
    button.addEventListener("pointermove", function (e) {
      if (press && e.pointerId === press.id && !press.moved) {
        var dx = e.clientX - press.x;
        var dy = e.clientY - press.y;
        if (dx * dx + dy * dy < SIZE_SLOP_PX * SIZE_SLOP_PX) {
          // Under the slop: the slide starts from here, not from the touch.
          if (slide) slide.lastY = e.clientY;
          return;
        }
        press.moved = true;
        startPress();
      }
      if (press && !press.dragging) return;
      slideTo(e);
    });
    function endButtonPress(e) {
      if (slide && e.pointerId === slide.id) slide = null;
      if (!press || e.pointerId !== press.id) return;
      clearTimeout(press.timer);
      var dragging = press.dragging;
      var moved = press.moved;
      press = null;
      if (!dragging) return;
      // The click that follows the release isn't a tap.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      if (moved) close();
    }
    button.addEventListener("pointerup", endButtonPress);
    button.addEventListener("pointercancel", endButtonPress);
    button.addEventListener("click", function () {
      var mouse = mousePress;
      mousePress = null;
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (mouse) {
        if (mouse.wasOpen && !mouse.slid) close();
        return;
      }
      if (isOpen) close();
      else open();
    });
    button.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        close();
        return;
      }
      var step = e.shiftKey ? SIZE_KEY_FINE : SIZE_KEY_STEP;
      var next = H.sliderKey(e, current, step, SIZE_KEY_PAGE, range.min, range.max);
      if (next === null) return;
      e.preventDefault();
      move(next);
    });

    /* ---- the line, while open ---- */

    track.addEventListener("pointerdown", function (e) {
      if (!isOpen) return;
      slideFrom(e, track);
    });
    track.addEventListener("pointermove", slideTo);
    function endTrackSlide(e) {
      if (slide && e.pointerId === slide.id) slide = null;
    }
    track.addEventListener("pointerup", endTrackSlide);
    track.addEventListener("pointercancel", endTrackSlide);

    // A vertical wheel or trackpad over the open dial moves the size.
    host.addEventListener("wheel", function (e) {
      if (!isOpen || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      var pitch = track.offsetHeight / (range.max - range.min);
      if (!(pitch > 0)) return;
      e.preventDefault();
      var px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      move(current - px / pitch);
    }, { passive: false });

    /* ---- hover, focus ---- */

    host.addEventListener("pointerenter", function (e) {
      if (e.pointerType !== "mouse" || !hoverMedia.matches) return;
      open();
    });
    host.addEventListener("pointerleave", function (e) {
      if (e.pointerType !== "mouse" || !hoverMedia.matches || !isOpen || slide) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(close, LEAVE_MS);
    });
    host.addEventListener("focusout", function (e) {
      if (isOpen && e.relatedTarget && !host.contains(e.relatedTarget)) close();
    });
    // A long press is the dial's: no context menu, which would cancel it.
    host.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    set(current, false);
    return { set: set, finder: finder };
  }

  /* ---- the name line ---- */

  function nameShower(node) {
    var timer = 0;
    function hide() {
      node.classList.remove("is-shown");
    }
    return function (text, linger) {
      clearTimeout(timer);
      if (!text) {
        hide();
        return;
      }
      node.textContent = text;
      node.classList.add("is-shown");
      if (linger) timer = setTimeout(hide, LINGER_MS);
    };
  }

  window.EmjiveOptionDial = {
    mount: mount,
    mountSize: mountSize,
    nameShower: nameShower
  };
})();
