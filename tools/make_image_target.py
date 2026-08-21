"""Build an 8th Wall Studio image target from an ordinary photo — no cloud, no editor UI.

An image target in this project is just a small JSON file plus a set of derived
images sitting in ./image-targets. The engine does its own feature extraction at
runtime from the *luminance* image, so all we have to produce is:

    <name>.json            metadata (crop rect, source dimensions)
    <name>_original.png    the untouched source
    <name>_cropped.png     the 3:4 region actually used as the target
    <name>_luminance.png   that crop, greyscale, resampled to 480x640
    <name>_thumbnail.png   editor preview

Usage:
    python tools/make_image_target.py <source-image> <target-name> [--no-crop]

    --no-crop   treat the whole source as the target (it should already be 3:4)

After running, register the target in src/app.js:

    require('../image-targets/<target-name>.json'),

and set the Image Target entity's `name` to <target-name> in the scene.
"""

import json
import os
import sys
import time

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS_DIR = os.path.join(os.path.dirname(HERE), 'image-targets')

# Every target shipped with the 8th Wall template normalises to this size, in
# portrait 3:4. Matching it exactly is the safest thing to do.
LUMINANCE_SIZE = (480, 640)
THUMBNAIL_HEIGHT = 350
ASPECT = 3.0 / 4.0

# The engine only ever loads the luminance image. `_original` and `_cropped` are
# previews for the editor, and every file in image-targets/ is copied into the deploy
# whether it is used or not -- a 2600 px phone photo lands as a 5.6 MB PNG that
# nothing downloads on purpose. Cap them.
PREVIEW_MAX = 800


def centre_crop_3x4(img):
    """Largest centred 3:4 portrait rectangle. Returns (crop, (left, top, w, h))."""
    w, h = img.size
    if w / h > ASPECT:
        # too wide -> trim the sides
        cw = int(round(h * ASPECT))
        ch = h
    else:
        # too tall -> trim top and bottom
        cw = w
        ch = int(round(w / ASPECT))
    left = (w - cw) // 2
    top = (h - ch) // 2
    return img.crop((left, top, left + cw, top + ch)), (left, top, cw, ch)


def shrink(img, longest):
    """Downscale so the longer side is at most `longest`, keeping the aspect."""
    w, h = img.size
    if max(w, h) <= longest:
        return img
    k = longest / max(w, h)
    return img.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def build(source_path, name, crop=True):
    if not os.path.isfile(source_path):
        raise SystemExit(f'no such file: {source_path}')

    os.makedirs(TARGETS_DIR, exist_ok=True)

    src = Image.open(source_path).convert('RGB')
    if crop:
        cropped, (left, top, cw, ch) = centre_crop_3x4(src)
    else:
        cropped = src
        left, top, cw, ch = 0, 0, src.size[0], src.size[1]

    luminance = cropped.convert('L').resize(LUMINANCE_SIZE, Image.LANCZOS)

    thumb_w = int(round(THUMBNAIL_HEIGHT * cropped.size[0] / cropped.size[1]))
    thumbnail = cropped.resize((thumb_w, THUMBNAIL_HEIGHT), Image.LANCZOS)

    out = {
        'original': shrink(src, PREVIEW_MAX),
        'cropped': shrink(cropped, PREVIEW_MAX),
        'luminance': luminance,
        'thumbnail': thumbnail,
    }
    for kind, img in out.items():
        img.save(os.path.join(TARGETS_DIR, f'{name}_{kind}.png'))

    now = int(time.time() * 1000)
    meta = {
        'imagePath': f'image-targets/{name}_luminance.png',
        'resources': {
            'originalImage': f'{name}_original.png',
            'croppedImage': f'{name}_cropped.png',
            'thumbnailImage': f'{name}_thumbnail.png',
            'luminanceImage': f'{name}_luminance.png',
        },
        'name': name,
        'type': 'PLANAR',
        'properties': {
            'top': top,
            'left': left,
            'width': cw,
            'height': ch,
            'isRotated': False,
            'originalWidth': src.size[0],
            'originalHeight': src.size[1],
        },
        'loadAutomatically': True,
        'created': now,
        'updated': now,
        'metadata': None,
    }
    json_path = os.path.join(TARGETS_DIR, f'{name}.json')
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)

    print(f'wrote {json_path}')
    print(f'  source     {src.size[0]}x{src.size[1]}')
    print(f'  crop       {cw}x{ch} at ({left},{top})')
    print(f'  luminance  {LUMINANCE_SIZE[0]}x{LUMINANCE_SIZE[1]}')


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        raise SystemExit(__doc__)
    build(args[0], args[1], crop='--no-crop' not in sys.argv)
