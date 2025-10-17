const canvas = document.getElementById("canvas");
const gl = canvas.getContext("webgl", { antialias: true }) 
       || canvas.getContext("experimental-webgl", { antialias: true });

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;
const controlPanel = document.querySelector(".controls");
controlPanel.style.display = "none"; // hide initially
//sliders
const refractionSlider = document.getElementById("refraction");
const curvatureSlider = document.getElementById("curvature");
const alphaSlider = document.getElementById("alpha");
const widthSlider = document.getElementById("slabWidth");
const heightSlider = document.getElementById("slabHeight");
const cornerSlider = document.getElementById("cornerRadius");
const blurSlider = document.getElementById("blurSlider");

// Hide control panel initially
controlPanel.style.display = "none";


// ---------------- SHADERS INLINE ----------------
const vertexShaderSrc = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
    v_uv = vec2(a_position.x, -a_position.y) * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSrc = `
precision mediump float;

uniform float u_dpr;
uniform sampler2D u_background;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
uniform vec2 u_size;
varying vec2 v_uv;

uniform float u_maxRefract;
uniform float u_domePower;
uniform float u_alpha;
uniform float u_cornerRadius;
uniform float u_blur;

// ----------------- Rounded rectangle SDF -----------------
float roundedBoxSDF(vec2 pt, vec2 size, float radius){
    vec2 d = abs(pt) - size + vec2(radius);
    d = max(d, 0.0);
    return length(d) - radius;
}

// ----------------- Dome refraction (your original logic) -----------------
vec2 domeRefraction(vec2 local, vec2 halfSize, float cornerRadius) {
    // local: -1..1 along slab axes
    // cornerRadius: normalized 0..1
    
    // Clamp local to rounded rectangle edge
    vec2 clamped = clamp(local, vec2(-1.0 + cornerRadius), vec2(1.0 - cornerRadius));

    // Distance from the edge (0=center, 1=slab edge)
    vec2 dist = (clamped - local) * vec2(sign(local));

    // Combine X and Y distances for dome intensity
    float t = pow(length(dist) / 1.0, u_domePower); 

    // Avoid zero-length
    if(length(local) == 0.0) return vec2(0.0);

    // Refraction vector proportional to local position
    vec2 offset = normalize(local) * t * u_maxRefract;
    return -offset;
}


// ----------------- Frosted blur sampling -----------------
vec3 blurSample(sampler2D tex, vec2 uv, float blurSize) {
    vec3 sum = vec3(0.0);
    float total = 0.0;
    float sigma = 8.0;

    for (float x = -8.0; x <= 8.0; x++) {
        for (float y = -8.0; y <= 8.0; y++) {
            vec2 offset = vec2(x, y) * blurSize / u_resolution;
            float weight = exp(-(x*x + y*y)/(2.0*sigma*sigma));
            sum += texture2D(tex, uv + offset).rgb * weight;
            total += weight;
        }
    }
    return sum / total;
}


// ----------------- Main -----------------
void main() {
    vec2 pixelUV = (v_uv * u_resolution) / u_dpr;
    vec2 center = u_mouse;
    vec2 halfSize = u_size * 0.5;

    vec2 local = (pixelUV - center) / halfSize;
    local.y *= u_resolution.x / u_resolution.y;

    // Rounded rectangle mask
    float dist = roundedBoxSDF(local, vec2(1.0,1.0), u_cornerRadius);
    if(dist > 0.0) {
        gl_FragColor = texture2D(u_background, v_uv); // outside slab
        return;
    }

    // Dome-shaped refraction (unchanged)
    vec2 offset = domeRefraction(local, halfSize, u_cornerRadius);
    vec2 refractUV = v_uv + offset;

    // Apply frosted blur at the refracted position
    vec3 color = blurSample(u_background, refractUV, u_blur);

    gl_FragColor = vec4(color, u_alpha);
}

`;

// ---------------- HELPER FUNCTIONS ----------------
function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile error:", gl.getShaderInfoLog(shader));
        return null;
    }
    return shader;
}

// ---------------- INIT PROGRAM ----------------
const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSrc);
const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSrc);

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("Program link error:", gl.getProgramInfoLog(program));
}
gl.useProgram(program);

// ---------------- BUFFER ----------------
const positionBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1
]), gl.STATIC_DRAW);

