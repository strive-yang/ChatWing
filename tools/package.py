"""Package manifest-declared runtime files and their license into dist/."""
import json
from pathlib import Path, PurePosixPath
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
package = json.loads((root / "package.json").read_text(encoding="utf-8"))
version = manifest["version"]
if version != package["version"]:
    raise SystemExit("Version mismatch: manifest.json and package.json must match.")

files = {"manifest.json", "LICENSE", *manifest["icons"].values()}
for content_script in manifest["content_scripts"]:
    files.update(content_script.get("js", []))
    files.update(content_script.get("css", []))

# A manifest-derived allowlist keeps tests, docs and local files out of releases.
contents = {}
for name in sorted(files):
    path = PurePosixPath(name)
    if (
        path.is_absolute()
        or ".." in path.parts
        or "\\" in name
        or (name not in {"manifest.json", "LICENSE"} and path.parts[0] not in {"content", "icons"})
    ):
        raise SystemExit(f"Invalid release path: {name}")
    source = root / name
    if not source.resolve().is_relative_to(root):
        raise SystemExit(f"Release file is outside the project: {name}")
    contents[name] = source.read_bytes()

destination = root / "dist" / f"ChatWing-{version}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for name, data in contents.items():
        # Stable metadata makes repeated packages of the same files identical.
        info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
print(destination)
