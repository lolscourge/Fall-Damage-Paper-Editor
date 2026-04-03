@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo  Build whisperx_fd.exe  (CPU-only)
echo ============================================
echo.
echo Output: bin\whisperx_fd.exe
echo.
echo NOTE: This downloads ~2GB of packages and takes 10-20 minutes.
echo       The finished exe is ~600MB.  Run once, then distribute bin\whisperx_fd.exe.
echo.
pause

REM ── Optional: pass python path as first argument ──────────────────────────────
if "%~1"=="" (
    set PYTHON_EXE=python
) else (
    set PYTHON_EXE=%~1
)

%PYTHON_EXE% --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found.
    echo   Install Python 3.10 or 3.11 from https://python.org and add to PATH,
    echo   or pass the full path as the first argument:
    echo     build_whisperx_exe.bat "C:\Python311\python.exe"
    pause
    exit /b 1
)

for /f "tokens=*" %%V in ('%PYTHON_EXE% --version 2^>^&1') do echo   Using: %%V
echo.

REM ── Paths ─────────────────────────────────────────────────────────────────────
set SCRIPT_DIR=%~dp0
set VENV_DIR=%SCRIPT_DIR%_whisperx_build_env
set BUILD_DIR=%SCRIPT_DIR%_whisperx_build_work
set DIST_DIR=%SCRIPT_DIR%bin
set PY_SCRIPT=%SCRIPT_DIR%_whisperx_transcribe.py

if not exist "%PY_SCRIPT%" (
    echo ERROR: _whisperx_transcribe.py not found at:
    echo   %PY_SCRIPT%
    pause
    exit /b 1
)
if not exist "%DIST_DIR%" mkdir "%DIST_DIR%"

REM ── Create fresh venv ─────────────────────────────────────────────────────────
echo [1/5] Creating virtual environment...
if exist "%VENV_DIR%" (
    echo   Removing old build env...
    rd /s /q "%VENV_DIR%"
)
%PYTHON_EXE% -m venv "%VENV_DIR%"
if errorlevel 1 ( echo ERROR: Failed to create venv. & pause & exit /b 1 )
call "%VENV_DIR%\Scripts\activate.bat"
echo   Done.
echo.

REM ── CPU-only PyTorch ──────────────────────────────────────────────────────────
echo [2/5] Installing CPU-only PyTorch (largest download, ~600MB)...
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 ( echo ERROR: PyTorch install failed. & pause & exit /b 1 )
echo   Done.
echo.

REM ── WhisperX + PyInstaller ────────────────────────────────────────────────────
echo [3/5] Installing WhisperX, PyInstaller, and hooks...
pip install "whisperx>=3.1" pyinstaller "pyinstaller-hooks-contrib>=2024.6"
if errorlevel 1 ( echo ERROR: WhisperX or PyInstaller install failed. & pause & exit /b 1 )

REM ── Patch PyInstaller bytecode scanner ────────────────────────────────────────
REM   Python 3.10's dis.get_instructions() crashes on certain Cython-compiled
REM   code objects (IndexError: tuple index out of range). This patch makes
REM   iterate_instructions() skip broken code objects instead of crashing.
echo   Patching PyInstaller modulegraph util.py for Python 3.10 compatibility...
for /f "delims=" %%P in ('"%VENV_DIR%\Scripts\python.exe" -c "import PyInstaller, os; print(os.path.join(os.path.dirname(PyInstaller.__file__), 'lib', 'modulegraph', 'util.py'))"') do set UTIL_PY=%%P
if not exist "!UTIL_PY!" (
    echo   WARNING: Could not locate PyInstaller util.py at !UTIL_PY!, skipping patch.
) else (
    "%VENV_DIR%\Scripts\python.exe" -c "import sys; path=sys.argv[1]; txt=open(path).read(); marker='        yield from (i for i in get_instructions(code_object) if i.opname != \"EXTENDED_ARG\")'; replacement='        try:\n            yield from (i for i in get_instructions(code_object) if i.opname != \"EXTENDED_ARG\")\n        except (IndexError, Exception):\n            pass  # skip Cython code objects that crash Python 3.10 dis'; (open(path,\"w\").write(txt.replace(marker,replacement)) or print(\"  Patched.\")) if marker in txt else print(\"  Already patched.\")" "!UTIL_PY!"
)
echo   Done.
echo.

