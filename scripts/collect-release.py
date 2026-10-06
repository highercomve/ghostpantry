#!/usr/bin/env python3
"""Collect Oriel packages with platform-specific names and SHA-256 checksums."""
import hashlib
from pathlib import Path
import shutil
import sys

platform = sys.argv[1]
output = Path("dist")
output.mkdir(exist_ok=True)
roots = [Path("zig-out/package")] if platform != "android" else [
    Path("android/app/build/outputs/apk"), Path("android/app/build/outputs/bundle")
]
collected = []
for root in roots:
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in {".deb", ".rpm", ".appimage", ".dmg", ".exe", ".apk", ".aab"}:
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
