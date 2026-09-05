// Time-of-day in real photometric units.
//
// Phase 1 shipped a street lamp at intensity 26 that lit nothing, because the
// number was picked by eye rather than from a unit. Everything here carries its
// unit in the name, and exposure moves with the light level the way a camera's
// auto-exposure does — so "looks right" and "is physically sane" stop competing.
//
//   DirectionalLight.intensity -> lux (illuminance on a surface facing the sun)
//   PointLight.intensity       -> candela (luminous intensity)
//   HemisphereLight.intensity  -> lux (sky illuminance), and ZERO whenever a sky
//                                 dome's PMREM is in the scene: that map already
//                                 carries this sky, and carrying it twice is what
//                                 flattened golden hour. See the constructor.

import * as THREE from '../vendor/three.module.min.js';

// EVERY EXPOSURE BELOW WAS RE-DERIVED WHEN THE SKY STOPPED BEING DELIVERED TWICE.
//
// The rule this file uses is exposure = pi/E: an 18% grey card under a total
// horizontal illuminance E sits at E*0.18/pi nits, so pi/E puts it back on 0.18.
// Only `golden` was ever authored strictly to that rule - noon, dusk and night
// each carry a deliberate offset from it, and re-deriving them from the rule now
// would re-grade three presets for a reason that has nothing to do with this
// change. So each stop moves by exactly the factor its OWN horizontal illuminance
// moved by, which is what an auto-exposure does and what this change warrants:
//
//     exposure_new = exposure_old * E_before / E_after
//
// E_before is measured, not computed: tools/sky-once.mjs parks an albedo-1,
// roughness-1 patch face-up in front of the corridor hero camera on a settled
// scene and reads pi * its radiance out of the HDR scene target, which is lux.
// It is everything reaching that patch - sun, HemisphereLight, PMREM and, where
// they are lit, the street lamps.
//
// The term subtracted from it is the CLOSED FORM, intensity * luminance(skyColor),
// which is what three.js puts on an up-facing normal by construction. The meter
// reproduces that to 0.0% at noon, golden and dusk, so this is not a shortcut -
// it is the more accurate of two agreeing numbers, and it is the only correct one
// at night, where the hemisphere-only frame still contains the street lamps
// (0.3 lux of them, against 0.008 lux of hemisphere).
//
//   preset  E_before   HemisphereLight    E_after    factor   stop
//   noon       119,851 lux     13,075 (10.91%)    106,775 lux  1.1225   1/78,000 -> 1/69,490
//              ^ SUPERSEDED. Moving noon's stop by a ratio preserved an offset that
//                had never been derived from anything, and it rendered the brightest
//                hour of the day darker than night: frame mean 23.8 against night's
//                30.8, sky-lit facades on 2.1 of 255 against night's 21.7. The stop
//                is now derived rather than carried - see the preset.
//   golden      17,971 lux      5,548 (30.87%)     12,423 lux  1.4466   1/6,006 -> 1/4,152
//   dusk         1,764 lux        355 (20.12%)      1,409 lux  1.2518   1/900 -> 1/719
//   night       0.7000 lux     0.0080 (1.14%)     0.6920 lux  1.0116   1/1.15 -> 1/1.15 (left alone, see below)
//
// The frame does not get brighter. An 18% card sits where it sat; what moves is
// the SPLIT, because the term that was removed was fill and the sun was not:
//   noon    the sun goes from 76.6% of the light on the road to 86.0%
//   golden  the sun goes from 28.2% of the light on the road to 40.8%
//   dusk    the sun goes from 1.6% of the light on the road to 2.0%
//   night   the sun goes from 28.6% of the light on the road to 28.9%
//
// The meter's patch is a MeshStandardMaterial and keeps its dielectric lobe, so
// its sun term runs a few percent over the illuminance; that bias is identical in
// E_before and E_after and very nearly cancels in the ratio, which is a second
// reason to move the stop by a ratio rather than to re-derive it from pi/E.

