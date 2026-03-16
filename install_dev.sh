#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  Paper Editor CEP Panel — Mac Install
#  Mirrors install_dev.bat for macOS.
#
#  What this script does:
#   1. Enables PlayerDebugMode (unsigned CEP extensions) via plist
#   2. Creates symlink so Premiere Pro discovers the panel
#   3. Resets settings.json so defaults use this folder
# ──────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ID="com.falldamage.papereditor"
CEP_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK_PATH="$CEP_DIR/$EXTENSION_ID"

echo ""
echo "Paper Editor CEP Panel — Mac Install"
echo "=========================================="
echo ""
echo "Install from: $SCRIPT_DIR"
echo ""

# ── 1. Enable PlayerDebugMode ──────────────────────────────────
echo "[1/4] Setting PlayerDebugMode..."
for VERSION in 12 13 14; do
    PLIST="$HOME/Library/Preferences/com.adobe.CSXS.${VERSION}.plist"
    defaults write "$PLIST" PlayerDebugMode 1 2>/dev/null || true
done
echo "      Done. (If Premiere was already open, restart it.)"

# ── 2. Create symlink ──────────────────────────────────────────
echo ""
echo "[2/4] Creating symlink..."
mkdir -p "$CEP_DIR"

if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
    echo "      Removing old link/folder..."
    rm -rf "$LINK_PATH"
fi

if ln -s "$SCRIPT_DIR" "$LINK_PATH"; then
    echo "      Symlink created: $LINK_PATH -> $SCRIPT_DIR"
else
    echo "      Symlink FAILED. Manually copy this folder to:"
    echo "        $LINK_PATH"
fi

# ── 3. Reset settings.json ─────────────────────────────────────
echo ""
echo "[3/4] Resetting settings..."
SETTINGS="$SCRIPT_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
    rm -f "$SETTINGS"
    echo "      settings.json removed — paths will use defaults."
else
    echo "      No settings.json to reset."
fi

# ── 4. Check for After Effects ─────────────────────────────────
echo ""
echo "[4/4] Checking for After Effects..."
AE_FOUND=""
AE_DIR="/Applications/Adobe"
if [ -d "$AE_DIR" ]; then
    while IFS= read -r -d '' APP; do
        BIN="$APP/Contents/MacOS/After Effects"
        if [ -f "$BIN" ]; then
            AE_FOUND="$BIN"
            echo "      Found: $BIN"
            break
        fi
    done < <(find "$AE_DIR" -maxdepth 2 -iname "*after effects*" -type d -print0 2>/dev/null | sort -rz)
fi
if [ -z "$AE_FOUND" ]; then
    echo "      After Effects not found — Leaderboard feature will"
    echo "      require the AE path to be set manually in Settings."
fi

echo ""
echo "=========================================="
echo " Setup complete!"
echo ""
echo " Prerequisites (place in bin/ or set in Settings):"
echo "   - Whisper: whisper binary + bin/models/ggml-base.en.bin"
echo "   - FFmpeg: ffmpeg, ffprobe"
echo "   - Optional: yt-dlp, Photoshop, After Effects"
echo ""
echo " Next steps:"
echo "   1. Restart Premiere Pro 2025/2026"
echo "   2. Go to Window > Extensions > Paper Editor"
echo "   3. Open Settings to verify paths"
echo "=========================================="
echo ""
