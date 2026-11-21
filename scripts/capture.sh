#!/bin/sh
# Captures roam's preview (a made-up move, see mods/roam/preview.js) from the
# running Herdr window, then composes the README assets from it.
#
#   scripts/capture.sh [out-dir]      default: docs/assets
#
# It opens the roam dialog over your window for about 20 seconds. Nothing
# moves: the preview never plans or moves a real space. Only the dialog ends
# up in the assets (see scripts/compose.py).
#
# Keep the Herdr window visible and the screen awake: `herdr-app shot` saves
# the last frame the window drew, and a hidden window stops drawing.
set -eu

out="${1:-docs/assets}"
raw="$(mktemp -d)"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out" "$raw/play"

shot() { herdr-app shot "$1" >/dev/null; }
show() { herdr-app do "roam.preview-$1" >/dev/null; sleep 1; }

herdr-app do mod.open --name roam >/dev/null
sleep 1.5
for view in pick review done failed; do
  show "$view"
  shot "$raw/$view.png"
done

# The move itself, frame by frame.
show review
herdr-app do roam.preview-play >/dev/null
i=0
while [ $i -lt 110 ]; do
  shot "$raw/play/$(printf %04d $i).png"
  i=$((i + 1))
  sleep 0.07
done
herdr-app do overlay.close >/dev/null 2>&1 || true

for view in pick review done failed; do
  python3 "$here/compose.py" still "$raw/$view.png" "$out/$view.png"
done
python3 "$here/compose.py" gif "$raw/play" "$out/demo.gif"
cp "$out/review.png" preview.png
rm -rf "$raw"
echo "assets in $out, preview.png updated"
