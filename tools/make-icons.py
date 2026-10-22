"""Regenerate the extension's original vector-like icons (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
destination = root / "icons"
destination.mkdir(exist_ok=True)
image = Image.new("RGBA", (512, 512))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 511, 511), radius=126, fill="#18745c")
for y, end in ((156, 363), (256, 307), (356, 251)):
    draw.ellipse((116, y - 14, 144, y + 14), fill="#c5e3d2")
    draw.rounded_rectangle((183, y - 14, end, y + 14), radius=14, fill="#ffffff")
for size in (16, 32, 48, 128):
    image.resize((size, size), Image.Resampling.LANCZOS).save(destination / f"icon-{size}.png")
print("Created 16, 32, 48 and 128 px icons.")
