#!/usr/bin/env python3
"""
WhisperX transcription script for Fall Damage Paper Editor CEP panel.
Outputs {"words": [{"word": str, "start": float, "end": float}, ...]} to --output path.

Usage:
    python _whisperx_transcribe.py --audio <wav> --model <model_name> --device <cpu|cuda> --output <out.json>

Install requirements:
    pip install whisperx
    (WhisperX also requires ffmpeg on PATH and torch — see https://github.com/m-bain/whisperX)
"""

import argparse
import json
import sys

# PyInstaller freeze fixes — must run before any whisperx/transformers imports
if getattr(sys, "frozen", False):
    # 1. importlib.metadata patch: transformers checks package versions at startup
    #    via importlib.metadata.version(), but PyInstaller doesn't bundle .dist-info
    #    for every package. Return "0.0.0" ONLY for packages that are actually
    #    bundled (importable) but missing metadata. For packages that truly aren't
    #    installed (librosa, dill, etc.), let PackageNotFoundError propagate so that
    #    availability guards like RequirementCache("librosa") correctly return False.
    import importlib.metadata as _im
    import importlib.util as _iu
    _orig_version = _im.version
    def _safe_version(package_name):
        try:
            return _orig_version(package_name)
        except _im.PackageNotFoundError:
            if _iu.find_spec(package_name) is not None:
                return "0.0.0"  # bundled but missing .dist-info
            raise  # genuinely not installed — let the error propagate
    _im.version = _safe_version


def main():
    parser = argparse.ArgumentParser(description="WhisperX transcription with word-level alignment")
    parser.add_argument("--audio",  required=True,  help="Path to audio file (WAV, 16kHz mono recommended)")
    parser.add_argument("--model",  required=True,  help="WhisperX model name (e.g. base.en, small.en, medium.en)")
    parser.add_argument("--device", default="cpu",  help="Compute device: cpu or cuda")
    parser.add_argument("--output", required=True,  help="Output JSON file path")
    args = parser.parse_args()

    try:
        import whisperx
    except ImportError:
        print("ERROR: whisperx not installed. Run: pip install whisperx", file=sys.stderr)
        sys.exit(1)

    device = args.device
    compute_type = "float32" if device == "cpu" else "float16"

    print(f"[whisperx] Loading model '{args.model}' on {device} ({compute_type})...", file=sys.stderr)
    model = whisperx.load_model(args.model, device=device, compute_type=compute_type)

    print(f"[whisperx] Loading audio: {args.audio}", file=sys.stderr)
    audio = whisperx.load_audio(args.audio)

    print("[whisperx] Transcribing...", file=sys.stderr)
    result = model.transcribe(audio, batch_size=16, language="en")

    # Free GPU memory if on CUDA before loading alignment model
    if device == "cuda":
        import gc, torch
        del model
        gc.collect()
        torch.cuda.empty_cache()

    print("[whisperx] Loading alignment model...", file=sys.stderr)
    model_a, metadata = whisperx.load_align_model(language_code="en", device=device)

    print("[whisperx] Aligning word timestamps...", file=sys.stderr)
    result = whisperx.align(
        result["segments"], model_a, metadata, audio, device,
        return_char_alignments=False
    )

    word_segments = result.get("word_segments", [])
    words = []
    for w in word_segments:
        word_text = (w.get("word") or "").strip()
        if not word_text:
            continue
        start = w.get("start")
        end   = w.get("end")
        # Some words may lack alignment (e.g. silence / punct) — skip them
        if start is None or end is None:
            continue
        words.append({
            "word":  word_text,
            "start": float(start),
            "end":   float(end)
        })

    output = {"words": words}
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f)

    print(f"[whisperx] Done — {len(words)} words written to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