export const PRESETS = {
  noon: {
    label: 'Noon',
    sunLux: 100000,           // clear-sky direct normal illuminance
    skyLux: 20000,            // diffuse sky component
    elevation: 1.32, azimuth: 0.6,
    sunColor: 0xfff6e8, skyColor: 0xbcd6f5, groundColor: 0x6b6455,
    // THE STOP NOON WAS EXPOSED AT WAS AN INHERITED CONSTANT, NOT A DERIVATION,
    // AND IT RENDERED THE BRIGHTEST HOUR OF THE DAY DARKER THAN NIGHT.
    //
    // What was here: "1/78,000 becomes 1/69,490 ... noon has always been authored
    // well under pi/E and stays exactly as far under it." Every other preset's stop
    // was re-derived from the light; this one only ever moved by the ratio its
    // illuminance moved by, carrying an offset nobody had re-examined since it was
    // first typed. Measured at the corridor camera on the build that shipped it
    // (tools/daynight-sweep.mjs, tools/tod-readability.mjs, docs/shots/tod-*.png):
    //
    //   preset  frame mean  below 16/255   sky region   sky-lit facade   stop
    //   noon        23.8       42.5%          39.6           2.1        1/69,490
    //   golden     130.6        3.9%         194.1          35.4        1/4,152
    //   dusk       112.1        3.0%         206.4          62.7        1/719
    //   night       30.8       42.8%          49.4          21.7        1/1.15
    //
    // Noon's frame mean sat BELOW night's and its sky-lit facades a tenth of
    // night's. The sky's own audit says the same thing in one number: mid-sky
    // renders at 0.107 x ACES saturation at noon against 0.811 at golden, 0.806 at
    // dusk and 0.078 at NIGHT - a noon sky less than half a stop brighter than a
    // NIGHT sky, in the units the frame is actually built in.
    //
    // IT IS THE STOP, NOT THE LIGHT, AND THAT WAS MEASURED RATHER THAN ASSUMED.
    // Inverting the tonemap on those same frames recovers the radiance behind each
    // pixel, and the sky-lit facade carries 1,100 nits at noon against 445 at
    // golden - 2.5x MORE light, rendering 17x darker. The sky delivers 15,156 lux
    // here against golden's 8,519, so the ambient is the strongest of any daytime
    // preset, not the weakest; and sun 92,998 lux direct normal with 15,156 lux of
    // diffuse is a 14.4% diffuse fraction, which is a physically correct clear noon
    // and sits mid-envelope. Nothing about the light is wrong.
    //
    // THE RULE, AND THE ONE CORRECTION IT NEEDS IN THIS RENDERER.
    // exposure = pi/E puts an 18% grey card on 0.18 in ACES input. E here is
    // 92,997.73 * sin(1.32) + 15,156 = 105,244 lux measured, so the rule says
    // 1/33,501. That is +1.05 stops on what was here, and it is still not enough:
    // rendered, it leaves the frame at mean 56.6 with 25.1% below 16/255 and the
    // sky-lit facade on 6.3. The reason is measurable and is not the shoulder -
    // src/post.js's composite is a RawShaderMaterial with no <colorspace_fragment>,
    // so the byte in the frame IS aces(radiance * exposure) with no display
    // transfer function on the way out, and aces(0.18) is 68/255, not 118/255. A
    // surface 2.7 stops under the card - which is exactly what a sky-lit facade is
    // under a 75.6 deg sun, 105,244 lux of ground against ~17,000 on a shaded wall -
    // therefore lands in the TOE, not the shoulder. Measured on the frames above:
    // noon's shaded facade sat at 0.0158 in ACES input, where aces(x)/x is 0.46, and
    // golden's sits at 0.107, where it is 1.29 - so the same 2.5x more light was
    // handed a 2.8x weaker curve on top of a 16.7x tighter stop. Golden escapes this
    // because its 8 deg sun leaves its shaded wall only 0.8 stops under ITS card.
    //
    // So the offset from pi/E is +1.26 stops and it is sized by an acceptance test,
    // stated here because it is a trade and not a rule: at the corridor camera the
    // sky-lit facade must clear 20/255 so material is visible, no more than 10% of
    // the frame may sit below 16/255, and nothing may clip. Rendered at four
    // candidate stops (tools/tod-stop-sweep.mjs, docs/shots/stop-noon-*.png),
    // 1/20,000 leaves the facade on 14.4 with 13.6% crushed, 1/16,000 reaches 19.8
    // and 9.9% - on the line - and 1/11,500 passes but the far field has climbed to
    // 0.756 of the fog clamp and the sky has gone milky. 1/14,000 clears both with
    // margin, and this is the shipped sweep frame rather than a candidate: frame
    // mean 114.0, sky-lit facade 23.8, 7.9% below 16/255, 2.9% below 8, 0% clipped,
    // against 23.8 / 2.1 / 42.5% / 28.7% / 0% before. mid-sky goes 0.107 -> 0.532,
    // beside golden's 0.811 and dusk's 0.806 instead of beside night's 0.078.
    //
    // WHAT THIS DOES NOT DO. It does not flatten noon. Exposure cannot: the
    // sunlit-to-shaded ILLUMINANCE ratio is 105,244:17,000 = 6.2:1 and is untouched
    // by the stop. What moves is where that ratio sits on the curve, and it sits
    // further apart, not closer - sunlit plaza against sky-lit facade goes from 27
    // display units of separation to 121. Noon keeps its hard shadows. The audit is
    // untouched either side of the change: sun 92,997.73 lux delivered, sky 15,156
    // over 1 path, 0 lamps lit, no flags - and the radiance behind every measured
    // region is the same to within the traffic moving through frame (sky 8,067 ->
    // 8,064 nits, sky-lit facade 1,100 -> 1,115, road 6,245 -> 6,262). Only the
    // camera moved.
    //
    // The elevation is NOT touched. PROGRESS.md's remedy for noon's weak wall-to-
    // wall separation - a 75.6 deg sun puts cos(75.6) = 0.25 of the beam on a
    // facade turned toward it - is to lower the elevation, and that remains right
    // and remains a separate change. It is also not this defect's fix, and the
    // arithmetic says why: dropping to 45 deg is worth 1.51 stops on a wall turned
    // TOWARD the sun (cos 75.6 = 0.248 -> cos 45 = 0.707) and nothing at all on a
    // shaded one, whose illuminance is the sky's and does not depend on where the
    // sun is. It fixes wall-against-wall separation; it cannot fix a crush.
    exposure: 1 / 14000,      // camera stop, not a brightness fudge
    lampsOn: false,
    fog: { color: 0xa8c2dc, density: 0.0016 },
    // bloomThreshold is in EXPOSED units, so it had to move with the stop or the
    // change would have bloomed the pavement. It was 1.7 at 1/69,490, i.e. 118,133
    // nits - above anything in the district, which is why noon had no bloom at all.
    // Re-derived the way golden's was, from the brightest plausible non-emissive
    // surface, which at a 75.6 deg sun is the GROUND rather than a wall: sunlit
    // white road marking at albedo 0.7 is 105,244 * 0.7/pi = 23,450 nits = 1.675
    // exposed, and sunlit concrete at 0.35 is 0.838. Clearing the marking by 28%
    // gives 2.1, i.e. 29,400 nits. What blooms at noon is therefore the sun's
    // aureole and specular glints off glass and metal, which run 10^4-10^5 nits,
    // and nothing that is merely lit - the same bar golden's 1.4 was set to.
    post: { fogColor: 0xa9c3e0, inscatter: 0xfff0d0, density: 0.0016,
            heightFalloff: 0.020, bloomThreshold: 2.1, bloomStrength: 0.30 },
  },
  // Golden hour. The hour the district did not have.
  //
  // Every dusk critique round asked for legible cast shadows on the road, and
  // tools/sun-share.mjs measured why they cannot exist there: at dusk the sun
  // owns 1.9% of the light on the road (2.4 of 255) and the geometry is already
  // blocking 83.8% of that. Dusk is authored as SUNSET - sun on the horizon,
  // sky-dominated, flat ground - and it renders that correctly. Golden hour is a
  // different hour, and this is it.
  //
  // Nothing below is a taste value. Every photometric number was read back out of
  // OUR OWN atmosphere (src/sky.js) at this geometry, turbidity 2.6, overcast 0:
  //
  //   sun elevation           8.00 deg = 0.1396 rad
  //   sunLux  (direct normal, SUN_ILLUMINANCE * luminance(transmittance))  34,470
  //   skyLux  (cos-weighted hemispherical integral over the dome)           8,519
  //   zenith 1,434 nits, horizon 7,908 nits
  //   transmittance t = [0.4168, 0.2442, 0.0982]  <- the sun's colour after air mass
  //
  // 8 deg was proposed from Kasten-Young air mass 6.857 and a broadband luminous
  // optical depth tau = 0.21, which predicts 31,500 lux direct normal. Our model
  // says 34,470 - 9.4% brighter. The model wins: 34,470 is what this preset puts on
  // the district (audit() measures 34,394 delivered, the 0.2% being the hue's 8-bit
  // quantisation), and the discrepancy is logged rather than split. The model is
  // self-consistent at the other end too: it puts 9,319 lux at dusk's 3.15 deg,
  // against the ~8,800 that src/sky.js's own SKY_PRESETS comment quotes.
  //
  // Why 8 deg and not 6. Two independent reasons, both measured:
  //   - the sun's share of the horizontal illuminance is sun*sin(el)/(sun*sin(el)
  //     + sky): 25.7% at 6 deg, 36.0% at 8 deg, 44.4% at 10 deg. A cast shadow can
  //     never be more legible than that number allows, and 6 deg is on the edge of
  //     the 25% acceptance bar before any geometry gets in the way. That is the
  //     ATMOSPHERE's share, and the district used to render well under it because
  //     it delivered the sky twice. It does not any more. The light meter reads
  //     the sun at 40.8% of the horizontal illuminance on this build against 28.2%
  //     on the one that double-counted - the atmosphere's 36.0% plus the PMREM's
  //     own 13.5% shortfall against the dome's integral, so BETTER than the
  //     atmosphere rather than worse. tools/sun-share.mjs, which measures the road
  //     band in display units at this camera, agrees: 35.5% of the road with 24%
  //     of it blocked by geometry, against 26.5% / 24.3% on the double-counted
  //     build, and the band itself holds at 122.5 of 255 with 0% clipped where it
  //     read 122.0 before - which is the exposure re-derivation doing exactly what
  //     it is supposed to.
  //   - shadow length against the shadow volume. The ortho shadow camera is +-120
  //     (lateral) with near 1 / far 900 along the light ray from a light parked 400 m
  //     out, so the ground is covered from 403 m sunward to 505 m anti-sunward of
  //     the viewer. The +-120 half-extent bounds the LATERAL half-width, not shadow
  //     length; length is bounded by that 505 m. The district's tallest building is
  //     67.2 m: at 8 deg it throws 67.2/tan(8) = 478 m, inside 505; at 6 deg it
  //     throws 639 m and gets cut off. Median building 6.4 m -> 46 m of shadow, p95
  //     36.5 m -> 260 m. The half-extent was +-260 until it was traded for shadow
  //     map resolution; the measurement that says the trade cost nothing is in the
  //     constructor.
  // A wall facing the sun collects cos(8 deg) = 0.99 of the beam, which is the
  // exact defect noon has and cannot fix at 75.6 deg elevation.
  //
  // Azimuth 0.768 rad = 44.0 deg is the one art call here, and it is stated rather
  // than derived. The corridor hero camera looks along heading -16.0 deg and the
  // fivepoints camera along -0.0 deg, so 44 deg sits 60 deg off the corridor lens
  // and 44 deg off the fivepoints lens. Both are wider than those cameras'
  // horizontal half-FOV (42.8 deg at fov 55, 38.4 deg at fov 48, 16:9), so the disc
  // itself stays out of frame while its warm gradient sits at the frame edge; and a
  // sun 60 deg off the lens puts the shadow direction 120 deg off it, i.e. shadows
  // rake ACROSS the carriageway and toward the camera instead of hiding behind
  // their casters, which is what dusk's 172-deg-off sun does. tools/sun-sweep.mjs
  // established that bearing barely moves ground occlusion (1.99-3.55 over a full
  // 360), so this is about where the light sits in frame, not how much of it there is.
  //
  // It is also the bearing that decides which wall is the key light: a facade whose
  // normal points along heading N collects cos(azimuth - N) of the beam, so an
  // azimuth near the street's normal (90 deg off the lens) maximises the lit wall
  // and minimises the visible shadow, and one near the lens does the opposite. 44 deg
  // is deliberately between: the fivepoints frame gets its left-hand block at
  // cos(46 deg) = 0.70 of full beam - warm and clearly the key - while the right-hand
  // block falls to fill light only, which is the wall-to-wall separation noon cannot
  // produce at 75.6 deg.
  //
  // Measured, at the corridor camera, comparing the authored frame against the same
  // frame with shadow.intensity = 0 (docs/shots/share-*-authored-{base,noshadow}.png):
  //
  //   hour     road pixels darkened >8/255 by cast shadow     mean depth where shadowed
  //   golden                21.0%                                     23.2/255
  //   dusk                   1.9%                                     12.3/255
  //   noon                   0.0%                                     13.1/255
  //
  // Eleven times dusk's shadowed area at nearly twice the depth, and noon has none at
  // all at this camera. That is the round-5 note - "make the sun's occlusion visible
  // on the ground planes" - actually satisfied, in the hour where it is physically
  // possible rather than in the one where it is not.
  golden: {
    label: 'Golden hour',
    // 53,138 is an INTENSITY, and it is the one number in this preset that is not
    // the illuminance it looks like. three.js hands the shader color * intensity as
    // the irradiance, so what a surface facing this sun actually receives is
    // intensity * luminance(sunColor) = 53138 * 0.6487 = 34,470 lux - the measured
    // direct normal illuminance. A saturated hue cannot carry linear luminance 1 in
    // eight bits (only white can), so the deficit has to live in the intensity or it
    // does not exist at all: authoring 34,470 here would put 22,361 lux on the
    // district and call it 34,470.
    //
    // Measured, in the running district with the sun's colour forced to white at a
    // fixed intensity: the road band goes 139.5 -> 147.1 of 255, and the sun's own
    // contribution to it 0.0445 -> 0.0670 in exposed units, a factor of 1.506
    // against the 1.542 that 1/0.6487 predicts. The deficit is real and this is its
    // size. audit() now reports sunLuxDelivered/skyLuxDelivered beside the authored
    // values so the gap is visible for every preset, not just this one - noon
    // delivers 93,080 of its authored 100,000 and dusk 498 of its 1,200.
    sunLux: 53138,
    skyLux: 8519,             // the dome's own hemispherical illuminance, as measured
    elevation: 0.1396, azimuth: 0.768,
    // t normalised to its brightest channel and encoded sRGB: [1, 0.586, 0.236],
    // linear luminance 0.6487 - see sunLux above, which carries the deficit.
    sunColor: 0xffc985,
    // The dome's OWN cos-weighted upper-hemisphere colour, re-integrated from the
    // same 64x32 probe skyLux comes from: [6325, 8712, 13073] nits, normalised.
    // Cool fill against a warm key is what makes the hour read, and it is measured,
    // not styled.
    skyColor: 0xb9d5ff,
    // Ground bounce: uGroundAlbedo (0x6b6455, linear [0.147, 0.127, 0.091]) times
    // the normalised sun hue -> [0.147, 0.075, 0.021]. Red passes the air mass
    // intact, green and blue do not.
    groundColor: 0x6b4d28,
    // The rule is exposure = pi/E for an 18% grey card, and the whole question is
    // which E. This is the one preset that was authored strictly to it.
    //
    // The atmosphere's own answer is E_h = 34470*sin(8 deg) + 8519 = 4,797 + 8,519
    // = 13,316 lux, giving 1/4,239: what a light meter on the road would read
    // outdoors. What the engine put there was different, and the reason has now
    // changed. It USED to be that the sky arrived twice - a HemisphereLight at
    // skyLux plus a PMREM built from the same dome at environmentIntensity 1 - so
    // E_render was 18,868 lux by arithmetic and the stop was 1/6,006. The sky is
    // delivered once now (see the HemisphereLight in the constructor), and the
    // light meter reads, at this camera on a settled scene:
    //
    //     sun on a horizontal surface          5,064.3 lux
    //     HemisphereLight                      5,547.8  -> 0
    //     PMREM environment                    7,358.9
    //                                       ----------
    //                    E_before   17,970.8 lux    E_after  12,423.0 lux
    //
    // 1.4466x less light, so 1/6,006 becomes 1/4,152. The strict rule on the
    // measured E_after would say pi/12,423 = 1/3,954, 5% away: the authored
    // 1/6,006 was itself 5% under pi/E_before because the arithmetic above
    // used the dome's 8,519 lux where the PMREM actually delivers 7,359, and
    // moving the stop by a ratio keeps that offset rather than folding a second
    // correction into the same edit.
    //
    // The frame does not get brighter: an 18% card sits where it sat. What moves is
    // the split - the sun goes from 28.2% of the light on the road to 40.8%, and
    // the key:fill between a wall turned toward the sun and one turned away goes
    // from 2.99 (1.58 stops) to the figure recorded in PROGRESS.md.
    exposure: 1 / 4152,
    // Off. 4,797 lux of sun on the road against a 900 cd lamp is not a contest,
    // and real street lighting is not on 40 minutes before sunset.
    lampsOn: false,
    // Fallback only: with a PostStack attached (which the district always has)
    // scene.fog is dropped and post.js's height fog takes over. The colour doubles
    // as the flat background in that fallback, so it carries the dome's ambient hue
    // rather than the away-from-sun horizon ring, which at this hour measures a
    // near-neutral 0xf5fff7 and would render the fallback sky white. Density is
    // noon's: golden hour is the same clear air.
    fog: { color: 0xb9d5ff, density: 0.0016 },
    // fogColor/inscatter/density/heightFalloff are all overwritten within the same
    // apply() - sky.applyToPost() writes the measured atmosphere over them and
    // normalisePostExposure() clamps after that - so they are set to the measured
    // hues (fog = away-from-sun horizon ring, inscatter = toward-sun ring) rather
    // than to a colour that would be a lie for the one frame they survive.
    //
    // bloomThreshold and bloomStrength are NOT overwritten and are the only look
    // parameters here. The threshold is bounded from below by three quantities that
    // are arithmetic on the numbers above, in exposed units at 1/6,006:
    //   exposed mid-sky              sqrt(1434*7908)/6006                    = 0.56
    //   white sunlit horizontal      E_render/pi/6006                        = 1.00
    //   sunlit facade, albedo 0.5    (34470*cos(8) + (5552+8519)/2)*0.5/pi/6006 = 1.09
    // A threshold under 1.09 blooms every sunlit wall in the district, which is the
    // milky frame three critic rounds have already complained about. 1.4 clears the
    // brightest plausible facade by 28% and sits under the inscatter lobe's own
    // ceiling (normalisePostExposure clamps it to 2.2 exposed), so what blooms is
    // the sun's aureole and specular glints off glass and wet metal - and nothing
    // that is merely lit. Strength is between noon's 0.30 and dusk's 0.62 and nearer
    // noon, because unlike dusk nothing in frame is an emitter.
    post: { fogColor: 0xf5fff7, inscatter: 0xffd4a5, density: 0.0016,
            heightFalloff: 0.020, bloomThreshold: 1.4, bloomStrength: 0.40 },
  },
  dusk: {
    label: 'Dusk',
    sunLux: 1200,             // sun on the horizon, heavily attenuated
    skyLux: 900,
    elevation: 0.055, azimuth: 2.72,
    sunColor: 0xff9048, skyColor: 0x93a9d6, groundColor: 0x40382e,
    // Derived, not dialled: an 18% grey card under this preset's 2100 lux total
    // (1200 sun + 900 sky) sits at 2100 x 0.18/pi = 120 nits, so mid-grey lands at
    // 0.18/120 = 1/667. The previous 1/330 was exactly one stop hot, which is why the
    // plaza measured 214/255 and the sky 245/255 with the darkest region in frame -
    // asphalt - still at 173. Blind critics called it milky with no black point; they
    // were right, and the tonemapper they blamed was not the cause.
    //
    // Re-derived for a sky delivered once. The light meter reads 1,764.2 lux at the
    // corridor camera - sun, both sky paths AND the street lamps, which are lit at
    // this hour - of which the HemisphereLight was 354.9 (20.1%). 1.2518x less
    // light, so 1/900 becomes 1/719. The 2100-lux arithmetic above is left
    // standing because it is the reasoning that set the offset from pi/E, and that
    // offset is preserved exactly; only the light changed.
    exposure: 1 / 719,
    lampsOn: true,
    fog: { color: 0x6a6480, density: 0.0034 },
    post: { fogColor: 0x6d6a88, inscatter: 0xff9a52, density: 0.0032,
            heightFalloff: 0.016, bloomThreshold: 0.85, bloomStrength: 0.62 },
  },
  night: {
    label: 'Night',
    sunLux: 0.6,              // full moon is ~0.25 lux; this is moon + skyglow
    skyLux: 0.15,             // measured from the sky model, not guessed at
    elevation: 0.9, azimuth: 4.1,
    sunColor: 0x9fb6e0, skyColor: 0x35406b, groundColor: 0x14161f,
    // Re-derived for a sky delivered once, and then LEFT ALONE, which is the
    // derivation's own answer rather than a reluctance to touch it.
    //
    // skyLux 0.15 through a 0x35406b tint delivers 0.008 lux to a horizontal
    // surface. The light meter reads 0.70 lux in total at the corridor camera -
    // the lamps and the dome are what night is - so the hemisphere is 1.14% of it
    // and the stop would move by 1.2%, from 1/1.15 to 1/1.14.
    //
    // The meter cannot even see the term it would be correcting for: base minus
    // the hemisphere-off frame reads 0.0 lux against a 0.05 lux quantisation, and
    // the hemisphere-ONLY frame reads 0.3 lux because the street lamps are lit at
    // this hour and that frame still contains them. A stop moved by a percent, on
    // a term below the instrument's resolution, is a diff and not a derivation -
    // and the night frames are the ones three critic rounds have named as the best
    // in the set. What DOES change at night is measured and reported in
    // PROGRESS.md: the hemisphere was 0.2% of the corridor wall region and 1.2% of
    // the ground region, so the crushed fraction and the lamp pools move by less
    // than the run-to-run spread.
    exposure: 1 / 1.15,       // dark sky, lamp-lit surfaces readable. At 1/3.2 the
                              // polarity was right but the frame was unplayably dark
    lampsOn: true,
    fog: { color: 0x141a2a, density: 0.0042 },
    post: { fogColor: 0x18203a, inscatter: 0x3b4a78, density: 0.0038,
            heightFalloff: 0.014, bloomThreshold: 0.55, bloomStrength: 0.85 },
  },
};

