/* ==========================================================================
   J&MV — selection storage
   Plain localStorage-backed selection, exposed as window.EmjiveSelection.
   Loaded on product.html (adds items), the floating selection bar (adds/
   removes items on every page), and launch-order.html (lists/removes them)
   before each page's own script.
   ========================================================================== */

(function (global) {
  "use strict";

  var STORAGE_KEY = "emjive_selection";

  // Where the selection lives once a localStorage write has failed (storage
  // blocked outright — Safari with all site data blocked throws on any
  // access — or over quota). Without it, a failed write would leave
  // readAll() still returning the old stored list: the bar and order page
  // would never show the item just added, and every index-based call below
  // would act on a list that no longer matches what's on screen. This keeps
  // the selection working for as long as the visitor stays on this page;
  // it can't follow them to the next one, since memory is all there is.
  // null while storage is working.
  var memoryItems = null;

  function readAll() {
    if (memoryItems) return memoryItems.slice();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeAll(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      memoryItems = null;
    } catch (e) {
      memoryItems = items.slice();
    }
  }

  // Lets any page-specific script (the floating selection bar especially)
  // react live to a change instead of needing a reload.
  function notify() {
    global.dispatchEvent(new CustomEvent("emjive:selection-changed"));
  }

  function getSelection() {
    return readAll();
  }

  // item: { series, productId, name, category, metal, size, price, image } —
  // a self-contained snapshot, so launch-order.html never needs to re-fetch/
  // join against any products.json to render itself.
  //
  // `series` is what makes productId meaningful: ids are only unique within
  // one series' catalog. Selections saved before it existed simply have no
  // series field, which is fine — nothing here reads it, and the one
  // consumer that keys off productId tolerates it being absent (see
  // itemKey() in js/selection-bar.js).
  function addItem(item) {
    var items = readAll();
    items.push(item);
    writeAll(items);
    notify();
    return items;
  }

  function removeItem(index) {
    var items = readAll();
    items.splice(index, 1);
    writeAll(items);
    notify();
    return items;
  }

  // Reinserts an item at a specific position — "Undo" after Unselect (the
  // order list and the bar's drawer, js/order-rows.js), so the item lands
  // back where it was rather than at the end the way addItem would.
  function insertItem(index, item) {
    var items = readAll();
    items.splice(index, 0, item);
    writeAll(items);
    notify();
    return items;
  }

  // Patches an existing item in place (the Modify sheet, js/modify-modal.js
  // — changing metal/size, and the price that comes with them — without
  // moving the item to the end of the list the way remove+add would).
  function updateItem(index, patch) {
    var items = readAll();
    if (!items[index]) return items;
    items[index] = Object.assign({}, items[index], patch);
    writeAll(items);
    notify();
    return items;
  }

  function clear() {
    writeAll([]);
    notify();
  }

  function formatPrice(price) {
    return price > 0 ? "€ " + price : "Price on request";
  }

  /* ---- sizes ---------------------------------------------------------------
     A size is whatever the visitor types into the one size field both sheets
     have (js/product.js's #sizeModal, js/modify-modal.js's #modifyModal) —
     there's no standard-size list to pick from any more. These three are
     the rules both fields share, so the two can't drift apart. */

  // The keystroke filter: digits and at most one decimal point, capped at
  // two decimal places (e.g. "59.43"). inputmode="decimal" on the element
  // is what actually triggers the numeric keypad on mobile; this backstops
  // desktop typing and paste. The comma-to-dot swap up front is for French
  // (and other comma-decimal) mobile keypads, whose decimal key sends "," —
  // without it, that keypress would just be stripped by the filter below
  // instead of registering as one.
  function sanitizeSizeInput(raw) {
    var cleaned = String(raw).replace(/,/g, ".").replace(/[^0-9.]/g, "");
    var firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "").slice(0, 2);
    }
    return cleaned;
  }

  // The one form a size is stored in. A field can legitimately hold "62."
  // mid-typing or ".5" off a keypad, and a decimal size always shows two
  // digits (62.5 -> "62.50") — storing it already padded means the order
  // rows, the drawer and a Modify pre-fill all read the same thing.
  // Returns "" for anything with no digits in it at all.
  function normalizeSize(raw) {
    var str = sanitizeSizeInput(raw == null ? "" : raw);
    var dot = str.indexOf(".");
    var whole = (dot === -1 ? str : str.slice(0, dot)).replace(/^0+(?=\d)/, "");
    var frac = dot === -1 ? "" : str.slice(dot + 1);
    if (!whole && !frac) return "";
    if (!whole) whole = "0";
    if (!frac) return whole;
    return whole + "." + (frac.length === 1 ? frac + "0" : frac);
  }

  // What gates Add and Save: an empty field, a lone "." or a zero can't be
  // ordered.
  function isValidSize(raw) {
    var size = normalizeSize(raw);
    return size !== "" && parseFloat(size) > 0;
  }

  // Appends a size value to `parent` as plain text, except a decimal
  // size's fractional part (e.g. "59.43") — that renders at half size
  // with the decimal point itself dropped, since every place this is
  // shown (the order rows and the drawer rows, js/order-rows.js) already
  // uses "." to separate .category.metal.size, and a literal decimal point
  // in the size itself would read as one more trait segment. See
  // .size-fraction in css/style.css. Always two digits (62.5 -> "62" + a
  // small "50"): normalizeSize() already stores them padded, so the
  // padding here is for selections saved before it did.
  function appendSize(parent, size) {
    var str = String(size);
    var dot = str.indexOf(".");
    if (dot === -1) {
      parent.appendChild(document.createTextNode(str));
      return;
    }
    parent.appendChild(document.createTextNode(str.slice(0, dot)));
    var digits = str.slice(dot + 1);
    if (!digits) return;
    var frac = document.createElement("span");
    frac.className = "size-fraction";
    frac.textContent = digits.length === 1 ? digits + "0" : digits;
    parent.appendChild(frac);
  }

  global.EmjiveSelection = {
    getSelection: getSelection,
    addItem: addItem,
    removeItem: removeItem,
    insertItem: insertItem,
    updateItem: updateItem,
    clear: clear,
    formatPrice: formatPrice,
    sanitizeSizeInput: sanitizeSizeInput,
    normalizeSize: normalizeSize,
    isValidSize: isValidSize,
    appendSize: appendSize
  };
})(window);
