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
const u_maxRefract = gl.getUniformLocation(program, "u_maxRefract");
const u_domePower = gl.getUniformLocation(program, "u_domePower");
const u_alpha = gl.getUniformLocation(program, "u_alpha");
const u_cornerRadius = gl.getUniformLocation(program, "u_cornerRadius");
const u_blur = gl.getUniformLocation(program, "u_blur");
// ---------------- TEXTURE ----------------
let background = gl.createTexture();
let imageLoaded = false;
const uploadInput = document.getElementById('upload');
const uploadBtn = document.getElementById('uploadBtn');
const preview = document.getElementById('preview');

uploadBtn.addEventListener('click', () => uploadInput.click());

uploadInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if(!file) return;
    const img = new Image();
    const preview = document.getElementById('preview');
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

        preview.src = img.src;
        preview.style.display = 'block';
    };
    img.src = URL.createObjectURL(file);

    if (uploadInput.files.length > 0) {
        presetDropdown.classList.remove('disabled');
    } else {
        presetDropdown.classList.add('disabled');
    }
});

const presetDropdown = document.querySelector('.preset-wrapper .dropdown');
const dropdown = presetDropdown;
const select = dropdown.querySelector('.select span');
const hiddenInput = dropdown.querySelector('input[name="preset"]');
const options = dropdown.querySelectorAll('.dropdown-menu li');
presetDropdown.classList.add('disabled');


uploadInput.addEventListener('change', () => {
    if (uploadInput.files.length > 0) {
        presetDropdown.classList.remove('disabled');
    } else {
        presetDropdown.classList.add('disabled');
    }
});



refractionSlider.addEventListener("input", e => {
    params.MAX_REFRACT = parseFloat(e.target.value);
    document.getElementById("refractionValue").innerText = params.MAX_REFRACT.toFixed(3);
});

curvatureSlider.addEventListener("input", e => {
    params.DOME_POWER = parseFloat(e.target.value);
    document.getElementById("domeValue").innerText = params.DOME_POWER.toFixed(1);
});

blurSlider.addEventListener("input", e => {
    params.BLUR = parseFloat(e.target.value);
    blurValue.textContent = params.BLUR.toFixed(1);
});



// ---------------- SLAB ----------------
// Determine mobile or desktop
const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Default slab and params
let slab = {
    x: 0,
    y: 0,
    w: isMobile ? 100 : 200,
    h: isMobile ? 100 : 200
};

let params = {
    MAX_REFRACT: 1.75,
    DOME_POWER: 4.0,
    CORNER_RADIUS: 0.5,
    ALPHA: 1.0,
    BLUR: 2.0,
    TRACK_SPEED: isMobile ? 0.05 : 0.02
};

// Slider elements
const sliders = [
    {id: 'refraction', value: params.MAX_REFRACT, label: 'refractionValue', fixed: 3},
    {id: 'curvature', value: params.DOME_POWER, label: 'domeValue', fixed: 1},
    {id: 'slabWidth', value: slab.w, label: 'widthValue', fixed: 0},
    {id: 'slabHeight', value: slab.h, label: 'heightValue', fixed: 0},
    {id: 'cornerRadius', value: params.CORNER_RADIUS, label: 'cornerValue', fixed: 2},
    {id: 'blurSlider', value: params.BLUR, label: 'blurValue', fixed: 1},
    {id: 'trackSpeedSlider', value: params.TRACK_SPEED, label: 'trackSpeedValue', fixed: 3}
];

// Initialize sliders
sliders.forEach(s => {
    const slider = document.getElementById(s.id);
    const span = document.getElementById(s.label);
    slider.value = s.value;
    span.textContent = s.value.toFixed(s.fixed);

    slider.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        span.textContent = val.toFixed(s.fixed);

        // Update JS params or slab
        switch(s.id){
            case 'refraction': params.MAX_REFRACT = val; break;
            case 'curvature': params.DOME_POWER = val; break;
            case 'slabWidth': slab.w = val; break;
            case 'slabHeight': slab.h = val; break;
            case 'cornerRadius': params.CORNER_RADIUS = val; break;
            case 'blurSlider': params.BLUR = val; break;
            case 'trackSpeedSlider': params.TRACK_SPEED = val; break;
        }
    });
});

let currentMouse = [0, 0];  // will set after resize
let targetMouse = [0, 0]; 
let dragging = false;
slab.x = canvas.width/2;
slab.y = canvas.height/2;
currentMouse[0] = slab.x;
currentMouse[1] = slab.y;
targetMouse[0] = slab.x;
targetMouse[1] = slab.y;


