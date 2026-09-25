#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
configuration="${CONFIGURATION:-release}"
scratch="${TEMPO_BUILD_PATH:-.build}"
swift build -c "$configuration" --scratch-path "$scratch"
bin_path="$(swift build -c "$configuration" --scratch-path "$scratch" --show-bin-path)"
app="dist/Lawdie Time Capture.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_path/Tempo" "$app/Contents/MacOS/Tempo"
cp scripts/Info.plist "$app/Contents/Info.plist"
cp -R "$bin_path/LawdieTempo_Tempo.bundle" "$app/Contents/Resources/"
bash scripts/icon.sh
cp assets/Tempo.icns "$app/Contents/Resources/Tempo.icns"
codesign --force --sign - "$app"
echo "Built $app"
