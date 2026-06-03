// Backend picker.
//
// WebGPU if the browser exposes it, otherwise the proven WebGL1 playground
// (script.js) — which stays the untouched fallback safety net. script-webgpu.js
// also self-falls-back if the adapter/device request fails at runtime, so this
// only handles the "no navigator.gpu at all" and "file failed to load" cases.
(function () {
  var useWebGPU = typeof navigator !== "undefined" && !!navigator.gpu;
  var src = useWebGPU ? "script-webgpu.js" : "script.js";

  var s = document.createElement("script");
  s.src = src;
  s.onerror = function () {
    if (useWebGPU) {
      var f = document.createElement("script");
      f.src = "script.js";
      document.head.appendChild(f);
    }
  };
  document.head.appendChild(s);
})();
