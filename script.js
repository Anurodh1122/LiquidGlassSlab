// Liquid glass slab.
//
// Shader principles:
//   - Proper rounded-box SDF (works for any width/height/cornerRadius).
//   - Refraction direction = SDF gradient → true edge-normal everywhere.
//     A bar refracts perpendicular to its long edges the same way a circle
//     refracts radially; no anisotropic pinching.
//   - Refraction magnitude scales with shortEdge → looks the same at any size.
//   - Chromatic split (R vs B refract differently) for the per-channel fringe.
//   - Iridescent rim (sin-RGB palette around the perimeter) for the soap-
//     bubble / water-drop look.
//   - Background image is letterboxed onto an offscreen canvas (contain-fit),
//     uploaded as the texture, so the source aspect is preserved.

const canvas = document.getElementById("canvas");
const gl =
  canvas.getContext("webgl", { antialias: true }) ||
  canvas.getContext("experimental-webgl", { antialias: true });

// Required for fwidth() / dFdx() / dFdy() in WebGL1.
gl.getExtension("OES_standard_derivatives");

const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// ============ SHADERS ============
const VERT = `
attribute vec2 a_position;
varying   vec2 v_uv;
void main() {
    v_uv = vec2(a_position.x, -a_position.y) * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform sampler2D u_bg;
uniform vec2  u_res;        
uniform vec2  u_center;
uniform vec2  u_size;
uniform float u_dpr;

uniform float u_refract;
uniform float u_curve;
uniform float u_corner;
uniform float u_blur;
uniform float u_dispersion;
uniform float u_border;
uniform float u_shadowDark;
uniform float u_shadowSpread;
uniform float u_shadowThick;
uniform float u_tint;

varying vec2 v_uv;

float sdRound(vec2 local, vec2 halfSize, float corner) {
    float shortEdge = min(halfSize.x, halfSize.y);
    float r = corner * shortEdge;
    vec2 p = local * halfSize;
    vec2 q = abs(p) - halfSize + r;
    return (min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r) / shortEdge;
}

// Outward edge normal via SDF gradient.
vec2 sdNormal(vec2 local, vec2 halfSize, float corner) {
    float e = 0.0035;
    float dx = sdRound(local + vec2(e, 0.0), halfSize, corner)
             - sdRound(local - vec2(e, 0.0), halfSize, corner);
    float dy = sdRound(local + vec2(0.0, e), halfSize, corner)
             - sdRound(local - vec2(0.0, e), halfSize, corner);
    vec2 g = vec2(dx, dy);
    float l = length(g);
    return l < 1e-5 ? vec2(0.0) : g / l;
}

// 11x11 gaussian blur — used for the frosted look.
vec3 blurSample(vec2 uv, float bs) {
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (float x = -5.0; x <= 5.0; x++) {
        for (float y = -5.0; y <= 5.0; y++) {
            float w = exp(-(x * x + y * y) / 40.0);
            vec2 off = vec2(x, y) * bs / u_res;
            sum += texture2D(u_bg, uv + off).rgb * w;
            total += w;
        }
    }
    return sum / total;
}

vec3 backgroundWithShadow(vec2 uv, float dist) {
    vec3 bg = texture2D(u_bg, uv).rgb;
    float d = max(dist, 0.0);
    float spread = max(u_shadowSpread, 1e-4);
    float shadow = 1.0 - smoothstep(0.0, spread, d);
    shadow       = pow(shadow, max(u_shadowThick, 0.1));
    shadow      *= u_shadowDark;
    return mix(bg, vec3(0.0), shadow);
}

void main() {
    vec2 px = (v_uv * u_res) / u_dpr;
    vec2 halfSize = u_size * 0.5;
    vec2 local = (px - u_center) / halfSize;

    float dist = sdRound(local, halfSize, u_corner);
    float aa = max(fwidth(dist), 1e-5);

    if (dist > aa) {
        gl_FragColor = vec4(backgroundWithShadow(v_uv, dist), 1.0);
        return;
    }

    // Compute the inside-the-slab look.
    float depth = -dist;
    float prox  = 1.0 - clamp(depth, 0.0, 1.0);
    float t     = pow(prox, u_curve);

    vec2 n = sdNormal(local, halfSize, u_corner);
    float shortPx = min(halfSize.x, halfSize.y);
    vec2  offsetPx = -n * t * u_refract * shortPx;
    vec2  offsetUV = (offsetPx * u_dpr) / u_res;

    float fringe = pow(prox, 1.8);
    float disp   = u_dispersion * fringe;
    vec2 dR = offsetUV * (1.0 + 0.28 * disp);
    vec2 dG = offsetUV;
    vec2 dB = offsetUV * (1.0 - 0.28 * disp);

    float r = blurSample(v_uv + dR, u_blur).r;
    float g = blurSample(v_uv + dG, u_blur).g;
    float b = blurSample(v_uv + dB, u_blur).b;
    vec3 inside = vec3(r, g, b);

    if (u_border > 0.001) {
        float t         = u_border * u_border;
        float bandWidth = max(t * 0.04, aa * 0.6);                  
        float aaDepth   = max(fwidth(depth), 1e-5);
        float ring      = 1.0 - smoothstep(bandWidth - aaDepth, bandWidth + aaDepth, depth);
        float strength  = ring * (0.10 + u_border * 0.22);           
        inside         += vec3(strength);
    }

    inside += vec3(u_tint);

    float insideAlpha = 1.0 - smoothstep(-aa, aa, dist);
    vec3 outside = backgroundWithShadow(v_uv, max(dist, 0.0));
    gl_FragColor = vec4(mix(outside, inside, insideAlpha), 1.0);
}
`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(s));
  }
  return s;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  console.error("Program link error:", gl.getProgramInfoLog(program));
}
gl.useProgram(program);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
  gl.STATIC_DRAW,
);
const aPos = gl.getAttribLocation(program, "a_position");
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const U = {
  bg: gl.getUniformLocation(program, "u_bg"),
  res: gl.getUniformLocation(program, "u_res"),
  center: gl.getUniformLocation(program, "u_center"),
  size: gl.getUniformLocation(program, "u_size"),
  dpr: gl.getUniformLocation(program, "u_dpr"),
  refract: gl.getUniformLocation(program, "u_refract"),
  curve: gl.getUniformLocation(program, "u_curve"),
  corner: gl.getUniformLocation(program, "u_corner"),
  blur: gl.getUniformLocation(program, "u_blur"),
  dispersion: gl.getUniformLocation(program, "u_dispersion"),
  border: gl.getUniformLocation(program, "u_border"),
  shadowDark: gl.getUniformLocation(program, "u_shadowDark"),
  shadowSpread: gl.getUniformLocation(program, "u_shadowSpread"),
  shadowThick: gl.getUniformLocation(program, "u_shadowThick"),
  tint: gl.getUniformLocation(program, "u_tint"),
};
gl.uniform1i(U.bg, 0);

