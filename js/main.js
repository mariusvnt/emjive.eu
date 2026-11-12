// Site-wide behaviour on every page: the header menu, the category filter
// row and its link to the homepage gallery, and the chromatic-aberration filter.

(function () {
  "use strict";

  /* ---- chromatic aberration (Chromium only) ----
     The blurred bars split red and blue with an SVG backdrop-filter, which only
     Chromium applies to a backdrop. Detected by userAgentData brands (no WebKit
     browser has them); sets .has-backdrop-svg on <html> for the CSS. */
  (function () {
    var data = navigator.userAgentData;
    if (!(data && data.brands && data.brands.some(function (b) { return b.brand === "Chromium"; }))) return;
    var NS = "http://www.w3.org/2000/svg";
    function node(tag, attrs, parent) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (parent) parent.appendChild(n);
      return n;
    }
    function channel(which, values) {
      return { "in": "SourceGraphic", type: "matrix", values: values, result: which };
    }
    var svg = node("svg", { width: "0", height: "0", "aria-hidden": "true", focusable: "false" });
    svg.style.position = "absolute";
    // Red one way, blue the other along `axis` ("dy" or "dx"); `flip` swaps
    // them; `amount` in px (default 1.5).
    function aberration(id, axis, flip, amount) {
      var d = String(amount || 1.5);
      var filter = node("filter", { id: id, x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" }, svg);
      var red = { "in": "r", result: "rShifted" };
      var blue = { "in": "b", result: "bShifted" };
      red[axis] = flip ? d : "-" + d;
      blue[axis] = flip ? "-" + d : d;
      node("feColorMatrix", channel("r", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"), filter);
      node("feOffset", red, filter);
      node("feColorMatrix", channel("g", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"), filter);
      node("feColorMatrix", channel("b", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"), filter);
      node("feOffset", blue, filter);
      node("feBlend", { "in": "rShifted", in2: "g", mode: "screen", result: "rg" }, filter);
      node("feBlend", { "in": "rg", in2: "bShifted", mode: "screen" }, filter);
    }
    aberration("emjiveAberration", "dy");
    // The product page's bottom veil also uses 0.75px and 3px strengths.
    aberration("emjiveAberrationS", "dy", false, 0.75);
    aberration("emjiveAberration3", "dy", false, 3);
    document.body.appendChild(svg);
    document.documentElement.classList.add("has-backdrop-svg");
  })();

  /* ---- header menu ---- */

  var menuToggle = document.getElementById("menuToggle");
  var siteHeaderMenu = document.getElementById("siteHeaderMenu");
  var siteHeader = document.querySelector(".site-header");
  var siteHeaderRow = document.querySelector(".site-header__row");

  // For window.EmjiveMenus (js/series.js) click-away handling; root is the
  // whole header so the toggle itself never counts as "away".
  var headerMenuPanel = {
    root: siteHeader,
    close: function () { setHeaderMenuOpen(false); },
    returnFocus: menuToggle
  };

  function setHeaderMenuOpen(isOpen) {
    menuToggle.classList.toggle("is-open", isOpen);
    siteHeaderMenu.classList.toggle("is-open", isOpen);
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    if (window.EmjiveMenus) {
      if (isOpen) window.EmjiveMenus.opened(headerMenuPanel);
      else window.EmjiveMenus.closed(headerMenuPanel);
    }
  }

  // Only the gallery filters in place; elsewhere a category click navigates there.
  var filtersAreInPlace = !!document.getElementById("productGrid");

  if (menuToggle && siteHeaderMenu) {
    menuToggle.addEventListener("click", function () {
      setHeaderMenuOpen(!menuToggle.classList.contains("is-open"));
    });

    // Empty space in the header row toggles the menu too.
    if (siteHeaderRow) {
      siteHeaderRow.addEventListener("click", function (e) {
        if (e.target.closest(".site-header__brand") || e.target.closest(".menu-toggle")) return;
        setHeaderMenuOpen(!menuToggle.classList.contains("is-open"));
      });
    }

    // Delegated: the category links are rendered later.
    siteHeaderMenu.addEventListener("click", function (e) {
      var link = e.target.closest("a");
      if (!link || !siteHeaderMenu.contains(link)) return;

      if (link.classList.contains("is-cat")) {
        // The menu stays open on the gallery so several categories can be toggled.
        if (!filtersAreInPlace) return;
        e.preventDefault();
        toggleCategory(link.dataset.cat);
        return;
      }

      setHeaderMenuOpen(false);
    });
  }

  /* ---- header category filter ---- */

  // Rendered from the active series' categories (?series=, else the featured one).
  var filterOptions = document.getElementById("headerFilterOptions");
  var filterRow = document.getElementById("siteHeaderFilter");
  var filterLabel = filterRow && filterRow.querySelector(".site-header__filter-label");
  var activeCats = [];

  function parseCatsFromQuery(valid) {
    var raw = new URLSearchParams(window.location.search).get("cat");
    if (!raw) return [];
    // Unknown values are dropped, so a typo shows everything instead of nothing.
    return raw.split(",")
      .map(function (c) { return c.trim(); })
      .filter(function (c) { return c && valid.indexOf(c) !== -1; });
  }

  function buildFilterHref(cat) {
    // Keeps ?series=.
    var url = new URL("/", window.location.href);
    var series = window.EmjiveSeries.slug;
    if (series && !window.EmjiveSeries.isFeatured(series)) {
      url.searchParams.set("series", series);
    }
    url.searchParams.set("cat", cat);
    return url.pathname + url.search + "#products";
  }

  function renderHeaderFilter() {
    if (!filterOptions) return;
    filterOptions.innerHTML = "";

    if (!filtersAreInPlace) {
      // Off the gallery the row is a plain "Gallery" link.
      if (filterRow) filterRow.hidden = false;
      if (filterLabel) filterLabel.hidden = true;
      var galleryLink = document.createElement("a");
      galleryLink.className = "is-info";
      galleryLink.textContent = "Gallery";
      galleryLink.href = window.EmjiveSeries.mainHref(window.EmjiveSeries.slug) + "#products";
      filterOptions.appendChild(galleryLink);
      return;
    }

    var cats = window.EmjiveSeries.categories();
    // No categories: hidden. One: shown inert and selected, without the label.
    if (filterRow) filterRow.hidden = cats.length === 0;
    if (filterLabel) filterLabel.hidden = cats.length <= 1;

    if (cats.length === 1) {
      // No href: an <a> without one is neither clickable nor focusable.
      var soleTag = document.createElement("a");
      soleTag.className = "is-cat is-active";
      soleTag.textContent = cats[0];
      filterOptions.appendChild(soleTag);
      return;
    }

    cats.forEach(function (cat) {
      // Real links, so middle-click and new tabs work; the gallery intercepts them.
      var link = document.createElement("a");
      link.className = "is-cat";
      link.dataset.cat = cat;
      link.textContent = cat;
      link.href = buildFilterHref(cat);
      filterOptions.appendChild(link);
    });
    syncFilterButtons();
  }

  function syncFilterButtons() {
    if (!filterOptions) return;
    filterOptions.querySelectorAll("a.is-cat").forEach(function (link) {
      var on = activeCats.indexOf(link.dataset.cat) !== -1;
      link.classList.toggle("is-active", on);
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  }

  /* ---- filtering the gallery ----
     EmjiveGallery.setFilter() (js/gallery.js) hides non-matching items and
     returns per-category counts; before products load it applies the filter
     later and reports counts via "emjive:gallery-filtered". */
  var gallery = filtersAreInPlace ? window.EmjiveGallery : null;

  // Styling hooks for empty categories (data-count, .is-empty).
  function markCounts(counts) {
    if (!filterOptions || !counts) return;
    filterOptions.querySelectorAll("a.is-cat").forEach(function (link) {
      var n = counts[link.dataset.cat] || 0;
      link.dataset.count = String(n);
      link.classList.toggle("is-empty", n === 0);
    });
  }

  function applyFilter() {
    if (gallery) {
      markCounts(gallery.setFilter(activeCats, function () { setCategories([]); }));
    }
    syncFilterButtons();
  }

  if (gallery) {
    window.addEventListener("emjive:gallery-filtered", function (e) {
      markCounts(e.detail && e.detail.counts);
    });
  }

  function syncFilterUrl() {
    var url = new URL(window.location.href);
    if (activeCats.length) url.searchParams.set("cat", activeCats.join(","));
    else url.searchParams.delete("cat");
    // Passes history.state through: it holds js/scroll-memory.js's entry token.
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }

  function setCategories(next) {
    activeCats = next;
    applyFilter();
    syncFilterUrl();
  }

  function toggleCategory(cat) {
    if (!cat) return;
    var i = activeCats.indexOf(cat);
    setCategories(i === -1
      ? activeCats.concat([cat])
      : activeCats.filter(function (c) { return c !== cat; }));
  }

  // The filter row renders on every page, hence categories live in data/series.json.
  window.EmjiveSeries.ready
    .then(function () {
      activeCats = parseCatsFromQuery(window.EmjiveSeries.categories());
      renderHeaderFilter();
      // A ?cat= from a link: the gallery applies it once its products are in.
      if (gallery) applyFilter();
    })
    // The row simply stays empty; log rather than leave an unhandled rejection.
    .catch(function (err) {
      console.error("emjive: could not render the header filter row", err);
    });

  /* ---- contact form stub ---- */

  var contactForm = document.getElementById("contactForm");
  if (contactForm) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      alert("This form isn't available yet.");
    });
  }
})();
