/* ==========================================================================
   em·ji·ve — metal picker

   Shared by the product page (js/product.js) and the Modify sheet
   (js/modify-modal.js, built on every page): one bar per metal, stacked, the
   active one stretched and the others shrunk, with a dot + the metal's name
   beside the active bar. Both used to build and update the same markup
   separately; loaded on all seven pages for the same reason
   js/modify-modal.js is, ahead of it.

   window.EmjiveMetalPicker.mount(container, { metals, selected, onSelect })
   fills `container` (the .product-metals box) and returns { select(metal) }.
   A click calls onSelect(metal) at once — the model, price and images behind
   the picker must not wait on an animation — and the picker then plays its
   own change in three beats, all keyed off the container's classes (see
   css/style.css):
     1. .is-switching: the dot + label fade out (--fade-fast)
     2. .is-selected moves to the new row: the bars resize (--metal-bar-resize)
     3. .is-switching comes off: the dot + label fade in on the new row
   Updated in place, never rebuilt, so keyboard focus stays on the bar just
   pressed. The first paint (and a re-mount) shows the final state with no
   animation. aria-pressed flips immediately; only the visuals are sequenced.
   select(metal) is the same change without the onSelect call, for callers
   that already know the metal.
   ========================================================================== */

(function () {
  "use strict";

  // A duration token off :root ("0.075s" or "75ms") in ms — the timing lives
  // in css/style.css only, so the beats here can't drift from the transitions.
  function tokenMs(name, fallback) {
    var raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    var n = parseFloat(raw);
    if (isNaN(n)) return fallback;
    return /ms$/.test(raw) ? n : n * 1000;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mount(container, opts) {
    var metals = opts.metals || [];
    var selected = opts.selected;
    var onSelect = opts.onSelect || function () {};
    var rows = [];
    var timers = [];

    container.innerHTML = "";
    container.classList.remove("is-switching");
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Metal");

    metals.forEach(function (metal) {
      var row = el("div", "product-metals__row");
      row.appendChild(el("span", "product-metals__tag", metal));

      var btn = el("button", "product-metals__option");
      btn.type = "button";
      btn.dataset.metal = metal;
      btn.setAttribute("aria-label", metal);
      // Which finish is selected is otherwise only a class and a dot — neither
      // reachable by a screen reader, on a control that changes the price.
      btn.addEventListener("click", function () {
        select(metal);
        onSelect(metal);
      });
      row.appendChild(btn);

      container.appendChild(row);
      rows.push({ metal: metal, row: row, btn: btn });
    });
    paintAria();
    paintRows();

    function paintAria() {
      rows.forEach(function (r) {
        r.btn.setAttribute("aria-pressed", String(r.metal === selected));
      });
    }

    function paintRows() {
      rows.forEach(function (r) {
        r.row.classList.toggle("is-selected", r.metal === selected);
      });
    }

    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function select(metal) {
      if (metal === selected) return;
      selected = metal;
      paintAria();
      clearTimers();

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        container.classList.remove("is-switching");
        paintRows();
        return;
      }

      // Re-read per change: cheap, and follows a token edited in devtools.
      var fadeOut = tokenMs("--fade-fast", 75);
      var resize = tokenMs("--metal-bar-resize", 250);
      container.classList.add("is-switching");
      timers.push(setTimeout(paintRows, fadeOut));
      timers.push(setTimeout(function () {
        container.classList.remove("is-switching");
      }, fadeOut + resize));
    }

    return { select: select };
  }

  window.EmjiveMetalPicker = { mount: mount };
})();
