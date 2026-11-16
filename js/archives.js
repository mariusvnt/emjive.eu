// archives.html: the shelf of studies, one case per study in data/studies.json,
// newest first. A closed case is a spine showing a slice of the study's hero
// picture, its name rising above it. Focusing one (a mouse hover, a long press
// on touch, Enter) opens it to the whole picture, its name turning level over
// it and its manifest text and items under it. One case is open at a time, and it stays
// open until another is focused, a click lands elsewhere or Escape is pressed,
// so the pointer can travel down to the item links.
//
// Arriving on the shelf (the pointer back over it, or a new hold) opens the
// case pointed at, the old one closing where it is. From there the focus is
// read from the pointer's travel in closed-spine steps (zoneAt), not from the
// case under it, which changes size as the focus moves: a mouse sweeping the
// shelf focuses each study as it passes, and on touch a held finger can slide
// along the shelf the same way.

(function () {
  "use strict";

  var shelf = document.getElementById("archivesShelf");
  if (!shelf) return;

  var H = window.EmjiveHelpers;

  // Mirrored into CSS as --archives-hold (the spine lifting under the finger).
  var HOLD_MS = 450;
  var MOVE_SLOP_PX = 10;
  // A click this soon after a touch on the shelf is that touch's, already handled.
  var TOUCH_CLICK_MS = 600;
  // The glide reaches 95% of a move in GLIDE_S when the open case is
  // GLIDE_REF_PX wide, longer as it is wider (by the square root), so a
  // desktop's wide case doesn't sweep past faster than a phone's.
  var GLIDE_S = 0.3;
  var GLIDE_REF_PX = 180;
  // How long the focus rests before its name turns level and its text shows.
  var SETTLE_MS = 100;
  // ?test-studies=N appends N placeholder studies, for trying the shelf with
  // more than the real ones. Test only: nothing links to it.
  var TEST_STUDIES_MAX = 20;

  var row = null;
  var cases = []; // { el, name, spine, cover, go, details, picture, full }
  var rulers = null; // { step, spine, open }: the stack's CSS widths, measured
  var openIndex = -1; // the focused study
  var settledIndex = -1; // the one whose name and text show
  var settleTimer = 0;
  // pos: the study the opening is centred on; amount: how open the stack is (0 to 1).
  // fade, fadeFrom: the openness a cut is closing (startGlide).
  var glide = { pos: { x: 0, v: 0 }, amount: { x: 0, v: 0 }, fade: { x: 0, v: 0 }, fadeFrom: [], target: 0, omega: 0, frame: 0, last: 0 };
  // True once the pointer has left the stack or the finger has lifted.
  var detached = true;
  var zoneOffset = 0; // set by anchor()
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var touch = null;
  var lastTouchEnd = 0;
  var swallowClicks = false;

  /* ---- data ---- */

  function newestFirst(list) {
    return list.slice().sort(function (a, b) {
      return (Number(b.year) || 0) - (Number(a.year) || 0);
    });
  }

  function testStudies(real) {
    var count = Math.min(TEST_STUDIES_MAX, parseInt(new URLSearchParams(window.location.search).get("test-studies"), 10) || 0);
    var base = real[real.length - 1];
    var out = [];
    for (var i = 0; i < count && base; i++) {
      out.push({
        slug: "test-" + (i + 2),
        name: "Study " + (i + 2),
        year: String((Number(base.year) || 0) - i - 1),
        hero: base.hero,
        test: true
      });
    }
    return out;
  }

  function pictureOf(entry) {
    var preload = entry.hero && entry.hero.preload;
    return preload && preload.length ? preload[0] : "";
  }

  /* ---- markup ---- */

  function buildCase(entry, k) {
    var el = H.el("div", "archives__case");
    el.style.setProperty("--k", String(k));
    el.setAttribute("data-index", String(k));
    var detailsId = "archivesDetails" + k;

    var name = el.appendChild(H.el("span", "archives__name", entry.name));
    name.setAttribute("aria-hidden", "true");
    name.insertAdjacentHTML("beforeend", H.ICON_OUT);

    var frame = el.appendChild(H.el("div", "archives__frame"));
    var full = pictureOf(entry);
    var picture = null;
    if (full) {
      picture = frame.appendChild(H.el("img", "archives__picture"));
      picture.alt = "";
      picture.decoding = "async";
      // The landscape picture on phones too: a case opens at the spine's
      // height, where the phone's portrait crop would barely widen.
      picture.src = window.EmjiveLoader ? window.EmjiveLoader.variant(full, "lo") : full;
    }

    var spine = frame.appendChild(H.el("button", "archives__spine"));
    spine.type = "button";
    spine.setAttribute("aria-label", entry.name + ", " + entry.year);
    spine.setAttribute("aria-expanded", "false");
    spine.setAttribute("aria-controls", detailsId);

    // A button acting as a link, not an <a href>: holding a link on iOS opens
    // Safari's link preview, which takes over the shelf's hold and slide.
    var cover = frame.appendChild(H.el("button", "archives__cover"));
    cover.type = "button";
    cover.setAttribute("role", "link");
    cover.setAttribute("aria-label", entry.name + " study");
    var href = entry.test ? "" : window.EmjiveStudies.mainHref(entry.slug);
    function go(e) {
      if (!href) return;
      if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) window.open(href, "_blank", "noopener");
      else window.location.href = href;
    }
    cover.addEventListener("click", go);
    cover.addEventListener("auxclick", function (e) { if (e.button === 1) go(e); });

    var details = H.el("section", "archives__details");
    details.id = detailsId;
    details.style.setProperty("--k", String(k));
    details.setAttribute("aria-label", entry.name);

    return { el: el, name: name, spine: spine, cover: cover, go: go, details: details, picture: picture, full: full };
  }

  function fillDetails(details, intro, items) {
    if (intro) details.appendChild(H.el("p", "archives__intro", intro));
    if (!items.length) return;
    var list = details.appendChild(H.el("ul", "archives__items"));
    items.forEach(function (item) {
      var li = list.appendChild(H.el("li"));
      if (item.href) {
        var a = li.appendChild(H.el("a", "", item.name));
        a.href = item.href;
      } else {
        li.appendChild(H.el("span", "", item.name));
      }
    });
  }

  // A study whose files fail shows without text or items; the others don't wait on it.
  function loadDetails(entry, details) {
    if (entry.test) {
      fillDetails(details, "", [1, 2, 3, 4].map(function (n) { return { name: "Item " + n }; }));
      return;
    }
    var studies = window.EmjiveStudies;
    Promise.all([
      studies.loadManifest(entry.slug).catch(function () { return {}; }),
      studies.loadProducts(entry.slug).catch(function () { return []; })
    ]).then(function (results) {
      fillDetails(details, results[0].intro || "", results[1].map(function (product) {
        return { name: product.name || "", href: studies.productHref(product) };
      }));
    });
  }

  /* ---- open / close ---- */

  // The focused case (data-focus) takes the pointer as its study's link at
  // once and starts widening; its name turns level and its text shows
  // (data-open) only once the focus has rested, so a sweep only slides pictures.
  function setOpen(index) {
    if (index === openIndex) {
      if (index >= 0) detached = false;
      return;
    }
    // Back after the pointer left the stack or the finger lifted: the old case
    // closes where it is while the new one opens, rather than gliding across.
    var cut = detached;
    detached = index < 0;
    var focused = document.activeElement;
    var refocus = null;
    cases.forEach(function (c, k) {
      var on = k === index;
      c.el.toggleAttribute("data-focus", on);
      c.spine.setAttribute("aria-expanded", on ? "true" : "false");
      // The control under the focus hides as the case changes state.
      if (on && focused === c.spine) refocus = c.cover;
      if (!on && k === openIndex && (focused === c.cover || c.details.contains(focused))) refocus = c.spine;
    });
    openIndex = index;
    if (refocus) refocus.focus();
    settle(-1);
    clearTimeout(settleTimer);
    if (index >= 0) settleTimer = setTimeout(function () { settle(openIndex); }, SETTLE_MS);
    startGlide(cut);
  }

  function settle(index) {
    if (index === settledIndex) return;
    cases.forEach(function (c, k) {
      var on = k === index;
      c.el.toggleAttribute("data-open", on);
      c.details.toggleAttribute("data-open", on);
    });
    settledIndex = index;
  }

  // One position glides toward the focused study and sets every case's
  // openness (--w, 0 to 1): neighbours share it as it passes, so the open
  // width always sums to one case and the centred stack holds still, and a
  // sweep is one motion rather than a width transition restarted at each border.
  // A critically damped spring: it sets off gently and carries its speed from
  // one study to the next, where an ease toward each would jump at every change.
  //
  // A cut hands the openness as it stands to a fading layer (fadeFrom, scaled
  // by fade) and opens the new case from nothing. The two springs start at
  // rest with the same omega, so the fade closes exactly as the new case
  // opens and the widths still sum to one case.
  function startGlide(cut) {
    // 95% of a move from rest at omega * t = 4.74.
    var caseW = rulers.open.getBoundingClientRect().width || GLIDE_REF_PX;
    glide.omega = 4.74 / (GLIDE_S * Math.sqrt(caseW / GLIDE_REF_PX));
    if (cut && openIndex >= 0 && glide.amount.x + glide.fade.x > 0.01) {
      glide.fadeFrom = cases.map(function (c, k) { return openness(k); });
      glide.fade = { x: 1, v: 0 };
      glide.amount = { x: 0, v: 0 };
    }
    if (openIndex >= 0) {
      // From closed, a case opens where it stands, not gliding over from the last one.
      if (glide.amount.x < 0.01) glide.pos = { x: openIndex, v: 0 };
      glide.target = openIndex;
    }
    if (glide.frame) return;
    glide.last = 0;
    glide.frame = requestAnimationFrame(stepGlide);
  }

  function openness(k) {
    return glide.amount.x * Math.max(0, 1 - Math.abs(glide.pos.x - k)) + glide.fade.x * (glide.fadeFrom[k] || 0);
  }

  // Semi-implicit Euler in steps of 8 ms at most, steady at any frame rate.
  function spring(s, target, dt) {
    var w = glide.omega;
    for (var left = dt; left > 0; left -= 0.008) {
      var h = Math.min(left, 0.008);
      s.v += (-2 * w * s.v - w * w * (s.x - target)) * h;
      s.x += s.v * h;
    }
  }

  function stepGlide(now) {
    glide.frame = 0;
    var goal = openIndex >= 0 ? 1 : 0;
    var dt = glide.last ? Math.min(Math.max(now - glide.last, 0), 100) / 1000 : 1 / 60;
    glide.last = now;
    if (reduceMotion.matches) {
      glide.pos = { x: glide.target, v: 0 };
      glide.amount = { x: goal, v: 0 };
      glide.fade = { x: 0, v: 0 };
    } else {
      spring(glide.pos, glide.target, dt);
      spring(glide.amount, goal, dt);
      spring(glide.fade, 0, dt);
    }
    // Kept on the shelf and never past fully open, where the widths would no
    // longer sum to one case.
    if (glide.pos.x < 0 || glide.pos.x > cases.length - 1) {
      glide.pos.x = H.clamp(glide.pos.x, 0, cases.length - 1);
      glide.pos.v = 0;
    }
    if (glide.amount.x < 0 || glide.amount.x > 1) {
      glide.amount.x = H.clamp(glide.amount.x, 0, 1);
      glide.amount.v = 0;
    }
    if (glide.fade.x < 0) glide.fade = { x: 0, v: 0 };
    var done = Math.abs(glide.target - glide.pos.x) < 0.002 && Math.abs(glide.pos.v) < 0.01 &&
      Math.abs(goal - glide.amount.x) < 0.002 && Math.abs(glide.amount.v) < 0.01 &&
      glide.fade.x < 0.002 && Math.abs(glide.fade.v) < 0.01;
    if (done) {
      glide.pos = { x: glide.target, v: 0 };
      glide.amount = { x: goal, v: 0 };
      glide.fade = { x: 0, v: 0 };
    }
    cases.forEach(function (c, k) {
      c.el.style.setProperty("--w", openness(k).toFixed(4));
    });
    if (!done) glide.frame = requestAnimationFrame(stepGlide);
  }

  /* ---- which study the pointer points at ---- */

  // Each study owns one spine step of the closed stack, centred in the row
  // whatever is open, shifted by the last anchor. The centred row keeps the
  // open case within reach of its zone, so the pointer stays over the case it
  // focuses.
  function ruler(prop) {
    var el = H.el("span", "archives__ruler");
    el.style.width = "var(" + prop + ")";
    el.setAttribute("aria-hidden", "true");
    row.appendChild(el);
    return el;
  }

  // clientX in steps from the closed stack's left edge, unclamped, or NaN
  // outside the stack as it stands (closed, or with a case open).
  function stackPos(x, clamped) {
    var r = row.getBoundingClientRect();
    var step = rulers.step.getBoundingClientRect().width;
    var gap = step - rulers.spine.getBoundingClientRect().width;
    var n = cases.length;
    var centre = r.left + r.width / 2;
    var span = openIndex < 0 ? n * step - gap : (n - 1) * step + rulers.open.getBoundingClientRect().width;
    if (!clamped && Math.abs(x - centre) > span / 2) return NaN;
    return (x - (centre - (n * step - gap) / 2)) / step;
  }

  // On arrival (the pointer back on the stack, or a new hold) the case under
  // the pointer opens, whatever its zone; the zones then shift so that this
  // spot is that study's middle, and moves count from there.
  function anchor(k, x) {
    zoneOffset = k + 0.5 - stackPos(x, true);
  }

  // The study at clientX, or -1 outside the stack unless clamped.
  function zoneAt(x, clamped) {
    var u = stackPos(x, clamped);
    if (isNaN(u)) return -1;
    return H.clamp(Math.floor(u + zoneOffset), 0, cases.length - 1);
  }

  /* ---- mouse ---- */

  function onMouseMove(e) {
    if (e.pointerType !== "mouse") return;
    // The open case's name is its link: reaching for it never shifts the focus.
    var name = e.target.closest && e.target.closest(".archives__name");
    if (name && settledIndex >= 0 && name === cases[settledIndex].name) return;
    if (isNaN(stackPos(e.clientX, false))) {
      detached = true;
      return;
    }
    if (detached) {
      // Only a case's picture and name take the pointer, so this is the one pointed at.
      var k = caseIndexAt(e.target);
      if (k < 0) return;
      anchor(k, e.clientX);
      setOpen(k);
      return;
    }
    setOpen(zoneAt(e.clientX, false));
  }

  function onMouseLeave(e) {
    if (e.pointerType === "mouse") detached = true;
  }

  /* ---- touch: hold, then slide ---- */

  function caseIndexAt(target) {
    var el = target && target.closest ? target.closest(".archives__case") : null;
    return el ? Number(el.getAttribute("data-index")) : -1;
  }

  function endHold() {
    if (!touch) return;
    clearTimeout(touch.timer);
    cases[touch.k].el.classList.remove("is-pressed");
  }

  function nudge(k) {
    var el = cases[k].el;
    el.classList.remove("is-nudged");
    // Restarts the animation on a second tap.
    void el.offsetWidth;
    el.classList.add("is-nudged");
  }

  // While a finger is on the shelf no text on the page is selectable: iOS
  // otherwise answers a hold with a selection of the nearest text it finds.
  function lockSelection(on) {
    document.documentElement.classList.toggle("is-archives-touch", on);
    if (on) return;
    var selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  }

  function onTouchStart(e) {
    endHold();
    touch = null;
    lockSelection(true);
    if (e.touches.length !== 1) return;
    var k = caseIndexAt(e.target);
    if (k < 0) return;
    var t = e.touches[0];
    touch = { k: k, x: t.clientX, y: t.clientY, held: false, timer: 0 };
    // An open case is already up: a tap on it goes to the study, a hold slides from it.
    if (k !== openIndex) cases[k].el.classList.add("is-pressed");
    touch.timer = setTimeout(function () {
      if (!touch) return;
      endHold();
      touch.held = true;
      swallowClicks = true;
      anchor(touch.k, touch.x);
      setOpen(touch.k);
    }, HOLD_MS);
  }

  function onTouchMove(e) {
    if (!touch) return;
    var t = e.touches[0];
    if (!touch.held) {
      if (Math.abs(t.clientX - touch.x) > MOVE_SLOP_PX || Math.abs(t.clientY - touch.y) > MOVE_SLOP_PX) {
        endHold();
        touch = null;
      }
      return;
    }
    // Held: the finger now drives the focus, not the page's scroll.
    e.preventDefault();
    setOpen(zoneAt(t.clientX, true));
  }

  function onTouchEnd(e) {
    lastTouchEnd = Date.now();
    if (!e.touches.length) {
      lockSelection(false);
      detached = true;
    }
    if (!touch) return;
    endHold();
    if (!touch.held && touch.k !== openIndex) nudge(touch.k);
    touch = null;
  }

  function onTouchCancel() {
    endHold();
    touch = null;
    lockSelection(false);
    detached = true;
  }

  /* ---- wiring ---- */

  function wire() {
    cases.forEach(function (c, k) {
      c.el.addEventListener("animationend", function () { c.el.classList.remove("is-nudged"); });
      // Enter or a screen reader opens it; a touch only by holding (onTouchStart).
      c.spine.addEventListener("click", function (e) {
        if (Date.now() - lastTouchEnd < TOUCH_CLICK_MS) return;
        setOpen(k);
        if (e.detail === 0) c.cover.focus();
      });
      // The name (and its arrow) is the open case's link too; on a closed
      // case a mouse click opens it, a touch only by holding.
      c.name.addEventListener("click", function (e) {
        if (k === settledIndex) c.go(e);
        else if (Date.now() - lastTouchEnd >= TOUCH_CLICK_MS) setOpen(k);
      });
      c.name.addEventListener("auxclick", function (e) {
        if (e.button === 1 && k === settledIndex) c.go(e);
      });
    });

    row.addEventListener("pointermove", onMouseMove);
    row.addEventListener("pointerleave", onMouseLeave);
    row.addEventListener("touchstart", onTouchStart, { passive: true });
    // Not passive: a held finger's moves are kept from scrolling the page.
    row.addEventListener("touchmove", onTouchMove, { passive: false });
    row.addEventListener("touchend", onTouchEnd, { passive: true });
    row.addEventListener("touchcancel", onTouchCancel, { passive: true });
    // The click a hold ends with would land on the case it just opened.
    row.addEventListener("click", function (e) {
      if (!swallowClicks) return;
      swallowClicks = false;
      if (Date.now() - lastTouchEnd < TOUCH_CLICK_MS) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    // Android's long-press menu over the pictures and links.
    row.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    document.addEventListener("selectstart", function (e) {
      if (document.documentElement.classList.contains("is-archives-touch")) e.preventDefault();
    });

    // Pointer events, not click: iOS sends no click for a tap on a non-interactive spot. A tap
    // away is one that lifts near where it went down; a scroll ends in pointercancel instead.
    var away = null;
    function isAway(target) {
      return !(target.closest && target.closest(".archives__frame, .archives__name, .archives__details"));
    }
    document.addEventListener("pointerdown", function (e) {
      away = openIndex !== -1 && e.isPrimary && isAway(e.target) ? { x: e.clientX, y: e.clientY } : null;
    });
    document.addEventListener("pointerup", function (e) {
      if (!away || !e.isPrimary) return;
      var moved = Math.hypot(e.clientX - away.x, e.clientY - away.y);
      away = null;
      if (moved <= MOVE_SLOP_PX) setOpen(-1);
    });
    document.addEventListener("pointercancel", function () { away = null; });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || openIndex === -1) return;
      var focused = document.activeElement;
      if (focused && focused !== document.body && !shelf.contains(focused)) return;
      setOpen(-1);
    });
  }

  /* ---- start ---- */

  function render(studies) {
    var list = newestFirst(studies);
    list = list.concat(testStudies(list));
    if (!list.length) return;

    shelf.style.setProperty("--n", String(list.length));
    shelf.style.setProperty("--archives-hold", HOLD_MS + "ms");
    row = shelf.appendChild(H.el("div", "archives__row"));
    var area = shelf.appendChild(H.el("div", "archives__details-area"));
    rulers = { step: ruler("--spine-step"), spine: ruler("--spine-w"), open: ruler("--case-w") };

    list.forEach(function (entry, k) {
      var c = buildCase(entry, k);
      cases.push(c);
      row.appendChild(c.el);
      area.appendChild(c.details);
      loadDetails(entry, c.details);
    });
    wire();

    var loader = window.EmjiveLoader;
    if (!loader) return;
    cases.forEach(function (c) {
      if (c.picture) loader.upgradeImage(c.picture, c.full);
    });
  }

  window.EmjiveStudies.ready
    .then(function () { render(window.EmjiveStudies.all()); })
    .catch(function (err) {
      console.error("Could not load the archives:", err);
      window.EmjiveMessage.show(shelf,
        "This page couldn't be loaded. Check your connection and try again.",
        { label: "Reload" }, "alert");
    });
})();
