#!/usr/bin/env python3
"""
Generate PWA + favicon icons matching the in-app Logo component
(concentric green rings + pulsing core dot, dark navy background).

Run once when the brand mark changes. Outputs land in
frontend/public/. The generated files are not gitignored — they
should be committed so anyone building from a fresh checkout has
the icons.

Run from anywhere:
    python3 frontend/scripts/generate-pwa-icons.py

Required: Pillow (PIL). Install via `pip install Pillow` in your venv.

Why Python: the brand mark is simple geometry (circles), and
generating PNGs deterministically from one script keeps the icons
in lockstep with each other across all sizes. Inkscape /
imagemagick / browser screenshots all introduce subtle drift; this
script gives byte-identical output for the same input.
"""

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


# Brand palette — matches frontend/src/index.css :root vars + the
# Logo component's inline styles in App.jsx.
BG_RGB = (4, 6, 10)              # --bg / theme-color
ACCENT_RGB = (57, 255, 20)       # --accent
ACCENT_GLOW_RGB = (57, 255, 20)  # used for the soft halo behind core

OUT_DIR = Path(__file__).resolve().parents[1] / "public"


def draw_brand_icon(size: int, *, padding_ratio: float = 0.18) -> Image.Image:
    """
    Render the brand mark — two concentric thin rings around a bright
    core dot — into a square RGBA image at `size` x `size`.

    Composition (matches the Logo component):
      - Outer ring  : thin, 30% accent alpha
      - Inner ring  : thin, 55% accent alpha
      - Core dot    : solid accent
      - Soft halo behind core for the "alive" glow

    padding_ratio leaves room around the brand mark so it survives
    Android's maskable-icon cropping (which can shave 20% off each
    edge). 0.18 keeps the design safely inside the inner 64%.
    """
    img = Image.new("RGBA", (size, size), BG_RGB + (255,))

    pad = int(size * padding_ratio)
    inset = pad
    outer_box = (inset, inset, size - inset, size - inset)

    # Outer ring — drawn on its own layer so the ring stroke renders
    # at exactly 1.5% of the icon's edge length, scaling with size.
    ring_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring_layer)
    stroke = max(2, size // 80)

    # Outer ring
    rd.ellipse(outer_box, outline=ACCENT_RGB + (76,), width=stroke)

    # Inner ring — 18% smaller than outer
    inner_inset = inset + (size - 2 * inset) * 0.18
    inner_box = (inner_inset, inner_inset, size - inner_inset, size - inner_inset)
    rd.ellipse(inner_box, outline=ACCENT_RGB + (140,), width=stroke)

    img.alpha_composite(ring_layer)

    # Soft halo behind the core dot — gives the "alive" glow that the
    # in-app Logo gets from the .glow-pulse CSS animation. We can't
    # animate a static icon, but the halo carries the same vibe.
    halo_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo_layer)
    halo_radius = (size - 2 * inset) * 0.18
    center = (size // 2, size // 2)
    hd.ellipse(
        (
            center[0] - halo_radius,
            center[1] - halo_radius,
            center[0] + halo_radius,
            center[1] + halo_radius,
        ),
        fill=ACCENT_GLOW_RGB + (130,),
    )
    halo_layer = halo_layer.filter(ImageFilter.GaussianBlur(radius=size * 0.04))
    img.alpha_composite(halo_layer)

    # Core dot — solid bright accent. 12% of the icon's edge length.
    core_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core_layer)
    core_radius = (size - 2 * inset) * 0.13
    cd.ellipse(
        (
            center[0] - core_radius,
            center[1] - core_radius,
            center[0] + core_radius,
            center[1] + core_radius,
        ),
        fill=ACCENT_RGB + (255,),
    )
    img.alpha_composite(core_layer)

    return img


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # PWA + favicon + apple-touch sizes. The 192 and 512 are required
    # by Chrome for install-prompt eligibility; 180 is the canonical
    # iOS apple-touch-icon size; 32 + 16 cover legacy browser favicons.
    targets = [
        ("icon-512.png", 512),
        ("icon-192.png", 192),
        ("apple-touch-icon.png", 180),
        ("favicon-32.png", 32),
        ("favicon-16.png", 16),
    ]

    for filename, size in targets:
        icon = draw_brand_icon(size)
        out = OUT_DIR / filename
        icon.save(out, "PNG", optimize=True)
        print(f"  wrote {out.relative_to(OUT_DIR.parents[1])}  ({size}x{size}, {out.stat().st_size} bytes)")

    print(f"\nDone. {len(targets)} icons written to {OUT_DIR.relative_to(OUT_DIR.parents[1])}/")


if __name__ == "__main__":
    main()
