# Paper Editor CEP Panel

A CEP (Common Extensibility Platform) panel for Adobe Premiere Pro 2025/2026 that automates **paper edit → timeline** workflows for the Dexerto YT show Fall Damage. Designed for structured video production with dialogue clips, reveals, leaderboards, quote cards, and external audio.

## What it does

1. **Paper Edit Input** — Parse a text script with timecodes, dialogue, Reveal/Link/End Card lines.
2. **Multi-Camera Workflow** — Add camera footage with multiple parts per camera.
3. **Transcription & Matching** — Uses Whisper to transcribe, then matches script lines to timecodes.
4. **Project Generation** — Builds XMEML, imports into Premiere, and opens the sequence with overlays.

## Template Assets

The media assets used by this panel (video overlays, audio stings, Photoshop templates, Motion Graphics Templates) are not included in this repo due to file size.

**Download them here and place the contents into the `templates/` folder:**

> [Download template assets (Google Drive)](https://YOUR_GOOGLE_DRIVE_LINK_HERE)

## Prerequisites

- **Adobe Premiere Pro** 2025 or 2026
- **Windows** (this panel is Windows-only; uses PowerShell, tasklist, and Windows paths)
- **External tools** (place in `bin/` or configure paths in Settings):
  - [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) — `whisper.exe` and model `ggml-base.en.bin` in `bin/models/`
  - [FFmpeg](https://ffmpeg.org/download.html) — `ffmpeg.exe`, `ffprobe.exe`
  - [yt-dlp](https://github.com/yt-dlp/yt-dlp) (optional) — for YouTube clip downloads
- **Adobe Photoshop** (optional, for quote cards)
- **Adobe After Effects** (optional, for leaderboard renders)

## Installation

1. Run `install_dev.bat` **as Administrator**.
2. Restart Premiere Pro.
3. Open **Window → Extensions → Paper Editor**.
4. Open **Settings** and verify paths for Whisper, FFmpeg, Photoshop, After Effects, and templates.

### Manual setup (if symlink fails)

Copy this entire folder to:
```
%APPDATA%\Adobe\CEP\extensions\com.falldamage.papereditor
```

Ensure `PlayerDebugMode` is enabled for CEP 12/13:
```
HKEY_CURRENT_USER\Software\Adobe\CSXS.12 → PlayerDebugMode = 1
HKEY_CURRENT_USER\Software\Adobe\CSXS.13 → PlayerDebugMode = 1
```

## Usage

1. **Sources** — Add cameras (first = reference), optionally external audio.
2. **Paper Edit** — Select your `.txt` paper edit file and output directory.
3. **Features** — Configure Quote Cards, Leaderboard, Hearts, Sparkles, Name MOGRT.
4. **Generate Project** — Runs transcription, sync, matching, XMEML build, and Premiere import.

Use **Cancel** during generation to stop after the current step.

## Paper Edit Format

- Timecode lines: `1:23` or `0:12:45` or `0:12:45:12` (HH:MM:SS:FF) followed by dialogue
- `Reveal - <text>` — Scoring reveal (optional 0.5, 1pt, etc.)
- `Leaderboard reveal` — Leaderboard-specific reveal
- `End card` — End card placeholder
- URLs — Treated as Link entries

## Troubleshooting

- **"Premiere Pro connection not available"** — Run the panel from inside Premiere Pro (Window → Extensions → Paper Editor).
- **Whisper/FFmpeg not found** — Set correct paths in Settings.
- **Stale paths after moving project** — Use Settings → **Clear Session Cache**.
- **Leaderboard AE timeout** — Ensure After Effects is installed; start AE before generating if it's slow to launch.

## License

Internal/fallback use. See project owner for terms.
"# Fall-Damage-Paper-Editor" 
