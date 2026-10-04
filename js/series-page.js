/* ==========================================================================
   series.html — renders one series' design manifest.

   The page itself is still an empty shell by design; this only wires up the
   route (title, year, subtitle, and a real not-found state) so the URL is
   verifiable now, while the body stays blank until the manifest is designed.
   Rendering manifest.json's "sections" array belongs here later — see
   dev-guidelines/data.md for the schema.
   ========================================================================== */

(function () {
  "use strict";

  var loadingEl = document.getElementById("seriesManifestLoading");
  var contentEl = document.getElementById("seriesManifestContent");
  if (!loadingEl || !contentEl) return;

  // The page's arrival loader (js/loader.js) covers the page until this is
  // called — on success once the manifest is in, on failure once the
  // not-found message is in place.
  function pageReady() {
    if (window.EmjiveLoader) window.EmjiveLoader.pageReady();
  }

  function showNotFound(slug) {
    loadingEl.hidden = false;
    loadingEl.textContent = slug
      ? "No series called “" + slug + "” — "
      : "No series specified — ";
    var link = document.createElement("a");
    link.className = "btn";
    link.href = "archives.html";
    link.textContent = "Browse the archives";
    loadingEl.appendChild(link);
    pageReady();
  }

  window.EmjiveSeries.ready
    .then(function () {
      // Deliberately NOT EmjiveSeries.slug: that falls back to the featured
      // series, and silently showing the wrong series' manifest is worse
      // than saying it doesn't exist.
      var slug = window.EmjiveSeries.requestedSlug();
      var entry = slug && window.EmjiveSeries.get(slug);
      if (!entry) return showNotFound(slug);

      return window.EmjiveSeries.loadManifest(slug).then(function (manifest) {
        var title = manifest.title || entry.name || slug;
        document.title = title + " — em·ji·ve";

        document.getElementById("seriesManifestYear").textContent =
          manifest.year || entry.year || "";
        document.getElementById("seriesManifestTitle").textContent = title;

        var subtitleEl = document.getElementById("seriesManifestSubtitle");
        subtitleEl.textContent = manifest.subtitle || "";
        subtitleEl.hidden = !manifest.subtitle;

        loadingEl.hidden = true;
        contentEl.hidden = false;
        pageReady();
      });
    })
    .catch(function (err) {
      // Not "no such series" — that case is handled above without throwing.
      // This is a failed request or an exception, which the old catch
      // reported as a missing series.
      console.error("Could not load the series:", err);
      loadingEl.hidden = false;
      contentEl.hidden = true;
      loadingEl.textContent = "This page couldn't be loaded. Check your connection and try again. ";
      loadingEl.setAttribute("role", "alert");
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn";
      retry.textContent = "Try again";
      retry.addEventListener("click", function () { window.location.reload(); });
      loadingEl.appendChild(retry);
      pageReady();
    });
})();
