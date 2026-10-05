/* ==========================================================================
   em·ji·ve — lazy 3D viewer loader

   The only thing the pages load up front for 3D. js/three-viewer.js (three.js
   plus the glTF/Draco/HDR loaders, ~645KB minified, ~168KB gzipped) is pulled
   in through the dynamic import() below instead of a <script> tag, so the
   pages that never draw a model pay nothing for it — and the ones that do
   fetch it in parallel with their data rather than ahead of first paint.

   It is a module because the dynamic import has to go through Vite: the
   classic scripts in js/ are copied to dist/ verbatim, so only a module
   entry can have this import resolved to the content-hashed chunk (and the
   bare "three" specifier inside it resolved at all).

   window.EmjiveLoadViewer() resolves to the viewer factory (the same
   function as window.EmjiveModelViewer, which three-viewer.js also still
   sets) and rejects if the module could not be fetched. The result is
   cached — including a failure: a visitor whose connection dropped keeps the
   icon fallbacks for the rest of the page rather than retrying on every
   scroll.

   When to start fetching is the page's call, via data-viewer on <html>:
     "eager"  — start now (no page uses it at the moment: product.html used to,
                but its first paint doesn't need the chunk and the download
                competed with the images that do);
     "idle"   — start once the browser is idle (index.html: the grid's models
                sit below the hero);
     absent   — only when something asks (product.html once its first paint
                is in, the Modify sheet on every other page).
   ========================================================================== */

var pending = null;

window.EmjiveLoadViewer = function () {
  if (!pending) {
    pending = import("./three-viewer.js").then(function () {
      return window.EmjiveModelViewer;
    });
  }
  return pending;
};

var when = document.documentElement.getAttribute("data-viewer");
if (when === "eager") {
  window.EmjiveLoadViewer().catch(function () {});
} else if (when === "idle") {
  // The grid's models are below the hero, so nothing here is needed for the
  // first paint — and the chunk (~165KB gzipped, plus evaluating 645KB) used
  // to start the moment the browser had a free moment, which on a slow link
  // was while the hero picture was still downloading. It now starts once the
  // page has revealed (js/loader.js's "emjive:pageready") and the browser is
  // idle, or as soon as the visitor shows they are about to scroll toward the
  // models — whichever comes first — with a backstop for a page that never
  // reveals.
  var started = false;
  var start = function () {
    if (started) return;
    started = true;
    window.EmjiveLoadViewer().catch(function () {});
  };
  var startWhenIdle = function () {
    if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 2000 });
    else setTimeout(start, 500);
  };
  if (window.EmjiveLoader && window.EmjiveLoader.isPageReady()) startWhenIdle();
  else window.addEventListener("emjive:pageready", startWhenIdle, { once: true });
  ["scroll", "wheel", "touchstart", "pointerdown", "keydown"].forEach(function (name) {
    window.addEventListener(name, start, { once: true, passive: true });
  });
  setTimeout(start, 10000);
}

/* ---- ?mem=1: a memory read-out for a device with no inspector ----------------
   iOS Safari ends a tab that uses too much memory and reloads it, and from a
   Windows machine there is no way to attach Safari's inspector to see why.
   Adding ?mem=1 to any address puts a small panel in the corner of the page
   with the numbers that matter, so a person holding the phone can read them
   off. Nothing else changes, and without the parameter none of this runs.

   What the numbers mean, and which way is good:
     3D viewers     live WebGL contexts. The gallery allows 3; a product page 1.
     model arrays   decoded geometry still held as JavaScript arrays. Should
                    fall to ~0 MB once each live model has drawn its first frame.
     GPU objects    geometries / textures the live renderers hold.
     Draco workers  decoder workers alive. 0 a few seconds after the last load.
     glass          the mode in use and how many times the page copy behind the
                    glass bar has been rebuilt (clone mode only).
     phone images   whether this window counts as a phone for the picture
                    variants, plus the window size and pixel ratio it is judged
                    on — a "no" on a phone means the big desktop pictures load.
     JS heap        only where the browser reports it (not iOS Safari).
   --------------------------------------------------------------------------- */
if (/[?&]mem=1(&|$)/.test(location.search)) {
  var memPanel = document.createElement("div");
  var memStyle = memPanel.style;
  memStyle.position = "fixed";
  memStyle.left = "4px";
  memStyle.bottom = "4px";
  memStyle.zIndex = "2147483647";
  memStyle.padding = "4px 6px";
  memStyle.font = "10px/1.35 ui-monospace, Menlo, monospace";
  memStyle.color = "#0f0";
  memStyle.background = "rgba(0,0,0,0.78)";
  memStyle.whiteSpace = "pre";
  memStyle.pointerEvents = "none";
  var memRender = function () {
    var mem = window.EmjiveMem || {};
    var lines = [];
    var gpu = mem.gpuObjects ? mem.gpuObjects() : null;
    lines.push("3D viewers     " + (mem.liveRenderers ? mem.liveRenderers() : "-"));
    lines.push("model arrays   " + (typeof mem.cpuGeometryBytes === "number" ? (mem.cpuGeometryBytes / 1048576).toFixed(1) + " MB" : "-"));
    lines.push("GPU objects    " + (gpu ? gpu.geometries + " geo / " + gpu.textures + " tex" : "-"));
    lines.push("Draco workers  " + (mem.dracoWorkers ? mem.dracoWorkers() : "-"));
    lines.push("glass          " + (window.EmjiveGlass ? window.EmjiveGlass.mode : "-") + ", copies " + (mem.glassCopies || 0));
    var phone = window.EmjiveLoader ? (window.EmjiveLoader.isPhone() ? "yes" : "NO") : "-";
    lines.push("phone images   " + phone + "  " + window.innerWidth + "x" + window.innerHeight +
      " (" + (window.innerWidth / window.innerHeight).toFixed(3) + ") @" + (window.devicePixelRatio || 1));
    if (window.performance && window.performance.memory) {
      lines.push("JS heap        " + (window.performance.memory.usedJSHeapSize / 1048576).toFixed(0) + " MB");
    }
    memPanel.textContent = lines.join("\n");
  };
  var memMount = function () {
    document.body.appendChild(memPanel);
    memRender();
    setInterval(memRender, 500);
  };
  if (document.body) memMount();
  else document.addEventListener("DOMContentLoaded", memMount);
}
