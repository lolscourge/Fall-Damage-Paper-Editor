/**
 * leaderboard-end.js — Appends "Leaderboard End" production tracks to the main
 * WHISPER_EDIT XMEML string before it is written to disk.
 *
 * Why not copy the nest into the project?
 * The template "Leaderboard End" lives in a Premiere .prproj (template_project_expanded.xml),
 * not in XMEML. We generate a single XMEML (WHISPER_EDIT) and import it; Premiere’s FCP XML
 * import does not merge in sequences from a .prproj. To use a nest we would need to:
 *   (1) Export the Leaderboard End sequence as FCP XML once (or build equivalent XMEML),
 *   (2) Include that as a second <sequence> in our XMEML and reference it from the main
 *       sequence via a clipitem that contains the nested <sequence>, or
 *   (3) Import the main XMEML, then run JSX to import a second XMEML (Leaderboard End) and
 *       place it as a nest at endLbRevealFrame.
 * Option (2) would preserve one “nest” clip and keep all layout/effects inside it, but we’d
 * still need to build that sequence XMEML (with paths for the project-specific LB .mov and
 * templates) and implement the clipitem/sequence-ref format. Current approach avoids that
 * by appending flat tracks to the main sequence and applying effects in JSX.
 *
 * Approach (identical mechanism to the main sequence):
 *   • appendToXMEML() inserts <track> elements into the XMEML <video> and <audio>
 *     sections with correct frame-count <in>/<out> values.  No runtime trimming.
 *     No importFiles() calls.  No offline-file risk.
 *   • generateJSX() produces a tiny ExtendScript script (run after XMEML import)
 *     that applies Ultra Key to the Fireworks clip and Constant Power fades to
 *     the music / climb-tone / drum-roll audio clips via the qe DOM.
 *
 * Layout — offsets and durations in FRAMES, anchored at the 2nd LB reveal (rf).
 * Values match the "Leaderboard End" sequence in templates/template_project_expanded.xml
 * (23.976 fps; ticks/frame 10594584000). Lumetri on LB mov and Confetti is not applied
 * here — set those manually after import if needed.
 *
 *  VIDEO tracks (appended above all existing tracks, bottom → top)
 *   V+0  END CARD nologo.mov       start rf+13   dur 200 f
 *   V+1  Leaderboard .mov (opt.)   start rf+18   dur 195 f   alpha straight
 *   V+2  Confetti .mov             start rf+72   dur 109 f  [Ultra Key — key out black]
 *   V+3  Fireworks .mp4            start rf+111  dur  64 f   [Ultra Key — green screen]
 *
 *  AUDIO tracks (7 tracks, appended after all existing audio tracks)
 *   A+0  Music ch1    start rf+1    dur 187 f   fade-in 20 f  fade-out 26 f
 *   A+1  Music ch2    start rf+1    dur 187 f   fade-in 20 f  fade-out 26 f
 *   A+2  Whoosh #1    start rf+48   dur  15 f
 *   A+3  Climb Tone   start rf+53   dur  63 f   fade-in 63 f
 *   A+4  Drum Roll    start rf+79   dur  37 f   fade-in  8 f
 *   A+5  Whoosh #2    start rf+81   dur  35 f
 *   A+6  Party Horn   start rf+108  dur  24 f
 *
 * Required template files (templates/ folder):
 *   16-9 fall damage END CARD_nologo.mov
 *   Fireworks   Green Screen   Free Download.mp4
 *   200206_02_Particle_exploding_confetti.mov
 *   ES_Red Hour - Jharee.mp3
 *   20 CINEMATIC WHOOSH.mp3
 *   DRUM ROLL SOUND EFFECTS.m4a
 *   Retro, 8 Bit, Climb Tone 01.mp3
 *   Party Horn.mp3
 *
 * Note: Lumetri Color grades visible in the template project cannot be applied
 * programmatically — set them manually on the LB .mov and Confetti clips after import.
 *
 * Framerates: Layout values above are defined at TEMPLATE_FPS (e.g. 24). They are
 * converted to the target sequence FPS so timing stays correct across framerates.
 */