// Plausibility envelope, asserted by the sweep. These are the ranges a real
// photometric reference would put each quantity in.
//
// `skyLux` is judged against the sky's DELIVERED illuminance on a horizontal
// surface, summed over every path carrying it - see audit() and skyDelivery().
// It used to be judged against hemi.intensity, which is an intensity rather than
// an illuminance AND was only one of the two paths delivering the sky, so the
// gate read PASS on a build putting 14,067 lux on golden hour against the
// 5,500-11,800 below. The bounds themselves have not moved: they were always
// authored as sky ILLUMINANCE ranges swept out of src/sky.js's own atmosphere,
// and they now judge that. tools/daynight-sweep.mjs's second negative test
// re-injects the double delivery and fails if this stops catching it.
export const PLAUSIBLE = {
  noon:  { sunLux: [50000, 130000], skyLux: [8000, 30000] },
  // Golden hour is defined by its elevation band, so its envelope is too. Swept
  // through OUR OWN atmosphere at turbidity 2.6 (the value weather.js's clear
  // state actually pushes), direct normal runs 24,301 lux at 6 deg to 43,410 at
  // 10 deg and the dome's hemispherical illuminance 7,360 to 9,427. Those ends
  // widened by 25% either way are the bounds below; the preset sits at 34,470 and
  // 8,519, which is 8 deg exactly.
  // NOTE the units differ from the two rows around them, and deliberately: golden's
  // sunLux is the INTENSITY, whose delivered illuminance is intensity *
  // luminance(sunColor) - see the preset. Swept through our own atmosphere at
  // turbidity 2.6, direct normal runs 24,301 lux at 6 deg to 43,410 at 10 deg, and
  // the intensity that delivers those through the transmittance hue at each end is
  // 41,455 and 62,371. Widened 25% either way. audit() reports sunLuxDelivered
  // alongside, which is the number to read as a photometric quantity.
  golden: { sunLux: [31000, 78000],  skyLux: [5500, 11800] },
  dusk:  { sunLux: [200, 4000],     skyLux: [100, 2500] },
  night: { sunLux: [0, 3],          skyLux: [0.03, 1.5] },
  lampCandela: [300, 3000],         // a street lamp is ~10-20 klm over a sphere
  shopCandela: [40, 600],
};

