/**
 * host/index.jsx - ExtendScript for Premiere Pro.
 * Called from the CEP panel via csInterface.evalScript().
 *
 * Provides:
 *   - importAndOpenXMEML(xmlPath)  Import XMEML and open the sequence
 *   - getActiveSequenceInfo()      Return info about the active sequence
 *   - openSequenceByName(name)     Find and open a sequence by name
 */

// -- Helper: recursively search for a sequence in project items --

function findSequenceItem(parentItem, seqName) {
    for (var i = 0; i < parentItem.children.numItems; i++) {
        var child = parentItem.children[i];
        if (child.name === seqName) {
            return child;
        }
        // Search in bins
        if (child.type === ProjectItemType.BIN && child.children) {
            var found = findSequenceItem(child, seqName);
            if (found) return found;
        }
    }
    return null;
}

// -- Import XMEML from path file (avoids path injection when called from CEP) --

function importAndOpenXMEMLFromPathFile(pathFilePath) {
    try {
        var pathFile = new File(pathFilePath);
        if (!pathFile.open("r")) return "error: could not open path file";
        var xmlPath = pathFile.readln();
        pathFile.close();
        if (!xmlPath || xmlPath.length === 0) return "error: empty path in path file";
        return importAndOpenXMEML(xmlPath);
    } catch (e) {
        return "error: " + e.message;
    }
}

// -- Import XMEML and open the resulting sequence --

function importAndOpenXMEML(xmlPath) {
    try {
        if (!app.project) {
            return "error: no project open";
        }

        var xmlFile = new File(xmlPath);
        if (!xmlFile.exists) {
            return "error: XMEML file not found at " + xmlPath;
        }

        // Remember existing sequence count to detect the new one
        var seqCountBefore = app.project.sequences.numSequences;

        // Import the XMEML file
        var success = app.project.importFiles(
            [xmlPath],
            false,                    // suppressUI
            app.project.rootItem,     // target bin
            false                     // importAsNumberedStills
        );

        if (!success) {
            return "error: importFiles returned false";
        }

        // Find the newly imported sequence
        var seqCountAfter = app.project.sequences.numSequences;

        if (seqCountAfter > seqCountBefore) {
            // The last sequence in the list should be the newly imported one
            var newSeq = app.project.sequences[seqCountAfter - 1];
            if (newSeq) {
                app.project.activeSequence = newSeq;
                // Also open it in the timeline
                app.project.openSequence(newSeq.sequenceID);
                return "success: opened " + newSeq.name;
            }
        }

        // Fallback: search for WHISPER_EDIT by name
        var item = findSequenceItem(app.project.rootItem, "WHISPER_EDIT");
        if (item) {
            // Open sequence from project item
            app.project.openSequence(item.nodeId);
            return "success: opened WHISPER_EDIT via search";
        }

        return "success: imported but could not auto-open sequence";
    } catch (e) {
        return "error: " + e.message;
    }
}

// -- Open a sequence by name --

function openSequenceByName(seqName) {
    try {
        if (!app.project) return "error: no project";

        // Search through all sequences
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var seq = app.project.sequences[i];
            if (seq.name === seqName) {
                app.project.activeSequence = seq;
                app.project.openSequence(seq.sequenceID);
                return "success";
            }
        }

        // Fallback: search project items
        var item = findSequenceItem(app.project.rootItem, seqName);
        if (item) {
            app.project.openSequence(item.nodeId);
            return "success: via item search";
        }

        return "error: sequence '" + seqName + "' not found";
    } catch (e) {
        return "error: " + e.message;
    }
}

// -- Get Active Sequence Info --

function getActiveSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ error: "No active sequence" });
        }

        var info = {
            name: seq.name,
            id: seq.sequenceID,
            videoTrackCount: seq.videoTracks.numTracks,
            audioTrackCount: seq.audioTracks.numTracks
        };

        return JSON.stringify(info);
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// -- Get Project Path --

function getProjectPath() {
    try {
        if (app.project && app.project.path) {
            return app.project.path;
        }
        return "";
    } catch (e) {
        return "";
    }
}

// -- Organize project into bins --

