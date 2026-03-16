# Paper Editor CEP Panel

A CEP (Common Extensibility Platform) panel for Adobe Premiere Pro 2025/2026 that automates **paper edit → timeline** workflows for the Dexerto YT show Fall Damage. Designed for structured video production with dialogue clips, reveals, leaderboards, quote cards, and external audio.

## What it does

1. **Paper Edit Input** — Parse a text script with timecodes, dialogue, Reveal/Link/End Card lines.
2. **Multi-Camera Workflow** — Add camera footage with multiple parts per camera.
3. **Transcription & Matching** — Uses WhisperX to transcribe, then matches script lines to timecodes.
4. **Project Generation** — Builds XMEML, imports into Premiere, and opens the sequence with overlays.

### Features

- **Quote Cards** — Generates styled quote card PNGs from a data file using Photoshop, places them on the timeline.
- **YouTube Clips** — Downloads and trims YouTube clips via yt-dlp, placed on the timeline at link entries.
- **Leaderboard** — Renders an animated leaderboard in After Effects, placed on the timeline with an end celebration block (confetti, fireworks, music, sound effects).
- **Hearts** — Places heart MOGRTs on score reveal points.
- **Sparkles** — Adds sparkle effects on newly revealed hearts.
- **Intro Card** — Places a Name MOGRT (AE MOGRT) with the guest's name on the intro clip.
- **Auto Theme Sync** — Panel background matches Premiere's dark/light theme automatically.

## Template Assets

The media assets used by this panel (video overlays, audio stings, Photoshop templates, Motion Graphics Templates) are not included in this repo due to file size.

**Download them here and place the contents into the `templates/` folder:**

> [Download template assets (Google Drive)](https://YOUR_GOOGLE_DRIVE_LINK_HERE)

## Prerequisites

- **Adobe Premiere Pro** 2025 or 2026
- **Windows** (this panel is Windows-only; uses PowerShell, tasklist, and Windows paths)
- **External tools** (place in `bin/` or configure paths in Settings):
  - `whisperx_fd.exe` — built via `build_whisperx_exe.bat` (bundles WhisperX + CPU PyTorch, no Python needed)
  - [FFmpeg](https://ffmpeg.org/download.html) — `ffmpeg.exe`, `ffprobe.exe`
  - [yt-dlp](https://github.com/yt-dlp/yt-dlp) (optional) — for YouTube clip downloads
- **Adobe Photoshop** (optional, for quote card generation)
- **Adobe After Effects** (optional, for leaderboard renders)

## Installation

1. Run `install_dev.bat` **as Administrator**.
2. Restart Premiere Pro.
3. Open **Window → Extensions → Paper Editor**.
4. Click **Settings** (in the LOG section) and verify paths for WhisperX, FFmpeg, and any optional tools.

### Manual setup (if symlink fails)

Copy this entire folder to:
```
%APPDATA%\Adobe\CEP\extensions\com.falldamage.papereditor
```

Ensure `PlayerDebugMode` is enabled for CEP 12:
```
HKEY_CURRENT_USER\Software\Adobe\CSXS.12 → PlayerDebugMode = 1
```

## Usage

1. **Sources** — Add cameras (first = reference camera), optionally add external audio parts.
2. **Paper Edit** — Select your `.txt` paper edit file and output directory.
3. **Features** — Enable/disable Quote Cards, Leaderboard, Hearts, Sparkles, Intro Card.
4. **Generate Project** — Runs transcription, sync, matching, XMEML build, and Premiere import.

Use **Cancel** during generation to stop after the current step.

## Paper Edit Format

- Timecode lines: `1:23` or `0:12:45` or `0:12:45:12` (HH:MM:SS:FF) followed by dialogue
- `Reveal - <text>` — Scoring reveal (optional 0.5, 1pt, etc.)
- `Leaderboard reveal` — Leaderboard-specific reveal
- `End card` — End card placeholder
- URLs — Treated as Link entries

## Sequence Naming

Generated sequences are named: `YYMMDD_FD_GuestName_QUOTES_Paper Edit`

## Troubleshooting

- **"Premiere Pro connection not available"** — Run the panel from inside Premiere Pro (Window → Extensions → Paper Editor).
- **WhisperX/FFmpeg not found** — Set correct paths in Settings.
- **First run slow** — WhisperX downloads AI models (~400MB) on first use; cached after that in `%USERPROFILE%\.cache\huggingface\hub\`.
- **Stale paths after moving project** — Use Settings → **Clear Session Cache**.
- **Leaderboard AE timeout** — Ensure After Effects is installed; start AE before generating if it's slow to launch.
- **MOGRT text not updating** — The Name MOGRT must be an AE MOGRT (created in After Effects), not a Premiere Essential Graphics template. Only AE MOGRTs expose scriptable text params.

## License

Internal/fallback use. See project owner for terms.
