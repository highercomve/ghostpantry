#!/usr/bin/env python3
"""Collect Oriel packages with platform-specific names and SHA-256 checksums."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

platform = sys.argv[1]
output = Path("dist")
output.mkdir(exist_ok=True)
if platform == "android":
    roots = [Path("android/app/build/outputs/apk"), Path("android/app/build/outputs/bundle")]
elif platform == "ios":
    # The unsigned device .ipa and the simulator .app, zipped (release.yml).
    roots = [Path("zig-out/ios-release")]
else:
    roots = [Path("zig-out/package")]
suffixes = {".deb", ".rpm", ".appimage", ".dmg", ".exe", ".apk", ".aab"}
if platform == "ios":
    suffixes = {".ipa", ".zip"}
collected = []
for root in roots:
    for path in sorted(root.rglob("*")):
        if platform == "android" and path.suffix.lower() == ".apk":
            metadata = path.parent / "output-metadata.json"
            if not metadata.exists():
                continue
            current = {element["outputFile"] for element in json.loads(metadata.read_text())["elements"]}
            if path.name not in current:
                continue
        if path.is_file() and path.suffix.lower() in suffixes:
            destination = output / f"ghostpantry-{platform}-{path.name}"
            shutil.copy2(path, destination)
            collected.append(destination)
if not collected:
    raise SystemExit(f"No {platform} packages found")
with (output / f"SHA256SUMS-{platform}").open("w", encoding="utf-8") as checksums:
    for path in collected:
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        checksums.write(f"{digest}  {path.name}\n")
print(f"Collected {len(collected)} {platform} packages")
