/**
 * comments.js — YouTube Comment MOGRT placement.
 * Parses a comments data file, matches comments to paper edit entries,
 * and generates ExtendScript JSX for placing Comment MOGRTs in Premiere.
 */

var Comments = (function () {
    "use strict";

    var TICKS_PER_SEC = XMEMLBuilder.TICKS_PER_SECOND;
    var SINGLE_LINE_CHAR_LIMIT = 63;
    var TWO_LINE_CHAR_LIMIT = 126;

    /**
     * Parse a comments data file into an array of { username, text }.
     * Expected format: @username: comment text
     */
    function parseCommentsFile(text) {
        var lines = text.split(/\r?\n/);
        var comments = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var match = line.match(/^(@[\w.]+):\s*(.+)$/);
            if (match) {
                comments.push({ username: match[1], text: match[2].trim() });
            }
        }
        return comments;
    }

    /**
     * Normalize text for fuzzy comparison: lowercase, collapse whitespace,
     * strip most punctuation (keep apostrophes for contractions).
     */
    function normalize(s) {
        return s.toLowerCase()
            .replace(/['\u2018\u2019\u2032]/g, "'")
            .replace(/["\u201C\u201D]/g, "")
            .replace(/[^\w\s']/g, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * Match a single clip's paper-edit text against the comments list.
     * Returns { idx, comment, score } or null if no match found.
     */
    function matchClipToComment(clipText, comments, usedIndices) {
        var normClip = normalize(clipText);
        var clipWords = normClip.split(" ");
        if (clipWords.length === 0 || (clipWords.length === 1 && !clipWords[0])) return null;

        var bestIdx = -1;
        var bestScore = 0;

        for (var i = 0; i < comments.length; i++) {
            if (usedIndices[i]) continue;

            var normComment = normalize(comments[i].text);
            var commentWords = normComment.split(" ");

            // Build word set for comment
            var commentWordSet = {};
            for (var w = 0; w < commentWords.length; w++) {
                commentWordSet[commentWords[w]] = true;
            }

            // Count overlap (words in clip that also appear in comment)
            var overlap = 0;
            for (var w = 0; w < clipWords.length; w++) {
                if (commentWordSet[clipWords[w]]) overlap++;
            }

            // Jaccard similarity: overlap / union
            var union = clipWords.length + commentWords.length - overlap;
            var score = union > 0 ? overlap / union : 0;

            // Boost for substring containment
            if (normClip.indexOf(normComment) >= 0 || normComment.indexOf(normClip) >= 0) {
                score = Math.max(score, 0.8);
            }

            if (score > bestScore && score >= 0.4) {
                bestScore = score;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            return { idx: bestIdx, comment: comments[bestIdx], score: bestScore };
        }
        return null;
    }

    /**
     * Cross-reference matched clip placements against the comments list.
     * Returns an array of comment placements with timeline positions.
     *
     * @param {Array} entries - parsed paper edit entries
     * @param {Array} clipPlacements - placements from step 6 (with tlStartFrame set by builder)
     * @param {Array} comments - parsed comments [{username, text}]
     * @returns {Array} [{placementIdx, username, text, score}]
     */
    function matchClipsToComments(entries, clipPlacements, comments) {
        var result = [];
        var usedIndices = {};

        // entries and clipPlacements are 1:1 (every entry produces one placement)
        var len = Math.min(entries.length, clipPlacements.length);
        for (var i = 0; i < len; i++) {
            var entry = entries[i];
            var pl = clipPlacements[i];

            if (entry.type === "clip" && pl.type === "clip" && pl.matched) {
                var match = matchClipToComment(entry.text, comments, usedIndices);
                if (match) {
                    usedIndices[match.idx] = true;
                    result.push({
                        placementIdx: i,
                        username: match.comment.username,
                        text: match.comment.text,
                        score: match.score
                    });
                }
            }
        }

        return result;
    }

    /**
     * Generate ExtendScript JSX for placing Comment MOGRTs.
     *
     * @param {string} mogrt1Path - path to 1-line MOGRT (in project folder)
     * @param {string} mogrt2Path - path to 2-line MOGRT (in project folder)
     * @param {Array} commentPlacements - from matchClipsToComments()
     * @param {Array} clipPlacements - full placements array (with tlStartFrame set by builder)
     * @param {number} fps - frames per second
     * @param {number} trackIdx - 0-based video track index for comments
     * @returns {string} JSX script content
     */
    function generateJSX(mogrt1Path, mogrt2Path, commentPlacements, clipPlacements, fps, trackIdx) {
        var jsx = '';
        jsx += '(function() {\n';
        jsx += '    var seq = app.project.activeSequence;\n';
        jsx += '    if (!seq) { $.writeln("No active sequence for Comments MOGRT."); return; }\n';
        jsx += '    var placed = 0;\n\n';

        for (var i = 0; i < commentPlacements.length; i++) {
            var cp = commentPlacements[i];
            var useMultiLine = cp.text.length > SINGLE_LINE_CHAR_LIMIT;
            var mogrtPath = useMultiLine ? mogrt2Path : mogrt1Path;
            var mogrtPathJS = mogrtPath.replace(/\\/g, "/").replace(/"/g, '\\"');

            var pl = clipPlacements[cp.placementIdx];
            var ticks = Math.round((pl.tlStartFrame / fps) * TICKS_PER_SEC);

            var usernameEsc = cp.username
                .replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            var commentText = cp.text;
            var charLimit = useMultiLine ? TWO_LINE_CHAR_LIMIT : SINGLE_LINE_CHAR_LIMIT;
            if (commentText.length > charLimit) {
                commentText = commentText.substring(0, charLimit - 3) + "...";
            }
            // For 2-line MOGRT, split text at a space near the midpoint using \r
            if (useMultiLine && commentText.indexOf("\r") < 0) {
                var mid = Math.floor(commentText.length / 2);
                var bestSplit = -1;
                for (var si = mid; si >= mid - 15 && si >= 0; si--) {
                    if (commentText[si] === " ") { bestSplit = si; break; }
                }
                if (bestSplit < 0) {
                    for (var si = mid; si <= mid + 15 && si < commentText.length; si++) {
                        if (commentText[si] === " ") { bestSplit = si; break; }
                    }
                }
                if (bestSplit > 0) {
                    commentText = commentText.substring(0, bestSplit) + "\r" + commentText.substring(bestSplit + 1);
                }
            }
            var textEsc = commentText
                .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\r/g, "\\r").replace(/\n/g, " ");

            jsx += '    // Comment ' + (i + 1) + ': ' + cp.username + '\n';
            jsx += '    (function() {\n';
            jsx += '        var mogrtPath = "' + mogrtPathJS + '";\n';
            jsx += '        var f = new File(mogrtPath);\n';
            jsx += '        if (!f.exists) { $.writeln("Comment MOGRT not found: " + mogrtPath); return; }\n\n';
            jsx += '        var item = seq.importMGT(mogrtPath, "' + ticks + '", ' + trackIdx + ', 0);\n';
            jsx += '        if (!item) { $.writeln("Failed to import Comment MOGRT at track V' + (trackIdx + 1) + '"); return; }\n\n';

            jsx += '        try {\n';
            jsx += '            var mgt = item.getMGTComponent();\n';
            jsx += '            if (mgt) {\n';
            jsx += '                for (var j = 0; j < mgt.properties.numItems; j++) {\n';
            jsx += '                    var prop = mgt.properties[j];\n';
            jsx += '                    var curVal;\n';
            jsx += '                    try { curVal = prop.getValue(); } catch(e) { continue; }\n';
            jsx += '                    if (typeof curVal !== "string" || curVal.indexOf("textEditValue") < 0) continue;\n';

            // Identify the property by its displayName
            jsx += '                    var dName = "";\n';
            jsx += '                    try { dName = prop.displayName || ""; } catch(e) {}\n';
            jsx += '                    var dLower = dName.toLowerCase();\n';
            jsx += '                    var newText = "";\n';
            jsx += '                    var newLen = 0;\n';
            // 1-line MOGRT: "Comment Text", "User Name"
            // 2-line MOGRT: "comment", "name"
            jsx += '                    if (dLower === "user name" || dLower === "name") {\n';
            jsx += '                        newText = "' + usernameEsc + '";\n';
            jsx += '                        newLen = ' + cp.username.length + ';\n';
            jsx += '                    } else if (dLower === "comment text" || dLower === "comment") {\n';
            jsx += '                        newText = "' + textEsc + '";\n';
            jsx += '                        newLen = ' + commentText.length + ';\n';
            jsx += '                    } else {\n';
            jsx += '                        continue;\n';
            jsx += '                    }\n';

            jsx += '                    var updated = curVal.replace(\n';
            jsx += '                        /"textEditValue":"[^"]*"/,\n';
            jsx += '                        \'"textEditValue":"\' + newText + \'"\'\n';
            jsx += '                    );\n';
            jsx += '                    updated = updated.replace(\n';
            jsx += '                        /"fontTextRunLength":\\[\\d+\\]/,\n';
            jsx += '                        \'"fontTextRunLength":[\' + newLen + \']\'\n';
            jsx += '                    );\n';
            jsx += '                    prop.setValue(updated, true);\n';
            jsx += '                }\n';
            jsx += '            }\n';
            jsx += '        } catch(e) { $.writeln("Comment MOGRT text error: " + e.message); }\n';
            jsx += '        placed++;\n';
            jsx += '    })();\n\n';
        }

        jsx += '    $.writeln("Comments placed: " + placed + "/" + ' + commentPlacements.length + ');\n';
        jsx += '})();\n';

        return jsx;
    }

    return {
        parseCommentsFile: parseCommentsFile,
        matchClipToComment: matchClipToComment,
        matchClipsToComments: matchClipsToComments,
        generateJSX: generateJSX,
        SINGLE_LINE_CHAR_LIMIT: SINGLE_LINE_CHAR_LIMIT,
        TWO_LINE_CHAR_LIMIT: TWO_LINE_CHAR_LIMIT
    };
})();
