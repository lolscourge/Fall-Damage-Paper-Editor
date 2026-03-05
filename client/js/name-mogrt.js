/**
 * name-mogrt.js — Generates the ExtendScript JSX for placing the Name.mogrt in Premiere.
 */

var NameMogrt = (function () {
    "use strict";

    var TICKS_PER_SEC = XMEMLBuilder.TICKS_PER_SECOND;

    function generateJSX(mogrtPath, guestName, introData, trackIdx, fps) {
        var ticks       = Math.round((introData.tlStartFrame / fps) * TICKS_PER_SEC);
        var mogrtPathJS = mogrtPath.replace(/\\/g, "/").replace(/"/g, '\\"');
        var nameEsc     = guestName.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, " ");

        var jsx = '';
        jsx += '(function() {\n';
        jsx += '    var seq = app.project.activeSequence;\n';
        jsx += '    if (!seq) { alert("No active sequence for Name MOGRT."); return; }\n\n';
        jsx += '    var mogrtPath = "' + mogrtPathJS + '";\n';
        jsx += '    var f = new File(mogrtPath);\n';
        jsx += '    if (!f.exists) { alert("Name MOGRT not found: " + mogrtPath); return; }\n\n';
        jsx += '    var item = seq.importMGT(mogrtPath, "' + ticks + '", ' + trackIdx + ', 0);\n';
        jsx += '    if (!item) {\n';
        jsx += '        alert("Failed to import Name MOGRT at track " + ' + trackIdx + ');\n';
        jsx += '        return;\n';
        jsx += '    }\n\n';
        jsx += '    // Set the guest name text on the MOGRT\n';
        jsx += '    try {\n';
        jsx += '        var comp = item.getMGTComponent();\n';
        jsx += '        if (comp) {\n';
        jsx += '            // Try common parameter names for the text field\n';
        jsx += '            var paramNames = ["Name", "Text", "Source Text", "name", "text"];\n';
        jsx += '            var found = false;\n';
        jsx += '            for (var i = 0; i < paramNames.length; i++) {\n';
        jsx += '                var p = comp.properties.getParamForDisplayName(paramNames[i]);\n';
        jsx += '                if (p) {\n';
        jsx += '                    p.setValue("' + nameEsc + '", true);\n';
        jsx += '                    found = true;\n';
        jsx += '                    break;\n';
        jsx += '                }\n';
        jsx += '            }\n';
        jsx += '            if (!found) {\n';
        jsx += '                // Fallback: try setting first text-like param\n';
        jsx += '                for (var j = 0; j < comp.properties.numItems; j++) {\n';
        jsx += '                    try {\n';
        jsx += '                        comp.properties[j].setValue("' + nameEsc + '", true);\n';
        jsx += '                        break;\n';
        jsx += '                    } catch(ex) {}\n';
        jsx += '                }\n';
        jsx += '            }\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {\n';
        jsx += '        // Name setting failed silently — MOGRT still placed\n';
        jsx += '    }\n\n';
        jsx += '    // Set purple colour label\n';
        jsx += '    try {\n';
        jsx += '        if (item.projectItem && item.projectItem.setColorLabel) {\n';
        jsx += '            item.projectItem.setColorLabel(0); // Violet\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {}\n';
        jsx += '})();\n';

        return jsx;
    }

    return { generateJSX: generateJSX };
})();
