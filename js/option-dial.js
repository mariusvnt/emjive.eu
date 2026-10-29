// Option dial: a circular button showing the active option, its name under
// it, opening a disc over three blurs, divided into one section per option,
// each always in the same place, the active one dotted (the dot turning
// round the middle to it). Pointing into a section makes its option the
// active one; the disc's middle changes nothing. Used by js/product.js for
// the shape (mode "icons": an icon per section) and the material (mode
// "fill": each section filled with its swatch, from the button's edge to the
// disc's, fading out at it in three layers).
//
// The button holds every option's preview, stacked, crossfading to the
// active one.
//
// window.EmjiveOptionDial.mount(host, { name, mode, options, selected, onSelect, onShow })
//   options: [{ key, label, preview() }], preview() a new node per call
//   onShow(label): the active option's name while open, "" once closed
//   -> { select(key), setOptions(options) }  (select() does not call onSelect)
// A fine pointer that hovers: hovering opens, moving into a section picks
// it, a click closes, leaving closes. Touch: a tap opens (a tap in a section
// picks it and closes, one outside closes); a press held HOLD_MS, or dragged,
// opens it under the finger, which picks each section it enters (a hold
// released unmoved leaves it open). Keyboard: Enter or Space opens and
// closes, the arrows step through the options, Escape closes.

