/**
 * name-mogrt.js — Generates ExtendScript JSX for placing the Name.mogrt in Premiere.
 *
 * The Name.mogrt is an AE MOGRT with an exposed text property.
 * getMGTComponent() returns the component; we scan all properties to find
 * the text param (identified by getValue() containing "textEditValue"),
 * then patch the JSON and setValue().
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
        jsx += '        alert("Failed to import Name MOGRT at track V" + ' + (trackIdx + 1) + ');\n';
        jsx += '        return;\n';
        jsx += '    }\n\n';

        // Scan MGT component properties for the text param (contains "textEditValue" in its JSON value)
        jsx += '    try {\n';
        jsx += '        var mgt = item.getMGTComponent();\n';
        jsx += '        if (mgt) {\n';
        jsx += '            for (var i = 0; i < mgt.properties.numItems; i++) {\n';
        jsx += '                var p = mgt.properties[i];\n';
        jsx += '                var curVal;\n';
        jsx += '                try { curVal = p.getValue(); } catch(e) { continue; }\n';
        jsx += '                if (typeof curVal === "string" && curVal.indexOf("textEditValue") >= 0) {\n';
        jsx += '                    var updated = curVal.replace(\n';
        jsx += '                        /"textEditValue":"[^"]*"/,\n';
        jsx += '                        \'"textEditValue":"' + nameEsc + '"\'\n';
        jsx += '                    );\n';
        jsx += '                    updated = updated.replace(\n';
        jsx += '                        /"fontTextRunLength":\\[\\d+\\]/,\n';
        jsx += '                        \'"fontTextRunLength":[' + guestName.length + ']\'\n';
        jsx += '                    );\n';
        jsx += '                    p.setValue(updated, true);\n';
        jsx += '                    break;\n';
        jsx += '                }\n';
        jsx += '            }\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {}\n\n';

        // Color label
        jsx += '    try {\n';
        jsx += '        if (item.projectItem && item.projectItem.setColorLabel) {\n';
        jsx += '            item.projectItem.setColorLabel(0);\n';
        jsx += '        }\n';
        jsx += '    } catch(e) {}\n';
        jsx += '})();\n';

        return jsx;
    }

    return { generateJSX: generateJSX };
})();
