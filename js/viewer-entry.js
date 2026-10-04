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
     "eager"  — start now (product.html: the model is the page);
     "idle"   — start once the browser is idle (index.html: the grid's models
                sit below the hero);
     absent   — only when something asks (the Modify sheet, on every other
                page).
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
  var start = function () { window.EmjiveLoadViewer().catch(function () {}); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 4000 });
  else setTimeout(start, 2000);
}