(function () {
  "use strict";

  var H = window.EmjiveHelpers;
  var el = H.el;
  var remPx = H.remPx;

  // The disc, in rem: the neutral middle's radius (the button's, and a
  // little), and the icons' radius, at least ICON_RING_MIN_REM and with
  // ICON_PITCH_REM between neighbours, the sections reaching as far again.
  var INNER_REM = 1.625;
  var ICON_RING_MIN_REM = 3;
  var ICON_PITCH_REM = 2.2;
  var FILL_OUTER_REM = 4.375;
  // The button's radius (.product-dial --dial-size) less its border, where
  // the swatches start, under the border it loses while open.
  var FILL_INNER_REM = 1.3125;
  // The swatches, once per fade layer.
  var FILL_FADES = 3;
  var HOLD_MS = 250;
  var DRAG_SLOP_PX = 8;
  // Leaving the dial closes it after this long; coming back keeps it.
  var LEAVE_MS = 200;
  var hoverMedia = window.matchMedia("(hover: hover) and (pointer: fine)");

  // An annular sector, centred on angle `mid` (radians from the top,
  // clockwise) and `half` wide each side, from `inner` to 1 (shares of the
  // radius), as a polygon() over its square.
  function sectorPolygon(mid, half, inner) {
    var steps = 16;
    var points = [];
    var at = function (r, a) {
      return (50 + 50 * r * Math.sin(a)).toFixed(2) + "% " + (50 - 50 * r * Math.cos(a)).toFixed(2) + "%";
    };
    for (var i = 0; i <= steps; i++) points.push(at(1, mid - half + (2 * half * i) / steps));
    for (var j = steps; j >= 0; j--) points.push(at(inner, mid - half + (2 * half * j) / steps));
    return "polygon(" + points.join(", ") + ")";
  }

  function mount(host, opts) {
    var name = opts.name || "";
    var fill = opts.mode === "fill";
    var onSelect = opts.onSelect || function () {};
    var onShow = opts.onShow || function () {};
    var options = [];
    var selected = opts.selected;
    var isOpen = false;
    var leaveTimer = 0;
    var outer = FILL_OUTER_REM;
    // The dot's angle, in degrees, carried on by the shorter way round.
    var turn = 0;

    host.classList.add("product-dial", fill ? "product-dial--fill" : "product-dial--icons");
    host.innerHTML = "";
    var button = el("button", "product-dial__button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    var face = el("span", "product-dial__preview");
    face.setAttribute("aria-hidden", "true");
    button.appendChild(face);
    var label = el("span", "product-dial__label");
    label.setAttribute("aria-hidden", "true");
    // The disc: its blurs (the strongest the smallest), its sections, the dot.
    var wheel = el("div", "product-dial__wheel");
    wheel.setAttribute("aria-hidden", "true");
    var blur = el("span", "product-dial__blur");
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    blur.appendChild(el("span"));
    wheel.appendChild(blur);
    var sections = el("div", "product-dial__sections");
    wheel.appendChild(sections);
    var dot = el("span", "product-dial__dot");
    wheel.appendChild(dot);
    host.appendChild(button);
    host.appendChild(label);
    host.appendChild(wheel);

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
      var step = (2 * Math.PI) / count;
      var ring = Math.max(ICON_RING_MIN_REM, (count * ICON_PITCH_REM) / (2 * Math.PI));
      outer = fill ? FILL_OUTER_REM : 2 * ring - INNER_REM;
      host.style.setProperty("--dial-outer", outer.toFixed(3) + "rem");
      host.style.setProperty("--dial-inner", INNER_REM + "rem");
      // Where the dot sits on the active section: its middle, or its icon's.
      host.style.setProperty("--dial-dot-r", (fill ? (FILL_INNER_REM + outer) / 2 : ring).toFixed(3) + "rem");
      face.innerHTML = "";
      options.forEach(function (option) {
        var layer = el("span", "product-dial__face");
        layer.setAttribute("data-key", option.key);
        layer.appendChild(option.preview());
        face.appendChild(layer);
      });
      sections.innerHTML = "";
      for (var layer = 0; layer < (fill ? FILL_FADES : 1); layer++) {
        var into = sections;
        if (fill) {
          into = el("span", "product-dial__fade");
          sections.appendChild(into);
        }
        options.forEach(function (option, i) {
          var mid = i * step;
          var section = el("span", "product-dial__section");
          section.setAttribute("data-key", option.key);
          section.style.setProperty("--dial-x", Math.sin(mid).toFixed(4));
          section.style.setProperty("--dial-y", (-Math.cos(mid)).toFixed(4));
          if (fill) section.style.clipPath = sectorPolygon(mid, step / 2, FILL_INNER_REM / outer);
          section.appendChild(option.preview());
          into.appendChild(section);
        });
      }
      host.style.setProperty("--dial-ring", ring.toFixed(3) + "rem");
      paint();
    }

    function paint() {
      var i = Math.max(0, indexOf(selected));
      var option = options[i];
      Array.prototype.forEach.call(face.children, function (layer) {
        layer.classList.toggle("is-shown", !!option && layer.getAttribute("data-key") === option.key);
      });
      label.textContent = option ? option.label : "";
      button.setAttribute("aria-label", name + (option ? ": " + option.label : ""));
      var target = (i * 360) / Math.max(1, options.length);
      turn += ((((target - turn) % 360) + 540) % 360) - 180;
      dot.style.setProperty("--dial-turn", turn.toFixed(2) + "deg");
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
      host.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", onOutside, true);
      var option = options[indexOf(selected)];
      onShow(option ? option.label : "");
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

    // The option whose section holds the point; null in the disc's middle.
    function keyAt(x, y) {
      var r = button.getBoundingClientRect();
      var dx = x - (r.left + r.width / 2);
      var dy = y - (r.top + r.height / 2);
      if (!options.length || dx * dx + dy * dy < Math.pow(INNER_REM * remPx(), 2)) return null;
      var n = options.length;
      var turn = Math.atan2(dx, -dy);
      if (turn < 0) turn += 2 * Math.PI;
      return options[Math.round(turn / ((2 * Math.PI) / n)) % n].key;
    }

    /* ---- the button: a click (mouse, keyboard, or a touch's tap) ---- */

    var suppressClick = false;
    button.addEventListener("click", function () {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (isOpen && !hoverMedia.matches) close();
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

    /* ---- hover: the section under the mouse ---- */

    host.addEventListener("pointerenter", function (e) {
      if (e.pointerType !== "mouse" || !hoverMedia.matches) return;
      open();
    });
    host.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse" || !isOpen) return;
      var key = keyAt(e.clientX, e.clientY);
      if (key) pick(key);
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

  window.EmjiveOptionDial = { mount: mount };
})();
