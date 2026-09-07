// Post-processing stack: HDR scene target -> bloom -> composite (height fog +
// aerial perspective + ACES tonemap + sRGB encode + dither).
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
uniform float exposure;
varying vec2 vUv;
void main() {
  // Same guard as the composite's sanitize(), inlined because this shader does not
  // share SKY_COMMON-style includes with it. Without it, contrib below is
  // Inf/Inf = NaN and the separable blur then spreads that NaN over a 9-tap
  // neighbourhood of otherwise-good pixels.
  //
  // AND FOR TWO ROUNDS IT DID EXACTLY THAT, because the guard was written with
  // mix(). See sanitize() in COMPOSITE_FRAG for the whole finding; the short
  // version is that mix(x, y, 0.0) is x*(1.0 - a) + y*a and Inf * 0.0 is NaN, so
  // the one line that exists to remove non-finite values was MANUFACTURING them
  // from every Inf it caught. Measured at the golden whitebox camera: one NaN
  // texel here, 312 after the third blur pass, 675 after the fourth, and the
  // composite then multiplies each of those by bloomStrength and ADDS it.
  // Ternaries instead, so nothing that failed the test is ever an operand.
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  bvec3 ok = lessThanEqual(c, vec3(60000.0));
  c = vec3(ok.x ? max(c.x, 0.0) : 60000.0,
           ok.y ? max(c.y, 0.0) : 60000.0,
           ok.z ? max(c.z, 0.0) : 60000.0);
  // Threshold in EXPOSED units, not in nits.
  //
  // The scene target is authored in physical units - a sunlit road at golden hour
  // is thousands of nits - while daynight.js authors bloomThreshold on the 0-2
  // scale the tonemapper works in (noon 1.7, dusk 0.85, night 0.55). Comparing
  // those two directly made lum - threshold indistinguishable from lum, so
  // contrib came out ~1 for EVERY pixel and the bright pass passed the whole frame
  // through. The composite then added bloomStrength x a 20 px blur of the entire
  // image: veiling glare, not bloom.
  //
  // Measured at the golden corridor camera, mean luminance the bloom ADDED, binned
  // by each pixel's own no-bloom luminance:
  //
  //     0-19  +29.3    50-99  +32.5    160-219  +19.6    220-255  +8.0
  //
  // It was lifting the darks hardest and the highlights least - the exact inverse
  // of a bloom, and the mechanism behind three rounds of critics reporting a milky
  // frame with no black point, flattened shadow edges and low chroma.
  //
  // Multiplying by the camera stop puts lum on the same scale the threshold is
  // authored on, so a threshold of 1.4 now means 1.4x mid-grey rather than 1.4
  // nits. bloomStrength is re-derived alongside it in daynight.js.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722)) * exposure;
  // Soft knee so the bloom does not switch on as a hard edge across a gradient.
  float knee = threshold * softKnee + 1e-5;
  float soft = clamp(lum - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  // contrib is a ratio, so it is unit-free and still applies to c in nits.
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

// Screen-space ambient occlusion, at half resolution.
//
// Every blind critic across both review rounds named the same gap first: buildings
// and props meet the ground with no darkening at all, so nothing looks like it is
// sitting ON anything. That is contact occlusion, and a forward renderer gives you
// none of it for free.
//
// Normals are reconstructed from neighbouring depth samples rather than from a
// normal buffer, so this needs no change to any surface material and no second
// geometry pass - which matters because the draw-call gate counts scene draws and
// a normal prepass would double them. The cost is post passes, which the gate does
// not count, and slightly softer normals at depth discontinuities.
// WHY THE KERNEL AND THE DITHER ARE PARAMETERS AND NOT CONSTANTS. The r8 review
// found the junction band on every facade dithered -- alternating light and dark
// single pixels -- and the AO buffer says why in one number: straight out of this
// pass, the pixel-scale grain on that band is 27.2 of 255 (tools/ao-noise.mjs
// --live). The band's own mean is 30. The estimator's noise is 90% of its signal.
//
// THE ARITHMETIC OF THAT, because it is the whole defect. Twelve samples, each
// either occluded or not, quantises `ao` to steps of 1/12. At the junction ~2.5
// of the 12 land on the jamb, so raw ao ~ 0.794, and pow(0.794, 8.5) = 0.14.
// The slope of that curve there is 8.5 * 0.794^7.5 = 1.59, so ONE SAMPLE
// FLIPPING moves the output by 1.59/12 = 0.133, which is 34 of 255. Measured
// 27.2. The exponent is not amplifying a smooth signal; it is amplifying a coin
// toss, and the coin is tossed again every frame as the camera moves.
//
// It did not show at aoScale 0.5 because a half-resolution buffer is bilinearly
// UPSAMPLED into the composite, and that upsample is not depth-aware: it blends
// unconditionally, over 2 screen pixels, on top of a blur that already reached
// +-4. Going to full resolution was right and is why props ground -- and it
// removed the one unconditional smoothing step in the chain, which is what let
// the estimator's noise through. Nothing about the noise was new; it was always
// there, under two stages of dilution.
//
// So each lever below defaults to EXACTLY the r8 behaviour and can be swept
// without editing this file, because "isolate one term at a time" is the only
// way to tell which of them is carrying the fix.
// KERNEL: 0 = the legacy typed vectors, 1 = the spiral, 2 = the spiral with
// its sample LENGTHS decorrelated from its elevations.
const AO_FRAG = (SAMPLES, KERNEL) => `
uniform sampler2D tDepth;
uniform mat4  invProjection;
uniform mat4  projection;   // forward projection, to put a view-space sample back on screen
uniform vec2  texelSize;
uniform float radius;
uniform float bias;
uniform float intensity;
uniform float falloff;      // metres of soft ramp on the occlusion test; 0 = hard step
uniform float dither;       // 0 = per-pixel hash rotation; N = an NxN interleaved tile
uniform float cameraFar;
varying vec2 vUv;

vec3 viewPosFromDepth(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = invProjection * clip;
  return view.xyz / view.w;
}
vec3 viewPosAt(vec2 uv) {
  return viewPosFromDepth(uv, texture2D(tDepth, uv).r);
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  // Sky carries no occlusion. Without this the horizon grows a dark rim.
  if (depth >= 0.999999) { gl_FragColor = vec4(1.0); return; }

  vec3 origin = viewPosFromDepth(vUv, depth);

  // Normal from the cross product of screen-space depth gradients. Derivatives
  // (dFdx/dFdy) would be cheaper but are unreliable across the GLSL versions this
  // ships against; explicit neighbour taps behave identically everywhere.
  vec3 dx = viewPosAt(vUv + vec2(texelSize.x, 0.0)) - origin;
  vec3 dx2 = origin - viewPosAt(vUv - vec2(texelSize.x, 0.0));
  vec3 dy = viewPosAt(vUv + vec2(0.0, texelSize.y)) - origin;
  vec3 dy2 = origin - viewPosAt(vUv - vec2(0.0, texelSize.y));
  // Pick the smaller gradient on each axis so a silhouette edge does not tilt the
  // normal and smear occlusion across the discontinuity.
  dx = abs(dx.z) < abs(dx2.z) ? dx : dx2;
  dy = abs(dy.z) < abs(dy2.z) ? dy : dy2;
  vec3 normal = normalize(cross(dx, dy));

  // ROTATION. Two ways, and which one is in use decides whether the blur that
  // follows can cancel the dither or merely average it down.
  //
  // dither = 0 is the r8 behaviour: a continuous hash, so every pixel gets an
  // unrelated angle and a 5x5 box sees 25 INDEPENDENT draws. That reduces the
  // variance by 25 on average and by a random amount in any particular window,
  // and the amount left over is the grain.
  //
  // dither = N tiles N*N fixed angles across the screen instead. At N = 5 the
  // tile is exactly the footprint of the 5x5 blur, so a full-weight window
  // contains each of the 25 angles ONCE and the interleaving cancels rather than
  // averages. 7 is coprime with 25, so k*7 mod 25 is a bijection on the tile and
  // adjacent pixels get angles a long way apart instead of a ramp.
  float rnd;
  if (dither < 0.5) {
    rnd = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  } else {
    vec2 t = floor(mod(gl_FragCoord.xy, dither));
    float m = dither * dither;
    rnd = (mod(t.y * dither + t.x, m) * 7.0 + 0.5) / m;
    rnd = fract(rnd);
  }
  float ca = cos(rnd * 6.2831853), sa = sin(rnd * 6.2831853);

  const int SAMPLES = ${SAMPLES};
${KERNEL ? `
  // STRATIFIED COSINE HEMISPHERE, built about the actual normal.
  //
  // The kernel it replaces is twelve hand-typed vectors in an arbitrary space,
  // folded onto whichever side of the surface they land on with
  // \`if (dot(rk, normal) < 0.0) rk = -rk;\`. That fold is cheap and it is the
  // reason the estimator is so noisy: it is not a cosine hemisphere, the twelve
  // lengths clump (three of them under a fifth of the radius, one at 0.87, and
  // nothing between 0.34 and 0.53), and after the per-pixel rotation the set a
  // pixel actually gets depends on the rotation far more than it should.
  //
  // This builds a tangent basis on the surface, rotates it per pixel, and walks
  // a golden-angle spiral: azimuth by the golden angle so no two samples share a
  // direction, disk radius sqrt(u) so the projected density is uniform, and
  // elevation sqrt(1-u) so the distribution is cosine-weighted about the normal,
  // which is the weighting the occlusion integral actually wants. Sample LENGTH
  // is stratified from 0.12 R to R across the set, keeping the bias toward the
  // origin that makes contact darkening tight while removing the clumping.
  //
  // aoKernel 2 differs from 1 in exactly one line: it draws the sample LENGTH
  // from the golden-ratio low-discrepancy sequence instead of from the same u
  // that sets the elevation. In kernel 1 those are the same variable, so every
  // near-normal sample is also a short one and every grazing sample is also a
  // long one -- and grazing-and-long is where occluders actually are. Whether
  // that correlation costs anything is a question for the sweep.
  vec3 up = abs(normal.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 tang = normalize(cross(up, normal));
  vec3 bitan = cross(normal, tang);
  vec3 t2 = tang * ca + bitan * sa;
  vec3 b2 = tang * -sa + bitan * ca;
` : `
  // Hemisphere kernel, weighted toward the origin so contact darkening is tight.
  vec3 kernel[12];
  kernel[0]  = vec3( 0.5381,  0.1856,  0.4319);
  kernel[1]  = vec3( 0.1379,  0.2486,  0.4430);
  kernel[2]  = vec3( 0.3371,  0.5679,  0.0057);
  kernel[3]  = vec3(-0.6999, -0.0451,  0.0019);
  kernel[4]  = vec3( 0.0689, -0.1598,  0.8547);
  kernel[5]  = vec3( 0.0560,  0.0069,  0.1843);
  kernel[6]  = vec3(-0.0146,  0.1402,  0.0762);
  kernel[7]  = vec3( 0.0100, -0.1924,  0.0344);
  kernel[8]  = vec3(-0.3577, -0.5301,  0.4358);
  kernel[9]  = vec3(-0.3169,  0.1063,  0.0158);
  kernel[10] = vec3( 0.0103, -0.5869,  0.0046);
  kernel[11] = vec3(-0.0897, -0.4940,  0.3287);
`}
  float occlusion = 0.0;
  for (int i = 0; i < SAMPLES; i++) {
${KERNEL ? `
    float fi = float(i) + 0.5;
    float u = fi / float(SAMPLES);
    float ang = fi * 2.39996323;
    float rr = sqrt(u);
    vec3 rk = (t2 * (cos(ang) * rr) + b2 * (sin(ang) * rr) + normal * sqrt(max(0.0, 1.0 - u)))
              * mix(0.12, 1.0, ${KERNEL === 2 ? 'fract(fi * 0.6180339887)' : 'u'});
` : `
    vec3 k = kernel[i];
    vec3 rk = vec3(k.x * ca - k.y * sa, k.x * sa + k.y * ca, k.z);
    // Flip into the hemisphere around the surface normal.
    if (dot(rk, normal) < 0.0) rk = -rk;
`}
    vec3 samplePos = origin + rk * radius;

    vec4 clip = projection * vec4(samplePos, 1.0);
    if (clip.w <= 0.0) continue;
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sceneZ = viewPosAt(suv).z;
    float diff = sceneZ - samplePos.z;
    // Range check: a sample far in front of the surface is a different object, not
    // an occluder. Without it every silhouette grows a dark halo.
    float rangeCheck = smoothstep(0.0, 1.0, radius / max(1e-4, abs(origin.z - sceneZ)));
    // THE TEST IS A STEP, AND A STEP IS WHERE THE QUANTISATION COMES FROM. With
    // falloff = 0 this is the r8 behaviour: each sample contributes 0 or 1, so a
    // 12-sample estimate can only take 13 values and a geometry change of a
    // millimetre flips one of them all the way. A soft ramp over a falloff-metre window lets a sample that is marginally behind the surface contribute
    // marginally, which is both a better estimate of the integral and a
    // continuous function of the geometry -- so it does not flicker when the
    // camera moves half a pixel.
    float hit = falloff > 0.0 ? smoothstep(bias, bias + falloff, diff)
                              : (diff > bias ? 1.0 : 0.0);
    occlusion += hit * rangeCheck;
  }

  float ao = 1.0 - occlusion / float(SAMPLES);
  // Contrast curve. The kernel is weighted toward the origin - several vectors are
  // under a fifth of the radius - which keeps contact darkening tight but means a
  // raw average badly understates occlusion in a corner. Measured: without this the
  // whole buffer sat at a mean of 0.93 and wall/ground junctions moved less than 2%,
  // which is indistinguishable from no AO at all.
  //
  // AND IT IS ALSO THE NOISE GAIN. d(x^n)/dx = n*x^(n-1), so whatever the
  // estimator's per-pixel error is, the buffer carries it multiplied by that.
  // Any change to the exponent has to be read as a change to both at once.
  ao = pow(clamp(ao, 0.0, 1.0), intensity);
  gl_FragColor = vec4(vec3(ao), 1.0);
}`;

// Depth-aware blur. A plain box blur bleeds occlusion across silhouettes and
// gives the halo the range check just removed.
//
// THE r8 WEIGHT IS exp(-|dd| * 2000) ON WINDOW DEPTH, AND WINDOW DEPTH IS NOT A
// DISTANCE. With near = 0.2 and far = 1400 the window value is d ~ 1 - 0.2/t, so
// dd = 0.2 dt / t^2 and the weight is exp(-400 dt / t^2): the tolerance grows
// with the SQUARE of the distance. At 5 m a same-surface step of 8 cm across two
// pixels is already rejected at w = 0.28; at 100 m a five-METRE silhouette is
// accepted at w = 0.82. So the filter is too strict where it should smooth and
// too permissive where it should cut, and the one thing it is calibrated for is
// the middle distance it happened to be tuned at.
//
// depthSigma > 0 switches to a RELATIVE tolerance on linearised depth: reject a
// neighbour that is more than depthSigma of its own distance away, with a small
// absolute floor so the metre in front of the camera does not go to zero
// tolerance. depthSigma = 0 keeps the r8 weight so the two can be differenced.
// It is a parameter and not a replacement because the r8 filter measured an
// effective 147 taps on the junction band (tools/ao-noise.mjs --live) -- it is
// NOT collapsing there, which was the first hypothesis and it was wrong.
const AO_BLUR_FRAG = `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2  texelSize;
uniform float cameraNear;
uniform float cameraFar;
uniform float blurRadius;
uniform float depthSigma;
varying vec2 vUv;

float linZ(float d) {
  float ndc = d * 2.0 - 1.0;
  return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
}

void main() {
  float centerDepth = texture2D(tDepth, vUv).r;
  float cz = linZ(centerDepth);
  float tol = max(depthSigma * cz, 0.03);
  float sum = 0.0, weightSum = 0.0;
  for (int x = -4; x <= 4; x++) {
    for (int y = -4; y <= 4; y++) {
      // blurRadius is a runtime uniform so the kernel WIDTH can be swept without
      // recompiling. GLSL ES 1.0 needs the loop bounds constant, so the taps
      // outside the requested radius are skipped rather than not iterated. The
      // constant bound is 4 rather than 2 only so radii above 2 can be SWEPT;
      // at blurRadius 2 the extra iterations do nothing but a compare.
      if (abs(float(x)) > blurRadius || abs(float(y)) > blurRadius) continue;
      vec2 offset = vec2(float(x), float(y)) * texelSize;
      float d = texture2D(tDepth, vUv + offset).r;
      // Reject neighbours on a different surface.
      float w = depthSigma > 0.0 ? exp(-abs(linZ(d) - cz) / tol)
                                 : exp(-abs(d - centerDepth) * 2000.0);
      sum += texture2D(tAO, vUv + offset).r * w;
      weightSum += w;
    }
  }
  gl_FragColor = vec4(vec3(sum / max(1e-4, weightSum)), 1.0);
}`;

const COMPOSITE_FRAG = `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform float aoStrength;
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

// Highlight rolloff: a soft knee in front of the ACES fit, so the top of the
// range compresses into a shoulder instead of pinning at the ceiling.
//
// WHAT IT IS FOR, AND WHAT IT CANNOT DO. A facade:bayTower glazing cell whose
// normal sits 1.1 degrees off the half-vector of the 8-degree golden sun returns
// - measured into a FloatType target by tools/highlight-probe.mjs, at the
// whitebox camera - a mean of 643,000 cd/m2 over the pane and a peak of
// 14,287,888, against a display-white radiance of 29,800 at golden's stop. It
// is not achromatic light: the same readback puts the pane at B/R 0.227, which
// is the sun's own colour.
//
// None of that reaches this shader. The scene target is HalfFloatType, so every
// channel past 65,504 is stored saturated, and sanitize() below then pins every
// channel past 60,000 onto ONE number. By the time the composite runs, the pane
// is (60000, 60000, 60000) - flat, achromatic, and bit-identical to the sun
// disc, which the sky clamps to the same 60,000. So no curve here can shrink
// that pane, and none can give it its colour back: both were destroyed upstream
// of this file, and the fix for them has to sit before the half-float write.
// Measured at the same camera: 7,840 px past the ceiling, 14,066 past the
// display-white radiance, so 44% of what reads as white DOES still carry a
// gradient this curve can act on.
//
// WHAT IT DOES DO. The value this curve sees is scene + bloom, and bloom is added
// ON TOP of a value sanitize has already clamped - so the pane's core left this
// composite at a literal 255,255,255 with bloom on and 254 with it off, i.e. the
// ceiling was reading as the display maximum and the bloom halo was carrying it
// out over the string course and pier in front of the glass. The rolloff puts
// that whole saturated band back inside the range and gives the band below it
// somewhere to go, which is the part of the defect that lives on this side of
// the target.
//
// THE CURVE. Reinhard's hyperbolic soft knee, per channel, on the EXPOSED value
// - the same 0-2-ish scale bloomThreshold is authored on, so one pair of
// constants is correct at every preset and nothing in daynight.js moves:
//
//     f(x) = x                                  for x <= K
//     f(x) = K + S*(x-K) / (S + (x-K))          for x >  K,   S = C - K
//
// C1-continuous at K (slope exactly 1 there, so nothing kinks), monotonic, and
// invertible in closed form - which matters because tools/critic-metrics.mjs,
// tools/pane-tint.mjs, tools/glaz-probe.mjs and tools/transfer-audit.mjs all
// recover radiance from a shipped byte and all four now carry this inverse.
//
// THE TWO CONSTANTS, and C is not a taste. The four tools that recover radiance
// from a shipped byte have to invert this, and the byte they have to invert it
// at is 255, which decodes to the ACES fit's own white point 7.2416. The
// rolloff's inverse only exists for y < C, so C > 7.2416 or the inverse blows
// up on the brightest pixel in the frame - and with C above it, display 255 also
// stays REACHABLE, so "clipped" keeps its meaning for critic-metrics.mjs.
// C = 8.0. K is then the only free parameter, and lowering it buys compression
// at the top: at C = 8.0, byte 255 lands on 253.6 with K = 3.0, 252.1 with
// K = 0.5 and 252.0 with K = 0.35, so 0.5 is where the return stops. It is also
// where the cost stops: the map is exact to the byte at 210 and below, which is
// the whole sky at every hour (golden 0.36 exposed, noon 0.24), every sunlit
// road, and 99.9% of the noon and night frames.
//
// THE WHOLE EFFECT, exactly, as a byte-to-byte map - it is a per-channel curve
// on a per-channel value, so this table IS the change, at every preset and every
// pixel:
//
//     in   210    220    230    240    245    250    252    254    255
//     out  210.0  219.7  229.2  238.5  243.1  247.6  249.4  251.2  252.1
//
// So it is worth about three display units at the very top and under one below
// 230. That is the whole of what a curve on this side of the scene target can
// be worth, which is the finding as much as the change is. Set
// highlightCeil <= highlightKnee to disable it and get the old chain back -
// that is how the A/B arms in the probes are built.
uniform float highlightKnee;
uniform float highlightCeil;
vec3 highlightRolloff(vec3 x) {
  float S = highlightCeil - highlightKnee;
  if (S <= 0.0) return x;
  vec3 t = max(x - highlightKnee, vec3(0.0));
  return min(x, vec3(highlightKnee)) + (S * t) / (S + t);
}

// Half-float hygiene, and the reason the noon frame has a hole in it.
//
// The scene renders into a HalfFloatType target and the district is authored in
// absolute nits, so a metallic pane reflecting the PMREM - whose own ceiling is
// sky.js's maxRadiance of 60,000 nits - plus a direct specular lobe from a
// 34,470 lux sun lands past half-float's 65,504 and stores Inf. Some of it comes
// back NaN outright: measured at the corridor camera at golden hour, 14,259 NaN
// channels and 8 Inf in the 1600x900 scene target, with the finite maximum sitting
// exactly on 65,504.
//
// aces() is clamp((x(ax+b))/(x(cx+d)+e)): hand it Inf and it computes Inf/Inf, and
// clamp(NaN) is 0 on this rasteriser. That is a PURE BLACK blob, and it is not new
// - docs/shots/tod-noon.png has 20,920 pure-black pixels (1.79% of frame) on the
// committed build, and three critic rounds have described the noon frame as having
// black facades. Dusk has none of it, because at 1,200 lux nothing gets near the
// ceiling. Switching bloom off does not remove it, which is what ruled the bright
// pass out as the source.
//
// NaN fails every comparison, including against itself, so lessThanEqual() is
// false for NaN and for Inf alike and both land on the ceiling. A blown specular
// highlight then renders as the white it physically is instead of as a hole.
// Finite pixels are returned bit-for-bit unchanged, so no frame that was correct
// moves.
//
// debugSanitize exists to answer the white-rectangle question, which four critic
// sightings could describe and none could attribute. Set it to 1 and every pixel
// this guard catches is painted an unmistakable green instead of the ceiling. If
// the rectangle turns green, the guard IS the rectangle and the fix belongs
// upstream at the overflow; if it stays white, the hypothesis is dead and the
// white came from somewhere else. Either answer is worth having, which is why the
// switch is a uniform and not a temporary edit - it can be re-run on any future
// frame without touching the shader again.
//
// AND IT WAS WRITTEN WITH mix(), WHICH MADE IT A NaN SOURCE. This is the whole
// of the intermittent additive white block, and it is one line.
//
// mix(x, y, a) is x*(1.0 - a) + y*a. For a channel that FAILS the test, a is
// 0.0, so the second term is y * 0.0 - and when y is +Inf, that is NaN, not
// zero. NaN itself came through correctly (GLSL max(x, y) is y < x ? x : y and
// every comparison against NaN is false, so max(NaN, 0.0) is 0.0 and the mix
// returned CEIL), but every INFINITY the guard caught left it as a NaN. The
// guard was manufacturing exactly what it exists to remove.
//
// What that is worth, measured frame-wide by tools/nan-probe.mjs at the golden
// whitebox camera, pass by pass:
//
//     hdr scene target   6,935 non-finite   (6,924 NaN + 11 Inf)
//     bright pass            1 NaN          at (158, 370)
//     blurA                312 NaN          screen box [134,358]-[180,382]
//     blurB                675 NaN          screen box [132,344]-[180,396]
//
// Eleven Inf channels in the scene target become ONE NaN texel in the bright
// pass, and four separable blur passes at +-1.4 and +-3.2 texels, run twice at
// double step, spread it into a 49x53 half-res block - 675 texels, about 2,700
// full-resolution pixels. NaN does not blur: any tap touching one makes the
// whole result NaN, so the block has a HARD edge and a rectangular support
// rather than a falloff. The composite then sanitizes it back to CEIL, so the
// block arrives as bloom at 60,000 nits flat and is ADDED at bloomStrength:
// +24,000 nits, or 2.49 in exposed units at golden, over 2,700 px of frame that
// owes nothing to the geometry underneath it.
//
// That is the "intermittent additive 2,890 px block at (137,349)-(216,402)" the
// bimodal whitebox measurement carries, and it is also most of what four critic
// sightings described as a hard-edged, axis-aligned, perspective-ignoring white
// rectangle painted over a pier and a spandrel in FRONT of the glass. It is
// intermittent because it is seeded by the ELEVEN Inf channels in a frame: a
// frame with none has no block at all, which is why eight captures in ten sat at
// 0.1012-0.1023 and two at 0.2430.
//
// The fix is to stop multiplying: a ternary selects the ceiling for anything
// that failed the test, so nothing non-finite is ever an operand. Finite pixels
// are still returned bit-for-bit, and NaN still lands on the ceiling rather than
// on black, which is what the paragraph above this one is about.
uniform float debugSanitize;
vec3 sanitize(vec3 c) {
  const float CEIL = 60000.0;
  bvec3 ok = lessThanEqual(c, vec3(CEIL));
  if (debugSanitize > 0.5 && !all(ok)) return vec3(0.0, 40000.0, 0.0);
  return vec3(ok.x ? max(c.x, 0.0) : CEIL,
              ok.y ? max(c.y, 0.0) : CEIL,
              ok.z ? max(c.z, 0.0) : CEIL);
}


void main() {
  vec3 scene = sanitize(texture2D(tScene, vUv).rgb);
  vec3 bloom = sanitize(texture2D(tBloom, vUv).rgb);
  float depth = texture2D(tDepth, vUv).r;

  // AO multiplies the scene but NOT the bloom. Bloom comes from emissives - lit
  // windows, lamps, signage - and those are light sources, not surfaces receiving
  // ambient. Occluding them would dim the very things that read as light at night.
  float ao = mix(1.0, texture2D(tAO, vUv).r, aoStrength);
  vec3 color = scene * ao + bloom * bloomStrength;

  // --- Height fog with aerial perspective.
  // Sky pixels (depth == 1) get full fog so the world edge dissolves into the
  // horizon instead of ending in the razor-sharp cut the critic measured.
  vec3 vpos = viewPosFromDepth(vUv, depth);
  bool isSky = depth >= 0.999999;
  float dist = isSky ? cameraFar : length(vpos);

  // Integrate an exponential height falloff along the ray. Approximated with the
  // fragment's midpoint height, which is stable and cheap at this scale.
  float worldY = cameraY + vpos.y;
  float midY = mix(cameraY, worldY, 0.5);
  float heightTerm = exp(-max(0.0, midY - fogHeightRef) * fogHeightFalloff);
  float fogAmount = 1.0 - exp(-dist * fogDensity * heightTerm);
  fogAmount = clamp(fogAmount, 0.0, 1.0);
  // The sky dome is the far field and already carries its own scattering. Fogging
  // it again replaces it with the fog colour, and because fog is normalised against
  // the camera stop to a fixed target, that flattened every time of day to the same
  // sky brightness - measured night sky L=187.6 against ground L=100.6, which is the
  // blind critics' unanimous "there is no night" finding.
  if (isSky) fogAmount = min(fogAmount, 0.06);

  // Forward scattering: looking toward the sun through haze goes warm and bright.
  vec3 viewDir = normalize(vpos);
  float sunAmount = max(dot(viewDir, normalize(sunDirView)), 0.0);
  vec3 fogCol = mix(fogColor, fogInscatter, pow(sunAmount, 6.0));

  color = mix(color, fogCol, fogAmount);

  // --- Exposure, highlight rolloff, tonemap.
  //
  // The rolloff sits AFTER the bloom add and the fog mix and BEFORE the fit,
  // because what pins at the ceiling is the composited value, not the scene
  // sample: a pane already at sanitize's ceiling picked up another 40% of a
  // blurred copy of itself here and left at a literal 255.
  color *= exposure;
  color = highlightRolloff(color);
  color = aces(color);

  // --- Display transfer function. THE THING THAT WAS MISSING.
  //
  // This composite is a RawShaderMaterial, so three.js substitutes no shader
  // chunks into it: renderer.outputColorSpace = SRGBColorSpace above configures a
  // <colorspace_fragment> that never runs here, and the byte written to the
  // 8-bit framebuffer was aces(radiance * exposure) with no encode at all. The
  // display then reads that byte as sRGB and applies a ~2.2 decode nobody
  // compensated for, so every value below the top of the range came out darker
  // than it was authored - and the deficit GROWS as values fall, because the
  // error is a power law and not an offset.
  //
  // The size of it, measured rather than argued (tools/transfer-audit.mjs --gamma):
  // noon's sky-lit facade and its sunlit road sat at ACES input 0.0796 and 0.4473,
  // 2.49 stops apart in radiance. At one stop, so only the encode differs, the old
  // chain put them 6.41:1 apart in code value and this one puts them 2.36:1 apart
  // - 1.076 display stops per scene stop against 0.498. Sunlit surfaces about
  // right, shaded surfaces two to three times too dark, from the encode alone.
  //
  // And it IS the encode, not the light: --shape normalises each frame's
  // scene-linear luminance by its own p90, which removes exposure, and the
  // engine's histogram already sat inside the matched photographs' - at noon p25
  // 0.142 against 0.102 and p50 0.454 against 0.297, i.e. a SHORTER dark tail
  // than the photographs have. There was no missing fill to find.
  //
  // Every camera stop, every bloom threshold and both fog clamps moved with this;
  // see src/daynight.js. Piecewise sRGB, identical to three's own
  // <colorspace_fragment>, so a future move back onto the built-in chunk is a
  // no-op rather than a re-grade.
  color = mix(1.055 * pow(max(color, vec3(0.0)), vec3(0.41666)) - vec3(0.055),
              color * 12.92,
              vec3(lessThanEqual(color, vec3(0.0031308))));

  // Wet streets read slightly cooler and more contrasted. It multiplies the
  // DISPLAY value and always has - before the encode above existed, the ACES
  // output WAS the display value - so it sits on this side of the transfer and
  // its strength is unchanged. Ahead of the encode the same numbers would be
  // divided by the curve's slope, about 2.4x in the toe, quietly turning a
  // shipped look parameter into a third of itself.
  color = mix(color, color * vec3(0.94, 0.98, 1.06), wetness * 0.35);

  // Ordered dither before the 8-bit write, and AFTER the encode: quantisation
  // happens in the encoded domain, so a dither applied before the transfer would
  // be stretched by its slope - 2.4x in the toe, where the banding actually is.
  // Phase 1's critic measured undithered sky banding in runs of 17-19 identical
  // pixels.
  float d = fract(dot(gl_FragCoord.xy, vec2(0.7548776662, 0.5698402909)));
  color += (d - 0.5) / 255.0;

  gl_FragColor = vec4(color, 1.0);
}`;

// --------------------------------------------------------------------- FXAA
//
// The second of the two anti-aliasing routes, kept because the choice between
// them is a measurement and not an opinion. This is FXAA in its short form
// (Lottes' console/"lite" path): one full-screen pass, five taps to decide
// whether a pixel sits on an edge and four more to blend along it.
//
// It runs AFTER the composite, on the tonemapped 8-bit image, because FXAA is a
// PERCEPTUAL filter: it thresholds on luma contrast. Pointed at the linear HDR
// target it would see a 60,000-nit sky against a 600-nit wall and call every
// pixel an edge.
//
// What it costs, stated plainly: it is a blur that cannot tell a silhouette from
// a one-pixel-wide piece of signage lettering, and it has no coverage
// information - it infers sub-pixel geometry from five luma samples. What it
// buys over MSAA is that it also softens SHADING aliasing (specular sparkle on
// wet asphalt, a hard normal-map edge), which no amount of geometric coverage
// touches.
//
// No backticks below. A backtick inside a GLSL comment ends this template
// literal, which has cost this project three separate debugging sessions.
const FXAA_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2 invResolution;
varying vec2 vUv;

const float EDGE_MIN   = 0.0312;      // 1/32 - absolute contrast floor
const float EDGE_MUL   = 0.125;       // 1/8  - contrast relative to local max
const float REDUCE_MIN = 0.0078125;   // 1/128
const float REDUCE_MUL = 0.125;       // 1/8
const float SPAN_MAX   = 8.0;         // texels of search along the edge

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 p = invResolution;
  // Named for where they actually are in UV space, where v increases UPWARD.
  // Transliterating the original NW/NE/SW/SE names, which assume v increases
  // downward, silently mirrors the blur direction on one axis and turns the
  // filter into a diagonal smear.
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;
  vec3 rgbLB = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * p).rgb;
  vec3 rgbRB = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * p).rgb;
  vec3 rgbLT = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * p).rgb;
  vec3 rgbRT = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * p).rgb;

  float lM = luma(rgbM);
  float lLB = luma(rgbLB), lRB = luma(rgbRB), lLT = luma(rgbLT), lRT = luma(rgbRT);
  float lMin = min(lM, min(min(lLB, lRB), min(lLT, lRT)));
  float lMax = max(lM, max(max(lLB, lRB), max(lLT, lRT)));

  // Local-contrast gate. Without it every flat surface gets a four-tap blur,
  // which is how FXAA earns its reputation for softening a whole frame.
  if (lMax - lMin < max(EDGE_MIN, lMax * EDGE_MUL)) {
    gl_FragColor = vec4(rgbM, 1.0);
    return;
  }

  // Luma gradient from the four corners, then blur along its perpendicular -
  // which is the edge. The filter is symmetric in dir, so its overall sign does
  // not matter; the RELATIVE sign of the two components does.
  float gx = (lRT + lRB) - (lLT + lLB);
  float gy = (lLT + lRT) - (lLB + lRB);
  vec2 dir = vec2(-gy, gx);

  float reduce = max((lLB + lRB + lLT + lRT) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * p;

  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv + dir * -0.5).rgb +
                                   texture2D(tDiffuse, vUv + dir *  0.5).rgb);
  // The wider pair can reach past the edge onto a third surface. If its luma
  // leaves the neighbourhood, fall back to the narrow pair.
  float lB = luma(rgbB);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}`;

export class PostStack {
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? true;
    this.bloomScale = opts.bloomScale ?? 0.5;   // bloom runs at half res

    // --- Anti-aliasing.
    //
    // The renderer is constructed with antialias: FALSE, and that is not a
    // regression. The flag only ever configured the DEFAULT framebuffer, and the
    // scene has not been drawn there since this file existed - it goes into
    // this.hdr, and the only thing that reaches the default framebuffer is a
    // fullscreen triangle with no interior edges to anti-alias. The request was
    // inert and every silhouette in every shipped frame was hard-stepped:
    // measured on docs/shots/play-fivepoints-golden.png, 38.0% of high-contrast
    // silhouette transitions completed in a single pixel with no intermediate
    // value at all (tools/aa-edges.mjs).
    //
    // Both routes live here, switchable at runtime through setAA(), because
    // which one to ship is a measurement and not an opinion:
    //
    //   'off'        what shipped before: no resolve anywhere.
    //   'msaa'       samples on the HDR target. Real geometric coverage, zero
    //                extra passes, zero extra draw calls.
    //   'fxaa'       one extra full-screen pass on the tonemapped image.
    //   'msaa+fxaa'  both.
    //
    // THE TRAP IN 'msaa', checked before committing to it rather than after:
    // this.hdr carries a depthTexture that the AO pass and the composite (height
    // fog, sky detection) sample as an ordinary texture, and a multisampled
    // target's depth attachment is a multisample renderbuffer that cannot be
    // sampled. It works here because this three build resolves depth as part of
    // the colour resolve - vendor/three.module.min.js blits with
    // resolveDepthBuffer && depthBuffer ? mask | DEPTH_BUFFER_BIT into the
    // single-sample framebuffer the depth texture is attached to, and
    // resolveDepthBuffer defaults to true. Verified on the rasteriser rather
    // than in the source alone by tools/aa-msaa-probe.mjs: with samples 4 and a
    // depthTexture, sampling that texture returns the same values as the
    // single-sample arm (centre 231, corner 248, GL error 0), and the same probe
    // shows those numbers MOVE when the geometry moves, so they are live.
    this.aaMode = opts.aa ?? 'msaa';
    this.msaaSamples = opts.msaaSamples ?? 4;

    // Tone mapping is ours now; the renderer must hand us linear HDR.
    //
    // outputColorSpace has never reached the pixel that reaches the screen, and
    // that is worth stating because it looks like it should. It only decides what
    // three's <colorspace_fragment> converts to, and that chunk reaches a material
    // two ways, neither of which applies here: the SCENE pass renders into
    // this.hdr, and a render target's own texture.colorSpace governs there - a
    // HalfFloatType target is linear, so the scene materials write linear, which
    // is what bloom needs; and the pass that DOES draw to the default framebuffer
    // is the composite below, a RawShaderMaterial, which gets no chunk
    // substitution at all. That is why the encode is written out by hand in
    // COMPOSITE_FRAG. Left set because it is still the correct declaration of what
    // this renderer puts on screen, and now it is also true.
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
      // Highlight rolloff, in EXPOSED units - see highlightRolloff() in
      // COMPOSITE_FRAG for the derivation. highlightCeil <= highlightKnee
      // disables it and restores the pre-rolloff chain, which is how a probe
      // builds its two arms without rebuilding the page.
      highlightKnee: 0.5,
      highlightCeil: 8.0,
      sunDirection: new THREE.Vector3(0, 1, 0),
      // ---------------------------------------------------------------- AO
      //
      // 0.6 m, exponent 8.5, full strength. Radius is in VIEW-SPACE METRES, so
      // this is a contact scale: it darkens where a wall meets pavement, under
      // kerbs and awnings and vehicles, and around a shoe, without putting an
      // apron round everything that stands up.
      //
      // It used to be 2.2 m, and the comment above it claimed 0.9. Measured off
      // the AO buffer itself with tools/ao-sweep.mjs -- one capture per
      // parameter set, subject present and subject removed, nothing else in the
      // world moving, and a repeat of the first parameter set at the end of
      // every sweep agreeing to four decimal places -- this is what 2.2 m was
      // doing and what 0.6 m does instead. All numbers are OCCLUSION, 1 - ao,
      // read off aoBlurRT; "bw" is one 0.41 m shoulder width.
      //
      //                                       2.2/3.8/0.95   0.6/8.5/1.00
      //   a standing figure's OWN darkening
      //   on the pavement beside its shoe        0.111          0.233
      //   ... three body widths out              0.061          0.070
      //   ... SIX body widths out                0.041          0.011
      //   ... last radius still over 0.05      8.5 bw         3.2 bw
      //   under the foot itself                  0.278          0.354
      //   a window reveal against the wall
      //   beside it, 0.16 m of built depth       0.068          0.067
      //   a wall's foot against the same wall
      //   2.2 m up                              -0.026          0.236
      //   pavement 0.12 m from a wall against
      //   pavement 1.8 m out                     0.096          0.016
      //   mean occlusion over the whole frame    0.264          0.240
      //
      // TWO BLIND REVIEWERS CALLED THE OLD SETTING "a soft fan roughly six times
      // his body width, with no edge and no direction". They were reading it
      // correctly and conservatively: at 2.2 m a figure was still putting 0.041
      // on the pavement six body widths away and did not fall under 0.05 until
      // 8.5. At 0.6 m that is 0.011 and 3.2, and the darkening right beside the
      // shoe has DOUBLED. Nothing about the contact was traded away to get it --
      // the foot reads 27% harder, because the exponent is where AO's contrast
      // lives and a tighter kernel can afford more of it.
      //
      // THE REVEAL DOES NOT PULL APART FROM THE HALO, which was the thing to
      // check: 0.067 against 0.068, a facade recess measured by raycasting the
      // built depth in src/facades.js rather than by choosing a screen box.
      //
      // ONE THING DOES GIVE WAY AND IT SHOULD BE ON THE RECORD. The broad
      // gradient along the foot of every wall -- pavement within 0.12 m of the
      // masonry against pavement 1.8 m out -- falls from 0.096 to 0.016. That
      // gradient is the halo again, drawn against a building instead of against
      // a person: a two-metre apron with no edge in it. What replaces it is
      // sharper and in the right place. The wall's own foot goes from 0.026
      // LIGHTER than the wall two metres up to 0.236 darker, so the junction
      // reads as a junction rather than as a smudge on the paving.
      //
      // Bias is unchanged. Strength is a fraction of the AO buffer in the
      // composite (mix(1.0, ao, aoStrength) below), so 1.00 is all of it and
      // there is nowhere above it to go; the contrast knob is the exponent.
      aoEnabled: true,
      aoStrength: 1.0,
      aoRadius: 0.6,
      aoBias: 0.035,
      aoIntensity: 8.5,
      // THE BUFFER THE KERNEL ABOVE IS DRAWN INTO. This is a separate question
      // from the kernel, and it was not re-asked when the radius moved.
      //
      // aoScale is the AO target's size as a fraction of the frame; aoBlurRadius
      // is the half-width, in AO texels, of the depth-aware blur that follows.
      // It used to be 0.5 and 2 -- a HALF-resolution buffer smoothed by a 5x5
      // kernel, so the smoothing reached +-4 SCREEN pixels and spanned 9. The
      // comment defending that said "full res buys very little AT THIS RADIUS",
      // and it was written when the radius was 2.2 m: at 2.2 m the AO feature is
      // metres wide and 9 pixels of smoothing is a rounding error. The radius is
      // 0.6 m now. The feature IS the contact band, and a prop's contact band at
      // the hero framing is a handful of pixels.
      //
      // MEASURED with tools/prop-ground.mjs, which renders every arm inside ONE
      // page.evaluate() so nothing in the world can move between them (the repeat
      // guard reads d=0.0000 on every quantity, not merely "within tolerance").
      // It samples the ground along the two rays the sun defines -- away from it,
      // where a shadow falls, and toward it as the control -- because the ring
      // average this replaced cannot see a directional shadow at all.
      //
      //   umbra = shadow-side base luma / same-ray luma 1.8-2.5 m out. Below 1
      //   the object is darkening the ground it stands on. Same ray, so exposure
      //   and albedo both cancel.
      //
      //                            0.5 / 2      1.0 / 2     1.0 / 1
      //     parked car   22.3 m     0.7764       0.7255      0.7099
      //     prop         18.8 m     0.8091       0.7995      0.8134
      //     prop         38.8 m     0.4323       0.3780      0.3477
      //     prop         19.4 m     0.7049       0.6965      0.7139   (2nd camera)
      //
      // Those were taken before the kerb work merged. RE-MEASURED on the tip
      // with the kerbs in, the same change is worth more, because a kerb is a
      // hard occluding edge at the pavement lip and that is precisely what a
      // half-resolution buffer was smearing across nine screen pixels:
      //
      //     parked car   22.3 m     0.7636       0.6794
      //     prop         18.8 m     0.7262       0.7157
      //     edge, parked car          11.6         17.1
      //
      //   edge = steepest 0.05 m step on the shadow side. "No umbra edge" is a
      //   statement about THIS number and nothing else in this file.
      //
      //     parked car   22.3 m       7.9         10.7        18.9
      //
      // 1.0 / 2 IS TAKEN AND 1.0 / 1 IS NOT, and the reason is the pedestrian
      // halo the previous round bought and this round was told not to spend.
      // tools/ao-sweep.mjs, same kernel, same camera, reading the AO buffer:
      //
      //                                     0.5 / 2   1.0 / 2   1.0 / 1
      //     last radius still over 0.05 ..     2.93      3.17      4.15   bw
      //     last radius still over 0.02 ..     7.56      7.80      8.05   bw
      //     darkening at 3 body widths        0.0479    0.0521    0.0603
      //     darkening at 6 body widths        0.0276    0.0272    0.0245
      //     foot occlusion under the shoe     0.7659    0.7941    0.7974
      //     prop @ 18.8 m contact rise        0.2187    0.2786    0.2977
      //
      // The previous round shipped its halo win as "last radius still over 0.05:
      // 8.5 bw -> 3.2 bw". 1.0 / 2 lands that number at 3.17 -- where that round
      // left it -- while 1.0 / 1 gives back 1.2 body widths of it. So the wider
      // kernel buys 85% of the prop gain for 20% of the halo cost, and the blur
      // width stays where it was. Only the resolution changes.
      //
      // Everything else moves the right way or not at all: foot contact 0.7659
      // -> 0.7941, window reveal contrast 0.1842 -> 0.1992, wall/pavement crease
      // 0.0533 -> 0.0504, frame mean occlusion 0.1317 -> 0.1231 (LESS blanket
      // AO, more of it in the right place), and all three of ao-sweep's prop
      // contacts improve.
      //
      // AND THE SHARPENING IS NOT GRAIN, which is the thing to disprove before
      // believing any of it: an unfiltered SSAO buffer is noisy, and a narrower
      // blur would raise `edge` just as convincingly if the tool were measuring
      // nothing but noise. tools/prop-ground-noise.mjs reads the MEAN step over
      // 1.8-2.5 m of the same ray -- open paving, where no contact term reaches,
      // so anything moving out there is grain. At the parked car it goes 2.39 ->
      // 2.25: the grain FALLS while the signal more than doubles, and signal over
      // grain goes 3.30 -> 8.41.
      //
      // WHICH KNOB IS DOING IT: the resolution, not the blur width. Narrowing
      // the blur at half res (0.5 / 1) is a slight NEGATIVE -- umbra 0.7764 ->
      // 0.7920 on the car -- because a half-res texel is already two screen
      // pixels and there is nothing left there to preserve. That is the
      // isolation that picks this parameter out of the two: one of them does
      // nothing on its own and the other does all of it.
      //
      // WHAT IT COSTS, as arithmetic rather than a timing on this box: no
      // geometry, no draw calls, no change to any other pass, and geom-audit's
      // prop counts identical to the unit. The AO passes' tap-pixel count goes
      // from 12*N/4 + 25*N/4 = 9.25N to 12*N + 25*N = 37N, i.e. 4x the pixel
      // work of two of the seven post passes and of nothing else.
      aoScale: 1.0,
      aoBlurRadius: 2,
      // ------------------------------------------------- THE ESTIMATOR ITSELF
      // Everything above this line is about WHERE the AO term goes. These four
      // are about how noisy it is when it gets there, which is the r8 review's
      // first-ranked defect and is a different question with different levers.
      // Each defaults to the r8 behaviour, so an arm that changes one of them is
      // a difference of one term. See AO_FRAG for the arithmetic and
      // tools/ao-noise.mjs for the measurements.
      //
      //   aoSamples     taps in the hemisphere. Variance falls as 1/N; the
      //                 quantisation STEP -- which is what pow() amplifies --
      //                 falls as 1/N too. Changing it recompiles the AO shader.
      //   aoKernel      0 = the twelve typed vectors, folded onto the normal's
      //                 side. 1 = a stratified golden-angle cosine hemisphere
      //                 built on a real tangent basis. Also recompiles.
      //   aoFalloff     metres of soft ramp on the occlusion test. 0 = the hard
      //                 step, which is what makes a 12-sample estimate take only
      //                 13 values.
      //   aoDither      0 = per-pixel hash rotation. N = an NxN interleaved tile
      //                 of fixed angles; at N = 5 the tile is exactly the 5x5
      //                 blur footprint, so the blur cancels the pattern instead
      //                 of averaging 25 random draws.
      //   aoDepthSigma  0 = the r8 blur weight on raw window depth. > 0 = a
      //                 relative tolerance on linearised depth.
      aoSamples: 12,
      aoKernel: 0,
      aoFalloff: 0,
      aoDither: 0,
      aoDepthSigma: 0,
    };

    const type = THREE.HalfFloatType;
    this.hdr = this._makeHdr(this._wantMsaa() ? this.msaaSamples : 0);

    const rtOpts = { type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    this.brightRT = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.blurB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    // AO is single-channel data, not colour. An 8-bit target is plenty and keeps
    // the bandwidth off the half-float budget.
    const aoOpts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, aoOpts);
    this.aoBlurRT = new THREE.WebGLRenderTarget(1, 1, aoOpts);
    // Where the composite lands when FXAA is on, so the filter has something to
    // read. LinearFilter is load-bearing: FXAA blends at sub-texel offsets, and
    // with NEAREST every one of those taps snaps back to the centre texel and
    // the pass becomes an expensive copy. Allocated lazily - an 'msaa' or 'off'
    // build never pays for it.
    this.ldrOpts = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.ldrRT = null;
    // Bound when AO is off. Sampling an unbound sampler2D is undefined behaviour
    // and on some drivers reads black, which would multiply the whole frame to
    // nothing rather than simply disabling the effect.
    this.whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.whiteTex.needsUpdate = true;

    const geo = fullscreenGeometry();
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.Camera();

    this.brightMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${BRIGHT_FRAG}`,
      uniforms: {
        tDiffuse: { value: null },
        threshold: { value: this.params.bloomThreshold },
        exposure: { value: this.params.exposure },
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
    this.aoMat = this._makeAoMat();
    this.aoBlurMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${AO_BLUR_FRAG}`,
      uniforms: {
        tAO: { value: null }, tDepth: { value: null },
        texelSize: { value: new THREE.Vector2() },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 1 },
        blurRadius: { value: this.params.aoBlurRadius },
        depthSigma: { value: this.params.aoDepthSigma },
      },
      depthTest: false, depthWrite: false,
    });
    this.compositeMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${COMPOSITE_FRAG}`,
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, tDepth: { value: null },
        tAO: { value: null }, aoStrength: { value: this.params.aoStrength },
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
        highlightKnee: { value: this.params.highlightKnee },
        highlightCeil: { value: this.params.highlightCeil },
        debugSanitize: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });

    this.fxaaMat = new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${FXAA_FRAG}`,
      uniforms: { tDiffuse: { value: null }, invResolution: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });

    this.quad = new THREE.Mesh(geo, this.brightMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this._sunView = new THREE.Vector3();
    // sceneCalls/sceneTriangles are the numbers the budget gate cares about.
    // renderer.info.render is per-render() and the composite blit would otherwise
    // overwrite the scene's counts with 1 call / 1 triangle.
    // The shadow pass was invisible to the budget gate for this project's whole
    // life. three.js does this, in WebGLRenderer.render:
    //
    //     beginShadows(); shadowMap.render(...); endShadows();
    //     this.info.autoReset === true && this.info.reset();
    //
    // - it counts every shadow-map draw call into info.render.calls and then
    // WIPES the counter before the opaque pass. Whatever we read afterwards
    // describes the colour pass only. Measured: enabling casters took the scene
    // from 84 to 331 caster meshes and the gate's draw-call number did not move
    // by one.
    //
    // Taking autoReset ourselves is the supported way out: reset once at the top
    // of render(), and info.render then accumulates shadows AND opaque. The read
    // still happens before the post blits, so those stay counted separately in
    // `passes` rather than smuggled into the geometry number.
    this.renderer.info.autoReset = false;
    this.stats = { passes: 0, drawCalls: 0, shadowMapEnabled: false,
                   sceneTriangles: 0, totalCalls: 0 };
  }

  /**
   * The AO material, built for the CURRENT sample count and kernel.
   *
   * Sample count and kernel shape are compile-time in GLSL ES 1.0 -- a loop
   * bound has to be constant and the legacy path needs a fixed-size array -- so
   * sweeping them means rebuilding the program. _syncAoProgram() below does that
   * only when one of the two actually changes, which is never during play and
   * once per arm under a sweep. Everything else about the pass is a uniform.
   */
  _makeAoMat() {
    const p = this.params;
    // THE LEGACY KERNEL IS TWELVE TYPED VECTORS AND CANNOT BE ASKED FOR
    // THIRTEEN. An arm that raised aoSamples while leaving aoKernel at 0 would
    // index kernel[12..N] out of bounds -- undefined in GLSL ES, and on
    // SwiftShader it returns something rather than failing, so the arm would
    // have produced numbers that looked like measurements. The count is forced
    // back to 12 there. Buying more samples means changing the kernel, which is
    // a finding and not a limitation: the old kernel IS its twelve vectors.
    const samples = p.aoKernel ? Math.max(1, Math.round(p.aoSamples)) : 12;
    this._aoBuilt = { samples: p.aoSamples, kernel: p.aoKernel };
    this.aoEffectiveSamples = samples;
    return new THREE.RawShaderMaterial({
      vertexShader: `precision highp float; attribute vec3 position; attribute vec2 uv; ${FULLSCREEN_VERT}`,
      fragmentShader: `precision highp float; ${AO_FRAG(samples, Math.round(p.aoKernel) | 0)}`,
      uniforms: {
        tDepth: { value: null },
        invProjection: { value: new THREE.Matrix4() },
        projection: { value: new THREE.Matrix4() },
        texelSize: { value: new THREE.Vector2() },
        radius: { value: p.aoRadius },
        bias: { value: p.aoBias },
        intensity: { value: p.aoIntensity },
        falloff: { value: p.aoFalloff },
        dither: { value: p.aoDither },
        cameraFar: { value: 1 },
      },
      depthTest: false, depthWrite: false,
    });
  }

  _syncAoProgram() {
    const p = this.params, b = this._aoBuilt;
    if (b && b.samples === p.aoSamples && b.kernel === p.aoKernel) return;
    const old = this.aoMat;
    this.aoMat = this._makeAoMat();
    if (old) old.dispose();
  }

  _wantMsaa() { return this.aaMode === 'msaa' || this.aaMode === 'msaa+fxaa'; }

  _wantFxaa() { return this.aaMode === 'fxaa' || this.aaMode === 'msaa+fxaa'; }

  _makeHdr(samples) {
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
      samples,
    });
    rt.depthTexture = new THREE.DepthTexture(1, 1);
    rt.depthTexture.type = THREE.UnsignedIntType;
    return rt;
  }

  /**
   * Switch anti-aliasing at runtime: 'off' | 'msaa' | 'fxaa' | 'msaa+fxaa'.
   * Returns the state it actually reached, so a harness can ASSERT the toggle
   * took rather than assume it. (This session already had an A/B whose two arms
   * were secretly identical because the switch never ran.)
   */
  setAA(mode) {
    const valid = ['off', 'msaa', 'fxaa', 'msaa+fxaa'];
    if (!valid.includes(mode)) throw new Error(`unknown AA mode ${mode}`);
    const before = this.hdr.samples;
    this.aaMode = mode;
    const want = this._wantMsaa() ? this.msaaSamples : 0;
    if (want !== before) {
      // The sample count is fixed when three allocates the framebuffer, so the
      // target is rebuilt rather than mutated. Cheap: only harnesses switch.
      const old = this.hdr;
      this.hdr = this._makeHdr(want);
      old.dispose();
      if (this._size) this.setSize(this._size[0], this._size[1]);
    }
    if (this._wantFxaa() && !this.ldrRT) {
      this.ldrRT = new THREE.WebGLRenderTarget(1, 1, this.ldrOpts);
      if (this._size) this.setSize(this._size[0], this._size[1]);
    }
    return this.aaState();
  }

  aaState() {
    return {
      mode: this.aaMode,
      // Read back off the render target, not off the requested value: this is
      // what the GPU was actually asked for.
      samples: this.hdr.samples,
      fxaaPass: this._wantFxaa(),
      rendererAntialias: this.renderer.getContext().getContextAttributes().antialias,
      width: this.hdr.width, height: this.hdr.height,
    };
  }

  setSize(width, height) {
    this._size = [width, height];
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    this.hdr.setSize(w, h);
    this.hdr.depthTexture.image.width = w;
    this.hdr.depthTexture.image.height = h;
    if (this.ldrRT) this.ldrRT.setSize(w, h);
    const bw = Math.max(1, Math.floor(w * this.bloomScale));
    const bh = Math.max(1, Math.floor(h * this.bloomScale));
    this.brightRT.setSize(bw, bh);
    this.blurA.setSize(bw, bh);
    this.blurB.setSize(bw, bh);
    // AO buffer scale. See params.aoScale.
    const s = this.params.aoScale;
    const aw = Math.max(1, Math.floor(w * s));
    const ah = Math.max(1, Math.floor(h * s));
    this.aoRT.setSize(aw, ah);
    this.aoBlurRT.setSize(aw, ah);
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
    // We own the counter now (see the constructor). Reset before anything draws,
    // so what we read below is shadow pass + opaque pass and nothing else.
    r.info.reset();
    this.stats.shadowMapEnabled = r.shadowMap.enabled;
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this.stats.drawCalls = r.info.render.calls;
      this.stats.sceneTriangles = r.info.render.triangles;
      this.stats.passes = 0;
      this.stats.totalCalls = this.stats.drawCalls;
      return;
    }
    this.stats.passes = 0;

    r.setRenderTarget(this.hdr);
    r.clear();
    r.render(this.scene, this.camera);
    // Read BEFORE the blits below, which would otherwise fold full-screen quads
    // into a number the gate reads as scene geometry.
    this.stats.drawCalls = r.info.render.calls;
    this.stats.sceneTriangles = r.info.render.triangles;

    // Bright pass at half res.
    this.brightMat.uniforms.tDiffuse.value = this.hdr.texture;
    this.brightMat.uniforms.threshold.value = this.params.bloomThreshold;
    this.brightMat.uniforms.exposure.value = this.params.exposure;
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

    // --- AO into its own target, then a depth-aware blur. The target is frame
    // sized (params.aoScale 1.0); it was half sized until props stopped
    // grounding, and the note on params.aoScale is the measurement that moved it.
    if (this.params.aoEnabled) {
      this._syncAoProgram();
      const au = this.aoMat.uniforms;
      au.tDepth.value = this.hdr.depthTexture;
      au.invProjection.value.copy(this.camera.projectionMatrixInverse);
      au.projection.value.copy(this.camera.projectionMatrix);
      au.texelSize.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      au.radius.value = this.params.aoRadius;
      au.bias.value = this.params.aoBias;
      au.intensity.value = this.params.aoIntensity;
      au.falloff.value = this.params.aoFalloff;
      au.dither.value = this.params.aoDither;
      au.cameraFar.value = this.camera.far;
      this._blit(this.aoMat, this.aoRT);

      const bu = this.aoBlurMat.uniforms;
      bu.tAO.value = this.aoRT.texture;
      bu.tDepth.value = this.hdr.depthTexture;
      bu.texelSize.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      bu.cameraNear.value = this.camera.near;
      bu.cameraFar.value = this.camera.far;
      bu.blurRadius.value = this.params.aoBlurRadius;
      bu.depthSigma.value = this.params.aoDepthSigma;
      this._blit(this.aoBlurMat, this.aoBlurRT);
    }

    // Composite.
    const u = this.compositeMat.uniforms;
    const p = this.params;
    u.tScene.value = this.hdr.texture;
    u.tBloom.value = this.blurB.texture;
    u.tDepth.value = this.hdr.depthTexture;
    u.tAO.value = p.aoEnabled ? this.aoBlurRT.texture : this.whiteTex;
    u.aoStrength.value = p.aoEnabled ? p.aoStrength : 0;
    u.bloomStrength.value = p.bloomStrength;
    u.exposure.value = p.exposure;
    u.fogColor.value.set(p.fogColor.r, p.fogColor.g, p.fogColor.b);
    u.fogInscatter.value.set(p.fogInscatter.r, p.fogInscatter.g, p.fogInscatter.b);
    u.fogDensity.value = p.fogDensity;
    u.fogHeightFalloff.value = p.fogHeightFalloff;
    u.fogHeightRef.value = p.fogHeightRef;
    u.wetness.value = p.wetness;
    u.highlightKnee.value = p.highlightKnee;
    u.highlightCeil.value = p.highlightCeil;
    // Driven from params like everything else here, so a harness sets it through
    // postParams() and no future refactor of this block can silently strand it.
    u.debugSanitize.value = p.debugSanitize ? 1 : 0;
    u.cameraY.value = this.camera.position.y;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.invProjection.value.copy(this.camera.projectionMatrixInverse);
    // Sun direction has to reach the shader in view space or the inscatter lobe
    // swings around as the camera turns.
    this._sunView.copy(p.sunDirection).transformDirection(this.camera.matrixWorldInverse);
    u.sunDirView.value.copy(this._sunView);

    // With FXAA the composite lands in an 8-bit target and the filter writes the
    // frame; without it the composite writes the frame directly and there is no
    // extra pass to pay for. Bloom and height fog are upstream of this and are
    // untouched either way.
    if (this._wantFxaa()) {
      if (!this.ldrRT) {
        this.ldrRT = new THREE.WebGLRenderTarget(1, 1, this.ldrOpts);
        if (this._size) this.setSize(this._size[0], this._size[1]);
      }
      this._blit(this.compositeMat, this.ldrRT);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture;
      this.fxaaMat.uniforms.invResolution.value.set(1 / this.ldrRT.width, 1 / this.ldrRT.height);
      this._blit(this.fxaaMat, null);
    } else {
      this._blit(this.compositeMat, null);
    }
    this.stats.totalCalls = this.stats.drawCalls + this.stats.passes;
  }

  dispose() {
    for (const t of [this.hdr, this.brightRT, this.blurA, this.blurB,
                     this.aoRT, this.aoBlurRT, this.ldrRT]) { if (t) t.dispose(); }
    for (const m of [this.brightMat, this.blurMat, this.compositeMat,
                     this.aoMat, this.aoBlurMat, this.fxaaMat]) m.dispose();
    this.whiteTex.dispose();
  }
}