REM ── Build ─────────────────────────────────────────────────────────────────────
echo [4/5] Building whisperx_fd.exe via PyInstaller (5-15 min)...
echo.

"%VENV_DIR%\Scripts\pyinstaller.exe" ^
    --onefile ^
    --name whisperx_fd ^
    --collect-all whisperx ^
    --collect-all faster_whisper ^
    --collect-all ctranslate2 ^
    --collect-all transformers ^
    --collect-all tokenizers ^
    --collect-all huggingface_hub ^
    --collect-all numpy ^
    --collect-all pyannote.audio ^
    --collect-all pyannote.core ^
    --collect-all pyannote.database ^
    --collect-all pyannote.metrics ^
    --collect-all pyannote.pipeline ^
    --collect-all lightning ^
    --collect-all torchmetrics ^
    --collect-all asteroid_filterbanks ^
    --collect-all einops ^
    --collect-all julius ^
    --collect-all onnxruntime ^
    --hidden-import whisperx ^
    --hidden-import whisperx.audio ^
    --hidden-import whisperx.asr ^
    --hidden-import whisperx.alignment ^
    --hidden-import faster_whisper ^
    --hidden-import ctranslate2 ^
    --hidden-import transformers.models.wav2vec2 ^
    --hidden-import transformers.models.wav2vec2_conformer ^
    --hidden-import scipy.signal ^
    --hidden-import scipy.linalg ^
    --hidden-import scipy.sparse.csgraph ^
    --copy-metadata whisperx ^
    --copy-metadata faster_whisper ^
    --copy-metadata ctranslate2 ^
    --copy-metadata transformers ^
    --copy-metadata tokenizers ^
    --copy-metadata huggingface_hub ^
    --copy-metadata numpy ^
    --copy-metadata regex ^
    --copy-metadata requests ^
    --copy-metadata tqdm ^
    --copy-metadata filelock ^
    --copy-metadata packaging ^
    --copy-metadata torch ^
    --copy-metadata torchaudio ^
    --copy-metadata pyannote.audio ^
    --copy-metadata pyannote.core ^
    --copy-metadata lightning ^
    --copy-metadata torchmetrics ^
    --distpath "%DIST_DIR%" ^
    --workpath "%BUILD_DIR%" ^
    --specpath "%SCRIPT_DIR%" ^
    --noconfirm ^
    "%PY_SCRIPT%"

if errorlevel 1 ( echo ERROR: PyInstaller build failed. Check output above. & pause & exit /b 1 )
echo.

REM ── Cleanup ───────────────────────────────────────────────────────────────────
echo [5/5] Cleaning up build environment...
deactivate
rd /s /q "%VENV_DIR%"  2>nul
rd /s /q "%BUILD_DIR%" 2>nul
del "%SCRIPT_DIR%whisperx_fd.spec" 2>nul
echo   Done.
echo.

REM ── Result ────────────────────────────────────────────────────────────────────
echo ============================================
if exist "%DIST_DIR%\whisperx_fd.exe" (
    echo  SUCCESS: bin\whisperx_fd.exe is ready.
    echo.
    echo  FIRST RUN NOTE:
    echo  The exe downloads AI models on first use ^(~400MB^):
    echo    %%USERPROFILE%%\.cache\huggingface\hub\
    echo  Internet is required on first run only.
    echo  All subsequent runs work offline.
    echo ============================================
) else (
    echo  FAILED: whisperx_fd.exe not found in bin\
    echo  Review the PyInstaller output above.
    echo.
    echo  Common fixes:
    echo    - Add --collect-all pyannote.audio if whisperx imports it
    echo    - Try Python 3.10 or 3.11 if on a newer version
    echo ============================================
)
pause
