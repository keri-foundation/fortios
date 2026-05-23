import UIKit
import WebKit

final class WebContainerViewController: UIViewController {
    private var webView: WKWebView?
    private var navDelegate: WebNavDelegate?
    private var bridge: WebBridge?
    private var loopbackServer: LocalLoopbackPayloadServer?
    private var didInjectStorageCanary = false

    override func viewDidLoad() {
        super.viewDidLoad()

        overrideUserInterfaceStyle = AppConfig.Appearance.interfaceStyle
        view.backgroundColor = AppConfig.Appearance.backgroundColor

        let userContentController = WKUserContentController()

        let bridge = WebBridge()
        userContentController.add(bridge, name: AppConfig.Bridge.handlerName)
        self.bridge = bridge
        WKRuntimeTrace.installIfNeeded(
            on: userContentController,
            handlerName: AppConfig.Bridge.handlerName)

        // Receive crypto operation results from Pyodide worker via JS bridge
        bridge.onCryptoResult = { [weak self] payload in
            _ = self  // suppress unused warning; callers can extend this
            if let error = payload.error, !error.isEmpty {
                AppLogger.warning(
                    "[WebContainer] crypto_result id=\(payload.id) error",
                    category: AppConfig.Log.webContainer)
                return
            }

            AppLogger.debug(
                "[WebContainer] crypto_result id=\(payload.id) ok",
                category: AppConfig.Log.webContainer)
        }

        let config = WKWebViewConfiguration()
        config.userContentController = userContentController

        config.setURLSchemeHandler(PayloadSchemeHandler(), forURLScheme: AppConfig.Scheme.name)

        let initialPayloadTarget = resolveInitialPayloadTarget()
        self.loopbackServer = initialPayloadTarget.server

        let webView = WKWebView(frame: .zero, configuration: config)
        self.webView = webView

        let navDelegate = WebNavDelegate(
            policy: WebNavigationPolicy(
                allowedLoopbackOrigin: initialPayloadTarget.loopbackOrigin,
                allowedFileRoot: initialPayloadTarget.fileReadAccessRoot))
        navDelegate.onDidFinish = { [weak self] webView in
            self?.runStorageCanaryIfNeeded(in: webView)
        }
        self.navDelegate = navDelegate
        webView.navigationDelegate = navDelegate

        // Prevent white flash before HTML paints. Must be set before load.
        // underPageBackgroundColor uses a dynamic provider to match CSS bg in both modes.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.underPageBackgroundColor = AppConfig.Appearance.backgroundColor
        // CSS env(safe-area-inset-*) owns all insets — prevent UIKit double-counting.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Keep visual scale at 1.0 so fixed tab bars align with hit testing (pinch/double-tap zoom otherwise offsets taps).
        webView.scrollView.minimumZoomScale = 1.0
        webView.scrollView.maximumZoomScale = 1.0
        webView.scrollView.bouncesZoom = false
        #if DEBUG
            webView.isInspectable = true
        #endif

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        NSLayoutConstraint.activate([
            // UIKit safe area handles the Dynamic Island / status bar gap natively.
            // The native view.backgroundColor fills behind the status bar.
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        loadInitialPayload(webView: webView, target: initialPayloadTarget)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        AppConfig.Appearance.statusBarStyle
    }

    deinit {
        loopbackServer?.stop()
        webView?.configuration.userContentController.removeScriptMessageHandler(
            forName: AppConfig.Bridge.handlerName)
    }

    private func loadInitialPayload(webView: WKWebView, target: InitialPayloadTarget) {
        let url = target.url
        let displayedURL = displayedURLString(url, relativeTo: target.fileReadAccessRoot)

        AppLogger.notice(
            "[WebContainer] loading initial payload entry=\(displayedURL)",
            category: AppConfig.Log.webContainer)
        if WKRuntimeTrace.isEnabled {
            AppLogger.info(
                "[WebContainer] wk_trace.navigation phase=\"load_initial_url\" url=\"\(displayedURL)\"",
                category: AppConfig.Log.webContainer)
        }

        if let fileReadAccessRoot = target.fileReadAccessRoot {
            let displayedRoot = displayedURLString(fileReadAccessRoot, relativeTo: fileReadAccessRoot)

            AppLogger.notice(
                "[WebContainer] file_origin.load.url url=\"\(displayedURL)\"",
                category: AppConfig.Log.webContainer)
            AppLogger.notice(
                "[WebContainer] file_origin.read_access_root url=\"\(displayedRoot)\"",
                category: AppConfig.Log.webContainer)

            webView.loadFileURL(url, allowingReadAccessTo: fileReadAccessRoot)
            return
        }

        webView.load(URLRequest(url: url))
    }

    private func resolveInitialPayloadTarget() -> InitialPayloadTarget {
        let fileOriginRequested = AppConfig.FileOrigin.isEnabled
        let explicitLoopbackRequested = AppConfig.Loopback.isEnabled
        let workaroundLoopbackRequested = AppConfig.Loopback.shouldUseBlobWorkerWorkaround

        // DEBUG-only evidence probe: iOS has no documented Android-style reserved
        // local HTTPS asset origin, so this file:// lane is opt-in only.
        if fileOriginRequested {
            let reason: String
            if explicitLoopbackRequested {
                reason = "explicit_file_over_explicit_loopback"
            } else if workaroundLoopbackRequested {
                reason = "explicit_file_over_loopback_workaround"
            } else {
                reason = "explicit_opt_in"
            }

            return resolveFileOriginTarget(reason: reason)
        }

        if AppConfig.Loopback.isEnabled {
            return resolveLoopbackTarget(reason: "explicit_opt_in")
        }

        if workaroundLoopbackRequested {
            AppLogger.notice(
                "[Loopback] loopback.workaround reason=\"blob_worker_invalid_state\" trigger=\"ios26_simulator\"",
                category: AppConfig.Log.loopback)
            return resolveLoopbackTarget(reason: "ios26_simulator_blob_worker")
        }

        return resolveAppSchemeTarget()
    }

    private func resolveAppSchemeTarget() -> InitialPayloadTarget {
        guard let url = URL(string: AppConfig.Scheme.entryURL) else {
            AppLogger.error(
                "[WebContainer] invalid initial URL", category: AppConfig.Log.webContainer)
            return InitialPayloadTarget(
                url: URL(fileURLWithPath: "/"),
                server: nil,
                loopbackOrigin: nil,
                fileReadAccessRoot: nil)
        }

        return InitialPayloadTarget(
            url: url,
            server: nil,
            loopbackOrigin: nil,
            fileReadAccessRoot: nil)
    }

    private func resolveFileOriginTarget(reason: String) -> InitialPayloadTarget {
        #if DEBUG
            let fileManager = FileManager.default

            guard
                let payloadRootURL = Bundle.main.resourceURL?.appendingPathComponent(
                    AppConfig.Payload.bundleSubdirectory,
                    isDirectory: true)
            else {
                AppLogger.error(
                    "[WebContainer] file_origin.probe.error error_kind=\"missing_payload_root\" fallback=\"app_scheme\" reason=\"\(reason)\"",
                    category: AppConfig.Log.webContainer)
                return resolveAppSchemeTarget()
            }

            let entryFileURL = payloadRootURL.appendingPathComponent(
                AppConfig.Scheme.defaultIndexPath,
                isDirectory: false)

            guard fileManager.fileExists(atPath: entryFileURL.path) else {
                AppLogger.error(
                    "[WebContainer] file_origin.probe.error error_kind=\"missing_entry_file\" entry=\"file://\(AppConfig.Payload.bundleSubdirectory)/\(AppConfig.Scheme.defaultIndexPath)\" fallback=\"app_scheme\" reason=\"\(reason)\"",
                    category: AppConfig.Log.webContainer)
                return resolveAppSchemeTarget()
            }

            AppLogger.notice(
                "[WebContainer] file_origin.probe.enabled reason=\"\(reason)\"",
                category: AppConfig.Log.webContainer)

            return InitialPayloadTarget(
                url: entryFileURL,
                server: nil,
                loopbackOrigin: nil,
                fileReadAccessRoot: payloadRootURL)
        #else
            return resolveAppSchemeTarget()
        #endif
    }

    private func resolveLoopbackTarget(reason: String) -> InitialPayloadTarget {
        do {
            let server = try LocalLoopbackPayloadServer()
            let loopbackOrigin = try server.start()
            let url = loopbackOrigin.entryURL

            AppLogger.notice(
                "[Loopback] loopback.load.url url=\"\(url.absoluteString)\" reason=\"\(reason)\"",
                category: AppConfig.Log.loopback)

            return InitialPayloadTarget(
                url: url,
                server: server,
                loopbackOrigin: loopbackOrigin,
                fileReadAccessRoot: nil)
        } catch {
            AppLogger.error(
                "[Loopback] loopback.server.error error_kind=\"startup_failed\" error=\"\(error.localizedDescription)\" fallback=\"app_scheme\" reason=\"\(reason)\"",
                error: error,
                category: AppConfig.Log.loopback)
        }

        return resolveAppSchemeTarget()
    }

    private func displayedURLString(_ url: URL, relativeTo root: URL?) -> String {
        guard url.isFileURL, let root else {
            return url.absoluteString
        }

        let normalizedRoot = root.standardizedFileURL.path
        let normalizedURL = url.standardizedFileURL.path
        let prefix = "file://\(AppConfig.Payload.bundleSubdirectory)"

        if normalizedURL == normalizedRoot {
            return "\(prefix)/"
        }

        if normalizedURL.hasPrefix(normalizedRoot + "/") {
            let relativePath = String(normalizedURL.dropFirst(normalizedRoot.count + 1))
            return "\(prefix)/\(relativePath)"
        }

        return prefix
    }

    private func runStorageCanaryIfNeeded(in webView: WKWebView) {
        guard StorageCanary.isEnabled else { return }
        guard !didInjectStorageCanary else { return }
        didInjectStorageCanary = true

        AppLogger.notice(
            "[WebContainer] storage canary injecting url=\(webView.url?.absoluteString ?? "(nil)")",
            category: AppConfig.Log.webContainer)

        webView.evaluateJavaScript(StorageCanary.script(handlerName: AppConfig.Bridge.handlerName)) {
            result, error in
            if let error {
                AppLogger.error(
                    "[WebContainer] storage canary injection failed",
                    error: error,
                    category: AppConfig.Log.webContainer)
                return
            }

            if let marker = result as? String, marker == StorageCanary.startedMarker {
                AppLogger.notice(
                    "[WebContainer] storage canary started",
                    category: AppConfig.Log.webContainer)
                return
            }

            if let marker = result as? String, marker == StorageCanary.missingBridgeMarker {
                AppLogger.error(
                    "[WebContainer] storage canary missing bridge handler",
                    category: AppConfig.Log.webContainer)
                return
            }

            AppLogger.warning(
                "[WebContainer] storage canary returned unexpected marker=\(String(describing: result))",
                category: AppConfig.Log.webContainer)
        }
    }

    /// Dispatch a crypto operation to the Pyodide Web Worker via JS.
    /// Results are delivered asynchronously as `crypto_result` bridge messages
    /// handled by `bridge.onCryptoResult`.
    ///
    /// - Parameter command: Dictionary matching the `WorkerInbound` protocol
    ///   defined in `pyodide_worker.ts`. Required keys: `id` (String), `type` (String).
    ///   Optional keys depend on `type`:
    ///   - `blake3_hash`:  `data` (String)
    ///   - `sign`:         `message` (String)
    ///   - `verify`:       `message`, `signature`, `publicKey` (all String)
    func runCryptoOperation(_ command: [String: Any]) {
        guard let webView = webView else {
            AppLogger.warning(
                "[WebContainer] runCryptoOperation: webView not ready",
                category: AppConfig.Log.webContainer)
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: command),
            let json = String(data: data, encoding: .utf8)
        else {
            AppLogger.error(
                "[WebContainer] runCryptoOperation: JSON serialization failed",
                category: AppConfig.Log.webContainer)
            return
        }
        let js = """
        (function() {
            if (typeof window.handleNativeCommand !== 'function') {
                return '__bridge_missing__';
            }
            window.handleNativeCommand(\(json));
            return '__bridge_called__';
        })();
        """

        webView.evaluateJavaScript(js) { result, error in
            if let error = error {
                AppLogger.error(
                    "[WebContainer] evaluateJavaScript error: \(error)",
                    category: AppConfig.Log.webContainer)
                return
            }

            if let marker = result as? String, marker == "__bridge_missing__" {
                AppLogger.warning(
                    "[WebContainer] handleNativeCommand not available; skipping debug crypto dispatch",
                    category: AppConfig.Log.webContainer)
            }
        }
    }
}

private struct InitialPayloadTarget {
    let url: URL
    let server: LocalLoopbackPayloadServer?
    let loopbackOrigin: LoopbackOrigin?
    let fileReadAccessRoot: URL?
}

private enum WKRuntimeTrace {
    private static let environmentKey = "FORTIOS_WK_TRACE"
    private static let launchArgument = "-FORTIOS_WK_TRACE"

    static var isEnabled: Bool {
        #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            if let flag = environment[environmentKey]?.lowercased(),
                ["1", "true", "yes"].contains(flag)
            {
                return true
            }

            let arguments = ProcessInfo.processInfo.arguments
            return arguments.contains(launchArgument)
                || arguments.contains("\(environmentKey)=1")
        #else
            return false
        #endif
    }

    static func installIfNeeded(on userContentController: WKUserContentController, handlerName: String) {
        guard isEnabled else { return }

        let script = WKUserScript(
            source: source(handlerName: handlerName),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false)
        userContentController.addUserScript(script)

        AppLogger.notice(
            "[WebContainer] wk_trace.install handler=\"\(handlerName)\"",
            category: AppConfig.Log.webContainer)
    }

    private static func source(handlerName: String) -> String {
        #"""
        (function () {
            if (window.__fortiosWkTraceInstalled) {
                return;
            }
            window.__fortiosWkTraceInstalled = true;

            const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers["\#(handlerName)"];
            if (!bridge || typeof bridge.postMessage !== "function") {
                return;
            }

            const secretPattern = /passcode|password|secret|seed\s*phrase|private\s*key|mnemonic|token/gi;
            const cap = (value, limit = 240) => value.length > limit ? value.slice(0, limit) : value;
            const webPayloadMarker = "/WebPayload/";
            const sanitize = (value) => cap(String(value ?? "").replace(secretPattern, "[REDACTED]"));
            const normalizeUrl = (value) => {
                const stringValue = String(value ?? "");
                if (!stringValue) {
                    return "";
                }

                const markerIndex = stringValue.indexOf(webPayloadMarker);
                if (markerIndex === -1) {
                    return sanitize(stringValue);
                }

                return sanitize(`file://WebPayload/${stringValue.slice(markerIndex + webPayloadMarker.length)}`);
            };
            const stringify = (value) => {
                if (typeof value === "string") {
                    return normalizeUrl(value);
                }
                if (typeof value === "number" || typeof value === "boolean") {
                    return String(value);
                }
                if (value === null || typeof value === "undefined") {
                    return String(value);
                }
                if (value instanceof Error) {
                    return sanitize(`${value.name}: ${value.message}`);
                }
                try {
                    return normalizeUrl(JSON.stringify(value));
                } catch (_) {
                    return normalizeUrl(String(value));
                }
            };

            const isFileOrigin = () => window.location && window.location.protocol === "file:";
            const currentDocumentUrl = () => window.location && window.location.href ? normalizeUrl(window.location.href) : "";
            const currentOrigin = () => window.location && window.location.origin ? window.location.origin : "";
            const targetUrl = (target) => {
                if (!target || typeof target !== "object") {
                    return "";
                }

                return normalizeUrl(target.src || target.href || "");
            };
            const errorName = (errorLike) => errorLike && typeof errorLike.name === "string" ? errorLike.name : "";
            const errorMessage = (errorLike, fallback) => {
                if (errorLike && typeof errorLike.message === "string" && errorLike.message) {
                    return sanitize(errorLike.message);
                }

                return sanitize(fallback || "");
            };
            const postFileOriginDiagnostic = (event, level, fields = {}) => {
                if (!isFileOrigin()) {
                    return;
                }

                postEvent(event, level, {
                    document_url: currentDocumentUrl(),
                    origin: currentOrigin(),
                    ready_state: document.readyState,
                    ...fields,
                });
            };

            const formatValue = (value) => {
                if (typeof value === "number" || typeof value === "boolean") {
                    return String(value);
                }
                return JSON.stringify(stringify(value));
            };

            const postEvent = (event, level, fields = {}) => {
                const parts = Object.entries(fields)
                    .filter(([, value]) => value !== undefined && value !== null && value !== "")
                    .map(([key, value]) => `${key}=${formatValue(value)}`);
                const suffix = parts.length ? ` ${parts.join(" ")}` : "";
                bridge.postMessage({
                    type: "log",
                    timestamp: new Date().toISOString(),
                    message: `[fortweb.runtime] event=${event} level=${JSON.stringify(level)}${suffix}`,
                });
            };

            postEvent("wk_trace.install", "info", {
                document_url: currentDocumentUrl(),
                origin: currentOrigin(),
            });
            postFileOriginDiagnostic("file_origin.boot_diag.install", "info");

            document.addEventListener("readystatechange", () => {
                postFileOriginDiagnostic("file_origin.boot_diag.document_ready_state", "info");
            });

            window.addEventListener("error", (event) => {
                const sourceUrl = event && event.filename
                    ? normalizeUrl(event.filename)
                    : targetUrl(event && event.target);
                const targetTag = event && event.target && event.target.tagName ? event.target.tagName : "";
                const targetType = event && event.target && typeof event.target.type === "string" ? event.target.type : "";
                const detailedMessage = errorMessage(event && event.error, event && event.message ? event.message : "window error event");

                postEvent("wk_trace.js_error", "error", {
                    message: detailedMessage,
                    error_name: errorName(event && event.error),
                    source: sourceUrl,
                    lineno: event && typeof event.lineno === "number" ? event.lineno : "",
                    colno: event && typeof event.colno === "number" ? event.colno : "",
                    target_tag: targetTag,
                    target_src: targetUrl(event && event.target),
                    target_type: targetType,
                });

                postFileOriginDiagnostic("file_origin.boot_diag.js_error", "error", {
                    message: detailedMessage,
                    error_name: errorName(event && event.error),
                    source: sourceUrl,
                    lineno: event && typeof event.lineno === "number" ? event.lineno : "",
                    colno: event && typeof event.colno === "number" ? event.colno : "",
                    target_tag: targetTag,
                    target_src: targetUrl(event && event.target),
                    target_type: targetType,
                });

                if (targetTag === "SCRIPT") {
                    postFileOriginDiagnostic("file_origin.boot_diag.script_error", "error", {
                        message: detailedMessage,
                        error_name: errorName(event && event.error),
                        source: sourceUrl,
                        lineno: event && typeof event.lineno === "number" ? event.lineno : "",
                        colno: event && typeof event.colno === "number" ? event.colno : "",
                        script_src: targetUrl(event && event.target),
                        script_type: targetType,
                    });
                }
            }, true);

            window.addEventListener("unhandledrejection", (event) => {
                const reason = event ? event.reason : null;
                postEvent("wk_trace.unhandled_rejection", "error", {
                    message: stringify(reason ?? "unhandled rejection"),
                    reason_name: errorName(reason),
                });

                postFileOriginDiagnostic("file_origin.boot_diag.unhandled_rejection", "error", {
                    message: stringify(reason ?? "unhandled rejection"),
                    reason_name: errorName(reason),
                });
            });

            if (window.console) {
                const originalError = typeof window.console.error === "function"
                    ? window.console.error.bind(window.console)
                    : null;
                const originalWarn = typeof window.console.warn === "function"
                    ? window.console.warn.bind(window.console)
                    : null;

                if (originalError) {
                    window.console.error = function (...args) {
                        const message = args.map((arg) => stringify(arg)).join(" | ");
                        postEvent("wk_trace.console_error", "error", {
                            message,
                        });
                        postFileOriginDiagnostic("file_origin.boot_diag.console_error", "error", {
                            message,
                        });
                        return originalError(...args);
                    };
                }

                if (originalWarn) {
                    window.console.warn = function (...args) {
                        const message = args.map((arg) => stringify(arg)).join(" | ");
                        postEvent("wk_trace.console_warn", "warning", {
                            message,
                        });
                        postFileOriginDiagnostic("file_origin.boot_diag.console_warn", "warning", {
                            message,
                        });
                        return originalWarn(...args);
                    };
                }
            }

            if (window.URL && typeof window.URL.createObjectURL === "function") {
                const originalCreateObjectURL = window.URL.createObjectURL.bind(window.URL);
                window.URL.createObjectURL = function (object) {
                    const createdUrl = originalCreateObjectURL(object);
                    postEvent("wk_trace.blob_url_created", "info", {
                        blob_url: createdUrl,
                        blob_type: object && typeof object.type === "string" ? object.type : "",
                        blob_size: object && typeof object.size === "number" ? object.size : "",
                    });
                    return createdUrl;
                };
            }

            if (typeof window.Worker === "function") {
                const NativeWorker = window.Worker;
                const attachWorkerTrace = (worker, source) => {
                    if (!worker || typeof worker.addEventListener !== "function") {
                        return worker;
                    }

                    worker.addEventListener("error", (event) => {
                        postEvent("wk_trace.worker_error", "error", {
                            source,
                            message: event && event.message ? event.message : "worker error",
                            lineno: event && typeof event.lineno === "number" ? event.lineno : "",
                            colno: event && typeof event.colno === "number" ? event.colno : "",
                        });
                    });
                    worker.addEventListener("messageerror", () => {
                        postEvent("wk_trace.worker_message_error", "error", { source });
                    });
                    return worker;
                };

                function TracedWorker(url, options) {
                    const source = stringify(url);
                    postEvent("wk_trace.worker_create", "info", { source });
                    try {
                        const worker = options === undefined ? new NativeWorker(url) : new NativeWorker(url, options);
                        return attachWorkerTrace(worker, source);
                    } catch (error) {
                        postEvent("wk_trace.worker_error", "error", {
                            source,
                            message: stringify(error),
                        });
                        throw error;
                    }
                }

                TracedWorker.prototype = NativeWorker.prototype;
                Object.keys(NativeWorker).forEach((key) => {
                    try {
                        TracedWorker[key] = NativeWorker[key];
                    } catch (_) {}
                });
                window.Worker = TracedWorker;
            }
        })();
        """#
    }
}

private enum StorageCanary {
        static let startedMarker = "__storage_canary_started__"
        static let missingBridgeMarker = "__storage_canary_missing_bridge__"

        static var isEnabled: Bool {
                #if DEBUG
                        let environment = ProcessInfo.processInfo.environment
                        if let flag = environment["FORTIOS_STORAGE_CANARY"]?.lowercased(),
                                ["1", "true", "yes"].contains(flag)
                        {
                                return true
                        }

                        let arguments = ProcessInfo.processInfo.arguments
                        return arguments.contains("-FORTIOS_STORAGE_CANARY")
                                || arguments.contains("FORTIOS_STORAGE_CANARY=1")
                #else
                        return false
                #endif
        }

        static func script(handlerName: String) -> String {
                #"""
                (function () {
                    const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers["\#(handlerName)"];
                    if (!bridge || typeof bridge.postMessage !== "function") {
                        return "\#(missingBridgeMarker)";
                    }

                    const stringify = (value) => {
                        if (typeof value === "string") {
                            return JSON.stringify(value);
                        }
                        if (typeof value === "number" || typeof value === "boolean") {
                            return String(value);
                        }
                        if (value === null || typeof value === "undefined") {
                            return JSON.stringify(String(value));
                        }
                        try {
                            return JSON.stringify(value);
                        } catch (_) {
                            return JSON.stringify(String(value));
                        }
                    };

                    const emit = (label, fields = {}) => {
                        const suffix = Object.entries(fields)
                            .map(([key, value]) => `${key}=${stringify(value)}`)
                            .join(" ");

                        bridge.postMessage({
                            type: "log",
                            timestamp: new Date().toISOString(),
                            message: suffix ? `[storage_canary] ${label} ${suffix}` : `[storage_canary] ${label}`,
                        });
                    };

                    const errorFields = (error) => ({
                        name: error && error.name ? error.name : "Error",
                        message: error && error.message ? error.message : String(error),
                    });

                    const probeState = {
                        main: false,
                        worker: false,
                        done: false,
                    };

                    let masterTimer;
                    const finishAll = (status, fields = {}) => {
                        if (probeState.done) {
                            return;
                        }
                        probeState.done = true;
                        if (masterTimer) {
                            clearTimeout(masterTimer);
                        }
                        emit("storage_canary.done", { status, ...fields });
                    };

                    const finishProbe = (name) => {
                        probeState[name] = true;
                        if (probeState.main && probeState.worker) {
                            finishAll("complete");
                        }
                    };

                    const openIndexedDb = (labelPrefix, databaseName, databaseFactory, onComplete) => {
                        emit(`${labelPrefix}.open.start`, { database: databaseName });
                        emit(`${labelPrefix}.type`, {
                            available: typeof databaseFactory !== "undefined",
                            value: typeof databaseFactory,
                        });

                        if (typeof databaseFactory === "undefined") {
                            emit(`${labelPrefix}.open.error`, {
                                name: "Unavailable",
                                message: "indexedDB is undefined",
                            });
                            onComplete();
                            return;
                        }

                        let finished = false;
                        const finish = () => {
                            if (finished) {
                                return;
                            }
                            finished = true;
                            clearTimeout(timeout);
                            onComplete();
                        };
                        const timeout = setTimeout(() => {
                            if (finished) {
                                return;
                            }
                            emit(`${labelPrefix}.open.error`, {
                                name: "Timeout",
                                message: `Timed out opening ${databaseName}`,
                            });
                            finish();
                        }, 5000);

                        try {
                            const request = databaseFactory.open(databaseName, 1);
                            request.onupgradeneeded = () => {};
                            request.onsuccess = () => {
                                if (finished) {
                                    return;
                                }
                                try {
                                    request.result.close();
                                } catch (_) {}
                                emit(`${labelPrefix}.open.success`, { database: databaseName });
                                finish();
                            };
                            request.onerror = () => {
                                if (finished) {
                                    return;
                                }
                                emit(`${labelPrefix}.open.error`, errorFields(request.error));
                                finish();
                            };
                        } catch (error) {
                            if (finished) {
                                return;
                            }
                            emit(`${labelPrefix}.open.error`, errorFields(error));
                            finish();
                        }
                    };

                    const startWorkerProbe = () => {
                        emit("storage_canary.worker.create.start", { mode: "blob" });
                        if (typeof Worker === "undefined") {
                            emit("storage_canary.worker.create.error", {
                                name: "Unavailable",
                                message: "Worker is undefined",
                            });
                            finishProbe("worker");
                            return;
                        }

                        const workerSource = [
                            "const emit = (label, fields = {}) => self.postMessage({ kind: 'log', label, fields });",
                            "const errorFields = (error) => ({ name: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) });",
                            "const openIndexedDb = (labelPrefix, databaseName) => new Promise((resolve) => {",
                            "  emit(labelPrefix + '.open.start', { database: databaseName });",
                            "  emit(labelPrefix + '.type', { available: typeof indexedDB !== 'undefined', value: typeof indexedDB });",
                            "  if (typeof indexedDB === 'undefined') {",
                            "    emit(labelPrefix + '.open.error', { name: 'Unavailable', message: 'indexedDB is undefined' });",
                            "    resolve();",
                            "    return;",
                            "  }",
                            "  let finished = false;",
                            "  const timeout = setTimeout(() => {",
                            "    if (finished) return;",
                            "    finished = true;",
                            "    emit(labelPrefix + '.open.error', { name: 'Timeout', message: 'Timed out opening ' + databaseName });",
                            "    resolve();",
                            "  }, 5000);",
                            "  try {",
                            "    const request = indexedDB.open(databaseName, 1);",
                            "    request.onupgradeneeded = () => {};",
                            "    request.onsuccess = () => {",
                            "      if (finished) return;",
                            "      finished = true;",
                            "      clearTimeout(timeout);",
                            "      try { request.result.close(); } catch (_) {}",
                            "      emit(labelPrefix + '.open.success', { database: databaseName });",
                            "      resolve();",
                            "    };",
                            "    request.onerror = () => {",
                            "      if (finished) return;",
                            "      finished = true;",
                            "      clearTimeout(timeout);",
                            "      emit(labelPrefix + '.open.error', errorFields(request.error));",
                            "      resolve();",
                            "    };",
                            "  } catch (error) {",
                            "    if (finished) return;",
                            "    finished = true;",
                            "    clearTimeout(timeout);",
                            "    emit(labelPrefix + '.open.error', errorFields(error));",
                            "    resolve();",
                            "  }",
                            "});",
                            "self.onmessage = async function (event) {",
                            "  if (!event || !event.data || event.data.type !== 'run') { return; }",
                            "  try {",
                            "    emit('storage_canary.worker.href', { value: self.location.href });",
                            "    emit('storage_canary.worker.origin', { value: String(self.location.origin) });",
                            "  } catch (error) {",
                            "    emit('storage_canary.worker.origin', errorFields(error));",
                            "  }",
                            "  await openIndexedDb('storage_canary.worker.indexeddb', 'fort-ios-storage-canary-worker');",
                            "  self.postMessage({ kind: 'done' });",
                            "};",
                        ].join("\n");

                        let objectUrl = "";
                        try {
                            objectUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
                            const worker = new Worker(objectUrl);
                            emit("storage_canary.worker.create.success", { mode: "blob" });

                            let finished = false;
                            const finish = () => {
                                if (finished) {
                                    return;
                                }
                                finished = true;
                                clearTimeout(timeout);
                                worker.terminate();
                                if (objectUrl) {
                                    URL.revokeObjectURL(objectUrl);
                                }
                                finishProbe("worker");
                            };
                            const timeout = setTimeout(() => {
                                if (finished) {
                                    return;
                                }
                                emit("storage_canary.worker.create.error", {
                                    name: "Timeout",
                                    message: "Worker did not finish within 5000ms",
                                });
                                emit("storage_canary.worker.indexeddb.open.error", {
                                    name: "Timeout",
                                    message: "Worker did not finish within 5000ms",
                                });
                                finish();
                            }, 5000);

                            worker.onmessage = (event) => {
                                if (!event || !event.data) {
                                    return;
                                }

                                if (event.data.kind === "log") {
                                    emit(event.data.label, event.data.fields || {});
                                    return;
                                }

                                if (event.data.kind === "done") {
                                    finish();
                                }
                            };

                            worker.onerror = (event) => {
                                emit("storage_canary.worker.create.error", {
                                    name: event && event.type ? event.type : "WorkerError",
                                    message: event && event.message ? event.message : "Worker execution failed",
                                });
                                finish();
                            };

                            worker.postMessage({ type: "run" });
                        } catch (error) {
                            emit("storage_canary.worker.create.error", errorFields(error));
                            if (objectUrl) {
                                URL.revokeObjectURL(objectUrl);
                            }
                            finishProbe("worker");
                        }
                    };

                    emit("storage_canary.page.href", { value: location.href });
                    emit("storage_canary.page.origin", { value: String(location.origin) });
                    emit("storage_canary.page.is_secure_context", { value: Boolean(globalThis.isSecureContext) });

                    masterTimer = setTimeout(() => {
                        finishAll("timeout", {
                            mainComplete: probeState.main,
                            workerComplete: probeState.worker,
                        });
                    }, 8000);

                    try {
                        openIndexedDb(
                            "storage_canary.main.indexeddb",
                            "fort-ios-storage-canary-main",
                            globalThis.indexedDB,
                            () => finishProbe("main")
                        );
                    } catch (error) {
                        emit("storage_canary.main.indexeddb.open.error", errorFields(error));
                        finishProbe("main");
                    }

                    try {
                        startWorkerProbe();
                    } catch (error) {
                        emit("storage_canary.worker.create.error", errorFields(error));
                        finishProbe("worker");
                    }

                    Promise.resolve().catch((error) => {
                        emit("storage_canary.script.error", errorFields(error));
                        finishAll("script_error");
                    });

                    return "\#(startedMarker)";
                })();
                """#
        }
}
