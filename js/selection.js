// The selection (cart), in localStorage: window.EmjiveSelection. Also the
// shared price-by-size and size-input rules.

(function (global) {
  "use strict";

  var STORAGE_KEY = "emjive_selection";

  // The selection once a localStorage write has failed (blocked or over quota),
  // so this page keeps a consistent list; null while storage works.
  var memoryItems = null;

  // Stored as { v, items }. Bump when stored item fields change meaning (ids,
  // pricing): carts of another version are dropped rather than misread.
  var STORAGE_VERSION = 3;

  // localStorage can hold stale, hand-edited or corrupt entries: keep only
  // usable items and coerce the fields the UI computes with.
  function isSafeImagePath(path) {
    // Same-origin relative paths only (it ends up in an <img src>).
    return typeof path === "string" && path !== "" &&
      !/^[a-z][a-z0-9+.-]*:/i.test(path) && path.indexOf("//") !== 0;
  }

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.productId == null || raw.productId === "") return null;
    var price = Number(raw.price);
    var item = Object.assign({}, raw, {
      productId: String(raw.productId),
      name: raw.name == null ? "" : String(raw.name),
      category: raw.category == null ? "" : String(raw.category),
      metal: raw.metal == null ? "" : String(raw.metal),
      size: raw.size == null ? "" : String(raw.size),
      price: isFinite(price) && price > 0 ? price : 0,
      image: isSafeImagePath(raw.image) ? raw.image : ""
    });
    if (item.series != null) item.series = String(item.series);
    // The chosen design's key; absent for single-design products.
    if (item.design != null) item.design = String(item.design);
    return item;
  }

  function sanitizeItems(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var item = sanitizeItem(list[i]);
      if (item) out.push(item);
    }
    return out;
  }

  function readAll() {
    if (memoryItems) return memoryItems.slice();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== STORAGE_VERSION || !Array.isArray(parsed.items)) return [];
      return sanitizeItems(parsed.items);
    } catch (e) {
      return [];
    }
  }

  function writeAll(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, items: items }));
      memoryItems = null;
    } catch (e) {
      memoryItems = items.slice();
    }
  }

  // Another tab changed the cart ("storage" fires only in other documents, so
  // no loop). Ignored on the memory fallback.
  global.addEventListener("storage", function (e) {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    if (memoryItems) return;
    notify("sync");
  });

  // "emjive:selection-changed", dispatched synchronously from the changing call;
  // detail { action: "add" | "remove" | "insert" | "update" | "clear" | "sync", index }.
  // "insert" is only ever an Undo.
  function notify(action, index) {
    global.dispatchEvent(new CustomEvent("emjive:selection-changed", {
      detail: { action: action, index: index }
    }));
  }

  function getSelection() {
    return readAll();
  }

  // item: { series, productId, design, name, category, metal, size, price, image },
  // a self-contained snapshot (name and image are the chosen design's). series
  // qualifies productId, which is only unique within a series.
  function addItem(item) {
    var items = readAll();
    items.push(item);
    writeAll(items);
    notify("add", items.length - 1);
    return items;
  }

  function removeItem(index) {
    var items = readAll();
    items.splice(index, 1);
    writeAll(items);
    notify("remove", index);
    return items;
  }

  // Puts an item back at its index (the Modify sheet's Undo).
  function insertItem(index, item) {
    var items = readAll();
    items.splice(index, 0, item);
    writeAll(items);
    notify("insert", index);
    return items;
  }

  // Patches an item in place (the Modify sheet), keeping its position.
  function updateItem(index, patch) {
    var items = readAll();
    if (!items[index]) return items;
    items[index] = Object.assign({}, items[index], patch);
    writeAll(items);
    notify("update", index);
    return items;
  }

  function clear() {
    writeAll([]);
    notify("clear");
  }

  /* ---- telling one change from another ----
     The bar's icon strip and the order rows animate only the item a change
     touched, identified with these two. */

  // Stable across renders; `|| ""` covers items without a series or design.
  function itemKey(item) {
    return (item.series || "") + "|" + item.productId + "|" + (item.design || "") + "|" + item.metal + "|" + item.size;
  }

  // The single change from oldKeys to keys: an insert or removal at `index`, or
  // (same length) updates in place. null otherwise.
  function singleChange(oldKeys, keys) {
    if (keys.length === oldKeys.length) return { type: "update" };
    if (Math.abs(keys.length - oldKeys.length) !== 1) return null;
    var longer = keys.length > oldKeys.length ? keys : oldKeys;
    var shorter = longer === keys ? oldKeys : keys;
    var i = 0;
    while (i < shorter.length && shorter[i] === longer[i]) i++;
    for (var j = i; j < shorter.length; j++) {
      if (shorter[j] !== longer[j + 1]) return null;
    }
    return { type: longer === keys ? "insert" : "remove", index: i };
  }

  function formatPrice(price) {
    return price > 0 ? "€ " + price : "TBD";
  }

  /* ---- prices by size ----
     per-metal-specs prices are at REFERENCE_SIZE_MM (62 mm) and scale
     linearly: priceAt(size) = price x size / 62, whole euros, size clamped to
     "size-range". A price of 0 means "TBD". */
  var REFERENCE_SIZE_MM = 62;
  var DEFAULT_SIZE_RANGE = { min: 40, max: 80 };

  function sizeRange(product) {
    var range = (product && product["size-range"]) || {};
    var min = Number(range.min);
    var max = Number(range.max);
    return isFinite(min) && isFinite(max) && min > 0 && max >= min
      ? { min: min, max: max }
      : { min: DEFAULT_SIZE_RANGE.min, max: DEFAULT_SIZE_RANGE.max };
  }

  // `size` may be a number or a typed string.
  function priceAt(product, metal, size) {
    var specs = product && product["per-metal-specs"] && product["per-metal-specs"][metal];
    var base = specs && specs.price;
    if (!(base > 0)) return 0;
    var mm = parseFloat(size);
    if (!isFinite(mm) || mm <= 0) return 0;
    var range = sizeRange(product);
    mm = Math.min(Math.max(mm, range.min), range.max);
    return Math.round(base * mm / REFERENCE_SIZE_MM);
  }

  function priceRange(product, metal) {
    var range = sizeRange(product);
    return { min: priceAt(product, metal, range.min), max: priceAt(product, metal, range.max) };
  }

  // Lowest price over one metal, or over every priced metal. 0 if none is priced.
  function priceFrom(product, metal) {
    var specs = (product && product["per-metal-specs"]) || {};
    var low = 0;
    (metal ? [metal] : Object.keys(specs)).forEach(function (m) {
      var price = priceRange(product, m).min;
      if (price > 0 && (!low || price < low)) low = price;
    });
    return low;
  }

  function formatPriceFrom(price) {
    return price > 0 ? "from " + formatPrice(price) : "TBD";
  }

  function formatPriceRange(range) {
    if (!(range.max > 0)) return "TBD";
    if (range.min === range.max) return formatPrice(range.min);
    return "€ " + range.min + " – " + range.max;
  }

  /* ---- sizes: rules shared by the size fields of #sizeModal and #modifyModal ---- */

  // Keystroke filter: digits and one decimal point, two decimals at most.
  // Commas become dots (comma-decimal mobile keypads).
  function sanitizeSizeInput(raw) {
    var cleaned = String(raw).replace(/,/g, ".").replace(/[^0-9.]/g, "");
    var firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "").slice(0, 2);
    }
    return cleaned;
  }

  // The stored form: a decimal size always has two digits (62.5 -> "62.50").
  // "" when there are no digits.
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

  // Gates Add and Save: empty, "." or zero can't be ordered.
  function isValidSize(raw) {
    var size = normalizeSize(raw);
    return size !== "" && parseFloat(size) > 0;
  }

  // Appends a size as text, its decimals as a small .size-fraction without the
  // point: "." already separates .category.metal.size in the rows.
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

  // Builds a category's "size-guide" ({ how, head, rows }) into `container`.
  // false when there is no guide (then no "Find my size" button).
  function fillSizeGuide(container, guide) {
    container.innerHTML = "";
    if (!guide || !guide.rows || !guide.rows.length) return false;
    (guide.how || []).forEach(function (paragraph) {
      var how = document.createElement("p");
      how.className = "size-guide__how";
      how.textContent = paragraph;
      container.appendChild(how);
    });
    // Transposed: one table row per head label, one column per size. Scrolls when too wide.
    var table = document.createElement("table");
    table.className = "size-guide__table";
    var tbody = document.createElement("tbody");
    (guide.head || []).forEach(function (label, column) {
      var tr = document.createElement("tr");
      var th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      tr.appendChild(th);
      guide.rows.forEach(function (row) {
        var td = document.createElement("td");
        td.textContent = row[column];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    var scroll = document.createElement("div");
    scroll.className = "size-guide__scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Size chart");
    scroll.appendChild(table);
    container.appendChild(scroll);
    return true;
  }

  global.EmjiveSelection = {
    fillSizeGuide: fillSizeGuide,
    getSelection: getSelection,
    addItem: addItem,
    removeItem: removeItem,
    insertItem: insertItem,
    updateItem: updateItem,
    clear: clear,
    formatPrice: formatPrice,
    priceFrom: priceFrom,
    formatPriceFrom: formatPriceFrom,
    formatPriceRange: formatPriceRange,
    REFERENCE_SIZE_MM: REFERENCE_SIZE_MM,
    sizeRange: sizeRange,
    priceAt: priceAt,
    priceRange: priceRange,
    sanitizeSizeInput: sanitizeSizeInput,
    normalizeSize: normalizeSize,
    isValidSize: isValidSize,
    appendSize: appendSize,
    itemKey: itemKey,
    singleChange: singleChange
  };
})(window);
