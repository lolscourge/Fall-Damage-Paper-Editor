/**
 * hearts.js — Hearts MOGRT scoring logic.
 * Port of PaperEditor.py's heart state computation and JSX generation.
 */

var Hearts = (function () {
    "use strict";

    // Dropdown Menu Control values inside the .mogrt
    var HEART_OPAQUE      = 0;
    var HEART_FULL        = 1;
    var HEART_GREY_BROKEN = 2;
    var HEART_NO_HEART    = 3;
    var HEART_HALF        = 4;

    var PREMIERE_TICKS_PER_SECOND = XMEMLBuilder.TICKS_PER_SECOND;

    // Effective heart positions in the MOGRT Master comp (3840x540).
    // The hearts live in 1920x1080 precomps (center 960,540) with the
    // heart visual at (260,204) inside, placed at (900,582) in Master.
    // Effective = 900 + (260-960) = 200,  582 + (204-540) = 246.
    var NATIVE_FIRST_HEART_X = 200;
    var NATIVE_HEART_SPACING = 344;
    var NATIVE_HEART_Y       = 246;
    var NATIVE_COMP_CENTER_X = 1920; // 3840 / 2
    var NATIVE_COMP_CENTER_Y = 270;  // 540 / 2

    // MOGRT placement in Premiere (pixel coords in 1920x1080 sequence)
    var TOP_ROW_CENTER    = { x: 695.0, y: 832.0 };
    var BOTTOM_ROW_CENTER = { x: 695.0, y: 923.0 };
    var MOGRT_SCALE       = 30; // percent

    /**
     * Compute the screen-space pixel position of a specific heart.
     * @param {number} heartIndex - 0-based index (0-10) within the row
     * @param {boolean} isTopRow - true for top row, false for bottom
     * @returns {{ x: number, y: number }}
     */
    function getHeartScreenPos(heartIndex, isTopRow) {
        var nativeX = NATIVE_FIRST_HEART_X + heartIndex * NATIVE_HEART_SPACING;
        var center = isTopRow ? TOP_ROW_CENTER : BOTTOM_ROW_CENTER;
        var s = MOGRT_SCALE / 100;
        return {
            x: center.x + (nativeX - NATIVE_COMP_CENTER_X) * s,
            y: center.y + (NATIVE_HEART_Y - NATIVE_COMP_CENTER_Y) * s
        };
    }

    /**
     * For each reveal, determine which heart changed and on which row.
     * @param {Array<number>} revealScores - list of scores
     * @returns {Array<{ heartIndex: number, isTopRow: boolean }>}
     */
    function computeChangedHearts(revealScores) {
        var n = revealScores.length;
        var topCount = Math.floor(n / 2);
        var changes = [];
        for (var i = 0; i < n; i++) {
            if (i < topCount) {
                changes.push({ heartIndex: i, isTopRow: true });
            } else {
                changes.push({ heartIndex: i - topCount, isTopRow: false });
            }
        }
        return changes;
    }

    function scoreToHeartValue(score) {
        if (score === null || score === undefined) return HEART_OPAQUE;
        if (score >= 1.0) return HEART_FULL;
        if (score === 0.5) return HEART_HALF;
        return HEART_GREY_BROKEN;
    }

    /**
     * Compute cumulative heart states for each reveal.
     * @param {Array<number>} revealScores - list of scores (0.0, 0.5, 1.0)
     * @returns {Array} list of { top: [...], bottom: [...] } per reveal
     */
    function computeHeartStates(revealScores) {
        var n = revealScores.length;
        if (n === 0) return [];

        var topCount = Math.floor(n / 2);
        var bottomCount = Math.ceil(n / 2);

        // Initialize
        var top = [], bottom = [];
        for (var i = 0; i < 11; i++) {
            top.push(i < topCount ? HEART_OPAQUE : HEART_NO_HEART);
            bottom.push(i < bottomCount ? HEART_OPAQUE : HEART_NO_HEART);
        }

        var states = [];
        for (var i = 0; i < n; i++) {
            var value = scoreToHeartValue(revealScores[i]);
            if (i < topCount) {
                top[i] = value;
            } else {
                bottom[i - topCount] = value;
            }
            states.push({ top: top.slice(), bottom: bottom.slice() });
        }

        return states;
    }

    /**
     * Generate ExtendScript JSX to place heart MOGRTs via importMGT,
     * and optionally place sparkle clips on newly revealed hearts.
     *
     * @param {string} mogrtPath - absolute path to the .mogrt file
     * @param {Array} revealData - list of { frame, score, gapFrames }
     * @param {number} fps - framerate
     * @param {number} topTrackIdx - video track index for the top heart row
     * @param {number} bottomTrackIdx - video track index for the bottom heart row
     * @param {string} [sparklesPath] - absolute path to Sparkles.mov
     * @param {number} [sparkleTrackIdx] - video track index for sparkles
     * @returns {string} ExtendScript JSX code
     */
    function generateHeartsJSX(mogrtPath, revealData, fps, topTrackIdx, bottomTrackIdx, sparklesPath, sparkleTrackIdx, logDir) {
        var scores = revealData.map(function (r) { return r.score; });
        var states = computeHeartStates(scores);

        if (states.length === 0) return "";

        var mogrtPathJS = mogrtPath.replace(/\\/g, "/");
        // Write log to the project folder (logDir), not next to the MOGRT which may be read-only
        var mogrtDirJS = mogrtPath.replace(/\\/g, "/").replace(/\/[^\/]*$/, "");
        var logPathJS = (logDir ? logDir.replace(/\\/g, "/") : mogrtDirJS) + "/_hearts_log.txt";
        var hasSparkles = !!(sparklesPath && sparkleTrackIdx >= 0);
        var sparklesPathJS = hasSparkles ? sparklesPath.replace(/\\/g, "/") : "";
        var changedHearts = hasSparkles ? computeChangedHearts(scores) : [];

        var placementLines = [];
        for (var idx = 0; idx < revealData.length; idx++) {
            var rd = revealData[idx];
            var state = states[idx];
            var ticks = Math.round((rd.frame / fps) * PREMIERE_TICKS_PER_SECOND);

            var topVals = "[" + state.top.join(",") + "]";
            var bottomVals = "[" + state.bottom.join(",") + "]";

            placementLines.push(
                '    placeHeartPair("' + ticks + '", ' + topTrackIdx + ', ' + bottomTrackIdx + ', ' +
                topVals + ', ' + bottomVals + '); // Reveal ' + (idx + 1) + ' (' + rd.score + 'pt)'
            );

            if (hasSparkles && changedHearts[idx]) {
                var ch = changedHearts[idx];
                var pos = getHeartScreenPos(ch.heartIndex, ch.isTopRow);
                placementLines.push(
                    '    placeSparkle("' + ticks + '", ' +
                    pos.x.toFixed(1) + ', ' + pos.y.toFixed(1) +
                    '); // Sparkle on ' + (ch.isTopRow ? 'top' : 'bottom') +
                    ' heart ' + (ch.heartIndex + 1)
                );
            }
        }

        var numReveals = states.length;

        var jsx = '';
        jsx += 'var MOGRT_PATH = "' + mogrtPathJS + '";\n';
        jsx += 'var LOG_PATH = "' + logPathJS + '";\n';
        if (hasSparkles) {
            jsx += 'var SPARKLES_PATH = "' + sparklesPathJS + '";\n';
            jsx += 'var SPARKLE_TRACK_IDX = ' + sparkleTrackIdx + ';\n';
        }
        jsx += '\n';

        jsx += 'function logMsg(msg) {\n';
        jsx += '    var d = new Date();\n';
        jsx += '    var time = d.getHours() + ":" + d.getMinutes() + ":" + d.getSeconds();\n';
        jsx += '    try {\n';
        jsx += '        var f = new File(LOG_PATH);\n';
        jsx += '        f.open("a");\n';
        jsx += '        f.writeln(time + " | " + msg);\n';
        jsx += '        f.close();\n';
        jsx += '    } catch (logErr) {}\n';
        jsx += '}\n\n';

        jsx += 'try {\n';
        jsx += '    var initLog = new File(LOG_PATH);\n';
        jsx += '    initLog.open("w");\n';
        jsx += '    initLog.writeln("=== HEARTS MOGRT SCRIPT INITIATED ===");\n';
        jsx += '    initLog.close();\n';
        jsx += '} catch (initErr) {}\n\n';

        jsx += 'var HEART_NAMES = [\n';
        jsx += '    "Heart 1","Heart 2","Heart 3","Heart 4","Heart 5",\n';
        jsx += '    "Heart 6","Heart 7","Heart 8","Heart 9","Heart 10","Heart 11"\n';
        jsx += '];\n\n';

        jsx += 'var placed = 0;\n';
        jsx += 'var errors = [];\n\n';

        jsx += 'function placeHeartPair(tickStr, topIdx, botIdx, topH, botH) {\n';
        jsx += '    var seq = app.project.activeSequence;\n';
        jsx += '    logMsg("Processing reveal at ticks: " + tickStr + " (Target Tracks: V" + (topIdx+1) + " & V" + (botIdx+1) + ")");\n\n';
        
        // --- TOP ROW (Visual Top / Layer 2) ---
        jsx += '    var topItem = seq.importMGT(MOGRT_PATH, tickStr, topIdx, 0);\n';
        jsx += '    if (!topItem) {\n';
        jsx += '        var err = "importMGT failed for top track at ticks " + tickStr;\n';
        jsx += '        errors.push(err);\n';
        jsx += '        logMsg("ERROR: " + err);\n';
        jsx += '    } else {\n';
        jsx += '        logMsg("Top MOGRT imported successfully. Setting values...");\n';
        jsx += '        setHearts(topItem, topH);\n';
        // Updated Coordinate: 695.0, 832.0 (Top Row / Layer 2)
        jsx += '        configureItem(topItem, 695.0, 832.0, 30, 0);\n';
        jsx += '        placed++;\n';
        jsx += '    }\n\n';

        // --- BOTTOM ROW (Visual Bottom / Layer 1) ---
        jsx += '    var botItem = seq.importMGT(MOGRT_PATH, tickStr, botIdx, 0);\n';
        jsx += '    if (!botItem) {\n';
        jsx += '        var err = "importMGT failed for bottom track at ticks " + tickStr;\n';
        jsx += '        errors.push(err);\n';
        jsx += '        logMsg("ERROR: " + err);\n';
        jsx += '    } else {\n';
        jsx += '        logMsg("Bottom MOGRT imported successfully. Setting values...");\n';
        jsx += '        setHearts(botItem, botH);\n';
        // Updated Coordinate: 695.0, 923.0 (Bottom Row / Layer 1)
        jsx += '        configureItem(botItem, 695.0, 923.0, 30, 0);\n';
        jsx += '        placed++;\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        jsx += 'function setHearts(item, vals) {\n';
        jsx += '    try {\n';
        jsx += '        var comp = item.getMGTComponent();\n';
        jsx += '        if (!comp) {\n';
        jsx += '            errors.push("getMGTComponent() returned null");\n';
        jsx += '            logMsg("ERROR: getMGTComponent() returned null");\n';
        jsx += '            return;\n';
        jsx += '        }\n';
        jsx += '        for (var i = 0; i < 11; i++) {\n';
        jsx += '            var p = comp.properties.getParamForDisplayName(HEART_NAMES[i]);\n';
        jsx += '            if (p) {\n';
        jsx += '                p.setValue(vals[i], true);\n';
        jsx += '            } else {\n';
        jsx += '                errors.push("Param not found: " + HEART_NAMES[i]);\n';
        jsx += '                logMsg("ERROR: Param not found: " + HEART_NAMES[i]);\n';
        jsx += '            }\n';
        jsx += '        }\n';
        jsx += '    } catch (e) {\n';
        jsx += '        errors.push("setHearts error: " + e.message);\n';
        jsx += '        logMsg("CRITICAL ERROR in setHearts: " + e.message);\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        // --- UPDATED CONFIGURE ITEM FUNCTION WITH NORMALIZATION ---
        jsx += 'function configureItem(item, posX, posY, scaleVal, labelColor) {\n';
        jsx += '    try {\n';
        jsx += '        // 1. Get Sequence Resolution for Normalization\n';
        jsx += '        var seq = app.project.activeSequence;\n';
        jsx += '        var settings = seq.getSettings();\n';
        jsx += '        var seqWidth = settings.videoFrameWidth;\n';
        jsx += '        var seqHeight = settings.videoFrameHeight;\n\n';

        jsx += '        // 2. Normalize to 0.0-1.0 using the 1920x1080 reference frame.\n';
        jsx += '        //    Pixel coords are defined for 1920x1080, so always divide by\n';
        jsx += '        //    that reference — not the actual sequence resolution — so that\n';
        jsx += '        //    placement is correct on 4K, UHD, or any other sequence size.\n';
        jsx += '        var normX = posX / 1920;\n';
        jsx += '        var normY = posY / 1080;\n';
        jsx += '        logMsg("  seq=" + seqWidth + "x" + seqHeight + ", pixels [" + posX + "," + posY + "] -> normalized [" + normX.toFixed(4) + "," + normY.toFixed(4) + "]");\n\n';

        jsx += '        // Set purple colour label on the project item\n';
        jsx += '        if (item.projectItem && item.projectItem.setColorLabel) {\n';
        jsx += '            item.projectItem.setColorLabel(labelColor);\n';
        jsx += '        }\n';
        jsx += '        // Set scale and position via the Motion fixed effect\n';
        jsx += '        for (var i = 0; i < item.components.numItems; i++) {\n';
        jsx += '            if (item.components[i].displayName === "Motion") {\n';
        jsx += '                var motion = item.components[i];\n';
        jsx += '                var posParam = motion.properties.getParamForDisplayName("Position");\n';
        jsx += '                var scaleParam = motion.properties.getParamForDisplayName("Scale");\n';
        jsx += '                if (posParam) {\n';
        jsx += '                    // Set X and Y separately using NORMALIZED values\n';
        jsx += '                    try {\n';
        jsx += '                        if (posParam.getParamByIndex) {\n';
        jsx += '                            posParam.getParamByIndex(0).setValue(normX, true);\n';
        jsx += '                            posParam.getParamByIndex(1).setValue(normY, true);\n';
        jsx += '                        } else {\n';
        jsx += '                            posParam.setValue([normX, normY], true);\n';
        jsx += '                        }\n';
        jsx += '                        logMsg("  Position set successfully.");\n';
        jsx += '                    } catch (pe) {\n';
        jsx += '                        logMsg("  Position setValue failed: " + pe.message);\n';
        jsx += '                    }\n';
        jsx += '                }\n';
        jsx += '                if (scaleParam) {\n';
        jsx += '                    scaleParam.setValue(scaleVal, true);\n';
        jsx += '                    logMsg("  Scale set to " + scaleVal);\n';
        jsx += '                }\n';
        jsx += '                break;\n';
        jsx += '            }\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {\n';
        jsx += '        logMsg("configureItem error: " + e.message);\n';
        jsx += '        errors.push("configureItem error: " + e.message);\n';
        jsx += '    }\n';
        jsx += '}\n\n';
        // -----------------------------------------------------------

        // ── Sparkle placement ──
        if (hasSparkles) {
            jsx += 'var sparklesItem = null;\n\n';

            jsx += 'function importSparkles() {\n';
            jsx += '    try {\n';
            jsx += '        var result = app.project.importFiles([SPARKLES_PATH], true, app.project.rootItem, false);\n';
            jsx += '        if (!result) {\n';
            jsx += '            logMsg("Sparkles import returned false, searching project...");\n';
            jsx += '        }\n';
            jsx += '    } catch(e) {\n';
            jsx += '        logMsg("Sparkles import exception: " + e.message);\n';
            jsx += '    }\n';
            jsx += '    // Find the imported item\n';
            jsx += '    for (var i = 0; i < app.project.rootItem.children.numItems; i++) {\n';
            jsx += '        var child = app.project.rootItem.children[i];\n';
            jsx += '        if (child.name === "Sparkles.mov" || child.name === "Sparkles") {\n';
            jsx += '            sparklesItem = child;\n';
            jsx += '            logMsg("Found sparkles project item: " + child.name);\n';
            jsx += '            return;\n';
            jsx += '        }\n';
            jsx += '    }\n';
            jsx += '    logMsg("WARNING: Could not find Sparkles.mov in project after import");\n';
            jsx += '}\n\n';

            jsx += 'function placeSparkle(tickStr, screenX, screenY) {\n';
            jsx += '    if (!sparklesItem) return;\n';
            jsx += '    var seq = app.project.activeSequence;\n';
            jsx += '    var track = seq.videoTracks[SPARKLE_TRACK_IDX];\n';
            jsx += '    if (!track) {\n';
            jsx += '        logMsg("Sparkle track " + SPARKLE_TRACK_IDX + " not found");\n';
            jsx += '        return;\n';
            jsx += '    }\n';
            jsx += '    try {\n';
            jsx += '        track.overwriteClip(sparklesItem, tickStr);\n';
            jsx += '        logMsg("Sparkle placed at ticks " + tickStr + " pos [" + screenX + "," + screenY + "]");\n';
            jsx += '        // Find the clip we just placed and configure position/scale\n';
            jsx += '        var clip = null;\n';
            jsx += '        for (var i = track.clips.numItems - 1; i >= 0; i--) {\n';
            jsx += '            if (track.clips[i].start.ticks === tickStr) {\n';
            jsx += '                clip = track.clips[i];\n';
            jsx += '                break;\n';
            jsx += '            }\n';
            jsx += '        }\n';
            jsx += '        if (clip) {\n';
            jsx += '            configureItem(clip, screenX, screenY, 30.1, 0);\n';
            jsx += '        } else {\n';
            jsx += '            logMsg("WARNING: Could not find sparkle clip after overwrite");\n';
            jsx += '        }\n';
            jsx += '    } catch(e) {\n';
            jsx += '        logMsg("placeSparkle error: " + e.message);\n';
            jsx += '        errors.push("placeSparkle: " + e.message);\n';
            jsx += '    }\n';
            jsx += '}\n\n';
        }

        jsx += '(function() {\n';
        jsx += '    try {\n';
        jsx += '        var seq = app.project.activeSequence;\n';
        jsx += '        if (!seq) {\n';
        jsx += '            logMsg("FATAL: No active sequence found. Aborting.");\n';
        jsx += '            alert("No active sequence found. Click into your timeline and run again.");\n';
        jsx += '            return;\n';
        jsx += '        }\n\n';
        jsx += '        var f = new File(MOGRT_PATH);\n';
        jsx += '        if (!f.exists) {\n';
        jsx += '            logMsg("FATAL: MOGRT file not found at " + MOGRT_PATH);\n';
        jsx += '            alert("MOGRT file not found. Check the log.");\n';
        jsx += '            return;\n';
        jsx += '        }\n\n';
        jsx += '        logMsg("Sequence found. Beginning placement of ' + (numReveals * 2) + ' MOGRTs...");\n\n';
        if (hasSparkles) {
            jsx += '        importSparkles();\n\n';
        }
        jsx += placementLines.join('\n') + '\n\n';
        jsx += '        logMsg("=== SCRIPT FINISHED ===");\n';
        jsx += '        logMsg("Placed: " + placed + " MOGRTs.");\n';
        jsx += '        logMsg("Errors: " + errors.length);\n\n';
        jsx += '        if (errors.length > 0) {\n';
        jsx += '            alert("Hearts script finished with " + errors.length + " errors. Check the _log.txt file next to your MOGRT.");\n';
        jsx += '        } else {\n';
        jsx += '            alert("Hearts script done! Placed " + placed + " MOGRTs.");\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {\n';
        jsx += '        logMsg("UNHANDLED EXCEPTION: " + e.message);\n';
        jsx += '    }\n';
        jsx += '})();\n';

        return jsx;
    }

    return {
        computeHeartStates: computeHeartStates,
        computeChangedHearts: computeChangedHearts,
        getHeartScreenPos: getHeartScreenPos,
        generateHeartsJSX: generateHeartsJSX,
        HEART_OPAQUE: HEART_OPAQUE,
        HEART_FULL: HEART_FULL,
        HEART_GREY_BROKEN: HEART_GREY_BROKEN,
        HEART_NO_HEART: HEART_NO_HEART,
        HEART_HALF: HEART_HALF
    };
})();