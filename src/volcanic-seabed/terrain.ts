/**
 * A sampled read of the sculpt, so the rest of the scene can sit *on* it instead of
 * guessing where it is.
 *
 * Everything that used to float — the vent, the lava seams, the LEDs — floated for
 * the same reason: the code knew the shape it wanted the terrain to be (a cone with a
 * summit at a known height) and the terrain stopped being that shape the moment a
 * sculpt replaced it. Rather than keep a second, wrong model of the surface in the
 * TypeScript, read the real one once the GLB has loaded.
 *
 * Two heights are kept per cell, not one. The seabed swells as it heats, by up to
 * 140 mm on the current sculpt, so "where is the surface" has two answers and the
 * live one is between them. `heightAt` takes the morph influence and interpolates —
 * which is exact, because the morph itself is linear in that influence.
 *
 * A grid rather than raycasting: 30,000 vertices splat into it once, and every lookup
 * afterwards is four reads and a lerp. Raycasting the mesh per formation per frame
 * would be the same answer for a great deal more work, and would have to be redone
 * anyway every time the morph moved.
 */

export interface TerrainField {
  n: number
  /** Surface height with the swell fully retracted. */
  rest: Float32Array
  /** Surface height with the swell fully applied. */
  full: Float32Array
  /** The vertex mask the converter baked — 1 where the sculpt is hottest. */
  mask: Float32Array
  min: number
  max: number
  /**
   * Mask-weighted centroid of the plate, in block units.
   *
   * The mask saturates at 1 across roughly a third of the footprint, and inside that
   * plateau its gradient is exactly zero — so a formation that spawns in the middle
   * of the hot band has no downhill to follow and would only jitter. Pointing away
   * from this centroid gives it a direction until it reaches the edge of the plateau
   * and the real gradient takes over.
   */
  hotX: number
  hotZ: number
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Cell index from a plan position in block units, footprint centred on the origin. */
const cellOf = (n: number, v: number) => clamp(Math.floor((v + 0.5) * n), 0, n - 1)

/**
 * Fill cells no vertex landed in.
 *
 * Decimation leaves the vertex distribution uneven, so at 56 x 56 roughly one cell in
 * twelve comes out empty. Left alone those read as holes in the surface and anything
 * sitting on them drops through. Dilating from filled neighbours a few times closes
 * them; the values are approximate but the alternative is a visible hole.
 */
const fillHoles = (n: number, a: Float32Array, empty: Uint8Array) => {
  const pending = new Uint8Array(empty)
  for (let pass = 0; pass < 8; pass++) {
    let filled = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        if (!pending[k]) {
          continue
        }
        let sum = 0
        let count = 0
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di
            const jj = j + dj
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) {
              continue
            }
            const kk = jj * n + ii
            if (pending[kk]) {
              continue
            }
            sum += a[kk]
            count++
          }
        }
        if (count) {
          a[k] = sum / count
          pending[k] = 0
          filled++
        }
      }
    }
    if (!filled) {
      break
    }
  }
}

/**
 * Build the field from a loaded glTF mesh.
 *
 * Expects the geometry the converter produces: a `_mask` attribute and a single
 * morph target. Returns null if either is missing rather than half-working, because
 * a silently flat terrain field is worse than none.
 */
export const buildTerrainField = (mesh: any, n = 56): TerrainField | null => {
  const geo = mesh?.geometry
  const pos = geo?.attributes?.position
  const mask = geo?.attributes?._mask
  const morph = geo?.morphAttributes?.position?.[0]
  if (!pos || !mask) {
    return null
  }

  const cells = n * n
  const rest = new Float32Array(cells).fill(-1e9)
  const full = new Float32Array(cells).fill(-1e9)
  const mk = new Float32Array(cells)
  const empty = new Uint8Array(cells).fill(1)

  for (let i = 0; i < pos.count; i++) {
    const k = cellOf(n, pos.getZ(i)) * n + cellOf(n, pos.getX(i))
    const y = pos.getY(i)
    if (y > rest[k]) {
      rest[k] = y
      mk[k] = mask.getX(i)
      empty[k] = 0
    }
    const yf = y + (morph ? morph.getY(i) : 0)
    if (yf > full[k]) {
      full[k] = yf
    }
  }

  fillHoles(n, rest, empty)
  fillHoles(n, full, empty)
  fillHoles(n, mk, empty)

  let min = Infinity
  let max = -Infinity
  let cx = 0
  let cz = 0
  let totalWeight = 0
  for (let k = 0; k < cells; k++) {
    if (rest[k] < min) {
      min = rest[k]
    }
    if (full[k] > max) {
      max = full[k]
    }
    const wgt = mk[k]
    if (wgt > 0) {
      // Cell centres in block units, weighted by the mask — the same centroid the
      // mask itself describes, rather than wherever the grid happens to be dense.
      cx += (((k % n) + 0.5) / n - 0.5) * wgt
      cz += ((Math.floor(k / n) + 0.5) / n - 0.5) * wgt
      totalWeight += wgt
    }
  }
  const w = totalWeight || 1

  return {n, rest, full, mask: mk, min, max, hotX: cx / w, hotZ: cz / w}
}

