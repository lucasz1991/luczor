"""Generate Luczor's vector mark and a small, looping brand animation.

Requires Pillow and CairoSVG. Run from the workspace root with:
    py -3 app/scripts/generate-luczor-brand.py --sync-admin

The vector paths follow the selected blue/violet concept. The GIF only varies
segment brightness; the emblem stays still and readable at small sizes. After
regenerating assets, update Tauri's native icons from public/brand/luczor-icon.png.
"""

from __future__ import annotations

import argparse
import io
import math
import shutil
from pathlib import Path

import cairosvg
from PIL import Image


APP_ROOT = Path(__file__).resolve().parents[1]
BRAND_DIR = APP_ROOT / "public" / "brand"
ADMIN_BRAND_DIR = APP_ROOT.parent / "admin_api_app" / "public" / "brand"

DEFS = """
  <defs>
    <linearGradient id="lz-blue" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#359ffa"/>
      <stop offset="1" stop-color="#586cf6"/>
    </linearGradient>
    <linearGradient id="lz-top" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#5475f8"/>
      <stop offset="1" stop-color="#9859ef"/>
    </linearGradient>
    <linearGradient id="lz-right" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#825cf0"/>
      <stop offset="1" stop-color="#9858ec"/>
    </linearGradient>
    <linearGradient id="lz-bottom" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#3b9ff9"/>
      <stop offset="1" stop-color="#7665f2"/>
    </linearGradient>
  </defs>
"""

# Four interlocked blades; the fifth, smaller facet gives the upper blade depth.
SEGMENTS = (
    ("left", "M150 0V251l66 67H57l-21-22V98Z", "url(#lz-blue)"),
    ("top", "M171 68h190l94 100H239l-68 64Z", "url(#lz-top)"),
    ("top-facet", "M171 68l68 100-68 64Z", "#496ff6"),
    ("right", "M250 188h111l67 69v135l-109 93V258Z", "url(#lz-right)"),
    ("bottom", "M0 331h231l67-60v162H92Z", "url(#lz-bottom)"),
)

# GIF uses stable flat colors so palette quantization cannot make gradients flicker.
GIF_COLORS = ("#448df8", "#7668f4", "#496ff6", "#8d5cf0", "#5d7ef6")


def svg_markup(*, icon: bool, brightness: tuple[float, ...] | None = None) -> str:
    title = "Luczor App-Icon" if icon else "Luczor Symbol"
    background = (
        '<rect x="4" y="4" width="504" height="504" rx="108" '
        'fill="#0b0d18" stroke="#22243a" stroke-width="3"/>'
        if icon
        else ""
    )
    blades = "\n".join(
        f'<path id="lz-{name}" d="{path}" '
        f'fill="{GIF_COLORS[index] if brightness else fill}" '
        f'opacity="{brightness[index] if brightness else 1:.3f}"/>'
        for index, (name, path, fill) in enumerate(SEGMENTS)
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512" role="img" aria-labelledby="title">\n'
        f"  <title id=\"title\">{title}</title>\n"
        f"{DEFS}  {background}\n"
        '  <g transform="translate(60 47) scale(.86)">\n'
        f"    {blades}\n"
        "  </g>\n</svg>\n"
    )


def render_gif(path: Path) -> None:
    frames: list[Image.Image] = []
    for frame in range(36):
        phase = 2 * math.pi * frame / 36
        levels = tuple(
            0.64 + 0.36 * (0.5 + 0.5 * math.cos(phase - blade * math.pi / 2))
            for blade in (0, 1, 1, 2, 3)
        )
        png = cairosvg.svg2png(
            bytestring=svg_markup(icon=True, brightness=levels).encode("utf-8"),
            output_width=256,
            output_height=256,
        )
        rendered = Image.open(io.BytesIO(png)).convert("RGBA")
        backdrop = Image.new("RGBA", rendered.size, (11, 11, 17, 255))
        backdrop.alpha_composite(rendered)
        frames.append(backdrop.convert("RGB"))

    palette_sheet = Image.new("RGB", (256 * 6, 256 * 6))
    for index, frame in enumerate(frames):
        palette_sheet.paste(frame, ((index % 6) * 256, (index // 6) * 256))
    palette = palette_sheet.quantize(colors=128, dither=Image.Dither.NONE)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    indexed[0].save(
        path,
        save_all=True,
        append_images=indexed[1:],
        duration=90,
        loop=0,
        disposal=2,
        optimize=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sync-admin", action="store_true", help="copy browser assets to sibling admin_api_app")
    args = parser.parse_args()

    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    mark_svg = BRAND_DIR / "luczor-mark.svg"
    icon_svg = BRAND_DIR / "luczor-icon.svg"
    icon_png = BRAND_DIR / "luczor-icon.png"
    gif = BRAND_DIR / "luczor-animated.gif"
    favicon = APP_ROOT / "public" / "favicon.ico"
    mark_svg.write_text(svg_markup(icon=False), encoding="utf-8")
    icon_svg.write_text(svg_markup(icon=True), encoding="utf-8")
    cairosvg.svg2png(
        bytestring=svg_markup(icon=True).encode("utf-8"),
        write_to=str(icon_png),
        output_width=512,
        output_height=512,
    )
    Image.open(icon_png).save(
        favicon,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    render_gif(gif)

    if args.sync_admin:
        if not ADMIN_BRAND_DIR.parent.is_dir():
            raise SystemExit(f"Admin public directory missing: {ADMIN_BRAND_DIR.parent}")
        ADMIN_BRAND_DIR.mkdir(parents=True, exist_ok=True)
        for asset in (mark_svg, icon_svg, icon_png, gif):
            shutil.copy2(asset, ADMIN_BRAND_DIR / asset.name)
        shutil.copy2(favicon, ADMIN_BRAND_DIR.parent / favicon.name)

    for asset in (mark_svg, icon_svg, icon_png, gif, favicon):
        print(f"Generated {asset}")


if __name__ == "__main__":
    main()
