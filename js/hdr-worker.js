/* ==========================================================================
   em·ji·ve — HDR decode worker

   Radiance .hdr (RGBE) -> half-float RGBA is plain CPU work: ~30ms for the
   1024x512 environment map on a desktop, several times that on a phone, all of
   it on the main thread at the moment the page is trying to draw its model.
   js/three-viewer.js hands the downloaded file here instead and gets the
   decoded pixels back.

   Only the decode lives here. The download stays on the main thread (it has
   to: that is the request the page's own preload of the file is matched
   against), and so does everything that touches WebGL (PMREM, the upload).

   Message in:   { id, buffer }                  the .hdr file's bytes (copied)
   Message out:  { id, width, height, data, type, colorSpace, minFilter,
                   magFilter, generateMipmaps, flipY }   data is transferred
                 { id, error }                   it could not be decoded

   A module (bundled by Vite, `new Worker(new URL(...), { type: "module" })`
   in three-viewer.js). Anything that stops it running — a page served
   without the bundler (scene-tool.html, the render harness), a browser that
   has no module workers — makes three-viewer.js decode on the main thread
   instead, as it always did.
   ========================================================================== */

import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

var loader = new HDRLoader();

self.onmessage = function (event) {
  var message = event.data;
  try {
    var result = loader.parse(message.buffer);
    self.postMessage({
      id: message.id,
      width: result.width,
      height: result.height,
      data: result.data,
      type: result.type,
      colorSpace: result.colorSpace,
      minFilter: result.minFilter,
      magFilter: result.magFilter,
      generateMipmaps: result.generateMipmaps,
      flipY: result.flipY
    }, [result.data.buffer]);
  } catch (err) {
    self.postMessage({ id: message.id, error: String((err && err.message) || err) });
  }
};
