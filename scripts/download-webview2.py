#!/usr/bin/env python3
"""Fetch the pinned Microsoft SDK and extract only its x64 native loader."""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

version = "1.0.4258.31"
url = f"https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/{version}/microsoft.web.webview2.{version}.nupkg"
with urllib.request.urlopen(url, timeout=60) as response:
    package = response.read(32 * 1024 * 1024 + 1)
if hashlib.sha256(package).hexdigest() != "56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9":
    raise SystemExit("WebView2 SDK checksum does not match")
output = Path(".zig-cache/webview2/WebView2Loader.dll")
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(io.BytesIO(package)) as archive:
    output.write_bytes(archive.read("build/native/x64/WebView2Loader.dll"))
print(output.resolve())
