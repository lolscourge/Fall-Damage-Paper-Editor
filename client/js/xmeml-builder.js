/**
 * xmeml-builder.js — Generates Premiere Pro XMEML (XML) sequence files.
 * Port of PaperEditor.py's XML generation logic.
 */

var XMEMLBuilder = (function () {
    "use strict";

    var pathMod = require("path");
    var IS_WIN = (typeof process !== "undefined") && process.platform === "win32";

    // Shared with hearts.js and name-mogrt.js — single source of truth
    var TICKS_PER_SECOND = 254016000000;

    // ── XML Helper ──

    function esc(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function tag(name, content, attrs) {
        var attrStr = "";
        if (attrs) {
            for (var k in attrs) {
                if (attrs.hasOwnProperty(k)) attrStr += " " + k + '="' + esc(attrs[k]) + '"';
            }
        }
        if (content === undefined || content === null) {
            return "<" + name + attrStr + " />";
        }
        return "<" + name + attrStr + ">" + content + "</" + name + ">";
    }

    // ── Path URL ──

    function pctEncode(c) {
        var h = c.charCodeAt(0).toString(16).toUpperCase();
        return "%" + (h.length < 2 ? "0" + h : h);
    }

    // Encode a single path segment (never encodes slashes or Windows drive colon).
    function encodeSegment(seg) {
        return seg.replace(/[^A-Za-z0-9\-._~!$'()*+,;=@]/g, pctEncode);
    }

    function getPathUrl(filePath) {
        var absPath = filePath.replace(/\\/g, "/");
        var parts = absPath.split("/");
        var encoded = parts.map(function (seg, i) {
            // Keep Windows drive letter (e.g. "C:") unencoded
            if (IS_WIN && i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
            return encodeSegment(seg);
        });
        var encodedPath = encoded.join("/");
        // Premiere Pro FCP XML style (file://localhost/...). Windows: C:/... ; Mac: /Volumes/... or /Users/...
        if (IS_WIN) return "file://localhost/" + encodedPath;
        return "file://localhost" + (encodedPath.indexOf("/") === 0 ? encodedPath : "/" + encodedPath);
    }

    // ── Stable file ID from full path (avoids basename collisions) ──

    function pathHash(p) {
        var h = 0;
        for (var i = 0; i < p.length; i++) {
            h = ((h << 5) - h + p.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(16).slice(-8);
    }

    function makeFileId(prefix, filePath) {
        var name = pathMod.basename(filePath).replace(/[^a-zA-Z0-9]/g, "-").slice(0, 24);
        return prefix + pathHash(filePath) + "-" + name;
    }

    // ── Rate node ──

    function rateXML(fpsStr) {
        var fps = parseFloat(fpsStr);
        var isNTSC = [23.976, 29.97, 59.94].some(function (std) { return Math.abs(fps - std) < 0.02; });
        return tag("rate",
            tag("timebase", String(Math.round(fps))) +
            tag("ntsc", isNTSC ? "TRUE" : "FALSE")
        );
    }

    // ── Build full XMEML ──

    /**
     * Build the complete XMEML document.
     *
     * @param {Object} opts
     * @param {Array} opts.entries           - parsed paper edit entries
     * @param {number} opts.numCams          - number of cameras
     * @param {Object} opts.videoInfo        - { width, height, durationFrames }
     * @param {string} opts.fpsVal           - FPS as string
     * @param {number} opts.padFrames        - padding in frames
     * @param {number} opts.gapFrames        - gap duration in frames
     * @param {boolean} opts.hasExtAudio     - has external audio
     * @param {number} opts.extAudioChannels - external audio channel count
     * @param {boolean} opts.hasQuoteCards   - has quote cards
     * @param {boolean} opts.hasScoringReveals - has scoring reveals (for hearts tracks)
     * @param {Array} opts.clipPlacements    - pre-computed clip placements from main.js
     * @param {string} [opts.leaderboardMovPath]          - path to rendered leaderboard .mov (alpha)
     * @param {number} [opts.leaderboardMovDurationFrames] - duration of leaderboard .mov in frames
     * @param {boolean} [opts.leaderboardMovPlaceInEndBlockOnly] - if true, do not place LB .mov in main sequence (end block will add it)
     * @param {string} [opts.leaderboardGridPngPath]      - path to leaderboard grid PNG (alpha)
     *
     * @returns {string} Full XMEML XML string
     */
    function build(opts) {
        var fpsVal = opts.fpsVal;
        var fpsF = parseFloat(fpsVal);
        var numCams = opts.numCams;
        var vidW = opts.videoInfo.width;
        var vidH = opts.videoInfo.height;

        var xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n';
        xml += '<xmeml version="4">\n';
        xml += '<sequence id="sequence-1">\n';
        xml += tag("name", "WHISPER_EDIT") + "\n";
        xml += tag("duration", "0") + "\n"; // Will be updated
        xml += rateXML(fpsVal) + "\n";

        // Timecode
        xml += "<timecode>\n" + rateXML(fpsVal) + "\n";
        xml += tag("string", "00:00:00:00") + "\n";
        xml += tag("frame", "0") + "\n";
        xml += tag("displayformat", "NDF") + "\n";
        xml += "</timecode>\n";

        // Media
        xml += "<media>\n";

        // Video section
        xml += "<video>\n";
        xml += "<format>\n<samplecharacteristics>\n" + rateXML(fpsVal) + "\n";
        xml += tag("width", String(vidW)) + "\n";
        xml += tag("height", String(vidH)) + "\n";
        xml += tag("anamorphic", "FALSE") + "\n";
        xml += tag("pixelaspectratio", "square") + "\n";
        xml += tag("fielddominance", "none") + "\n";
        xml += "</samplecharacteristics>\n</format>\n";

        /*
         * Video track layout (bottom-to-top):
         *   V0 … V(numCams-1)               camera tracks
         *   V(numCams+0)  bg_overlay         END CARD_nologo (intro + per-QC), END CARD 2 (end)
         *   V(numCams+1)  title_card         QUOTES_Title Card.mov (intro)
         *   V(numCams+2)  name_mogrt         placeholder — Name.mogrt placed via importMGT post-import
         *   V(numCams+3)  leaderboard        PNG or .mov — conditional (hasLeaderboard)
         *   …+ytTrackOffset  ytclips         YouTube trim clips — conditional (hasYouTubeClips)
         *   …+qcTrackOffset  qcards          quote card PNGs — conditional (hasQuoteCards)
         *                text               text overlays (always present)
         *   top+0  hearts_top              } hearts MOGRT placeholders — conditional (hasScoringReveals)
         *   top+1  hearts_bot              }
         *   top+2  sparkles                }
         *
         * overlayTrackOffset starts at 3 (bg+title+name) and increments for each optional track.
         */

        // Video tracks: V1..VN for cameras
        var videoTrackTags = [];
        for (var c = 0; c < numCams; c++) {
            videoTrackTags.push({ tag: "track", id: "cam" + c, clips: [] });
        }

        // Overlay tracks (always present — above cameras, below YT/QC/text)
        // bg_overlay: END CARD_nologo (intro + per-QC) and END CARD 2 (end)
        videoTrackTags.push({ tag: "track", id: "bg_overlay", clips: [] });
        // title_card: QUOTES_Title Card.mov (intro only)
        videoTrackTags.push({ tag: "track", id: "title_card", clips: [] });
        // name_mogrt: placeholder for Name.mogrt (placed via importMGT post-import)
        videoTrackTags.push({ tag: "track", id: "name_mogrt", clips: [] });

        var overlayTrackOffset = 3; // bg_overlay + title_card + name_mogrt

        // Track indices for the overlay tracks
        var bgOverlayIdx = numCams;
        var titleCardIdx = numCams + 1;
        var nameMogrtIdx = numCams + 2;

        // Leaderboard track (above name_mogrt, below YT clips — conditional)
        var hasLBMov  = !!(opts.leaderboardMovPath && opts.leaderboardMovDurationFrames);
        var hasLBGrid = !!opts.leaderboardGridPngPath;
        var lbMovInEndBlockOnly = !!opts.leaderboardMovPlaceInEndBlockOnly;
        var hasLeaderboard = (hasLBMov && !lbMovInEndBlockOnly) || hasLBGrid;
        var lbTrackIdx = -1;
        if (hasLeaderboard) {
            lbTrackIdx = numCams + overlayTrackOffset;
            videoTrackTags.push({ tag: "track", id: "leaderboard", clips: [] });
            overlayTrackOffset++;
        }

        // YouTube clips track (above overlay tracks, below QC overlay)
        var hasYT = !!opts.hasYouTubeClips;
        if (hasYT) {
            videoTrackTags.push({ tag: "track", id: "ytclips", clips: [] });
        }

        // Quote card overlay track (above YT clips)
        if (opts.hasQuoteCards) {
            videoTrackTags.push({ tag: "track", id: "qcards", clips: [] });
        }

        // Track index helpers (account for overlay + optional YT and QC tracks)
        var ytTrackOffset = hasYT ? 1 : 0;
        var qcTrackOffset = opts.hasQuoteCards ? 1 : 0;
        // textIdx = numCams + overlayTrackOffset + ytTrackOffset + qcTrackOffset

        // Text track
        videoTrackTags.push({
            tag: "track", id: "text", clips: [],
            extra: tag("locked", "FALSE") + tag("enabled", "TRUE")
        });

        // Hearts tracks (empty placeholders for importMGT)
        var heartsTopIdx = -1, heartsBotIdx = -1, sparklesIdx = -1;
        if (opts.hasScoringReveals) {
            heartsTopIdx = videoTrackTags.length;
            videoTrackTags.push({ tag: "track", id: "hearts_top", clips: [] });
            heartsBotIdx = videoTrackTags.length;
            videoTrackTags.push({ tag: "track", id: "hearts_bot", clips: [] });
            sparklesIdx = videoTrackTags.length;
            videoTrackTags.push({ tag: "track", id: "sparkles", clips: [] });
        }

        // Process placements
        var currTL = 0;
        var clipCounter = 1;
        var genCounter = 1;
        var qcClipCounter = 10000;
        var ytClipCounter = 20000;
        var overlayClipCounter = 30000;
        var fileDefs = {};
        var heartsRevealData = [];
        var pendingYTClip = null; // deferred YT clip to place under the next REVEAL
        var introData = null; // populated if an intro clip is detected
        var leaderboardRevealCount = 0; // counts "Leaderboard reveal" entries
        var lbClipCounter = 40000;
        var endLbRevealFrame = -1; // frame position of the 2nd leaderboard reveal (-1 if none)

        // Audio clips built by build() with correct timeline positions
        // audioTrackClips[camIdx] = { track1: [...], track2: [...] }
        var audioTrackClips = {};
        for (var c = 0; c < numCams; c++) {
            audioTrackClips[c] = { track1: [], track2: [] };
        }
        var extAudioTrack1Clips = [];
        var extAudioTrack2Clips = [];
        var ytAudioTrack1Clips = [];
        var ytAudioTrack2Clips = [];

        var placements = opts.clipPlacements || [];

        for (var p = 0; p < placements.length; p++) {
            var pl = placements[p];

            if (pl.type === "clip" && pl.matched) {
                // Place clips for each camera — build video + audio with correct currTL
                for (var ci = 0; ci < pl.cameras.length; ci++) {
                    var cam = pl.cameras[ci];
                    var clipXML = buildClipXML(cam, currTL, fpsVal, fpsF, clipCounter, fileDefs, opts.padFrames);
                    videoTrackTags[ci].clips.push(clipXML.videoClip);

                    // Store audio clips with correct timeline position
                    if (clipXML.audioClips && clipXML.audioClips.length >= 2) {
                        audioTrackClips[ci].track1.push(clipXML.audioClips[0]);
                        audioTrackClips[ci].track2.push(clipXML.audioClips[1]);
                    }

                    clipCounter = clipXML.nextCounter;
                }

                // External audio clips — rebuild with correct currTL
                if (pl.extAudioClips && pl.extAudioClips.length > 0) {
                    // The ext audio clips were pre-built with currTL=0,
                    // so we patch the start/end tags to use the real currTL
                    for (var ea = 0; ea < pl.extAudioClips.length; ea++) {
                        var fixedClip = pl.extAudioClips[ea]
                            .replace(/<start>0<\/start>/, "<start>" + currTL + "</start>")
                            .replace(/<end>(\d+)<\/end>/, "<end>" + (currTL + pl.duration) + "</end>");
                        extAudioTrack1Clips.push(fixedClip);
                    }
                }
                if (pl.extAudioClips2 && pl.extAudioClips2.length > 0) {
                    for (var ea = 0; ea < pl.extAudioClips2.length; ea++) {
                        var fixedClip = pl.extAudioClips2[ea]
                            .replace(/<start>0<\/start>/, "<start>" + currTL + "</start>")
                            .replace(/<end>(\d+)<\/end>/, "<end>" + (currTL + pl.duration) + "</end>");
                        extAudioTrack2Clips.push(fixedClip);
                    }
                }

                // YouTube clip — defer to the next REVEAL (not placed under the quote card)
                if (hasYT && pl.quoteCard && pl.quoteCard.ytClipPath) {
                    pendingYTClip = {
                        path: pl.quoteCard.ytClipPath,
                        durationFrames: pl.quoteCard.ytDurationFrames || null
                    };
                }

                // Quote card PNG overlay (above YT clips)
                if (pl.quoteCard && opts.hasQuoteCards) {
                    var qcTrackIdx = numCams + overlayTrackOffset + ytTrackOffset;
                    qcClipCounter++;
                    var qcXML = buildImageClipXML(pl.quoteCard.pngPath, currTL, pl.duration, fpsVal, qcClipCounter, fileDefs);
                    videoTrackTags[qcTrackIdx].clips.push(qcXML);

                    // Place END CARD_nologo underneath each quote card on bg_overlay track
                    if (opts.endCardNoLogoPath) {
                        overlayClipCounter++;
                        var ecnXML = buildVideoClipXML(opts.endCardNoLogoPath, currTL, pl.duration, fpsVal, fpsF, overlayClipCounter, fileDefs);
                        videoTrackTags[bgOverlayIdx].clips.push(ecnXML);
                    }
                }

                // Intro stack: END CARD_nologo + QUOTES_Title Card on overlay tracks
                if (pl.isIntro) {
                    introData = { tlStartFrame: currTL, durationFrames: pl.duration };

                    // Only place END CARD_nologo if not already placed by the QC handler above
                    if (opts.endCardNoLogoPath && !(pl.quoteCard && opts.hasQuoteCards)) {
                        overlayClipCounter++;
                        var introECN = buildVideoClipXML(opts.endCardNoLogoPath, currTL, pl.duration, fpsVal, fpsF, overlayClipCounter, fileDefs);
                        videoTrackTags[bgOverlayIdx].clips.push(introECN);
                    }
                    if (opts.titleCardPath) {
                        overlayClipCounter++;
                        var introTC = buildVideoClipXML(opts.titleCardPath, currTL, pl.duration, fpsVal, fpsF, overlayClipCounter, fileDefs);
                        videoTrackTags[titleCardIdx].clips.push(introTC);
                    }
                }

                currTL += pl.duration;

            } else if (pl.type === "clip" && !pl.matched) {
                // No match — text generator
                var textIdx = numCams + overlayTrackOffset + ytTrackOffset + qcTrackOffset;
                var genXML = buildTextGenerator(pl.displayText, currTL, opts.gapFrames, fpsVal, genCounter);
                videoTrackTags[textIdx].clips.push(genXML);
                genCounter++;
                currTL += opts.gapFrames;

            } else if (pl.type === "reveal") {
                // Check if this is a leaderboard reveal
                var isLBReveal = /^Leaderboard\s+reveal/i.test(pl.text);
                if (isLBReveal) leaderboardRevealCount++;

                // Place deferred YouTube clip at this reveal position
                var thisRevealYTDur = 0; // duration of the YT clip placed at this reveal
                if (hasYT && pendingYTClip) {
                    var ytIdx = numCams + overlayTrackOffset; // YT track is after overlay tracks
                    ytClipCounter++;
                    thisRevealYTDur = pendingYTClip.durationFrames || opts.gapFrames;
                    var ytXML = buildVideoClipXML(pendingYTClip.path, currTL, thisRevealYTDur, fpsVal, fpsF, ytClipCounter, fileDefs);
                    videoTrackTags[ytIdx].clips.push(ytXML);

                    // Build audio clips for the YT video (stereo — 2 tracks)
                    // Must use the same fileId as the video clipitem above so Premiere
                    // links both to the same source file.
                    var ytFName = pathMod.basename(pendingYTClip.path);
                    var ytFId = makeFileId("file-v-", pendingYTClip.path);
                    for (var ytAT = 1; ytAT <= 2; ytAT++) {
                        ytClipCounter++;
                        var ytAC = '<clipitem id="clipitem-' + ytClipCounter + '">\n';
                        ytAC += tag("name", esc(ytFName)) + "\n";
                        ytAC += tag("duration", String(thisRevealYTDur)) + "\n";
                        ytAC += rateXML(fpsVal) + "\n";
                        ytAC += tag("start", String(currTL)) + "\n";
                        ytAC += tag("end", String(currTL + thisRevealYTDur)) + "\n";
                        ytAC += tag("in", "0") + "\n";
                        ytAC += tag("out", String(thisRevealYTDur)) + "\n";
                        ytAC += '<file id="' + esc(ytFId) + '" />\n';
                        ytAC += "<sourcetrack>\n";
                        ytAC += tag("mediatype", "audio") + "\n";
                        ytAC += tag("trackindex", String(ytAT)) + "\n";
                        ytAC += "</sourcetrack>\n";
                        ytAC += "</clipitem>";
                        if (ytAT === 1) ytAudioTrack1Clips.push(ytAC);
                        else ytAudioTrack2Clips.push(ytAC);
                    }

                    pendingYTClip = null;
                }

                // Place leaderboard grid PNG at the first leaderboard reveal
                var thisRevealLBDur = 0;
                if (hasLBGrid && isLBReveal && leaderboardRevealCount === 1) {
                    lbClipCounter++;
                    thisRevealLBDur = opts.gapFrames;
                    var lbGridXML = buildImageClipXML(
                        opts.leaderboardGridPngPath, currTL, thisRevealLBDur,
                        fpsVal, lbClipCounter, fileDefs, 1920, 1080
                    );
                    videoTrackTags[lbTrackIdx].clips.push(lbGridXML);
                }

                // Record the second leaderboard reveal frame for the end leaderboard JSX
                if (isLBReveal && leaderboardRevealCount === 2) {
                    endLbRevealFrame = currTL;
                }

                // Place leaderboard .mov at the second leaderboard reveal
                // (Skip when end-leaderboard block will add it, to avoid duplicate clip.)
                var lbMovInEndBlockOnly = !!opts.leaderboardMovPlaceInEndBlockOnly;
                if (hasLBMov && isLBReveal && leaderboardRevealCount === 2 && !lbMovInEndBlockOnly) {
                    lbClipCounter++;
                    thisRevealLBDur = opts.leaderboardMovDurationFrames;
                    var lbXML = buildVideoClipXML(
                        opts.leaderboardMovPath, currTL, thisRevealLBDur,
                        fpsVal, fpsF, lbClipCounter, fileDefs, "straight"
                    );
                    videoTrackTags[lbTrackIdx].clips.push(lbXML);
                }

                // Reveal text generator — use longest overlay duration, else gapFrames
                var revealDur = Math.max(thisRevealYTDur, thisRevealLBDur);
                if (revealDur === 0) revealDur = opts.gapFrames;
                var textIdx = numCams + overlayTrackOffset + ytTrackOffset + qcTrackOffset;
                var genXML = buildTextGenerator(pl.text, currTL, revealDur, fpsVal, genCounter);
                videoTrackTags[textIdx].clips.push(genXML);
                if (pl.score !== null && pl.score !== undefined) {
                    heartsRevealData.push({ frame: currTL, score: pl.score, gapFrames: revealDur });
                }
                genCounter++;
                currTL += revealDur;

            } else if (pl.type === "link") {
                var textIdx = numCams + overlayTrackOffset + ytTrackOffset + qcTrackOffset;
                var genXML = buildTextGenerator("LINK: " + pl.text, currTL, opts.gapFrames, fpsVal, genCounter);
                videoTrackTags[textIdx].clips.push(genXML);
                genCounter++;
                currTL += opts.gapFrames;

            } else if (pl.type === "endcard") {
                var textIdx = numCams + overlayTrackOffset + ytTrackOffset + qcTrackOffset;
                var endcardDur = opts.gapFrames;
                var genXML = buildTextGenerator("END CARD", currTL, endcardDur, fpsVal, genCounter);
                videoTrackTags[textIdx].clips.push(genXML);

                // Place END CARD 2 on bg_overlay track
                if (opts.endCard2Path) {
                    overlayClipCounter++;
                    var ec2XML = buildVideoClipXML(opts.endCard2Path, currTL, endcardDur, fpsVal, fpsF, overlayClipCounter, fileDefs);
                    videoTrackTags[bgOverlayIdx].clips.push(ec2XML);
                }

                genCounter++;
                currTL += endcardDur;
            }
        }

        // Write video tracks
        for (var t = 0; t < videoTrackTags.length; t++) {
            xml += "<track>\n";
            if (videoTrackTags[t].extra) xml += videoTrackTags[t].extra + "\n";
            xml += videoTrackTags[t].clips.join("\n");
            xml += "\n</track>\n";
        }

        xml += "</video>\n";

        // Audio section
        xml += "<audio>\n";
        xml += "<format>\n<samplecharacteristics>\n";
        xml += tag("depth", "16") + "\n";
        xml += tag("samplerate", "48000") + "\n";
        xml += "</samplecharacteristics>\n</format>\n";

        // External audio tracks (using correctly-positioned clips from build loop)
        if (opts.hasExtAudio) {
            xml += "<track>\n";
            for (var ea = 0; ea < extAudioTrack1Clips.length; ea++) {
                xml += extAudioTrack1Clips[ea] + "\n";
            }
            xml += "</track>\n";
            if (opts.extAudioChannels >= 2) {
                xml += "<track>\n";
                for (var ea = 0; ea < extAudioTrack2Clips.length; ea++) {
                    xml += extAudioTrack2Clips[ea] + "\n";
                }
                xml += "</track>\n";
            }
        }

        // Camera audio tracks (2 per camera, using correctly-positioned clips from build loop)
        for (var ci = 0; ci < numCams; ci++) {
            xml += "<track>\n";
            for (var a = 0; a < audioTrackClips[ci].track1.length; a++) {
                xml += audioTrackClips[ci].track1[a] + "\n";
            }
            xml += "</track>\n";
            xml += "<track>\n";
            for (var a = 0; a < audioTrackClips[ci].track2.length; a++) {
                xml += audioTrackClips[ci].track2[a] + "\n";
            }
            xml += "</track>\n";
        }

        // YouTube audio tracks (stereo — 2 tracks)
        if (hasYT && ytAudioTrack1Clips.length > 0) {
            xml += "<track>\n";
            for (var ya = 0; ya < ytAudioTrack1Clips.length; ya++) {
                xml += ytAudioTrack1Clips[ya] + "\n";
            }
            xml += "</track>\n";
            xml += "<track>\n";
            for (var ya = 0; ya < ytAudioTrack2Clips.length; ya++) {
                xml += ytAudioTrack2Clips[ya] + "\n";
            }
            xml += "</track>\n";
        }

        xml += "</audio>\n";
        xml += "</media>\n";

        // Update duration
        xml = xml.replace(/<duration>0<\/duration>/, tag("duration", String(currTL)));

        xml += "</sequence>\n";
        xml += "</xmeml>\n";

        return {
            xml: xml,
            heartsRevealData: heartsRevealData,
            totalFrames: currTL,
            introData: introData,
            nameMogrtTrackIdx: nameMogrtIdx,
            heartsTopTrackIdx: heartsTopIdx,
            heartsBotTrackIdx: heartsBotIdx,
            sparklesTrackIdx: sparklesIdx,
            endLbRevealFrame: endLbRevealFrame
        };
    }

    // ── Clip XML builders ──

    function buildClipXML(cam, currTL, fpsVal, fpsF, clipCounter, fileDefs, padFrames) {
        var fileName = cam.fileName;
        var fileId = cam.fileId;
        var filePath = cam.filePath;
        var inF = cam.inFrame;
        var outF = cam.outFrame;
        var vidInfo = cam.videoInfo || {};

        var inFAdj = Math.max(0, inF - padFrames);
        var dur = (outF + padFrames) - inFAdj;
        var outFAdj = inFAdj + dur;

        var videoClip = '<clipitem id="clipitem-' + clipCounter + '">\n';
        videoClip += tag("name", esc(fileName)) + "\n";
        videoClip += tag("duration", String(dur)) + "\n";
        videoClip += rateXML(fpsVal) + "\n";
        videoClip += tag("start", String(currTL)) + "\n";
        videoClip += tag("end", String(currTL + dur)) + "\n";
        videoClip += tag("in", String(inFAdj)) + "\n";
        videoClip += tag("out", String(outFAdj)) + "\n";
        videoClip += tag("alphatype", "none") + "\n";
        videoClip += tag("anamorphic", "FALSE") + "\n";

        if (!fileDefs[fileId]) {
            videoClip += '<file id="' + esc(fileId) + '">\n';
            videoClip += tag("name", esc(fileName)) + "\n";
            videoClip += tag("pathurl", esc(getPathUrl(filePath))) + "\n";
            videoClip += rateXML(fpsVal) + "\n";

            var actualDur = vidInfo.durationFrames || (outFAdj + Math.round(fpsF * 60));
            videoClip += tag("duration", String(actualDur)) + "\n";

            videoClip += "<timecode>\n" + rateXML(fpsVal) + "\n";
            videoClip += tag("string", "00:00:00:00") + "\n";
            videoClip += tag("frame", "0") + "\n";
            videoClip += tag("displayformat", "NDF") + "\n";
            videoClip += "</timecode>\n";

            videoClip += "<media>\n<video>\n<samplecharacteristics>\n";
            videoClip += rateXML(fpsVal) + "\n";
            videoClip += tag("width", String(vidInfo.width || 1920)) + "\n";
            videoClip += tag("height", String(vidInfo.height || 1080)) + "\n";
            videoClip += tag("anamorphic", "FALSE") + "\n";
            videoClip += tag("pixelaspectratio", "square") + "\n";
            videoClip += tag("fielddominance", "none") + "\n";
            videoClip += "</samplecharacteristics>\n</video>\n";
            videoClip += "<audio>\n<samplecharacteristics>\n";
            videoClip += tag("depth", "16") + "\n";
            videoClip += tag("samplerate", "48000") + "\n";
            videoClip += "</samplecharacteristics>\n";
            videoClip += tag("channelcount", "2") + "\n";
            videoClip += "</audio>\n</media>\n";
            videoClip += "</file>\n";
            fileDefs[fileId] = true;
        } else {
            videoClip += '<file id="' + esc(fileId) + '" />\n';
        }

        videoClip += "</clipitem>";

        // Audio clips (2 tracks)
        var audioClips = [];
        for (var t = 1; t <= 2; t++) {
            var ac = '<clipitem id="clipitem-' + (clipCounter + t) + '">\n';
            ac += tag("name", esc(fileName)) + "\n";
            ac += tag("duration", String(dur)) + "\n";
            ac += rateXML(fpsVal) + "\n";
            ac += tag("start", String(currTL)) + "\n";
            ac += tag("end", String(currTL + dur)) + "\n";
            ac += tag("in", String(inFAdj)) + "\n";
            ac += tag("out", String(outFAdj)) + "\n";
            ac += '<file id="' + esc(fileId) + '" />\n';
            ac += "<sourcetrack>\n";
            ac += tag("mediatype", "audio") + "\n";
            ac += tag("trackindex", String(t)) + "\n";
            ac += "</sourcetrack>\n";
            ac += "</clipitem>";
            audioClips.push(ac);
        }

        return {
            videoClip: videoClip,
            audioClips: audioClips,
            duration: dur,
            nextCounter: clipCounter + 3
        };
    }

    function buildTextGenerator(displayText, currTL, gapFrames, fpsVal, genCounter) {
        var xml = '<generatoritem id="generatoritem-' + genCounter + '">\n';
        xml += tag("name", esc(displayText.substring(0, 50))) + "\n";
        xml += tag("duration", String(gapFrames)) + "\n";
        xml += rateXML(fpsVal) + "\n";
        xml += tag("start", String(currTL)) + "\n";
        xml += tag("end", String(currTL + gapFrames)) + "\n";
        xml += tag("in", "0") + "\n";
        xml += tag("out", String(gapFrames)) + "\n";
        xml += tag("anamorphic", "FALSE") + "\n";
        xml += tag("alphatype", "none") + "\n";
        xml += "<labels>\n" + tag("label2", "Rose") + "\n</labels>\n";
        xml += "<effect>\n";
        xml += tag("name", "Text") + "\n";
        xml += tag("effectid", "Text") + "\n";
        xml += tag("effectcategory", "Text") + "\n";
        xml += tag("effecttype", "generator") + "\n";
        xml += tag("mediatype", "video") + "\n";
        xml += '<parameter authoringApp="PremierePro">\n';
        xml += tag("parameterid", "str") + "\n";
        xml += tag("name", "Text") + "\n";
        xml += tag("value", esc(displayText)) + "\n";
        xml += "</parameter>\n";
        xml += '<parameter authoringApp="PremierePro">\n';
        xml += tag("parameterid", "fontsize") + "\n";
        xml += tag("name", "Font Size") + "\n";
        xml += tag("value", "42") + "\n";
        xml += "</parameter>\n";
        xml += "</effect>\n";
        xml += "</generatoritem>";
        return xml;
    }

    function buildImageClipXML(imagePath, currTL, durationFrames, fpsVal, clipCounter, fileDefs, imgWidth, imgHeight) {
        var fileName = pathMod.basename(imagePath);
        var fileId = makeFileId("file-img-", imagePath);

        var xml = '<clipitem id="clipitem-' + clipCounter + '">\n';
        xml += tag("name", esc(fileName)) + "\n";
        xml += tag("duration", String(durationFrames)) + "\n";
        xml += rateXML(fpsVal) + "\n";
        xml += tag("start", String(currTL)) + "\n";
        xml += tag("end", String(currTL + durationFrames)) + "\n";
        xml += tag("in", "0") + "\n";
        xml += tag("out", String(durationFrames)) + "\n";
        xml += tag("alphatype", "straight") + "\n";
        xml += tag("anamorphic", "FALSE") + "\n";

        if (!fileDefs[fileId]) {
            xml += '<file id="' + esc(fileId) + '">\n';
            xml += tag("name", esc(fileName)) + "\n";
            xml += tag("pathurl", esc(getPathUrl(imagePath))) + "\n";
            xml += rateXML(fpsVal) + "\n";
            xml += tag("duration", String(durationFrames)) + "\n";
            xml += "<media>\n<video>\n<samplecharacteristics>\n";
            xml += rateXML(fpsVal) + "\n";
            xml += tag("width", String(imgWidth || 2067)) + "\n";
            xml += tag("height", String(imgHeight || 1393)) + "\n";
            xml += tag("anamorphic", "FALSE") + "\n";
            xml += tag("pixelaspectratio", "square") + "\n";
            xml += tag("fielddominance", "none") + "\n";
            xml += "</samplecharacteristics>\n</video>\n</media>\n";
            xml += "</file>\n";
            fileDefs[fileId] = true;
        } else {
            xml += '<file id="' + esc(fileId) + '" />\n';
        }

        xml += "</clipitem>";
        return xml;
    }

    /**
     * Build a video-only clipitem for a video file (YouTube MP4, leaderboard MOV, etc).
     * @param {string} [alphaType="none"] - Alpha type: "none" or "straight"
     */
    function buildVideoClipXML(videoPath, currTL, durationFrames, fpsVal, fpsF, clipCounter, fileDefs, alphaType) {
        var fileName = pathMod.basename(videoPath);
        var fileId = makeFileId("file-v-", videoPath);

        var xml = '<clipitem id="clipitem-' + clipCounter + '">\n';
        xml += tag("name", esc(fileName)) + "\n";
        xml += tag("duration", String(durationFrames)) + "\n";
        xml += rateXML(fpsVal) + "\n";
        xml += tag("start", String(currTL)) + "\n";
        xml += tag("end", String(currTL + durationFrames)) + "\n";
        xml += tag("in", "0") + "\n";
        xml += tag("out", String(durationFrames)) + "\n";
        xml += tag("alphatype", alphaType || "none") + "\n";
        xml += tag("anamorphic", "FALSE") + "\n";

        if (!fileDefs[fileId]) {
            xml += '<file id="' + esc(fileId) + '">\n';
            xml += tag("name", esc(fileName)) + "\n";
            xml += tag("pathurl", esc(getPathUrl(videoPath))) + "\n";
            xml += rateXML(fpsVal) + "\n";
            xml += tag("duration", String(durationFrames)) + "\n";
            xml += "<media>\n<video>\n<samplecharacteristics>\n";
            xml += rateXML(fpsVal) + "\n";
            xml += tag("width", "1920") + "\n";
            xml += tag("height", "1080") + "\n";
            xml += tag("anamorphic", "FALSE") + "\n";
            xml += tag("pixelaspectratio", "square") + "\n";
            xml += tag("fielddominance", "none") + "\n";
            xml += "</samplecharacteristics>\n</video>\n";
            xml += "<audio>\n<samplecharacteristics>\n";
            xml += tag("depth", "16") + "\n";
            xml += tag("samplerate", "48000") + "\n";
            xml += "</samplecharacteristics>\n";
            xml += tag("channelcount", "2") + "\n";
            xml += "</audio>\n</media>\n";
            xml += "</file>\n";
            fileDefs[fileId] = true;
        } else {
            xml += '<file id="' + esc(fileId) + '" />\n';
        }

        xml += "</clipitem>";
        return xml;
    }

    function buildExtAudioClipXML(audioFilePath, audioFileId, currTL, timelineDur, inF, outF, fpsVal, clipCounter, fileDefs, audioChannels, trackIndex, fileDurationFrames) {
        var fileName = pathMod.basename(audioFilePath);
        var dur = outF - inF;

        var xml = '<clipitem id="clipitem-' + clipCounter + '">\n';
        xml += tag("name", esc(fileName)) + "\n";
        xml += tag("duration", String(dur)) + "\n";
        xml += rateXML(fpsVal) + "\n";
        xml += tag("start", String(currTL)) + "\n";
        xml += tag("end", String(currTL + timelineDur)) + "\n";
        xml += tag("in", String(inF)) + "\n";
        xml += tag("out", String(outF)) + "\n";

        if (!fileDefs[audioFileId]) {
            xml += '<file id="' + esc(audioFileId) + '">\n';
            xml += tag("name", esc(fileName)) + "\n";
            xml += tag("pathurl", esc(getPathUrl(audioFilePath))) + "\n";
            xml += rateXML(fpsVal) + "\n";
            // Use actual file duration when provided; fall back to a reasonable estimate
            var actualFileDur = fileDurationFrames || (outF + Math.round(parseFloat(fpsVal) * 60));
            xml += tag("duration", String(actualFileDur)) + "\n";
            xml += "<timecode>\n" + rateXML(fpsVal) + "\n";
            xml += tag("string", "00:00:00:00") + "\n";
            xml += tag("frame", "0") + "\n";
            xml += tag("displayformat", "NDF") + "\n";
            xml += "</timecode>\n";
            xml += "<media>\n<audio>\n<samplecharacteristics>\n";
            xml += tag("depth", "16") + "\n";
            xml += tag("samplerate", "48000") + "\n";
            xml += "</samplecharacteristics>\n";
            xml += tag("channelcount", String(audioChannels)) + "\n";
            xml += "</audio>\n</media>\n";
            xml += "</file>\n";
            fileDefs[audioFileId] = true;
        } else {
            xml += '<file id="' + esc(audioFileId) + '" />\n';
        }

        xml += "<sourcetrack>\n";
        xml += tag("mediatype", "audio") + "\n";
        xml += tag("trackindex", String(trackIndex)) + "\n";
        xml += "</sourcetrack>\n";
        xml += "</clipitem>";

        return xml;
    }

    return {
        TICKS_PER_SECOND: TICKS_PER_SECOND,
        build: build,
        getPathUrl: getPathUrl,
        rateXML: rateXML,
        buildClipXML: buildClipXML,
        buildTextGenerator: buildTextGenerator,
        buildImageClipXML: buildImageClipXML,
        buildVideoClipXML: buildVideoClipXML,
        buildExtAudioClipXML: buildExtAudioClipXML
    };
})();
