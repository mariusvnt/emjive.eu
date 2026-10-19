// Lint for typos and dead code in classic scripts sharing window globals; not a style gate.
//   js/*.js, series/<slug>/hero.js   classic scripts (browser globals, not modules)
//   js/three-viewer.js, viewer-entry.js, hdr-worker.js, stack-scene.js   ES modules (Vite)
//   scripts/, vite.config.js         Node tooling
import js from "@eslint/js";
import globals from "globals";

// The window.EmjiveX globals the classic scripts publish to each other.
const EMJIVE = [
  "EmjiveFocusTrap", "EmjiveHelpers", "EmjiveHero", "EmjiveLoadViewer",
  "EmjiveLoader", "EmjiveMenus", "EmjiveMessage", "EmjiveMetalPicker", "EmjiveModelViewer", "EmjiveModifyModal",
  "EmjiveOrderRows", "EmjiveScrollMemory", "EmjiveSelection", "EmjiveSeries",
  "EmjiveSeriesHero"
];
const emjiveGlobals = Object.fromEntries(EMJIVE.map((name) => [name, "readonly"]));

const rules = {
  // Unused arguments are fine (fixed callback signatures).
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-console": "off"
};

export default [
  { ignores: ["dist/**", "node_modules/**", "assets/**", "data/**", "json-tool.html", "scene-tool.html"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js", "series/**/*.js"],
    ignores: ["js/three-viewer.js", "js/viewer-entry.js", "js/hdr-worker.js", "js/stack-scene.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...emjiveGlobals }
    },
    rules
  },
  {
    files: ["js/three-viewer.js", "js/viewer-entry.js", "js/hdr-worker.js", "js/stack-scene.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...emjiveGlobals }
    },
    rules
  },
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser }
    },
    rules
  },
  {
    files: ["vite.config.js", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, __dirname: "readonly" }
    },
    rules
  }
];