const trackSpeedSlider = document.getElementById("trackSpeedSlider");
const trackSpeedValue = document.getElementById("trackSpeedValue");

trackSpeedSlider.addEventListener("input", (e) => {
    params.TRACK_SPEED = parseFloat(e.target.value);
    trackSpeedValue.textContent = params.TRACK_SPEED.toFixed(3);
});

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

const presets = {
    rounded: () => ({
        w: isMobile ? 100 : 200,
        h: isMobile ? 100 : 200, 
        MAX_REFRACT: 1.750,
        DOME_POWER: 4.0,
        CORNER_RADIUS: 0.5,
        BLUR: isMobile ? 0.6 : 1.2,
    }),
    circle: () => ({
        w: isMobile ? 100 : 200,
        h: isMobile ? 100 : 200,       // keep circle
        MAX_REFRACT: isMobile ? 0.075 : 0.1300,
        DOME_POWER: isMobile ? 6.5 : 6.5,
        CORNER_RADIUS: 1.0,
        BLUR: isMobile ? 0.4 : 1.0,
    })
};

dropdown.querySelector('.select').addEventListener('click', (e) => {
    if (!dropdown.classList.contains('disabled')) {
        dropdown.classList.toggle('active');
    }
});

document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});

options.forEach(option => {
    option.addEventListener('click', (e) => {
        if (dropdown.classList.contains('disabled')) return;
        e.stopPropagation(); // prevent dropdown toggle
        const value = option.getAttribute('data-value');
        const preset = presets[value]();

        // update displayed text
        select.textContent = option.textContent;
        hiddenInput.value = value;
        dropdown.classList.remove('active');

        // apply preset to slab
        slab.w = preset.w;
        slab.h = preset.h;
        params.MAX_REFRACT = preset.MAX_REFRACT;
        params.DOME_POWER = preset.DOME_POWER;
        params.CORNER_RADIUS = preset.CORNER_RADIUS;
        params.BLUR = preset.BLUR;

        // update sliders & displayed numbers
        widthSlider.value = slab.w;
        heightSlider.value = slab.h;
        refractionSlider.value = params.MAX_REFRACT;
        curvatureSlider.value = params.DOME_POWER;
        cornerSlider.value = params.CORNER_RADIUS;
        blurSlider.value = params.BLUR;

        document.getElementById("widthValue").innerText = slab.w;
        document.getElementById("heightValue").innerText = slab.h;
        document.getElementById("refractionValue").innerText = params.MAX_REFRACT.toFixed(3);
        document.getElementById("domeValue").innerText = params.DOME_POWER.toFixed(1);
        document.getElementById("cornerValue").innerText = params.CORNER_RADIUS.toFixed(2);
        document.getElementById("blurValue").textContent = params.BLUR.toFixed(1);
    });
});
document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});

// ---------------- POINTER EVENTS ----------------
canvas.addEventListener('pointerdown', e => {
    dragging = true;
    targetMouse[0] = e.clientX;
    targetMouse[1] = e.clientY;
});

canvas.addEventListener('pointermove', e => {
    if (dragging) {
        targetMouse[0] = e.clientX;
        targetMouse[1] = e.clientY;
    }
});

canvas.addEventListener('pointerup', () => dragging = false);
canvas.addEventListener('pointerout', () => dragging = false);

// Prevent touch scroll on mobile
if(isMobile){
    canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}

// ---------------- Toggle Control Panel ----------------
const toggleBtn = document.getElementById("toggleControls");
const controlsPanel = document.querySelector(".controls");

toggleBtn.addEventListener("click", () => {
    controlsPanel.classList.toggle("show");
});

// ---------------- RENDER ----------------
function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);

    if (!dragging) {
        slab.x = canvas.width/2;
        slab.y = canvas.height/2;
    }

}
window.addEventListener("resize", resize);
resize();

function draw() {
    if(!imageLoaded) return;
    gl.clear(gl.COLOR_BUFFER_BIT);

    // ---- Smooth motion update ----
    const smoothing = params.TRACK_SPEED;
    currentMouse[0] += (targetMouse[0] - currentMouse[0]) * smoothing;
    currentMouse[1] += (targetMouse[1] - currentMouse[1]) * smoothing;

    slab.x = currentMouse[0];
    slab.y = currentMouse[1];

    // ------------------------------

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