const positionLocation = gl.getAttribLocation(program, "a_position");
gl.enableVertexAttribArray(positionLocation);
gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

// ---------------- UNIFORMS ----------------
const u_resolution = gl.getUniformLocation(program, "u_resolution");
const u_mouse = gl.getUniformLocation(program, "u_mouse");
const u_size = gl.getUniformLocation(program, "u_size");
const u_background = gl.getUniformLocation(program, "u_background");
const u_dpr = gl.getUniformLocation(program, "u_dpr");
// NEW UNIFORMS FOR PARAMETERS
const u_maxRefract = gl.getUniformLocation(program, "u_maxRefract");
const u_domePower = gl.getUniformLocation(program, "u_domePower");
const u_alpha = gl.getUniformLocation(program, "u_alpha");
const u_cornerRadius = gl.getUniformLocation(program, "u_cornerRadius");
const u_blur = gl.getUniformLocation(program, "u_blur");

let params = {
    MAX_REFRACT: 2.000,
    DOME_POWER: 4.0,
    ALPHA: 0.9,
    CORNER_RADIUS: 0.5,
    BLUR: 2.5
};
// ---------------- TEXTURE ----------------
let background = gl.createTexture();
let imageLoaded = false;

document.getElementById('upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if(!file) return;
    const img = new Image();
    img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, background);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(u_background, 0);
        gl.uniform1f(u_dpr, window.devicePixelRatio || 1);
        imageLoaded = true;
        controlPanel.style.display = "flex";
        requestAnimationFrame(draw);
    };
    img.src = URL.createObjectURL(file);
});

refractionSlider.addEventListener("input", e => {
    params.MAX_REFRACT = parseFloat(e.target.value);
    document.getElementById("refractionValue").innerText = params.MAX_REFRACT.toFixed(3);
});

curvatureSlider.addEventListener("input", e => {
    params.DOME_POWER = parseFloat(e.target.value);
    document.getElementById("domeValue").innerText = params.DOME_POWER.toFixed(1);
});

alphaSlider.addEventListener("input", e => {
    params.ALPHA = parseFloat(e.target.value);
    document.getElementById("alphaValue").innerText = params.ALPHA.toFixed(2);
});
blurSlider.addEventListener("input", e => {
    params.BLUR = parseFloat(e.target.value);
    blurValue.textContent = params.BLUR.toFixed(1);
});



// ---------------- SLAB ----------------
let slab = { x: canvas.width/2, y: canvas.height/2, w: 300, h: 400 };
let dragging = false;

widthSlider.addEventListener("input", e => {
    slab.w = parseInt(e.target.value);
    document.getElementById("widthValue").innerText = slab.w;
});

heightSlider.addEventListener("input", e => {
    slab.h = parseInt(e.target.value);
    document.getElementById("heightValue").innerText = slab.h;
});
cornerSlider.addEventListener("input", e => {
    params.CORNER_RADIUS = parseFloat(e.target.value);
    document.getElementById("cornerValue").innerText = params.CORNER_RADIUS.toFixed(2);
});


canvas.addEventListener('pointerdown', e => {
    const mx = e.clientX, my = e.clientY;
    if(mx > slab.x - slab.w/2 && mx < slab.x + slab.w/2 &&
       my > slab.y - slab.h/2 && my < slab.y + slab.h/2){
        dragging = true;
    }
});
canvas.addEventListener('pointerup', () => dragging = false);
canvas.addEventListener('pointerout', () => dragging = false);
canvas.addEventListener('pointermove', e => {
    if(dragging){
        slab.x = e.clientX;
        slab.y = e.clientY;
    }
});

// ---------------- RENDER ----------------
function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener("resize", resize);
resize();

function draw() {
    if(!imageLoaded) return;
    resize();
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Update shader parameters
    gl.uniform1f(u_maxRefract, params.MAX_REFRACT);
    gl.uniform1f(u_domePower, params.DOME_POWER);
    gl.uniform1f(u_alpha, params.ALPHA);
    gl.uniform1f(u_cornerRadius, params.CORNER_RADIUS);
    gl.uniform1f(u_blur, params.BLUR);


    gl.uniform2f(u_resolution, canvas.width, canvas.height);
    gl.uniform2f(u_mouse, slab.x, slab.y);
    gl.uniform2f(u_size, slab.w, slab.h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, background);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(draw);
}

