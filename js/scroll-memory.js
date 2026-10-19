// Homepage scroll memory (index.html only): Back returns to the exact offset
// on the first painted frame. Native restoration can't: the page reaches its
// height only after series.json, the hero bundle and products.json, so it
// clamps to the top. This reserves the previous height before first paint and
// scrolls inside a rAF, before that frame paints.
//
// Blocking in <head>: the reservation must exist before <body> is parsed.
// Also decides the landing (data-hero="play"|"skip", data-gallery-view=
// "stack"|"grid" on <html>) for the same reason, and stores both per history
// entry so Back gets them back.

(function () {
  "use strict";

  var STORAGE_PREFIX = "emjive:scroll:";
  // The last chosen view this visit (cleared on a landing).
  var VIEW_KEY = "emjive_gallery_view";

  var html = document.documentElement;
  var H = window.EmjiveHelpers;

  /* ---- the landing ----
     1. The entry's saved state (Back, reload): the exact layout left.
     2. #products in the address: skip the hero.
     3. Otherwise the hero plays when arriving from outside the site, and is
        skipped within a visit. A landing resets the view to the wheel; within a
        visit it is the visitor's last choice. Blocked storage keeps the defaults. */
  function cameFromThisSite() {
    try {
      return !!document.referrer && new URL(document.referrer).origin === window.location.origin;
    } catch (e) {
      return false;
    }
  }

  function decideLanding(saved) {
    var landing = !saved && !cameFromThisSite();
    if (landing) H.removeStorage("localStorage", VIEW_KEY);
    var view = saved && saved.view ? saved.view : H.readStorage("localStorage", VIEW_KEY);
    if (view !== "grid") view = "stack";
    var hero;
    if (saved && saved.hero) hero = saved.hero;
    else if (window.location.hash === "#products") hero = "skip";
    else hero = cameFromThisSite() ? "skip" : "play";
    if (hero !== "skip") hero = "play";
    html.setAttribute("data-gallery-view", view);
    html.setAttribute("data-hero", hero);
    // fresh: nothing saved yet for this entry (an arrival, not Back). A skipped
    // hero in the wheel view is then landed at its end (series/<slug>/hero.js).
    return { view: view, hero: hero, fresh: !saved };
  }

  // No history.scrollRestoration: leave restoration to the browser; still decide the landing.
  if (!("scrollRestoration" in window.history)) {
    decideLanding(null);
    return;
  }
  var RESTORING_CLASS = "emjive-restoring-scroll";
  var HEIGHT_VAR = "--emjive-restore-height";

  // Hard cap on the restore; whatever hasn't landed is released as-is.
  var DEADLINE_MS = 1200;
  // Grace for the visible pictures to decode before the gallery is revealed (settle()).
  var SETTLE_MS = 250;
  var SAVE_THROTTLE_MS = 300;

  // Stop the re-assert loop, not the restore window (see userTookOver).
  var TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

  function now() {
    return Date.now();
  }

  /* ---- per-history-entry key ----
     A token in history.state, not the URL: two homepage entries can sit at
     different offsets. The position itself goes to sessionStorage, since
     Safari rate-limits replaceState too hard to write on every scroll. */
  var key = (function () {
    var state;
    try { state = window.history.state; } catch (e) { state = null; }
    if (state && state.emjiveScrollKey) return state.emjiveScrollKey;

    var minted = "s" + now().toString(36) + Math.random().toString(36).slice(2, 8);
    var next = {};
    if (state && typeof state === "object") {
      for (var k in state) {
        if (Object.prototype.hasOwnProperty.call(state, k)) next[k] = state[k];
      }
    }
    next.emjiveScrollKey = minted;
    try {
      // No URL argument: the address stays as is.
      window.history.replaceState(next, "");
    } catch (e) {
      // Can't persist the token: leave it to the browser.
      return null;
    }
    return minted;
  })();

  if (!key) {
    decideLanding(null);
    return;
  }

  // This entry's record: { y, h, hero, view, wheel }.
  function readEntry() {
    return H.readStorageJson("sessionStorage", STORAGE_PREFIX + key);
  }

  // Only an entry with an offset to return to is a restore.
  function readSaved() {
    var entry = readEntry();
    return entry && entry.y > 0 ? entry : null;
  }

  // What the head decided, then updated by js/gallery.js (remember()).
  var landing = decideLanding(readEntry());

  // The product left at the top of the wheel (js/gallery-stack.js).
  var wheel = (function () {
    var entry = readEntry();
    return entry && entry.wheel ? String(entry.wheel) : null;
  })();

  /* ---- saving ---- */

  // The height makes the offset reachable on the next load (beginRestore).
  function save() {
    if (restoring) return; // mid-restore: not the visitor's position
    H.writeStorage("sessionStorage", STORAGE_PREFIX + key, JSON.stringify({
      y: Math.round(window.pageYOffset || window.scrollY || 0),
      h: Math.round(html.scrollHeight),
      hero: landing.hero,
      view: landing.view,
      wheel: wheel
    }));
  }

  var saveTimer = 0;
  function throttledSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      save();
    }, SAVE_THROTTLE_MS);
  }

  // pagehide is the one iOS fires reliably (and unload would block bfcache);
  // visibilitychange covers app switches, the throttled scroll a killed tab.
  window.addEventListener("pagehide", save);
  window.addEventListener("scroll", throttledSave, { passive: true });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") save();
  });

  /* ---- the restore window ---- */

  var restoring = false;
  // Set on the visitor's first input: stops re-asserting the offset, but keeps
  // the height reservation until the content outgrows it, or the page would
  // collapse under them.
  var userTookOver = false;
  var contentReadyCalled = false;
  var targetY = 0;
  var reservedHeight = 0;
  var deadline = 0;
  var rafId = 0;

  function tallEnough() {
    return html.scrollHeight >= reservedHeight;
  }

  function expired() {
    return now() >= deadline;
  }

  function tick() {
    rafId = 0;
    if (!restoring) return;
    // document.body can still be null on the first frames.
    if (document.body && !userTookOver) H.jumpScroll(targetY);
    if (expired()) {
      endRestore();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function endRestore() {
    if (!restoring) return;
    restoring = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    TAKEOVER_EVENTS.forEach(function (type) {
      window.removeEventListener(type, takeOver, true);
    });
    // A no-op for layout by now: settle() waits for the content to reach the height.
    html.classList.remove(RESTORING_CLASS);
    html.style.removeProperty(HEIGHT_VAR);
  }

  function takeOver() {
    userTookOver = true;
  }

  function beginRestore(entry) {
    restoring = true;
    targetY = entry.y;
    reservedHeight = entry.h || 0;
    deadline = now() + DEADLINE_MS;

    html.style.setProperty(HEIGHT_VAR, reservedHeight + "px");
    html.classList.add(RESTORING_CLASS);

    // Capture phase, so handlers that stop propagation (TrackballControls) can't hide input.
    TAKEOVER_EVENTS.forEach(function (type) {
      window.addEventListener(type, takeOver, { passive: true, capture: true });
    });

    // Armed here too, so an error elsewhere can't leave the gallery hidden.
    setTimeout(endRestore, DEADLINE_MS);

    tick();
  }

  /* ---- settling before the gallery is revealed ----
     The gallery stays visibility: hidden during the restore (css/style.css), so
     its pictures appear complete. Everything races the deadline. */

  // Polls the document height: one outcome instead of three load signals.
  function heightReady() {
    return new Promise(function (resolve) {
      (function check() {
        if (tallEnough() || expired()) return resolve();
        requestAnimationFrame(check);
      })();
    });
  }

  // The gallery pictures on screen at the restored offset (none in the hero).
  function visibleFigureImages() {
    var viewportHeight = window.innerHeight || 0;
    var all = document.querySelectorAll(".grid-tile__card:first-child, .stack-item__img");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var rect = all[i].getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < viewportHeight) out.push(H.imageReady(all[i]));
    }
    if (document.fonts && document.fonts.ready) out.push(document.fonts.ready);
    return out;
  }

  // The page's own "done" check (holdUntil()), polled each frame.
  var layoutCheck = null;

  function layoutReady() {
    return new Promise(function (resolve) {
      (function check() {
        var done;
        try { done = !layoutCheck || layoutCheck(); } catch (e) { done = true; }
        if (done || !restoring || expired()) return resolve();
        requestAnimationFrame(check);
      })();
    });
  }

  function settle() {
    heightReady()
      .then(function () {
        if (!restoring) return;
        if (!userTookOver) H.jumpScroll(targetY);
        return Promise.race([Promise.all(visibleFigureImages()), H.wait(SETTLE_MS)]);
      })
      .then(function () {
        if (!restoring) return;
        return layoutReady();
      })
      .then(function () {
        if (!restoring) return;
        // Two frames: hero.js and js/selection-bar.js react to the restored offset
        // before the gallery shows.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            if (!userTookOver) H.jumpScroll(targetY);
            endRestore();
          });
        });
      })
      .catch(endRestore);
  }

  /* ---- bfcache ----
     A bfcache restore keeps the layout but still needs the scroll, since
     scrollRestoration is "manual"; pageshow precedes its first frame. */
  window.addEventListener("pageshow", function (event) {
    if (!event.persisted) return;
    var entry = readSaved();
    if (entry) H.jumpScroll(entry.y);
  });

  /* ---- go ---- */

  // Before anything is read, so the browser's clamped restore never runs.
  // Per history entry, so other pages are unaffected.
  window.history.scrollRestoration = "manual";

  window.EmjiveScrollMemory = {
    isRestoring: function () { return restoring; },

    // js/gallery.js: hold the restore until fn() reports the gallery laid out
    // (or the deadline), or the hero would show drawn for another layout.
    holdUntil: function (fn) {
      if (typeof fn === "function") layoutCheck = fn;
    },

    // { hero, view, fresh }, as decided above.
    landing: function () { return landing; },

    // js/gallery.js: record a view or hero change for this entry, at once.
    remember: function (patch) {
      if (!patch) return;
      if (patch.hero === "play" || patch.hero === "skip") landing.hero = patch.hero;
      if (patch.view === "stack" || patch.view === "grid") landing.view = patch.view;
      save();
    },

    // js/gallery-stack.js: the product at the top of the wheel once turned (null: as landed).
    rememberWheel: function (id) {
      wheel = id === null || id === undefined ? null : String(id);
      save();
    },
    wheel: function () { return wheel; },

    // js/gallery.js, once the gallery is rendered and filtered: the last height change.
    contentReady: function () {
      if (contentReadyCalled) return;
      contentReadyCalled = true;
      if (!restoring) return;
      if (!userTookOver) H.jumpScroll(targetY);
      settle();
    }
  };

  var savedEntry = readSaved();
  if (savedEntry) beginRestore(savedEntry);
})();
