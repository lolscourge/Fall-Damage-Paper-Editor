/**
 * quote-cards.js — Quote card parsing, font sizing, wrapping, and Photoshop JSX generation.
 * Port of PaperEditor.py's quote card logic.
 */

/* global Processing */

var QuoteCards = (function () {
    "use strict";

    var pathMod = require("path");

    // ── YouTube link parsing ──

    // Supports MM:SS and HH:MM:SS timestamp formats
    var YT_LINK_REGEX = /^(https?:\/\/\S+)\s+(\d+:\d{2}(?::\d{2})?)-(\d+:\d{2}(?::\d{2})?)$/;

    /**
     * Parse a YouTube link line into { ytUrl, ytVideoId, ytStart, ytEnd }.
     * Returns null if the line isn't a recognised YouTube+timestamp format.
     */
    function parseYouTubeLink(linkStr) {
        if (!linkStr) return null;
        var m = linkStr.trim().match(YT_LINK_REGEX);
        if (!m) return null;

        var url = m[1];

        function parseTStamp(str) {
            var parts = str.split(":");
            if (parts.length === 3) {
                return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
            }
            return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }

        var startSec = parseTStamp(m[2]);
        var endSec   = parseTStamp(m[3]);

        // Extract video ID from youtu.be/ID or youtube.com/watch?v=ID
        var videoId = null;
        var idMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]+)/) ||
                      url.match(/[?&]v=([A-Za-z0-9_-]+)/);
        if (idMatch) videoId = idMatch[1];

        return { ytUrl: url, ytVideoId: videoId, ytStart: startSec, ytEnd: endSec };
    }

    // ── Parsing ──

    function parseQuoteEntries(text) {
        // Normalise line endings, then split on any blank line (1 or more)
        var blocks = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n[ \t]*\n/);
        var entries = [];

        for (var b = 0; b < blocks.length; b++) {
            var lines = blocks[b].trim().split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
            if (lines.length < 4) continue;

            var quote = lines[0];
            var hidden = lines[1];
            var scene, link, difficulty, cardType;

            if (lines.length >= 5) {
                scene = lines[2];
                link = lines[3];
                difficulty = parseInt(lines[4], 10);
                cardType = "wcn";
            } else {
                scene = hidden;
                link = lines[2];
                difficulty = parseInt(lines[3], 10);
                cardType = "wst";
            }

            // Extract YouTube URL and timestamps from link field
            var yt = parseYouTubeLink(link);

            var entry = {
                quote: quote,
                hidden: hidden,
                scene: scene,
                link: link,
                difficulty: Math.max(1, Math.min(5, difficulty)),
                cardType: cardType
            };

            if (yt) {
                entry.ytUrl = yt.ytUrl;
                entry.ytVideoId = yt.ytVideoId;
                entry.ytStart = yt.ytStart;
                entry.ytEnd = yt.ytEnd;
            }

            entries.push(entry);
        }

        return entries;
    }

    // ── Slug ──

    function sceneSlug(scene) {
        var slug = scene.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        return slug.substring(0, 40);
    }

    function getPngFilename(index, scene) {
        var idx = String(index);
        if (idx.length < 2) idx = "0" + idx;
        return idx + "_" + sceneSlug(scene) + ".png";
    }

    // ── Font Sizing ──

    var QC_PX_PER_CHAR_AT_82 = 76;

    function fitFontSize(text, boxW, boxH, refChars, refSize, minSize) {
        refSize = refSize || 82.0;
        minSize = minSize || 20.0;
        var n = text.length;
        if (n === 0 || n <= refChars) return refSize;
        var size = refSize * Math.sqrt(refChars / n);
        return Math.max(minSize, Math.round(size * 100) / 100);
    }

    function quoteFontSize(text, cardType) {
        if (cardType === "wst") {
            return fitFontSize(text, 1799, 400, 47, 90.0, 20.0);
        }
        return fitFontSize(text, 1713, 250, 47, 82.0, 20.0);
    }

    function hiddenFontSize(text, cardType) {
        if (cardType === "wst") {
            var n = text.length;
            var maxCharsAt82 = 484.0 / 76.0;
            if (n <= maxCharsAt82) return 82.0;
            var size = 82.0 * (maxCharsAt82 / n);
            return Math.max(18.0, Math.round(size * 100) / 100);
        }
        return fitFontSize(text, 1455, 100, 42, 50.0, 18.0);
    }

    // ── Line Wrapping ──

    function wrapText(text, fontSize, boxWidthPx) {
        var pxPerChar = 76.0 * (fontSize / 82.0);
        var charsPerLine = Math.max(1, Math.floor(boxWidthPx / pxPerChar));
        var words = text.split(" ");
        var lines = [], current = "";

        for (var i = 0; i < words.length; i++) {
            var test = (current + " " + words[i]).trim();
            if (test.length <= charsPerLine) {
                current = test;
            } else {
                if (current) lines.push(current);
                current = words[i];
            }
        }
        if (current) lines.push(current);
        return lines.join("\r");
    }

    function wrapQuote(text, fontSize, cardType) {
        var boxW = cardType === "wst" ? 1799 : 1713;
        return wrapText(text, fontSize, boxW);
    }

    function wrapHidden(text, fontSize, cardType) {
        if (cardType === "wst") return text;
        return wrapText(text, fontSize, 1455);
    }

    // ── JSX String Escaping ──

    function jsString(s) {
        var out = "";
        s = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\r");
        for (var i = 0; i < s.length; i++) {
            var code = s.charCodeAt(i);
            if (code > 127) {
                var hex = code.toString(16);
                while (hex.length < 4) hex = "0" + hex;
                out += "\\u" + hex;
            } else {
                out += s[i];
            }
        }
        return '"' + out + '"';
    }

    // ── Generate Photoshop JSX ──

    function generateQuoteJSX(entries, templatePSD, outputDir, psdBasename) {
        var templateJS = templatePSD.replace(/\\/g, "/").replace(/"/g, '\\"');
        var outputJS = outputDir.replace(/\\/g, "/").replace(/"/g, '\\"');
        psdBasename = (psdBasename || "QuoteCards").replace(/"/g, '\\"');

        var cardBlocks = [];
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var idx = i + 1;
            var slug = sceneSlug(entry.scene);
            var filename = getPngFilename(idx, entry.scene);
            var qSize = quoteFontSize(entry.quote, entry.cardType);
            var hSize = hiddenFontSize(entry.hidden, entry.cardType);
            var wrappedQuote = wrapQuote("\u201c" + entry.quote + "\u201d", qSize, entry.cardType);
            var wrappedHidden = wrapHidden(entry.hidden, hSize, entry.cardType);

            cardBlocks.push(
                '    // Card ' + idx + ': ' + entry.scene + '\n' +
                '    processCard(doc, {\n' +
                '        cardType: "' + entry.cardType + '",\n' +
                '        quote: ' + jsString(wrappedQuote) + ',\n' +
                '        hidden: ' + jsString(wrappedHidden) + ',\n' +
                '        difficulty: ' + entry.difficulty + ',\n' +
                '        quoteFontSize: ' + qSize + ',\n' +
                '        hiddenFontSize: ' + hSize + ',\n' +
                '        filename: "' + filename + '"\n' +
                '    });\n'
            );
        }

        // Full JSX (same as Python's generate_quote_jsx)
        var jsx = '#target photoshop\n\n';
        jsx += 'displayDialogs = DialogModes.NO;\n\n';
        jsx += 'var TEMPLATE_PATH = "' + templateJS + '";\n';
        jsx += 'var OUTPUT_DIR = "' + outputJS + '";\n\n';

        jsx += 'var outFolder = new Folder(OUTPUT_DIR);\n';
        jsx += 'if (!outFolder.exists) outFolder.create();\n\n';

        // Helper functions (same as original)
        jsx += 'function findLayer(parent, name) {\n';
        jsx += '    for (var i = 0; i < parent.layers.length; i++) {\n';
        jsx += '        var ln = parent.layers[i].name;\n';
        jsx += '        if (ln === name) return parent.layers[i];\n';
        jsx += '        if (ln.indexOf(name + " copy") === 0) return parent.layers[i];\n';
        jsx += '    }\n';
        jsx += '    return null;\n';
        jsx += '}\n\n';

        jsx += 'function findLayerRecursive(parent, name) {\n';
        jsx += '    for (var i = 0; i < parent.layers.length; i++) {\n';
        jsx += '        var layer = parent.layers[i];\n';
        jsx += '        if (layer.name === name || layer.name.indexOf(name + " copy") === 0) return layer;\n';
        jsx += '        if (layer.typename === "LayerSet") {\n';
        jsx += '            var found = findLayerRecursive(layer, name);\n';
        jsx += '            if (found) return found;\n';
        jsx += '        }\n';
        jsx += '    }\n';
        jsx += '    return null;\n';
        jsx += '}\n\n';

        jsx += 'function setGroupVisibility(group, vis) {\n';
        jsx += '    group.visible = vis;\n';
        jsx += '    for (var i = 0; i < group.layers.length; i++) {\n';
        jsx += '        var layer = group.layers[i];\n';
        jsx += '        layer.visible = vis;\n';
        jsx += '        if (layer.typename === "LayerSet") setGroupVisibility(layer, vis);\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        jsx += 'function setTextLayer(layer, content, fontSize) {\n';
        jsx += '    if (!layer) { alert("Text layer not found for: " + content); return; }\n';
        jsx += '    layer.visible = true;\n';
        jsx += '    var doc = app.activeDocument;\n';
        jsx += '    var dpiScale = 72 / doc.resolution;\n';
        jsx += '    var ti = layer.textItem;\n';
        jsx += '    ti.size = new UnitValue(fontSize * dpiScale, "pt");\n';
        jsx += '    ti.contents = content;\n';
        jsx += '}\n\n';

        jsx += 'function positionScribble(scribbleLayer, hiddenLayer, maxH) {\n';
        jsx += '    if (!scribbleLayer || !hiddenLayer) return;\n';
        jsx += '    scribbleLayer.visible = true;\n';
        jsx += '    var tb = hiddenLayer.bounds;\n';
        jsx += '    var tLeft = tb[0].as("px"), tTop = tb[1].as("px");\n';
        jsx += '    var tRight = tb[2].as("px"), tBottom = tb[3].as("px");\n';
        jsx += '    var tWidth = tRight - tLeft, tHeight = tBottom - tTop;\n';
        jsx += '    var sb = scribbleLayer.bounds;\n';
        jsx += '    var sLeft = sb[0].as("px"), sTop = sb[1].as("px");\n';
        jsx += '    var sRight = sb[2].as("px"), sBottom = sb[3].as("px");\n';
        jsx += '    var sWidth = sRight - sLeft, sHeight = sBottom - sTop;\n';
        jsx += '    var padX = tWidth * 0.15, padY = tHeight * 0.2;\n';
        jsx += '    var targetW = tWidth + padX * 2, targetH = tHeight + padY * 2;\n';
        jsx += '    if (maxH && targetH > maxH) targetH = maxH;\n';
        jsx += '    if (sWidth > 0 && sHeight > 0) {\n';
        jsx += '        scribbleLayer.resize((targetW / sWidth) * 100, (targetH / sHeight) * 100, AnchorPosition.TOPLEFT);\n';
        jsx += '    }\n';
        jsx += '    var newSB = scribbleLayer.bounds;\n';
        jsx += '    var newSW = newSB[2].as("px") - newSB[0].as("px");\n';
        jsx += '    var newSH = newSB[3].as("px") - newSB[1].as("px");\n';
        jsx += '    var dx = (tLeft + tWidth / 2) - (newSB[0].as("px") + newSW / 2);\n';
        jsx += '    var dy = (tTop + tHeight / 2) - (newSB[1].as("px") + newSH / 2);\n';
        jsx += '    scribbleLayer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));\n';
        jsx += '}\n\n';

        jsx += 'function exportPNG(doc, filename) {\n';
        jsx += '    var opts = new PNGSaveOptions();\n';
        jsx += '    opts.compression = 6;\n';
        jsx += '    opts.interlaced = false;\n';
        jsx += '    doc.saveAs(new File(OUTPUT_DIR + "/" + filename), opts, true, Extension.LOWERCASE);\n';
        jsx += '}\n\n';

        jsx += 'function hideAllCardGroups(doc) {\n';
        jsx += '    for (var i = 0; i < doc.layers.length; i++) {\n';
        jsx += '        var layer = doc.layers[i];\n';
        jsx += '        if (layer.typename === "LayerSet") layer.visible = false;\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        jsx += 'function processCard(doc, data) {\n';
        jsx += '    try {\n';
        jsx += '        var sourceGroupName = (data.cardType === "wst") ? "Who Said This_TEMPLATE" : "What Comes Next_TEMPLATE";\n';
        jsx += '        var sourceGroup = findLayer(doc, sourceGroupName);\n';
        jsx += '        if (!sourceGroup) { alert("Template group not found: " + sourceGroupName); return; }\n';
        jsx += '        var cardGroup = sourceGroup.duplicate();\n';
        jsx += '        cardGroup.name = data.filename.replace(".png", "");\n';
        jsx += '        setGroupVisibility(cardGroup, true);\n';
        jsx += '        if (data.cardType === "wst") {\n';
        jsx += '            var quoteLayer = findLayer(cardGroup, "QUOTE_TEXT");\n';
        jsx += '            setTextLayer(quoteLayer, data.quote, data.quoteFontSize);\n';
        jsx += '            if (quoteLayer) quoteLayer.translate(new UnitValue(0, "px"), new UnitValue(-69, "px"));\n';
        jsx += '            var hiddenLayer = findLayer(cardGroup, "HIDDEN_TEXT");\n';
        jsx += '            setTextLayer(hiddenLayer, data.hidden, data.hiddenFontSize);\n';
        jsx += '            var scribble = findLayer(cardGroup, "Scribble GFX");\n';
        jsx += '            positionScribble(scribble, hiddenLayer);\n';
        jsx += '            var redCircle = findLayer(cardGroup, "Red Circle");\n';
        jsx += '            if (redCircle) redCircle.visible = false;\n';
        jsx += '            var diffLeft = findLayer(cardGroup, "Difficulty_Left");\n';
        jsx += '            var diffRight = findLayer(cardGroup, "Difficulty_Right");\n';
        jsx += '            if (diffLeft) setGroupVisibility(diffLeft, true);\n';
        jsx += '            if (diffRight) setGroupVisibility(diffRight, false);\n';
        jsx += '            if (diffLeft) { var stars = findLayer(diffLeft, "Stars"); if (stars) setStars(stars, data.difficulty); }\n';
        jsx += '        } else {\n';
        jsx += '            var quoteLayer = findLayer(cardGroup, "QUOTE_TEXT");\n';
        jsx += '            setTextLayer(quoteLayer, data.quote, data.quoteFontSize);\n';
        jsx += '            if (quoteLayer) quoteLayer.translate(new UnitValue(0, "px"), new UnitValue(-30, "px"));\n';
        jsx += '            var hiddenLayer = findLayer(cardGroup, "HIDDEN_TEXT");\n';
        jsx += '            setTextLayer(hiddenLayer, data.hidden, data.hiddenFontSize);\n';
        jsx += '            var scribble = findLayer(cardGroup, "Scribble GFX");\n';
        jsx += '            positionScribble(scribble, hiddenLayer, 150);\n';
        jsx += '            var redCircle = findLayer(cardGroup, "Red Circle");\n';
        jsx += '            if (redCircle) redCircle.visible = true;\n';
        jsx += '            var diffLeft = findLayer(cardGroup, "Difficulty_Left");\n';
        jsx += '            var diffRight = findLayer(cardGroup, "Difficulty_Right");\n';
        jsx += '            if (diffLeft) setGroupVisibility(diffLeft, true);\n';
        jsx += '            if (diffRight) setGroupVisibility(diffRight, false);\n';
        jsx += '            if (diffLeft) { var stars = findLayer(diffLeft, "Stars"); if (stars) setStars(stars, data.difficulty); }\n';
        jsx += '        }\n';
        jsx += '        hideAllCardGroups(doc);\n';
        jsx += '        cardGroup.visible = true;\n';
        jsx += '        exportPNG(doc, data.filename);\n';
        jsx += '        cardGroup.visible = false;\n';
        jsx += '    } catch (e) {\n';
        jsx += '        alert("Error processing card: " + data.filename + "\\n" + e.message);\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        jsx += 'function setStars(starsGroup, difficulty) {\n';
        jsx += '    for (var s = 1; s <= 5; s++) {\n';
        jsx += '        var padded = ("00" + s).slice(-3);\n';
        jsx += '        var fillLayer = findLayer(starsGroup, "Star " + padded + "_Fill");\n';
        jsx += '        var outlineLayer = findLayer(starsGroup, "Star " + padded);\n';
        jsx += '        if (fillLayer) fillLayer.visible = (s <= difficulty);\n';
        jsx += '        if (outlineLayer) outlineLayer.visible = true;\n';
        jsx += '    }\n';
        jsx += '}\n\n';

        jsx += 'var doc = app.open(new File(TEMPLATE_PATH));\n';
        jsx += 'var wstTemplate = findLayer(doc, "Who Said This_TEMPLATE");\n';
        jsx += 'var wcnTemplate = findLayer(doc, "What Comes Next_TEMPLATE");\n';
        jsx += 'if (wstTemplate) wstTemplate.visible = false;\n';
        jsx += 'if (wcnTemplate) wcnTemplate.visible = false;\n\n';

        jsx += cardBlocks.join("\n");

        var psdOutput = (outputDir + "/" + psdBasename + "_QuoteCards.psd").replace(/\\/g, "/");
        jsx += '\nvar psdOpts = new PhotoshopSaveOptions();\n';
        jsx += 'psdOpts.layers = true;\n';
        jsx += 'psdOpts.embedColorProfile = true;\n';
        jsx += 'doc.saveAs(new File("' + psdOutput + '"), psdOpts, true, Extension.LOWERCASE);\n';
        jsx += 'doc.close(SaveOptions.DONOTSAVECHANGES);\n\n';

        jsx += 'var sentinel = new File("' + outputJS + '/_done.txt");\n';
        jsx += 'sentinel.open("w");\n';
        jsx += 'sentinel.writeln("done");\n';
        jsx += 'sentinel.close();\n\n';

        jsx += 'alert("Done! Generated " + ' + entries.length + ' + " quote cards.\\nPNGs + PSD saved to:\\n' + outputJS + '");\n';

        return jsx;
    }

    // ── Clip matching ──

    /**
     * Match quote card entries to paper edit clip entries using fuzzy text similarity.
     * Returns a map: origEntryIndex -> { card, cardIdx, pngPath, pngFilename, matchScore }
     *
     * Mirrors PaperEditor.py's match_quote_cards_to_clips().
     *
     * @param {Array}  qcEntries   - Parsed quote card entries (from parseQuoteEntries)
     * @param {Array}  clipEntries - Clip entries from the paper edit (each must have .text and ._origIdx)
     * @param {string} outputDir   - Directory where quote card PNGs will be written
     * @returns {Object}
     */
    function matchToClips(qcEntries, clipEntries, outputDir) {
        var result = {};
        if (!qcEntries || !clipEntries || qcEntries.length === 0 || clipEntries.length === 0) return result;

        function cleanText(s) {
            return s.toLowerCase().trim().replace(/[^\w\s]/g, "");
        }

        for (var cardIdx = 0; cardIdx < qcEntries.length; cardIdx++) {
            var card       = qcEntries[cardIdx];
            var cleanCard  = cleanText(card.quote);
            var bestScore  = 0;
            var bestClipIdx = -1;

            for (var ci = 0; ci < clipEntries.length; ci++) {
                var score = Processing.sequenceMatcherRatio(cleanCard, cleanText(clipEntries[ci].text));
                if (score > bestScore) { bestScore = score; bestClipIdx = ci; }
            }

            if (bestScore >= 0.3 && bestClipIdx >= 0) {
                var pngFilename = getPngFilename(cardIdx + 1, card.scene);
                var clipEntry   = clipEntries[bestClipIdx];
                result[clipEntry._origIdx] = {
                    card: card,
                    cardIdx: cardIdx,
                    pngPath: pathMod.join(outputDir, pngFilename),
                    pngFilename: pngFilename,
                    matchScore: bestScore
                };
                console.log("[QuoteCards] '" + card.scene + "' matched to '" +
                    clipEntry.text.substring(0, 40) + "...' (score=" + bestScore.toFixed(2) + ")");
            } else {
                console.log("[QuoteCards] '" + card.scene + "' — no matching clip (best=" + bestScore.toFixed(2) + ")");
            }
        }

        return result;
    }

    return {
        parseQuoteEntries: parseQuoteEntries,
        parseYouTubeLink: parseYouTubeLink,
        sceneSlug: sceneSlug,
        getPngFilename: getPngFilename,
        quoteFontSize: quoteFontSize,
        hiddenFontSize: hiddenFontSize,
        generateQuoteJSX: generateQuoteJSX,
        matchToClips: matchToClips
    };
})();
