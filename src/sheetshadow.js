// A SHEET WITH NO THICKNESS IN THE SUN'S MAP — #141, round 2.
//
// three's PCF pass draws a FrontSide material's BACK faces into the sun's map. Over a closed body that
// is what made bias 0 safe (#141): the map holds the face a body's thickness BEHIND the lit one, a car's
// floor pan 0.19 m under its roof. A shop awning is not closed. src/signage.js builds its barrel as a
// top sheet and an underside on the SAME vertices, its valance as a front and a back on the same four,
// and a street-name blade lettered on both faces the same way, so what the map holds over a lit sheet
// is that sheet's own twin at its own depth. Nothing separates them but normalBias, and three's
// PCF_SOFT reads the map well away from the lookup:
//
//     sixteen texel centres, four a row at -1-f, -f, 1-f and 2-f texels, the outer two weighted 1-f and
//     f by the lookup's sub-texel phase: 2 texels along an axis, 2.8 on a diagonal at a weight that
//     vanishes there
//
// where the depth of a plane tilted theta from the sun has moved by that many texels times tan(theta).
// normalBias stands nb / cos(theta) of it. tools/shadow-floor.mjs runs those taps and finds that a twin
// under 1.52 texels of slope behind its sheet costs it over 0.15 of the sun at some phase (a third at 1
// texel, 0.04 at 2), and at bias 0 / nb 0.06 that is every sheet tilted more than 19.7 degrees from the
// sun: the reviewer's 4 px diagonal stripes on sun-facing awning tops and valances at noon (#141's
// blind review: stripe energy x2.66 and x3.11 in their boxes, valances 4-13% darker). Measured with
// tools/shadow-bias.mjs at fivepoints noon against a 4096-texel map over +-40 m: of the shop signage the
// reference has lit, 80.3% loses over 0.15 of its sun at bias 0, against 10.1% under the old 0.54 m
// constant — and 10.1% is the old constant's floor, the 2048 map's softer edges, not acne.
//
// THE LEVER IS THE TWIN'S DEPTH, ALONG THE SUN'S RAY, AND ONLY ON THE SIGNAGE. One term at a time, at
// that camera, each family's own pixels, against the reference (partial acne: lit there and losing over
// 0.15 of the sun here; leak: dark there and over half lit here; stripes: the reviewer's statistic on
// Marrow & Vine's fabric where it is flat in the unshadowed frame, over the BEFORE build's). Two page
// loads, the receiver and normal rows in one and the rest in the other; the rows both carry agree to a
// pixel:
//
//     arm                                  signage acne   signage leak   facade leak   ground leak   stripes
//     bias 0 / nb 0.06, round 1               80.3%           147            121            644        x2.93
//     the old constant, 0.54 m                10.1%           168          1,127          3,260        x1.00
//     receiver: + 0.12 m normal offset         2.2%           830            122            645        x1.08
//     receiver: slope-scaled, 2 texels         2.0%         1,134            122            645        x0.93
//     caster: twin moved 0.12 m on its normal 10.2%           153            121          1,751        x1.09
//     caster: twin pushed along the RAY        10.3%           151            122            644        x1.00   <- this
//
// Every RECEIVER lever peter-pans whatever the signage receives: a shadow falling on an awning from its
// neighbour or from the building lets go near its caster, 6-8x the leak. Moving the twin along its own
// NORMAL moves its EDGE, so the awning's shadow on the pavement shrank by the offset (ground leak x2.7).
// Pushing it along the sun's ray leaves its (u, v) in the map exactly where it was — the silhouette, so
// every shadow the sign casts keeps its shape — and changes only the depth a receiver is compared with.
// It reaches the old constant's floor on the signage and costs nothing anywhere else.
//
// HOW FAR, AND WHERE IT STOPS. The push is SHEET_TEXELS of slope, less what normalBias already stands:
//
//     max(0, SHEET_TEXELS * texel * tan(theta) - nb / cos(theta))        metres along the sun's ray
//
// 2 texels, the kernel's reach along an axis, over the 1.52 the gate derives for the census's 0.15 line.
// It is ZERO for a face within 14.8 degrees of the light: the underside of a fascia or a parapet cap at
// noon is not moved at all, so the shadow attached into the gap under it — what the same reviewer
// preferred in #141's build — stays attached. theta is clamped where the sun lights a quarter of its beam
// (SHEET_COS, tools/shadow-floor.mjs's ACNE_COS), because past that a sheet's acne cannot be seen and the
// tangent would only grow: 0.67 m at most. Measured one value at a time at fivepoints noon: 1 texel ->
// 13.2% of the lit signage, 1.5 -> 11.9%, 2 -> 10.3%, against the 10.1% floor; the reviewer's boxes read
// the BEFORE build's stripe energy exactly from 1 up.
//
// NOT THE FACADE TRIM. Its awning kit is the same double sheet and is not built on the shipped path
// (src/facades.js builds it only for a caller that passes `awnings: true`, which no shipped caller does),
// so the trim's acne at bias 0 is its thin closed pieces, which the old constant hid by detaching them.
// The same push on the whole trim mesh buys it little — 12.2% -> 11.2% at 2 texels — and costs 765 px of
// leak against 116, a lit line along the foot of a shopfront. The trim stays as round 1 left it.
//
// The depth material is the only seam three offers: the PCF pass packs depth from a varying computed
// off gl_Position, so polygonOffset moves the depth TEST and not the stored value, and a per-object
// customDepthMaterial is how a family gets its own. It runs only in the sun's pass — every other light
// here is a PointLight with no map.
import * as THREE from '../vendor/three.module.min.js';
import { SUN_SHADOW } from './daynight.js';