export class TimeOfDay {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    // The shadow map's RESOLUTION ON THE GROUND, which is the quantity that
    // decides whether a street-scale object can cast anything at all.
    //
    // An ortho shadow camera 2*S metres across a map of N texels resolves
    // 2*S/N metres per texel, and PCF needs roughly two texels of contiguous
    // occlusion before a shadow survives filtering. The shipped 2048 over
    // +-260 gave 0.254 m/texel: a car (1.8 m across) is 7 texels and does
    // appear, a bin (0.5 m) is 2 and barely does, a bollard (0.15 m) is 0.6
    // and can never appear no matter what flags it carries. That is half of
    // why the round-6 critics found street objects sitting ON the pavement
    // rather than in contact with it; the other half was castShadow, see
    // src/streetfurniture.js.
    //
    // 3072 over +-120 is 0.078 m/texel - 3.25x finer - and the extent half of
    // that was measured rather than guessed. tools/sun-share.mjs's method,
    // applied per horizontal band at the corridor hero camera at golden hour
    // with traffic and the crowd frozen: capture the frame, capture it again
    // with shadow.intensity = 0, and the difference is the light the shadow
    // pass is removing.
    //
    //   extent x map     m/texel   facade band   mid band    near band
    //   260 x 2048 (old)  0.254     7.02          21.32       2.91   <- shipped
    //   260 x 2048 +props 0.254     7.05          21.50       6.68
    //   260 x 4096        0.127     7.28          21.68       6.02
    //   180 x 2048        0.176     7.18          21.59       6.60
    //   120 x 2048        0.117     7.27          21.61       6.25
    //   150 x 4096        0.073     7.35          21.61       6.82
    //    90 x 2048        0.088     7.01          21.63       6.21
    //
    // The mid band is the one a tighter camera was expected to cost: it is the
    // far half of the carriageway, where DISTANT buildings throw their shadows,
    // and it is 52-53% shadowed in every row. Tightening from +-260 to +-90
    // moves it by 0.3 of 21.3 - i.e. nothing. The reason is the streamer: near
    // chunks (nearRadius 2 x chunkSize 128) span +-320 m around the viewer, so
    // a +-120 shadow box sits entirely inside full-detail geometry and every
    // caster that was reaching the frame still is.
    //
    // What S actually bounds is worth stating, because it is not shadow LENGTH.
    // The ortho box's two lateral axes are perpendicular to the light ray: one
    // horizontal and across the sun's bearing, one near-vertical. A ground point
    // d metres UP-SUN of the viewer sits only d*sin(elevation) = 0.14d along the
    // near-vertical axis at golden hour, so +-120 admits casters hundreds of
    // metres up-sun and the up-sun limit is `near`, not S. S bounds the ACROSS-SUN
    // slab: outside +-120 m of the line through the viewer along the sun's
    // bearing, nothing casts and nothing receives. At the corridor camera the sun
    // sits 60 deg off the lens, so that slab edge falls 120/sin(60 deg) = 139 m
    // down the street.
    //
    // +-120 rather than the +-90 that also measured clean: 90 is the tightest
    // extent this probe happened to test, at ONE camera and one azimuth, and an
    // extent chosen at the edge of its own evidence is how a shadow volume ends
    // up popping on a street the probe never stood in.
    // 2048, not 3072, and the extent is what buys the resolution.
    //
    // The ground-contact work raised both together and the chunk-stall gate then
    // failed three times in seven runs, where the eight before it never passed
    // 12.2 ms. Isolated with DRIVE_SHADOW on the drive-through harness, three runs
    // each, everything else identical:
    //
    //   3072, casters on   10.1  15.8  23.5  17.1  17.1  11.8  10.9   3 FAILs
    //   shadows off         8.6   9.6   7.9                          0
    //   2048, casters on    9.2   8.4  10.4                          0
    //
    // So it is the map SIZE, not the 85 caster meshes: at 2048 every caster and
    // the tight extent are kept, draw calls stay at 228, and the stall returns to
    // the band it sat in before any of this. SwiftShader rasterises the shadow map
    // on the same CPU that runs the streaming slice the metric measures, and 3072
    // is 2.25x the texels of 2048.
    //
    // The resolution that mattered came from the EXTENT anyway. At +/-120 over
    // 2048 a texel is 240/2048 = 0.117 m, still 2.17x finer than the 0.254 m that
    // made a pedestrian 2 texels wide and therefore un-castable. A pedestrian is
    // now ~4.3 texels and a bollard ~1.3.
    const SHADOW_MAP = 2048, S = 120;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    Object.assign(this.sun.shadow.camera,
      { left: -S, right: S, top: S, bottom: -S, near: 1, far: 900 });
    // Kept as authored. bias is in normalised depth, so against near 1 / far 900
    // it is 0.0006 * 899 = 0.54 m along the light ray. The bias a receiver needs
    // is about one texel divided by tan(elevation) - at golden hour's 8 deg and
    // the new 0.078 m texel that is 0.55 m, which is what this already is. It
    // was the 0.254 m texel that this bias was too small for, and PCF blur was
    // covering the difference.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    scene.add(this.sun, this.sun.target);