// BACKGROUND
const texture = gl.createTexture();
let sourceImg = null;
const bgCanvas = document.createElement("canvas");
const bgCtx = bgCanvas.getContext("2d");

function letterboxColor() {
  return getComputedStyle(document.body).backgroundColor || "#0a0a0a";
}

function rebuildTexture() {
  if (!sourceImg) return;
  const cw = canvas.width,
    ch = canvas.height;
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
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;

  bgCtx.imageSmoothingEnabled = true;
  bgCtx.imageSmoothingQuality = "high";
  bgCtx.drawImage(sourceImg, dx, dy, dw, dh);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1f(U.dpr, window.devicePixelRatio || 1);
  if (typeof needsRedraw !== "undefined") needsRedraw = true;
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
  [
    "refract",
    "refractVal",
    3,
    (v) => (params.refract = v),
    () => params.refract,
  ],
  ["curve", "curveVal", 2, (v) => (params.curve = v), () => params.curve],
  ["width", "widthVal", 0, (v) => (slab.w = v), () => slab.w],
  ["height", "heightVal", 0, (v) => (slab.h = v), () => slab.h],
  ["corner", "cornerVal", 2, (v) => (params.corner = v), () => params.corner],
  ["blur", "blurVal", 2, (v) => (params.blur = v), () => params.blur],
  [
    "dispersion",
    "dispersionVal",
    2,
    (v) => (params.dispersion = v),
    () => params.dispersion,
  ],
  ["border", "borderVal", 2, (v) => (params.border = v), () => params.border],
  [
    "shadowDark",
    "shadowDarkVal",
    2,
    (v) => (params.shadowDark = v),
    () => params.shadowDark,
  ],
  [
    "shadowSpread",
    "shadowSpreadVal",
    2,
    (v) => (params.shadowSpread = v),
    () => params.shadowSpread,
  ],
  [
    "shadowThick",
    "shadowThickVal",
    2,
    (v) => (params.shadowThick = v),
    () => params.shadowThick,
  ],
  ["tint", "tintVal", 2, (v) => (params.tint = v), () => params.tint],
  [
    "track",
    "trackVal",
    3,
    (v) => (params.trackSpeed = v),
    () => params.trackSpeed,
  ],
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

// ============ PRESETS ============
// All five use the same shader. Defaults are robust; presets only nudge
// dimensions and corner radius.
const presets = {
  square: () => ({ w: 220, h: 220, corner: 0.18 }),
  rectangle: () => ({ w: 320, h: 200, corner: 0.1 }),
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
  if (typeof needsRedraw !== "undefined") needsRedraw = true;
}

// ============ PRESETS (row toggle) ============
const presetButtons = [...document.querySelectorAll("[data-value]")];
presetButtons.forEach((b) => {
  b.addEventListener("click", () => {
    const p = presets[b.dataset.value]?.();
    if (!p) return;
    applyPreset(p);
    presetButtons.forEach((o) => (o.dataset.active = o === b ? "1" : "0"));
  });
});

// ============ SETTINGS PANEL ============
const panelBtn = document.getElementById("panelBtn");
const panel = document.getElementById("panel");
function setPanel(open) {
  panel.classList.toggle("hidden", !open);
  panel.classList.toggle("flex", open);
}
if (panelBtn && panel) {
  panelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(panel.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    if (!panel.contains(e.target) && !panelBtn.contains(e.target)) setPanel(false);
  });
}

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
  canvas.addEventListener("touchstart", (e) => e.preventDefault(), {
    passive: false,
  });
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), {
    passive: false,
  });
}

