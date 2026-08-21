"""Generate the particle sprite textures for the volcanic seabed.

The ash used to be tetrahedra. At the size a particle is drawn on a phone a
tetrahedron is four flat facets and a hard silhouette, which reads as debris rather
than as smoke however it is coloured — it was the one part of the scene that still
looked like placeholder geometry. A soft, textured, camera-facing quad reads as smoke
at any size, and costs two triangles instead of four.

Both textures are white with the shape carried entirely in the alpha channel, so the
runtime can tint them per particle from the same colour ramp as everything else.

    python tools/make_particle_textures.py

Writes into src/assets/volcanic-seabed/. Deterministic — the seed is fixed, so
re-running produces byte-identical files and does not churn the repo.
"""

import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), 'src', 'assets', 'volcanic-seabed')

SEED = 20260822


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def value_noise(size, cells, rng):
    """One octave of value noise, bilinearly interpolated and smoothstepped."""
    grid = rng.random((cells + 1, cells + 1))
    # Wrap the last row/column onto the first so octaves tile rather than seam.
    grid[-1, :] = grid[0, :]
    grid[:, -1] = grid[:, 0]

    xs = np.linspace(0, cells, size, endpoint=False)
    i = np.floor(xs).astype(int)
    f = smoothstep(xs - i)

    top = grid[i][:, i] * (1 - f)[None, :] + grid[i][:, i + 1] * f[None, :]
    bot = grid[i + 1][:, i] * (1 - f)[None, :] + grid[i + 1][:, i + 1] * f[None, :]
    return top * (1 - f)[:, None] + bot * f[:, None]


def fbm(size, rng, octaves=5, cells=3):
    total = np.zeros((size, size))
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        total += value_noise(size, cells * (2 ** o), rng) * amp
        norm += amp
        amp *= 0.5
    return total / norm


def radial(size, power=1.0):
    """1 at the centre, 0 at the inscribed circle, with a soft shoulder."""
    a = (np.arange(size) + 0.5) / size * 2.0 - 1.0
    r = np.sqrt(a[:, None] ** 2 + a[None, :] ** 2)
    return smoothstep(1.0 - r) ** power


def write_rgba(path, alpha):
    size = alpha.shape[0]
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., 0:3] = 255                       # white; the runtime tints it
    rgba[..., 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(path, optimize=True)
    print('  {}  {}x{}  {:.0f} KB'.format(
        os.path.basename(path), size, size, os.path.getsize(path) / 1024))


def make_smoke(size=256):
    """A wispy puff: fractal noise eaten into by a radial falloff.

    The noise is raised to a power and rescaled so most of the quad is empty and the
    density is concentrated in a few soft lobes — a puff with holes in it, not a
    uniform blob, which is what lets overlapping particles build into a column
    instead of a grey wall.
    """
    rng = np.random.default_rng(SEED)
    # Few octaves and a coarse base: a particle is maybe forty pixels across on a
    # phone, so anything finer than a handful of lobes aliases into static. Five
    # octaves from a 3-cell base gave 5-pixel speckle and looked like sensor noise.
    n = fbm(size, rng, octaves=3, cells=2)
    n = (n - n.min()) / (n.max() - n.min())
    # Dense enough to actually deposit ink. The first version averaged 0.09 alpha
    # across the quad, so a particle at 0.45 material opacity put down about four
    # percent coverage and the column was invisible over bright water. A solid
    # tetrahedron had been doing ten times that.
    a = radial(size, power=0.9) * (0.62 + 0.55 * n ** 0.8)
    a = np.clip(a * 1.15, 0.0, 1.0)
    a *= radial(size, power=0.45)              # guarantee it reaches zero at the edge
    return a


def make_glow(size=128):
    """A hot ember: bright core, fast falloff, faint halo."""
    a = (np.arange(size) + 0.5) / size * 2.0 - 1.0
    r = np.sqrt(a[:, None] ** 2 + a[None, :] ** 2)
    core = np.exp(-(r * 3.4) ** 2)
    halo = smoothstep(1.0 - r) ** 2.2 * 0.32
    return np.clip(core + halo, 0.0, 1.0)


def make_bubble(size=128):
    """A gas bubble: a bright rim with a hollow middle and one highlight."""
    a = (np.arange(size) + 0.5) / size * 2.0 - 1.0
    y, x = a[:, None], a[None, :]
    r = np.sqrt(y ** 2 + x ** 2)
    rim = np.exp(-((r - 0.78) / 0.13) ** 2) * 0.85
    fill = smoothstep((0.86 - r) / 0.5) * 0.13
    # Highlight up and to the left, where the key light is.
    hl = np.exp(-(((x + 0.32) ** 2 + (y + 0.34) ** 2) / 0.020))
    return np.clip(rim + fill + hl * 0.75, 0.0, 1.0) * smoothstep((1.0 - r) * 6.0)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('writing particle textures to ' + OUT_DIR)
    write_rgba(os.path.join(OUT_DIR, 'smoke.png'), make_smoke())
    write_rgba(os.path.join(OUT_DIR, 'ember.png'), make_glow())
    write_rgba(os.path.join(OUT_DIR, 'bubble.png'), make_bubble())


main()
