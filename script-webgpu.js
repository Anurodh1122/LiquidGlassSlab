// Liquid glass slab — WebGPU port.
//
// Same effect as the WebGL1 playground (script.js): SDF rounded box, gradient
// edge-normal refraction, chromatic dispersion, frosted blur, border lift,
// tint, drop shadow — plus identical interaction (sliders, presets, drag, theme,
// upload, resize). Only the GPU plumbing differs (WebGPU + WGSL + multi-pass).
//
// Blur — separable two-pass Gaussian:
//   The background is pre-blurred once per redraw (11-tap horizontal -> 11-tap
//   vertical = an exact, wide, jitter-free Gaussian). The main pass then samples
//   that pre-blurred texture at each channel's refraction offset. Because a
//   Gaussian blur commutes with the sample location, this is mathematically
//   identical to blurring around each offset center — but the main pass costs ~3
//   texture reads instead of 75/363, and there is no kernel banding to see.
//
// Optimizations: DPR cap (1.5 mobile / 2.0 desktop); high-performance adapter
// preference; needsRedraw gating. Everything is in one async IIFE so the WebGL1
// fallback (loaded on failure) has no clashing top-level globals.

(async function () {
  const canvas = document.getElementById("canvas");

  function loadFallback(reason) {
    console.warn("[glass] WebGPU unavailable — falling back to WebGL1:", reason);
    const s = document.createElement("script");
    s.src = "script.js";
    document.head.appendChild(s);
  }

  if (!navigator.gpu) return loadFallback("navigator.gpu missing");

  // GPU selection preference (persisted). "auto" passes no hint; the other two
  // are honoured well on the WebGPU/D3D12/Metal path. Switching needs a fresh
  // adapter+device, so the UI persists this and reloads.
  const GPU_KEY = "glassGpuPref";
  const gpuPref = localStorage.getItem(GPU_KEY) || "high-performance";
  // powerPreference is currently IGNORED on Windows (crbug.com/369219127) and
  // logs a console warning when passed, so skip it there — the browser picks the
  // GPU regardless. Still passed on macOS/Linux, where hybrid laptops honour it
  // to favour the dGPU. "auto" never passes a hint.
  const isWindows =
    navigator.userAgentData?.platform === "Windows" ||
    /Windows/i.test(navigator.userAgent);
  const powerPreference =
    gpuPref === "auto" || isWindows ? undefined : gpuPref;

  let adapter, device;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference });
    if (adapter) device = await adapter.requestDevice();
  } catch (e) {
    return loadFallback(e);
  }
  if (!device) return loadFallback("no adapter/device");

  // Surface which GPU we actually got (dGPU vs iGPU).
  let gpuInfoStr = "WebGPU";
  try {
    const info = adapter.info || (await adapter.requestAdapterInfo?.());
    if (info) {
      gpuInfoStr =
        [info.vendor, info.architecture || info.device]
          .filter(Boolean)
          .join(" · ") || "WebGPU";
      console.info("[glass] WebGPU on:", gpuInfoStr);
    }
  } catch {}

  device.lost.then((d) => console.warn("[glass] WebGPU device lost:", d.reason));

  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const isMobile = /Mobi|Android/i.test(navigator.userAgent);

  // DPR cap — backing-store resolution limit. renderDpr is set in resize() and
  // reused by render() so canvas size and the shader's dpr always agree.
  const MAX_DPR = isMobile ? 1.5 : 2.0;
  let renderDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  // ============ SHADERS (WGSL) ============

  // Shared fullscreen-triangle-pair vertex stage (no vertex buffer).
  const VS = `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0)       uv  : vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> VSOut {
  var P = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
  );
  let p = P[vi];
  var o : VSOut;
  o.pos = vec4<f32>(p, 0.0, 1.0);
  o.uv  = vec2<f32>(p.x, -p.y) * 0.5 + vec2<f32>(0.5, 0.5);
  return o;
}
`;

  // Separable 1D Gaussian. dir is (1,0) for the horizontal pass, (0,1) for the
  // vertical. Weight exp(-i^2/40) over i in -5..5 reproduces the baseline 11x11
  // kernel exactly when applied in both directions. Stride i*bs/res matches the
  // playground's blur slider behaviour (bs in device px).
  const WGSL_BLUR =
    VS +
    `
struct BlurU {
  res : vec2<f32>,
  dir : vec2<f32>,
  bs  : f32,
};
@group(0) @binding(0) var<uniform> B : BlurU;
@group(0) @binding(1) var samp0 : sampler;
@group(0) @binding(2) var srcTex : texture_2d<f32>;

@fragment
fn fs_main(frag : VSOut) -> @location(0) vec4<f32> {
  var sum = vec3<f32>(0.0, 0.0, 0.0);
  var total = 0.0;
  for (var i = -5.0; i <= 5.0; i = i + 1.0) {
    let w = exp(-i * i / 40.0);
    let off = B.dir * (i * B.bs) / B.res;
    sum = sum + textureSampleLevel(srcTex, samp0, frag.uv + off, 0.0).rgb * w;
    total = total + w;
  }
  return vec4<f32>(sum / total, 1.0);
}
`;

  // Main composite. Samples the SHARP background (bgTex) for outside + shadow,
  // and the PRE-BLURRED background (blurTex) inside the slab at each channel's
  // dispersion offset.
  const WGSL_MAIN =
    VS +
    `
struct Uniforms {
  res        : vec2<f32>,
  center     : vec2<f32>,
  size       : vec2<f32>,
  dpr        : f32,
  refract    : f32,
  curve      : f32,
  corner     : f32,
  blur       : f32,
  dispersion : f32,
  border     : f32,
  shadowDark : f32,
  shadowSpread : f32,
  shadowThick  : f32,
  tint       : f32,
};
@group(0) @binding(0) var<uniform> U : Uniforms;
@group(0) @binding(1) var bgSamp  : sampler;
@group(0) @binding(2) var bgTex   : texture_2d<f32>;
@group(0) @binding(3) var blurTex : texture_2d<f32>;

fn sdRound(local : vec2<f32>, halfSize : vec2<f32>, corner : f32) -> f32 {
  let shortEdge = min(halfSize.x, halfSize.y);
  let r = corner * shortEdge;
  let p = local * halfSize;
  let q = abs(p) - halfSize + r;
  return (min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r) / shortEdge;
}

fn sdNormal(local : vec2<f32>, halfSize : vec2<f32>, corner : f32) -> vec2<f32> {
  let e = 0.0035;
  let dx = sdRound(local + vec2<f32>(e, 0.0), halfSize, corner)
         - sdRound(local - vec2<f32>(e, 0.0), halfSize, corner);
  let dy = sdRound(local + vec2<f32>(0.0, e), halfSize, corner)
         - sdRound(local - vec2<f32>(0.0, e), halfSize, corner);
  let g = vec2<f32>(dx, dy);
  let l = length(g);
  if (l < 1e-5) { return vec2<f32>(0.0, 0.0); }
  return g / l;
}

fn backgroundWithShadow(uv : vec2<f32>, dist : f32) -> vec3<f32> {
  let bg = textureSampleLevel(bgTex, bgSamp, uv, 0.0).rgb;
  let d = max(dist, 0.0);
  let spread = max(U.shadowSpread, 1e-4);
  var shadow = 1.0 - smoothstep(0.0, spread, d);
  shadow = pow(shadow, max(U.shadowThick, 0.1));
  shadow = shadow * U.shadowDark;
  return mix(bg, vec3<f32>(0.0, 0.0, 0.0), shadow);
}

@fragment
fn fs_main(frag : VSOut) -> @location(0) vec4<f32> {
  let v_uv = frag.uv;
  let px = (v_uv * U.res) / U.dpr;
  let halfSize = U.size * 0.5;
  let local = (px - U.center) / halfSize;

  let dist = sdRound(local, halfSize, U.corner);
  // fwidth() must be in uniform control flow; depth = -dist so the same aa also
  // serves the border band.
  let aa = max(fwidth(dist), 1e-5);

  if (dist > aa) {
    return vec4<f32>(backgroundWithShadow(v_uv, dist), 1.0);
  }

  let depth = -dist;
  let prox  = 1.0 - clamp(depth, 0.0, 1.0);
  let t     = pow(prox, U.curve);

  let n        = sdNormal(local, halfSize, U.corner);
  let shortPx  = min(halfSize.x, halfSize.y);
  let offsetPx = -n * t * U.refract * shortPx;
  let offsetUV = (offsetPx * U.dpr) / U.res;

  let fringe = pow(prox, 1.8);
  let disp   = U.dispersion * fringe;
  let dR = offsetUV * (1.0 + 0.28 * disp);
  let dG = offsetUV;
  let dB = offsetUV * (1.0 - 0.28 * disp);

  // Pre-blurred background sampled per channel at its dispersion offset.
  let r = textureSampleLevel(blurTex, bgSamp, v_uv + dR, 0.0).r;
  let g = textureSampleLevel(blurTex, bgSamp, v_uv + dG, 0.0).g;
  let b = textureSampleLevel(blurTex, bgSamp, v_uv + dB, 0.0).b;
  var inside = vec3<f32>(r, g, b);

  if (U.border > 0.001) {
    let tb        = U.border * U.border;
    let bandWidth = max(tb * 0.04, aa * 0.6);
    let ring      = 1.0 - smoothstep(bandWidth - aa, bandWidth + aa, depth);
    let strength  = ring * (0.10 + U.border * 0.22);
    inside = inside + vec3<f32>(strength, strength, strength);
  }

  inside = inside + vec3<f32>(U.tint, U.tint, U.tint);

  let insideAlpha = 1.0 - smoothstep(-aa, aa, dist);
  let outside = backgroundWithShadow(v_uv, max(dist, 0.0));
  return vec4<f32>(mix(outside, inside, insideAlpha), 1.0);
}
`;

  // ============ PIPELINES ============
  const BLUR_FORMAT = "rgba8unorm";

  const blurModule = device.createShaderModule({ code: WGSL_BLUR });
  const blurPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: blurModule, entryPoint: "vs_main" },
    fragment: {
      module: blurModule,
      entryPoint: "fs_main",
      targets: [{ format: BLUR_FORMAT }],
    },
    primitive: { topology: "triangle-list" },
  });

  const mainModule = device.createShaderModule({ code: WGSL_MAIN });
  const mainPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: mainModule, entryPoint: "vs_main" },
    fragment: { module: mainModule, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // Main uniforms: 80 bytes (20 f32 incl. tail pad to a 16-byte multiple).
  const uniformData = new Float32Array(20);
  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Blur uniforms: { res, dir, bs } -> 20 bytes, padded to 32. Two buffers so H
  // and V can hold different dir within the same submitted command buffer.
  const blurDataH = new Float32Array(8); // [resX,resY, 1,0, bs, ...pad]
  const blurDataV = new Float32Array(8); // [resX,resY, 0,1, bs, ...pad]
  blurDataH[2] = 1;
  blurDataH[3] = 0;
  blurDataV[2] = 0;
  blurDataV[3] = 1;
  const blurUniformH = device.createBuffer({
    size: blurDataH.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const blurUniformV = device.createBuffer({
    size: blurDataV.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  // ============ BACKGROUND / TARGETS ============
  let bgTexture = null; // sharp source
  let blurTexA = null; // horizontal-pass target
  let blurTexB = null; // vertical-pass target (final blurred)
  let mainBind = null;
  let blurBindH = null;
  let blurBindV = null;

  let sourceImg = null;
  const bgCanvas = document.createElement("canvas");
  const bgCtx = bgCanvas.getContext("2d");

  function makeBindGroups() {
    blurBindH = device.createBindGroup({
      layout: blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: blurUniformH } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: bgTexture.createView() },
      ],
    });
    blurBindV = device.createBindGroup({
      layout: blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: blurUniformV } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: blurTexA.createView() },
      ],
    });
    mainBind = device.createBindGroup({
      layout: mainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: bgTexture.createView() },
        { binding: 3, resource: blurTexB.createView() },
      ],
    });
  }

  function ensureTargets(cw, ch) {
    if (bgTexture && bgTexture.width === cw && bgTexture.height === ch) return;
    bgTexture?.destroy();
    blurTexA?.destroy();
    blurTexB?.destroy();
    bgTexture = device.createTexture({
      size: [cw, ch],
      format: BLUR_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const targetUsage =
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    blurTexA = device.createTexture({ size: [cw, ch], format: BLUR_FORMAT, usage: targetUsage });
    blurTexB = device.createTexture({ size: [cw, ch], format: BLUR_FORMAT, usage: targetUsage });
    makeBindGroups();
  }

  function letterboxColor() {
    return getComputedStyle(document.body).backgroundColor || "#0a0a0a";
  }

  function rebuildTexture() {
    if (!sourceImg) return;
    const cw = canvas.width,
      ch = canvas.height;
    if (cw === 0 || ch === 0) return;
    bgCanvas.width = cw;
    bgCanvas.height = ch;

    bgCtx.fillStyle = letterboxColor();
    bgCtx.fillRect(0, 0, cw, ch);

    const ir = sourceImg.width / sourceImg.height;
    const cr = cw / ch;
    let dw, dh;
    if (ir > cr) {
      dw = cw;
      dh = cw / ir;
    } else {
      dh = ch;
      dw = ch * ir;
    }
    bgCtx.imageSmoothingEnabled = true;
    bgCtx.imageSmoothingQuality = "high";
    bgCtx.drawImage(sourceImg, (cw - dw) / 2, (ch - dh) / 2, dw, dh);

    ensureTargets(cw, ch);
    device.queue.copyExternalImageToTexture(
      { source: bgCanvas, flipY: false },
      { texture: bgTexture },
      [cw, ch],
    );
    needsRedraw = true;
  }

  function makeDefaultBackdrop() {
    const c = document.createElement("canvas");
    c.width = 1920;
    c.height = 1080;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 1920, 1080);
    g.addColorStop(0.0, "#0f2557");
    g.addColorStop(0.35, "#7b2cbf");
    g.addColorStop(0.7, "#e63946");
    g.addColorStop(1.0, "#f4a261");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 18; i++) {
      const x = Math.random() * 1920,
        y = Math.random() * 1080;
      const r = 180 + Math.random() * 420;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(255,255,255,${0.05 + Math.random() * 0.18})`);
      rg.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, 1920, 1080);
    }
    return c;
  }

  // ============ STATE ============
  const slab = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    w: isMobile ? 150 : 240,
    h: isMobile ? 150 : 240,
  };
  const params = {
    refract: 0.98,
    curve: 9.5,
    corner: 0.5,
    blur: isMobile ? 0.6 : 0.8,
    dispersion: 0.3,
    border: 0.25,
    shadowDark: 0.1,
    shadowSpread: 0.4,
    shadowThick: 4.5,
    tint: 0.06,
    trackSpeed: isMobile ? 0.06 : 0.025,
  };

  // ============ SLIDERS ============
  const sliderMap = [
    ["refract", "refractVal", 3, (v) => (params.refract = v), () => params.refract],
    ["curve", "curveVal", 2, (v) => (params.curve = v), () => params.curve],
    ["width", "widthVal", 0, (v) => (slab.w = v), () => slab.w],
    ["height", "heightVal", 0, (v) => (slab.h = v), () => slab.h],
    ["corner", "cornerVal", 2, (v) => (params.corner = v), () => params.corner],
    ["blur", "blurVal", 2, (v) => (params.blur = v), () => params.blur],
    ["dispersion", "dispersionVal", 2, (v) => (params.dispersion = v), () => params.dispersion],
    ["border", "borderVal", 2, (v) => (params.border = v), () => params.border],
    ["shadowDark", "shadowDarkVal", 2, (v) => (params.shadowDark = v), () => params.shadowDark],
    ["shadowSpread", "shadowSpreadVal", 2, (v) => (params.shadowSpread = v), () => params.shadowSpread],
    ["shadowThick", "shadowThickVal", 2, (v) => (params.shadowThick = v), () => params.shadowThick],
    ["tint", "tintVal", 2, (v) => (params.tint = v), () => params.tint],
    ["track", "trackVal", 3, (v) => (params.trackSpeed = v), () => params.trackSpeed],
  ];

  function syncSliders() {
    for (const [id, lbl, fx, , get] of sliderMap) {
      const el = document.getElementById(id);
      const lab = document.getElementById(lbl);
      if (!el || !lab) continue;
      const v = get();
      el.value = v;
      lab.textContent = v.toFixed(fx);
    }
  }

  for (const [id, lbl, fx, set] of sliderMap) {
    const el = document.getElementById(id);
    const lab = document.getElementById(lbl);
    if (!el || !lab) continue;
    el.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      set(v);
      lab.textContent = v.toFixed(fx);
      dirty();
    });
  }

  // ============ PRESETS (row toggle) ============
  const presets = {
    square: () => ({ w: 200, h: 200, corner: 0.50 }),
    rectangle: () => ({ w: 320, h: 200, corner: 0.55 }),
    circle: () => ({ w: 220, h: 220, corner: 1.0 }),
    pill: () => ({ w: 340, h: 130, corner: 1.0 }),
    bar: () => ({ w: 500, h: 70, corner: 1.0 }),
  };
  const mobileScale = isMobile ? 0.65 : 1.0;
  function applyPreset(p) {
    slab.w = Math.round(p.w * mobileScale);
    slab.h = Math.round(p.h * mobileScale);
    params.corner = p.corner;
    syncSliders();
    needsRedraw = true;
  }

  const presetButtons = [...document.querySelectorAll("[data-value]")];
  presetButtons.forEach((b) => {
    b.addEventListener("click", () => {
      const p = presets[b.dataset.value]?.();
      if (!p) return;
      applyPreset(p);
      presetButtons.forEach((o) => (o.dataset.active = o === b ? "1" : "0"));
    });
  });

  // ============ POINTER ============
  let currentMouse = [slab.x, slab.y];
  let targetMouse = [slab.x, slab.y];
  let dragging = false;
  let needsRedraw = true;
  const dirty = () => {
    needsRedraw = true;
  };

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    targetMouse[0] = e.clientX;
    targetMouse[1] = e.clientY;
    dirty();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    targetMouse[0] = e.clientX;
    targetMouse[1] = e.clientY;
    dirty();
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  canvas.addEventListener("pointerout", () => (dragging = false));

  if (isMobile) {
    canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  }

  // ============ THEME ============
  const themeButtons = document.querySelectorAll("[data-theme]");
  const THEME_KEY = "glassTheme";
  const mq = matchMedia("(prefers-color-scheme: dark)");

  function applyTheme(mode) {
    localStorage.setItem(THEME_KEY, mode);
    const isDark = mode === "dark" || (mode === "auto" && mq.matches);
    document.documentElement.classList.toggle("dark", isDark);
    themeButtons.forEach((b) => (b.dataset.active = b.dataset.theme === mode ? "1" : "0"));
    rebuildTexture();
  }

  themeButtons.forEach((b) =>
    b.addEventListener("click", () => applyTheme(b.dataset.theme)),
  );
  mq.addEventListener("change", () => {
    if ((localStorage.getItem(THEME_KEY) || "auto") === "auto") applyTheme("auto");
  });

  // ============ SETTINGS PANEL ============
  const panelBtn = document.getElementById("panelBtn");
  const panel = document.getElementById("panel");
  function setPanel(open) {
    panel.classList.toggle("hidden", !open);
    panel.classList.toggle("flex", open);
  }
  panelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(panel.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && !panelBtn.contains(e.target)) setPanel(false);
  });

  // ============ GPU CONTROLS ============
  // Center pill shows the active GPU; the panel seg switches preference (persist
  // + reload, the reliable way to actually get a different adapter). Both are
  // hidden on the WebGL1 fallback.
  const gpuInfoEl = document.getElementById("gpuInfo");
  if (gpuInfoEl) {
    const label = "WebGPU · " + gpuInfoStr;
    gpuInfoEl.textContent = label;
    gpuInfoEl.title = label;
    gpuInfoEl.classList.remove("hidden");
    gpuInfoEl.classList.add("flex");
  }
  const gpuGroup = document.getElementById("gpuGroup");
  if (gpuGroup) {
    gpuGroup.classList.remove("hidden");
    gpuGroup.classList.add("flex");
    gpuGroup.querySelectorAll("[data-gpu]").forEach((b) => {
      b.dataset.active = b.dataset.gpu === gpuPref ? "1" : "0";
      b.addEventListener("click", () => {
        if (b.dataset.gpu === gpuPref) return;
        localStorage.setItem(GPU_KEY, b.dataset.gpu);
        location.reload();
      });
    });
  }
  const gpuNote = document.getElementById("gpuNote");
  if (gpuNote) {
    gpuNote.textContent = isWindows
      ? "Windows currently lets the browser choose the GPU — this hint is ignored here."
      : "Switching reloads the page to apply.";
  }

  // ============ CONTROLS TOGGLE ============
  const controlsEl = document.getElementById("controls");
  document.getElementById("toggleControls").addEventListener("click", () => {
    const hidden = controlsEl.classList.contains("hidden");
    controlsEl.classList.toggle("hidden", !hidden);
    controlsEl.classList.toggle("grid", hidden);
  });

  // ============ UPLOAD ============
  const upload = document.getElementById("upload");
  const uploadBtn = document.getElementById("uploadBtn");
  const preview = document.getElementById("preview");

  uploadBtn.addEventListener("click", () => upload.click());
  upload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      sourceImg = img;
      rebuildTexture();
      preview.src = img.src;
      preview.classList.remove("hidden");
    };
    img.src = URL.createObjectURL(file);
  });

  // ============ RESIZE ============
  function resize() {
    renderDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(window.innerWidth * renderDpr);
    canvas.height = Math.round(window.innerHeight * renderDpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    if (!dragging) {
      slab.x = window.innerWidth / 2;
      slab.y = window.innerHeight / 2;
      currentMouse[0] = slab.x;
      currentMouse[1] = slab.y;
      targetMouse[0] = slab.x;
      targetMouse[1] = slab.y;
    }
    rebuildTexture();
  }
  window.addEventListener("resize", resize);

  // ============ DRAW LOOP ============
  // FPS guard — samples only across consecutive *rendered* frames so idle frames
  // can't mask a slow render. Warns at most once / 10s.
  const FPS_WARN = 24;
  let fpsAcc = 0,
    fpsFrames = 0,
    fpsLast = 0,
    fpsWarned = 0;

  function render() {
    const cw = canvas.width,
      ch = canvas.height;

    // Main uniforms.
    uniformData[0] = cw;
    uniformData[1] = ch;
    uniformData[2] = slab.x;
    uniformData[3] = slab.y;
    uniformData[4] = slab.w;
    uniformData[5] = slab.h;
    uniformData[6] = renderDpr;
    uniformData[7] = params.refract;
    uniformData[8] = params.curve;
    uniformData[9] = params.corner;
    uniformData[10] = params.blur;
    uniformData[11] = params.dispersion;
    uniformData[12] = params.border;
    uniformData[13] = params.shadowDark;
    uniformData[14] = params.shadowSpread;
    uniformData[15] = params.shadowThick;
    uniformData[16] = params.tint;
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Blur uniforms (res + current blur amount; dir is baked per buffer).
    blurDataH[0] = cw;
    blurDataH[1] = ch;
    blurDataH[4] = params.blur;
    blurDataV[0] = cw;
    blurDataV[1] = ch;
    blurDataV[4] = params.blur;
    device.queue.writeBuffer(blurUniformH, 0, blurDataH);
    device.queue.writeBuffer(blurUniformV, 0, blurDataV);

    const encoder = device.createCommandEncoder();

    // Pass 1: horizontal blur  bgTexture -> blurTexA
    blurPass(encoder, blurTexA.createView(), blurBindH);
    // Pass 2: vertical blur     blurTexA  -> blurTexB
    blurPass(encoder, blurTexB.createView(), blurBindV);

    // Pass 3: composite -> canvas
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(mainPipeline);
    pass.setBindGroup(0, mainBind);
    pass.draw(6);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  function blurPass(encoder, view, bind) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" },
      ],
    });
    pass.setPipeline(blurPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(6);
    pass.end();
  }

  function draw() {
    const dx = targetMouse[0] - currentMouse[0];
    const dy = targetMouse[1] - currentMouse[1];
    const moving = Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05;

    if (moving) {
      const s = params.trackSpeed;
      currentMouse[0] += dx * s;
      currentMouse[1] += dy * s;
      needsRedraw = true;
    } else if (
      currentMouse[0] !== targetMouse[0] ||
      currentMouse[1] !== targetMouse[1]
    ) {
      currentMouse[0] = targetMouse[0];
      currentMouse[1] = targetMouse[1];
      needsRedraw = true;
    }
    slab.x = currentMouse[0];
    slab.y = currentMouse[1];

    if (needsRedraw && mainBind) {
      render();
      needsRedraw = false;

      const ts = performance.now();
      if (fpsLast) {
        fpsAcc += ts - fpsLast;
        fpsFrames++;
        if (fpsAcc >= 2000) {
          const avg = fpsAcc / fpsFrames;
          if (1000 / avg < FPS_WARN && ts - fpsWarned > 10000) {
            console.warn(
              `[glass] ~${(1000 / avg).toFixed(0)} fps while rendering ` +
                `(${avg.toFixed(1)} ms/frame). Try GPU: Performance, lower Blur, or a smaller slab.`,
            );
            fpsWarned = ts;
          }
          fpsAcc = 0;
          fpsFrames = 0;
        }
      }
      fpsLast = ts;
    } else {
      fpsLast = 0; // idle — break the sampling chain
    }

    requestAnimationFrame(draw);
  }

  // ============ BOOT ============
  syncSliders();
  applyTheme(localStorage.getItem(THEME_KEY) || "auto");
  sourceImg = makeDefaultBackdrop();
  resize();
  requestAnimationFrame(draw);
})();
