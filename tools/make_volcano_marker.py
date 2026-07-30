"""Generate a printable stand-in for the hand-painted base of the Underwater Volcano block.

This is scaffolding, not artwork: it exists so the AR side can be built and tested
before any resin is poured. When the real base plate is painted, photograph it and
run tools/make_image_target.py on the photo instead — nothing else changes.

The pattern is designed for what image tracking actually needs:
  * features large enough to survive the 480x640 downsample the tracker works on
  * high local contrast, spread over the whole plate rather than clustered
  * nothing repeating or symmetric, so pose is unambiguous

Output: print/volcano-base.png at 1200x1600 (100 x 133 mm at 300 dpi, fits A6).

Usage:
    python tools/make_volcano_marker.py
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, 'print')
OUT_PATH = os.path.join(OUT_DIR, 'volcano-base.png')

W, H = 1200, 1600
SEED = 20260729

BASALT = (26, 24, 28)
ASH = (188, 182, 176)
LAVA = (255, 122, 34)
LAVA_CORE = (255, 232, 168)


def overlay(size):
    return Image.new('RGBA', size, (0, 0, 0, 0))


def mottle(img, rng):
    """Uneven volcanic sand: broad tonal blotches, low frequency."""
    layer = overlay(img.size)
    d = ImageDraw.Draw(layer)
    for _ in range(90):
        r = rng.randint(90, 320)
        x, y = rng.randint(-100, W + 100), rng.randint(-100, H + 100)
        v = rng.randint(10, 70)
        d.ellipse((x - r, y - r, x + r, y + r), fill=(v, v - 2, v + 4, rng.randint(30, 70)))
    layer = layer.filter(ImageFilter.GaussianBlur(40))
    img.alpha_composite(layer)


def pebbles(img, rng):
    """Scattered grains and rocks. The main source of trackable corners."""
    layer = overlay(img.size)
    d = ImageDraw.Draw(layer)
    for _ in range(190):
        cx, cy = rng.randint(40, W - 40), rng.randint(40, H - 40)
        r = rng.randint(9, 44)
        squash = rng.uniform(0.55, 1.0)
        box = (cx - r, cy - r * squash, cx + r, cy + r * squash)
        tone = rng.choice([rng.randint(120, 215), rng.randint(120, 215), rng.randint(28, 60)])
        d.ellipse(box, fill=(tone, tone - rng.randint(0, 12), tone - rng.randint(0, 20), 255))
        # a dark rim turns each blob into a pair of strong edges
        d.ellipse(box, outline=(12, 10, 12, 235), width=max(2, r // 9))
    img.alpha_composite(layer)


def slabs(img, rng):
    """Angular basalt plates: long straight edges, good for pose stability."""
    layer = overlay(img.size)
    d = ImageDraw.Draw(layer)
    for _ in range(11):
        cx, cy = rng.randint(90, W - 90), rng.randint(90, H - 90)
        n = rng.randint(5, 7)
        base = rng.uniform(0, math.tau)
        pts = []
        for i in range(n):
            a = base + i * math.tau / n + rng.uniform(-0.28, 0.28)
            rad = rng.randint(70, 185)
            pts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad * rng.uniform(0.6, 1.0)))
        d.polygon(pts, fill=(16, 15, 18, 225))
        d.line(pts + [pts[0]], fill=(150, 146, 150, 200), width=rng.randint(3, 7), joint='curve')
    img.alpha_composite(layer)


def veins(img, rng):
    """Cracked lava: branching walks, drawn hot core over a wide glow."""
    glow = overlay(img.size)
    gd = ImageDraw.Draw(glow)
    core = overlay(img.size)
    cd = ImageDraw.Draw(core)

    def walk(x, y, angle, length, width, depth):
        steps = max(4, int(length / 26))
        for _ in range(steps):
            angle += rng.uniform(-0.42, 0.42)
            nx, ny = x + math.cos(angle) * 26, y + math.sin(angle) * 26
            gd.line((x, y, nx, ny), fill=LAVA + (215,), width=int(width * 2.6))
            cd.line((x, y, nx, ny), fill=LAVA_CORE + (255,), width=max(2, int(width * 0.62)))
            x, y = nx, ny
            if depth < 2 and rng.random() < 0.16:
                walk(x, y, angle + rng.choice([-1, 1]) * rng.uniform(0.6, 1.2),
                     length * 0.5, width * 0.6, depth + 1)
            if not (-60 < x < W + 60 and -60 < y < H + 60):
                return

    for _ in range(13):
        walk(rng.randint(60, W - 60), rng.randint(60, H - 60),
             rng.uniform(0, math.tau), rng.randint(220, 620), rng.uniform(5, 10), 0)

    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(9)))
    img.alpha_composite(core)


def glyphs(img, rng):
    """A handful of large, one-off shapes. Cheap insurance against a featureless region."""
    layer = overlay(img.size)
    d = ImageDraw.Draw(layer)
    spots = [(215, 300), (930, 470), (300, 940), (880, 1180), (520, 1420), (150, 1180)]
    for i, (cx, cy) in enumerate(spots):
        r = rng.randint(70, 115)
        if i % 3 == 0:
            d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=ASH + (255,), width=15)
        elif i % 3 == 1:
            pts = [(cx, cy - r), (cx + r, cy + r * 0.7), (cx - r * 0.8, cy + r * 0.9)]
            d.polygon(pts, outline=ASH + (255,), width=14)
        else:
            d.arc((cx - r, cy - r, cx + r, cy + r), rng.randint(0, 180),
                  rng.randint(200, 340), fill=ASH + (255,), width=18)
    img.alpha_composite(layer)


def frame(img):
    """Quiet dark margin so the paper edge and table are never mistaken for the target."""
    d = ImageDraw.Draw(img)
    m = 26
    d.rectangle((0, 0, W, m), fill=BASALT + (255,))
    d.rectangle((0, H - m, W, H), fill=BASALT + (255,))
    d.rectangle((0, 0, m, H), fill=BASALT + (255,))
    d.rectangle((W - m, 0, W, H), fill=BASALT + (255,))
    # single asymmetric corner tick: tells a human which way is up
    d.rectangle((m, m, m + 96, m + 26), fill=ASH + (255,))
    d.rectangle((m, m, m + 26, m + 96), fill=ASH + (255,))


def main():
    rng = random.Random(SEED)
    img = Image.new('RGBA', (W, H), BASALT + (255,))

    mottle(img, rng)
    slabs(img, rng)
    veins(img, rng)
    pebbles(img, rng)
    glyphs(img, rng)
    frame(img)

    os.makedirs(OUT_DIR, exist_ok=True)
    img.convert('RGB').save(OUT_PATH)
    print(f'wrote {OUT_PATH}  ({W}x{H}, ~100x133 mm at 300 dpi)')


if __name__ == '__main__':
    main()
