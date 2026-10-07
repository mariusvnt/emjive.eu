/* ==========================================================================
   em·ji·ve — metal picker

   Shared by the product page (js/product.js) and the Modify sheet
   (js/modify-modal.js, built on every page): one square per metal, showing
   its swatch, a dot in the middle of the selected one, and the selected
   metal's name beside them. The squares never change on a pick; only the dot
   and the name move. Both used
   to build and update the same markup separately; loaded on all seven pages
   for the same reason js/modify-modal.js is, ahead of it.

   window.EmjiveMetalPicker.mount(container, { metals, selected, onSelect, row })
   fills `container` (the .product-metals box) and returns { select(metal) }.

   The selected square carries a dot (CSS, from aria-pressed). The squares
   stack vertically, and the one name — the selected metal's —
   stands to the right of its square: a pick only moves it to the new square's
   row (--metal-index on the picker, which css/style.css turns into a
   position). With `row: true` (the Modify sheet) the squares lie side by side
   instead, and the name stands once, to the right of the last of them;
   the product page switches the same markup to that arrangement for its
   specs stage (.is-specs-layout, js/product.js). The page puts the
   "Material" label by it, in the label | value tables the specs and the two
   size sheets share. The squares' pictures are
   assets/metal-sample_<metal>.webp, made by scripts/auto-render.js at the
   size they are shown.

   A click calls onSelect(metal) at once — the model, price and images behind
   the picker must not wait on an animation — and the picker moves its name
   to the new square in the same tick. Updated in place, never rebuilt, so
   keyboard focus stays on the square just pressed. aria-pressed flips with
   it. select(metal) is the same change without the onSelect call,
   for callers that already know the metal.
   ========================================================================== */

(function () {
  "use strict";

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
    var options = [];

    container.innerHTML = "";
    container.classList.toggle("product-metals--row", !!opts.row);
    container.style.setProperty("--metal-count", String(metals.length));
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Material");

    metals.forEach(function (metal) {
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
      container.appendChild(btn);
      options.push({ metal: metal, btn: btn });
    });
    // The selected metal's name: one element, moved (and re-worded) on a pick.
    var tag = el("span", "product-metals__tag");
    tag.setAttribute("aria-hidden", "true");
    container.appendChild(tag);
    paint();

    function paint() {
      options.forEach(function (o) {
        o.btn.setAttribute("aria-pressed", String(o.metal === selected));
      });
      tag.textContent = selected || "";
      container.style.setProperty("--metal-index", String(Math.max(0, metals.indexOf(selected))));
    }

    function select(metal) {
      if (metal === selected) return;
      selected = metal;
      paint();
    }

    return { select: select };
  }

  window.EmjiveMetalPicker = { mount: mount };
})();
