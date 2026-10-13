/* ==========================================================================
   J&MV — site behaviour
   The header (menu, category filter row), the page-wide helpers below, and
   the filter's link to the homepage gallery. Loads on every page.

   Owns no gallery and no hero: the homepage's stack and grid are
   js/gallery.js and js/gallery-stack.js, and the hero is per-series, in that
   series' own bundle (series/<slug>/hero.js), injected by js/series.js — see
   dev-guidelines/client-scripts.md.
   ========================================================================== */

(function () {
  "use strict";

  /* ---- chromatic aberration (Chromium only) ------------------------------
     The blurred strips (the product page's title bar, the Select bar, the
     checkout bar: css/style.css) split red and blue a pixel and a half apart,
     vertically (the product page's band over its bottom bars at three
     strengths), with an SVG filter used as a backdrop-filter — which only
     Chromium runs on a backdrop. A browser with that engine says so in its
     brands (Chrome, Edge, Brave...; none of the WebKit browsers, iPhone's
     Chrome among them, has them): it gets the filter in the page and
     .has-backdrop-svg on <html>, which the CSS keys the layers on; the others
     get the blur alone. */
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
    // Red goes one way and blue the other, along `axis`: "dy" splits them
    // vertically, "dx" sideways; `flip` swaps which goes which way; `amount`
    // is how far each goes, in px (1.5 unless given).
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
    // The product page's band over the bottom bars (css/style.css
    // .product-bottom-veil) has three strengths, the 1.5px above among them:
    // 0.75px, and 3px nearest the bars.
    aberration("emjiveAberrationS", "dy", false, 0.75);
    aberration("emjiveAberration3", "dy", false, 3);
    document.body.appendChild(svg);
    document.documentElement.classList.add("has-backdrop-svg");
  })();

  /* ---- header menu toggle ------------------------------------------------- */

  var menuToggle = document.getElementById("menuToggle");
  var siteHeaderMenu = document.getElementById("siteHeaderMenu");
  var siteHeader = document.querySelector(".site-header");
  var siteHeaderRow = document.querySelector(".site-header__row");

  // Registered with window.EmjiveMenus (js/series.js) so a click away from
  // the header closes it — root spans the whole header (toggle included),
  // not just the menu panel, so clicking the toggle itself is never
  // mistaken for "away" by that shared listener.
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

  // Only this page can filter in place; everywhere else a category click is
  // a real navigation back to the grid.
  var filtersAreInPlace = !!document.getElementById("productGrid");

  if (menuToggle && siteHeaderMenu) {
    menuToggle.addEventListener("click", function () {
      setHeaderMenuOpen(!menuToggle.classList.contains("is-open"));
    });

    // The empty space in the header row (outside the brand logo and the
    // toggle button itself, both of which already have their own handlers
    // — the logo navigates home, the toggle would otherwise double-fire)
    // toggles the menu too, same as clicking the +/- icon.
    if (siteHeaderRow) {
      siteHeaderRow.addEventListener("click", function (e) {
        if (e.target.closest(".site-header__brand") || e.target.closest(".menu-toggle")) return;
        setHeaderMenuOpen(!menuToggle.classList.contains("is-open"));
      });
    }

    // Delegated rather than bound per link: the category buttons are
    // rendered from data after this runs, so a per-link listener would
    // never reach them.
    siteHeaderMenu.addEventListener("click", function (e) {
      var link = e.target.closest("a");
      if (!link || !siteHeaderMenu.contains(link)) return;

      if (link.classList.contains("is-cat")) {
        // On the grid page the menu deliberately stays OPEN — multi-select
        // is unusable if it closes after every toggle. Elsewhere, fall
        // through to the link's own href and let it navigate.
        if (!filtersAreInPlace) return;
        e.preventDefault();
        toggleCategory(link.dataset.cat);
        return;
      }

      setHeaderMenuOpen(false);
    });
  }

  /* ---- header category filter -------------------------------------------- */

  // Categories are per-series: each series declares its own subset of the
  // global vocabulary, so this row is rendered from the ACTIVE series
  // (?series=, else the featured one) rather than a fixed list. That's also
  // the series a click will land on, so the buttons never advertise a
  // category the destination can't show.
  var filterOptions = document.getElementById("headerFilterOptions");
  var filterRow = document.getElementById("siteHeaderFilter");
  var filterLabel = filterRow && filterRow.querySelector(".site-header__filter-label");
  var activeCats = [];

  function parseCatsFromQuery(valid) {
    var raw = new URLSearchParams(window.location.search).get("cat");
    if (!raw) return [];
    // Unknown values are dropped rather than left to match nothing, so a
    // typo — or a category belonging to some other series — shows
    // everything instead of an empty grid.
    return raw.split(",")
      .map(function (c) { return c.trim(); })
      .filter(function (c) { return c && valid.indexOf(c) !== -1; });
  }

  function buildFilterHref(cat) {
    // Built off the gallery's own address (the same one mainHref() gives) so
    // ?series= is preserved.
    var url = new URL("/gallery", window.location.href);
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
      // Every page but the grid: the row becomes a plain "back to the
      // gallery" link instead of a filter — category count is irrelevant
      // here, so this is unconditional. Never dotted — only category tags
      // carry a selection state (see css/style.css).
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
    // Zero categories: nothing to show at all. Exactly one: nothing to
    // actually filter either — toggling the sole tag can never change what
    // the grid shows — so "Filter gallery by" is dropped and the bare tag
    // renders permanently dotted and inert instead of interactive.
    if (filterRow) filterRow.hidden = cats.length === 0;
    if (filterLabel) filterLabel.hidden = cats.length <= 1;

    if (cats.length === 1) {
      // No href, no click listener: an <a> with no href is natively
      // unclickable/unfocusable, so that alone is enough to make this
      // inert — no separate markup shape needed, and it still matches
      // every .site-header__nav a.is-cat rule in css/style.css.
      var soleTag = document.createElement("a");
      soleTag.className = "is-cat is-active";
      soleTag.textContent = cats[0];
      filterOptions.appendChild(soleTag);
      return;
    }

    cats.forEach(function (cat) {
      // Real <a href>, not <button>, on every page: that keeps middle-click
      // and open-in-new-tab working, with the in-place toggle layered on
      // top via preventDefault() where the grid exists. No "." prefix —
      // the selection dot (css/style.css) already carries that signal, a
      // second one in the text itself would be redundant.
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

  /* ---- filtering the gallery --------------------------------------------
     The gallery itself — the stack, the grid and both their renderings — is
     js/gallery.js's; this file owns only the filter row and the address.
     A category toggle goes to EmjiveGallery.setFilter(), which hides what
     doesn't match in whichever view is showing (never rebuilding anything)
     and answers with how many products each category has, the styling hook
     below. Before the products have loaded it keeps the categories and
     applies them once they have, reporting the counts then through
     "emjive:gallery-filtered". */
  var gallery = filtersAreInPlace ? window.EmjiveGallery : null;

  // A styling hook only — nothing renders differently for these yet, but
  // it lets a zero-product category be dimmed later without touching JS.
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
    // new URL(location.href) keeps ?series= and the site's base path intact
    // for free, and replaceState avoids stacking a history entry per toggle.
    // history.state is passed back through rather than nulled: it carries
    // js/scroll-memory.js's per-entry token, and wiping it here would make
    // this entry forget where it was scrolled to on the next category
    // toggle.
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

  // The header's filter row renders on EVERY page, including the ones that
  // load no product data at all — which is exactly why the category list
  // lives in data/series.json's index rather than inside a products file.
  window.EmjiveSeries.ready
    .then(function () {
      activeCats = parseCatsFromQuery(window.EmjiveSeries.categories());
      renderHeaderFilter();
      // A ?cat= arrived at from another page (or a shared link): the gallery
      // keeps it until its products are in.
      if (gallery) applyFilter();
    })
    // The gallery reports its own failed load in the page itself; this one
    // has nowhere to put a message — the filter row simply stays empty,
    // which is the correct degraded state. What it must NOT do is leave an
    // unhandled rejection: this runs on all seven pages, including the four
    // that load no product data at all, so a broken data/series.json would
    // otherwise surface only as a console error with no indication of which
    // chain produced it.
    .catch(function (err) {
      console.error("emjive: could not render the header filter row", err);
    });

  /* ---- contact form stub -------------------------------------------------- */

  var contactForm = document.getElementById("contactForm");
  if (contactForm) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      alert("This form isn't connected yet. Wire it up to a form service (Formspree, Netlify Forms, etc.) — see README.");
    });
  }
})();