var LeaderboardEnd = (function () {
    "use strict";

    var pathMod = require("path");

    /** FPS the layout was designed in (offsets/durations in the comments above).
 *  Template project "Leaderboard End" sequence uses 10594584000 ticks/frame = 23.976. */
    var TEMPLATE_FPS = 23.976;

    // ── Public constants ─────────────────────────────────────────────────────

    var REQUIRED_FILES = {
        endCard:   "16-9 fall damage END CARD_nologo.mov",
        fireworks: "Fireworks   Green Screen   Free Download.mp4",
        confetti:  "200206_02_Particle_exploding_confetti.mov",
        music:     "ES_Red Hour - Jharee.mp3",
        whoosh:    "20 CINEMATIC WHOOSH.mp3",
        drumRoll:  "DRUM ROLL SOUND EFFECTS.m4a",
        climbTone: "Retro, 8 Bit, Climb Tone 01.mp3",
        partyHorn: "Party Horn.mp3"
    };

    // Fixed properties of the confetti template asset — avoids an ffprobe call every run.
    // 200206_02_Particle_exploding_confetti.mov: ProRes, 3840x2160, 30fps, 242 frames, no audio.
    // Update if you swap the file for one with different dimensions or audio.
    var CONFETTI_INFO = { width: 3840, height: 2160, hasAudio: false };

    // ── Private XML helpers ──────────────────────────────────────────────────

    function esc(s) {
        return String(s)
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;");
    }

    // ── appendToXMEML ────────────────────────────────────────────────────────

    /**
     * Appends end-leaderboard <track> elements to an existing WHISPER_EDIT XMEML
     * string.  Must be called BEFORE fs.writeFileSync() writes the XML to disk.
     *
     * Uses XMEMLBuilder.rateXML() and XMEMLBuilder.getPathUrl() which are both
     * exported on the global XMEMLBuilder object and available in this scope.
     *
     * @param {string} xmlStr
     * @param {Object} opts
     * @param {number} opts.endLbRevealFrame    - frame index of 2nd LB reveal in main seq
     * @param {string} opts.fpsVal              - fps string e.g. "23.976"
     * @param {string} opts.templatesDir        - absolute path to templates folder
     * @param {string} [opts.projectFolder]    - absolute path to project folder (for media in project)
     * @param {string} [opts.leaderboardMovPath]- path to AE-rendered LB .mov (optional)
     * @param {string} [opts.confettiPath]     - path to confetti .mov (prefer project folder copy)
     * @returns {string} modified XMEML
     */
    function appendToXMEML(xmlStr, opts) {
        var rf       = opts.endLbRevealFrame;
        var fpsVal   = opts.fpsVal;
        var targetFps = parseFloat(fpsVal) || 24;
        var td     = opts.templatesDir.replace(/\\/g, "/").replace(/\/$/, "");
        var lbMov  = opts.leaderboardMovPath
                     ? opts.leaderboardMovPath.replace(/\\/g, "/")
                     : null;
        var confettiPath = opts.confettiPath
                          ? opts.confettiPath.replace(/\\/g, "/")
                          : (td + "/" + REQUIRED_FILES.confetti);
        var hasLb  = !!lbMov;

        // Convert template-frame values to target sequence frames (preserve timing across FPS)
        function toFrames(templateFrames) {
            return Math.max(1, Math.round((templateFrames / TEMPLATE_FPS) * targetFps));
        }

        // Reuse XMEMLBuilder's exported helpers (loaded as a global before this file)
        var rateXML = XMEMLBuilder.rateXML(fpsVal);
        function pathUrl(p) { return esc(XMEMLBuilder.getPathUrl(p)); }

        // Counter for unique IDs within our injected blocks (high range to avoid
        // collisions with XMEMLBuilder IDs that start at 1 and climb from there).
        var idCtr   = 90001;
        var fileDefs = {}; // canonical path → fileId — one <file> per path, avoids duplicate imports
        function canonPath(p) { return pathMod.resolve(String(p)).replace(/\\/g, "/"); }
        function ensureMovName(name) {
            if (!name || typeof name !== "string") return name;
            var lower = name.toLowerCase();
            if (lower.endsWith(".mov") || lower.endsWith(".mp4") || lower.endsWith(".m4v") || lower.endsWith(".mpg")) return name;
            return name + ".mov";
        }

        // ── Video <track> builder ────────────────────────────────────────────

        /**
         * Returns a <filter> block for a video effect.
         * effectId should be the FCP-XML effectid string Premiere recognises:
         *   "Luma Key" — confirmed supported in FCP XML → Premiere import
         * Premiere silently skips unrecognised effectids.
         *
         * @param {string} displayName
         * @param {string} effectId
         * @param {string} category
         * @param {Array<{name:string, value:*}>} [params]  — optional <parameter> elements
         */
        function effectFilter(displayName, effectId, category, params) {
            var paramXml = "";
            if (params) {
                for (var pi = 0; pi < params.length; pi++) {
                    paramXml += "<parameter>\n" +
                        "<name>" + esc(params[pi].name) + "</name>\n" +
                        "<value>" + esc(String(params[pi].value)) + "</value>\n" +
                        "</parameter>\n";
                }
            }
            return "<filter>\n" +
                "<enabled>TRUE</enabled>\n" +
                "<start>-1</start>\n" +
                "<end>-1</end>\n" +
                "<effect>\n" +
                "<name>" + esc(displayName) + "</name>\n" +
                "<effectid>" + esc(effectId) + "</effectid>\n" +
                "<effectcategory>" + esc(category) + "</effectcategory>\n" +
                "<effecttype>filter</effecttype>\n" +
                "<mediatype>video</mediatype>\n" +
                paramXml +
                "</effect>\n" +
                "</filter>\n";
        }

        function videoTrack(name, filePath, start, dur, alphaType, fileInfo, filterXml) {
            var clipId = "lb-c" + (idCtr++);
            var xml = "<clipitem id=\"" + clipId + "\">\n";
            xml += "<name>" + esc(name) + "</name>\n";
            xml += "<duration>" + dur + "</duration>\n";
            xml += rateXML + "\n";
            xml += "<start>" + start + "</start>\n";
            xml += "<end>" + (start + dur) + "</end>\n";
            xml += "<in>0</in>\n";
            xml += "<out>" + dur + "</out>\n";
            xml += "<alphatype>" + (alphaType || "none") + "</alphatype>\n";
            xml += "<anamorphic>FALSE</anamorphic>\n";
            var key = canonPath(filePath);
            var fid = fileDefs[key];
            if (!fid) {
                fid = "lb-f" + (idCtr++);
                fileDefs[key] = fid;
                xml += "<file id=\"" + fid + "\">\n";
                xml += "<name>" + esc(name) + "</name>\n";
                xml += "<pathurl>" + pathUrl(filePath) + "</pathurl>\n";
                xml += rateXML + "\n";
                xml += "<duration>" + dur + "</duration>\n";
                xml += "<media>\n<video>\n<samplecharacteristics>\n";
                xml += rateXML + "\n";
                var fw = (fileInfo && fileInfo.width)  ? fileInfo.width  : 1920;
                var fh = (fileInfo && fileInfo.height) ? fileInfo.height : 1080;
                xml += "<width>" + fw + "</width>\n<height>" + fh + "</height>\n";
                xml += "<anamorphic>FALSE</anamorphic>\n";
                xml += "<pixelaspectratio>square</pixelaspectratio>\n";
                xml += "<fielddominance>none</fielddominance>\n";
                xml += "</samplecharacteristics>\n</video>\n";
                var inclAudio = fileInfo ? !!fileInfo.hasAudio : true;
                if (inclAudio) {
                    xml += "<audio>\n<samplecharacteristics>\n";
                    xml += "<depth>16</depth>\n<samplerate>48000</samplerate>\n";
                    xml += "</samplecharacteristics>\n<channelcount>2</channelcount>\n";
                    xml += "</audio>\n";
                }
                xml += "</media>\n";
                xml += "</file>\n";
            } else {
                xml += "<file id=\"" + fid + "\" />\n";
            }
            if (filterXml) xml += filterXml;
            xml += "</clipitem>";
            return "<track>\n" + xml + "\n</track>\n";
        }

        // ── Audio <track> builder ────────────────────────────────────────────

        function audioTrack(name, filePath, start, dur, trackIndex) {
            var clipId = "lb-ac" + (idCtr++);
            var xml = "<clipitem id=\"" + clipId + "\">\n";
            xml += "<name>" + esc(name) + "</name>\n";
            xml += "<duration>" + dur + "</duration>\n";
            xml += rateXML + "\n";
            xml += "<start>" + start + "</start>\n";
            xml += "<end>" + (start + dur) + "</end>\n";
            xml += "<in>0</in>\n";
            xml += "<out>" + dur + "</out>\n";
            var key = canonPath(filePath);
            var fid = fileDefs[key];
            if (!fid) {
                fid = "lb-af" + (idCtr++);
                fileDefs[key] = fid;
                xml += "<file id=\"" + fid + "\">\n";
                xml += "<name>" + esc(name) + "</name>\n";
                xml += "<pathurl>" + pathUrl(filePath) + "</pathurl>\n";
                xml += rateXML + "\n";
                // Use a large placeholder — Premiere reads the real duration from the file.
                xml += "<duration>100000</duration>\n";
                xml += "<media>\n<audio>\n<samplecharacteristics>\n";
                xml += "<depth>16</depth>\n<samplerate>48000</samplerate>\n";
                xml += "</samplecharacteristics>\n";
                xml += "<channelcount>2</channelcount>\n";
                xml += "</audio>\n</media>\n";
                xml += "</file>\n";
            } else {
                xml += "<file id=\"" + fid + "\" />\n";
            }
            xml += "<sourcetrack>\n";
            xml += "<mediatype>audio</mediatype>\n";
            xml += "<trackindex>" + (trackIndex || 1) + "</trackindex>\n";
            xml += "</sourcetrack>\n";
            xml += "</clipitem>";
            return "<track>\n" + xml + "\n</track>\n";
        }

        // ── Assemble video tracks ────────────────────────────────────────────

        var lbMovInfo      = opts.leaderboardMovInfo || null;
        var confettiInfo   = opts.confettiInfo       || null;

        var videoBlocks = "";
        videoBlocks += videoTrack(
            REQUIRED_FILES.endCard,
            td + "/" + REQUIRED_FILES.endCard,
            rf + toFrames(13), toFrames(200)
        );
        if (hasLb) {
            videoBlocks += videoTrack(
                ensureMovName(pathMod.basename(lbMov)), lbMov,
                rf + toFrames(18), toFrames(195), "straight", lbMovInfo
            );
        }
        videoBlocks += videoTrack(
            ensureMovName(REQUIRED_FILES.confetti),
            confettiPath,
            rf + toFrames(72), toFrames(109), undefined, confettiInfo,
            // Luma Key: confirmed supported FCP XML → Premiere import mapping.
            // Threshold=3 keys out the dark background without clipping the confetti colours.
            effectFilter("Luma Key", "Luma Key", "Matte", [{ name: "Threshold", value: 3 }])
        );
        // Fireworks: Ultra Key (green screen) is NOT supported via FCP XML import —
        // Premiere logs "not translated" and skips it. Apply Ultra Key manually after import.
        videoBlocks += videoTrack(
            REQUIRED_FILES.fireworks,
            td + "/" + REQUIRED_FILES.fireworks,
            rf + toFrames(111), toFrames(64)
        );

        // ── Assemble audio tracks ────────────────────────────────────────────

        var musicPath = td + "/" + REQUIRED_FILES.music;
        var whooshPath = td + "/" + REQUIRED_FILES.whoosh;
        var climbPath  = td + "/" + REQUIRED_FILES.climbTone;
        var drumPath   = td + "/" + REQUIRED_FILES.drumRoll;
        var hornPath   = td + "/" + REQUIRED_FILES.partyHorn;

        var audioBlocks = "";
        // Music — stereo: two tracks, one per channel
        audioBlocks += audioTrack(REQUIRED_FILES.music,    musicPath,  rf + toFrames( 1), toFrames(187), 1);
        audioBlocks += audioTrack(REQUIRED_FILES.music,    musicPath,  rf + toFrames( 1), toFrames(187), 2);
        // SFX — mono (ch 1 each)
        audioBlocks += audioTrack(REQUIRED_FILES.whoosh,   whooshPath, rf + toFrames(48), toFrames( 15), 1);
        audioBlocks += audioTrack(REQUIRED_FILES.climbTone, climbPath, rf + toFrames(53), toFrames( 63), 1);
        audioBlocks += audioTrack(REQUIRED_FILES.drumRoll,  drumPath,  rf + toFrames(79), toFrames( 37), 1);
        audioBlocks += audioTrack(REQUIRED_FILES.whoosh,   whooshPath, rf + toFrames(81), toFrames( 35), 1);
        audioBlocks += audioTrack(REQUIRED_FILES.partyHorn, hornPath,  rf + toFrames(108), toFrames( 24), 1);

        // ── Inject into XMEML ───────────────────────────────────────────────
        // Use lastIndexOf to target the OUTER </video> and </audio> closing tags,
        // not the inner ones inside <file><media>...</media></file> elements.

        var vidClose = xmlStr.lastIndexOf("</video>\n");
        if (vidClose < 0) throw new Error("appendToXMEML: </video> not found in XMEML");
        xmlStr = xmlStr.slice(0, vidClose) + videoBlocks + xmlStr.slice(vidClose);

        var audClose = xmlStr.lastIndexOf("</audio>\n");
        if (audClose < 0) throw new Error("appendToXMEML: </audio> not found in XMEML");
        xmlStr = xmlStr.slice(0, audClose) + audioBlocks + xmlStr.slice(audClose);

        return xmlStr;
    }

    // ── generateJSX ──────────────────────────────────────────────────────────

    /**
     * Generates a short ExtendScript JSX that runs AFTER the XMEML has been
     * imported into Premiere.  It ONLY applies effects and fades — no file
     * imports, no clip placement (all done by the XMEML).
     *
     * Track indices are computed at runtime by counting from the END of the
     * sequence's track list (our tracks are always appended last).
     * Fade durations are converted from template FPS to target FPS.
     *
     * @param {Object} opts
     * @param {boolean} [opts.hasLb]  - true if a leaderboard .mov was included
     * @param {string}  [opts.logDir] - project folder for debug log
     * @param {string}  [opts.fpsVal] - sequence fps e.g. "23.976" (for fade conversion)
     * @returns {string} JSX source string
     */
    function generateJSX(opts) {
        var hasLb  = !!opts.hasLb;
        var logDir = (opts.logDir || "").replace(/\\/g, "/");
        var targetFps = parseFloat(opts.fpsVal) || 24;
        function toFrames(templateFrames) {
            return Math.max(1, Math.round((templateFrames / TEMPLATE_FPS) * targetFps));
        }
        var fadeMusicIn = toFrames(20), fadeMusicOut = toFrames(26);
        var fadeClimbIn = toFrames(63);
        var fadeDrumIn  = toFrames(8);

        var j = "";
        j += "// Auto-generated End Leaderboard effects (keys + fades + resize)\n";
        j += "(function () {\n";
        j += "try {\n\n";

        // Log helper
        j += "var _LOG = \"" + logDir + "/_leaderboard_end_log.txt\";\n";
        j += "function logMsg(m) {\n";
        j += "    try { var f = new File(_LOG); f.open('a'); f.writeln(m); f.close(); } catch(e) {}\n";
        j += "}\n";
        j += "try { var fi = new File(_LOG); fi.open('w'); fi.writeln('=== END LB EFFECTS ==='); fi.close(); } catch(e) {}\n\n";

        j += "var seq = app.project.activeSequence;\n";
        j += "if (!seq) { logMsg('FATAL: no active sequence'); return; }\n\n";

        j += "var totalVid = seq.videoTracks.numTracks;\n";
        j += "var totalAud = seq.audioTracks.numTracks;\n";
        j += "logMsg('Tracks  V:' + totalVid + '  A:' + totalAud);\n\n";

        // Our appended tracks are at the END of the track list.
        // Video layout (highest index = topmost):
        //   totalVid-2  = Confetti  (Luma Key applied via XMEML <filter> on import)
        //   totalVid-1  = Fireworks (Ultra Key applied via XMEML <filter> on import)
        // Audio layout:
        //   totalAud-7  = Music ch1
        //   totalAud-6  = Music ch2
        //   totalAud-5  = Whoosh1
        //   totalAud-4  = ClimbTone
        //   totalAud-3  = DrumRoll
        //   totalAud-2  = Whoosh2
        //   totalAud-1  = PartyHorn
        j += "var vidConfetti  = totalVid - 2;\n";
        j += "var audMusicL    = totalAud - 7;\n";
        j += "var audMusicR    = totalAud - 6;\n";
        j += "var audClimb     = totalAud - 4;\n";
        j += "var audDrum      = totalAud - 3;\n\n";

        // ── Helper: scale a clip via Motion component's Scale property ──
        // setScaleToFrameSize() does not exist in this Premiere version.
        // nativeW/nativeH = the clip's source pixel dimensions.
        // Skips automatically if the resulting scale is ~100% (clip already fills frame).
        j += "function resizeClipByScale(vidTrackIdx, nativeW, nativeH, label) {\n";
        j += "    try {\n";
        j += "        var track = seq.videoTracks[vidTrackIdx];\n";
        j += "        if (!track || !track.clips || !track.clips.numItems) { logMsg('No clips at V' + (vidTrackIdx+1) + ' (' + label + ')'); return; }\n";
        j += "        var clip = track.clips[0];\n";
        j += "        var seqW = seq.frameSizeHorizontal;\n";
        j += "        var seqH = seq.frameSizeVertical;\n";
        j += "        var scale = Math.round(Math.min(seqW / nativeW, seqH / nativeH) * 10000) / 100;\n";
        j += "        if (Math.abs(scale - 100) < 0.1) { logMsg('V' + (vidTrackIdx+1) + ' (' + label + ') already 100% — skip'); return; }\n";
        j += "        var found = false;\n";
        j += "        for (var ci = 0; ci < clip.components.numItems; ci++) {\n";
        j += "            var comp = clip.components[ci];\n";
        j += "            if (comp.displayName === 'Motion') {\n";
        j += "                for (var pi = 0; pi < comp.properties.numItems; pi++) {\n";
        j += "                    var prop = comp.properties[pi];\n";
        j += "                    if (prop.displayName === 'Scale') {\n";
        j += "                        prop.setValue(scale, true);\n";
        j += "                        logMsg('Scaled V' + (vidTrackIdx+1) + ' (' + label + ') to ' + scale + '% (native ' + nativeW + 'x' + nativeH + ', seq ' + seqW + 'x' + seqH + ')');\n";
        j += "                        found = true; break;\n";
        j += "                    }\n";
        j += "                }\n";
        j += "                if (found) break;\n";
        j += "            }\n";
        j += "        }\n";
        j += "        if (!found) logMsg('Motion/Scale prop not found on V' + (vidTrackIdx+1) + ' (' + label + ')');\n";
        j += "    } catch(re) { logMsg('Resize V' + (vidTrackIdx+1) + ' (' + label + '): ' + re.message); }\n";
        j += "}\n\n";

        // ── Resize: confetti is 3840x2160; fireworks 1920x1080 → 100% → skipped ──
        // Effects (Luma Key / Ultra Key) are embedded as XMEML <filter> elements
        // and applied automatically on import — no JSX needed for them.
        j += "logMsg('--- Resize ---');\n";
        j += "resizeClipByScale(vidConfetti, 3840, 2160, 'Confetti');\n\n";

        // ── Audio fades via standard DOM Volume component keyframes ──
        // QE DOM setInTransition/setOutTransition are absent in this Premiere version.
        // Instead we keyframe the Volume > Level property on each clip:
        //   fade-in:  -100 dB at clipStart → 0 dB at clipStart + fadeInFrames
        //   fade-out:  0 dB at clipEnd - fadeOutFrames → -100 dB at clipEnd
        j += "logMsg('--- Audio fades ---');\n";
        j += "var _fps = " + targetFps + ";\n";
        j += "function applyVolumeFade(audIdx, fadeInFrames, fadeOutFrames) {\n";
        j += "    try {\n";
        j += "        var track = seq.audioTracks[audIdx];\n";
        j += "        if (!track || !track.clips || !track.clips.numItems) { logMsg('No clip on A' + (audIdx+1)); return; }\n";
        j += "        var clip = track.clips[0];\n";
        j += "        var startTicks = parseInt(clip.start.ticks);\n";
        j += "        var endTicks   = parseInt(clip.end.ticks);\n";
        j += "        // Find Volume > Level component property\n";
        j += "        var volProp = null;\n";
        j += "        for (var ci = 0; ci < clip.components.numItems && !volProp; ci++) {\n";
        j += "            var comp = clip.components[ci];\n";
        j += "            if (comp.displayName === 'Volume') {\n";
        j += "                for (var pi = 0; pi < comp.properties.numItems && !volProp; pi++) {\n";
        j += "                    if (comp.properties[pi].displayName === 'Level') volProp = comp.properties[pi];\n";
        j += "                }\n";
        j += "            }\n";
        j += "        }\n";
        j += "        if (!volProp) { logMsg('Volume/Level not found on A' + (audIdx+1)); return; }\n";
        j += "        function _t(ticks) { var t = new Time(); t.ticks = String(ticks); return t; }\n";
        j += "        var keyIdx = -1;\n";
        j += "        if (fadeInFrames > 0) {\n";
        j += "            volProp.addKey(_t(startTicks)); keyIdx++;\n";
        j += "            volProp.setValueAtKey(keyIdx, -100);\n";
        j += "            volProp.addKey(_t(startTicks + Math.round(fadeInFrames / _fps * 254016000000))); keyIdx++;\n";
        j += "            volProp.setValueAtKey(keyIdx, 0);\n";
        j += "        }\n";
        j += "        if (fadeOutFrames > 0) {\n";
        j += "            volProp.addKey(_t(endTicks - Math.round(fadeOutFrames / _fps * 254016000000))); keyIdx++;\n";
        j += "            volProp.setValueAtKey(keyIdx, 0);\n";
        j += "            volProp.addKey(_t(endTicks)); keyIdx++;\n";
        j += "            volProp.setValueAtKey(keyIdx, -100);\n";
        j += "        }\n";
        j += "        logMsg('Volume fades A' + (audIdx+1) + ': in=' + fadeInFrames + 'f  out=' + fadeOutFrames + 'f  keys=' + (keyIdx+1));\n";
        j += "    } catch(fe) { logMsg('VolumeFade A' + (audIdx+1) + ': ' + fe.message); }\n";
        j += "}\n";
        j += "applyVolumeFade(audMusicL, " + fadeMusicIn + ", " + fadeMusicOut + ");\n";
        j += "applyVolumeFade(audMusicR, " + fadeMusicIn + ", " + fadeMusicOut + ");\n";
        j += "applyVolumeFade(audClimb,  " + fadeClimbIn + ", 0);\n";
        j += "applyVolumeFade(audDrum,   " + fadeDrumIn  + ", 0);\n\n";

        j += "logMsg('=== DONE ===');\n";
        j += "alert('End Leaderboard: resize and volume fades applied.\\nLuma Key + Ultra Key were embedded in the XMEML — check Effects Controls to confirm.');\n\n";

        j += "} catch (e) {\n";
        j += "    try {\n";
        j += "        var ef = new File(\"" + logDir + "/_leaderboard_end_log.txt\");\n";
        j += "        ef.open('a'); ef.writeln('UNHANDLED: ' + e.message + ' (line ' + e.line + ')'); ef.close();\n";
        j += "    } catch(le) {}\n";
        j += "    alert('End Leaderboard effects error: ' + e.message);\n";
        j += "}\n";
        j += "})();\n";

        return j;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    return {
        appendToXMEML: appendToXMEML,
        generateJSX:   generateJSX,
        REQUIRED_FILES: REQUIRED_FILES,
        CONFETTI_INFO:  CONFETTI_INFO
    };

})();