function organizeProjectIntoBins() {
    try {
        if (!app.project || !app.project.rootItem) {
            return "error: no project";
        }

        var root = app.project.rootItem;
        var binNames = ["FOOTAGE", "CLIPS", "QUOTE CARDS", "SEQUENCES", "GFX"];
        var bins = {};

        // Create bins (or find existing)
        for (var i = 0; i < binNames.length; i++) {
            var name = binNames[i];
            var found = null;
            for (var j = 0; j < root.children.numItems; j++) {
                if (root.children[j].name === name && root.children[j].type === ProjectItemType.BIN) {
                    found = root.children[j];
                    break;
                }
            }
            bins[name] = found || root.createBin(name);
        }

        // Collect items at root level (exclude our bins)
        var toProcess = [];
        for (var k = 0; k < root.children.numItems; k++) {
            var item = root.children[k];
            if (binNames.indexOf(item.name) >= 0 && item.type === ProjectItemType.BIN) {
                continue; // Skip our bins
            }
            toProcess.push(item);
        }

        // Build set of sequence project items
        var sequenceItems = {};
        for (var s = 0; s < app.project.sequences.numSequences; s++) {
            var seq = app.project.sequences[s];
            try {
                if (seq.getProjectItem) {
                    var seqItem = seq.getProjectItem();
                    if (seqItem) sequenceItems[seqItem.nodeId] = true;
                }
            } catch (seqEx) { /* ignore */ }
        }

        var moved = 0;
        for (var m = 0; m < toProcess.length; m++) {
            var pi = toProcess[m];
            var destBin = null;
            var path = "";
            var name = (pi.name || "").toLowerCase();

            try {
                if (pi.getMediaPath) {
                    path = (pi.getMediaPath() || "").toLowerCase().replace(/\\/g, "/");
                }
            } catch (pathEx) { /* ignore */ }

            // Sequences
            if (pi.nodeId && sequenceItems[pi.nodeId]) {
                destBin = bins["SEQUENCES"];
            }
            // Quote card PNGs
            else if ((path.indexOf("quotes") >= 0 && path.indexOf(".png") >= 0) ||
                     (path.indexOf("quote") >= 0 && name.indexOf(".png") >= 0)) {
                destBin = bins["QUOTE CARDS"];
            }
            // YouTube clips (trimmed), derived clips
            else if (path.indexOf("/yt/") >= 0 || path.indexOf("\\yt\\") >= 0 || path.indexOf("quotes/yt") >= 0) {
                destBin = bins["CLIPS"];
            }
            // GFX: MOGRTs, overlay .mov files (Title Card, END CARD), templates
            else if (path.indexOf(".mogrt") >= 0 || path.indexOf("templates") >= 0 ||
                     path.indexOf("end card") >= 0 || path.indexOf("title card") >= 0 ||
                     name.indexOf("hearts") >= 0 || name.indexOf("name.mogrt") >= 0) {
                destBin = bins["GFX"];
            }
            // Everything else: camera footage, external audio
            else {
                destBin = bins["FOOTAGE"];
            }

            if (destBin && pi.moveBin) {
                try {
                    pi.moveBin(destBin);
                    moved++;
                } catch (moveEx) {
                    // Item might not support moveBin
                }
            }
        }

        return "success: organized " + moved + " items into bins";
    } catch (e) {
        return "error: " + e.message;
    }
}

// -- Alert from panel --

function showAlert(message) {
    alert(message);
    return "ok";
}

// -- Check for offline media, attempt relink, return JSON --
// Reads project folder path from a path file (avoids injection when called from CEP).
// Returns: {"relinked":N,"stillOffline":[{"name":"...","path":"..."},...],"error":"..."}

function checkAndRelinkOfflineMedia(pathFilePath) {
    // NOTE: function declarations must be at function-body level, not inside try blocks,
    // because ExtendScript (ES3) does not allow block-level function declarations.
    function collectProjectItems(parent, out) {
        try {
            if (!parent || !parent.children) return;
            for (var i = 0; i < parent.children.numItems; i++) {
                var pi = parent.children[i];
                if (pi.type === ProjectItemType.BIN && pi.children) {
                    collectProjectItems(pi, out);
                } else if (pi.getMediaPath) {
                    var mp = "";
                    try { mp = pi.getMediaPath(); } catch (e) {}
                    if (mp) out.push(pi);
                }
            }
        } catch (e) {}
    }

    function findFileInFolder(folderObj, basename) {
        var base = folderObj.fsName.replace(/\\/g, "/").replace(/\/$/, "");
        var f = new File(base + "/" + basename);
        if (f.exists) return f.fsName;
        // One level deep: check subdirs (quotes, quotes/yt, etc.)
        var list = folderObj.getFiles();
        for (var k = 0; k < list.length; k++) {
            if (list[k] instanceof Folder) {
                var sub = new File(list[k].fsName + "/" + basename);
                if (sub.exists) return sub.fsName;
            }
        }
        return null;
    }

    try {
        var pathFile = new File(pathFilePath);
        if (!pathFile.open("r")) return '{"error":"could not open path file"}';
        var projectFolder = pathFile.readln();
        pathFile.close();
        if (!projectFolder || projectFolder.length === 0) return '{"error":"empty project folder path"}';

        if (!app.project || !app.project.rootItem) return '{"error":"no project"}';

        var relinked = 0;
        var stillOffline = [];
        var projectFolderObj = new Folder(projectFolder);
        if (!projectFolderObj.exists) {
            return '{"error":"project folder not found: ' + projectFolder.replace(/"/g, "\\\"") + '"}';
        }

        var items = [];
        collectProjectItems(app.project.rootItem, items);

        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            var mediaPath = "";
            try { mediaPath = item.getMediaPath(); } catch (e) { continue; }
            if (!mediaPath) continue;

            var f = new File(mediaPath);
            var isOffline = !f.exists;

            if (isOffline && item.canChangeMediaPath && item.canChangeMediaPath()) {
                var basename = mediaPath.replace(/^.*[\/\\]/, "");
                var foundPath = findFileInFolder(projectFolderObj, basename);
                if (foundPath) {
                    try {
                        item.changeMediaPath(foundPath);
                        relinked++;
                    } catch (chEx) {
                        stillOffline.push({ name: item.name || basename, path: mediaPath });
                    }
                } else {
                    stillOffline.push({ name: item.name || basename, path: mediaPath });
                }
            } else if (isOffline) {
                stillOffline.push({ name: item.name || (mediaPath.replace(/^.*[\/\\]/, "")), path: mediaPath });
            }
        }

        return JSON.stringify({ relinked: relinked, stillOffline: stillOffline });
    } catch (e) {
        return '{"error":"' + (e.message || String(e)).replace(/"/g, '\\"').replace(/\n/g, " ") + '"}';
    }
}