// ============ THEME ============
const themeButtons = document.querySelectorAll("[data-theme]");
const THEME_KEY = "glassTheme";
const mq = matchMedia("(prefers-color-scheme: dark)");

function applyTheme(mode) {
  localStorage.setItem(THEME_KEY, mode);
  const isDark = mode === "dark" || (mode === "auto" && mq.matches);
  document.documentElement.classList.toggle("dark", isDark);
  themeButtons.forEach((b) => {
    const active = b.dataset.theme === mode;
    b.dataset.active = active ? "1" : "0";
  });
  rebuildTexture();
}

themeButtons.forEach((b) =>
  b.addEventListener("click", () => applyTheme(b.dataset.theme)),
);
mq.addEventListener("change", () => {
  if ((localStorage.getItem(THEME_KEY) || "auto") === "auto")
    applyTheme("auto");
});

// ============ CONTROLS TOGGLE ============
const controlsEl = document.getElementById("controls");
document.getElementById("toggleControls").addEventListener("click", () => {
  const hidden = controlsEl.classList.contains("hidden");
  controlsEl.classList.toggle("hidden", !hidden);
  controlsEl.classList.toggle("grid", hidden);
});

// ============ BACKEND BADGE ============
// Same center pill as the WebGPU build, so it's always clear which renderer is
// live. WEBGL_debug_renderer_info gives the unmasked GPU string when available.
(function () {
  const el = document.getElementById("gpuInfo");
  if (!el) return;
  let label = "WebGL1";
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const r = dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    if (r) label += " · " + r;
  } catch {}
  el.textContent = label;
  el.title = label;
  el.classList.remove("hidden");
  el.classList.add("flex");
})();

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
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
  gl.viewport(0, 0, canvas.width, canvas.height);
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

  if (needsRedraw) {
    gl.uniform1f(U.refract, params.refract);
    gl.uniform1f(U.curve, params.curve);
    gl.uniform1f(U.corner, params.corner);
    gl.uniform1f(U.blur, params.blur);
    gl.uniform1f(U.dispersion, params.dispersion);
    gl.uniform1f(U.border, params.border);
    gl.uniform1f(U.shadowDark, params.shadowDark);
    gl.uniform1f(U.shadowSpread, params.shadowSpread);
    gl.uniform1f(U.shadowThick, params.shadowThick);
    gl.uniform1f(U.tint, params.tint);
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform2f(U.center, slab.x, slab.y);
    gl.uniform2f(U.size, slab.w, slab.h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    needsRedraw = false;
  }

  requestAnimationFrame(draw);
}

// ============ BOOT ============
syncSliders();
applyTheme(localStorage.getItem(THEME_KEY) || "auto");
sourceImg = makeDefaultBackdrop();
resize();
requestAnimationFrame(draw);
