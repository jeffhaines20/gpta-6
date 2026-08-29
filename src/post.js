// Post-processing stack: HDR scene target -> bloom -> composite (height fog +
// aerial perspective + ACES tonemap + dither).
//
// Written rather than pulled from three's addons so the whole chain is one file
// we own and can budget: it is 4 extra draw calls total, and every uniform is
// visible here. Phase 1's blind critic ranked "no HDR pipeline" and "no
// atmospheric scattering" as gaps 4 and 2; this is both of them.
//
// Tone mapping moves OFF the renderer and into the composite pass. Bloom has to
// see linear HDR values — if the renderer tonemaps in-material first, the bright
// pass has nothing above 1.0 left to find.

import * as THREE from '../vendor/three.module.min.js';

const FULLSCREEN_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// A single oversized triangle beats a quad: no diagonal seam, one fewer vertex,
// and the GPU clips the overhang for free.
function fullscreenGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  return g;
}

const BRIGHT_FRAG = `
uniform sampler2D tDiffuse;
uniform float threshold;
uniform float softKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee so the bloom does not switch on as a hard edge across a gradient.
  float knee = threshold * softKnee + 1e-5;
  float soft = clamp(lum - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, lum - threshold) / max(lum, 1e-5);
  gl_FragColor = vec4(c * contrib, 1.0);
}`;

