/* ==========================================================================
   em·ji·ve — metal picker

   Shared by the product page (js/product.js) and the Modify sheet
   (js/modify-modal.js, built on every page): one square per metal, showing
   its swatch, and the selected metal's name — a dot + the name — beside
   them. The squares never change on a pick; only the name moves. Both used
   to build and update the same markup separately; loaded on all seven pages
   for the same reason js/modify-modal.js is, ahead of it.

   window.EmjiveMetalPicker.mount(container, { metals, selected, onSelect, row })
   fills `container` (the .product-metals box) and returns { select(metal) }.

   The squares stack vertically, and each row carries its own name to the
   right of its square — the selected row's shown, the others' hidden, so a
   pick crossfades the name from one row to the next. With `row: true` (the
   Modify sheet) the squares lie side by side instead, and the name is shown
   once, to the right of the last of them — css/style.css lays the three
   names on one spot there; the product page switches the same markup to that
   arrangement for its specs stage (.is-specs-layout, js/product.js). The
   page puts the "Material" label by it, in the label | value tables the
   specs and the two size sheets share.

   A click calls onSelect(metal) at once — the model, price and images behind
   the picker must not wait on an animation — and the picker moves
   .is-selected to the new square in the same tick. Updated in place, never
   rebuilt, so keyboard focus stays on the square just pressed. aria-pressed
   flips with it. select(metal) is the same change without the onSelect call,
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
    var rows = [];

    container.innerHTML = "";
    container.classList.toggle("product-metals--row", !!opts.row);
    container.style.setProperty("--metal-count", String(metals.length));
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Material");

    metals.forEach(function (metal) {
      var row = el("div", "product-metals__row");

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
      row.appendChild(el("span", "product-metals__tag", metal));

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

    function select(metal) {
      if (metal === selected) return;
      selected = metal;
      paintAria();
      paintRows();
    }

    return { select: select };
  }

  window.EmjiveMetalPicker = { mount: mount };
})();
