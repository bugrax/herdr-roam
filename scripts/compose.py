#!/usr/bin/env python3
"""Turn raw Herdr window shots into README assets.

Only the roam dialog is kept: it is found in each shot, cut out with rounded
corners and placed on a clean background with a soft shadow. Nothing else
from the window (other spaces, terminal text) can end up in an asset.

    python3 scripts/compose.py still <shot.png> <out.png>
    python3 scripts/compose.py gif <frames-dir> <out.gif> [--fps 14] [--hold 2.5]

Needs Pillow; `gif` also needs gifski (brew install gifski).
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

DIALOG_W = 600  # logical px, from mods/roam/mod.json
RADIUS = 12  # logical px
PAD = 56  # logical px around the dialog
BG_TOP = (14, 16, 22)
BG_BOTTOM = (24, 28, 38)


def dialog_box(im):
    """The dialog's rectangle: the popover-colored column just inside its left edge."""
    w, h = im.size
    scale = 2 if w > 3000 else 1
    left = w // 2 - DIALOG_W * scale // 2
    x = left + 8 * scale
    bg = im.getpixel((x, h // 2))
    near = lambda p: all(abs(a - b) <= 3 for a, b in zip(p[:3], bg[:3]))
    runs, start, prev = [], None, None
    for y in range(h):
        if near(im.getpixel((x, y))):
            if start is None:
                start = prev = y
            elif y == prev + 1:
                prev = y
            else:
                runs.append((start, prev))
                start = prev = y
    if start is not None:
        runs.append((start, prev))
    if not runs:
        return None, scale
    top, bottom = max(runs, key=lambda r: r[1] - r[0])
    if bottom - top < 120 * scale:
        return None, scale
    # Only the inside: the run is the popover between the top and bottom
    # borders. The border itself is drawn again by place(), so not one pixel
    # from outside the dialog is kept.
    inset = 2 * scale
    return (left + inset, top, left + DIALOG_W * scale - inset, bottom + 1), scale


def rounded(img, r):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), r, fill=255)
    return mask


def background(size):
    w, h = size
    bg = Image.new("RGB", size, BG_TOP)
    draw = ImageDraw.Draw(bg)
    for y in range(h):
        t = y / max(h - 1, 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    return bg


def place(dialog, scale, canvas_h=None, top=None):
    """The dialog on the background; with canvas_h/top fixed, frames line up."""
    r = RADIUS * scale
    pad = PAD * scale
    w = dialog.size[0] + 2 * pad
    h = canvas_h or dialog.size[1] + 2 * pad
    y0 = top if top is not None else (h - dialog.size[1]) // 2
    x0 = pad
    canvas = background((w, h)).convert("RGBA")
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 10 * scale, x0 + dialog.size[0], y0 + dialog.size[1] + 10 * scale), r, fill=(0, 0, 0, 150))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(18 * scale)))
    canvas.paste(dialog, (x0, y0), rounded(dialog, r))
    # Herdr's thin dialog border, drawn again.
    ImageDraw.Draw(canvas).rounded_rectangle((x0, y0, x0 + dialog.size[0] - 1, y0 + dialog.size[1] - 1), r, outline=(58, 61, 68, 255), width=max(1, scale))
    return canvas.convert("RGB")


def still(src, out):
    im = Image.open(src).convert("RGB")
    box, scale = dialog_box(im)
    if not box:
        sys.exit(f"no dialog in {src}")
    place(im.crop(box), scale).save(out, optimize=True)
    print(out)


def gif(frames_dir, out, fps, hold):
    frames = []
    for path in sorted(glob.glob(os.path.join(frames_dir, "*.png"))):
        im = Image.open(path).convert("RGB")
        box, scale = dialog_box(im)
        if box:
            frames.append((im.crop(box), scale))
    if not frames:
        sys.exit("no frames with a dialog")
    # The review screen before Move is pressed is taller than the move itself:
    # leave it out (it has its own still) so the canvas fits the move.
    first = frames[0][0].size[1]
    if first > frames[-1][0].size[1]:
        while frames and frames[0][0].size[1] == first:
            frames.pop(0)
    scale = frames[0][1]
    tallest = max(d.size[1] for d, _ in frames)
    top = PAD * scale
    canvas_h = tallest + 2 * PAD * scale
    tmp = tempfile.mkdtemp()
    try:
        n = 0
        last = None
        for d, _ in frames:
            last = place(d, scale, canvas_h, top)
            last.save(os.path.join(tmp, f"{n:04d}.png"))
            n += 1
        for _ in range(int(hold * fps)):  # hold the result
            last.save(os.path.join(tmp, f"{n:04d}.png"))
            n += 1
        subprocess.run(
            ["gifski", "--fps", str(fps), "--width", "960", "--quality", "92", "-o", out, *sorted(glob.glob(os.path.join(tmp, "*.png")))],
            check=True,
        )
    finally:
        shutil.rmtree(tmp)
    print(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["still", "gif"])
    ap.add_argument("src")
    ap.add_argument("out")
    ap.add_argument("--fps", type=int, default=14)
    ap.add_argument("--hold", type=float, default=2.5)
    a = ap.parse_args()
    still(a.src, a.out) if a.mode == "still" else gif(a.src, a.out, a.fps, a.hold)
