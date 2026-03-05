/**
 * main.js — Main UI controller for the Paper Editor CEP panel.
 * Wires together the UI, processing, XMEML generation, and Premiere integration.
 *
 * All heavy processing is async (Promises) to avoid blocking the CEP UI thread.
 */

(function () {
    "use strict";

    var fs = require("fs");
    var pathMod = require("path");
    var childProcess = require("child_process");
    // Without --mixed-context, Node globals aren't auto-injected into the browser context.
    var process = (typeof process !== "undefined") ? process : require("process");

    var csInterface;
    var extensionDir;

    // Safely init CSInterface (may fail outside CEP)
    try {
        csInterface = new CSInterface();
        extensionDir = csInterface.getSystemPath(CSInterface.SystemPath.EXTENSION);
        // CEP may return a file:\ or file:/// URI — strip it to a plain path
        if (extensionDir) {
            extensionDir = extensionDir.replace(/^file:\/{0,3}/, "");
            // On Windows the path may start like /C:/... — remove leading slash before drive letter
            if (/^\/[A-Za-z]:/.test(extensionDir)) {
                extensionDir = extensionDir.substring(1);
            }
        }
        console.log("[Paper Editor] Extension dir:", extensionDir);

        // Probe: confirm basic evalScript is working (no ScriptPath poisoning).
        (function () {
            try {
                window.__adobe_cep__.evalScript("app.version", function (res) {
                    console.log("[Paper Editor] probe app.version:", res);
                });
            } catch (probeErr) {
                console.error("[Paper Editor] probe threw:", probeErr.message);
            }
        })();
    } catch (e) {
        console.error("[Paper Editor] CSInterface init failed (not in CEP?):", e.message);
        extensionDir = __dirname || ".";
    }

    // ── State ──

    var cameras = [];       // [{ label, parts: [path, ...] }]
    var extAudioParts = []; // [path, ...]
    var isRunning = false;
    var abortRequested = false;
    var lastXmlPath = null; // #8: track last written XMEML path for recovery

    // ── Auto-detect Photoshop ──

    function findPhotoshopExe() {
        var searchDirs = [
            "C:\\Program Files\\Adobe",
            "C:\\Program Files (x86)\\Adobe"
        ];
        // Prefer newer / non-beta, but accept anything with Photoshop.exe
        var candidates = [];
        for (var si = 0; si < searchDirs.length; si++) {
            try {
                if (!fs.existsSync(searchDirs[si])) continue;
                var entries = fs.readdirSync(searchDirs[si]);
                for (var ei = 0; ei < entries.length; ei++) {
                    var name = entries[ei];
                    if (name.toLowerCase().indexOf("photoshop") === -1) continue;
                    var exe = pathMod.join(searchDirs[si], name, "Photoshop.exe");
                    if (fs.existsSync(exe)) {
                        candidates.push({ path: exe, name: name });
                    }
                }
            } catch (e) { /* ignore permission errors */ }
        }
        if (candidates.length === 0) return "";
        // Sort: prefer folders with a year number (2025, 2026…), then non-beta, then alphabetical descending
        candidates.sort(function (a, b) {
            var yearA = (a.name.match(/(\d{4})/) || [0, 0])[1];
            var yearB = (b.name.match(/(\d{4})/) || [0, 0])[1];
            if (yearA !== yearB) return yearB - yearA; // higher year first
            var betaA = a.name.toLowerCase().indexOf("beta") >= 0 ? 1 : 0;
            var betaB = b.name.toLowerCase().indexOf("beta") >= 0 ? 1 : 0;
            if (betaA !== betaB) return betaA - betaB; // non-beta first
            return b.name.localeCompare(a.name);
        });
        console.log("[Paper Editor] Photoshop candidates:", candidates.map(function (c) { return c.name; }).join(", "));
        return candidates[0].path;
    }

    // ── Derive guest name from paper edit filename ──

    function deriveGuestName(filePath) {
        var base = pathMod.basename(filePath, pathMod.extname(filePath));
        // Strip common suffixes
        base = base.replace(/[_\- ]?(paper\s*edit|paperedit|quote\s*cards|quotecards|project)/gi, "");
        base = base.trim();
        if (!base) return "Guest";
        // Split camelCase or underscores/dashes into words
        base = base
            .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
            .replace(/[_\-]+/g, " ")               // underscore/dash split
            .trim();
        // Title case each word
        return base.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }


    // ── Default settings ──
    // All file paths default to locations relative to the extension install directory.
    // The install_dev.bat copies binaries into bin/ and templates into templates/.

    var settings = {
        whisperExe: pathMod.join(extensionDir, "bin", "whisper.exe"),
        ffmpegExe: pathMod.join(extensionDir, "bin", "ffmpeg.exe"),
        ffprobeExe: pathMod.join(extensionDir, "bin", "ffprobe.exe"),
        whisperModel: pathMod.join(extensionDir, "bin", "models", "ggml-base.en.bin"),
        psExe: findPhotoshopExe(),
        aeExe: AERunner.findAfterEffectsExe(),
        ytDlpExe: pathMod.join(extensionDir, "bin", "yt-dlp.exe"),
        heartsMogrt: pathMod.join(extensionDir, "templates", "Hearts_SINGLELINE_V3.mogrt"),
        qcTemplatePsd: pathMod.join(extensionDir, "templates", "Quote Card Template.psd"),
        nameMogrt: pathMod.join(extensionDir, "templates", "Name.mogrt"),
        titleCardMov: pathMod.join(extensionDir, "templates", "QUOTES_Title Card.mov"),
        endCardNoLogoMov: pathMod.join(extensionDir, "templates", "16-9 fall damage END CARD_nologo.mov"),
        endCard2Mov: pathMod.join(extensionDir, "templates", "16-9 fall damage END CARD 2.mov"),
        matchThreshold: 0.5,
        similarityWeight: 0.7
    };

    var SETTINGS_FILE = pathMod.join(extensionDir, "settings.json");
    var CACHE_FILE    = pathMod.join(extensionDir, "cache.json");

    // ── Logging ──

    var logArea = null;

    window.log = function (level, msg) {
        try {
            if (!logArea) logArea = document.getElementById("log-area");
            if (!logArea) { console.log("[LOG " + level + "]", msg); return; }

            var time = new Date().toLocaleTimeString();
            var cls = level === "warn" ? "log-warn" : level === "success" ? "log-success" : "log-info";
            var line = document.createElement("div");
            line.className = cls;
            line.textContent = time + " " + msg;
            logArea.appendChild(line);
            logArea.scrollTop = logArea.scrollHeight;

            // Also log to console for debugging via Chrome DevTools
            if (level === "warn") console.warn("[PE]", msg);
            else console.log("[PE]", msg);
        } catch (e) {
            console.error("log() failed:", e);
        }
    };

    window.updateProgress = function (pct, text) {
        try {
            var bar = document.getElementById("progress-bar");
            var label = document.getElementById("progress-label");
            if (bar && pct >= 0) bar.style.width = pct + "%";
            if (label) label.textContent = text;
        } catch (e) {
            console.error("updateProgress() failed:", e);
        }
    };

    function showErrorBanner(msg) {
        var banner = document.getElementById("error-banner");
        if (banner) {
            banner.textContent = msg;
            banner.style.display = "";
            banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }

    function hideErrorBanner() {
        var banner = document.getElementById("error-banner");
        if (banner) banner.style.display = "none";
    }

    window.getSettings = function () { return settings; };

    // ── Log export (#15) ──

    function copyLog() {
        try {
            var area = document.getElementById("log-area");
            if (!area) return;
            var lines = [];
            area.querySelectorAll("div").forEach(function (el) {
                lines.push(el.textContent || "");
            });
            var text = lines.join("\n");
            // Use a textarea + execCommand as clipboard API is restricted in CEP
            var ta = document.createElement("textarea");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            log("info", "Log copied to clipboard (" + lines.length + " lines)");
        } catch (e) {
            log("warn", "Copy log failed: " + e.message);
        }
    }

    // ── Settings persistence ──

    function loadSettings() {
        try {
            if (fs.existsSync(SETTINGS_FILE)) {
                var data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
                for (var k in data) {
                    if (data.hasOwnProperty(k) && settings.hasOwnProperty(k)) {
                        settings[k] = data[k];
                    }
                }
                console.log("[Paper Editor] Settings loaded from", SETTINGS_FILE);
            }
        } catch (e) {
            console.warn("Failed to load settings:", e.message);
        }
    }

    function saveSettings() {
        try {
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
        } catch (e) {
            console.warn("Failed to save settings:", e.message);
            log("warn", "Settings could not be saved: " + e.message);
        }
    }

    // ── Settings export / import (#13) ──

    function exportSettings() {
        browseFolder(function (chosenDir) {
            if (!validatePath(chosenDir)) return;
            var dest = pathMod.join(chosenDir, "settings.json");
            try {
                fs.writeFileSync(dest, JSON.stringify(settings, null, 2), "utf8");
                log("success", "Settings exported to: " + dest);
            } catch (e) {
                log("warn", "Settings export failed: " + e.message);
            }
        });
    }

    function importSettings() {
        browseFile(function (chosen) {
            if (!validatePath(chosen) || !chosen.toLowerCase().endsWith(".json")) {
                log("warn", "Import cancelled — please select a .json settings file");
                return;
            }
            try {
                var data = JSON.parse(fs.readFileSync(chosen, "utf8"));
                for (var k in data) {
                    if (data.hasOwnProperty(k) && settings.hasOwnProperty(k)) {
                        settings[k] = data[k];
                    }
                }
                saveSettings();
                // Refresh the open modal fields if the modal is visible
                var modal = document.getElementById("settings-modal");
                if (modal && modal.style.display !== "none") {
                    openSettings();
                }
                log("success", "Settings imported from: " + chosen);
            } catch (e) {
                log("warn", "Settings import failed: " + e.message);
            }
        });
    }

    // ── Session cache persistence ──

    function saveCache() {
        try {
            var cache = {
                cameras: cameras,
                extAudioParts: extAudioParts,
                paperEditPath: document.getElementById("paper-edit-path").value,
                outputDir: document.getElementById("output-dir").value,
                fps: document.getElementById("fps").value,
                padding: document.getElementById("padding").value,
                gapDuration: document.getElementById("gap-duration").value,
                qcDataFile: document.getElementById("qc-data-file").value,
                lbAepPath: document.getElementById("lb-aep-path").value,
                lbGuestName: document.getElementById("lb-guest-name").value,
                lbPosition: document.getElementById("lb-position").value,
                lbScore: document.getElementById("lb-score").value,
                optExtAudio: document.getElementById("opt-ext-audio").checked,
                optQuoteCards: document.getElementById("opt-quote-cards").checked,
                optYtClips: document.getElementById("opt-yt-clips").checked,
                optLeaderboard: document.getElementById("opt-leaderboard").checked,
                optHearts: document.getElementById("opt-hearts").checked,
                optSparkles: document.getElementById("opt-sparkles").checked,
                optNameMogrt: document.getElementById("opt-name-mogrt").checked
            };
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
        } catch (e) {
            console.warn("Failed to save cache:", e.message);
        }
    }

    function clearCache() {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                fs.unlinkSync(CACHE_FILE);
                log("info", "Session cache cleared.");
            }
            cameras = [];
            extAudioParts = [];
            addCamera();
            renderExtAudio();
            document.getElementById("paper-edit-path").value = "";
            document.getElementById("output-dir").value = "";
            document.getElementById("qc-data-file").value = "";
            document.getElementById("lb-aep-path").value = "";
            document.getElementById("lb-guest-name").value = "";
            document.getElementById("lb-position").value = "";
            document.getElementById("lb-score").value = "";
            // Reset checkboxes to their HTML defaults and fire change events
            var checkDefaults = [
                ["opt-hearts", true], ["opt-sparkles", true], ["opt-name-mogrt", true],
                ["opt-quote-cards", true], ["opt-yt-clips", true],
                ["opt-leaderboard", true], ["opt-ext-audio", false]
            ];
            checkDefaults.forEach(function (cd) {
                var el = document.getElementById(cd[0]);
                if (el) { el.checked = cd[1]; el.dispatchEvent(new Event("change")); }
            });
            // Reset numeric fields to their defaults
            document.getElementById("fps").value = "23.976";
            document.getElementById("padding").value = "0.5";
            document.getElementById("gap-duration").value = "5.0";
        } catch (e) {
            log("warn", "Failed to clear cache: " + e.message);
        }
    }

    function loadCache() {
        try {
            if (!fs.existsSync(CACHE_FILE)) return;
            var cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));

            // Cameras
            if (cache.cameras && cache.cameras.length > 0) {
                cameras = cache.cameras;
                renderCameras();
            }

            // External audio
            if (cache.extAudioParts && cache.extAudioParts.length > 0) {
                extAudioParts = cache.extAudioParts;
                renderExtAudio();
            }

            // Text inputs
            if (cache.paperEditPath) document.getElementById("paper-edit-path").value = cache.paperEditPath;
            if (cache.outputDir) document.getElementById("output-dir").value = cache.outputDir;
            if (cache.fps) document.getElementById("fps").value = cache.fps;
            if (cache.padding) document.getElementById("padding").value = cache.padding;
            if (cache.gapDuration) document.getElementById("gap-duration").value = cache.gapDuration;
            if (cache.qcDataFile) document.getElementById("qc-data-file").value = cache.qcDataFile;
            if (cache.lbAepPath) document.getElementById("lb-aep-path").value = cache.lbAepPath;
            if (cache.lbGuestName !== undefined) document.getElementById("lb-guest-name").value = cache.lbGuestName;
            if (cache.lbPosition !== undefined) document.getElementById("lb-position").value = cache.lbPosition;
            if (cache.lbScore !== undefined) document.getElementById("lb-score").value = cache.lbScore;

            // Feature toggles — set checkbox state then fire change event to update UI
            var toggles = [
                ["opt-ext-audio", cache.optExtAudio],
                ["opt-quote-cards", cache.optQuoteCards],
                ["opt-yt-clips", cache.optYtClips],
                ["opt-leaderboard", cache.optLeaderboard],
                ["opt-hearts", cache.optHearts],
                ["opt-sparkles", cache.optSparkles],
                ["opt-name-mogrt", cache.optNameMogrt]
            ];
            toggles.forEach(function (t) {
                if (t[1] !== undefined) {
                    var el = document.getElementById(t[0]);
                    el.checked = t[1];
                    el.dispatchEvent(new Event("change"));
                }
            });

            console.log("[Paper Editor] Cache loaded from", CACHE_FILE);
            return true;
        } catch (e) {
            console.warn("Failed to load cache:", e.message);
        }
        return false;
    }

    // ── Path validation (#16) ──

    function validatePath(p) {
        return typeof p === "string" && p.length > 0 && p.indexOf("\0") === -1;
    }

    // ── File Browser (uses PowerShell dialogs on Windows) ──

    function browseFile(callback) {
        var psScript = [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$d = New-Object System.Windows.Forms.OpenFileDialog",
            "$d.Title = 'Select File'",
            "if ($d.ShowDialog() -eq 'OK') { $d.FileName | Set-Content -Path $env:TEMP\\pe_browse_result.txt -Encoding UTF8 }"
        ].join("; ");
        var psPath = pathMod.join(extensionDir, "_pe_browse_file.ps1");
        try {
            fs.writeFileSync(psPath, psScript, "utf8");
        } catch (e) {
            childProcess.exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = \'Select File\'; if ($d.ShowDialog() -eq \'OK\') { Write-Output $d.FileName }"',
                { windowsHide: true, timeout: 60000 },
                function (err, stdout) {
                    if (!err && stdout && stdout.trim()) callback(stdout.trim());
                });
            return;
        }
        var resultPath = (process.env.TEMP || process.env.TMP || "C:\\Temp") + "\\pe_browse_result.txt";
        try { if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath); } catch (e) {}
        childProcess.exec(
            'powershell -NoProfile -ExecutionPolicy Bypass -File "' + psPath.replace(/"/g, '\\"') + '"',
            { windowsHide: true, timeout: 60000 },
            function (err) {
                try {
                    if (fs.existsSync(resultPath)) {
                        var result = fs.readFileSync(resultPath, "utf8").trim();
                        if (result) callback(result);
                        fs.unlinkSync(resultPath);
                    }
                } catch (e) {}
                try { if (fs.existsSync(psPath)) fs.unlinkSync(psPath); } catch (e2) {}
            }
        );
    }

    function browseFolder(callback) {
        var ps = [
            "Add-Type -AssemblyName System.Windows.Forms",
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
            "$d.Description = 'Select Folder'",
            "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
        ].join("; ");

        childProcess.exec(
            'powershell -command "' + ps.replace(/"/g, '\\"') + '"',
            { windowsHide: true, timeout: 60000 },
            function (err, stdout) {
                if (!err && stdout && stdout.trim()) callback(stdout.trim());
            }
        );
    }

    // ── Camera UI ──

    function renderCameras() {
        var container = document.getElementById("cameras-container");
        container.innerHTML = "";

        cameras.forEach(function (cam, camIdx) {
            var block = document.createElement("div");
            block.className = "camera-block";

            var header = document.createElement("div");
            header.className = "camera-header";

            var labelInput = document.createElement("input");
            labelInput.className = "camera-label-input";
            labelInput.value = cam.label;
            labelInput.addEventListener("change", function () { cam.label = this.value; });
            header.appendChild(labelInput);

            if (camIdx === 0) {
                var badge = document.createElement("span");
                badge.className = "ref-badge";
                badge.textContent = "REF";
                header.appendChild(badge);
            }

            var addPartBtn = document.createElement("button");
            addPartBtn.className = "btn-sm";
            addPartBtn.textContent = "+ Part";
            addPartBtn.addEventListener("click", function () {
                cam.parts.push("");
                renderCameras();
            });
            header.appendChild(addPartBtn);

            if (camIdx > 0) {
                var removeBtn = document.createElement("button");
                removeBtn.className = "btn-remove";
                removeBtn.textContent = "Remove";
                removeBtn.style.marginLeft = "auto";
                removeBtn.addEventListener("click", function () {
                    cameras.splice(camIdx, 1);
                    renderCameras();
                });
                header.appendChild(removeBtn);
            }

            block.appendChild(header);

            cam.parts.forEach(function (partPath, partIdx) {
                var partRow = document.createElement("div");
                partRow.className = "part-row";

                var partLabel = document.createElement("span");
                partLabel.className = "part-label";
                partLabel.textContent = "Part " + (partIdx + 1);
                partRow.appendChild(partLabel);

                var partInput = document.createElement("input");
                partInput.className = "text-input";
                partInput.value = partPath;
                partInput.placeholder = "Select video file...";
                partInput.addEventListener("change", function () {
                    cam.parts[partIdx] = this.value;
                    if (camIdx === 0 && partIdx === 0) autoDetectFPS(this.value);
                });
                partRow.appendChild(partInput);

                var browseBtn = document.createElement("button");
                browseBtn.className = "btn-browse";
                browseBtn.textContent = "Browse";
                browseBtn.addEventListener("click", function () {
                    browseFile(function (path) {
                        cam.parts[partIdx] = path;
                        partInput.value = path;
                        if (camIdx === 0 && partIdx === 0) autoDetectFPS(path);
                    });
                });
                partRow.appendChild(browseBtn);

                if (partIdx > 0) {
                    var removePartBtn = document.createElement("button");
                    removePartBtn.className = "btn-remove";
                    removePartBtn.textContent = "X";
                    removePartBtn.addEventListener("click", function () {
                        cam.parts.splice(partIdx, 1);
                        renderCameras();
                    });
                    partRow.appendChild(removePartBtn);
                }

                block.appendChild(partRow);
            });

            container.appendChild(block);
        });
    }

    function addCamera() {
        var idx = cameras.length;
        var label = idx < 26 ? "CAM " + String.fromCharCode(65 + idx) : "CAM " + (idx + 1);
        cameras.push({ label: label, parts: [""] });
        renderCameras();
    }

    // ── External Audio UI ──

    function renderExtAudio() {
        var container = document.getElementById("ext-audio-container");
        container.innerHTML = "";

        extAudioParts.forEach(function (partPath, idx) {
            var row = document.createElement("div");
            row.className = "ext-audio-row";

            var label = document.createElement("span");
            label.className = "part-label";
            label.textContent = "Part " + (idx + 1);
            row.appendChild(label);

            var input = document.createElement("input");
            input.className = "text-input";
            input.value = partPath;
            input.placeholder = "Select audio file...";
            input.addEventListener("change", function () { extAudioParts[idx] = this.value; });
            row.appendChild(input);

            var browseBtn = document.createElement("button");
            browseBtn.className = "btn-browse";
            browseBtn.textContent = "Browse";
            browseBtn.addEventListener("click", function () {
                browseFile(function (path) {
                    extAudioParts[idx] = path;
                    input.value = path;
                });
            });
            row.appendChild(browseBtn);

            var removeBtn = document.createElement("button");
            removeBtn.className = "btn-remove";
            removeBtn.textContent = "X";
            removeBtn.addEventListener("click", function () {
                extAudioParts.splice(idx, 1);
                renderExtAudio();
            });
            row.appendChild(removeBtn);

            container.appendChild(row);
        });
    }

    // ── FPS auto-detect (now async) ──

    var fpsTimer = null;
    function autoDetectFPS(filePath) {
        if (fpsTimer) clearTimeout(fpsTimer);
        fpsTimer = setTimeout(function () {
            if (!filePath || !fs.existsSync(filePath)) return;
            Processing.detectFPS(settings.ffprobeExe, filePath).then(function (fps) {
                if (fps && fps > 0) {
                    var formatted = fps.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
                    document.getElementById("fps").value = formatted;
                    log("info", "Detected FPS: " + formatted);
                }
            }).catch(function (e) {
                console.warn("FPS detect error:", e);
            });
        }, 500);
    }

    // ── Browse button wiring ──

    function wireBrowseButtons() {
        document.querySelectorAll(".btn-browse[data-target]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var targetId = btn.getAttribute("data-target");
                var type = btn.getAttribute("data-type");
                var input = document.getElementById(targetId);
                if (!input) return;

                var cb = function (path) { input.value = path; };
                if (type === "folder") {
                    browseFolder(cb);
                } else {
                    browseFile(cb);
                }
            });
        });
    }

    // ── Settings Modal ──

    function openSettings() {
        document.getElementById("set-whisper-exe").value = settings.whisperExe;
        document.getElementById("set-ffmpeg-exe").value = settings.ffmpegExe;
        document.getElementById("set-ffprobe-exe").value = settings.ffprobeExe;
        document.getElementById("set-whisper-model").value = settings.whisperModel;
        document.getElementById("set-ps-exe").value = settings.psExe;
        document.getElementById("set-ae-exe").value = settings.aeExe;
        document.getElementById("set-yt-dlp-exe").value = settings.ytDlpExe;
        document.getElementById("set-hearts-mogrt").value = settings.heartsMogrt;
        document.getElementById("set-qc-template-psd").value = settings.qcTemplatePsd;
        document.getElementById("set-name-mogrt").value = settings.nameMogrt;
        document.getElementById("set-title-card-mov").value = settings.titleCardMov;
        document.getElementById("set-endcard-nologo-mov").value = settings.endCardNoLogoMov;
        document.getElementById("set-endcard2-mov").value = settings.endCard2Mov;
        document.getElementById("set-match-threshold").value = settings.matchThreshold;
        document.getElementById("set-similarity-weight").value = settings.similarityWeight;
        document.getElementById("settings-modal").style.display = "flex";
    }

    function closeSettings() {
        settings.whisperExe = document.getElementById("set-whisper-exe").value;
        settings.ffmpegExe = document.getElementById("set-ffmpeg-exe").value;
        settings.ffprobeExe = document.getElementById("set-ffprobe-exe").value;
        settings.whisperModel = document.getElementById("set-whisper-model").value;
        settings.psExe = document.getElementById("set-ps-exe").value;
        settings.aeExe = document.getElementById("set-ae-exe").value;
        settings.ytDlpExe = document.getElementById("set-yt-dlp-exe").value;
        settings.heartsMogrt = document.getElementById("set-hearts-mogrt").value;
        settings.qcTemplatePsd = document.getElementById("set-qc-template-psd").value;
        settings.nameMogrt = document.getElementById("set-name-mogrt").value;
        settings.titleCardMov = document.getElementById("set-title-card-mov").value;
        settings.endCardNoLogoMov = document.getElementById("set-endcard-nologo-mov").value;
        settings.endCard2Mov = document.getElementById("set-endcard2-mov").value;
        settings.matchThreshold = parseFloat(document.getElementById("set-match-threshold").value) || 0.5;
        settings.similarityWeight = parseFloat(document.getElementById("set-similarity-weight").value) || 0.7;
        saveSettings();
        document.getElementById("settings-modal").style.display = "none";
    }

    // ── Quote Cards ──

    function wireFeatureToggle(checkboxId, bodyId, subIds) {
        var cb = document.getElementById(checkboxId);
        var body = bodyId ? document.getElementById(bodyId) : null;
        cb.addEventListener("change", function () {
            if (body) body.style.display = cb.checked ? "" : "none";
            cb.closest("label").classList.toggle("off", !cb.checked);
            if (subIds) {
                subIds.forEach(function (subId) {
                    var sub = document.getElementById(subId);
                    if (sub) {
                        sub.disabled = !cb.checked;
                        sub.closest("label").classList.toggle("off", !cb.checked);
                        if (!cb.checked) sub.checked = false;
                    }
                });
            }
        });
    }

    function generateQuoteCards() {
        var dataPath = document.getElementById("qc-data-file").value;
        var templatePSD = settings.qcTemplatePsd;

        if (!dataPath || !fs.existsSync(dataPath)) {
            alert("Quote data file not found: " + dataPath); return;
        }
        if (!templatePSD || !fs.existsSync(templatePSD)) {
            alert("Template PSD not found. Set it in Settings.\n" + templatePSD); return;
        }
        if (!settings.psExe || !fs.existsSync(settings.psExe)) {
            alert("Photoshop not found. Set it in Settings.\n" + settings.psExe); return;
        }

        var peFile = document.getElementById("paper-edit-path").value;
        var outputBase = document.getElementById("output-dir").value;
        if (!outputBase) outputBase = peFile ? pathMod.dirname(peFile) : extensionDir;
        var peName = peFile ? pathMod.basename(peFile, pathMod.extname(peFile)) : "cards";
        var outputDir = pathMod.join(outputBase, peName + "_Project", "quotes");

        try {
            var text = fs.readFileSync(dataPath, "utf8");
            var entries = QuoteCards.parseQuoteEntries(text);
            log("info", "Quote cards: parsed " + entries.length + " entries");

            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            var jsxPath = pathMod.join(pathMod.dirname(outputDir), "_generate_cards.jsx");
            var jsxContent = QuoteCards.generateQuoteJSX(entries, templatePSD, outputDir, peName);
            fs.writeFileSync(jsxPath, jsxContent, "utf8");

            log("info", "Quote cards: launching Photoshop...");
            childProcess.spawn(settings.psExe, [jsxPath], { detached: true, windowsHide: false });
            log("success", "Photoshop launched. Cards will export to: " + outputDir);
        } catch (e) {
            log("warn", "Quote card generation failed: " + e.message);
            console.error("Quote card error:", e);
            alert("Quote card generation failed:\n" + e.message);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  LEADERBOARD (After Effects)
    // ══════════════════════════════════════════════════════════

    /**
     * Check if leaderboard inputs are filled in.
     */
    function hasLeaderboardInputs() {
        var aepPath = document.getElementById("lb-aep-path").value;
        var name    = document.getElementById("lb-guest-name").value.trim();
        return !!(aepPath && name);
    }

    /**
     * Validate feature-specific inputs when features are enabled.
     * Returns array of error messages (empty if all valid).
     */
    function validateFeatureInputs(optQuoteCards, optYtClips, optLeaderboard) {
        var errors = [];
        if (optLeaderboard) {
            var aepPath = document.getElementById("lb-aep-path").value.trim();
            var name = document.getElementById("lb-guest-name").value.trim();
            var position = parseInt(document.getElementById("lb-position").value, 10);
            var score = parseFloat(document.getElementById("lb-score").value);
            if (!aepPath) errors.push("• Leaderboard: AE project (.aep) file is required");
            else if (!fs.existsSync(aepPath)) errors.push("• Leaderboard: AE project file not found: " + aepPath);
            if (!name) errors.push("• Leaderboard: Guest name is required");
            if (isNaN(position) || position < 1) errors.push("• Leaderboard: Position must be 1 or higher");
            if (isNaN(score) || score < 0 || score > 100) errors.push("• Leaderboard: Score must be 0–100");
        }
        if (optQuoteCards || optYtClips) {
            var qcDataPath = document.getElementById("qc-data-file").value.trim();
            if (!qcDataPath) {
                errors.push("• Quote cards: Quote data file is required when Quote Cards or YT Clips is enabled");
            } else if (!fs.existsSync(qcDataPath)) {
                errors.push("• Quote cards: Quote data file not found: " + qcDataPath);
            }
        }
        return errors;
    }

    /**
     * Standalone "Process Leaderboard" button handler.
     */
    function processLeaderboardStandalone() {
        var peFile     = document.getElementById("paper-edit-path").value;
        var outputBase = document.getElementById("output-dir").value;
        if (!outputBase) outputBase = peFile ? pathMod.dirname(peFile) : extensionDir;
        var peName        = peFile ? pathMod.basename(peFile, pathMod.extname(peFile)) : "project";
        var projectFolder = pathMod.join(outputBase, peName + "_Project");

        log("info", "Leaderboard: standalone processing...");

        AERunner.processLeaderboard({
            aepPath:       document.getElementById("lb-aep-path").value,
            name:          document.getElementById("lb-guest-name").value.trim(),
            position:      parseInt(document.getElementById("lb-position").value, 10),
            score:         parseFloat(document.getElementById("lb-score").value),
            projectFolder: projectFolder,
            aeExe:         settings.aeExe,
            force:         true
        }).then(function (result) {
            log("success", "Leaderboard: done. Output: " + result.movPath);
        }).catch(function (e) {
            log("warn", "Leaderboard: " + e.message);
            alert("Leaderboard processing failed:" + e.message);
        });
    }


    // ══════════════════════════════════════════════════════════
    //  MAIN GENERATE PROCESS (fully async)
    // ══════════════════════════════════════════════════════════

    function generate() {
        if (isRunning) return;
        isRunning = true;
        abortRequested = false;
        var btn = document.getElementById("btn-generate");
        var cancelBtn = document.getElementById("btn-cancel");
        btn.disabled = true;
        btn.style.display = "none";
        if (cancelBtn) cancelBtn.style.display = "";
        btn.textContent = "Processing...";

        // Save current inputs so they persist across sessions
        saveCache();

        // Clear log and error banner
        if (logArea) logArea.innerHTML = "";
        hideErrorBanner();

        console.log("[Paper Editor] Generate started");

        runProcessAsync()
            .then(function () {
                console.log("[Paper Editor] Generate completed successfully");
            })
            .catch(function (e) {
                console.error("[Paper Editor] Generate FAILED:", e);
                log("warn", "FAILED: " + e.message);
                updateProgress(0, "Error — see log");
                showErrorBanner(e.message || "An error occurred. See log for details.");
                if (e.message && e.message.indexOf("Cannot generate — missing") === 0) {
                    alert(e.message);
                }
                // #8: If an XML was written before the failure, offer recovery info
                if (lastXmlPath && fs.existsSync(lastXmlPath)) {
                    log("info", "Partial XML saved: " + lastXmlPath);
                    log("info", "To manually import: File > Import in Premiere Pro, select sequence.xml");
                }
            })
            .then(function () {
                // finally block
                isRunning = false;
                btn.disabled = false;
                btn.textContent = "Generate Project";
                btn.style.display = "";
                var cancelBtn = document.getElementById("btn-cancel");
                if (cancelBtn) cancelBtn.style.display = "none";
            });
    }

    function requestCancel() {
        abortRequested = true;
        log("info", "Cancel requested — stopping after current step...");
    }

    function checkAbort() {
        if (abortRequested) throw new Error("Cancelled by user");
    }

    // ── Premiere evalScript helpers ──
    // Defined at module scope so all step functions can use them.

    function evalScriptPromise(script) {
        return new Promise(function (resolve, reject) {
            if (!csInterface) { reject(new Error("csInterface not available")); return; }
            csInterface.evalScript(script, function (res) { resolve(res || ""); });
        });
    }

    function evalHostScript(call) {
        var hostTmpJsx  = pathMod.join(require("os").tmpdir(), "_pe_host_call.jsx");
        var hostContent = "";
        try { hostContent = fs.readFileSync(pathMod.join(extensionDir, "host", "index.jsx"), "utf8"); } catch (e) {}
        var iife = '(function(){try{return(' + call + ')}catch(_e){return"ERR:"+(_e.message||String(_e))+" L:"+(_e.line||"?")}})()';
        var script = (hostContent ? hostContent + "\n" : "") + iife;
        try {
            fs.writeFileSync(hostTmpJsx, script, "utf8");
        } catch (writeErr) {
            return Promise.reject(new Error("Could not write host tmp JSX: " + writeErr.message));
        }
        var safePath     = hostTmpJsx.replace(/\\/g, "/");
        var evalFileCall = '(function(){try{return $.evalFile("' + safePath + '")}catch(_e){return"EVALFILE_ERR:"+(_e.message||String(_e))}})()';
        return evalScriptPromise(evalFileCall);
    }

    // ── Pipeline step functions ──
    // Each step reads shared state from ctx and writes results back to ctx.
    // Module-level vars (settings, extensionDir, csInterface, log, etc.) are
    // accessed directly since all step functions live in the same IIFE scope.

    function step1_validateInputs(ctx) {
        updateProgress(1, "Validating inputs...");
        log("info", "Validating inputs...");

        if (cameras.length === 0 || cameras[0].parts.length === 0 || !cameras[0].parts[0]) {
            return Promise.reject(new Error("Add at least one camera with one part file."));
        }

        var featureErrors = validateFeatureInputs(ctx.optQuoteCards, ctx.optYtClips, ctx.optLeaderboard);
        if (featureErrors.length > 0) {
            return Promise.reject(new Error("Cannot generate — missing required inputs:\n\n" + featureErrors.join("\n")));
        }

        var camInfos = [];
        for (var ci = 0; ci < cameras.length; ci++) {
            var cam        = cameras[ci];
            var validParts = cam.parts.filter(function (p) { return p && p.trim() && fs.existsSync(p); });
            if (validParts.length === 0) {
                if (ci === 0) return Promise.reject(new Error("Reference camera must have at least one valid part file."));
                log("warn", "Skipping " + cam.label + " — no valid parts");
                continue;
            }
            camInfos.push({ label: cam.label, parts: validParts });
        }

        if (camInfos.length === 0) return Promise.reject(new Error("No cameras with valid part files."));
        if (!ctx.scriptPath || !fs.existsSync(ctx.scriptPath)) {
            return Promise.reject(new Error("Paper edit file not found: " + ctx.scriptPath));
        }
        if (!settings.ffprobeExe || !fs.existsSync(settings.ffprobeExe)) {
            return Promise.reject(new Error("ffprobe not found at: " + settings.ffprobeExe + "\nConfigure it in Settings."));
        }
        if (!settings.ffmpegExe || !fs.existsSync(settings.ffmpegExe)) {
            return Promise.reject(new Error("ffmpeg not found at: " + settings.ffmpegExe + "\nConfigure it in Settings."));
        }
        if (!settings.whisperExe || !fs.existsSync(settings.whisperExe)) {
            return Promise.reject(new Error("Whisper not found at: " + settings.whisperExe + "\nConfigure it in Settings."));
        }
        if (!settings.whisperModel || !fs.existsSync(settings.whisperModel)) {
            return Promise.reject(new Error("Whisper model not found at: " + settings.whisperModel + "\nConfigure it in Settings."));
        }

        var optExtAudio        = document.getElementById("opt-ext-audio").checked;
        var validExtAudioParts = optExtAudio ? extAudioParts.filter(function (p) { return p && p.trim() && fs.existsSync(p); }) : [];

        ctx.camInfos           = camInfos;
        ctx.numCams            = camInfos.length;
        ctx.hasExtAudio        = validExtAudioParts.length > 0;
        ctx.validExtAudioParts = validExtAudioParts;

        updateProgress(5, "Inputs validated");
        log("info", "Starting — " + ctx.numCams + " camera(s)" +
            (ctx.hasExtAudio ? ", ext audio: " + validExtAudioParts.length + " part(s)" : "") +
            ", FPS: " + ctx.fpsVal);
        log("info", "Whisper: " + settings.whisperExe);
        log("info", "FFmpeg: "  + settings.ffmpegExe);

        Processing.initCacheDir(pathMod.dirname(ctx.scriptPath));
        Processing.cleanupOldCacheFiles(pathMod.join(pathMod.dirname(ctx.scriptPath), ".whisper_cache"), 7);

        return Promise.resolve();
    }

    function step2_detectPartDurations(ctx) {
        checkAbort();
        updateProgress(6, "Detecting part durations...");
        log("info", "Detecting part durations...");

        var chain = Promise.resolve([]);
        ctx.camInfos.forEach(function (cam) {
            chain = chain.then(function (allDurations) {
                log("info", "Getting durations for " + cam.label + "...");
                return Processing.getPartDurations(settings.ffprobeExe, cam.parts).then(function (durs) {
                    allDurations.push(durs);
                    return allDurations;
                });
            });
        });

        return chain.then(function (allCamDurations) {
            ctx.camDurations = allCamDurations;
            if (!ctx.hasExtAudio) { ctx.extAudioDurations = []; return; }

            log("info", "Getting durations for external audio...");
            return Processing.getPartDurations(settings.ffprobeExe, ctx.validExtAudioParts)
                .then(function (durs) {
                    ctx.extAudioDurations = durs;
                    return Processing.getAudioChannels(settings.ffprobeExe, ctx.validExtAudioParts[0]);
                })
                .then(function (ch) {
                    ctx.extAudioChannels = ch;
                    log("info", "External audio channels: " + ctx.extAudioChannels);
                });
        });
    }

    function step3_transcribeCameras(ctx) {
        checkAbort();
        updateProgress(15, "Transcribing cameras...");

        var transPromises = ctx.camInfos.map(function (cam, ci) {
            return Processing.transcribeAndMergeParts(
                settings.whisperExe, settings.whisperModel, settings.ffmpegExe,
                cam.parts, ctx.camDurations[ci]
            ).then(function (merged) {
                var prog = 15 + Math.round(((ci + 1) / ctx.numCams) * 25);
                updateProgress(prog, "Transcribed " + cam.label + " (" + (ci + 1) + "/" + ctx.numCams + ")");
                log("info", cam.label + ": " + (merged.transcription || []).length + " segments in merged transcript");
                return merged;
            });
        });

        return Promise.all(transPromises).then(function (results) {
            ctx.camWhisper = results;
            if (!ctx.hasExtAudio) return;
            updateProgress(40, "Transcribing external audio...");
            return Processing.transcribeAndMergeParts(
                settings.whisperExe, settings.whisperModel, settings.ffmpegExe,
                ctx.validExtAudioParts, ctx.extAudioDurations
            ).then(function (merged) {
                ctx.extAudioWhisper = merged;
                log("info", "External audio: " + (merged.transcription || []).length + " segments");
            });
        });
    }

    function step4_autoSync(ctx) {
        checkAbort();
        ctx.syncOffsets        = [0.0];
        ctx.extAudioSyncOffset = 0.0;

        var extAudioSyncPromise = Promise.resolve();
        if (ctx.hasExtAudio) {
            updateProgress(42, "Syncing external audio to reference camera...");
            extAudioSyncPromise = Processing.syncPair(
                settings.ffmpegExe, ctx.camInfos[0].parts[0], ctx.validExtAudioParts[0],
                ctx.camWhisper[0], ctx.extAudioWhisper, "External audio"
            ).then(function (offset) {
                if (offset !== null) ctx.extAudioSyncOffset = offset;
                else log("warn", "External audio sync failed — using offset 0.0s");
            });
        }

        return extAudioSyncPromise.then(function () {
            if (ctx.numCams <= 1) { log("info", "Single camera — no sync needed"); return; }

            updateProgress(44, "Auto-syncing cameras...");
            var chain = Promise.resolve();
            for (var ci = 1; ci < ctx.numCams; ci++) {
                (function (camIdx) {
                    chain = chain.then(function () {
                        var label = ctx.camInfos[camIdx].label;
                        return Processing.syncPair(
                            settings.ffmpegExe, ctx.camInfos[0].parts[0], ctx.camInfos[camIdx].parts[0],
                            ctx.camWhisper[0], ctx.camWhisper[camIdx], label
                        ).then(function (offset) {
                            ctx.syncOffsets.push(offset !== null ? offset : 0.0);
                            if (offset === null) log("warn", label + ": Auto-sync failed — using 0.0s");
                        });
                    });
                })(ci);
            }
            return chain;
        });
    }

    function step5_parseAndSetupProject(ctx) {
        checkAbort();
        updateProgress(50, "Syncing complete");
        updateProgress(51, "Parsing paper edit...");

        ctx.entries = PaperEditParser.parse(fs.readFileSync(ctx.scriptPath, "utf8"));
        log("info", "Parsed " + ctx.entries.length + " entries from paper edit");

        var projectOut = document.getElementById("output-dir").value;
        if (!projectOut || !projectOut.trim()) projectOut = pathMod.dirname(ctx.scriptPath);
        ctx.peName        = pathMod.basename(ctx.scriptPath, pathMod.extname(ctx.scriptPath));
        ctx.projectFolder = pathMod.join(projectOut, ctx.peName + "_Project");
        ctx.quotesFolder  = pathMod.join(ctx.projectFolder, "quotes");
        if (!fs.existsSync(ctx.quotesFolder)) fs.mkdirSync(ctx.quotesFolder, { recursive: true });

        ctx.qcEntries     = [];
        ctx.hasQuoteCards = false;
        var qcDataPath    = document.getElementById("qc-data-file").value;
        if (qcDataPath && fs.existsSync(qcDataPath) && (ctx.optQuoteCards || ctx.optYtClips)) {
            try {
                ctx.qcEntries = QuoteCards.parseQuoteEntries(fs.readFileSync(qcDataPath, "utf8"));
                if (ctx.qcEntries.length > 0) {
                    if (ctx.optQuoteCards) ctx.hasQuoteCards = true;
                    log("info", "Quote cards: " + ctx.qcEntries.length + " entries parsed");
                }
            } catch (e) {
                log("warn", "Quote card parsing failed: " + e.message);
            }
        }

        if (!ctx.hasQuoteCards) return Promise.resolve();

        var templatePSD = settings.qcTemplatePsd;
        if (!templatePSD || !fs.existsSync(templatePSD) || !settings.psExe || !fs.existsSync(settings.psExe)) {
            log("warn", "Quote cards: Photoshop or template PSD not configured — skipping PNG generation");
            return Promise.resolve();
        }

        updateProgress(52, "Generating quote cards in Photoshop...");
        var sentinelPath = pathMod.join(ctx.quotesFolder, "_done.txt");
        try { if (fs.existsSync(sentinelPath)) fs.unlinkSync(sentinelPath); } catch (ex) {}

        var jsxPath = pathMod.join(ctx.projectFolder, "_generate_cards.jsx");
        fs.writeFileSync(jsxPath, QuoteCards.generateQuoteJSX(ctx.qcEntries, templatePSD, ctx.quotesFolder, ctx.peName), "utf8");
        childProcess.spawn(settings.psExe, [jsxPath], { detached: true, windowsHide: false });
        log("info", "Quote cards: launched Photoshop, generating " + ctx.qcEntries.length + " cards");

        return new Promise(function (resolve) {
            var timeout = 300;
            var elapsed = 0;
            var interval = setInterval(function () {
                elapsed += 2;
                updateProgress(52 + Math.min(Math.floor(elapsed / timeout * 3), 3), "Waiting for Photoshop... (" + elapsed + "s)");
                if (fs.existsSync(sentinelPath)) {
                    clearInterval(interval);
                    try { fs.unlinkSync(sentinelPath); } catch (ex) {}
                    log("info", "Quote cards: Photoshop finished in " + elapsed + "s");
                    resolve();
                } else if (elapsed >= timeout) {
                    clearInterval(interval);
                    log("warn", "Quote cards: Photoshop timed out after " + timeout + "s — cards may be incomplete");
                    resolve();
                }
            }, 2000);
        });
    }

    function step5c_downloadYouTubeClips(ctx) {
        ctx.ytClipMap       = {};
        ctx.hasYouTubeClips = false;

        if (ctx.qcEntries.length === 0 || !ctx.optYtClips) return Promise.resolve();
        if (!ctx.qcEntries.some(function (e) { return !!e.ytUrl; })) return Promise.resolve();

        var ytCacheDir  = pathMod.join(ctx.quotesFolder, "yt_cache");
        var ytOutputDir = pathMod.join(ctx.quotesFolder, "yt");
        return YouTubeClips.download(ctx.qcEntries, ytCacheDir, ytOutputDir, settings)
            .then(function (result) {
                ctx.ytClipMap = result;
                if (Object.keys(ctx.ytClipMap).length > 0) {
                    ctx.hasYouTubeClips = true;
                    log("info", "YouTube clips: " + Object.keys(ctx.ytClipMap).length + " trimmed clips ready");
                }
            });
    }

    function step5d_processLeaderboardAE(ctx) {
        ctx.leaderboardMovPath           = null;
        ctx.leaderboardMovDurationFrames = null;
        ctx.leaderboardMovInfo           = null;
        ctx.leaderboardGridPngPath       = null;

        if (!hasLeaderboardInputs() || !ctx.optLeaderboard) return Promise.resolve();

        updateProgress(56, "Processing leaderboard in After Effects...");
        return AERunner.processLeaderboard({
            aepPath:       document.getElementById("lb-aep-path").value,
            name:          document.getElementById("lb-guest-name").value.trim(),
            position:      parseInt(document.getElementById("lb-position").value, 10),
            score:         parseFloat(document.getElementById("lb-score").value),
            projectFolder: ctx.projectFolder,
            aeExe:         settings.aeExe
        })
            .then(function (result) {
                ctx.leaderboardMovPath     = result.movPath;
                ctx.leaderboardGridPngPath = result.gridPngPath || null;
                if (ctx.leaderboardMovPath && fs.existsSync(ctx.leaderboardMovPath)) {
                    return Processing.getVideoInfo(settings.ffprobeExe, ctx.leaderboardMovPath);
                }
                return null;
            })
            .then(function (vidInfo) {
                ctx.leaderboardMovInfo = vidInfo || null;
                if (vidInfo && vidInfo.durationFrames) {
                    ctx.leaderboardMovDurationFrames = vidInfo.durationFrames;
                    log("info", "Leaderboard .mov: " + ctx.leaderboardMovDurationFrames + " frames, " +
                        vidInfo.width + "x" + vidInfo.height +
                        (vidInfo.hasAudio ? ", has audio" : ", no audio"));
                }
            })
            .catch(function (e) {
                log("warn", "Leaderboard processing failed: " + e.message + " — continuing without leaderboard .mov");
                ctx.leaderboardMovPath     = null;
                ctx.leaderboardGridPngPath = null;
            });
    }

    function step6_matchClipsAndBuildPlacements(ctx) {
        checkAbort();

        // Validate leaderboard .mov before building placements
        if (ctx.leaderboardMovPath) {
            var lbOfflineReason = null;
            try {
                if (!fs.existsSync(ctx.leaderboardMovPath)) {
                    lbOfflineReason = "Leaderboard .mov not found:\n" + ctx.leaderboardMovPath;
                } else if (fs.statSync(ctx.leaderboardMovPath).size === 0) {
                    lbOfflineReason = "Leaderboard .mov is empty (0 bytes):\n" + ctx.leaderboardMovPath;
                }
            } catch (statErr) {
                lbOfflineReason = "Cannot access leaderboard .mov:\n" + statErr.message;
            }
            if (lbOfflineReason) {
                log("warn", lbOfflineReason);
                alert("Leaderboard .mov will appear OFFLINE in Premiere.\n\n" + lbOfflineReason + "\n\nThe clip is still added to the timeline — relink the media if you fix the path.");
            }
        }

        // Match quote cards to clips using fuzzy text matching
        ctx.qcCardMap = {};
        if ((ctx.hasQuoteCards || ctx.hasYouTubeClips) && ctx.qcEntries.length > 0) {
            for (var ei = 0; ei < ctx.entries.length; ei++) { ctx.entries[ei]._origIdx = ei; }
            var clipEntries = ctx.entries.filter(function (e) { return e.type === "clip"; });
            ctx.qcCardMap   = QuoteCards.matchToClips(ctx.qcEntries, clipEntries, ctx.quotesFolder);
            log("info", "Quote cards: " + Object.keys(ctx.qcCardMap).length + " of " + ctx.qcEntries.length + " cards matched to clips");
            // Attach YouTube clip paths to matched entries
            for (var mapKey in ctx.qcCardMap) {
                if (ctx.qcCardMap.hasOwnProperty(mapKey)) {
                    var storedCardIdx = ctx.qcCardMap[mapKey].cardIdx;
                    if (storedCardIdx >= 0 && ctx.ytClipMap[storedCardIdx]) {
                        ctx.qcCardMap[mapKey].ytClipPath = ctx.ytClipMap[storedCardIdx];
                    }
                }
            }
        }

        updateProgress(55, "Matching clips...");

        ctx.hasScoringReveals = ctx.entries.some(function (e) {
            return e.type === "reveal" && e.score !== null && e.score !== undefined;
        });
        ctx.clipPlacements = [];
        ctx.matchCount     = 0;
        ctx.noMatchCount   = 0;
        var introDetected  = false;
        var clipCounter    = 50000; // avoids collision with XMEMLBuilder's internal IDs
        var fileDefs       = {};

        for (var idx = 0; idx < ctx.entries.length; idx++) {
            var entry    = ctx.entries[idx];
            var progress = 55 + Math.round((idx / Math.max(1, ctx.entries.length)) * 30);
            updateProgress(progress, "Processing entry " + (idx + 1) + "/" + ctx.entries.length + "...");

            if (entry.type === "clip") {
                var hintSec = PaperEditParser.tcToSeconds(entry.tc, ctx.fpsF);
                var match   = Processing.findTextInWhisper(entry.text, ctx.camWhisper[0], hintSec, settings);

                if (match.start !== null) {
                    log("info", "MATCH  " + entry.tc + " -> " + match.start.toFixed(1) + "s - " + match.end.toFixed(1) + "s");
                    ctx.matchCount++;

                    var refSFrame = Math.round(match.start * ctx.fpsF);
                    var refEFrame = Math.round(match.end   * ctx.fpsF);
                    var inFAdj    = Math.max(0, refSFrame - ctx.padFrames);
                    var dur       = (refEFrame + ctx.padFrames) - inFAdj;

                    var placement = { type: "clip", matched: true, duration: dur, cameras: [], extAudioClips: [], extAudioClips2: [] };

                    if (!introDetected) {
                        placement.isIntro = true;
                        introDetected     = true;
                        log("info", "  INTRO (first clip)");
                    }

                    for (var ci = 0; ci < ctx.numCams; ci++) {
                        var syncOffset = ctx.syncOffsets[ci];
                        var camStart   = match.start - syncOffset;
                        var camEnd     = match.end   - syncOffset;
                        var partRes    = Processing.resolvePart(camStart, ctx.camDurations[ci]);
                        var partResE   = Processing.resolvePart(camEnd,   ctx.camDurations[ci]);

                        if (partRes.partIndex === null || partResE.partIndex === null) {
                            log("warn", "  " + ctx.camInfos[ci].label + ": clip falls outside footage — skipping");
                            continue;
                        }

                        var localStart = partRes.localTime;
                        var localEnd   = partResE.localTime;
                        if (partRes.partIndex !== partResE.partIndex) {
                            localEnd = ctx.camDurations[ci][partRes.partIndex];
                            log("warn", "  " + ctx.camInfos[ci].label + ": clip spans part boundary, trimming");
                        }

                        var sFrame   = Math.round(localStart * ctx.fpsF);
                        var eFrame   = Math.round(localEnd   * ctx.fpsF);
                        var partPath = ctx.camInfos[ci].parts[partRes.partIndex];
                        var fid      = "file-cam" + ci + "-part" + partRes.partIndex;

                        placement.cameras.push({
                            fileName: pathMod.basename(partPath),
                            fileId: fid, filePath: partPath,
                            inFrame: sFrame, outFrame: eFrame,
                            videoInfo: { width: 1920, height: 1080, durationFrames: null }
                        });
                    }

                    if (ctx.hasExtAudio && ctx.extAudioDurations && ctx.extAudioDurations.length > 0) {
                        var eaStart = match.start - ctx.extAudioSyncOffset;
                        var eaEnd   = match.end   - ctx.extAudioSyncOffset;
                        var eaPartS = Processing.resolvePart(eaStart, ctx.extAudioDurations);
                        var eaPartE = Processing.resolvePart(eaEnd,   ctx.extAudioDurations);

                        if (eaPartS.partIndex !== null && eaPartE.partIndex !== null) {
                            var eaLocalStart    = eaPartS.localTime;
                            var eaLocalEnd      = eaPartE.localTime;
                            if (eaPartS.partIndex !== eaPartE.partIndex) eaLocalEnd = ctx.extAudioDurations[eaPartS.partIndex];
                            var eaInF           = Math.max(0, Math.round(eaLocalStart * ctx.fpsF) - ctx.padFrames);
                            var eaOutF          = Math.round(eaLocalEnd * ctx.fpsF) + ctx.padFrames;
                            var eaFilePath      = ctx.validExtAudioParts[eaPartS.partIndex];
                            var eaFileId        = "file-extaudio-part" + eaPartS.partIndex;
                            var eaFileDurFrames = Math.round(ctx.extAudioDurations[eaPartS.partIndex] * ctx.fpsF);

                            placement.extAudioClips.push(XMEMLBuilder.buildExtAudioClipXML(
                                eaFilePath, eaFileId, 0, dur, eaInF, eaOutF,
                                ctx.fpsVal, clipCounter++, fileDefs, ctx.extAudioChannels, 1, eaFileDurFrames
                            ));
                            if (ctx.extAudioChannels >= 2) {
                                placement.extAudioClips2.push(XMEMLBuilder.buildExtAudioClipXML(
                                    eaFilePath, eaFileId, 0, dur, eaInF, eaOutF,
                                    ctx.fpsVal, clipCounter++, fileDefs, ctx.extAudioChannels, 2, eaFileDurFrames
                                ));
                            }
                        }
                    }

                    if ((ctx.hasQuoteCards || ctx.hasYouTubeClips) && ctx.qcCardMap[idx]) {
                        placement.quoteCard = {};
                        if (ctx.hasQuoteCards) {
                            placement.quoteCard.pngPath     = ctx.qcCardMap[idx].pngPath;
                            placement.quoteCard.pngFilename = ctx.qcCardMap[idx].pngFilename;
                        }
                        if (ctx.qcCardMap[idx].ytClipPath) {
                            placement.quoteCard.ytClipPath = ctx.qcCardMap[idx].ytClipPath;
                            var ytCard = ctx.qcCardMap[idx].card;
                            if (ytCard && ytCard.ytEnd > ytCard.ytStart) {
                                var ytBufStart = Math.max(0, ytCard.ytStart - 2);
                                var ytBufEnd   = ytCard.ytEnd + 2;
                                placement.quoteCard.ytDurationFrames = Math.round((ytBufEnd - ytBufStart) * ctx.fpsF);
                            }
                        }
                        var attachParts = [];
                        if (placement.quoteCard.pngFilename) attachParts.push(ctx.qcCardMap[idx].pngFilename);
                        if (placement.quoteCard.ytClipPath)  attachParts.push("YT clip");
                        if (attachParts.length) log("info", "  QUOTE CARD  " + attachParts.join(" + ") + " attached");
                    }

                    ctx.clipPlacements.push(placement);
                } else {
                    ctx.noMatchCount++;
                    var display = entry.text.length > 80 ? entry.text.substring(0, 80) + "..." : entry.text;
                    log("warn", "NO MATCH  " + entry.tc + " - " + display);
                    ctx.clipPlacements.push({ type: "clip", matched: false, displayText: entry.tc + " - " + display });
                }

            } else if (entry.type === "reveal") {
                var scoreStr = entry.score !== null ? " (" + entry.score + "pt)" : " (no score)";
                log("info", "REVEAL  " + entry.text + scoreStr);
                ctx.clipPlacements.push({ type: "reveal", text: entry.text, score: entry.score });

            } else if (entry.type === "link") {
                log("info", "LINK  " + entry.text);
                ctx.clipPlacements.push({ type: "link", text: entry.text });

            } else if (entry.type === "endcard") {
                log("info", "END CARD");
                ctx.clipPlacements.push({ type: "endcard", text: "End Card" });
            }
        }

        var totalClips = ctx.matchCount + ctx.noMatchCount;
        log("info", "── Match Summary ── Matched: " + ctx.matchCount + "  |  No Match: " + ctx.noMatchCount + "  |  Total clips: " + totalClips);
        if (ctx.noMatchCount > 0 && totalClips > 0 && (ctx.noMatchCount / totalClips) > 0.25) {
            if (!confirm(ctx.noMatchCount + " clip(s) had no match (" + Math.round(ctx.noMatchCount / totalClips * 100) + "%). Continue building the project?")) {
                throw new Error("Cancelled — too many unmatched clips. Adjust Match Threshold in Settings or review your paper edit timecodes.");
            }
        }

        return Promise.resolve();
    }

    function step7_buildXMEML(ctx) {
        checkAbort();
        updateProgress(90, "Writing project files...");

        return Processing.getVideoInfo(settings.ffprobeExe, ctx.camInfos[0].parts[0]).then(function (videoInfo) {
            if (videoInfo.width * videoInfo.height !== 1920 * 1080) {
                log("warn", "Footage is " + videoInfo.width + "x" + videoInfo.height +
                    " — Hearts positions and leaderboard are tuned for 1920x1080. Results may not align.");
            }

            var endCardNoLogoPath = (settings.endCardNoLogoMov && fs.existsSync(settings.endCardNoLogoMov)) ? settings.endCardNoLogoMov : null;
            var titleCardPath     = (settings.titleCardMov     && fs.existsSync(settings.titleCardMov))     ? settings.titleCardMov     : null;
            var endCard2Path      = (settings.endCard2Mov      && fs.existsSync(settings.endCard2Mov))      ? settings.endCard2Mov      : null;

            // Determine whether the LB .mov goes in the end-block only
            // (requires ≥2 LB reveals + end-LB template files present)
            var lbRevealCount = ctx.clipPlacements.filter(function (p) {
                return p.type === "reveal" && /^Leaderboard\s+reveal/i.test(p.text);
            }).length;
            var endLbTemplatesDirPre = pathMod.join(extensionDir, "templates");
            var endLbMissingPre = (lbRevealCount >= 2)
                ? Object.keys(LeaderboardEnd.REQUIRED_FILES).filter(function (key) {
                      return !fs.existsSync(pathMod.join(endLbTemplatesDirPre, LeaderboardEnd.REQUIRED_FILES[key]));
                  })
                : [];
            var lbMovInEndBlockOnly = lbRevealCount >= 2 && !!ctx.leaderboardMovPath && endLbMissingPre.length === 0;

            var result = XMEMLBuilder.build({
                entries:                          ctx.entries,
                numCams:                          ctx.numCams,
                videoInfo:                        videoInfo,
                fpsVal:                           ctx.fpsVal,
                padFrames:                        ctx.padFrames,
                gapFrames:                        ctx.gapFrames,
                hasExtAudio:                      ctx.hasExtAudio,
                extAudioChannels:                 ctx.extAudioChannels,
                hasQuoteCards:                    ctx.hasQuoteCards,
                hasYouTubeClips:                  ctx.hasYouTubeClips,
                hasScoringReveals:                ctx.hasScoringReveals && ctx.optHearts,
                clipPlacements:                   ctx.clipPlacements,
                endCardNoLogoPath:                endCardNoLogoPath,
                titleCardPath:                    titleCardPath,
                endCard2Path:                     endCard2Path,
                leaderboardMovPath:               ctx.leaderboardMovPath,
                leaderboardMovDurationFrames:     ctx.leaderboardMovDurationFrames,
                leaderboardMovPlaceInEndBlockOnly: lbMovInEndBlockOnly,
                leaderboardGridPngPath:           ctx.leaderboardGridPngPath
            });

            ctx.xmemlResult       = result;
            ctx.endLbTemplatesDir = pathMod.join(extensionDir, "templates");
            ctx.endLbMissing = (result.endLbRevealFrame >= 0)
                ? Object.keys(LeaderboardEnd.REQUIRED_FILES).filter(function (key) {
                      return !fs.existsSync(pathMod.join(ctx.endLbTemplatesDir, LeaderboardEnd.REQUIRED_FILES[key]));
                  })
                : ["(no reveal found)"];

            if (result.endLbRevealFrame < 0 || ctx.endLbMissing.length > 0) {
                return Promise.resolve(result.xml);
            }

            // Copy confetti to project folder so Premiere can find it
            var confettiSource = pathMod.join(ctx.endLbTemplatesDir, LeaderboardEnd.REQUIRED_FILES.confetti);
            var confettiDest   = pathMod.join(ctx.projectFolder,     LeaderboardEnd.REQUIRED_FILES.confetti);
            var confettiPath   = confettiDest;
            if (fs.existsSync(confettiSource)) {
                try {
                    fs.copyFileSync(confettiSource, confettiDest);
                    log("info", "Copied confetti to project folder: " + confettiDest);
                } catch (cfErr) {
                    log("warn", "Confetti copy failed, using templates path: " + cfErr.message);
                    confettiPath = pathMod.join(pathMod.resolve(ctx.endLbTemplatesDir), LeaderboardEnd.REQUIRED_FILES.confetti);
                }
            } else {
                confettiPath = pathMod.join(pathMod.resolve(ctx.endLbTemplatesDir), LeaderboardEnd.REQUIRED_FILES.confetti);
            }

            var xmlToWrite = result.xml;
            try {
                xmlToWrite = LeaderboardEnd.appendToXMEML(xmlToWrite, {
                    endLbRevealFrame:   result.endLbRevealFrame,
                    fpsVal:             ctx.fpsVal,
                    templatesDir:       pathMod.resolve(ctx.endLbTemplatesDir),
                    projectFolder:      pathMod.resolve(ctx.projectFolder),
                    leaderboardMovPath: ctx.leaderboardMovPath ? pathMod.resolve(ctx.leaderboardMovPath) : null,
                    leaderboardMovInfo: ctx.leaderboardMovInfo,
                    confettiPath:       pathMod.resolve(confettiPath),
                    confettiInfo:       LeaderboardEnd.CONFETTI_INFO
                });
                log("info", "End Leaderboard tracks appended to XMEML");
            } catch (appendErr) {
                log("warn", "End Leaderboard XMEML append failed: " + appendErr.message);
            }
            return xmlToWrite;
        }).then(function (xmlToWrite) {
            ctx.xmlPath = pathMod.join(ctx.projectFolder, "sequence.xml");
            fs.writeFileSync(ctx.xmlPath, xmlToWrite, "utf8");
            lastXmlPath = ctx.xmlPath;
            log("info", "Saved XML: " + ctx.xmlPath);
        });
    }

    function step8_generateJSXFiles(ctx) {
        ctx.nameMogrtJSX  = null;
        ctx.heartsJSXPath = null;
        ctx.endLbJSXPath  = null;

        // Name MOGRT
        if (ctx.xmemlResult.introData && settings.nameMogrt && fs.existsSync(settings.nameMogrt) && ctx.optNameMogrt) {
            var nameMogrtDest = pathMod.join(ctx.projectFolder, pathMod.basename(settings.nameMogrt));
            try {
                fs.copyFileSync(settings.nameMogrt, nameMogrtDest);
                var guestName = deriveGuestName(ctx.scriptPath);
                log("info", "Guest name derived: " + guestName);
                ctx.nameMogrtJSX = NameMogrt.generateJSX(
                    nameMogrtDest, guestName, ctx.xmemlResult.introData,
                    ctx.xmemlResult.nameMogrtTrackIdx, ctx.fpsF
                );
                log("info", "Name MOGRT script generated for track V" + (ctx.xmemlResult.nameMogrtTrackIdx + 1));
            } catch (e) {
                log("warn", "Name MOGRT generation failed: " + e.message);
            }
        }

        // Hearts MOGRT + Sparkles
        var sourceMogrt = settings.heartsMogrt;
        if (ctx.xmemlResult.heartsRevealData.length > 0 && sourceMogrt && fs.existsSync(sourceMogrt) && ctx.optHearts) {
            if (!sourceMogrt.toLowerCase().endsWith(".mogrt")) {
                log("warn", "Hearts graphic MUST be a .mogrt file, not .aegraphic!");
            } else {
                var mogrtDest = pathMod.join(ctx.projectFolder, pathMod.basename(sourceMogrt));
                try {
                    fs.copyFileSync(sourceMogrt, mogrtDest);
                    log("info", "Copied hearts MOGRT -> " + mogrtDest);

                    var sparklesSource = pathMod.join(extensionDir, "templates", "Sparkles.mov");
                    var sparklesDest   = null;
                    if (fs.existsSync(sparklesSource) && ctx.xmemlResult.sparklesTrackIdx >= 0 && ctx.optSparkles) {
                        sparklesDest = pathMod.join(ctx.projectFolder, "Sparkles.mov");
                        try {
                            fs.copyFileSync(sparklesSource, sparklesDest);
                            log("info", "Copied Sparkles.mov -> " + sparklesDest);
                        } catch (se) {
                            log("warn", "Sparkles.mov copy failed: " + se.message);
                            sparklesDest = null;
                        }
                    }

                    var heartsJSX = Hearts.generateHeartsJSX(
                        mogrtDest, ctx.xmemlResult.heartsRevealData, ctx.fpsF,
                        ctx.xmemlResult.heartsTopTrackIdx, ctx.xmemlResult.heartsBotTrackIdx,
                        sparklesDest, ctx.xmemlResult.sparklesTrackIdx, ctx.projectFolder
                    );
                    if (heartsJSX) {
                        ctx.heartsJSXPath = pathMod.join(ctx.projectFolder, "_hearts.jsx");
                        fs.writeFileSync(ctx.heartsJSXPath, heartsJSX, "utf8");
                        log("info", "Hearts script generated: " + ctx.heartsJSXPath);
                    }
                } catch (e) {
                    log("warn", "Hearts MOGRT copy/generate failed: " + e.message);
                }
            }
        }

        // End Leaderboard effects JSX
        if (ctx.xmemlResult.endLbRevealFrame >= 0 && ctx.endLbMissing.length === 0) {
            try {
                var endLbJSX = LeaderboardEnd.generateJSX({ hasLb: !!(ctx.leaderboardMovPath), logDir: ctx.projectFolder, fpsVal: ctx.fpsVal });
                ctx.endLbJSXPath = pathMod.join(ctx.projectFolder, "_leaderboard_end.jsx");
                fs.writeFileSync(ctx.endLbJSXPath, endLbJSX, "utf8");
                log("info", "End Leaderboard effects script generated: " + ctx.endLbJSXPath);
            } catch (endLbErr) {
                log("warn", "End Leaderboard JSX generation failed: " + endLbErr.message);
            }
        } else if (ctx.xmemlResult.endLbRevealFrame >= 0 && ctx.endLbMissing.length > 0) {
            log("info", "End Leaderboard: " + ctx.endLbMissing.length + " template file(s) missing (" +
                ctx.endLbMissing.map(function (k) { return LeaderboardEnd.REQUIRED_FILES[k]; }).join(", ") +
                ") — skipping end leaderboard placement");
        }

        return Promise.resolve();
    }

    function step9_importAndOpen(ctx) {
        checkAbort();
        updateProgress(95, "Importing into Premiere Pro...");

        if (!csInterface) {
            return Promise.reject(new Error("Premiere Pro connection not available. Run this panel from Window → Extensions → Paper Editor inside Premiere Pro."));
        }

        var pathFilePath = pathMod.join(ctx.projectFolder, "_pe_xml_path.txt");
        try { fs.writeFileSync(pathFilePath, ctx.xmlPath, "utf8"); }
        catch (e) { throw new Error("Could not write path file for Premiere import: " + e.message); }
        var safePathFilePath = pathFilePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

        return evalHostScript("app.version").then(function (selfTest) {
            console.log("[Paper Editor] evalHostScript self-test:", selfTest);
            if (selfTest === "EvalScript error.") {
                log("warn", "evalHostScript self-test failed — host JSX may not be evaluating correctly");
            }
            return evalHostScript('importAndOpenXMEMLFromPathFile("' + safePathFilePath + '")');
        }).then(function (res) {
            console.log("[Paper Editor] importAndOpenXMEML result:", res);
            if (res && res.indexOf("error") >= 0) log("warn", "XMEML import: " + res);
            else log("success", "Sequence imported and opened: " + res);
            return new Promise(function (resolve) { setTimeout(resolve, 1500); });
        }).then(function () {
            return evalHostScript('openSequenceByName("WHISPER_EDIT")');
        }).then(function (res) {
            console.log("[Paper Editor] openSequenceByName result:", res);
        });
    }

    function step10_postImportJSX(ctx) {
        var chain = Promise.resolve();

        // ── Step 10a: Name MOGRT ──
        if (ctx.nameMogrtJSX) {
            chain = chain.then(function () {
                log("info", "Running Name MOGRT placement script...");
                return evalScriptPromise(ctx.nameMogrtJSX).then(function (nRes) {
                    log("info", "Name MOGRT placement result: " + (nRes && nRes !== "undefined" ? nRes : "done"));
                });
            });
        }

        // ── Step 10b: Hearts ──
        if (ctx.heartsJSXPath) {
            chain = chain.then(function () {
                log("info", "Running Hearts MOGRT placement script...");
                return evalScriptPromise(fs.readFileSync(ctx.heartsJSXPath, "utf8")).then(function (hRes) {
                    log("info", "Hearts placement result: " + (hRes && hRes !== "undefined" ? hRes : "done"));
                });
            });
        }

        // ── Step 10c: Organize project bins ──
        chain = chain.then(function () {
            return evalHostScript("organizeProjectIntoBins()").then(function (bRes) {
                if (bRes && bRes.indexOf("success") >= 0) log("info", "Project bins: " + bRes);
                else if (bRes && bRes.indexOf("error") >= 0) log("warn", "Bin organization: " + bRes);
            });
        });

        // ── Step 10d: End Leaderboard ──
        if (ctx.endLbJSXPath) {
            chain = chain.then(function () {
                log("info", "Running End Leaderboard placement script...");
                return evalScriptPromise(fs.readFileSync(ctx.endLbJSXPath, "utf8")).then(function (eRes) {
                    log("info", "End Leaderboard placement result: " + (eRes && eRes !== "undefined" ? eRes : "done"));
                });
            });
        }

        // ── Step 10e: Offline media check + relink ──
        return chain.then(function () {
            log("info", "Checking for offline media...");
            var projectFolderPathFile = pathMod.join(ctx.projectFolder, "_pe_project_folder.txt");
            try { fs.writeFileSync(projectFolderPathFile, ctx.projectFolder, "utf8"); }
            catch (pfErr) { log("warn", "Could not write project folder path file: " + pfErr.message); return; }
            var safePfPath = projectFolderPathFile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            return evalHostScript('checkAndRelinkOfflineMedia("' + safePfPath + '")');
        }).then(function (relinkRes) {
            if (!relinkRes) return;
            try {
                var r = JSON.parse(relinkRes);
                if (r.relinked > 0) log("info", "Relinked " + r.relinked + " offline clip(s)");
                if (r.stillOffline && r.stillOffline.length > 0) {
                    var msg = "Some media could not be relinked (" + r.stillOffline.length + " offline):\n\n";
                    for (var i = 0; i < r.stillOffline.length; i++) {
                        msg += "• " + (r.stillOffline[i].name || "(unnamed)") + "\n  " + r.stillOffline[i].path + "\n\n";
                    }
                    msg += "Relink manually via Right-click → Link Media.";
                    alert(msg);
                    log("warn", msg);
                }
                if (r.error) log("warn", "Offline check: " + r.error);
            } catch (parseErr) {
                log("warn", "Offline check result: " + (relinkRes || "empty"));
            }
        });
    }

    // ── Main pipeline orchestrator ──
    // Reads UI inputs, builds the pipeline context, and runs the step chain.

    function runProcessAsync() {
        var scriptPath = document.getElementById("paper-edit-path").value;
        var fpsVal = document.getElementById("fps").value;
        var fpsF = parseFloat(fpsVal);
        if (isNaN(fpsF) || fpsF <= 0 || fpsF > 120) {
            log("warn", "Invalid FPS '" + fpsVal + "', using 23.976");
            fpsF = 23.976;
            fpsVal = "23.976";
        }
        var padSec = parseFloat(document.getElementById("padding").value) || 0.5;
        var padFrames = Math.round(padSec * fpsF);
        var gapSec = parseFloat(document.getElementById("gap-duration").value) || 5.0;
        var gapFrames = Math.round(gapSec * fpsF);

        var ctx = {
            scriptPath:     scriptPath,
            fpsVal:         fpsVal,
            fpsF:           fpsF,
            padFrames:      padFrames,
            gapFrames:      gapFrames,
            optQuoteCards:  document.getElementById("opt-quote-cards").checked,
            optYtClips:     document.getElementById("opt-yt-clips").checked,
            optLeaderboard: document.getElementById("opt-leaderboard").checked,
            optHearts:      document.getElementById("opt-hearts").checked,
            optSparkles:    document.getElementById("opt-sparkles").checked,
            optNameMogrt:   document.getElementById("opt-name-mogrt").checked,
            // Pipeline state (populated by step functions)
            camInfos: [], numCams: 0, hasExtAudio: false, validExtAudioParts: [],
            camDurations: null, extAudioDurations: [], extAudioChannels: 2,
            camWhisper: null, extAudioWhisper: null,
            syncOffsets: [0.0], extAudioSyncOffset: 0.0,
            entries: [], projectFolder: null, quotesFolder: null, peName: null,
            qcEntries: [], hasQuoteCards: false, qcCardMap: {},
            ytClipMap: {}, hasYouTubeClips: false,
            leaderboardMovPath: null, leaderboardMovDurationFrames: null,
            leaderboardMovInfo: null, leaderboardGridPngPath: null,
            hasScoringReveals: false, clipPlacements: [], matchCount: 0, noMatchCount: 0,
            xmemlResult: null, endLbTemplatesDir: null, endLbMissing: null, xmlPath: null,
            nameMogrtJSX: null, heartsJSXPath: null, endLbJSXPath: null
        };

        return step1_validateInputs(ctx)
            .then(function () { return step2_detectPartDurations(ctx); })
            .then(function () { return step3_transcribeCameras(ctx); })
            .then(function () { return step4_autoSync(ctx); })
            .then(function () { return step5_parseAndSetupProject(ctx); })
            .then(function () { return step5c_downloadYouTubeClips(ctx); })
            .then(function () { return step5d_processLeaderboardAE(ctx); })
            .then(function () { return step6_matchClipsAndBuildPlacements(ctx); })
            .then(function () { return step7_buildXMEML(ctx); })
            .then(function () { return step8_generateJSXFiles(ctx); })
            .then(function () { return step9_importAndOpen(ctx); })
            .then(function () { return step10_postImportJSX(ctx); })
            .then(function () {
                updateProgress(100, "Done!");
                log("success", "Cameras: " + ctx.numCams + "  |  Matched: " + ctx.matchCount + "  |  No Match: " + ctx.noMatchCount +
                    "  |  Reveals: " + ctx.entries.filter(function (e) { return e.type === "reveal"; }).length +
                    "  |  Links: " + ctx.entries.filter(function (e) { return e.type === "link"; }).length);
                if (ctx.numCams > 1) {
                    for (var ci = 1; ci < ctx.numCams; ci++) {
                        log("info", "  " + ctx.camInfos[ci].label + " sync offset: " + ctx.syncOffsets[ci].toFixed(3) + "s");
                    }
                }
                if (ctx.hasExtAudio) log("info", "  External audio sync offset: " + ctx.extAudioSyncOffset.toFixed(3) + "s");
                log("success", "Project folder: " + ctx.projectFolder);
                if (ctx.hasQuoteCards) {
                    log("info", "  Quote cards placed: " + Object.keys(ctx.qcCardMap).length);
                }
            });
    }

    // ══════════════════════════════════════════════════════════
    //  INITIALIZATION
    // ══════════════════════════════════════════════════════════

    document.addEventListener("DOMContentLoaded", function () {
        console.log("[Paper Editor] DOMContentLoaded");

        try {
            logArea = document.getElementById("log-area");

            loadSettings();

            // Wire up buttons
            document.getElementById("btn-add-camera").addEventListener("click", addCamera);
            document.getElementById("btn-add-ext-audio").addEventListener("click", function () {
                extAudioParts.push("");
                renderExtAudio();
            });
            document.getElementById("btn-settings").addEventListener("click", openSettings);
            document.getElementById("btn-settings-done").addEventListener("click", closeSettings);
            var btnClearCache = document.getElementById("btn-clear-cache");
            if (btnClearCache) btnClearCache.addEventListener("click", function () {
                if (confirm("Clear session cache? Cameras, paths, and toggles will reset.")) {
                    clearCache();
                    closeSettings();
                }
            });
            document.getElementById("btn-generate-qc").addEventListener("click", generateQuoteCards);
            document.getElementById("btn-process-lb").addEventListener("click", processLeaderboardStandalone);

            // #13: Settings export / import buttons
            var btnExportSettings = document.getElementById("btn-export-settings");
            if (btnExportSettings) btnExportSettings.addEventListener("click", exportSettings);
            var btnImportSettings = document.getElementById("btn-import-settings");
            if (btnImportSettings) btnImportSettings.addEventListener("click", importSettings);

            // #15: Copy log button
            var btnCopyLog = document.getElementById("btn-copy-log");
            if (btnCopyLog) btnCopyLog.addEventListener("click", copyLog);

            // Feature toggle wiring (must happen before loadCache so change events work)
            wireFeatureToggle("opt-quote-cards", "qc-feature-body", ["opt-yt-clips"]);
            wireFeatureToggle("opt-leaderboard", "lb-feature-body");
            wireFeatureToggle("opt-ext-audio", "ext-audio-body");
            wireFeatureToggle("opt-hearts", null, ["opt-sparkles"]);

            // Restore cached inputs (after toggle wiring so dispatched events are handled)
            var didRestoreCache = loadCache();

            // Add a default camera only if cache didn't restore any
            if (cameras.length === 0) addCamera();
            document.getElementById("btn-generate").addEventListener("click", generate);
            var btnCancel = document.getElementById("btn-cancel");
            if (btnCancel) btnCancel.addEventListener("click", requestCancel);

            wireBrowseButtons();

            document.getElementById("settings-modal").addEventListener("click", function (e) {
                if (e.target === this) closeSettings();
            });

            log("info", "Paper Editor CEP panel loaded.");
            log("info", "Extension dir: " + extensionDir);

            // Validate binary paths on startup
            var binaries = [
                ["FFprobe", settings.ffprobeExe],
                ["FFmpeg", settings.ffmpegExe],
                ["Whisper", settings.whisperExe],
                ["Whisper model", settings.whisperModel]
            ];
            binaries.forEach(function (b) {
                if (b[1] && fs.existsSync(b[1])) {
                    log("info", b[0] + ": OK");
                } else {
                    log("warn", b[0] + ": NOT FOUND at " + b[1] + " — configure in Settings");
                }
            });

            // #12: CUDA/GPU detection
            childProcess.exec(
                "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader",
                { windowsHide: true, timeout: 8000 },
                function (err, stdout) {
                    if (!err && stdout && stdout.trim()) {
                        log("info", "GPU: " + stdout.trim().split("\n")[0]);
                    } else {
                        log("warn", "No NVIDIA GPU detected — Whisper will use CPU. Transcription will be slower.");
                    }
                    // #9: emit cache restore message after all startup messages
                    if (didRestoreCache) {
                        log("info", "Previous session restored — transcripts cached, click Generate to resume");
                    }
                }
            );

        } catch (e) {
            console.error("[Paper Editor] Init failed:", e);
            if (logArea) {
                log("warn", "Initialization error: " + e.message);
            }
        }
    });

})();
