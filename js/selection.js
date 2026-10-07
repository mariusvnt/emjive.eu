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

  // Stored shape: { v: STORAGE_VERSION, items: [...] }. The version is what
  // lets a future change to an item's fields migrate old carts instead of
  // guessing. The original format — a bare array of items, written by every
  // release before this one — is still read (as "version 0") and is simply
  // rewritten in the new shape on the next write.
  var STORAGE_VERSION = 1;

  // localStorage is writable by anything on the origin and survives across
  // deploys, so what comes back can be stale, hand-edited or corrupt. One bad
  // entry (null, a string, an item with no productId) used to throw inside
  // itemKey() and take the bar and the whole order page down with it. This
  // keeps only entries that are usable and coerces the fields the UI does
  // arithmetic or string-building on.
  function isSafeImagePath(path) {
    // A same-origin relative path only: no scheme (javascript:, data:,
    // https:) and no protocol-relative "//host" — it ends up in an <img src>.
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
      var list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : []);
      return sanitizeItems(list);
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

  // Another tab changed the cart: tell this one, so the bar and the order
  // page don't keep showing a list that no longer matches storage. (The
  // "storage" event only fires in OTHER documents, so this can't loop with
  // notify() below.) Ignored while the memory fallback is in charge, since
  // storage isn't this page's source of truth then.
  global.addEventListener("storage", function (e) {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    if (memoryItems) return;
    notify("sync");
  });

  // Lets any page-specific script (the floating selection bar especially)
  // react live to a change instead of needing a reload. Dispatched
  // synchronously, from inside the call that changed storage. detail says
  // which change it was — { action: "add" | "remove" | "insert" | "update" |
  // "clear", index } — for the listeners that animate the one item that
  // moved: an "insert" is only ever an Undo (see insertItem), which puts an
  // item back the way it left rather than arriving like a new one.
  function notify(action, index) {
    global.dispatchEvent(new CustomEvent("emjive:selection-changed", {
      detail: { action: action, index: index }
    }));
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
  // place that keys off productId tolerates it being absent (see itemKey()
  // below).
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

  // Reinserts an item at a specific position — the bar's "Undo" after an
  // Unselect in the Modify sheet (js/modify-modal.js), so the item lands
  // back where it was rather than at the end the way addItem would.
  function insertItem(index, item) {
    var items = readAll();
    items.splice(index, 0, item);
    writeAll(items);
    notify("insert", index);
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
    notify("update", index);
    return items;
  }

  function clear() {
    writeAll([]);
    notify("clear");
  }

  /* ---- telling one change from another ------------------------------------
     Both lists that show the selection — the floating bar's icon strip and
     the item rows (js/selection-bar.js, js/order-rows.js) — animate only the
     one item a change touched rather than rebuilding, and both work out
     which item that was the same way, from these two. */

  // productId is only unique within a series, hence the series prefix. The
  // `|| ""` covers selections saved before that field existed: it keeps
  // their key stable across renders, so an existing cart doesn't read as
  // all-new and replay every entrance animation.
  function itemKey(item) {
    return (item.series || "") + "|" + item.productId + "|" + item.metal + "|" + item.size;
  }

  // Which single change turns oldKeys into keys: one item inserted at
  // `index` (an Add pushes at the end, an Undo puts one back where it was),
  // one removed from `index`, or — same length — items updated in place (a
  // Modify changes a key without moving it). null for anything else.
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

  // The size guide (the product page's specs stage, the two size sheets):
  // `guide` is the category's "size-guide" in data/series.json — { how, head,
  // rows: one a size } — built into `container` as a few words and a table. Returns
  // whether there was anything to build (a category with no guide gets no
  // button).
  function fillSizeGuide(container, guide) {
    container.innerHTML = "";
    if (!guide || !guide.rows || !guide.rows.length) return false;
    var how = document.createElement("p");
    how.className = "size-guide__how";
    how.textContent = guide.how || "";
    container.appendChild(how);
    // Turned: the data has a row a size (and a head naming the columns), the
    // table a row a fact — its label first, then one column a size: three
    // rows. Wider than its room, it scrolls on its own.
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

  // Wires a size guide's button to its panel: the button opens and closes it
  // (.is-open on the panel, aria-expanded on the button), and so does a click
  // anywhere else. opts: { toggle, panel, onToggle(open) }. Returns
  // { close(), isOpen() }.
  function wireSizeGuide(opts) {
    var open = false;
    function set(next) {
      if (next === open) return;
      open = next;
      opts.panel.classList.toggle("is-open", open);
      opts.toggle.setAttribute("aria-expanded", String(open));
      if (open) document.addEventListener("click", away);
      else document.removeEventListener("click", away);
      if (opts.onToggle) opts.onToggle(open);
    }
    function away(e) {
      if (opts.toggle.contains(e.target) || opts.panel.contains(e.target)) return;
      set(false);
    }
    opts.toggle.addEventListener("click", function () { set(!open); });
    return { close: function () { set(false); }, isOpen: function () { return open; } };
  }

  global.EmjiveSelection = {
    fillSizeGuide: fillSizeGuide,
    wireSizeGuide: wireSizeGuide,
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
    appendSize: appendSize,
    itemKey: itemKey,
    singleChange: singleChange
  };
})(window);
