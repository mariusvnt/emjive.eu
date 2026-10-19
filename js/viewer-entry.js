// Lazy 3D viewer loader: the only 3D code pages load up front. A module so the
// dynamic import resolves through Vite to the hashed three-viewer.js chunk.
//
// window.EmjiveLoadViewer() -> Promise of the viewer factory
// (window.EmjiveModelViewer). Cached, failures included, so a dropped
// connection keeps the icon fallbacks instead of retrying on every scroll.
//
// data-viewer on <html> sets when to start fetching:
//   "eager"  now
//   "idle"   once the page has revealed and the browser is idle (index.html)
//   absent   only when something asks

var pending = null;

window.EmjiveLoadViewer = function () {
  if (!pending) {
    pending = import("./three-viewer.js").then(function () {
      return window.EmjiveModelViewer;
    });
  }
  return pending;
};

// The wheel's shared 3D scene (js/stack-scene.js), requested by
// js/gallery-stack.js. Resolves to createStackScene; cached like the viewer.
var stackPending = null;

window.EmjiveLoadStack = function () {
  if (!stackPending) {
    stackPending = import("./stack-scene.js").then(function (module) {
      return module.createStackScene;
    });
  }
  return stackPending;
};

var when = document.documentElement.getAttribute("data-viewer");
if (when === "eager") {
  window.EmjiveLoadViewer().catch(function () {});
} else if (when === "idle") {
  // Not needed for first paint: start after the page reveals and the browser is
  // idle, or at the first sign of scrolling toward the models, so the chunk
  // doesn't compete with the hero picture.
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

/* ?mem=1: a memory read-out panel, for phones with no attachable inspector
   (iOS Safari reloads tabs that use too much memory).
     3D viewers     live WebGL contexts (gallery max 3, product page 1)
     model arrays   geometry still held as JS arrays; ~0 MB once drawn
     GPU objects    geometries / textures held by live renderers
     Draco workers  0 a few seconds after the last load
     phone images   whether phone picture variants apply, and the window it judged
     JS heap        where reported (not iOS Safari) */
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
