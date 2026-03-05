/**
 * CSInterface - Adobe CEP interface library (v12)
 * Provides communication between HTML/JS panel and ExtendScript host.
 */

var CSInterface = (function () {
    "use strict";

    // CEP System path types
    var SystemPath = {
        USER_DATA:       "userData",
        COMMON_FILES:    "commonFiles",
        MY_DOCUMENTS:    "myDocuments",
        APPLICATION:     "application",
        EXTENSION:       "extension",
        HOST_APPLICATION: "hostApplication"
    };

    // CEP Color types
    var ColorType = { RGB: "rgb", GRADIENT: "gradient", NONE: "none" };

    // CEP Event scopes
    var EvalScriptError = "EvalScript_ErrMessage";

    /**
     * @constructor CSInterface
     */
    function CSInterface() {}

    /**
     * Retrieve host environment info.
     */
    CSInterface.prototype.getHostEnvironment = function () {
        var env;
        try {
            env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
        } catch (e) {
            env = null;
        }
        return env;
    };

    /**
     * Close this extension panel.
     */
    CSInterface.prototype.closeExtension = function () {
        window.__adobe_cep__.closeExtension();
    };

    /**
     * Get the system path of the given type.
     * @param {string} pathType - one of SystemPath constants
     */
    CSInterface.prototype.getSystemPath = function (pathType) {
        var path = "";
        try {
            path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
        } catch (e) {}
        return path;
    };

    /**
     * Evaluate an ExtendScript expression in the host application.
     * @param {string} script - the ExtendScript to evaluate
     * @param {function} [callback] - called with the result string
     */
    CSInterface.prototype.evalScript = function (script, callback) {
        if (callback === null || callback === undefined) {
            callback = function (result) {};
        }
        window.__adobe_cep__.evalScript(script, callback);
    };

    /**
     * Retrieve the scale factor for the current UI.
     */
    CSInterface.prototype.getScaleFactor = function () {
        var factor = 1;
        try {
            factor = JSON.parse(window.__adobe_cep__.getScaleFactor());
            if (typeof factor === "object" && factor.scaleFactor) {
                factor = factor.scaleFactor;
            }
        } catch (e) {}
        return factor;
    };

    /**
     * Register a listener for a CEP event.
     * @param {string} type - event type string
     * @param {function} listener - callback
     * @param {object} [obj] - 'this' context for listener
     */
    CSInterface.prototype.addEventListener = function (type, listener, obj) {
        window.__adobe_cep__.addEventListener(type, listener, obj);
    };

    /**
     * Remove a CEP event listener.
     */
    CSInterface.prototype.removeEventListener = function (type, listener, obj) {
        window.__adobe_cep__.removeEventListener(type, listener, obj);
    };

    /**
     * Dispatch a CEP event.
     * @param {CSEvent} event
     */
    CSInterface.prototype.dispatchEvent = function (event) {
        if (typeof event.data === "object") {
            event.data = JSON.stringify(event.data);
        }
        window.__adobe_cep__.dispatchEvent(event);
    };

    /**
     * Request to open another extension.
     * @param {string} extensionId
     */
    CSInterface.prototype.requestOpenExtension = function (extensionId) {
        window.__adobe_cep__.requestOpenExtension(extensionId, "");
    };

    /**
     * Get extensions currently loaded.
     */
    CSInterface.prototype.getExtensions = function (extensionIds) {
        var exts = [];
        try {
            exts = JSON.parse(window.__adobe_cep__.getExtensions(extensionIds));
        } catch (e) {}
        return exts;
    };

    /**
     * Get the current active theme color.
     */
    CSInterface.prototype.getHostColor = function () {
        return null; // Simplified — we use our own theme
    };

    /**
     * Open a URL in the default browser.
     * @param {string} url
     */
    CSInterface.prototype.openURLInDefaultBrowser = function (url) {
        if (typeof cep !== "undefined" && cep.util) {
            cep.util.openURLInDefaultBrowser(url);
        }
    };

    /**
     * Set the panel's title.
     * @param {string} title
     */
    CSInterface.prototype.setWindowTitle = function (title) {
        window.__adobe_cep__.invokeSync("setWindowTitle", title);
    };

    /**
     * Get the panel's current size and position.
     */
    CSInterface.prototype.getWindowGeometry = function () {
        return null;
    };

    // -- CSEvent constructor --
    function CSEvent(type, scope, appId, extensionId) {
        this.type = type;
        this.scope = scope || "APPLICATION";
        this.appId = appId || "";
        this.extensionId = extensionId || "";
        this.data = "";
    }

    // Expose
    CSInterface.SystemPath = SystemPath;
    CSInterface.CSEvent = CSEvent;
    CSInterface.ColorType = ColorType;
    CSInterface.EvalScriptError = EvalScriptError;

    return CSInterface;
})();

// Export for Node.js require()
if (typeof module !== "undefined") {
    module.exports = CSInterface;
}
