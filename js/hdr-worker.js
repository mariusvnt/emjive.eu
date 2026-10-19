// HDR decode worker: Radiance .hdr -> half-float RGBA, off the main thread.
// The fetch and all WebGL work stay in js/three-viewer.js, which decodes on the
// main thread itself when module workers are unavailable.
//
// In:  { id, buffer }
// Out: { id, width, height, data, type, colorSpace, minFilter, magFilter,
//        generateMipmaps, flipY } (data transferred) | { id, error }

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
