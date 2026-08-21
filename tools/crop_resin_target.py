# -*- coding: utf-8 -*-
"""Crop the resin photo to its interior and report how trackable it looks.

    python tools/crop_resin_target.py
    python tools/make_image_target.py print/resin-block.jpg resin-block


Two problems with feeding the cutout straight to the target builder:

  * The white background is not part of the object. Feature extraction would find a
    strong outline there that does not exist when the real block is on a table, and
    would then fail to match it.
  * The ragged edge of the pour is the least repeatable part of the object — it
    catches the light differently from every angle.

Background is found by flooding in from the border rather than by thresholding
colour: the top right of this pour is pale enough that a plain "is it near white"
test eats a third of the interior, and the largest clean rectangle came out as a
1212x180 strip.
"""
import os
from collections import deque

import numpy as np
from PIL import Image

SRC = 'print/IMG_TARGET.jpg'
OUT = 'print/resin-block.jpg'

im = Image.open(SRC).convert('RGB')
a = np.asarray(im).astype(np.int16)
h, w, _ = a.shape
print('source %dx%d' % (w, h))

mx = a.max(axis=2)
mn = a.min(axis=2)
paleish = (mx > 215) & ((mx - mn) < 42)

# Flood from the border, so only pale pixels *connected to the outside* count.
bg = np.zeros((h, w), bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if paleish[y, x] and not bg[y, x]:
            bg[y, x] = True
            q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if paleish[y, x] and not bg[y, x]:
            bg[y, x] = True
            q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and paleish[ny, nx] and not bg[ny, nx]:
            bg[ny, nx] = True
            q.append((ny, nx))
print('background reached from the border: %.1f%% of the frame' % (bg.mean() * 100))

# Inset a centred box until it holds no background at all. A centred crop keeps the
# proportions of the pour; a maximal-area rectangle happily returns a thin strip.
lo, hi = 0, min(h, w) // 2
while lo < hi:
    mid = (lo + hi) // 2
    if bg[mid:h - mid, mid:w - mid].any():
        lo = mid + 1
    else:
        hi = mid
inset = lo + int(0.012 * min(h, w))          # a little more, off the ragged edge
crop = im.crop((inset, inset, w - inset, h - inset))
print('inset %d px -> %dx%d (%.0f%% of each side kept)'
      % (inset, crop.size[0], crop.size[1], crop.size[0] / w * 100))
# JPEG, not PNG: this is a phone photograph, and the PNG of it was 5.6 MB. The
# target builder resamples it to 480x640 greyscale anyway, so the last few percent of
# fidelity here buys nothing and costs the repo five megabytes.
crop.save(OUT, quality=94, subsampling=0)
print('wrote ' + OUT)

# --- how trackable does it look? -------------------------------------------------
g = np.asarray(crop.convert('L')).astype(np.float32)
gx = np.abs(np.diff(g, axis=1))[:-1, :]
gy = np.abs(np.diff(g, axis=0))[:, :-1]
grad = np.sqrt(gx ** 2 + gy ** 2)
strong = grad > 12
print('\ntrackability proxies (higher is better):')
print('  contrast       std %.1f of 255' % g.std())
print('  mean gradient  %.2f' % grad.mean())
print('  strong edges   %.1f%% of pixels' % (strong.mean() * 100))

gh, gw = 6, 6
cell = np.zeros((gh, gw))
for j in range(gh):
    for i in range(gw):
        sub = strong[j * strong.shape[0] // gh:(j + 1) * strong.shape[0] // gh,
                     i * strong.shape[1] // gw:(i + 1) * strong.shape[1] // gw]
        cell[j, i] = sub.mean() * 100
print('  strong edges per cell, 6x6 over the crop:')
for row in cell:
    print('    ' + ' '.join('%5.1f' % v for v in row))
print('  cells under 2%%: %d of 36' % int((cell < 2.0).sum()))
