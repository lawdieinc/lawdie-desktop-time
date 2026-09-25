#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets .build/Tempo.iconset
source="Sources/Tempo/Resources/Brand/lawdie-icon.png"
for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$source" --out ".build/Tempo.iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$source" --out ".build/Tempo.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns .build/Tempo.iconset -o assets/Tempo.icns
