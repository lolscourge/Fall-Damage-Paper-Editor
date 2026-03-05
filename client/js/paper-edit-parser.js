/**
 * paper-edit-parser.js — Parses the paper edit text file into structured entries.
 * Port of PaperEditor.py's parse_paper_edit() and related regex.
 */

var PaperEditParser = (function () {
    "use strict";

    var TC_REGEX       = /(\d{1,2}:\d{2}(?::\d{2})?(?::\d{2})?)/;
    var REVEAL_REGEX   = /^Reveal\s*[-\u2013\u2014]?\s*(.+)$/i;
    var LEADERBOARD_REVEAL_REGEX = /^Leaderboard\s+reveal\b/i;
    var URL_REGEX      = /^(https?:\/\/\S+)(.*)$/;

    /**
     * Extract a numeric score from a reveal line's text portion.
     * Returns 0.0, 0.5, 1.0, or null for non-scoring reveals.
     */
    function parseRevealScore(revealText) {
        var text = revealText.trim();
        var lower = text.toLowerCase();

        // Non-scoring
        if (lower.indexOf("no score") >= 0 || lower.indexOf("leaderboard") >= 0) return null;

        // Half-point
        if (text.indexOf("\u00bd") >= 0 || lower.indexOf("1/2") >= 0 || lower.indexOf("half") >= 0) return 0.5;

        // Digit
        var m = text.match(/(\d+)/);
        if (m) return parseFloat(m[1]);

        return null;
    }

    /**
     * Parse paper edit text into an array of entry objects.
     * Entry types: "clip", "reveal", "link", "endcard"
     */
    function parse(text) {
        var lines = text.split(/\r?\n/);
        var entries = [];
        var currTC = null;
        var currBracket = null;
        var buf = [];

        for (var i = 0; i < lines.length; i++) {
            var stripped = lines[i].trim();
            if (!stripped) continue;

            // Leaderboard reveal
            if (LEADERBOARD_REVEAL_REGEX.test(stripped)) {
                if (currTC && buf.length) {
                    entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
                    currTC = null; currBracket = null; buf = [];
                }
                entries.push({ type: "reveal", text: stripped, score: null });
                continue;
            }

            // Reveal
            var revealMatch = stripped.match(REVEAL_REGEX);
            if (revealMatch) {
                if (currTC && buf.length) {
                    entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
                    currTC = null; currBracket = null; buf = [];
                }
                var score = parseRevealScore(revealMatch[1]);
                entries.push({ type: "reveal", text: stripped, score: score });
                continue;
            }

            // End card
            if (stripped.toLowerCase() === "end card") {
                if (currTC && buf.length) {
                    entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
                    currTC = null; currBracket = null; buf = [];
                }
                entries.push({ type: "endcard", text: "End Card" });
                continue;
            }

            // URL
            var urlMatch = stripped.match(URL_REGEX);
            if (urlMatch) {
                if (currTC && buf.length) {
                    entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
                    currTC = null; currBracket = null; buf = [];
                }
                entries.push({ type: "link", text: stripped });
                continue;
            }

            // Timecode line
            var tcMatch = stripped.match(new RegExp("^" + TC_REGEX.source));
            if (tcMatch) {
                if (currTC && buf.length) {
                    entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
                }
                currTC = tcMatch[1];
                var remainder = stripped.substring(tcMatch[0].length).trim();

                var bracketMatch = remainder.match(/\[(.+?)\]/);
                currBracket = bracketMatch ? bracketMatch[1] : null;
                if (bracketMatch) {
                    remainder = (remainder.substring(0, bracketMatch.index).trim() + " " +
                                 remainder.substring(bracketMatch.index + bracketMatch[0].length).trim()).trim();
                }

                buf = remainder ? [remainder] : [];
                continue;
            }

            // Continuation line
            if (currTC !== null) {
                buf.push(stripped);
            }
        }

        // Flush last entry
        if (currTC && buf.length) {
            entries.push({ type: "clip", tc: currTC, text: buf.join(" "), bracketNote: currBracket });
        }

        return entries;
    }

    /**
     * Parse a timecode string (e.g. "1:23", "0:12:45", or "0:12:45:12" HH:MM:SS:FF) into seconds.
     * For 4-part (HH:MM:SS:FF), frames are converted using 24fps if no fps given.
     */
    function tcToSeconds(tc, fps) {
        var parts = tc.split(":");
        if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
        if (parts.length === 4) {
            var h = parseInt(parts[0], 10) || 0;
            var m = parseInt(parts[1], 10) || 0;
            var s = parseInt(parts[2], 10) || 0;
            var f = parseInt(parts[3], 10) || 0;
            fps = fps || 24;
            return h * 3600 + m * 60 + s + (f / fps);
        }
        return 0;
    }

    return {
        parse: parse,
        parseRevealScore: parseRevealScore,
        tcToSeconds: tcToSeconds
    };
})();
