# Paper Editor (Fall Damage: Quotes)

A CEP panel for Adobe Premiere Pro that automates the paper edit to timeline workflow for Fall Damage: Quotes. Transcribes footage with WhisperX, matches dialogue from the paper edit, and builds a full sequence with quote cards, leaderboards, hearts, intro cards, and end celebrations. Windows Only.

> **[Download templates + bin (.zip)](https://drive.google.com/file/d/1YszHtpkTxwsleWeCjRL4N_cZ__HjHxmZ/view?usp=drive_link)** — Required files (MOGRTs, overlays, WhisperX, FFmpeg). Extract and copy `templates/` and `bin/` into the extension folder before installing.

## Usage Guide

## Setup (One-Time)

### 1. Install the Panel
- Download the extension (top right -> code -> download .zip) and extract to your Documents folder.
- Download and extract the provided `.zip` file. It contains a `templates/` folder (MOGRT files, overlay videos, PSD template) and a `bin/` folder (WhisperX, FFmpeg, FFprobe executables).
- Copy the `templates/` and `bin/` folders into the main extension folder (so they sit alongside `client/`, `host/`, etc.).
- Run `install_dev.bat` as Administrator. This creates a symlink so Premiere can find the extension.
- Restart Premiere Pro (run as Administrator).
- Go to **Window → Extensions → Paper Editor** to open the panel.

### 2. Configure Settings
- Click **Settings** (next to "Copy Log" in the LOG section).
- If you placed the `bin/` and `templates/` folders from the zip, all paths should be set automatically. Verify they look correct:
  - **WhisperX Executable** — `whisperx_fd.exe`
  - **FFmpeg / FFprobe** — `ffmpeg.exe`, `ffprobe.exe`
  - **WhisperX Model** — `base.en` for speed, `medium.en` for accuracy
  - **WhisperX Device** — `cpu` (default) or `cuda` if you have an NVIDIA GPU
  - **Hearts MOGRT**, **Name MOGRT**, **Quote Card Template**, **Title Card / End Cards** — template assets
- Optional tools (only needed if you use those features):
  - **Photoshop Executable** — for generating quote card PNGs
  - **After Effects Executable** — for rendering the leaderboard animation
  - **yt-dlp Executable** — for downloading YouTube clips
- Click **Done** to save.

> **First run note:** WhisperX will download AI models (~400MB) on its first transcription. This is cached in `%USERPROFILE%\.cache\huggingface\hub\` and only happens once.

---

## Per-Episode Workflow

### Step 1: Sources

**Add your camera footage:**
- The first camera is the **reference camera** — all other cameras and external audio will be synced to it.
- Click **+ Add Camera** for each angle. Each camera can have multiple parts (if recording was split into separate files).
- Click **Browse** next to each part slot to select the video file.

**External audio (optional):**
- Check **External Audio** if you recorded audio separately (e.g. a dedicated audio recorder).
- Click **+ Add Audio Part** and browse to each audio file.
- External audio is synced to the reference camera via WhisperX word matching.

### Step 2: Paper Edit

**Prepare your paper edit file:**
- Open the paper edit document on Google Drive / Asana.
- Select all the content and copy it.
- Open a plain text editor (e.g. Notepad), paste the content, and save it as `NAME_Paper Edit.txt` file. IMPORTANT: Name is parsed from here.
- In the panel, click **Browse** next to "Paper Edit (.txt)" and select that file.
- See [format guide](#paper-edit-format) below for what the panel expects.

**Set output directory (optional):**
- By default, the project folder is created next to the paper edit file.
- To put it somewhere else, browse to a different output directory.

**Adjust settings:**
- **FPS** — auto-detected from the first camera file, but you can override it.
- **Padding** — extra seconds added before and after each matched clip (default: 0.5s).
- **Gap** — length of placeholder gaps for NO MATCH, REVEAL, and LINK entries (default: 5s).

### Step 3: Features

Enable or disable features for this episode:

- **Quote Cards** — Generates styled quote card images and places them on the timeline.
  - Requires a **Quote Data File** (`.txt`). To create this, open the quotes table in the Google Drive / Asana document, copy the table contents, paste into a plain text file, and save as `NAME_Quote Data.txt`.
  - Click **Generate Cards in Photoshop** to create the PNGs before generating the project (optional — can be done separately).
  - **YT Clips** (sub-option) — downloads and trims YouTube clips referenced as URLs in the paper edit.

- **Leaderboard** — Renders an animated leaderboard graphic in After Effects.
  - Set the **AE Leaderboard Project** (`.aep`), **Guest Name**, **Position**, and **Score %**.
  - Click **Process Leaderboard in After Effects** to render. This can also run automatically during generation.

- **Hearts** — Places heart MOGRTs at scoring reveal points on the timeline.

- **Sparkles** — Adds sparkle effects on newly revealed hearts. Only available when Hearts is enabled.

- **Intro Card** — Places the guest name MOGRT and intro card overlays on the intro clip.

### Step 4: Generate

- Click **Generate Project**.
- The panel runs through these stages automatically:
  1. Validates all inputs and paths
  2. Detects durations of all footage parts
  3. Transcribes each camera with WhisperX
  4. Syncs multi-cam and external audio via word matching
  5. Parses the paper edit and matches lines to transcription
  6. Processes leaderboard in After Effects (if enabled)
  7. Builds the XMEML sequence
  8. Generates JSX scripts for MOGRTs and overlays
  9. Imports the sequence into Premiere and opens it
  10. Runs JSX scripts to place Name MOGRT, Hearts, and end leaderboard

- Watch the **progress bar** and **log** for status updates.
- Click **Cancel** at any time to stop after the current step completes.

### Step 5: After Generation

Once generation completes:
- The sequence opens in Premiere's timeline, named `YYMMDD_FD_GuestName_QUOTES_Paper Edit`.
- Project items are automatically organized into bins: FOOTAGE, CLIPS, QUOTE CARDS, SEQUENCES, GFX.
- Review the timeline — NO MATCH entries appear as gaps that you need to manually fill.
- REVEAL entries appear as gaps where you can add your reveal graphics.
- LINK entries appear as gaps where YouTube clips (if downloaded) are placed.

---

## Paper Edit Format

The paper edit is a plain `.txt` file. Each entry is a timecode line followed by dialogue text:

```
1:23
So the first question is about wrestling

3:45
Kenny talks about his career in New Japan

Reveal - Kenny Omega 0.5

5:12
Next question about favourite matches

Leaderboard reveal

7:30
Final thoughts on the industry

https://www.youtube.com/watch?v=example

End card
```

### Line Types

| Line | What it does |
|------|-------------|
| `1:23` or `0:01:23` or `0:01:23:12` | Timecode — marks the start of a dialogue clip |
| Text after timecode | Dialogue — matched against the transcription to find the clip |
| `Reveal - <text>` | Scoring reveal — creates a gap; Hearts MOGRT placed here if enabled |
| `Leaderboard reveal` (1st) | Shows the leaderboard grid PNG (static scores) |
| `Leaderboard reveal` (2nd) | Shows the animated leaderboard `.mov` + triggers the end celebration block (confetti, fireworks, music, SFX) |
| `Insound <text>` | In-sound cue — creates a labelled gap on the timeline |
| `End card` | End card placeholder |
| URL (http/https) | Link — YouTube clip downloaded and placed here (if YT Clips enabled) |

---

## Timeline Layout

Here's how each element gets placed on the generated timeline:

### Video Tracks (bottom to top)

| Track | Content |
|-------|---------|
| V1–V(n) | Camera footage — one track per camera (V1 = reference camera, V2 = CAM B, etc.) |
| V(n+1) | Background overlay — END CARD nologo `.mov` placed under quote cards and intro clip; END CARD 2 at end |
| V(n+2) | Title card — `QUOTES_Title Card.mov` placed on the intro clip |
| V(n+3) | Name MOGRT — guest name placed on the intro clip via JSX |
| V(n+4)* | Leaderboard — rendered leaderboard `.mov` at reveal points (if leaderboard enabled) |
| V(n+5)* | YouTube clips — trimmed YT clips at reveal points (if YT Clips enabled) |
| V(n+6)* | Quote cards — quote card PNGs overlaid on their corresponding dialogue clips |
| V(top-2) | Text generators — labels for NO MATCH, REVEAL, INSOUND, LINK, and END CARD gaps |
| V(top-1), V(top) | Hearts MOGRTs — top/bottom heart tracks (if Hearts enabled) |
| V(top+1) | Sparkles — sparkle effects on hearts (if Sparkles enabled) |

*Conditional tracks — only added if the feature is enabled. Track numbers shift accordingly.

### What goes where

- **Matched dialogue clips** — Camera footage placed on V3+ at the matched timecode, trimmed with padding.
- **NO MATCH** — A text generator gap (default 5s) with the unmatched dialogue text as a label. Fill these manually.
- **Quote cards** — PNG overlaid on the quote card track above the dialogue clip it belongs to, with END CARD nologo underneath as a background.
- **Intro card** — On the first clip: END CARD nologo (V1) + Title Card (V2) stacked underneath, Name MOGRT placed on top via JSX with the guest's name.
- **Reveals** — A gap with text label. If Hearts is enabled, heart MOGRTs are placed at each reveal via JSX. If a YouTube clip is associated, it's placed on the YT track.
- **Leaderboard reveal (1st)** — The leaderboard grid PNG (static snapshot of scores) is placed on the leaderboard track.
- **Leaderboard reveal (2nd)** — The animated leaderboard `.mov` is placed on the leaderboard track. If all end celebration template files are present, an end block is appended with END CARD nologo, confetti, fireworks (with Ultra Key), music, whooshes, drum roll, climb tone, and party horn.
- **INSOUND** — A labelled gap on the timeline. Fill with the appropriate sound effect manually.
- **LINK** — A labelled gap. If YT Clips is enabled, the downloaded/trimmed clip is placed on the YT track.
- **End card** — A gap with END CARD 2 `.mov` placed on the background overlay track.
- **Hearts** — Heart MOGRTs placed at each scoring reveal point via JSX after import. Each heart corresponds to the score value in the reveal line (e.g. `Reveal - Name 0.5` = half heart).
- **Sparkles** — Sparkle `.mov` effects placed on newly revealed hearts.

### Audio Tracks

| Track | Content |
|-------|---------|
| A1–A(n) | Camera audio — one track per camera |
| A(n+1)–A(n+2) | External audio (if enabled) — stereo pair synced to reference camera |
| A(bottom) | End leaderboard audio — music, whooshes, drum roll, party horn (if end block enabled) |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Panel doesn't appear in Window → Extensions | Run `install_dev.bat` as Admin, restart Premiere |
| "EvalScript error" on every action | Check that `CSXS/manifest.xml` has no `<ScriptPath>` element |
| WhisperX first run hangs | It's downloading models (~400MB). Wait for it to finish. |
| "Processing is not defined" | A JS file has a syntax error. Check the Chrome DevTools console (localhost:8088) |
| Quote cards not generating | Ensure Photoshop path is set in Settings and Photoshop is installed |
| Leaderboard render fails | Ensure After Effects path is set and the `.aep` file is valid |
| Name MOGRT text doesn't change | The MOGRT must be authored in After Effects, not Premiere's Essential Graphics |
| Timeline has gaps everywhere | These are NO MATCH entries. Adjust Match Threshold or improve paper edit phrasing |

---

## Keyboard Shortcuts / Tips

- **Copy Log** — Click to copy the full log to clipboard for sharing or debugging.
- **Settings → Export/Import** — Save and load your configuration as JSON.
- **Settings → Clear Session Cache** — Resets all cameras, paths, and toggles to defaults.
