/**
 * processing.js — Whisper transcription, FFmpeg operations, waveform sync, text matching.
 * Uses Node.js APIs (child_process, fs, crypto, path) available in CEP panels.
 *
 * ALL external process calls are ASYNC to avoid blocking the CEP UI thread.
 */

/* global log, updateProgress */

var Processing = (function () {
    "use strict";

    var childProcess = require("child_process");
    var fs = require("fs");
    var crypto = require("crypto");
    var pathMod = require("path");

    var IS_WIN = process.platform === "win32";

    // ── Cache directory ──

    var CACHE_DIR = "";

    function initCacheDir(baseDir) {
        CACHE_DIR = pathMod.join(baseDir, ".whisper_cache");
        try {
            if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        } catch (e) {
            console.error("Failed to create cache dir:", e);
        }
    }

    // ── Cache cleanup ──

    /**
     * Remove .wav and .raw temp files older than maxAgeDays from cacheDir.
     * Call on startup to prevent unbounded disk growth.
     */
    function cleanupOldCacheFiles(cacheDir, maxAgeDays) {
        if (!cacheDir || !fs.existsSync(cacheDir)) return;
        var maxAgeMs = (maxAgeDays || 7) * 24 * 60 * 60 * 1000;
        var now = Date.now();
        try {
            var files = fs.readdirSync(cacheDir);
            var removed = 0;
            files.forEach(function (f) {
                var ext = pathMod.extname(f).toLowerCase();
                if (ext !== ".wav" && ext !== ".raw") return;
                var fp = pathMod.join(cacheDir, f);
                try {
                    var stat = fs.statSync(fp);
                    if (now - stat.mtimeMs > maxAgeMs) {
                        fs.unlinkSync(fp);
                        removed++;
                    }
                } catch (e) {}
            });
            if (removed > 0) {
                console.log("[cache] Removed " + removed + " old temp file(s) from cache dir");
            }
        } catch (e) {
            console.warn("[cache] Cleanup failed:", e.message);
        }
    }

    // ── Async process execution ──

    /**
     * Run a command asynchronously. Returns a Promise<{ stdout, stderr, status }>.
     */
    function execAsync(bin, args, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (!bin) {
                reject(new Error("Binary path is empty or undefined"));
                return;
            }
            if (!fs.existsSync(bin)) {
                reject(new Error("Binary not found: " + bin));
                return;
            }

            console.log("[exec] " + pathMod.basename(bin) + " " + args.slice(0, 3).join(" ") + "...");

            var opts = { windowsHide: IS_WIN };
            var proc = childProcess.spawn(bin, args, opts);
            var stdoutBufs = [];
            var stderrBufs = [];

            proc.stdout.on("data", function (d) { stdoutBufs.push(d); });
            proc.stderr.on("data", function (d) { stderrBufs.push(d); });

            var timer = null;
            if (timeoutMs && timeoutMs > 0) {
                timer = setTimeout(function () {
                    try { proc.kill(); } catch (e) {}
                    reject(new Error("Process timed out after " + (timeoutMs / 1000) + "s: " + pathMod.basename(bin)));
                }, timeoutMs);
            }

            proc.on("close", function (code) {
                if (timer) clearTimeout(timer);
                resolve({
                    stdout: Buffer.concat(stdoutBufs).toString("utf8"),
                    stderr: Buffer.concat(stderrBufs).toString("utf8"),
                    status: code
                });
            });

            proc.on("error", function (err) {
                if (timer) clearTimeout(timer);
                console.error("[exec] spawn error:", err.message);
                reject(new Error("Failed to spawn " + pathMod.basename(bin) + ": " + err.message));
            });
        });
    }

    /**
     * Like execAsync but streams stderr line-by-line to onStderrLine(line).
     * Used for Whisper progress reporting.
     */
    function execAsyncWithProgress(bin, args, timeoutMs, onStderrLine) {
        return new Promise(function (resolve, reject) {
            if (!bin) {
                reject(new Error("Binary path is empty or undefined"));
                return;
            }
            if (!fs.existsSync(bin)) {
                reject(new Error("Binary not found: " + bin));
                return;
            }

            console.log("[exec] " + pathMod.basename(bin) + " " + args.slice(0, 3).join(" ") + "...");

            var opts = { windowsHide: IS_WIN };
            var proc = childProcess.spawn(bin, args, opts);
            var stdoutBufs = [];
            var stderrBufs = [];
            var stderrRemainder = "";

            proc.stdout.on("data", function (d) { stdoutBufs.push(d); });
            proc.stderr.on("data", function (d) {
                stderrBufs.push(d);
                if (onStderrLine) {
                    stderrRemainder += d.toString("utf8");
                    var lines = stderrRemainder.split("\n");
                    stderrRemainder = lines.pop(); // keep partial line
                    lines.forEach(function (line) {
                        if (line.trim()) {
                            try { onStderrLine(line); } catch (e) {}
                        }
                    });
                }
            });

            var timer = null;
            if (timeoutMs && timeoutMs > 0) {
                timer = setTimeout(function () {
                    try { proc.kill(); } catch (e) {}
                    reject(new Error("Process timed out after " + (timeoutMs / 1000) + "s: " + pathMod.basename(bin)));
                }, timeoutMs);
            }

            proc.on("close", function (code) {
                if (timer) clearTimeout(timer);
                resolve({
                    stdout: Buffer.concat(stdoutBufs).toString("utf8"),
                    stderr: Buffer.concat(stderrBufs).toString("utf8"),
                    status: code
                });
            });

            proc.on("error", function (err) {
                if (timer) clearTimeout(timer);
                console.error("[exec] spawn error:", err.message);
                reject(new Error("Failed to spawn " + pathMod.basename(bin) + ": " + err.message));
            });
        });
    }

    /**
     * Run a command that writes to a file instead of stdout. Returns Promise.
     * Used for ffmpeg output-to-file operations.
     */
    function execAsyncToFile(bin, args, timeoutMs) {
        return execAsync(bin, args, timeoutMs);
    }

    // ── FPS Detection ──

    function detectFPS(ffprobeBin, filePath) {
        if (!ffprobeBin || !fs.existsSync(ffprobeBin)) { console.warn("ffprobe not found"); return Promise.resolve(null); }
        if (!filePath || !fs.existsSync(filePath)) return Promise.resolve(null);

        return execAsync(ffprobeBin, [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=r_frame_rate",
            "-of", "csv=p=0",
            filePath
        ], 15000).then(function (result) {
            if (result.status === 0 && result.stdout.trim()) {
                var rateStr = result.stdout.trim();
                if (rateStr.indexOf("/") >= 0) {
                    var parts = rateStr.split("/");
                    return parseFloat(parts[0]) / parseFloat(parts[1]);
                }
                return parseFloat(rateStr);
            }
            return null;
        }).catch(function (e) {
            console.warn("FPS detection failed:", e.message);
            return null;
        });
    }

    // ── Duration Detection ──

    function getPartDuration(ffprobeBin, filePath) {
        if (!ffprobeBin || !fs.existsSync(ffprobeBin)) {
            return Promise.reject(new Error("ffprobe not found at: " + ffprobeBin));
        }
        if (!filePath || !fs.existsSync(filePath)) {
            return Promise.reject(new Error("File not found: " + filePath));
        }

        return execAsync(ffprobeBin, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            filePath
        ], 30000).then(function (result) {
            if (result.status !== 0 || !result.stdout.trim()) {
                throw new Error("ffprobe failed for " + pathMod.basename(filePath) + ": " + result.stderr.substring(0, 200));
            }
            return parseFloat(result.stdout.trim());
        });
    }

    function getPartDurations(ffprobeBin, partPaths) {
        var chain = Promise.resolve([]);
        partPaths.forEach(function (pp) {
            chain = chain.then(function (durations) {
                return getPartDuration(ffprobeBin, pp).then(function (dur) {
                    log("info", "  Part duration: " + pathMod.basename(pp) + " = " + dur.toFixed(2) + "s");
                    durations.push(dur);
                    return durations;
                });
            });
        });
        return chain;
    }

    function getCumulativeOffsets(durations) {
        var offsets = [0.0];
        for (var i = 0; i < durations.length; i++) {
            offsets.push(offsets[offsets.length - 1] + durations[i]);
        }
        return offsets;
    }

    // ── Audio Channels ──

    function getAudioChannels(ffprobeBin, filePath) {
        if (!ffprobeBin || !fs.existsSync(ffprobeBin) || !filePath || !fs.existsSync(filePath)) {
            return Promise.resolve(2);
        }

        return execAsync(ffprobeBin, [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=channels",
            "-of", "csv=p=0",
            filePath
        ], 10000).then(function (result) {
            if (result.status === 0 && result.stdout.trim()) {
                return parseInt(result.stdout.trim(), 10) || 2;
            }
            return 2;
        }).catch(function () { return 2; });
    }

    // ── Video Info ──

    var VIDEO_INFO_DEFAULT = { durationFrames: null, width: 1920, height: 1080, codec: "h264", hasAudio: false };
    var FFPROBE_VIDEO_ARGS = ["-v", "error", "-show_entries", "stream=codec_type,width,height,nb_frames,duration,r_frame_rate", "-of", "json"];

    // Parse ffprobe stream array into a videoInfo object. Returns VIDEO_INFO_DEFAULT on failure.
    function parseVideoStreams(streams) {
        var videoStream = null;
        var hasAudio    = false;
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].codec_type === "video" && !videoStream) videoStream = streams[i];
            if (streams[i].codec_type === "audio") hasAudio = true;
        }
        if (!videoStream) return Object.assign({}, VIDEO_INFO_DEFAULT);

        var s    = videoStream;
        var info = Object.assign({}, VIDEO_INFO_DEFAULT);
        info.hasAudio = hasAudio;
        if (s.width)  info.width  = parseInt(s.width,  10);
        if (s.height) info.height = parseInt(s.height, 10);
        if (s.nb_frames && s.nb_frames !== "N/A") {
            info.durationFrames = parseInt(s.nb_frames, 10);
        } else if (s.duration && s.r_frame_rate) {
            // QuickTime/Animation codec: nb_frames is N/A, compute from duration * fps
            var dur      = parseFloat(s.duration);
            var fpsParts = s.r_frame_rate.split("/");
            var fps      = fpsParts.length === 2 ? parseInt(fpsParts[0], 10) / parseInt(fpsParts[1], 10) : parseFloat(s.r_frame_rate);
            if (dur > 0 && fps > 0) info.durationFrames = Math.round(dur * fps);
        }
        return info;
    }

    function getVideoInfo(ffprobeBin, filePath) {
        if (!ffprobeBin || !fs.existsSync(ffprobeBin) || !filePath || !fs.existsSync(filePath)) {
            return Promise.resolve(Object.assign({}, VIDEO_INFO_DEFAULT));
        }
        return execAsync(ffprobeBin, FFPROBE_VIDEO_ARGS.concat([filePath]), 15000).then(function (result) {
            if (result.status === 0) {
                try {
                    return parseVideoStreams(JSON.parse(result.stdout).streams || []);
                } catch (e) {
                    console.warn("ffprobe JSON parse error:", e.message);
                }
            }
            return Object.assign({}, VIDEO_INFO_DEFAULT);
        }).catch(function (e) {
            console.warn("ffprobe video info failed:", e.message);
            return Object.assign({}, VIDEO_INFO_DEFAULT);
        });
    }

    function getVideoInfoSync(ffprobeBin, filePath) {
        if (!ffprobeBin || !fs.existsSync(ffprobeBin) || !filePath || !fs.existsSync(filePath)) {
            return Object.assign({}, VIDEO_INFO_DEFAULT);
        }
        try {
            var out  = childProcess.execFileSync(ffprobeBin, FFPROBE_VIDEO_ARGS.concat([filePath]), { timeout: 10000 });
            return parseVideoStreams(JSON.parse(out.toString()).streams || []);
        } catch (e) {
            // fall through to default
        }
        return Object.assign({}, VIDEO_INFO_DEFAULT);
    }

    // ── Whisper ──

    function getCachePath(videoPath, model) {
        var mtime = 0;
        try { mtime = fs.statSync(videoPath).mtimeMs; } catch (e) {}
        var key = videoPath + "_" + mtime + "_" + model;
        var hash = crypto.createHash("md5").update(key).digest("hex");
        return pathMod.join(CACHE_DIR, hash + ".json");
    }

    function convertToWav(ffmpegBin, inputPath) {
        var wavPath = pathMod.join(CACHE_DIR, "temp_whisper_audio_" + Date.now() + ".wav");
        return execAsync(ffmpegBin, [
            "-nostdin", "-y", "-i", inputPath,
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            wavPath
        ], 300000).then(function (result) {
            if (result.status !== 0) {
                throw new Error("FFmpeg audio conversion failed: " + result.stderr.substring(0, 200));
            }
            return wavPath;
        });
    }

    function runWhisperCpp(whisperBin, modelPath, ffmpegBin, videoPath) {
        var cachePath = getCachePath(videoPath, pathMod.basename(modelPath));

        // Check cache first (synchronous — fast, just reading a small JSON)
        if (fs.existsSync(cachePath)) {
            log("info", "Loaded transcript from cache: " + pathMod.basename(videoPath));
            try {
                return Promise.resolve(JSON.parse(fs.readFileSync(cachePath, "utf8")));
            } catch (e) {
                console.warn("Cache read failed, re-transcribing:", e.message);
            }
        }

        if (!whisperBin || !fs.existsSync(whisperBin)) {
            return Promise.reject(new Error("Whisper executable not found: " + whisperBin));
        }
        if (!modelPath || !fs.existsSync(modelPath)) {
            return Promise.reject(new Error("Whisper model not found: " + modelPath));
        }

        log("info", "Extracting audio: " + pathMod.basename(videoPath));

        return convertToWav(ffmpegBin, videoPath).then(function (tempWav) {
            log("info", "Running Whisper (this may take a while): " + pathMod.basename(videoPath));

            // Whisper.cpp -oj outputs <base>.json where base = input path minus extension.
            // We pass -of <base> explicitly so the output location is always deterministic.
            var outputBase  = tempWav.replace(/\.wav$/i, "");
            var expectedJson = outputBase + ".json";

            var lastProgressPct = -1;
            function onWhisperStderr(line) {
                // Whisper.cpp emits lines like: "whisper_print_progress_callback: progress = 42%"
                // or timestamp lines like: "[00:00:10.000 --> 00:00:12.000]"
                var pctMatch = line.match(/progress\s*=\s*(\d+)\s*%/i);
                if (pctMatch) {
                    var pct = parseInt(pctMatch[1], 10);
                    if (pct !== lastProgressPct) {
                        lastProgressPct = pct;
                        log("info", "Whisper: " + pct + "% — " + pathMod.basename(videoPath));
                    }
                } else {
                    var tsMatch = line.match(/\[(\d{2}:\d{2}:\d{2}\.\d+)\s*-->/);
                    if (tsMatch && tsMatch[1] !== "00:00:00") {
                        log("info", "Whisper: @ " + tsMatch[1] + " — " + pathMod.basename(videoPath));
                    }
                }
            }

            return execAsyncWithProgress(pathMod.resolve(whisperBin), [
                "-m", pathMod.resolve(modelPath),
                "-oj", "-of", outputBase, "--language", "en",
                tempWav
            ], 600000, onWhisperStderr).then(function (result) {
                if (result.status !== 0) {
                    throw new Error("Whisper failed (code " + result.status + "): " + result.stderr.substring(0, 200));
                }

                // Find output JSON
                if (!fs.existsSync(expectedJson)) {
                    throw new Error("Whisper output JSON not found at: " + expectedJson);
                }

                var data = JSON.parse(fs.readFileSync(expectedJson, "utf8"));

                // Cleanup temp files
                try { fs.unlinkSync(tempWav); } catch (e) {}
                try { fs.unlinkSync(expectedJson); } catch (e) {}

                // Cache result
                try { fs.writeFileSync(cachePath, JSON.stringify(data), "utf8"); } catch (e) {}

                log("info", "Transcription complete: " + pathMod.basename(videoPath));
                return data;
            }).catch(function (err) {
                try { fs.unlinkSync(tempWav); } catch (e) {}
                throw err;
            });
        });
    }

    function transcribeAndMergeParts(whisperBin, modelPath, ffmpegBin, partPaths, partDurations) {
        var offsets = getCumulativeOffsets(partDurations);
        var allSegments = [];

        var chain = Promise.resolve();
        partPaths.forEach(function (pp, idx) {
            chain = chain.then(function () {
                return runWhisperCpp(whisperBin, modelPath, ffmpegBin, pp).then(function (data) {
                    var offset = offsets[idx];
                    var segments = data.transcription || data.segments || [];

                    for (var j = 0; j < segments.length; j++) {
                        var seg = Object.assign({}, segments[j]);
                        if (seg.timestamps) {
                            seg.timestamps = {
                                from: parseTime(seg.timestamps.from) + offset,
                                to: parseTime(seg.timestamps.to) + offset
                            };
                        } else {
                            seg.from = parseTime(seg.from || 0) + offset;
                            seg.to = parseTime(seg.to || 0) + offset;
                        }
                        allSegments.push(seg);
                    }
                });
            });
        });

        return chain.then(function () {
            return { transcription: allSegments };
        });
    }

    // ── Time Parsing ──

    function parseTime(t) {
        if (typeof t === "number") return t;
        if (typeof t !== "string") return 0;
        t = t.replace(",", ".");
        var parts = t.split(":");
        if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        return parseFloat(t) || 0;
    }

    // ── Text Matching (pure computation — runs synchronously, fast) ──

    function sequenceMatcherRatio(a, b) {
        if (!a || !b) return 0;
        var lenA = a.length, lenB = b.length;
        if (lenA === 0 || lenB === 0) return 0;

        var dp = [];
        for (var i = 0; i <= lenA; i++) {
            dp[i] = [];
            for (var j = 0; j <= lenB; j++) {
                if (i === 0 || j === 0) {
                    dp[i][j] = 0;
                } else if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        var lcs = dp[lenA][lenB];
        return (2.0 * lcs) / (lenA + lenB);
    }

    function buildWordList(whisperData) {
        var words = [];
        var segments = whisperData.transcription || whisperData.segments || [];

        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var tFrom, tTo;
            if (seg.timestamps) {
                tFrom = parseTime(seg.timestamps.from);
                tTo = parseTime(seg.timestamps.to);
            } else {
                tFrom = parseTime(seg.from || 0);
                tTo = parseTime(seg.to || 0);
            }

            var text = seg.text || "";
            var segWords = text.split(/\s+/).filter(function (w) { return w.length > 0; });
            if (segWords.length === 0) continue;

            var duration = Math.max(0.1, tTo - tFrom);
            var perWord = duration / segWords.length;

            for (var j = 0; j < segWords.length; j++) {
                words.push({
                    word: segWords[j].trim().toLowerCase(),
                    start: tFrom + j * perWord,
                    end: tFrom + (j + 1) * perWord
                });
            }
        }
        return words;
    }

    function findTextInWhisper(targetText, whisperData, hintSec, settings) {
        var simWeight = (settings && settings.similarityWeight) || 0.7;
        var timeWeight = 1.0 - simWeight;
        var threshold = (settings && settings.matchThreshold) || 0.5;
        var timeWindow = 30.0;

        var words = buildWordList(whisperData);
        var cleanTarget = targetText.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
        if (cleanTarget.length === 0) return { start: null, end: null };

        var bestScore = -1;
        var bestStart = 0;
        var bestEnd = 0;
        var windowLen = cleanTarget.length;

        for (var i = 0; i <= words.length - windowLen; i++) {
            var currentStart = words[i].start;
            if (Math.abs(currentStart - hintSec) > 300) continue;

            var windowWords = [];
            for (var k = i; k < i + windowLen; k++) {
                windowWords.push(words[k].word);
            }
            var windowStr = windowWords.join(" ");
            var targetStr = cleanTarget.join(" ");

            var similarity = sequenceMatcherRatio(targetStr, windowStr);
            var timeDiff = Math.abs(currentStart - hintSec);
            var timeScore = Math.max(0, 1 - timeDiff / timeWindow);
            var totalScore = similarity * simWeight + timeScore * timeWeight;

            if (totalScore > bestScore) {
                bestScore = totalScore;
                bestStart = words[i].start;
                bestEnd = words[i + windowLen - 1].end;
            }
        }

        if (bestScore >= threshold) {
            return { start: bestStart, end: bestEnd };
        }
        return { start: null, end: null };
    }

    // ── Sync (Whisper-based fallback) — pure computation ──

    function findTextForSync(targetText, whisperData) {
        var words = buildWordList(whisperData);
        var cleanTarget = targetText.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
        if (cleanTarget.length === 0) return { start: null, end: null };

        var bestScore = -1;
        var bestStart = 0;
        var bestEnd = 0;
        var windowLen = cleanTarget.length;

        for (var i = 0; i <= words.length - windowLen; i++) {
            var windowWords = [];
            for (var k = i; k < i + windowLen; k++) {
                windowWords.push(words[k].word);
            }
            var windowStr = windowWords.join(" ");
            var targetStr = cleanTarget.join(" ");

            var similarity = sequenceMatcherRatio(targetStr, windowStr);
            if (similarity > bestScore) {
                bestScore = similarity;
                bestStart = words[i].start;
                bestEnd = words[i + windowLen - 1].end;
            }
        }

        if (bestScore >= 0.6) return { start: bestStart, end: bestEnd };
        return { start: null, end: null };
    }

    function autoSyncCamera(refWhisper, secWhisper) {
        var refSegments = refWhisper.transcription || refWhisper.segments || [];
        if (refSegments.length < 5) {
            log("warn", "Too few reference segments for auto-sync");
            return null;
        }

        var step = Math.max(1, Math.floor(refSegments.length / 20));
        var offsets = [];

        for (var idx = 0; idx < refSegments.length && offsets.length < 20; idx += step) {
            var seg = refSegments[idx];
            var text = (seg.text || "").trim();
            if (text.split(/\s+/).length < 3) continue;

            var refTime = seg.timestamps
                ? parseTime(seg.timestamps.from)
                : parseTime(seg.from || 0);

            var match = findTextForSync(text, secWhisper);
            if (match.start !== null) {
                offsets.push(refTime - match.start);
            }
        }

        if (offsets.length < 3) {
            log("warn", "Auto-sync: only " + offsets.length + " matches — too few");
            return null;
        }

        offsets.sort(function (a, b) { return a - b; });
        var median = offsets[Math.floor(offsets.length / 2)];
        log("info", "Auto-sync: " + offsets.length + " matches, median offset = " + median.toFixed(3) + "s");
        return median;
    }

    // ── Waveform Sync (FFT cross-correlation) — async because of PCM extraction ──

    function extractPCM(ffmpegBin, filePath, sampleRate, maxSeconds) {
        sampleRate = sampleRate || 16000;
        maxSeconds = maxSeconds || 600;

        var pcmPath = pathMod.join(CACHE_DIR, "temp_sync_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4) + ".raw");

        return execAsync(ffmpegBin, [
            "-nostdin", "-y", "-i", filePath,
            "-t", String(maxSeconds),
            "-ar", String(sampleRate),
            "-ac", "1",
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            pcmPath
        ], 300000).then(function (result) {
            if (result.status !== 0 || !fs.existsSync(pcmPath)) {
                log("warn", "PCM extraction failed for " + pathMod.basename(filePath));
                return null;
            }
            var buf = fs.readFileSync(pcmPath);
            try { fs.unlinkSync(pcmPath); } catch (e) {}

            if (buf.length < 2000) {
                log("warn", "PCM too short for " + pathMod.basename(filePath));
                return null;
            }
            return buf;
        }).catch(function (e) {
            log("warn", "PCM extraction error: " + e.message);
            try { fs.unlinkSync(pcmPath); } catch (ex) {}
            return null;
        });
    }

    function pcmBufferToFloat(buf) {
        var len = Math.floor(buf.length / 2);
        var arr = new Float64Array(len);
        for (var i = 0; i < len; i++) {
            arr[i] = buf.readInt16LE(i * 2);
        }
        return arr;
    }

    // Simple real FFT using Cooley-Tukey (radix-2, power-of-2 length)
    function nextPow2(n) {
        var v = 1;
        while (v < n) v <<= 1;
        return v;
    }

    function fft(re, im, inverse) {
        var n = re.length;
        for (var i = 1, j = 0; i < n; i++) {
            var bit = n >> 1;
            while (j & bit) { j ^= bit; bit >>= 1; }
            j ^= bit;
            if (i < j) {
                var tmp = re[i]; re[i] = re[j]; re[j] = tmp;
                tmp = im[i]; im[i] = im[j]; im[j] = tmp;
            }
        }
        for (var len = 2; len <= n; len <<= 1) {
            var ang = 2 * Math.PI / len * (inverse ? -1 : 1);
            var wRe = Math.cos(ang), wIm = Math.sin(ang);
            for (var i = 0; i < n; i += len) {
                var curRe = 1, curIm = 0;
                for (var j = 0; j < len / 2; j++) {
                    var uRe = re[i + j], uIm = im[i + j];
                    var vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
                    var vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
                    re[i + j] = uRe + vRe;
                    im[i + j] = uIm + vIm;
                    re[i + j + len / 2] = uRe - vRe;
                    im[i + j + len / 2] = uIm - vIm;
                    var newCurRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = newCurRe;
                }
            }
        }
        if (inverse) {
            for (var i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
        }
    }

    function crossCorrelate(refArr, secArr, chunkStart, chunkLen, sampleRate) {
        var refChunk = refArr.slice(chunkStart, chunkStart + chunkLen);
        if (refChunk.length < chunkLen) return { offset: null, confidence: 0 };

        var n = nextPow2(secArr.length + chunkLen - 1);

        var aRe = new Float64Array(n);
        var aIm = new Float64Array(n);
        var bRe = new Float64Array(n);
        var bIm = new Float64Array(n);

        for (var i = 0; i < secArr.length; i++) aRe[i] = secArr[i];
        for (var i = 0; i < chunkLen; i++) bRe[i] = refChunk[i];

        fft(aRe, aIm, false);
        fft(bRe, bIm, false);

        var cRe = new Float64Array(n);
        var cIm = new Float64Array(n);
        for (var i = 0; i < n; i++) {
            cRe[i] = aRe[i] * bRe[i] + aIm[i] * bIm[i];
            cIm[i] = aIm[i] * bRe[i] - aRe[i] * bIm[i];
        }

        fft(cRe, cIm, true);

        var validLen = secArr.length;
        var peakIdx = 0;
        var peakVal = -Infinity;
        for (var i = 0; i < validLen; i++) {
            if (cRe[i] > peakVal) {
                peakVal = cRe[i];
                peakIdx = i;
            }
        }

        var absVals = [];
        for (var i = 0; i < validLen; i++) absVals.push(Math.abs(cRe[i]));
        absVals.sort(function (a, b) { return a - b; });
        var p95 = absVals[Math.floor(absVals.length * 0.95)] || 1;
        var confidence = peakVal / p95;

        var offsetSamples = chunkStart - peakIdx;
        var offsetSec = offsetSamples / sampleRate;

        return { offset: offsetSec, confidence: confidence };
    }

    function syncByWaveform(ffmpegBin, refPath, secPath, sampleRate) {
        sampleRate = sampleRate || 16000;

        log("info", "Waveform sync: extracting audio...");

        // Limit to 5 minutes each — sync offsets are always seconds, not hours.
        // Extracting a full hour creates ~2 GB of FFT arrays which OOM-crashes CEP.
        return Promise.all([
            extractPCM(ffmpegBin, refPath, sampleRate, 300),
            extractPCM(ffmpegBin, secPath, sampleRate, 300)
        ]).then(function (pcms) {
            var refPCM = pcms[0];
            var secPCM = pcms[1];

            if (!refPCM || !secPCM) return null;

            var refArr = pcmBufferToFloat(refPCM);
            var secArr = pcmBufferToFloat(secPCM);

            log("info", "Waveform sync: ref=" + (refArr.length / sampleRate).toFixed(1) + "s, sec=" + (secArr.length / sampleRate).toFixed(1) + "s");

            if (refArr.length < sampleRate * 4 || secArr.length < sampleRate * 4) {
                log("warn", "Audio too short for waveform sync");
                return null;
            }

            var refMax = 0, secMax = 0;
            for (var i = 0; i < refArr.length; i++) if (Math.abs(refArr[i]) > refMax) refMax = Math.abs(refArr[i]);
            for (var i = 0; i < secArr.length; i++) if (Math.abs(secArr[i]) > secMax) secMax = Math.abs(secArr[i]);
            if (refMax < 100 || secMax < 100) {
                log("warn", "Audio appears silent");
                return null;
            }
            for (var i = 0; i < refArr.length; i++) refArr[i] /= (refMax + 1e-9);
            for (var i = 0; i < secArr.length; i++) secArr[i] /= (secMax + 1e-9);

            var chunkSamples = Math.min(sampleRate * 30, Math.floor(refArr.length / 3));
            if (chunkSamples < sampleRate * 2) {
                log("warn", "Not enough audio for correlation chunks");
                return null;
            }

            var cs1 = Math.max(0, Math.floor(refArr.length / 3) - Math.floor(chunkSamples / 2));
            var cs2 = Math.floor(2 * refArr.length / 3) - Math.floor(chunkSamples / 2);
            cs2 = Math.max(cs1 + chunkSamples, Math.min(cs2, refArr.length - chunkSamples));

            log("info", "Waveform sync: chunk1 @ " + (cs1 / sampleRate).toFixed(1) + "s, chunk2 @ " + (cs2 / sampleRate).toFixed(1) + "s");

            var r1 = crossCorrelate(refArr, secArr, cs1, chunkSamples, sampleRate);
            var r2 = crossCorrelate(refArr, secArr, cs2, chunkSamples, sampleRate);

            log("info", "Waveform sync: chunk1 offset=" + (r1.offset || 0).toFixed(4) + "s (conf=" + r1.confidence.toFixed(2) + "x)");
            log("info", "Waveform sync: chunk2 offset=" + (r2.offset || 0).toFixed(4) + "s (conf=" + r2.confidence.toFixed(2) + "x)");

            if (r1.confidence < 2.0 && r2.confidence < 2.0) {
                log("warn", "Low confidence on both chunks — sync unreliable");
                return null;
            }

            if (r1.confidence >= 2.0 && r2.confidence >= 2.0) {
                var drift = Math.abs(r1.offset - r2.offset);
                if (drift > 0.5) {
                    log("warn", "Chunks disagree by " + drift.toFixed(2) + "s");
                    return r1.confidence > r2.confidence ? r1.offset : r2.offset;
                }
                var avg = (r1.offset + r2.offset) / 2;
                log("info", "Waveform sync: final offset = " + avg.toFixed(4) + "s (averaged)");
                return avg;
            }

            return r1.confidence >= 2.0 ? r1.offset : r2.offset;
        }).catch(function (e) {
            log("warn", "Waveform sync failed: " + e.message);
            return null;
        });
    }

    function syncPair(ffmpegBin, refPath, secPath, refWhisper, secWhisper, label) {
        log("info", "Syncing " + label + " (waveform)...");

        return syncByWaveform(ffmpegBin, refPath, secPath).then(function (offset) {
            if (offset !== null) {
                log("info", label + ": waveform sync = " + offset.toFixed(4) + "s");
                return offset;
            }
            log("info", label + ": waveform sync failed, trying Whisper fallback...");
            var fallback = autoSyncCamera(refWhisper, secWhisper);
            if (fallback !== null) {
                log("info", label + ": Whisper sync = " + fallback.toFixed(3) + "s");
            }
            return fallback;
        });
    }

    // ── Part Resolution (pure computation) ──

    function resolvePart(combinedTime, partDurations) {
        if (combinedTime < 0) return { partIndex: null, localTime: null };
        var cumulative = 0;
        for (var i = 0; i < partDurations.length; i++) {
            if (combinedTime < cumulative + partDurations[i]) {
                return { partIndex: i, localTime: combinedTime - cumulative };
            }
            cumulative += partDurations[i];
        }
        return { partIndex: null, localTime: null };
    }

    // ── Public API ──

    return {
        execAsync: execAsync,
        execAsyncWithProgress: execAsyncWithProgress,
        initCacheDir: initCacheDir,
        cleanupOldCacheFiles: cleanupOldCacheFiles,
        detectFPS: detectFPS,
        getPartDuration: getPartDuration,
        getPartDurations: getPartDurations,
        getCumulativeOffsets: getCumulativeOffsets,
        getAudioChannels: getAudioChannels,
        getVideoInfo: getVideoInfo,
        getVideoInfoSync: getVideoInfoSync,
        runWhisperCpp: runWhisperCpp,
        transcribeAndMergeParts: transcribeAndMergeParts,
        parseTime: parseTime,
        findTextInWhisper: findTextInWhisper,
        autoSyncCamera: autoSyncCamera,
        syncByWaveform: syncByWaveform,
        syncPair: syncPair,
        resolvePart: resolvePart,
        buildWordList: buildWordList,
        sequenceMatcherRatio: sequenceMatcherRatio
    };
})();
