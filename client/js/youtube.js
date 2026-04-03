/**
 * youtube.js — YouTube clip download and trim via yt-dlp + FFmpeg.
 * Called during step 5c of the generate pipeline.
 */

/* global log, updateProgress, Processing, QuoteCards */

var YouTubeClips = (function () {
    "use strict";

    var fs      = require("fs");
    var pathMod = require("path");

    /**
     * Download and trim YouTube clips referenced by quote card entries.
     *
     * @param {Array}  qcEntries   - Parsed quote card entries (from QuoteCards)
     * @param {string} ytCacheDir  - Directory for full downloaded videos (cache)
     * @param {string} ytOutputDir - Directory for trimmed output clips
     * @param {Object} settings    - { ytDlpExe, ffmpegExe }
     * @returns {Promise<Object>} Resolves to { cardIndex: trimmedFilePath, ... }
     */
    function download(qcEntries, ytCacheDir, ytOutputDir, settings) {
        var ytDlp  = settings.ytDlpExe;
        var ffmpeg = settings.ffmpegExe;

        if (!ytDlp || !fs.existsSync(ytDlp)) {
            log("warn", "yt-dlp not found — skipping YouTube clip downloads. Set path in Settings.");
            return Promise.resolve({});
        }
        if (!ffmpeg || !fs.existsSync(ffmpeg)) {
            log("warn", "ffmpeg not found — cannot trim YouTube clips.");
            return Promise.resolve({});
        }

        try {
            if (!fs.existsSync(ytCacheDir))  fs.mkdirSync(ytCacheDir,  { recursive: true });
            if (!fs.existsSync(ytOutputDir)) fs.mkdirSync(ytOutputDir, { recursive: true });
        } catch (e) {
            log("warn", "Failed to create YouTube directories: " + e.message);
            return Promise.resolve({});
        }

        var clipMap = {};       // cardIndex -> trimmed path
        var chain   = Promise.resolve();

        // Collect unique video IDs so each full video is downloaded only once
        var videosNeeded = {};  // videoId -> { url, cachePath }
        for (var i = 0; i < qcEntries.length; i++) {
            var entry = qcEntries[i];
            if (!entry.ytUrl || !entry.ytVideoId) continue;
            if (!videosNeeded[entry.ytVideoId]) {
                videosNeeded[entry.ytVideoId] = {
                    url:       entry.ytUrl,
                    cachePath: pathMod.join(ytCacheDir, entry.ytVideoId + ".mp4")
                };
            }
        }

        // ── Phase 1: Download unique videos (skip if already cached) ──
        var videoIds = Object.keys(videosNeeded);
        for (var vi = 0; vi < videoIds.length; vi++) {
            (function (vid) {
                var info = videosNeeded[vid];
                chain = chain.then(function () {
                    if (fs.existsSync(info.cachePath)) {
                        log("info", "YT cache hit: " + vid);
                        return;
                    }
                    log("info", "Downloading YouTube video: " + vid + "...");
                    updateProgress(54, "Downloading YouTube: " + vid + "...");
                    return Processing.execAsync(ytDlp, [
                        "-f", "bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4/best",
                        "--merge-output-format", "mp4",
                        "-o", info.cachePath,
                        "--no-playlist",
                        info.url
                    ], 300000).then(function (result) {
                        if (result.status !== 0) {
                            log("warn", _ytDlpErrorMessage(vid, result.stderr || ""));
                        } else if (fs.existsSync(info.cachePath)) {
                            log("info", "Downloaded: " + vid);
                        } else {
                            log("warn", "yt-dlp finished but file not found: " + vid);
                        }
                    }).catch(function (e) {
                        log("warn", "yt-dlp failed for " + vid + ": " + e.message);
                    });
                });
            })(videoIds[vi]);
        }

        // ── Phase 2: Trim each card's time range (buffered ±2 s) ──
        for (var ci = 0; ci < qcEntries.length; ci++) {
            (function (cardIdx) {
                var e = qcEntries[cardIdx];
                if (!e.ytUrl || !e.ytVideoId) return;

                var slug        = QuoteCards.sceneSlug(e.scene);
                var idxStr      = String(cardIdx + 1);
                if (idxStr.length < 2) idxStr = "0" + idxStr;
                var trimmedPath = pathMod.join(ytOutputDir, idxStr + "_" + slug + ".mp4");

                chain = chain.then(function () {
                    if (fs.existsSync(trimmedPath)) {
                        log("info", "YT trim cached: " + pathMod.basename(trimmedPath));
                        clipMap[cardIdx] = trimmedPath;
                        return;
                    }

                    var cachePath = videosNeeded[e.ytVideoId].cachePath;
                    if (!fs.existsSync(cachePath)) {
                        log("warn", "Cached video not found for trim: " + e.ytVideoId);
                        return;
                    }

                    var startSec = Math.max(0, e.ytStart - 2);
                    var endSec   = e.ytEnd + 2;
                    log("info", "Trimming " + e.ytVideoId + " " + startSec + "s–" + endSec + "s -> " + pathMod.basename(trimmedPath));
                    updateProgress(54, "Trimming YouTube clip: " + (cardIdx + 1) + "/" + qcEntries.length);

                    return Processing.execAsync(ffmpeg, [
                        "-y",
                        "-ss", String(startSec),
                        "-i", cachePath,
                        "-t", String(endSec - startSec),
                        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                        "-c:a", "aac", "-b:a", "192k",
                        "-pix_fmt", "yuv420p",
                        "-avoid_negative_ts", "make_zero",
                        trimmedPath
                    ], 120000).then(function () {
                        if (fs.existsSync(trimmedPath)) {
                            clipMap[cardIdx] = trimmedPath;
                        } else {
                            log("warn", "Trim produced no output: " + pathMod.basename(trimmedPath));
                        }
                    }).catch(function (e) {
                        log("warn", "Trim failed: " + e.message);
                    });
                });
            })(ci);
        }

        return chain.then(function () { return clipMap; });
    }

    /** Produce a human-readable error message from yt-dlp stderr. */
    function _ytDlpErrorMessage(vid, stderr) {
        var msg = "yt-dlp failed for " + vid;
        if      (stderr.indexOf("Video unavailable") >= 0)                             msg += ": Video is unavailable or deleted";
        else if (stderr.indexOf("Private video") >= 0)                                 msg += ": Video is private";
        else if (stderr.indexOf("429") >= 0 || stderr.toLowerCase().indexOf("too many requests") >= 0) msg += ": Rate limited by YouTube — try again later";
        else if (stderr.toLowerCase().indexOf("copyright") >= 0)                       msg += ": Video blocked due to copyright";
        else                                                                            msg += ": " + stderr.substring(0, 200);
        return msg;
    }

    return { download: download };
})();
