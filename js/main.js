// Site-wide behaviour on every page: the header menu and the chromatic-aberration filter.

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
    // them; `amount` in px (default 1.5). A shift leaves its channel empty
    // along one edge (no blue on top: a yellow line), so each shifted
    // channel lies over its unshifted one.
    function aberration(id, axis, flip, amount) {
      var d = String(amount || 1.5);
      var filter = node("filter", { id: id, x: "0", y: "0", width: "100%", height: "100%", "color-interpolation-filters": "sRGB" }, svg);
      var red = { "in": "r", result: "rMoved" };
      var blue = { "in": "b", result: "bMoved" };
      red[axis] = flip ? d : "-" + d;
      blue[axis] = flip ? "-" + d : d;
      node("feColorMatrix", channel("r", "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"), filter);
      node("feOffset", red, filter);
      node("feComposite", { "in": "rMoved", in2: "r", operator: "over", result: "rShifted" }, filter);
      node("feColorMatrix", channel("g", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"), filter);
      node("feColorMatrix", channel("b", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"), filter);
      node("feOffset", blue, filter);
      node("feComposite", { "in": "bMoved", in2: "b", operator: "over", result: "bShifted" }, filter);
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

  // For window.EmjiveMenus (js/studies.js) click-away handling; root is the
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

    // A link closes the menu: one to #gallery stays on the page.
    siteHeaderMenu.addEventListener("click", function (e) {
      var link = e.target.closest("a");
      if (link && siteHeaderMenu.contains(link)) setHeaderMenuOpen(false);
    });
  }

  // The featured study's link (its name checked by scripts/validate-data.js)
  // isn't the current page on the gallery of another study (?study=).
  var featuredLink = document.querySelector("[data-featured-study][aria-current]");
  if (featuredLink) {
    window.EmjiveStudies.ready.then(function (ctx) {
      if (!window.EmjiveStudies.isFeatured(ctx.slug)) featuredLink.removeAttribute("aria-current");
    // The page itself reports a failed studies index.
    }).catch(function () {});
  }

  /* ---- contact form stub ---- */

  var contactForm = document.getElementById("contactForm");
  if (contactForm) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      alert("This form isn't available yet.");
    });
  }
})();
