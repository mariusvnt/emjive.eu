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
     scales — the chromatic aberration) recombined with an arithmetic
     feComposite. Around it, as plain CSS, the copy is frosted (blur +
     saturate) before it reaches the filter, and the map's blue channel — the
     specular sheen — and a white or black veil are laid over the result.
     Same maths as the reference's single filter; see buildFilter() for why
     it is split this way (it is what Safari can keep up with).

   One pipeline, every browser (Chrome, Safari — every iPhone browser is
   WebKit — and Firefox), the reference's own copy-refraction path: only
   Chromium can run an SVG filter on what's *behind* an element
   (backdrop-filter: url()), so nothing here relies on it. The glass carries
   a copy of the content it sits over (a cloneNode of <main>, or whatever
   data-glass-source selects), lined up with the original under the glass
   and re-lined on scroll / resize / the glass moving, and runs the filter
   on that copy with a plain filter: url(#id). The copy is inert and
   aria-hidden; ids are stripped; fixed-position nodes are dropped;
   <video>/<canvas> stay blank (they can't be copied).

   The only other look is the frost fallback (css/style.css: blur + tint +
   rim light), which shows before this script has run, with
   prefers-reduced-transparency, or if anything here throws.

   Safari workarounds. From the reference project: the filter runs at 1x
   (no supersampling — nothing here ever sets a filter resolution), the map
   is regenerated only when the shape changes, and the specular is read
   from the raw map. This port's own: the filter reference is set inline
   (WebKit resolves a url() reached through var() against the stylesheet),
   and the filter carries no coordinates — see buildFilter(). The
   reference also gives the filter a new id whenever its lens moves,
   because WebKit caches a filter's output per definition; here nothing in
   the definition ever moves (only the copy under it does, which WebKit
   repaints like any content), so the id only changes with a rebuild.

   ?glass=frost in the URL forces the fallback (for testing).
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
  var MAP_MAX = 2048;
  var REBUILD_DEBOUNCE_MS = 120;
  var CLONE_DEBOUNCE_MS = 200;

  // Every knob comes from a --glass-* custom property (css/style.css :root,
  // overridable per element); these are the fallbacks if one is missing.
  var DEFAULTS = {
    strength: 0.25,      // max displacement, as a fraction of the shorter side
    depth: 0.75,         // how far in from the edge the bending reaches (0..1 of half the shorter side)
    curvature: 0,        // dome magnification across the whole surface; 0 = rim only
    bend: 0.5,           // the meniscus "lip" at the rim
    bendWidth: 0.3,      // width of that lip, as a fraction of the shorter HALF side
    dispersion: 0.5,     // chromatic aberration at the rim
    specular: 1,         // gain on the whole highlight layer
    sheen: 0.3,          // directional edge highlight
    sheenWidth: 3,       // px
    sheenFalloff: 1.5,
    sheenAngle: 45,      // degrees
    glow: 0.12,          // soft inner glow
    glowSpread: 1,
    glowFalloff: 0.5,
    frost: 4,            // px of blur on the copy
    saturate: 1.6,
    brightness: 0.1,     // white (>0) or black (<0) veil over the lens
    splay: 0,            // push the refraction outward toward the corners
    clipToShape: 1,      // no displacement outside the rounded rect
    softEdge: 1,         // erf feather toward the lens edge
    sheenDark: 0,        // the highlight darkens the edge instead of lighting it
    scaleX: null,        // per-axis strength overrides (null = strength)
    scaleY: null
  };

  // ---- environment -------------------------------------------------------

  function detect() {
    var mode;
    var forced = null;
    try { forced = new URLSearchParams(global.location.search).get("glass"); } catch (e) { /* no URLSearchParams */ }
    if (
      forced === "frost" ||
      !global.ResizeObserver ||
      !global.MutationObserver ||
      !document.createElementNS ||
      (global.matchMedia && global.matchMedia("(prefers-reduced-transparency: reduce)").matches)
    ) {
      mode = "frost";
    } else {
      mode = "clone";
    }
    return { mode: mode };
  }

  var env = detect();
  // How many times the page copy has been made, for the ?mem=1 read-out
  // (js/viewer-entry.js). Shared with js/three-viewer.js's counters.
  global.EmjiveMem = global.EmjiveMem || {};
  global.EmjiveMem.glassCopies = 0;
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

  var sheenCanvas = null;

  // Returns { map, sheen }, PNG data URLs for a W x H (CSS px) rounded-rect
  // lens. map: the displacement, framed by `bleed` px of neutral grey on
  // every side — the whole filter region, so the filter needs no sub-region
  // coordinates at all (see buildFilter()). sheen: the specular highlight,
  // lens-sized, as the overlay that adds it (see sheenPixel()), or "" if
  // there is none. The maths is samasante/liquid-glass's
  // createLensMapGenerator (src/displacement.ts), on the lens's own aspect
  // instead of a square map stretched to fit.
  function generateMap(W, H, radius, o, bleed) {
    var scale = Math.min(1, MAP_MAX / (W + 2 * bleed), MAP_MAX / (H + 2 * bleed));
    var mw = Math.max(2, Math.round(W * scale));
    var mh = Math.max(2, Math.round(H * scale));
    var bpx = Math.round(bleed * scale);
    var pw = mw + 2 * bpx;
    var ph = mh + 2 * bpx;
    if (!mapCanvas) mapCanvas = document.createElement("canvas");
    mapCanvas.width = pw;
    mapCanvas.height = ph;
    var ctx = mapCanvas.getContext("2d");
    var image = ctx.createImageData(pw, ph);
    var data = image.data;
    for (var n = 0; n < data.length; n += 4) {
      data[n] = data[n + 1] = data[n + 2] = 128;
      data[n + 3] = 255;
    }

    var halfW = W / 2;
    var halfH = H / 2;
    var minHalf = Math.min(halfW, halfH);
    var r = Math.min(radius, minHalf);
    var stepX = W / mw;
    var stepY = H / mh;
    var invW = 1 / halfW;
    var invH = 1 / halfH;

    // depth: a 0..1 fraction of the lens — how far the refraction reaches in
    // from the edge. The rect inset by depthPx, feathered over depthPx (erf).
    var depthPx = Math.max(0, Math.min(o.depth * minHalf, minHalf - 1));
    var innerHalfW = Math.max(0, halfW - depthPx);
    var innerHalfH = Math.max(0, halfH - depthPx);
    var innerR = Math.max(0, Math.min(radius, Math.min(innerHalfW, innerHalfH)));
    var falloff = depthPx > 0 ? Math.SQRT1_2 / depthPx : 1e6;
    var clipToShape = o.clipToShape > 0;
    var softEdge = o.softEdge > 0;

    var dome = o.curvature > 0 ? domeConstants(o.curvature * minHalf, halfW, halfH) : null;
    var splay = o.splay;
    var splayInv = minHalf > 0 ? 1 / (0.5 * minHalf) : 0;
    // The meniscus lip: a bump hugging the rim, bendWidth a fraction of the
    // shorter HALF side (that is what the reference measures it against).
    var hasBend = o.bend > 0;
    var bendInv = 1 / Math.max(2, o.bendWidth * minHalf);

    var angle = (o.sheenAngle * Math.PI) / 180;
    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);
    var sheenNorm = Math.SQRT1_2;
    var sheenInv = o.sheenWidth > 0 ? 1 / o.sheenWidth : 0;
    var glowReachInv = 1 / Math.max(2, o.glowSpread * minHalf);
    var hasSpec = o.glow > 0 || o.sheen > 0;

    var halfCols = Math.ceil(mw / 2);
    var halfRows = Math.ceil(mh / 2);

    // The quadrant is worked out first (offsets and highlights), encoded
    // second: the base push, the dome and the meniscus lip add up, and an
    // axis only holds +-0.5. Written straight into the PNG the sum clips, and
    // everything past the clip — the rim, where it matters most — comes out
    // as a flat plateau: a shifted copy of the page instead of a bend, with
    // the colour split a constant offset instead of a fringe. So the peak is
    // found first and, if it overshoots, the whole field is scaled down to
    // fit (strength stays the peak displacement, as documented). The one
    // deliberate difference from the reference, and only where it overshoots.
    var cells = halfCols * halfRows;
    var qDx = new Float32Array(cells);
    var qDy = new Float32Array(cells);
    var qMain = new Float32Array(cells);
    var qCross = new Float32Array(cells);
    var qOut = new Uint8Array(cells); // outside the shape: neutral grey
    var peak = 0;

    var domeX = null;
    if (dome) {
      domeX = new Float32Array(halfCols);
      for (var c0 = 0; c0 < halfCols; c0 += 1) {
        domeX[c0] = domeGradient(-((c0 + 0.5) * stepX - halfW), dome.rx, dome.scaleX);
      }
    }

    for (var row = 0; row < halfRows; row += 1) {
      var py = -((row + 0.5) * stepY - halfH);
      var normY = py * invH > 1 ? 1 : py * invH;
      var dirYBase = dome ? domeGradient(py, dome.ry, dome.scaleY) : normY;
      var splayY = splay > 0 ? Math.max(0, 1 - (halfH - py) * splayInv) : 0;
      for (var col = 0; col < halfCols; col += 1) {
        var px = -((col + 0.5) * stepX - halfW);
        var cell = row * halfCols + col;
        var sdf = roundRectSdf(px, py, halfW, halfH, r);

        if (clipToShape && sdf >= 0) {
          qOut[cell] = 1;
          continue;
        }

        var dirX = domeX ? domeX[col] : px * invW > 1 ? 1 : px * invW;
        var dirY = dirYBase;
        if (splay > 0) {
          var yAtt = splayY * splay;
          var xAtt = Math.max(0, 1 - (halfW - px) * splayInv) * splay;
          if (yAtt > 0.001 || xAtt > 0.001) {
            var prevX = dirX;
            var prevY = dirY;
            dirX = prevX * (1 - yAtt);
            dirY = prevY * (1 - xAtt);
            var prevLen = Math.sqrt(prevX * prevX + prevY * prevY);
            var nextLen = Math.sqrt(dirX * dirX + dirY * dirY);
            if (nextLen > 0.001) {
              var restore = prevLen / nextLen;
              dirX *= restore;
              dirY *= restore;
            }
          }
        }

        var edgeOpacity = 1;
        if (softEdge) {
          var innerSdf = roundRectSdf(px, py, innerHalfW, innerHalfH, innerR);
          edgeOpacity = 0.5 * (1 + erf(innerSdf * falloff));
        }

        var dx = 0.5 * dirX * edgeOpacity;
        var dy = 0.5 * dirY * edgeOpacity;

        // Meniscus: an extra push along the same direction, peaking a third
        // of the way in from the rim (6.75 s^2 (1 - s), s = 1 at the rim, 0
        // at the lip's inner edge) and zero at the rim itself.
        if (hasBend) {
          var s = sdf < 0 ? Math.max(0, 1 + sdf * bendInv) : 0;
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

        var specMain = 0;
        var specCross = 0;
        if (hasSpec) {
          var normX = px * invW > 1 ? 1 : px * invW;
          var axisMain = Math.min(1, Math.abs(normX * cosA + normY * sinA) * sheenNorm);
          var axisCross = Math.min(1, Math.abs(normX * cosA - normY * sinA) * sheenNorm);
          if (o.sheen > 0) {
            var band = sdf < 0 ? Math.max(0, 1 + sdf * sheenInv) : 0;
            var b = o.sheen * Math.pow(band, o.sheenFalloff);
            specMain += b * (0.16 + 0.84 * Math.pow(axisMain, 1.6));
            specCross += b * (0.16 + 0.84 * Math.pow(axisCross, 1.6));
          }
          if (o.glow > 0) {
            var reach = sdf < 0 ? Math.min(1, -sdf * glowReachInv) : 1;
            var t = 1 - reach;
            var g = o.glow * Math.pow(t * t * (3 - 2 * t), o.glowFalloff) * edgeOpacity;
            specMain += g * (0.6 + 0.4 * axisMain);
            specCross += g * (0.6 + 0.4 * axisCross);
          }
          if (specMain > 1) specMain = 1;
          else if (specMain < -1) specMain = -1;
          if (specCross > 1) specCross = 1;
          else if (specCross < -1) specCross = -1;
        }

        qDx[cell] = dx;
        qDy[cell] = dy;
        qMain[cell] = specMain;
        qCross[cell] = specCross;
        if (Math.abs(dx) > peak) peak = Math.abs(dx);
        if (Math.abs(dy) > peak) peak = Math.abs(dy);
      }
    }

    var fit = peak > 0.5 ? 0.5 / peak : 1;

    var sheenData = null;
    var sheenCtx = null;
    var sheenImage = null;
    if (hasSpec && o.specular !== 0) {
      if (!sheenCanvas) sheenCanvas = document.createElement("canvas");
      sheenCanvas.width = mw;
      sheenCanvas.height = mh;
      sheenCtx = sheenCanvas.getContext("2d");
      sheenImage = sheenCtx.createImageData(mw, mh);
      sheenData = sheenImage.data;
    }

    for (row = 0; row < halfRows; row += 1) {
      for (col = 0; col < halfCols; col += 1) {
        var at = row * halfCols + col;
        var rPos;
        var rNeg;
        var gPos;
        var gNeg;
        var bMain;
        var bCross;
        if (qOut[at]) {
          // Outside the shape: neutral grey, no displacement, no specular.
          rPos = rNeg = gPos = gNeg = bMain = bCross = 128;
        } else {
          var ox = qDx[at] * fit;
          var oy = qDy[at] * fit;
          // Top-left quadrant offsets point toward the centre (+x, +y); the
          // other three mirror them, which is also why the specular term has
          // a "main" and a "cross" diagonal.
          rPos = encodeAxis(ox);
          rNeg = encodeAxis(-ox);
          gPos = encodeAxis(oy);
          gNeg = encodeAxis(-oy);
          bMain = encodeSpec(qMain[at]);
          bCross = encodeSpec(qCross[at]);
        }

        var colL = bpx + col;
        var colR = bpx + mw - 1 - col;
        var rowT = bpx + row;
        var rowB = bpx + mh - 1 - row;
        var i00 = (rowT * pw + colL) * 4;
        var i01 = (rowT * pw + colR) * 4;
        var i10 = (rowB * pw + colL) * 4;
        var i11 = (rowB * pw + colR) * 4;

        data[i00] = rPos; data[i00 + 1] = gPos; data[i00 + 2] = bMain; data[i00 + 3] = 255;
        data[i01] = rNeg; data[i01 + 1] = gPos; data[i01 + 2] = bCross; data[i01 + 3] = 255;
        data[i10] = rPos; data[i10 + 1] = gNeg; data[i10 + 2] = bCross; data[i10 + 3] = 255;
        data[i11] = rNeg; data[i11 + 1] = gNeg; data[i11 + 2] = bMain; data[i11 + 3] = 255;

        if (sheenData) {
          var sMain = sheenPixel(bMain, o);
          var sCross = sheenPixel(bCross, o);
          var s00 = (row * mw + col) * 4;
          var s01 = (row * mw + (mw - 1 - col)) * 4;
          var s10 = ((mh - 1 - row) * mw + col) * 4;
          var s11 = ((mh - 1 - row) * mw + (mw - 1 - col)) * 4;
          putSheen(sheenData, s00, sMain);
          putSheen(sheenData, s01, sCross);
          putSheen(sheenData, s10, sCross);
          putSheen(sheenData, s11, sMain);
        }
      }
    }

    ctx.putImageData(image, 0, 0);
    var sheenUrl = "";
    if (sheenData) {
      sheenCtx.putImageData(sheenImage, 0, 0);
      sheenUrl = sheenCanvas.toDataURL("image/png");
    }
    return { map: mapCanvas.toDataURL("image/png"), sheen: sheenUrl };
  }

  // One pixel of the sheen overlay, from the map's blue value (b, 128 =
  // none), exactly what the reference's filter does with it:
  //   - sheen: a white mask of alpha (b - 128) / 255 (never below 0), ADDED
  //     to the lens at `specular` gain (feComposite arithmetic k2 = specular,
  //     k3 = 1). As an overlay: white at that alpha, mix-blend-mode
  //     plus-lighter — which adds its premultiplied colour, the same sum.
  //   - sheenDark: the lens MULTIPLIED by 1 + 128 * specular / 255 -
  //     specular * b / 255 (feComposite arithmetic k1 = 1). As an overlay:
  //     that grey, opaque, mix-blend-mode multiply.
  // Returns [r, g, b, a] (unpremultiplied, as ImageData wants it).
  function sheenPixel(b, o) {
    var spec = o.specular;
    if (o.sheenDark > 0) {
      var grey = Math.max(0, Math.min(1, 1 + (128 * spec) / 255 - (spec * b) / 255));
      var g8 = Math.round(grey * 255);
      return [g8, g8, g8, 255];
    }
    var add = Math.max(0, Math.min(1, spec * Math.max(0, (b - 128) / 255)));
    return [255, 255, 255, Math.round(add * 255)];
  }

  function putSheen(data, index, px) {
    data[index] = px[0];
    data[index + 1] = px[1];
    data[index + 2] = px[2];
    data[index + 3] = px[3];
  }

  // ---- the SVG filter ------------------------------------------------------

  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  // The displacement scale in user px: strength is a fraction of the shorter
  // side (x2, as the field spans +-0.5), per axis if scaleX / scaleY are set —
  // the larger of the two drives the filter, the map carries the ratio.
  function lensScales(W, H, o) {
    var sx = o.scaleX == null ? o.strength : o.scaleX;
    var sy = o.scaleY == null ? o.strength : o.scaleY;
    var maxScale = Math.max(sx, sy);
    return {
      sx: sx,
      sy: sy,
      max: maxScale,
      base: maxScale * 2 * Math.min(W, H)
    };
  }

  // The filter is samasante/liquid-glass's LensFilterContents (src/Glass.tsx)
  // — map -> optional axis rescale -> frost -> symmetric RGB-split
  // displacement -> additive specular -> brightness veil — with only the
  // displacement and the colour split left inside the SVG filter. The rest
  // is the same maths, done where it costs nothing per frame:
  //   - frost + saturate: a CSS filter on .glass__clip, under the pane, so
  //     the copy reaches this filter already frosted (saturate is a
  //     per-pixel colour op: before or after the displacement is the same);
  //   - the sheen and the veil: overlays above the pane (.glass__sheen,
  //     .glass__veil) — they depend only on the lens's shape, never on what
  //     is under it, so they are drawn once, not per frame;
  //   - nothing clips the result to the lens's rounded shape: .glass__layer
  //     already clips to exactly that shape (it inherits the glass's
  //     border-radius), so the reference's shape mask and its cut-out of the
  //     copy around the lens drew nothing that shows.
  //
  // Why it matters — WebKit's own source, not a guess: Safari renders an SVG
  // reference filter in software (Page::preferredFilterRenderingModes only
  // adds the CoreImage path behind AcceleratedFiltersEnabled, an "unstable"
  // setting that defaults to false, and the CoreGraphics path only takes a
  // filter whose every primitive is a blur or a colour matrix), as plain
  // per-pixel loops over the whole region, at the full device scale
  // (RenderLayer::ensureLayerFilters: page().deviceScaleFactor(), 3 on an
  // iPhone) — and it has to run again every frame the copy moves under it,
  // which is every frame of a scroll. A plain CSS blur() / saturate(), by
  // contrast, goes through CoreGraphics there (GraphicsContextFiltersEnabled,
  // on by default), and a static overlay costs nothing at all. Chrome runs
  // either form on the GPU; it gives the same picture both ways.
  //
  // No primitive carries a position, either. The region is the pane's own
  // box (objectBoundingBox 0 0 1 1) and where the lens sits is drawn into
  // the map (lens framed by neutral grey, the bleed wide). WebKit measures
  // that box over everything the element paints, so the copy — which
  // overflows the pane by the whole page — has to be contained (see
  // .glass__clip) for it to be the pane's own box, as it is in Chrome. Plain
  // numbers — the displacement scale — stay in px (primitiveUnits
  // userSpaceOnUse), which carry no origin.
  function buildFilter(id, W, H, o, mapUrl) {
    var sc = lensScales(W, H, o);
    var needsMapScale = sc.max > 0 && !(sc.sx === sc.max && sc.sy === sc.max);
    var base = sc.base;
    var spread = DISPERSION_SPREAD * 0.5 * o.dispersion;

    var filter = svgEl("filter", {
      id: id,
      x: "0",
      y: "0",
      width: "1",
      height: "1",
      filterUnits: "objectBoundingBox",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB"
    });
    function put(name, attrs) { filter.appendChild(svgEl(name, attrs)); }

    // The map carries its own neutral surround, so it needs no grey
    // underlay; the reference's "rawMap" and "map" are the same image here.
    var image = svgEl("feImage", { preserveAspectRatio: "none", result: "map" });
    image.setAttribute("href", mapUrl);
    image.setAttributeNS(XLINK_NS, "xlink:href", mapUrl);
    filter.appendChild(image);
    var mapInput = "map";
    if (needsMapScale) {
      var mx = sc.sx / sc.max;
      var my = sc.sy / sc.max;
      put("feColorMatrix", {
        "in": "map",
        type: "matrix",
        values: mx + " 0 0 0 " + 0.5 * (1 - mx) + "  0 " + my + " 0 0 " + 0.5 * (1 - my) + "  0 0 1 0 0  0 0 0 1 0",
        result: "scaledMap"
      });
      mapInput = "scaledMap";
    }

    function displace(scale, result) {
      var attrs = {
        "in": "SourceGraphic",
        in2: mapInput,
        scale: String(scale),
        xChannelSelector: "R",
        yChannelSelector: "G"
      };
      if (result) attrs.result = result;
      put("feDisplacementMap", attrs);
    }

    if (o.dispersion > 0) {
      // Symmetric about the base: red fringes outward (+half the spread),
      // blue inward, green stays put — so raising dispersion fringes the
      // edges without zooming or shifting the whole refracted field.
      var scales = [base * (1 + spread), base, base * (1 - spread)];
      var keep = [
        "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
        "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
        "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
      ];
      var names = ["refractR", "refractG", "refractB"];
      for (var c = 0; c < 3; c += 1) {
        displace(scales[c], "d" + names[c]);
        put("feColorMatrix", { "in": "d" + names[c], type: "matrix", values: keep[c], result: names[c] });
      }
      put("feComposite", { "in": "refractR", in2: "refractG", operator: "arithmetic", k1: "0", k2: "1", k3: "1", k4: "0", result: "refractRG" });
      put("feComposite", { "in": "refractRG", in2: "refractB", operator: "arithmetic", k1: "0", k2: "1", k3: "1", k4: "0" });
    } else {
      displace(base);
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

  // ---- the copy ----------------------------------------------------------------

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
      // Images keep the original's `loading`: forcing them eager made the
      // copy fetch and decode every lazy picture on the page — the carousel's
      // photos, far out of view — that the page itself had deliberately left
      // alone. What the glass sits over is on screen in the original, so
      // anything it needs has already loaded (and a cloned <img> of an
      // already-loaded URL comes straight from the cache).
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
      // A copy is owed but wasn't made because nobody could see the glass at
      // the time — see isIdle() and rebuildClone().
      copyPending: false,
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

    buildLayers(inst);
    inst.source = document.querySelector(el.getAttribute("data-glass-source") || "main");
    if (inst.source) {
      var sro = new ResizeObserver(function () { kick(); });
      sro.observe(inst.source);
      inst.observers.push(sro);
      var mo = new MutationObserver(function (records) {
        if (records.some(isCopyRelevant)) scheduleClone(inst);
      });
      // Not every attribute: `style` is rewritten constantly by things the
      // copy has no use for (the carousel's track on every drag move, the
      // loaders' parts, fades), and each one of those used to cost a full
      // re-clone of the page. What changes what the glass shows through is
      // content arriving or leaving, an image source changing, and a class
      // or the hidden flag flipping something on or off.
      mo.observe(inst.source, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class", "src", "hidden"],
        characterData: true
      });
      inst.observers.push(mo);
      rebuildClone(inst);
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
    el.classList.remove("is-glass-clone");
    delete el.__emjiveGlass;
    instances.splice(instances.indexOf(inst), 1);
  }

  function buildLayers(inst) {
    // layer: the glass's own size and shape; clips. pane: the layer plus the
    // bleed all round, filled with the page's background; carries the SVG
    // filter (the bend). clip: the pane's own box, clipping AND containing
    // the copy (contain: strict) — WebKit otherwise counts everything the
    // copy paints (the whole page, way past the pane) as the pane's box when
    // it places the filter — and frosting it (CSS). stage: the copy itself,
    // moved into place. sheen, veil: the highlight and the tint, over the
    // pane (see buildFilter()).
    var layer = document.createElement("div");
    layer.className = "glass__layer";
    layer.setAttribute("aria-hidden", "true");
    var pane = document.createElement("div");
    pane.className = "glass__pane";
    var clip = document.createElement("div");
    clip.className = "glass__clip";
    var stage = document.createElement("div");
    stage.className = "glass__stage";
    stage.setAttribute("aria-hidden", "true");
    stage.setAttribute("inert", "");
    var sheen = document.createElement("div");
    sheen.className = "glass__sheen";
    var veil = document.createElement("div");
    veil.className = "glass__veil";
    clip.appendChild(stage);
    pane.appendChild(clip);
    layer.appendChild(pane);
    layer.appendChild(sheen);
    layer.appendChild(veil);
    inst.el.insertBefore(layer, inst.el.firstChild);
    inst.layer = layer;
    inst.pane = pane;
    inst.stage = stage;
    inst.sheen = sheen;
    inst.veil = veil;
  }

  function scheduleRebuild(inst, immediate) {
    clearTimeout(inst.rebuildTimer);
    if (immediate) { rebuild(inst); return; }
    inst.rebuildTimer = setTimeout(function () { rebuild(inst); }, REBUILD_DEBOUNCE_MS);
  }

  function rebuild(inst) {
    var el = inst.el;
    if (inst.mode === "frost") return;
    var W = el.offsetWidth;
    var H = el.offsetHeight;
    if (!W || !H) return; // hidden — the ResizeObserver fires again when it shows
    var o = readOptics(el);
    var radius = Math.min(readRadius(el, W, H), W / 2, H / 2);
    // The copy is padded all round by what the frost reaches past the edge
    // (three sigmas), so the blur at the rim samples solid page background,
    // not transparent. The displacement needs no padding of its own: every
    // offset in the map points INTO the lens (the dome, the lip and the base
    // push all bend toward the centre), so it never reads past the edge.
    // The region is the cost — every pass runs over all of it, every frame
    // the copy moves — so it is no bigger than that.
    var bleed = Math.ceil(o.frost * 3) + 2;
    var maps;
    try {
      maps = generateMap(W, H, radius, o, bleed);
    } catch (err) {
      fallBack(inst);
      return;
    }

    // A new filter per rebuild, under a new id: WebKit caches a filter's
    // output per definition.
    inst.version += 1;
    var id = "lg-" + inst.n + "-v" + inst.version;
    var next = buildFilter(id, W, H, o, maps.map);
    ensureDefs().appendChild(next);
    if (inst.filterEl && inst.filterEl.parentNode) inst.filterEl.parentNode.removeChild(inst.filterEl);
    inst.filterEl = next;
    inst.filterId = id;
    inst.width = W;
    inst.height = H;
    inst.optics = o;
    inst.bleed = bleed;
    inst.pane.style.inset = -bleed + "px";
    inst.pane.style.background = pageBackground();
    inst.sheen.style.backgroundImage = maps.sheen ? "url(" + maps.sheen + ")" : "none";
    inst.sheen.classList.toggle("is-dark", o.sheenDark > 0);
    // A white (> 0) or black (< 0) veil of that opacity, "over" the lens.
    inst.veil.style.backgroundColor = o.brightness === 0
      ? "transparent"
      : (o.brightness > 0 ? "rgba(255, 255, 255, " : "rgba(0, 0, 0, ") + Math.min(1, Math.abs(o.brightness)) + ")";
    pointFilter(inst);
    inst.lastX = NaN;
    // The first copy is made here, when the glass first has a size, not when
    // it was attached: a bar starts hidden, and copying the page for a bar
    // nobody can see — twice over, since the page keeps changing while it
    // loads — was pure waste (see rebuildClone).
    if (inst.copyPending) rebuildClone(inst);
    else sync(inst);
    el.classList.add("is-glass-clone");
    document.documentElement.setAttribute("data-glass-mode", inst.mode);
  }

  function fallBack(inst) {
    inst.mode = "frost";
    inst.el.classList.remove("is-glass-clone");
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

  // Nobody can see this glass right now: the bar hasn't been shown yet
  // (product.js and selection-page.js unhide it once their page has
  // rendered), it has stepped aside for the Modify sheet (.is-away) or been
  // covered by the checkout bar's strip (.is-strip-active), or the whole page
  // is in the background. Copying the page and re-running a filter for it is
  // work whose result is thrown away — and on a phone, memory it holds for
  // nothing. The copy is owed instead (copyPending) and made the moment the
  // glass can be seen again.
  function isIdle(inst) {
    var el = inst.el;
    return !el.offsetWidth ||
      document.hidden ||
      el.classList.contains("is-away") ||
      el.classList.contains("is-strip-active");
  }

  function rebuildClone(inst) {
    if (!inst.source || !inst.stage) return;
    if (isIdle(inst)) {
      inst.copyPending = true;
      return;
    }
    inst.copyPending = false;
    window.EmjiveMem.glassCopies += 1;
    var copy = inst.source.cloneNode(true);
    prune(inst.source, copy);
    copy.style.margin = "0";
    copy.style.pointerEvents = "none";
    inst.stage.textContent = "";
    inst.stage.appendChild(copy);
    inst.lastX = NaN;
    sync(inst);
  }

  // Inline, never through a custom property: WebKit resolves a url() that
  // reaches a stylesheet through var() against that STYLESHEET's address
  // (css/style.css#lg-1-v1 — a filter that doesn't exist). An inline style
  // resolves against the page.
  function pointFilter(inst) {
    if (inst.pane) inst.pane.style.filter = "url(#" + inst.filterId + ")";
  }

  // Lines the copy up with the original under the glass. Both rects are
  // viewport-relative, so scroll, resize and a moving glass all reduce to the
  // same two reads. Returns true if anything moved.
  function sync(inst) {
    if (inst.mode !== "clone" || !inst.stage || !inst.source) return false;
    if (isIdle(inst)) return false;
    // The glass became visible with a copy owed (see isIdle): make it now.
    // rebuildClone() clears the flag and calls back in here.
    if (inst.copyPending) {
      rebuildClone(inst);
      return true;
    }
    var sr = inst.source.getBoundingClientRect();
    var br = inst.el.getBoundingClientRect();
    var x = sr.left - br.left + inst.bleed;
    var y = sr.top - br.top + inst.bleed;
    var moved = !(x === inst.lastX && y === inst.lastY && sr.width === inst.lastW);
    if (moved) {
      inst.lastX = x;
      inst.lastY = y;
      inst.lastW = sr.width;
      inst.stage.style.width = sr.width + "px";
      // translate, not translate3d: the 3D form makes the copy its own
      // compositor layer, and the copy is the whole page — a layer as tall
      // as <main>, thousands of pixels at 3x, to show a bar's worth of it.
      // The copy only moves under a clip a few dozen pixels high, so a plain
      // 2D transform keeps the cost at the size of what is actually drawn.
      inst.stage.style.transform = "translate(" + x + "px," + y + "px)";
    }
    return moved;
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
    // Back from a hidden tab: a copy may be owed (see isIdle).
    document.addEventListener("visibilitychange", kick);

    // A page that goes into the back/forward cache is kept whole, copy and
    // all — a second, filtered DOM of the entire page, and the images in it,
    // held for as long as the entry lives. Dropped on the way out and owed
    // again, so coming back from the cache makes it afresh (kick -> sync ->
    // rebuildClone) instead of the cache keeping it.
    global.addEventListener("pagehide", function (e) {
      // Only when it is really going into the cache: on an ordinary
      // navigation the page can still be on screen for a moment, and
      // emptying the glass under it would show as a flicker.
      if (!e.persisted) return;
      instances.forEach(function (inst) {
        if (inst.mode !== "clone" || !inst.stage) return;
        clearTimeout(inst.cloneTimer);
        inst.cloneTimer = 0;
        inst.stage.textContent = "";
        inst.copyPending = true;
      });
    });
    global.addEventListener("pageshow", function (e) {
      if (e.persisted) kick();
    });
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
