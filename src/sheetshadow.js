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
// normalBias stands nb / cos(theta) of it. tools/shadow-floor.mjs runs those taps: a twin under 1.52
// texels of slope behind its sheet costs it over 0.15 of the sun at some phase (a third at 1 texel,
// 0.16 at 1.5, 0.04 at 2, 0.006 at 2.5, nothing past 2.83), and at bias 0 / nb 0.06 that is every sheet
// tilted more than 19.7 degrees from the sun: the reviewer's 4 px diagonal stripes on sun-facing awning
// tops and valances at noon (#141's blind review: stripe energy x2.66 and x3.11 in their boxes,
// valances 4-13% darker).
//
// THE LEVER IS THE TWIN'S DEPTH, ALONG THE SUN'S RAY, AND ONLY ON THE SIGNAGE. tools/shadow-bias.mjs at
// noon, one page load a camera, each arm one term, against a 4096-texel map over +-40 m that carries this
// same rule at its own texel and offsets (a reference with no push has sheet acne of its own, and read
// every arm 4-6 points clean). Acne: of the shop signage the reference has lit, the share losing over
// 0.15 of its sun; leak: dark there and over half lit here; stripes: the reviewer's statistic on the
// fabric that is flat in the unshadowed frame, over the BEFORE build's. Fivepoints:
//
//     arm                                 signage acne   signage leak   furniture leak   stripes (M&V)
//     bias 0 / nb 0.06, round 1              90.6%           147             157            x2.94
//     the old constant, 0.54 m               14.0%           168             566            x1.00
//     receiver: + 0.12 m normal offset        3.1%           830             157            x1.08
//     receiver: slope-scaled, 2 texels        2.7%         1,134             157            x0.93
//     caster: pushed along the RAY, 2        16.0%           151             157            x1.00
//     caster: pushed along the RAY, 2.5      14.3%           151             158            x1.00   <- SHIPPED
//
// and at the corridor (Tinsmith's stripes x2.32 in round 1, x1.00 from 1.5 texels up), the acne goes
// 67.0% round 1, 19.7% at 1.5 texels, 11.1% at 2, 5.3% at 2.5 and 3, against the old constant's 5.3%,
// for 41 px of furniture leak: a 4 px strip beside one street-sign post at the frame's edge.
//
// Every RECEIVER lever peter-pans whatever the signage receives: a shadow falling on an awning from its
// neighbour or from the building lets go near its caster, 6-8x the leak. Moving the twin along its own
// NORMAL (0.12 m, measured against an unpushed reference: 10.2% acne) moves its EDGE, and the awning's
// shadow on the pavement shrank by the offset — ground leak 645 -> 1,751. Pushing it along the sun's ray
// leaves its (u, v) in the map exactly where it was — the silhouette, so every shadow the sign casts
// keeps its shape — and changes only the depth a receiver is compared with.
//
// HOW FAR, AND WHERE IT STOPS. The push is SHEET_TEXELS of slope, less what normalBias already stands:
//
//     max(0, SHEET_TEXELS * texel * tan(theta) - nb / cos(theta))        metres along the sun's ray
//
// 2.5 texels, measured: the smallest push at which the lit signage reaches the old constant's level at
// both cameras, 3 adding nothing; past the 1.52 the gate derives for the census's 0.15 line, and where
// the kernel's worst loss is 0.006. It is ZERO for a face within 11.8 degrees of the light, and a
// horizontal underside at noon (14.4 degrees) moves 1.3 cm: the shadow attached into the gap under a
// fascia or a parapet cap — what the same reviewer preferred in #141's build — stays attached. theta is
// clamped where the sun lights a quarter of its beam (SHEET_COS, tools/shadow-floor.mjs's ACNE_COS),
// because past that a sheet's acne cannot be seen and the tangent would only grow: 0.89 m at most.
// Clamping at 0.15 or 0.1 instead moves nothing at either camera (measured at 2 texels).
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

/** Texels of depth slope a lit sheet stands in front of its twin: measured, see the header. */
export const SHEET_TEXELS = 2.5;
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
