/**
 * The water column: a sliced-diagram volume sitting on the seabed, with a live
 * surface on top of it.
 *
 * How the surface and the cut walls are kept in register
 * -----------------------------------------------------
 * The obvious worry is that the top face gets displaced by the wave function and the
 * four cut walls do not, so the volume tears open along its top edge. The fix is not
 * to run the distortion twice — it is to make the distortion a function of *where a
 * vertex is in plan*, and nothing else:
 *
 *     y += wave(x, z) * depthMask(y)
 *
 * A vertex at the top edge of a wall has the same (x, z) as the surface vertex above
 * it, so it receives exactly the same offset. They match by construction rather than
 * by being matched, and there is no seam to close because there was never a gap.
 * `depthMask` is 1 at the waterline and falls to 0 further down, so the wave dies out
 * with depth the way a real one does and the base of the volume stays flat on the
 * seabed.
 *
 * The cost is one mesh, one draw call and one shader — the wall vertices run the same
 * code the surface vertices run, and most of them multiply the result by nearly zero.
 * That is cheaper than any scheme that tries to keep two meshes agreeing.
 *
 * Reaching three.js
 * -----------------
 * `three` is not a dependency of this project; the 8th Wall runtime carries its own
 * copy and publishes it as `window.THREE`, which is what its own internals
 * destructure. Using that is not a hack — it is the only way to get the *same* three
 * the renderer is using. A second copy from npm would produce objects the runtime
 * quietly refuses to draw.
 */

import * as ecs from '@8thwall/ecs'

export interface WaterOptions {
  level: number         // waterline, in block units above the target plane
  width: number         // footprint, one block unit
  amplitude: number     // wave height at full calm, block units
  segments: number      // grid resolution across the surface
  depthSegments: number // rows down the cut walls
}

export interface Water {
  mesh: any
  uniforms: any
}

const VERTEX = `
uniform float uTime;
uniform float uHeat;
uniform float uAmp;
uniform float uLevel;
uniform float uVentRadius;

varying float vDepth;      // 0 at the waterline, 1 at the seabed
varying float vCrest;      // signed surface height, for foam
varying float vBoil;
varying vec3  vViewDir;
varying vec3  vNrm;

// --- cheap hashes -----------------------------------------------------------
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Voronoi F1 over the 3x3 neighbourhood. This is the "cellular" part of the
// surface: sine waves alone read as fabric, the cells give it the packed,
// jostling look that water has.
float voronoi(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float d = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      o = 0.5 + 0.5 * sin(uTime * 0.6 + 6.2831 * o);   // cells drift, never freeze
      d = min(d, length(g + o - f));
    }
  }
  return d;
}

// Surface height at a point in plan. Everything below reads from this one
// function, which is what keeps the walls and the surface agreeing.
float surface(vec2 xz, float heat, float vent) {
  float h = 0.0;
  h += sin(xz.x * 11.0 + uTime * 1.70) * 0.34;
  h += sin(xz.y * 13.7 - uTime * 1.30) * 0.28;
  h += sin((xz.x + xz.y) * 17.3 + uTime * 2.30) * 0.16;
  h += (0.5 - voronoi(xz * 9.0)) * 0.85;
  // Restlessness rises with heat everywhere, but the hard boil is over the vent.
  float boil = (0.5 - voronoi(xz * 27.0 + vec2(uTime * 1.7, -uTime * 1.4)));
  h += boil * (0.35 * heat + 2.10 * heat * vent);
  return h;
}

float ventWeight(vec2 xz) {
  return 1.0 - smoothstep(0.0, uVentRadius, length(xz));
}

void main() {
  vec3 p = position;

  // 1 at the waterline, easing to 0 with depth. Squared so the top centimetre
  // carries almost all of the motion and the volume below it stays legible.
  float m = clamp(p.y / max(uLevel, 1e-4), 0.0, 1.0);
  m = m * m * m;

  float vent = ventWeight(p.xz);
  float h = surface(p.xz, uHeat, vent);
  p.y += h * uAmp * m;

  // Surface normal by finite difference on the same function. Three extra
  // evaluations on a few thousand vertices is nothing, and without it the water
  // lights like a flat sheet no matter how much it is moving.
  float e = 0.012;
  float hx = surface(p.xz + vec2(e, 0.0), uHeat, vent);
  float hz = surface(p.xz + vec2(0.0, e), uHeat, vent);
  vec3 nrm = normalize(vec3(
    -(hx - h) * uAmp * m,
    e,
    -(hz - h) * uAmp * m
  ));
  vNrm = normalize(normalMatrix * mix(normal, nrm, m));

  vDepth = 1.0 - clamp(p.y / max(uLevel, 1e-4), 0.0, 1.0);
  vCrest = h;
  vBoil = uHeat * vent;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewDir = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`