/** Texels of depth slope a lit sheet stands in front of its twin: the PCF_SOFT kernel's reach along an axis. */
export const SHEET_TEXELS = 2;
/** The angle the push stops growing at: where the sun lights a quarter of its beam. */
export const SHEET_COS = 0.25;

/**
 * THE PUSH, WRITTEN ONCE. The shader compiles these two expressions and sheetDepthOffset() evaluates the
 * same two strings, so tools/shadow-floor.mjs reads the arithmetic the GPU runs rather than a copy of it:
 *
 *   c      the cosine between the face and the sun, clamped where the sun lights a quarter of its beam
 *   push   metres along the sun's ray: K texels of slope, less what normalBias already stands
 */
export const SHEET_COS_EXPR = 'clamp( abs( n ), cosMin, 1.0 )';
export const SHEET_PUSH_EXPR = 'max( 0.0, K * texel * sqrt( 1.0 - c * c ) / c - nb / c )';

const jsOf = (expr) => new Function('clamp', 'abs', 'max', 'sqrt', 'n', 'cosMin', 'K', 'texel', 'c', 'nb', `return ${expr};`);
const _cosJs = jsOf(SHEET_COS_EXPR), _pushJs = jsOf(SHEET_PUSH_EXPR);
const _clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The push for a face whose normal is `cos` from the light, in metres along the ray. */
export function sheetDepthOffset(cos, texel, nb = SUN_SHADOW.normalBias, K = SHEET_TEXELS, clampCos = SHEET_COS) {
  const c = _cosJs(_clamp, Math.abs, Math.max, Math.sqrt, cos, clampCos, K, texel, 0, nb);
  return _pushJs(_clamp, Math.abs, Math.max, Math.sqrt, cos, clampCos, K, texel, c, nb);
}

/** The seam, asserted: an injection that matched nothing would ship the round-1 map and say nothing. */
export const SHEET_SEAM = '#include <project_vertex>';
const glslOf = (expr) => expr.replace(/\bn\b/g, 'sheetN.z').replace(/\bcosMin\b/g, 'uSheetCos').replace(/\bK\b/g, 'uSheetK')
  .replace(/\btexel\b/g, 'sheetTexel').replace(/\bc\b/g, 'sheetC').replace(/\bnb\b/g, 'uSheetNB');
/** What goes after it. In the light's own view space the ray is -z, so this moves depth and nothing else. */
export const SHEET_GLSL = [
  '\t{',
  '\t\tvec3 sheetN = normalize( mat3( modelViewMatrix ) * normal );',
  `\t\tfloat sheetC = ${glslOf(SHEET_COS_EXPR)};`,
  // An orthographic camera's projectionMatrix[ 0 ][ 0 ] is 2 / (right - left).
  '\t\tfloat sheetTexel = 2.0 / ( projectionMatrix[ 0 ][ 0 ] * uSheetMap );',
  `\t\tmvPosition.z -= ${glslOf(SHEET_PUSH_EXPR)};`,
  '\t\tgl_Position = projectionMatrix * mvPosition;',
  '\t}',
].join('\n');

let _material = null;
/**
 * The one depth material every sheet-carrying mesh casts with. Its uniforms are on `userData.sheet`, so
 * a probe can set K to 0 and read the round-1 map on the same page.
 */
export function sheetDepthMaterial() {
  if (_material) return _material;
  const uniforms = {
    uSheetK: { value: SHEET_TEXELS },
    uSheetCos: { value: SHEET_COS },
    uSheetNB: { value: SUN_SHADOW.normalBias },
    uSheetMap: { value: SUN_SHADOW.mapSize },
  };
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.name = 'sheetDepth';
  m.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes(SHEET_SEAM)) throw new Error(`sheet depth: no "${SHEET_SEAM}" in the depth shader`);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = Object.keys(uniforms).map((k) => `uniform float ${k};`).join('\n') + '\n' +
      shader.vertexShader.replace(SHEET_SEAM, `${SHEET_SEAM}\n${SHEET_GLSL}`);
  };
  m.customProgramCacheKey = () => 'sheetDepth:1';
  m.userData.sheet = { uniforms };
  _material = m;
  return m;
}

/** Cast `mesh` into the sun's map as sheets. Returns the mesh, so it reads inline where a mesh is made. */
export function castAsSheet(mesh) {
  if (mesh) mesh.customDepthMaterial = sheetDepthMaterial();
  return mesh;
}
