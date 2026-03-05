/**
 * ae-runner.js — After Effects process management and leaderboard render orchestration.
 * Handles AE detection, script delivery (launch / COM bridge / -r fallback),
 * and the full processLeaderboard pipeline.
 */

/* global log, updateProgress, LeaderboardAE */

var AERunner = (function () {
    "use strict";

    var fs           = require("fs");
    var pathMod      = require("path");
    var childProcess = require("child_process");

    // ── AE detection ──

    function isAERunning() {
        return new Promise(function (resolve) {
            childProcess.exec(
                'tasklist /FI "IMAGENAME eq AfterFX.exe" /FO CSV /NH',
                { windowsHide: true, timeout: 5000 },
                function (err, stdout) {
                    resolve(!err && stdout && stdout.indexOf("AfterFX.exe") >= 0);
                }
            );
        });
    }

    /** Poll every 1 s until AfterFX.exe appears or maxWaitMs expires. */
    function waitForAEToStart(maxWaitMs) {
        return new Promise(function (resolve) {
            var started  = Date.now();
            var interval = setInterval(function () {
                isAERunning().then(function (running) {
                    if (running) {
                        clearInterval(interval);
                        log("info", "AE started after " + Math.round((Date.now() - started) / 1000) + "s");
                        resolve();
                    } else if (Date.now() - started >= maxWaitMs) {
                        clearInterval(interval);
                        log("warn", "AE startup timeout — continuing anyway");
                        resolve();
                    }
                });
            }, 1000);
        });
    }

    /**
     * Send a JSX script to a running AE instance via VBScript COM bridge.
     * Uses GetObject to attach to the running process and DoScriptFile to execute.
     */
    function sendScriptToRunningAE(jsxPath) {
        return new Promise(function (resolve, reject) {
            var winPath = jsxPath.replace(/\//g, "\\").replace(/"/g, '""');
            var vbs =
                'On Error Resume Next\r\n' +
                'Dim ae\r\n' +
                'Set ae = GetObject(, "AfterEffects.Application")\r\n' +
                'If ae Is Nothing Then\r\n' +
                '    WScript.StdErr.Write "ERROR:AE not reachable via COM"\r\n' +
                '    WScript.Quit 1\r\n' +
                'End If\r\n' +
                'ae.DoScriptFile "' + winPath + '"\r\n' +
                'If Err.Number <> 0 Then\r\n' +
                '    WScript.StdErr.Write "ERROR:" & Err.Description\r\n' +
                '    WScript.Quit 1\r\n' +
                'End If\r\n';

            var vbsPath = jsxPath.replace(/\.jsx$/, "") + "_run_" + Date.now() + ".vbs";
            try {
                fs.writeFileSync(vbsPath, vbs, "utf8");
            } catch (e) {
                return reject(new Error("Could not write VBS helper: " + e.message));
            }

            childProcess.exec(
                'cscript //nologo "' + vbsPath + '"',
                { windowsHide: true, timeout: 30000 },
                function (err, stdout, stderr) {
                    try { fs.unlinkSync(vbsPath); } catch (e) {}
                    if (err || (stderr && stderr.indexOf("ERROR:") >= 0)) {
                        reject(new Error(stderr || (err && err.message) || "COM bridge failed"));
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    /**
     * Run a JSX script in After Effects, handling all edge cases:
     *   - AE not running  → launch with -m -r (suppresses Home screen)
     *   - AE already running → send via COM bridge, fall back to -r
     */
    function runAEScript(aeExe, jsxPath) {
        return isAERunning().then(function (running) {
            if (!running) {
                log("info", "Leaderboard: starting After Effects...");
                childProcess.spawn(aeExe, ["-m", "-r", jsxPath], { detached: true, windowsHide: false });
                return waitForAEToStart(60000);
            }

            log("info", "Leaderboard: After Effects is already running, sending script via COM...");
            return sendScriptToRunningAE(jsxPath).then(function () {
                log("info", "Leaderboard: script sent to running AE instance");
            }).catch(function (comErr) {
                log("warn", "Leaderboard: COM bridge failed (" + comErr.message + "), trying -r flag...");
                childProcess.spawn(aeExe, ["-m", "-r", jsxPath], { detached: true, windowsHide: false });
            });
        });
    }

    // ── Auto-detect After Effects installation ──

    function findAfterEffectsExe() {
        var searchDirs = [
            "C:\\Program Files\\Adobe",
            "C:\\Program Files (x86)\\Adobe"
        ];
        var candidates = [];
        for (var si = 0; si < searchDirs.length; si++) {
            try {
                if (!fs.existsSync(searchDirs[si])) continue;
                var entries = fs.readdirSync(searchDirs[si]);
                for (var ei = 0; ei < entries.length; ei++) {
                    var name = entries[ei];
                    if (name.toLowerCase().indexOf("after effects") === -1) continue;
                    var exe = pathMod.join(searchDirs[si], name, "Support Files", "afterfx.exe");
                    if (fs.existsSync(exe)) candidates.push({ path: exe, name: name });
                }
            } catch (e) {}
        }
        if (candidates.length === 0) return "";
        candidates.sort(function (a, b) {
            var yearA = (a.name.match(/(\d{4})/) || [0, 0])[1];
            var yearB = (b.name.match(/(\d{4})/) || [0, 0])[1];
            if (yearA !== yearB) return yearB - yearA;
            var betaA = a.name.toLowerCase().indexOf("beta") >= 0 ? 1 : 0;
            var betaB = b.name.toLowerCase().indexOf("beta") >= 0 ? 1 : 0;
            if (betaA !== betaB) return betaA - betaB;
            return b.name.localeCompare(a.name);
        });
        console.log("[AERunner] After Effects candidates:", candidates.map(function (c) { return c.name; }).join(", "));
        return candidates[0].path;
    }

    // ── Leaderboard render pipeline ──

    /**
     * Generate a leaderboard .mov via After Effects.
     *
     * @param {Object} opts
     * @param {string} opts.aepPath       - Path to the AE leaderboard project
     * @param {string} opts.name          - Guest name
     * @param {number} opts.position      - Leaderboard position
     * @param {number} opts.score         - Score percentage (0–100)
     * @param {string} opts.projectFolder - Output directory for renders
     * @param {string} opts.aeExe         - Path to afterfx.exe
     * @param {boolean} [opts.force]      - Skip cache check and always re-render
     * @returns {Promise<{movPath: string, gridPngPath: string|null}>}
     */
    function processLeaderboard(opts) {
        var aepPath       = opts.aepPath;
        var name          = opts.name;
        var position      = opts.position;
        var score         = opts.score;
        var projectFolder = opts.projectFolder;
        var aeExe         = opts.aeExe;
        var force         = opts.force || false;

        if (!aepPath || !fs.existsSync(aepPath)) {
            return Promise.reject(new Error("AE leaderboard project not found: " + aepPath));
        }
        if (!aeExe || !fs.existsSync(aeExe)) {
            return Promise.reject(new Error("After Effects not found. Set it in Settings.\n" + aeExe));
        }
        if (!name) {
            return Promise.reject(new Error("Leaderboard: guest name is required."));
        }
        if (isNaN(position) || position < 1) {
            return Promise.reject(new Error("Leaderboard: position must be 1 or higher."));
        }
        if (isNaN(score) || score < 0 || score > 100) {
            return Promise.reject(new Error("Leaderboard: score must be 0–100."));
        }

        if (!fs.existsSync(projectFolder)) {
            fs.mkdirSync(projectFolder, { recursive: true });
        }

        var safeName          = name.replace(/[<>:"/\\|?*]/g, "_");
        var outputAepPath     = pathMod.join(projectFolder, "LEADERBOARD_" + safeName + ".aep");
        var outputMovPath     = pathMod.join(projectFolder, "LEADERBOARD_" + safeName + ".mov");
        var outputGridPngPath = pathMod.join(projectFolder, "LEADERBOARD_GRID_" + safeName + ".png");
        var sentinelPath      = pathMod.join(projectFolder, "_lb_done.txt");
        var jsxPath           = pathMod.join(projectFolder, "_leaderboard_update.jsx");

        // Cache check — skip AE if the .mov already exists from a previous run
        if (!force && fs.existsSync(outputMovPath)) {
            try {
                if (fs.statSync(outputMovPath).size > 0) {
                    log("info", "Leaderboard: cached .mov found — skipping After Effects render");
                    log("info", "  " + outputMovPath + "  (delete to re-render)");
                    var cached = { movPath: outputMovPath };
                    if (fs.existsSync(outputGridPngPath)) cached.gridPngPath = outputGridPngPath;
                    return Promise.resolve(cached);
                }
            } catch (ex) { /* stat failed — fall through to render */ }
        }

        try { if (fs.existsSync(sentinelPath)) fs.unlinkSync(sentinelPath); } catch (ex) {}

        var jsxContent = LeaderboardAE.generateJSX({
            aepPath: aepPath,
            newName: name,
            newPosition: position,
            newScore: score,
            outputAepPath: outputAepPath,
            outputMovPath: outputMovPath,
            outputGridPngPath: outputGridPngPath,
            sentinelPath: sentinelPath
        });
        fs.writeFileSync(jsxPath, jsxContent, "utf8");

        log("info", "Leaderboard: launching After Effects...");
        log("info", "  AEP: " + aepPath);
        log("info", "  Guest: " + name + " | Pos: " + position + " | Score: " + score + "%");

        return runAEScript(aeExe, jsxPath).then(function () {
            return new Promise(function (resolve, reject) {
                var timeout = 600;   // 10 minutes
                var elapsed = 0;
                var interval = setInterval(function () {
                    elapsed += 3;
                    updateProgress(56 + Math.min(Math.floor(elapsed / 60), 10),
                        "Leaderboard: exporting in AE... (" + elapsed + "s)");
                    if (elapsed % 30 === 0 || elapsed === 3) {
                        log("info", "Leaderboard: exporting in AE... (" + elapsed + "s)");
                    }

                    if (fs.existsSync(sentinelPath)) {
                        clearInterval(interval);
                        var result = "";
                        try { result = fs.readFileSync(sentinelPath, "utf8"); } catch (ex) {}
                        try { fs.unlinkSync(sentinelPath); } catch (ex) {}

                        if (result.indexOf("ERROR:") === 0) {
                            log("warn", "Leaderboard: AE reported error: " + result);
                            reject(new Error(result));
                        } else {
                            if (result.indexOf("WARNING:") >= 0) log("warn", "Leaderboard: " + result.split("\n")[0]);
                            log("success", "Leaderboard: AE finished in " + elapsed + "s");
                            _waitForMov(outputMovPath, result, 120, resolve);
                        }
                    } else if (elapsed >= timeout) {
                        clearInterval(interval);
                        log("warn", "Leaderboard: AE timed out after " + timeout + "s");
                        if (fs.existsSync(outputMovPath)) {
                            log("info", "  Output .mov exists, continuing...");
                            resolve({ movPath: outputMovPath, gridPngPath: null });
                        } else {
                            reject(new Error("After Effects timed out and no .mov was rendered."));
                        }
                    }
                }, 3000);
            });
        });
    }

    /** Poll until the .mov file is non-empty (up to retries × 500 ms). */
    function _waitForMov(movPath, sentinelContent, retries, resolve) {
        if (retries <= 0) {
            log("warn", "Leaderboard: .mov not ready after sentinel — continuing anyway");
            resolve({ movPath: movPath, gridPngPath: null });
            return;
        }
        if (fs.existsSync(movPath)) {
            try {
                var stat = fs.statSync(movPath);
                if (stat.size > 1000) {
                    log("info", "  Output: " + movPath + " (" + Math.round(stat.size / 1024) + " KB)");
                    var gridPngPath = null;
                    var lines = sentinelContent.split("\n");
                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].indexOf(".png") >= 0) {
                            gridPngPath = lines[i].replace(/^\s+|\s+$/g, "");
                            break;
                        }
                    }
                    if (gridPngPath && fs.existsSync(gridPngPath)) {
                        log("info", "  Grid PNG: " + gridPngPath);
                    } else { gridPngPath = null; }
                    resolve({ movPath: movPath, gridPngPath: gridPngPath });
                    return;
                }
            } catch (e) {}
        }
        setTimeout(function () { _waitForMov(movPath, sentinelContent, retries - 1, resolve); }, 500);
    }

    return {
        findAfterEffectsExe: findAfterEffectsExe,
        processLeaderboard:  processLeaderboard
    };
})();