/** Bilinear sample, so a formation crossing a cell boundary does not step. */
const sample = (f: TerrainField, a: Float32Array, x: number, z: number) => {
  const n = f.n
  const fx = clamp((x + 0.5) * n - 0.5, 0, n - 1)
  const fz = clamp((z + 0.5) * n - 0.5, 0, n - 1)
  const i0 = Math.floor(fx)
  const j0 = Math.floor(fz)
  const i1 = Math.min(i0 + 1, n - 1)
  const j1 = Math.min(j0 + 1, n - 1)
  const tx = fx - i0
  const tz = fz - j0
  const a00 = a[j0 * n + i0]
  const a10 = a[j0 * n + i1]
  const a01 = a[j1 * n + i0]
  const a11 = a[j1 * n + i1]
  return (a00 * (1 - tx) + a10 * tx) * (1 - tz) + (a01 * (1 - tx) + a11 * tx) * tz
}

/** Surface height at a plan position, for the current swell influence (0..1). */
export const heightAt = (f: TerrainField, x: number, z: number, influence: number) => {
  const r = sample(f, f.rest, x, z)
  const u = sample(f, f.full, x, z)
  return r + (u - r) * influence
}

export const maskAt = (f: TerrainField, x: number, z: number) => sample(f, f.mask, x, z)

/**
 * Direction of steepest *increase* in the mask, normalised.
 *
 * The formations travel along the negative of this: away from the hot ridge, out
 * towards the cold rock where they set.
 */
export const maskGradient = (f: TerrainField, x: number, z: number): [number, number] => {
  const e = 1.5 / f.n
  const gx = maskAt(f, x + e, z) - maskAt(f, x - e, z)
  const gz = maskAt(f, x, z + e) - maskAt(f, x, z - e)
  const len = Math.hypot(gx, gz)
  if (len > 1e-4) {
    return [gx / len, gz / len]
  }
  // Flat: either deep inside the saturated hot band or out on cold rock. Point back
  // towards the centre of the band, so the caller moving *down* the gradient still
  // heads outwards. Measured on the current sculpt, six of twenty-six formations
  // spawn somewhere this matters.
  const dx = x - f.hotX
  const dz = z - f.hotZ
  const d = Math.hypot(dx, dz)
  return d < 1e-4 ? [0, 0] : [-dx / d, -dz / d]
}

/**
 * Pick a plan position with probability following the mask, by rejection sampling.
 *
 * Falls back to the best of its attempts rather than looping forever — with a mask
 * that peaks at 1 this converges in a handful of tries, but a mask that was painted
 * mostly dark could otherwise spin.
 */
/**
 * Choose `count` vent positions spread along the hot ridge.
 *
 * Farthest-point sampling over the cells the mask calls hottest: start at the
 * strongest cell, then repeatedly take the hot cell furthest from everything chosen
 * so far. On a mask that saturates across a band — which is what a painted vertex
 * group looks like — that lands the vents along its length instead of clustering them
 * all at the centroid, which is what a plain "pick the top N cells" would do.
 */
export const pickVents = (
  f: TerrainField,
  count: number,
  seed: {x: number, z: number},
  minWeight = 0.8,
  inset = 0.34
): {x: number, z: number}[] => {
  const n = f.n
  const hot: {x: number, z: number, w: number}[] = []
  for (let k = 0; k < n * n; k++) {
    const w = f.mask[k]
    if (w < minWeight) {
      continue
    }
    const x = ((k % n) + 0.5) / n - 0.5
    const z = (Math.floor(k / n) + 0.5) / n - 0.5
    // Stay off the rim. Pure farthest-point sampling walks straight to the corners of
    // the footprint, which put two of three vents half inside the edge of the block
    // with their columns rising outside it.
    if (Math.abs(x) > inset || Math.abs(z) > inset) {
      continue
    }
    hot.push({x, z, w})
  }

  // The first vent is the one that was tuned by hand; the rest are found around it.
  const chosen = [{x: seed.x, z: seed.z}]
  if (!hot.length) {
    return chosen
  }

  while (chosen.length < Math.max(1, count)) {
    let best = null
    let bestScore = -1
    for (const c of hot) {
      let d = Infinity
      for (const q of chosen) {
        d = Math.min(d, Math.hypot(c.x - q.x, c.z - q.z))
      }
      // Distance from the vents already placed, weighted by how hot the cell is:
      // spread out, but stay on the ridge rather than running to the quietest corner
      // of the region that happens to clear the threshold.
      const score = d * c.w
      if (score > bestScore) {
        bestScore = score
        best = c
      }
    }
    if (!best || bestScore < 0.02) {
      break
    }
    chosen.push({x: best.x, z: best.z})
  }
  return chosen
}

export const sampleHotPoint = (
  f: TerrainField,
  rng: () => number,
  minWeight = 0.35
): [number, number] => {
  let bx = 0
  let bz = 0
  let best = -1
  for (let attempt = 0; attempt < 48; attempt++) {
    const x = rng() - 0.5
    const z = rng() - 0.5
    const w = maskAt(f, x, z)
    if (w > best) {
      best = w
      bx = x
      bz = z
    }
    if (w >= minWeight && rng() < w) {
      return [x, z]
    }
  }
  return [bx, bz]
}
