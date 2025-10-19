# Apple IOS26 Like Liquid Glass Slab Shader

A **WebGL-based interactive frosted glass / liquid slab shader** inspired by Apple’s translucent UI effects.  
Users can upload an image, drag a smooth refractive “glass slab” around, and fine-tune its shape, curvature, and blur for a realistic liquid-glass appearance.

## Features
- Interactive slab with rounded corners
- Dome-shaped refraction shader
- Frosted-glass blur effect 
- Upload your own image
- Live parameter controls (refraction, curvature, blur, size, etc.)
- Control panel for live parameter tweaking
- Responsive for both desktop and mobile

## Demo: [Liquid glass slab](https://anurodh1122.github.io/LiquidGlassSlab/)
![Main Demo](./assets/demo.gif)

## How to Use
1. Click the "Upload Image" button
2. Use the sliders at the bottom to adjust:
   ![Controls Guide](./assets/controls.gif)
   - Refraction intensity
   - Curvature
   - Slab Width/Height
   - Corner Radius
   - Blur
   - Finger or cursor tracking speed
3. Drag the slab on the canvas to reposition

The shader includes two pre-built presets you can try instantly:
![Preset Display](./assets/preset.gif)
| Preset | Description | Recommended Use |
|---------|--------------|-----------------|
| **Rounded Slab** | Balanced rectangle with subtle corner radius and smooth refraction. | Default elegant “glass panel” look for UI cards and overlays. |
| **Circle Slab** | Perfect circular dome with soft curvature and even refraction spread. | Ideal for bubble, lens, or spherical highlight effects. |
| **Pill Slab** | Wide rectangular capsule with stronger curvature at the shorter edges and flatter refraction across the longer sides. | Best for button-like or elongated glass surfaces (status bars, menu highlights). |
> Select a preset from the dropdown to automatically adjust all relevant parameters (size, curvature, blur, etc.).
> Each preset is **pre-customized for windowed, tablet, and mobile displays**, ensuring consistent visual appearance and curvature behavior across devices.

Photo credit: [Stunning High-Resolution Nature and Landscape Backgrounds by Vecteezy](https://www.vecteezy.com/photo/49547663-stunning-high-resolution-nature-and-landscape-backgrounds-breathtaking-scenery-in-hd)