const FRAGMENT = `
precision mediump float;

uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uFoam;
uniform vec3  uHot;
uniform float uOpacity;
uniform float uHeat;

varying float vDepth;
varying float vCrest;
varying float vBoil;
varying vec3  vViewDir;
varying vec3  vNrm;

void main() {
  // Thicker water is darker and denser. This is the whole reason the volume is
  // worth drawing rather than just a surface plane: the gradient down the cut
  // face is the diagram.
  vec3 col = mix(uShallow, uDeep, vDepth * vDepth);

  // Warm light climbing through the column above the vent.
  col = mix(col, uHot, clamp(vBoil * (1.0 - vDepth * 0.55), 0.0, 1.0) * 0.55);

  // Foam on the crests, and where it is boiling hard.
  float crest = smoothstep(0.35, 0.95, vCrest);
  float foam = clamp(crest * (1.0 - vDepth) + vBoil * crest * 1.4, 0.0, 1.0);
  col = mix(col, uFoam, foam * 0.8);

  // Glancing angles read as denser water, which is what sells it as a solid
  // volume rather than a blue pane.
  float fres = pow(1.0 - abs(dot(normalize(vNrm), normalize(vViewDir))), 2.5);

  float a = uOpacity;
  a += vDepth * 0.30;                 // the column beneath is more opaque
  a += fres * 0.35;
  a += foam * 0.45;
  a = clamp(a, 0.0, 0.96);

  gl_FragColor = vec4(col, a);
}
`

/**
 * Build the volume and hand back the handle the tick needs.
 *
 * Returns null if the entity's Object3D is not in place yet — the caller is expected
 * to try again on a later frame rather than to assume this cannot fail.
 */
export const createWater = (world, parent: ecs.Eid, o: WaterOptions): Water | null => {
  const THREE = (window as any).THREE
  if (!THREE) {
    return null
  }
  const host = world.three.entityToObject.get(parent)
  if (!host) {
    return null
  }

  const geo = new THREE.BoxGeometry(
    o.width, o.level, o.width, o.segments, o.depthSegments, o.segments
  )
  geo.translate(0, o.level / 2, 0)   // local Y runs 0 at the seabed to `level` at the top

  // Drop the underside. It is coplanar with the base of the sculpt, so it would
  // z-fight along the whole footprint, and nothing can ever see it. BoxGeometry
  // emits one group per face in the order +X -X +Y -Y +Z -Z, so the fourth group
  // is exactly the range to cut.
  const groups = geo.groups
  if (groups.length === 6) {
    const cut = groups[3]
    const src = geo.index.array
    const kept: number[] = []
    for (let i = 0; i < src.length; i++) {
      if (i < cut.start || i >= cut.start + cut.count) {
        kept.push(src[i])
      }
    }
    geo.setIndex(kept)
    geo.clearGroups()
  }

  const uniforms = {
    uTime: {value: 0},
    uHeat: {value: 0},
    uAmp: {value: o.amplitude},
    uLevel: {value: o.level},
    uVentRadius: {value: 0.34},
    uShallow: {value: new THREE.Color(0.32, 0.72, 0.88)},
    uDeep: {value: new THREE.Color(0.02, 0.12, 0.30)},
    uFoam: {value: new THREE.Color(0.88, 0.96, 1.0)},
    uHot: {value: new THREE.Color(0.95, 0.42, 0.16)},
    uOpacity: {value: 0.16},
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    // Both sides, and no depth writing: the far walls have to show through the near
    // ones or it is a blue box rather than a section through a body of water. The
    // sculpt is opaque and drawn first, so it still occludes correctly.
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'Water Volume'
  mesh.renderOrder = 10           // after the opaque sculpt
  mesh.frustumCulled = false      // the shader moves vertices past the bounding box
  host.add(mesh)
  world.three.notifyChanged(host)

  return {mesh, uniforms}
}

export const updateWater = (water: Water, elapsed: number, heat: number) => {
  water.uniforms.uTime.value = elapsed
  water.uniforms.uHeat.value = heat
}

export const disposeWater = (water: Water) => {
  water.mesh.parent?.remove(water.mesh)
  water.mesh.geometry.dispose()
  water.mesh.material.dispose()
}