const BLUR_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 direction;      // texel-sized step
varying vec2 vUv;
void main() {
  // 9-tap gaussian collapsed to 5 bilinear fetches.
  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
  vec2 o1 = direction * 1.3846153846;
  vec2 o2 = direction * 3.2307692308;
  sum += (texture2D(tDiffuse, vUv + o1).rgb + texture2D(tDiffuse, vUv - o1).rgb) * 0.3162162162;
  sum += (texture2D(tDiffuse, vUv + o2).rgb + texture2D(tDiffuse, vUv - o2).rgb) * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_FRAG = `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform float bloomStrength;
uniform float exposure;
uniform vec3  fogColor;
uniform vec3  fogInscatter;     // sun-tinted forward-scatter colour
uniform vec3  sunDirView;       // sun direction in VIEW space
uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogHeightRef;     // world Y the density is quoted at
uniform float cameraY;
uniform float cameraNear;
uniform float cameraFar;
uniform mat4  invProjection;
uniform vec2  resolution;
uniform float wetness;
varying vec2 vUv;

float linearDepth(float z) {
  float ndc = z * 2.0 - 1.0;
  return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
}

// View-space position from depth, so fog is a real distance and not a screen effect.
vec3 viewPosFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = invProjection * clip;
  return view.xyz / view.w;
}

// ACES filmic, Narkowicz fit. The single biggest "this looks like a game" lever.
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  float depth = texture2D(tDepth, vUv).r;

  vec3 color = scene + bloom * bloomStrength;

  // --- Height fog with aerial perspective.
  // Sky pixels (depth == 1) get full fog so the world edge dissolves into the
  // horizon instead of ending in the razor-sharp cut the critic measured.
  vec3 vpos = viewPosFromDepth(vUv, depth);
  float dist = (depth >= 0.999999) ? cameraFar : length(vpos);

  // Integrate an exponential height falloff along the ray. Approximated with the
  // fragment's midpoint height, which is stable and cheap at this scale.
  float worldY = cameraY + vpos.y;
  float midY = mix(cameraY, worldY, 0.5);
  float heightTerm = exp(-max(0.0, midY - fogHeightRef) * fogHeightFalloff);
  float fogAmount = 1.0 - exp(-dist * fogDensity * heightTerm);
  fogAmount = clamp(fogAmount, 0.0, 1.0);

  // Forward scattering: looking toward the sun through haze goes warm and bright.
  vec3 viewDir = normalize(vpos);
  float sunAmount = max(dot(viewDir, normalize(sunDirView)), 0.0);
  vec3 fogCol = mix(fogColor, fogInscatter, pow(sunAmount, 6.0));

  color = mix(color, fogCol, fogAmount);

  // --- Exposure, tonemap.
  color *= exposure;
  color = aces(color);

  // Wet streets read slightly cooler and more contrasted.
  color = mix(color, color * vec3(0.94, 0.98, 1.06), wetness * 0.35);

  // Ordered dither before the 8-bit write. Phase 1's critic measured undithered
  // sky banding in runs of 17-19 identical pixels.
  float d = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));
  color += (d - 0.5) / 255.0;

  gl_FragColor = vec4(color, 1.0);
}`;

export class PostStack {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;
    this.bloomScale = opts.bloomScale ?? 0.5;   // bloom runs at half res

    // Tone mapping is ours now; the renderer must hand us linear HDR.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.params = {
      bloomThreshold: 1.0,
      bloomSoftKnee: 0.6,
      bloomStrength: 0.55,
      exposure: 1 / 330,
      fogColor: new THREE.Color(0x8fa4c4),
      fogInscatter: new THREE.Color(0xffb478),
      fogDensity: 0.0025,
      fogHeightFalloff: 0.018,
      fogHeightRef: 0,
      wetness: 0,
      sunDirection: new THREE.Vector3(0, 1, 0),
    };

    const type = THREE.HalfFloatType;
    this.hdr = new THREE.WebGLRenderTarget(1, 1, {
      type, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
    });
    this.hdr.depthTexture = new THREE.DepthTexture(1, 1);
    this.hdr.depthTexture.type = THREE.UnsignedIntType;

    const rtOpts = { type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    this.brightRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurB = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    const geo = fullscreenGeometry();
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.Camera();

    this.brightMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${BRIGHT_FRAG}`,
      uniforms: {
        tDiffuse: { value: null },
        threshold: { value: this.params.bloomThreshold },
        softKnee: { value: this.params.bloomSoftKnee },
      },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${BLUR_FRAG}`,
      uniforms: { tDiffuse: { value: null }, direction: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this.compositeMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${COMPOSITE_FRAG}`,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tDepth: { value: null },
        bloomStrength: { value: this.params.bloomStrength },
        exposure: { value: this.params.exposure },
        fogColor: { value: new THREE.Vector3() },
        fogInscatter: { value: new THREE.Vector3() },
        sunDirView: { value: new THREE.Vector3(0, 1, 0) },
        fogDensity: { value: this.params.fogDensity },
        fogHeightFalloff: { value: this.params.fogHeightFalloff },
        fogHeightRef: { value: 0 },
        cameraY: { value: 0 },
        cameraNear: { value: 0.1 }, cameraFar: { value: 1000 },
        invProjection: { value: new THREE.Matrix4() },
        resolution: { value: new THREE.Vector2() },
        wetness: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });

    this.quad = new THREE.Mesh(geo, this.brightMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this._sunView = new THREE.Vector3();
    // sceneCalls/sceneTriangles are the numbers the budget gate cares about.
    // renderer.info.render is per-render() and the composite blit would otherwise
    // overwrite the scene's counts with 1 call / 1 triangle.
    this.stats = { passes: 0, sceneCalls: 0, sceneTriangles: 0, totalCalls: 0 };
  }

  setSize(width, height) {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    this.hdr.setSize(w, h);
    this.hdr.depthTexture.image.width = w;
    this.hdr.depthTexture.image.height = h;
    const bw = Math.max(1, Math.floor(w * this.bloomScale));
    const bh = Math.max(1, Math.floor(h * this.bloomScale));
    this.brightRT.setSize(bw, bh);
    this.blurA.setSize(bw, bh);
    this.blurB.setSize(bw, bh);
    this.compositeMat.uniforms.resolution.value.set(w, h);
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
    this.stats.passes++;
  }

  render() {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this.stats.sceneCalls = r.info.render.calls;
      this.stats.sceneTriangles = r.info.render.triangles;
      this.stats.passes = 0;
      this.stats.totalCalls = this.stats.sceneCalls;
      return;
    }
    this.stats.passes = 0;

    r.setRenderTarget(this.hdr);
    r.clear();
    r.render(this.scene, this.camera);
    this.stats.sceneCalls = r.info.render.calls;
    this.stats.sceneTriangles = r.info.render.triangles;

    // Bright pass at half res.
    this.brightMat.uniforms.tDiffuse.value = this.hdr.texture;
    this.brightMat.uniforms.threshold.value = this.params.bloomThreshold;
    this.brightMat.uniforms.softKnee.value = this.params.bloomSoftKnee;
    this._blit(this.brightMat, this.brightRT);

    // Two separable blur iterations. More than this on a half-res target buys
    // nothing visible and costs two more full-screen passes.
    const bw = this.brightRT.width, bh = this.brightRT.height;
    this.blurMat.uniforms.tDiffuse.value = this.brightRT.texture;
    this.blurMat.uniforms.direction.value.set(1 / bw, 0);
    this._blit(this.blurMat, this.blurA);
    this.blurMat.uniforms.tDiffuse.value = this.blurA.texture;
    this.blurMat.uniforms.direction.value.set(0, 1 / bh);
    this._blit(this.blurMat, this.blurB);
    this.blurMat.uniforms.tDiffuse.value = this.blurB.texture;
    this.blurMat.uniforms.direction.value.set(2 / bw, 0);
    this._blit(this.blurMat, this.blurA);
    this.blurMat.uniforms.tDiffuse.value = this.blurA.texture;
    this.blurMat.uniforms.direction.value.set(0, 2 / bh);
    this._blit(this.blurMat, this.blurB);

    // Composite.
    const u = this.compositeMat.uniforms;
    const p = this.params;
    u.tScene.value = this.hdr.texture;
    u.tBloom.value = this.blurB.texture;
    u.tDepth.value = this.hdr.depthTexture;
    u.bloomStrength.value = p.bloomStrength;
    u.exposure.value = p.exposure;
    u.fogColor.value.set(p.fogColor.r, p.fogColor.g, p.fogColor.b);
    u.fogInscatter.value.set(p.fogInscatter.r, p.fogInscatter.g, p.fogInscatter.b);
    u.fogDensity.value = p.fogDensity;
    u.fogHeightFalloff.value = p.fogHeightFalloff;
    u.fogHeightRef.value = p.fogHeightRef;
    u.wetness.value = p.wetness;
    u.cameraY.value = this.camera.position.y;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.invProjection.value.copy(this.camera.projectionMatrixInverse);
    // Sun direction has to reach the shader in view space or the inscatter lobe
    // swings around as the camera turns.
    this._sunView.copy(p.sunDirection).transformDirection(this.camera.matrixWorldInverse);
    u.sunDirView.value.copy(this._sunView);

    this._blit(this.compositeMat, null);
    this.stats.totalCalls = this.stats.sceneCalls + this.stats.passes;
  }

  dispose() {
    for (const t of [this.hdr, this.brightRT, this.blurA, this.blurB]) t.dispose();
    for (const m of [this.brightMat, this.blurMat, this.compositeMat]) m.dispose();
  }
}
