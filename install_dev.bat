@echo off
REM ──────────────────────────────────────────────────────────
REM  Paper Editor CEP Panel — Install
REM  This folder is self-contained. Run as Administrator for
REM  symlink creation (or use manual copy if symlink fails).
REM
REM  What this script does:
REM   1. Enables PlayerDebugMode (unsigned CEP extensions)
REM   2. Creates symlink so Premiere Pro discovers the panel
REM   3. Resets settings.json so defaults use this folder
REM ──────────────────────────────────────────────────────────

echo.
echo Paper Editor CEP Panel — Install
echo ==========================================
echo.

set "CEP_DIR=%~dp0"
if "%CEP_DIR:~-1%"=="\" set "CEP_DIR=%CEP_DIR:~0,-1%"

echo Install from: %CEP_DIR%
echo.

REM ── 1. Enable PlayerDebugMode (CSXS.12 = Prem 2025, CSXS.13 = Prem 2026) ──
echo [1/4] Setting PlayerDebugMode...
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
reg add "HKEY_CURRENT_USER\Software\Adobe\CSXS.13" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
echo       Done.

REM ── 2. Create symlink in CEP extensions folder ──
echo.
echo [2/4] Creating symlink...
set "EXTENSIONS_DIR=%APPDATA%\Adobe\CEP\extensions"
set "LINK_PATH=%EXTENSIONS_DIR%\com.falldamage.papereditor"

if not exist "%EXTENSIONS_DIR%" mkdir "%EXTENSIONS_DIR%"

if exist "%LINK_PATH%" (
    echo       Removing old symlink...
    rmdir "%LINK_PATH%" 2>nul
    del "%LINK_PATH%" 2>nul
)

mklink /D "%LINK_PATH%" "%CEP_DIR%"
if %ERRORLEVEL% neq 0 (
    echo.
    echo Symlink FAILED. Run as Administrator, or manually copy this folder to:
    echo   %LINK_PATH%
    echo.
) else (
    echo       Symlink created.
)

REM ── 3. Reset settings.json ──
echo.
echo [3/4] Resetting settings...
if exist "%CEP_DIR%\settings.json" (
    del "%CEP_DIR%\settings.json" >nul 2>&1
    echo       settings.json removed — paths will use defaults.
) else (
    echo       No settings.json to reset.
)

REM ── 4. Check for After Effects (used by Leaderboard feature) ──
echo.
echo [4/4] Checking for After Effects...
set "AE_FOUND="
setlocal enabledelayedexpansion
for /d %%D in ("C:\Program Files\Adobe\Adobe After Effects *") do (
    if exist "%%D\Support Files\AfterFX.exe" (
        set "AE_FOUND=%%D\Support Files\AfterFX.exe"
        echo       Found: %%D\Support Files\AfterFX.exe
    )
)
if not defined AE_FOUND (
    echo       After Effects not found — Leaderboard feature will
    echo       require the AE path to be set manually in Settings.
)
endlocal

echo.
echo ==========================================
echo  Setup complete!
echo.
echo  Prerequisites (place in bin/ or set in Settings):
echo    - Whisper: whisper.exe + bin/models/ggml-base.en.bin
echo    - FFmpeg: ffmpeg.exe, ffprobe.exe
echo    - Optional: yt-dlp.exe, Photoshop, After Effects
echo.
echo  Next steps:
echo    1. Restart Premiere Pro 2025/2026
echo    2. Go to Window ^> Extensions ^> Paper Editor
echo    3. Open Settings to verify paths (Whisper, FFmpeg,
echo       After Effects, Photoshop, etc.)
echo ==========================================
echo.
pause