    // A HemisphereLight is a crude sky-plus-ground-bounce approximation, and next
    // to a real sky dome it has nothing left to approximate.
    //
    // Two systems were carrying the same sky: this light at the preset's skyLux,
    // and sky.js's PMREM - built from the same dome - delivered AGAIN through
    // scene.environment at environmentIntensity 1, over sky.js's own
    // recommendation of 0.35. tools/sky-once.mjs measures both with a light meter
    // parked in the frame: an albedo-1, roughness-1 patch whose Lambertian
    // radiance is E/pi, so pi times its radiance read out of the HDR scene target
    // is lux. Corridor hero camera, streaming settled, traffic and pedestrians
    // frozen, noise floor taken first, one light path switched off at a time:
    //
    //   preset  surface   HemisphereLight   PMREM env   the dome's own integral
    //   noon    up           13,074 lux    15,006 lux           15,126 lux
    //   noon    down          2,580        15,736               15,593
    //   noon    wall          7,827        17,084               16,482
    //   golden  up            5,548         7,359                8,503
    //   golden  down            732         1,550                1,273
    //   golden  wall          3,140         6,490                6,111
    //   dusk    up              355         1,381                1,595
    //
    // The third column is int L cos(theta) dw over sky.js's own LUT - the sky the
    // PMREM is BUILT from, so it is the ceiling on what the PMREM can deliver, and
    // it is arithmetic on a read-back texture rather than a render. The second
    // column sits within a few percent of it. The first is a second helping.
    //
    // Night is deliberately absent from that table. The meter's single-path frames
    // still contain the STREET LAMPS, which are lit at that hour, and at 0.7 lux
    // total they swamp the 0.008 lux this light delivers there - the hemisphere-only
    // frame reads 0.3 lux and 0.29 of that is lamps. The number that IS trustworthy
    // at night is the closed form and the by-difference isolation, which agree:
    // 0.15 lux of intensity through a 0x35406b tint is 0.008 lux delivered, 1.1% of
    // the light at the corridor camera, and base-minus-hemisphere-off reads 0.0
    // against a 0.05 lux quantisation. The dome's own integral there is 0.197 lux.
    //
    // THE HEMISPHERE IS NOT CARRYING A TERM THE DOME LACKS, and that was the thing
    // worth checking: a HemisphereLight's groundColor is a ground BOUNCE, and a
    // PMREM built from a sky usually has none. This dome is not usual.
    // sky.js's skyRadiance() fades the dome into groundRadiance() = albedo * E/pi
    // below the horizon, so its lower hemisphere IS the lit ground, and the
    // integral over it reads 15,593 lux at noon against this light's 2,580 - six
    // times as much, not absent - and the PMREM delivers it to within 1%. Giving
    // the sky to the PMREM and keeping the hemisphere for the bounce, which is the
    // obvious compromise and the one this change was expected to make, would
    // double-count the bounce instead: the same mistake one level down.
    //
    // Nor can environmentIntensity absorb the PMREM's residual. At golden the
    // roughness-1 convolution delivers 86.5% of the dome's integral on an
    // up-facing normal and 121.8% on a down-facing one IN THE SAME FRAME,
    // so the error is angular, not scalar, and no single number corrects both.
    //
    // So: when the dome's environment map is in the scene it carries the whole
    // sky, upper hemisphere and lower, and this light carries nothing. When there
    // is no dome - labs/materials, labs/facades and labs/signage all construct
    // TimeOfDay without one - it is the only ambient there is and carries the lot.
    // apply() decides, after the dome has written.
    //
    // Left in the scene at intensity 0 rather than removed: it keeps the shader
    // permutation and the audit's light census stable across the change, and
    // audit().skyDelivery reports how many paths are carrying the sky, so the
    // question this whole block answers is a number in the artifact from now on.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    scene.add(this.hemi);

