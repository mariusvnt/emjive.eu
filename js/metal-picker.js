/* ==========================================================================
   em·ji·ve — metal picker

   Shared by the product page (js/product.js) and the Modify sheet
   (js/modify-modal.js, built on every page): a "Material" label at the
   left (the size field's layout), and at the right one vertical bar per
   metal, side by side, the active one stretched and the others shrunk, with
   a dot + the metal's name to the left of the stack. Both used to build and
   update the same markup separately; loaded on all seven pages for the same reason
   js/modify-modal.js is, ahead of it.

   window.EmjiveMetalPicker.mount(container, { metals, selected, onSelect, layout })
   fills `container` (the .product-metals box) and returns { select(metal) }.

   layout: "stack" (the product page's) is the other arrangement of the same
   control: a vertical stack of squares, and each row carries its own dot +
   name to the right of its square — the active row's shown, the others'
   hidden, so a pick crossfades the name from one row to the next. The
   squares themselves never change. No "Material" label here (the page has
   its own).
   The default layout is the Modify sheet's.
   A click calls onSelect(metal) at once — the model, price and images behind
   the picker must not wait on an animation — and the picker moves
   .is-selected to the new bar in the same tick: the dot + label switch
   instantly (no fade), and only the bars animate, resizing via a CSS
   transition (see css/style.css). Updated in place, never rebuilt, so
   keyboard focus stays on the bar just pressed. aria-pressed flips with it.
   select(metal) is the same change without the onSelect call, for callers
   that already know the metal.
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
    var edge = opts.layout === "stack";
    var rows = [];

    container.innerHTML = "";
    container.classList.toggle("product-metals--stack", edge);
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Material");

    // The one tag (retexted on a pick) of the default layout; the edge layout
    // has a tag per row instead.
    var tag = null;
    var stack = container;
    if (!edge) {
      var label = el("span", "product-metals__label", "Material");
      label.setAttribute("aria-hidden", "true");
      var field = el("div", "product-metals__field");
      tag = el("span", "product-metals__tag");
      stack = el("div", "product-metals__stack");
      field.appendChild(tag);
      field.appendChild(stack);
      container.appendChild(label);
      container.appendChild(field);
    }

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
      if (edge) row.appendChild(el("span", "product-metals__tag", metal));

      stack.appendChild(row);
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
      if (tag) tag.textContent = selected || "";
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
