/* ==========================================================================
   em·ji·ve — liquid glass

   A reusable "bending" glass for any element: opt in with
   class="glass" data-glass (css/style.css holds the frosted fallback and
   every optical knob as a --glass-* custom property). The checkout bar
   (launch-order.html) and the product page's Select bar both use it.

   The technique is a vanilla port of samasante/liquid-glass (MIT,
   Copyright (c) 2026 Sam Asante — https://github.com/samasante/liquid-glass),
   which is React-only; the maths and the filter pipeline are that
   project's, rewritten here without a framework:

   - A rounded-rect signed-distance field is rasterised into a small
     displacement-map PNG (R = x offset, G = y offset, B = specular
     highlight; one quadrant is computed and mirrored into the other three).
     The map is only regenerated when the element's shape changes.
   - An SVG <filter> turns that map into refraction: three
     feDisplacementMap passes (red / green / blue at slightly different
     scales — the chromatic aberration), recombined with an arithmetic
     feComposite, then the map's blue channel painted over as a white
     specular sheen.

   Where the filter goes depends on the browser, because only Chromium can
   run an SVG filter on what's *behind* an element:

   backdrop  Chromium (Chrome, Edge, Android): backdrop-filter: url(#id)
             bends the live page behind the glass.
   clone     Safari (every iPhone browser is WebKit) and Firefox: no
             backdrop-filter at all. The glass instead carries a copy of the
             page's content (a cloneNode of <main>, or whatever
             data-glass-source selects), lined up with the original under the
             glass and re-lined on scroll / resize / the bar moving, and
             applies the same filter to that copy with a plain
             filter: url(#id). Markup is inert and aria-hidden; ids are
             stripped; fixed-position nodes are dropped; <video>/<canvas>
             stay blank (they can't be copied).
   frost     the plain CSS look (blur + tint + rim light). Also what shows
             before this script has run, with prefers-reduced-transparency,
             or if anything here throws.

   Safari workarounds, all from the reference project: the filter runs at 1x
   (no supersampling — nothing here ever sets a filter resolution), the map
   is regenerated only when the shape changes, and every update gets a NEW
   filter id (lg-N-vK) because WebKit caches a filter's output by id.

   ?glass=backdrop|clone|frost in the URL forces a mode (for testing — the
   clone path also runs in Chromium).
   ========================================================================== */