    this.lamps = [];          // registered by whoever builds street furniture
    this.post = null;         // optional PostStack; see attachPost()
    this.skyDome = null;      // set once src/sky.js provides a real dome
    // Full strength, and that is no longer a preference: the dome's PMREM is the
    // only thing delivering the sky's diffuse, so dimming it dims the sky.
    // sky.js's recommendedEnvironmentIntensity now agrees, and the two have to -
    // sky.refresh() calls applyToScene() again on every weather transition, so a
    // disagreement between them does not read as a wrong constant, it reads as the
    // district re-dimming in the middle of the rain arriving.
    this.envIntensity = 1.0;
    this.weather = { wetness: 0, fogBoost: 0 };
    this.preset = null;
    this.apply('dusk');
  }

  /**
   * Is the dome's own PMREM in the scene and delivering? Identity-checked against
   * the dome's texture rather than testing scene.environment for truthiness: an
   * environment map from somewhere else is somebody else's decision, and this is
   * only ever about the double delivery of OUR sky.
   */
  skyCarriedByEnvironment() {
    return !!(this.skyDome && this.skyDome.environment
      && this.scene.environment === this.skyDome.environment
      && (this.scene.environmentIntensity ?? 1) > 0);
  }

  /**
   * The sky's diffuse illuminance on a horizontal surface, summed over every path
   * that carries it, in lux. This - not the HemisphereLight's raw intensity - is
   * the photometric quantity, and it is what the plausibility envelope judges.
   */
  skyDelivery() {
    const hemiLux = this.hemi.intensity * lum3(this.hemi.color);
    const domeLux = this.skyCarriedByEnvironment()
      ? (this.skyDome.audit().skyLux ?? 0) * (this.scene.environmentIntensity ?? 1) : 0;
    return {
      hemisphereLux: +hemiLux.toFixed(3),
      environmentLux: +domeLux.toFixed(3),
      totalLux: +(hemiLux + domeLux).toFixed(3),
      // How many independent paths are delivering the sky. Anything but 1 is a
      // photometric bug: 2 double-counts it, 0 leaves every shadow lit by the sun
      // alone. It is a count, so it catches the double delivery at a time of day
      // where the doubled total still happens to land inside the envelope - which
      // is exactly what noon did.
      paths: (hemiLux > 1e-6 ? 1 : 0) + (domeLux > 1e-6 ? 1 : 0),
    };
  }

  registerLamp(light, candela) { this.lamps.push({ light, candela }); }

  // Preferred over registerLamp: one instanced fixture set plus a nearest-N pool.
  // The streamer owns the facade library; time of day has to reach it so lit
  // windows switch with the cycle.
  setWorld(world) { this.world = world; this.apply(this.presetName); }

  // Attaching a sky hands it the background and the fog/inscatter terms. Without
  // one, apply() falls back to a radiance-scaled flat colour, which is a stand-in
  // and not a sky.
  setSky(sky, weather = null) {
    this.skyDome = sky;
    this.weatherSys = weather;
    this.apply(this.presetName);
  }

  setFurniture(furniture, lightPool) {
    this.furniture = furniture;
    this.lightPool = lightPool;
    this.apply(this.presetName);
  }

  // When a PostStack is attached it takes over tonemapping and exposure, and
  // scene.fog is dropped in favour of the depth-based height fog in the composite
  // pass (per-vertex fog cannot do aerial perspective or fog the sky).
  attachPost(post) {
    this.post = post;
    this.apply(this.presetName);
  }

  // Weather drives fog density and surface wetness without disturbing the
  // photometric values, so the plausibility gate stays meaningful in the rain.
  setWeather({ wetness = 0, fogBoost = 0 } = {}) {
    this.weather.wetness = wetness;
    this.weather.fogBoost = fogBoost;
    this._applyPost();
  }

  // Fog radiance has to survive the camera stop. Whatever the sky hands over is a
  // physical radiance; what ACES actually receives is radiance x exposure, and
  // anything much above ~1.5 saturates to white. Measured at dusk: fog 2.14 and
  // inscatter 6.52, which blew the whole frame while the illuminance ratio gate
  // still read "pass" - the gate was checking the wrong quantity.
  //
  // Fog colour is a look parameter; only its ratio to exposure matters. So it is
  // renormalised here, preserving hue, after the sky and weather have written.
  normalisePostExposure() {
    if (!this.post) return null;
    const q = this.post.params;
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const fit = (color, target) => {
      const l = lum(color) * q.exposure;
      if (l > target && l > 1e-9) color.multiplyScalar(target / l);
      return l;
    };
    // Fog fills most of a wide shot, so it must stay clearly below saturation.
    // Inscatter only applies in a narrow lobe toward the sun and is allowed to
    // bloom, which is what a sun behind haze actually does.
    const before = { fog: lum(q.fogColor) * q.exposure, inscatter: lum(q.fogInscatter) * q.exposure };
    fit(q.fogColor, 0.85);
    fit(q.fogInscatter, 2.2);
    // The sky's physical extinction veils the mid-ground at street level. Real
    // aerial perspective is far weaker over 300 m of clear air; this keeps depth
    // separation without turning the district into a white sheet.
    q.fogDensity = Math.min(q.fogDensity, 0.0009 + this.weather.fogBoost * 0.004);
    q.fogHeightFalloff = Math.max(q.fogHeightFalloff, 0.02);
    return { before, after: { fog: lum(q.fogColor) * q.exposure, inscatter: lum(q.fogInscatter) * q.exposure } };
  }

  _applyPost() {
    if (!this.post) return;
    const p = this.preset, pp = p.post;
    const q = this.post.params;
    q.exposure = p.exposure;
    q.fogColor.setHex(pp.fogColor);
    q.fogInscatter.setHex(pp.inscatter);
    q.fogDensity = pp.density * (1 + this.weather.fogBoost * 3);
    q.fogHeightFalloff = pp.heightFalloff;
    q.bloomThreshold = pp.bloomThreshold;
    q.bloomStrength = pp.bloomStrength;
    q.wetness = this.weather.wetness;
    q.sunDirection.copy(this.sun.position).normalize();
  }

  apply(name) {
    const p = PRESETS[name];
    if (!p) throw new Error(`unknown time of day: ${name}`);
    this.presetName = name;
    this.preset = p;

    this.sun.intensity = p.sunLux;
    this.sun.color.setHex(p.sunColor);
    const d = 400;
    this.sun.position.set(
      Math.cos(p.azimuth) * Math.cos(p.elevation) * d,
      Math.sin(p.elevation) * d,
      Math.sin(p.azimuth) * Math.cos(p.elevation) * d
    );

    // Intensity is NOT set here. It depends on whether the dome's environment map
    // ends up in the scene, which the block further down decides, so it is set
    // after that block and not before it.
    this.hemi.color.setHex(p.skyColor);
    this.hemi.groundColor.setHex(p.groundColor);

    if (this.post) {
      // The post stack tonemaps; the renderer must stay linear.
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.scene.fog = null;
      this._applyPost();
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = p.exposure;
      this.scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);
    }
    // Approximate sky radiance from the preset's sky illuminance (L = E / pi).
    // src/sky.js replaces this with a real dome; without the scale the background
    // is an sRGB colour multiplied by a camera stop, i.e. black.
    if (!this.skyDome) {
      this.scene.background = new THREE.Color(p.fog.color).multiplyScalar(p.skyLux / Math.PI);
    }

    for (const { light, candela } of this.lamps) {
      light.intensity = p.lampsOn ? candela : 0;
    }
    if (this.skyDome) {
      this.skyDome.setTimeOfDay(name);
      this.skyDome.refresh({ force: true });
      this.skyDome.applyToScene(this.scene);
      // Restore full strength after the sky writes: the environment map is the
      // only light reaching a wall when the sun is overhead, and now the only
      // thing delivering the sky's diffuse anywhere.
      this.scene.environmentIntensity = this.envIntensity;
      if (this.post) this.skyDome.applyToPost(this.post, this.weatherSys);
    }
    // THE SKY IS DELIVERED ONCE - see the HemisphereLight in the constructor for
    // the measurements. This runs AFTER the dome block above, because whether the
    // dome's environment map is in the scene is the question it asks.
    this.hemi.intensity = this.skyCarriedByEnvironment() ? 0 : p.skyLux;
    if (this.furniture) this.furniture.setLit(p.lampsOn);
    if (this.world && this.world.setFacadeTime) this.world.setFacadeTime(name);
    // Rescale the pool for the new time of day WITHOUT re-selecting which emitters
    // are lit. This used to pass { x: 0, y: 0, z: 0 }, so applying a preset re-pinned
    // all ten lights to the WORLD ORIGIN. main.js updates the pool correctly against
    // camera.position every frame, but tod.apply() ran after it and overwrote the
    // selection - and the hero-shot harness calls setTimeOfDay immediately before it
    // captures, so every critique frame this project has ever produced had its street
    // lamps pinned to (0,0,0).
    //
    // Measured at the night hero camera: nearest emitter 62 m, lights actually lit at
    // 298-491 m, all outside both the lamps' own 46 m falloff and the pool's 130 m
    // maxDistance. Two blind critics independently reported "there is no street
    // lighting" and "no pools of light beneath lamps" as their single highest-leverage
    // note. They were right, and the light-pool report - 233 emitters, 7 active -
    // said the system was healthy the whole time.
    if (this.lightPool) this.lightPool.update(this._followPos ?? { x: 0, y: 0, z: 0 },
      p.lampsOn ? 1 : 0);
    return p;
  }

  follow(pos) {
    // Remember where the viewer is. apply() needs it to rescale the light pool
    // without re-pinning every lamp to the world origin - see the note there.
    this._followPos = { x: pos.x, y: pos.y, z: pos.z };
    const p = this.preset, d = 400;
    this.sun.position.set(
      pos.x + Math.cos(p.azimuth) * Math.cos(p.elevation) * d,
      Math.sin(p.elevation) * d,
      pos.z + Math.sin(p.azimuth) * Math.cos(p.elevation) * d
    );
    this.sun.target.position.copy(pos);
    this.sun.target.updateMatrixWorld();
    if (this.post) this.post.params.sunDirection.copy(this.sun.position).sub(pos).normalize();
  }

  // Scene-graph audit: what is ACTUALLY in the graph, with units, so a visual
  // review can never again mistake a mis-tuned constant for a missing system.
  audit() {
    const lights = [];
    let shadowCasters = 0, shadowReceivers = 0;
    this.scene.traverse((o) => {
      if (o.isLight) {
        lights.push({
          type: o.type,
          intensity: +o.intensity.toFixed(3),
          unit: o.isDirectionalLight || o.isHemisphereLight ? 'lux' : 'candela',
          color: '#' + o.color.getHexString(),
          castShadow: !!o.castShadow,
          ...(o.distance !== undefined ? { distance: o.distance, decay: o.decay } : {}),
        });
      }
      if (o.isMesh) {
        if (o.castShadow) shadowCasters++;
        if (o.receiveShadow) shadowReceivers++;
      }
    });
    const byType = {};
    for (const l of lights) byType[l.type] = (byType[l.type] || 0) + 1;
    // The shadow map's resolution ON THE GROUND. A visual review that reports
    // "no shadows under the street furniture" needs this number to tell a
    // missing flag from a map that cannot resolve the object, which is the
    // distinction the round-6 round turned on.
    const sc = this.sun.shadow.camera;
    const shadowMap = {
      mapSize: this.sun.shadow.mapSize.x,
      extentM: +(sc.right - sc.left).toFixed(0),
      metresPerTexel: +((sc.right - sc.left) / this.sun.shadow.mapSize.x).toFixed(4),
      casterMeshes: shadowCasters,
      receiverMeshes: shadowReceivers,
    };

    // Plausibility checks against the envelope above.
    const flags = [];
    const env = PLAUSIBLE[this.presetName];
    const sun = lights.find((l) => l.type === 'DirectionalLight');
    const hemi = lights.find((l) => l.type === 'HemisphereLight');
    if (sun && (sun.intensity < env.sunLux[0] || sun.intensity > env.sunLux[1])) {
      flags.push(`sun ${sun.intensity} lux outside plausible ${env.sunLux.join('-')} for ${this.presetName}`);
    }
    // The sky, judged on what it DELIVERS rather than on one light's raw number.
    //
    // This used to read hemi.intensity. That was the wrong quantity twice over:
    // it is an intensity, not an illuminance (a tinted light of intensity E puts
    // E * luminance(color) lux on a facing surface), and from the day sky.js's
    // PMREM landed it was not even the only path carrying the sky. On the
    // committed build golden delivered 5,548 lux through the HemisphereLight AND
    // 8,519 through the environment - 14,067 against an envelope of 5,500-11,800
    // that the gate read as PASS, because it was looking at 8,519 and calling it
    // lux. Asserting the delivered total makes the envelope mean what it says,
    // and would have failed on that build. See the Threshold change log.
    const delivery = this.skyDelivery();
    if (delivery.totalLux < env.skyLux[0] || delivery.totalLux > env.skyLux[1]) {
      flags.push(`sky delivers ${delivery.totalLux.toFixed(0)} lux to a horizontal surface ` +
        `(hemisphere ${delivery.hemisphereLux.toFixed(0)} + environment ${delivery.environmentLux.toFixed(0)}), ` +
        `outside plausible ${env.skyLux.join('-')} for ${this.presetName}`);
    }
    // One sky, one delivery. Two paths double-count it whatever each one reads.
    if (delivery.paths !== 1) {
      flags.push(delivery.paths > 1
        ? `the sky is delivered ${delivery.paths} times: HemisphereLight ${delivery.hemisphereLux.toFixed(0)} lux ` +
          `AND environment ${delivery.environmentLux.toFixed(0)} lux, from the same dome`
        : 'nothing is delivering the sky: every shadowed surface is lit by the sun alone');
    }
    for (const l of lights.filter((x) => x.type === 'PointLight' && x.intensity > 0)) {
      const [lo, hi] = PLAUSIBLE.lampCandela;
      if (l.intensity < lo || l.intensity > hi) {
        flags.push(`point light ${l.intensity} cd outside plausible ${lo}-${hi}`);
      }
    }
    if (this.preset.lampsOn === false && lights.some((l) => l.type === 'PointLight' && l.intensity > 0)) {
      flags.push('street lamps are lit at a time of day when they should be off');
    }

    if (this.post) {
      const q = this.post.params;
      const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const fogExposed = lum(q.fogColor) * q.exposure;
      const insExposed = lum(q.fogInscatter) * q.exposure;
      // This, not the illuminance ratio, is what decides whether the frame blows
      // out. ACES saturates above roughly 1.5.
      if (fogExposed > 1.2) {
        flags.push(`fog radiance x exposure = ${fogExposed.toFixed(2)}; above ~1.2 the frame washes out`);
      }
      if (insExposed > 3.0) {
        flags.push(`inscatter radiance x exposure = ${insExposed.toFixed(2)}; above ~3.0 the sun lobe blows`);
      }
    }
    if (this.skyDome) {
      const skyAudit = this.skyDome.audit();
      for (const f of skyAudit.implausible ?? []) flags.push(`sky: ${f}`);
      // The sky is the dominant light source in frame. If its illuminance
      // disagrees with the preset the camera stop was set from, the image is
      // wrong however plausible each half looks alone.
      if (Number.isFinite(skyAudit.skyLux)) {
        const ratio = skyAudit.skyLux / Math.max(1e-6, this.preset.skyLux);
        if (ratio > 2 || ratio < 0.5) {
          flags.push(`sky illuminance ${skyAudit.skyLux.toFixed(0)} lux is ${ratio.toFixed(1)}x ` +
            `the ${this.presetName} preset's ${this.preset.skyLux} lux that exposure ` +
            `1/${Math.round(1 / this.preset.exposure)} was calibrated for`);
        }
      }
    }

    return {
      timeOfDay: this.presetName,
      exposure: this.post ? this.post.params.exposure : this.renderer.toneMappingExposure,
      exposureAsStop: `1/${Math.round(1 / (this.post ? this.post.params.exposure : this.renderer.toneMappingExposure))}`,
      toneMapping: this.post ? 'ACESFilmic (post composite)'
        : this.renderer.toneMapping === THREE.ACESFilmicToneMapping ? 'ACESFilmic (renderer)'
        : String(this.renderer.toneMapping),
      postProcessing: this.post ? {
        bloomThreshold: this.post.params.bloomThreshold,
        bloomStrength: this.post.params.bloomStrength,
        fogDensity: +this.post.params.fogDensity.toFixed(5),
        fogHeightFalloff: this.post.params.fogHeightFalloff,
        wetness: this.post.params.wetness,
        // AO reported explicitly. Every critic round so far has diagnosed "no
        // ambient occlusion" correctly AND "no shadow map" incorrectly, so the
        // audit needs to state which of the two is actually true.
        aoEnabled: this.post.params.aoEnabled,
        aoStrength: this.post.params.aoStrength,
        aoRadiusM: this.post.params.aoRadius,
        passes: this.post.stats.passes,
      } : null,
      shadowMapEnabled: this.renderer.shadowMap.enabled,
      shadowMap,
      lightCount: lights.length, lightsByType: byType,
      sunLux: sun?.intensity, skyLux: hemi?.intensity,
      // What the lights actually DELIVER, which is not what they are authored at.
      // three.js gives the shader color * intensity as the irradiance, so a tinted
      // light of intensity E puts E * luminance(color) lux on a facing surface, and
      // luminance(color) < 1 for every colour that is not white. Measured here
      // rather than assumed: noon's 0xfff6e8 is 0.93, golden's 0xffc985 is 0.65,
      // dusk's 0xff9048 is 0.42. Reported, not gated - the envelope above still
      // judges the authored value, so no existing verdict moves. It exists because
      // the file header promises "intensity -> lux" and that promise is only true
      // for a white light.
      sunLuxDelivered: sun ? +(this.sun.intensity * lum3(this.sun.color)).toFixed(3) : null,
      skyLuxDelivered: hemi ? +(this.hemi.intensity * lum3(this.hemi.color)).toFixed(3) : null,
      // Every path that carries the sky's diffuse, and how many there are. `paths`
      // is the number the envelope now gates on alongside the total: it turns "is
      // the sky double-counted" from an argument into a count.
      skyDelivery: delivery,
      litPointLights: lights.filter((l) => l.type === 'PointLight' && l.intensity > 0).length,
      lightPool: this.lightPool ? this.lightPool.report() : null,
      environmentIntensity: this.scene.environmentIntensity,
      hasEnvironment: !!this.scene.environment,
      sky: this.skyDome ? this.skyDome.audit() : null,
      weather: this.weatherSys ? this.weatherSys.report() : null,
      samplePointLightCandela: lights.find((l) => l.type === 'PointLight' && l.intensity > 0)?.intensity ?? 0,
      shadowCasters, shadowReceivers,
      implausible: flags,
    };
  }
}

// Relative luminance of a linear THREE.Color, Rec.709 weights. The same function
// sky.js keeps as luminance3(); duplicated rather than exported across the
// boundary because it is three multiplies and a shared helper module for it would
// be the only reason that module existed.
function lum3(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
