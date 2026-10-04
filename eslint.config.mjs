// Lint for the site's own code. What it is for is catching the mistakes a
// build never will in a codebase of plain classic scripts sharing window
// globals: a typo'd identifier (no-undef), a variable that is assigned and
// never read, an unreachable branch. It is not a style gate — formatting is
// the author's and the surrounding code's call.
//
// Three kinds of file, three environments:
//   js/*.js, series/<slug>/hero.js   classic <script>s: browser globals, NOT
//                                    modules (no import/export, top-level `var`
//                                    stays global-scoped like the browser does)
//   js/three-viewer.js, viewer-entry.js, hdr-worker.js
//                                    ES modules, bundled by Vite
//   scripts/, vite.config.js         Node tooling
import js from "@eslint/js";
import globals from "globals";

// The cross-script API: each classic script publishes one of these on window,
// and the others read it as window.EmjiveX. Listed so a bare reference to one
// is not flagged — and so a typo in a new bare identifier still is.
const EMJIVE = [
  "EmjiveCarousel", "EmjiveFocusTrap", "EmjiveGlass", "EmjiveHero", "EmjiveLoadViewer",
  "EmjiveLoader", "EmjiveMenus", "EmjiveMessage", "EmjiveMetalPicker", "EmjiveModelViewer", "EmjiveModifyModal",
  "EmjiveMotion", "EmjiveOrderRows", "EmjiveScrollMemory", "EmjiveSelection", "EmjiveSeries",
  "EmjiveSeriesHero"
];
const emjiveGlobals = Object.fromEntries(EMJIVE.map((name) => [name, "readonly"]));

const rules = {
  // Unused function arguments are conventional (callbacks with a fixed
  // signature); unused variables and imports are not.
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
  // `catch (e) {}` with a comment is how this codebase says "deliberately
  // ignored"; an empty block with no comment is still reported.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-console": "off"
};

export default [
  { ignores: ["dist/**", "node_modules/**", "assets/**", "data/**", "json-tool.html", "scene-tool.html"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js", "series/**/*.js"],
    ignores: ["js/three-viewer.js", "js/viewer-entry.js", "js/hdr-worker.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...emjiveGlobals }
    },
    rules
  },
  {
    files: ["js/three-viewer.js", "js/viewer-entry.js", "js/hdr-worker.js"],
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
