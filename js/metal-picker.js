// Metal picker: one swatch square per metal, a dot on the selected one, its
// name beside it. Shared by js/product.js and js/modify-modal.js.
//
// window.EmjiveMetalPicker.mount(container, { metals, selected, onSelect, row })
//   -> { select(metal) }  (select() does not call onSelect)
// Updated in place, never rebuilt, so focus stays on the pressed square.

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
      btn.addEventListener("click", function () {
        select(metal);
        onSelect(metal);
      });
      container.appendChild(btn);
      options.push({ metal: metal, btn: btn });
    });
    // The selected metal's name; CSS places it from --metal-index.
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
