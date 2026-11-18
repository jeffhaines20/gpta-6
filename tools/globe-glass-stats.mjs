// #142 round 2: the globe statistics of tools/globe-glass.mjs, in a module of their own so the gate's page
// (tools/globe-glass.html) reads its frames with the SAME code the tool reads the district's with. No node
// imports: a browser loads this file as it is. The definitions are stated in tools/globe-glass.mjs's header.
export const CAP = 0.4, OCCLUDER = 0.25, EDGE = 0.7;

/** sRGB byte -> linear, as a table. */
export function decodeLUT() {
  const L = new Float64Array(256);
  for (let v = 0; v < 256; v++) { const c = v / 255; L[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  return L;
}

/**
 * The three statistics of one globe. `img` is { width, height, channels, data } of sRGB bytes, `channels` 3 or 4
 * (readPNG returns 3 for these screenshots; a hardcoded 4 misaligns every sample, CLAUDE.md). `g` is
 * { cx, cy, r } in pixels (centre at pixel-centre coordinates x + 0.5) and optionally `box` [x0, x1, y0, y1]
 * inclusive; `sky` a box [x0, x1, y0, y1]. Throws on a non-finite sample.
 */
export function globeStats(img, g, sky, opts = {}) {
  const cap = opts.cap ?? CAP, occ = opts.occluder ?? OCCLUDER, edge = opts.edge ?? EDGE;
  const C = img.channels, W = img.width, H = img.height, L = opts.lut ?? decodeLUT();
  if (!(C === 3 || C === 4)) throw new Error(`globeStats: ${C} channels`);
  const px = (x, y) => {
    const i = (y * W + x) * C;
    const r = L[img.data[i]], gg = L[img.data[i + 1]], b = L[img.data[i + 2]];
    const Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    if (!Number.isFinite(Y)) throw new Error(`globeStats: non-finite sample at ${x},${y}`);
    return { r, g: gg, b, Y };
  };
  const [bx0, bx1, by0, by1] = g.box ?? [Math.floor(g.cx - g.r), Math.ceil(g.cx + g.r), Math.floor(g.cy - g.r), Math.ceil(g.cy + g.r)];
  const pts = [];
  for (let y = Math.max(0, by0); y <= Math.min(H - 1, by1); y++) {
    for (let x = Math.max(0, bx0); x <= Math.min(W - 1, bx1); x++) {
      const dx = (x + 0.5 - g.cx) / g.r, dy = (y + 0.5 - g.cy) / g.r;
      if (Math.hypot(dx, dy) > 1 - edge / g.r) continue;
      pts.push({ x, y, ny: -dy, ...px(x, y) });
    }
  }
  if (!pts.length) return { n: 0 };
  const med = pts.map((p) => p.Y).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
  const keep = pts.filter((p) => p.Y > occ * med);
  const T = keep.filter((p) => p.ny > cap), U = keep.filter((p) => p.ny < -cap);
  const mean = (A, k) => A.reduce((s, p) => s + p[k], 0) / A.length;
  let s = 0, n = 0;
  for (let y = sky[2]; y <= sky[3]; y++) for (let x = sky[0]; x <= sky[1]; x++) { s += px(x, y).Y; n++; }
  const skyY = s / n;
  const uR = U.length ? mean(U, 'r') : NaN, uG = U.length ? mean(U, 'g') : NaN, uB = U.length ? mean(U, 'b') : NaN;
  return {
    n: keep.length, occluded: pts.length - keep.length, top: T.length, under: U.length,
    topY: T.length ? mean(T, 'Y') : null, underY: U.length ? mean(U, 'Y') : null,
    underOverTop: T.length && U.length ? mean(U, 'Y') / mean(T, 'Y') : null,
    cast: U.length ? (uR - uB) / (uR + uG + uB) : null,
    globeOverSky: keep.length ? mean(keep, 'Y') / skyY : null, skyY,
    // the globe's own mean, so a frame with a black sky still has one; and over EVERY disc pixel, occluders and
    // all, for a globe so dark that the occluder rule (a fraction of its own median) has nothing to keep
    globeY: keep.length ? mean(keep, 'Y') : null, allY: mean(pts, 'Y'),
  };
}
