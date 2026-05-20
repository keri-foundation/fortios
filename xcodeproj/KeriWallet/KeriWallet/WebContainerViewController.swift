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
            policy: WebNavigationPolicy(allowedLoopbackOrigin: initialPayloadTarget.loopbackOrigin))
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

        loadInitialURL(webView: webView, url: initialPayloadTarget.url)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        AppConfig.Appearance.statusBarStyle
    }

    deinit {
        loopbackServer?.stop()
        webView?.configuration.userContentController.removeScriptMessageHandler(
            forName: AppConfig.Bridge.handlerName)
    }

    private func loadInitialURL(webView: WKWebView, url: URL) {
        AppLogger.notice(
            "[WebContainer] loading initial payload entry=\(url.absoluteString)",
            category: AppConfig.Log.webContainer)
        webView.load(URLRequest(url: url))
    }

    private func resolveInitialPayloadTarget() -> InitialPayloadTarget {
        if AppConfig.Loopback.isEnabled {
            do {
                let server = try LocalLoopbackPayloadServer()
                let loopbackOrigin = try server.start()
                let url = loopbackOrigin.entryURL

                AppLogger.notice(
                    "[Loopback] loopback.load.url url=\"\(url.absoluteString)\"",
                    category: AppConfig.Log.loopback)

                return InitialPayloadTarget(
                    url: url,
                    server: server,
                    loopbackOrigin: loopbackOrigin)
            } catch {
                AppLogger.error(
                    "[Loopback] loopback.server.error error_kind=\"startup_failed\" error=\"\(error.localizedDescription)\" fallback=\"app_scheme\"",
                    error: error,
                    category: AppConfig.Log.loopback)
            }
        }

        guard let url = URL(string: AppConfig.Scheme.entryURL) else {
            AppLogger.error(
                "[WebContainer] invalid initial URL", category: AppConfig.Log.webContainer)
            return InitialPayloadTarget(url: URL(fileURLWithPath: "/"), server: nil, loopbackOrigin: nil)
        }

        return InitialPayloadTarget(url: url, server: nil, loopbackOrigin: nil)
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