(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var XLINK_NS = "http://www.w3.org/1999/xlink";
  var HTML_NS = "http://www.w3.org/1999/xhtml";

  // Spread between the red and blue displacement scales, as a fraction of the
  // base scale, at dispersion 1.
  var DISPERSION_SPREAD = 0.22;
  // Longest side of the displacement-map PNG; a wider element is sampled at
  // a coarser resolution and the feImage stretches it back out.
  var MAP_MAX = 1024;
  var REBUILD_DEBOUNCE_MS = 120;
  var CLONE_DEBOUNCE_MS = 200;

  // Every knob comes from a --glass-* custom property (css/style.css :root,
  // overridable per element); these are the fallbacks if one is missing.
  var DEFAULTS = {
    strength: 0.25,      // max displacement, as a fraction of the shorter side
    depth: 0.75,         // how far in from the edge the bending reaches (0..1 of half the shorter side)
    curvature: 0,        // dome magnification across the whole surface; 0 = rim only
    bend: 0.5,           // the meniscus "lip" at the rim
    bendWidth: 0.3,      // width of that lip, as a fraction of the shorter side
    dispersion: 0.5,     // chromatic aberration at the rim
    specular: 1,         // gain on the whole highlight layer
    sheen: 0.3,          // directional edge highlight
    sheenWidth: 3,       // px
    sheenFalloff: 1.5,
    sheenAngle: 45,      // degrees
    glow: 0.12,          // soft inner glow
    glowSpread: 1,
    glowFalloff: 0.5,
    frost: 4,            // px of blur on the copy / backdrop
    saturate: 1.6
  };

  // ---- environment -------------------------------------------------------

  function detect() {
    var ua = navigator.userAgent || "";
    // Chrome / Edge / Opera / Samsung Internet on iOS are WebKit wearing a
    // different name (CriOS, EdgiOS, ...); none of them says "Chrome/".
    var chromium = /(Chrome|Chromium|Edg|OPR|SamsungBrowser)\//.test(ua);
    var webkit = /AppleWebKit/.test(ua) && !chromium;
    var mode;
    var forced = null;
    try { forced = new URLSearchParams(global.location.search).get("glass"); } catch (e) { /* no URLSearchParams */ }
    if (forced === "backdrop" || forced === "clone" || forced === "frost") {
      mode = forced;
    } else if (
      !global.ResizeObserver ||
      !document.createElementNS ||
      (global.matchMedia && global.matchMedia("(prefers-reduced-transparency: reduce)").matches)
    ) {
      mode = "frost";
    } else {
      mode = chromium ? "backdrop" : "clone";
    }
    return { mode: mode, webkit: webkit };
  }

  var env = detect();
  var instances = [];
  var counter = 0;
  var defs = null;

  // ---- the displacement map ----------------------------------------------

  var ERF_K = Math.sqrt(Math.PI);
  function erf(x) { return Math.tanh(ERF_K * x); }

  // Signed distance to a rounded rect centred on the origin, evaluated in one
  // quadrant (px, py >= 0): negative inside, positive outside.
  function roundRectSdf(px, py, halfW, halfH, radius) {
    var ex = px - halfW + radius;
    var ey = py - halfH + radius;
    var cx = ex > 0 ? ex : 0;
    var cy = ey > 0 ? ey : 0;
    return Math.sqrt(cx * cx + cy * cy) + Math.min(Math.max(ex, ey), 0) - radius;
  }

  // Spherical-cap ("dome") refraction: the gradient of a cap of radius
  // `radius`, normalised so its mean over the half extent is 0.5.
  function domeGradient(distance, radius, scale) {
    var inside = Math.min(distance, radius * (1 - 1e-3));
    return (inside / Math.sqrt(radius * radius - inside * inside)) * scale;
  }
  function domeGradientMean(radius, halfExtent) {
    return halfExtent > 0
      ? (radius - Math.sqrt(radius * radius - halfExtent * halfExtent)) / halfExtent
      : 0;
  }
  function domeConstants(capDepth, halfW, halfH) {
    var cap = Math.max(0.01, Math.min(capDepth, Math.min(halfW, halfH) - 1));
    var rx = (halfW * halfW + cap * cap) / (2 * cap);
    var ry = (halfH * halfH + cap * cap) / (2 * cap);
    var meanX = domeGradientMean(rx, halfW);
    var meanY = domeGradientMean(ry, halfH);
    return {
      rx: rx,
      ry: ry,
      scaleX: meanX > 0 ? 0.5 / meanX : 1,
      scaleY: meanY > 0 ? 0.5 / meanY : 1
    };
  }

  // 8-bit signed-around-0.5 encodings: an axis offset in [-0.5, 0.5], and a
  // specular value in [-1, 1] (128 = none).
  function encodeAxis(signed) { return ((0.5 + signed) * 255 + 0.5) | 0; }
  function encodeSpec(spec) { return (127 * spec + 128 + 0.5) | 0; }

  var mapCanvas = null;

  // Returns a PNG data URL for a W x H (CSS px) rounded rect.
  function generateMap(W, H, radius, o) {
    var scale = Math.min(1, MAP_MAX / W, MAP_MAX / H);
    var mw = Math.max(2, Math.round(W * scale));
    var mh = Math.max(2, Math.round(H * scale));
    if (!mapCanvas) mapCanvas = document.createElement("canvas");
    mapCanvas.width = mw;
    mapCanvas.height = mh;
    var ctx = mapCanvas.getContext("2d");
    var image = ctx.createImageData(mw, mh);
    var data = image.data;

    var halfW = W / 2;
    var halfH = H / 2;
    var minHalf = Math.min(halfW, halfH);
    var minDim = Math.min(W, H);
    var r = Math.min(radius, minHalf);

    // The refracting band: the rect inset by depthPx, feathered over depthPx.
    var depthPx = Math.max(1, o.depth * minHalf);
    var innerHalfW = Math.max(1, halfW - depthPx);
    var innerHalfH = Math.max(1, halfH - depthPx);
    var innerR = Math.max(0, r - depthPx);
    var falloff = Math.SQRT1_2 / depthPx;

    var dome = o.curvature > 0 ? domeConstants(o.curvature * minHalf, halfW, halfH) : null;
    var bendInv = 1 / Math.max(1, o.bendWidth * minDim);
    var hasBend = o.bend > 0;

    var angle = (o.sheenAngle * Math.PI) / 180;
    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);
    var sheenNorm = 1 / (Math.abs(cosA) + Math.abs(sinA) || 1);
    var sheenInv = 1 / Math.max(0.5, o.sheenWidth);
    var glowReachInv = 1 / Math.max(1, o.glowSpread * minHalf * 0.6);
    var hasSpec = o.specular > 0 && (o.sheen > 0 || o.glow > 0);

    var halfCols = Math.ceil(mw / 2);
    var halfRows = Math.ceil(mh / 2);
    var neutralAxis = encodeAxis(0);
    var neutralSpec = encodeSpec(0);

    for (var row = 0; row < halfRows; row += 1) {
      var py = (mh / 2 - (row + 0.5)) / scale;
      for (var col = 0; col < halfCols; col += 1) {
        var px = (mw / 2 - (col + 0.5)) / scale;

        var dx = 0;
        var dy = 0;
        var specMain = 0;
        var specCross = 0;
        var sdf = roundRectSdf(px, py, halfW, halfH, r);

        if (sdf <= 0) {
          var innerSdf = roundRectSdf(px, py, innerHalfW, innerHalfH, innerR);
          var edgeOpacity = 0.5 * (1 + erf(innerSdf * falloff));
          var nx = px / halfW > 1 ? 1 : px / halfW;
          var ny = py / halfH > 1 ? 1 : py / halfH;
          var dirX = dome ? domeGradient(px, dome.rx, dome.scaleX) : nx;
          var dirY = dome ? domeGradient(py, dome.ry, dome.scaleY) : ny;

          dx = 0.5 * dirX * edgeOpacity;
          dy = 0.5 * dirY * edgeOpacity;

          // Meniscus: an extra push along the same direction, peaking a
          // third of the way in from the rim (6.75 s^2 (1 - s), s = 1 at the
          // rim, 0 at the lip's inner edge).
          if (hasBend) {
            var s = Math.max(0, 1 + sdf * bendInv);
            if (s > 0) {
              var len = Math.sqrt(dirX * dirX + dirY * dirY);
              if (len > 1e-4) {
                var m = 6.75 * s * s * (1 - s);
                var a = (0.5 * o.bend * m * edgeOpacity) / len;
                dx += dirX * a;
                dy += dirY * a;
              }
            }
          }

          if (hasSpec) {
            var axisMain = Math.min(1, Math.abs(nx * cosA + ny * sinA) * sheenNorm);
            var axisCross = Math.min(1, Math.abs(nx * cosA - ny * sinA) * sheenNorm);
            if (o.sheen > 0) {
              var band = Math.max(0, 1 + sdf * sheenInv);
              var b = o.sheen * Math.pow(band, o.sheenFalloff);
              specMain += b * (0.16 + 0.84 * Math.pow(axisMain, 1.6));
              specCross += b * (0.16 + 0.84 * Math.pow(axisCross, 1.6));
            }
            if (o.glow > 0) {
              var reach = Math.min(1, -sdf * glowReachInv);
              var t = 1 - reach;
              var g = o.glow * Math.pow(t * t * (3 - 2 * t), o.glowFalloff) * edgeOpacity;
              specMain += g * (0.6 + 0.4 * axisMain);
              specCross += g * (0.6 + 0.4 * axisCross);
            }
            if (specMain > 1) specMain = 1;
            if (specCross > 1) specCross = 1;
          }
        }

        // Top-left quadrant offsets point toward the centre (+x, +y); the
        // other three mirror them, which is also why the specular term has a
        // "main" and a "cross" diagonal.
        var rPos = dx === 0 ? neutralAxis : encodeAxis(dx);
        var rNeg = dx === 0 ? neutralAxis : encodeAxis(-dx);
        var gPos = dy === 0 ? neutralAxis : encodeAxis(dy);
        var gNeg = dy === 0 ? neutralAxis : encodeAxis(-dy);
        var bMain = specMain === 0 ? neutralSpec : encodeSpec(specMain);
        var bCross = specCross === 0 ? neutralSpec : encodeSpec(specCross);

        var colR = mw - 1 - col;
        var rowB = mh - 1 - row;
        var i00 = (row * mw + col) * 4;
        var i01 = (row * mw + colR) * 4;
        var i10 = (rowB * mw + col) * 4;
        var i11 = (rowB * mw + colR) * 4;

        data[i00] = rPos; data[i00 + 1] = gPos; data[i00 + 2] = bMain; data[i00 + 3] = 255;
        data[i01] = rNeg; data[i01 + 1] = gPos; data[i01 + 2] = bCross; data[i01 + 3] = 255;
        data[i10] = rPos; data[i10 + 1] = gNeg; data[i10 + 2] = bCross; data[i10 + 3] = 255;
        data[i11] = rNeg; data[i11 + 1] = gNeg; data[i11 + 2] = bMain; data[i11 + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);
    return mapCanvas.toDataURL("image/png");
  }

  // ---- the SVG filter ------------------------------------------------------

  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  // Keeps one channel of its input (and alpha), zeroes the rest.
  function channelMatrix(channel) {
    var rows = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1, 0]
    ];
    rows[channel][channel] = 1;
    return rows.map(function (row) { return row.join(" "); }).join("  ");
  }

  function buildFilter(id, W, H, mapUrl, o) {
    var baseScale = 2 * o.strength * Math.min(W, H);
    var spread = DISPERSION_SPREAD * 0.5 * o.dispersion;
    var filter = svgEl("filter", {
      id: id,
      x: "0",
      y: "0",
      width: String(W),
      height: String(H),
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB"
    });

    var image = svgEl("feImage", {
      x: "0",
      y: "0",
      width: String(W),
      height: String(H),
      preserveAspectRatio: "none",
      result: "map"
    });
    image.setAttribute("href", mapUrl);
    image.setAttributeNS(XLINK_NS, "xlink:href", mapUrl);
    filter.appendChild(image);

    function displace(scale, result) {
      return svgEl("feDisplacementMap", {
        "in": "SourceGraphic",
        in2: "map",
        scale: String(scale),
        xChannelSelector: "R",
        yChannelSelector: "G",
        result: result
      });
    }

    if (o.dispersion > 0) {
      var names = ["R", "G", "B"];
      var scales = [baseScale * (1 + spread), baseScale, baseScale * (1 - spread)];
      for (var c = 0; c < 3; c += 1) {
        filter.appendChild(displace(scales[c], "d" + names[c]));
        filter.appendChild(svgEl("feColorMatrix", {
          "in": "d" + names[c],
          type: "matrix",
          values: channelMatrix(c),
          result: "c" + names[c]
        }));
      }
      filter.appendChild(svgEl("feComposite", {
        "in": "cR", in2: "cG", operator: "arithmetic", k1: "0", k2: "1", k3: "1", k4: "0", result: "cRG"
      }));
      filter.appendChild(svgEl("feComposite", {
        "in": "cRG", in2: "cB", operator: "arithmetic", k1: "0", k2: "1", k3: "1", k4: "0", result: "lens"
      }));
    } else {
      filter.appendChild(displace(baseScale, "lens"));
    }

    // The map's blue channel is the highlight: 0.5 = none, above that is
    // white at that alpha.
    if (o.specular > 0) {
      var gain = o.specular;
      filter.appendChild(svgEl("feColorMatrix", {
        "in": "map",
        type: "matrix",
        values: "0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 " + 2 * gain + " 0 " + -gain,
        result: "spec"
      }));
      filter.appendChild(svgEl("feComposite", { "in": "spec", in2: "lens", operator: "over" }));
    }
    return filter;
  }

  function ensureDefs() {
    if (defs && defs.isConnected) return defs;
    // Not display: none — Chromium ignores a filter inside a display:none svg.
    var svg = svgEl("svg", {
      width: "0",
      height: "0",
      "aria-hidden": "true",
      focusable: "false"
    });
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    defs = svgEl("defs", {});
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }

  // ---- optics + geometry from CSS -----------------------------------------

  function readOptics(el) {
    var cs = getComputedStyle(el);
    var o = {};
    for (var key in DEFAULTS) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
      var name = "--glass-" + key.replace(/[A-Z]/g, function (ch) { return "-" + ch.toLowerCase(); });
      var raw = parseFloat(cs.getPropertyValue(name));
      o[key] = isNaN(raw) ? DEFAULTS[key] : raw;
    }
    return o;
  }

  function readRadius(el, W, H) {
    var raw = getComputedStyle(el).borderTopLeftRadius || "0";
    var value = parseFloat(raw) || 0;
    if (/%$/.test(raw)) value = (value / 100) * Math.min(W, H);
    return value;
  }

  function pageBackground() {
    var probes = [document.body, document.documentElement];
    for (var i = 0; i < probes.length; i += 1) {
      var bg = getComputedStyle(probes[i]).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    }
    return "#fff";
  }

  // ---- the page copy (clone mode) ------------------------------------------

  var DROP_TAGS = { SCRIPT: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1 };
  var BLANK_TAGS = { VIDEO: 1, CANVAS: 1, AUDIO: 1 };

  function slice(list) { return Array.prototype.slice.call(list); }

  // Walks the original and its clone in step, dropping what can't or
  // shouldn't be copied. Must run on a clone that has the original's exact
  // shape (the two lists are matched by index).
  function prune(original, copy) {
    var origs = [original].concat(slice(original.querySelectorAll("*")));
    var copies = [copy].concat(slice(copy.querySelectorAll("*")));
    var drop = [];
    for (var i = 0; i < origs.length && i < copies.length; i += 1) {
      var o = origs[i];
      var c = copies[i];
      if (c.namespaceURI !== HTML_NS) continue; // inline SVG keeps its ids (url(#...) refs)
      if (DROP_TAGS[o.tagName]) { drop.push(c); continue; }
      if (i > 0 && getComputedStyle(o).position === "fixed") { drop.push(c); continue; }
      if (BLANK_TAGS[o.tagName]) {
        c.removeAttribute("src");
        c.removeAttribute("autoplay");
        c.textContent = "";
        c.style.visibility = "hidden";
      }
      if (o.tagName === "IMG") c.setAttribute("loading", "eager");
      c.removeAttribute("id");
      c.removeAttribute("name");
      c.removeAttribute("for");
      c.removeAttribute("autofocus");
      c.removeAttribute("accesskey");
    }
    drop.forEach(function (node) { if (node.parentNode) node.parentNode.removeChild(node); });
  }

  // ---- one glass element ----------------------------------------------------

  function attach(el) {
    if (!el || el.__emjiveGlass) return el && el.__emjiveGlass;
    var inst = {
      el: el,
      n: ++counter,
      mode: env.mode,
      version: 0,
      width: 0,
      height: 0,
      filterEl: null,
      filterId: "",
      rebuildTimer: 0,
      cloneTimer: 0,
      layer: null,
      pane: null,
      stage: null,
      source: null,
      bleed: 0,
      lastX: NaN,
      lastY: NaN,
      lastW: NaN,
      observers: []
    };
    el.__emjiveGlass = inst;
    instances.push(inst);

    if (inst.mode === "frost") return inst;

    var ro = new ResizeObserver(function () { scheduleRebuild(inst); });
    ro.observe(el);
    inst.observers.push(ro);

    if (inst.mode === "clone") {
      buildLayers(inst);
      inst.source = document.querySelector(el.getAttribute("data-glass-source") || "main");
      if (inst.source) {
        var sro = new ResizeObserver(function () { kick(); });
        sro.observe(inst.source);
        inst.observers.push(sro);
        var mo = new MutationObserver(function (records) {
          if (records.some(isCopyRelevant)) scheduleClone(inst);
        });
        mo.observe(inst.source, { subtree: true, childList: true, attributes: true, characterData: true });
        inst.observers.push(mo);
        rebuildClone(inst);
      }
    }
    scheduleRebuild(inst, true);
    return inst;
  }

  function destroy(el) {
    var inst = el && el.__emjiveGlass;
    if (!inst) return;
    inst.observers.forEach(function (ob) { ob.disconnect(); });
    clearTimeout(inst.rebuildTimer);
    clearTimeout(inst.cloneTimer);
    if (inst.filterEl && inst.filterEl.parentNode) inst.filterEl.parentNode.removeChild(inst.filterEl);
    if (inst.layer && inst.layer.parentNode) inst.layer.parentNode.removeChild(inst.layer);
    el.classList.remove("is-glass-backdrop", "is-glass-clone");
    el.style.removeProperty("--glass-url");
    delete el.__emjiveGlass;
    instances.splice(instances.indexOf(inst), 1);
  }

  function buildLayers(inst) {
    // layer: bar-sized, clips to the glass's own shape, and carries the
    // refraction filter. pane: the layer plus a bleed all round, carrying the
    // frost — so the blur has real pixels to sample at the rim instead of
    // fading out against transparent. stage: the page copy.
    var layer = document.createElement("div");
    layer.className = "glass__layer";
    layer.setAttribute("aria-hidden", "true");
    var pane = document.createElement("div");
    pane.className = "glass__pane";
    var stage = document.createElement("div");
    stage.className = "glass__stage";
    stage.setAttribute("aria-hidden", "true");
    stage.setAttribute("inert", "");
    pane.appendChild(stage);
    layer.appendChild(pane);
    inst.el.insertBefore(layer, inst.el.firstChild);
    inst.layer = layer;
    inst.pane = pane;
    inst.stage = stage;
  }

  function scheduleRebuild(inst, immediate) {
    clearTimeout(inst.rebuildTimer);
    if (immediate) { rebuild(inst); return; }
    inst.rebuildTimer = setTimeout(function () { rebuild(inst); }, REBUILD_DEBOUNCE_MS);
  }

  function rebuild(inst) {
    var el = inst.el;
    var W = el.offsetWidth;
    var H = el.offsetHeight;
    if (!W || !H) return; // hidden — the ResizeObserver fires again when it shows
    var o = readOptics(el);
    var radius = readRadius(el, W, H);
    var mapUrl;
    try {
      mapUrl = generateMap(W, H, radius, o);
    } catch (err) {
      fallBack(inst);
      return;
    }

    // Filter regions are per-size, so a resize means a new filter; the new id
    // is also what defeats WebKit's cached output.
    inst.version += 1;
    var id = "lg-" + inst.n + "-v" + inst.version;
    var next = buildFilter(id, W, H, mapUrl, o);
    ensureDefs().appendChild(next);
    if (inst.filterEl && inst.filterEl.parentNode) inst.filterEl.parentNode.removeChild(inst.filterEl);
    inst.filterEl = next;
    inst.filterId = id;
    inst.width = W;
    inst.height = H;
    inst.optics = o;
    el.style.setProperty("--glass-url", "url(#" + id + ")");

    if (inst.mode === "clone") {
      inst.bleed = Math.ceil(o.frost * 3) + 2;
      inst.pane.style.inset = -inst.bleed + "px";
      inst.pane.style.background = pageBackground();
      inst.lastX = NaN;
      sync(inst);
    }
    el.classList.add("is-glass-" + inst.mode);
    document.documentElement.setAttribute("data-glass-mode", inst.mode);
  }

  function fallBack(inst) {
    inst.mode = "frost";
    inst.el.classList.remove("is-glass-backdrop", "is-glass-clone");
    if (inst.layer && inst.layer.parentNode) inst.layer.parentNode.removeChild(inst.layer);
    inst.layer = inst.pane = inst.stage = null;
  }

  // A 3D viewer repaints itself constantly (its idle nudge, the hand overlay
  // that fades in and out, its poster crossfade), and every one of those is a
  // DOM mutation that would otherwise re-clone and re-prune the whole page —
  // a getComputedStyle per node — for a copy that doesn't show it anyway:
  // prune() blanks canvases, and what the glass samples is a blurred,
  // refracted few pixels of it. Changes INSIDE a viewer are skipped; the
  // viewer being added or removed is a change to its parent, which still
  // counts.
  function isCopyRelevant(record) {
    var node = record.target;
    var element = node.nodeType === 1 ? node : node.parentElement;
    return !(element && element.closest && element.closest(".emjive-3d-viewer"));
  }

  function scheduleClone(inst) {
    if (inst.cloneTimer) return;
    inst.cloneTimer = setTimeout(function () {
      inst.cloneTimer = 0;
      rebuildClone(inst);
    }, CLONE_DEBOUNCE_MS);
  }

  function rebuildClone(inst) {
    if (!inst.source || !inst.stage) return;
    var copy = inst.source.cloneNode(true);
    prune(inst.source, copy);
    copy.style.margin = "0";
    copy.style.pointerEvents = "none";
    inst.stage.textContent = "";
    inst.stage.appendChild(copy);
    inst.lastX = NaN;
    sync(inst);
  }

  // Lines the page copy up with the original under the glass. Both rects are
  // viewport-relative, so scroll, resize and a moving bar all reduce to the
  // same two reads. Returns true if anything moved.
  function sync(inst) {
    if (inst.mode !== "clone" || !inst.stage || !inst.source) return false;
    if (!inst.el.offsetWidth) return false;
    var sr = inst.source.getBoundingClientRect();
    var br = inst.el.getBoundingClientRect();
    var x = sr.left - br.left + inst.bleed;
    var y = sr.top - br.top + inst.bleed;
    if (x === inst.lastX && y === inst.lastY && sr.width === inst.lastW) return false;
    inst.lastX = x;
    inst.lastY = y;
    inst.lastW = sr.width;
    inst.stage.style.width = sr.width + "px";
    inst.stage.style.transform = "translate3d(" + x + "px," + y + "px,0)";
    if (env.webkit && inst.filterEl) {
      // WebKit re-filters a changed *definition*, not changed content under
      // an unchanged one: a fresh id each time the copy moves.
      inst.version += 1;
      var id = "lg-" + inst.n + "-v" + inst.version;
      inst.filterEl.setAttribute("id", id);
      inst.filterId = id;
      inst.el.style.setProperty("--glass-url", "url(#" + id + ")");
    }
    return true;
  }

  // ---- one shared rAF loop ---------------------------------------------------

  var raf = 0;
  var idleFrames = 0;

  function tick() {
    raf = 0;
    var moved = false;
    for (var i = 0; i < instances.length; i += 1) {
      if (sync(instances[i])) moved = true;
    }
    idleFrames = moved ? 0 : idleFrames + 1;
    // Keep polling a few frames after the last movement: the bar's own
    // transition (bottom 0.3s) and WebKit's async scrolling both outlive
    // the event that woke us.
    if (idleFrames < 8) raf = requestAnimationFrame(tick);
  }

  function kick() {
    idleFrames = 0;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function wireGlobal() {
    global.addEventListener("scroll", kick, { passive: true });
    global.addEventListener("resize", kick);
    if (global.visualViewport) {
      global.visualViewport.addEventListener("resize", kick);
      global.visualViewport.addEventListener("scroll", kick);
    }
    document.addEventListener("transitionrun", kick, true);
    document.addEventListener("transitionstart", kick, true);
    global.addEventListener("emjive:selection-changed", kick);
    global.addEventListener("emjive:modify-open", kick);
    global.addEventListener("emjive:modify-close", kick);
  }

  function init() {
    try {
      slice(document.querySelectorAll("[data-glass]")).forEach(attach);
      if (env.mode === "clone") wireGlobal();
    } catch (err) {
      instances.slice().forEach(function (inst) {
        inst.observers.forEach(function (ob) { ob.disconnect(); });
        fallBack(inst);
      });
    }
  }

  global.EmjiveGlass = {
    mode: env.mode,
    attach: attach,
    destroy: destroy,
    // Re-read the --glass-* knobs and rebuild now (after changing one).
    refresh: function (el) {
      var inst = el && el.__emjiveGlass;
      if (inst && inst.mode !== "frost") rebuild(inst);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
