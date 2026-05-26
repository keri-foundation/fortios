//
//  AppConfig.swift
//
//  Single source of truth for all compile-time constants in KeriWallet.
//  Caseless enums prevent accidental instantiation — every value is `static let`.
//
//  This file consolidates magic numbers and duplicated string literals from:
//  PayloadSchemeHandler, WebContainerViewController, WebNavigationPolicy,
//  WebBridge, and AppLogger. If you need to change a scheme name, handler name,
//  MIME mapping, or brand color — change it here, once.
//

import UIKit

// MARK: - AppConfig

enum AppConfig {

    // MARK: - URL Scheme

    enum Scheme {
        /// Custom URL scheme registered with WKWebView for serving bundled assets.
        static let name = "app"
        /// Initial URL loaded by the web container.
        static let entryURL = "app://local/index.html"
        /// Schemes the navigation policy allows. `about` is needed for `about:blank`.
        static let allowedSchemes: Set<String> = ["app", "about"]
        /// The only `about:` URL we permit — WebKit uses it internally.
        static let aboutBlankURL = "about:blank"
        /// Default `index.html` path returned when the URL path is empty (root `/`).
        static let defaultIndexPath = "index.html"
    }

    enum Loopback {
        enum OriginMode {
            case appLocal
            case loopback
        }

        struct OriginSelection {
            let mode: OriginMode
            let reason: String
        }

        static let originModeEnvironmentKey = "FORTIOS_ORIGIN_MODE"
        static let environmentKey = "FORTIOS_LOOPBACK_ORIGIN"
        static let disableWorkaroundEnvironmentKey = "FORTIOS_DISABLE_LOOPBACK_WORKAROUND"
        static let launchArgument = "--fortios-loopback-origin"
        static let disableWorkaroundLaunchArgument = "--fortios-disable-loopback-workaround"
        static let scheme = "http"
        static let host = "127.0.0.1"
        static let pathPrefixSegment = "_fortios"

        static var isEnabled: Bool {
            originSelection.mode == .loopback
        }

        static var originSelection: OriginSelection {
            let environment = ProcessInfo.processInfo.environment
            let arguments = ProcessInfo.processInfo.arguments

            if let requestedMode = environment[originModeEnvironmentKey]?.lowercased() {
                if requestedMode == "app-local" || requestedMode == "app_local" {
                    return OriginSelection(mode: .appLocal, reason: "explicit_origin_mode_app_local")
                }
                if requestedMode == "loopback" {
                    #if DEBUG
                    return OriginSelection(mode: .loopback, reason: "explicit_origin_mode_loopback")
                    #else
                        return OriginSelection(
                            mode: .appLocal,
                            reason: "explicit_origin_mode_loopback_unavailable_release")
                    #endif
                }
                return OriginSelection(mode: .appLocal, reason: "invalid_origin_mode_app_local")
            }

            if environmentFlagIsEnabled(disableWorkaroundEnvironmentKey)
                || arguments.contains(disableWorkaroundLaunchArgument)
                || arguments.contains("\(disableWorkaroundEnvironmentKey)=1")
            {
                return OriginSelection(mode: .appLocal, reason: "legacy_loopback_opt_out")
            }

            if environmentFlagIsEnabled(environmentKey)
                || arguments.contains(launchArgument)
                || arguments.contains("\(environmentKey)=1")
            {
                #if DEBUG
                return OriginSelection(mode: .loopback, reason: "legacy_loopback_opt_in")
                #else
                    return OriginSelection(
                        mode: .appLocal,
                        reason: "legacy_loopback_opt_in_unavailable_release")
                #endif
            }

            return OriginSelection(mode: .appLocal, reason: "app_local_default")
        }

        private static func environmentFlagIsEnabled(_ key: String) -> Bool {
            guard let flag = ProcessInfo.processInfo.environment[key]?.lowercased() else {
                return false
            }
            return ["1", "true", "yes"].contains(flag)
        }
    }

    enum FileOrigin {
        #if DEBUG
            static let environmentKey = "FORTIOS_FILE_URL_ORIGIN"
            static let launchArgument = "--fortios-file-url-origin"

            static var isEnabled: Bool {
                let environment = ProcessInfo.processInfo.environment
                if let flag = environment[environmentKey]?.lowercased(),
                    ["1", "true", "yes"].contains(flag)
                {
                    return true
                }

                let arguments = ProcessInfo.processInfo.arguments
                return arguments.contains(launchArgument)
                    || arguments.contains("\(environmentKey)=1")
            }
        #else
            static var isEnabled: Bool {
                false
            }
        #endif
    }

    // MARK: - JS ↔ Swift Bridge

    enum Bridge {
        /// WKScriptMessageHandler name — must match JS: `webkit.messageHandlers.bridge`.
        /// Delegates to the auto-generated `BridgeContract` for cross-language safety.
        static let handlerName = BridgeContract.handlerName
    }

    // MARK: - Bundled Web Payload

    enum Payload {
        /// Bundle subdirectory containing the Vite `dist/` output (synced by `sync-payload.sh`).
        static let bundleSubdirectory = "WebPayload"
        /// Wrapper payload provenance expected by the native host.
        static let requiredProducer = "fortweb-shared"
        static let requiredProfile = "product-shell"
        static let requiredEntryDocument = "fortweb/app/index.html"
        /// Maximum size (in bytes) of any single resource served by the scheme handler.
        /// 20 MiB — generous ceiling; Pyodide `.wasm` is ~12 MiB.
        static let maxResourceBytes = 20 * 1024 * 1024
    }

    enum RuntimeOriginContract {
        static let globalName = "__FORT_RUNTIME_ORIGIN__"
        static let schema = "fortweb.runtime-origin.v1"
        static let version = 1
        static let platform = "ios-wkwebview"
        static let mode = "bundled-offline"
        static let documentOrigin = "app://local"
        static let appBaseURL = "app://local"
        static let workerURL = "app://local/fortweb/app/runtime/wallet-worker.py"
        static let configURL = "app://local/fortweb/pyscript-ci.toml"
        static let storageNamespace = "fortweb-ios-wkwebview-app-local"
        static let originPartition = "app://local"
    }

    // MARK: - HTTP Response

    enum HTTP {
        /// HTTP version used in synthesized `HTTPURLResponse`.
        static let version = "HTTP/1.1"

        /// Cross-origin isolation headers required by SharedArrayBuffer / Pyodide threading.
        static let crossOriginHeaders: [(String, String)] = [
            ("Cross-Origin-Opener-Policy", "same-origin"),
            ("Cross-Origin-Embedder-Policy", "require-corp"),
            ("Cross-Origin-Resource-Policy", "cross-origin")
        ]
    }

    // MARK: - MIME Types

    enum MIME {
        /// Extension → MIME mapping. Add new entries here rather than in a switch.
        private static let mimeTypes: [String: String] = [
            "html": "text/html",
            "js": "text/javascript",
            "mjs": "text/javascript",
            "css": "text/css",
            "json": "application/json",
            "wasm": "application/wasm",
            "woff2": "font/woff2",
            "png": "image/png",
            "svg": "image/svg+xml",
            "whl": "application/zip",
            "py": "text/plain",
            "toml": "application/toml",
            "zip": "application/zip"
        ]

        /// Map a file extension to its MIME content-type.
        static func contentType(for ext: String) -> String {
            mimeTypes[ext.lowercased()] ?? "application/octet-stream"
        }

        /// Whether a MIME type should get a `; charset=utf-8` suffix.
        static func isText(_ mime: String) -> Bool {
            mime.hasPrefix("text/") || mime == "application/json"
                || mime == "application/javascript"
        }
    }

    // MARK: - Logging

    enum Log {
        /// Reverse-DNS subsystem for OSLog. Matches `PRODUCT_BUNDLE_IDENTIFIER`.
        static let subsystem = "com.kerifoundation.wallet"
        /// Default category used when none is specified.
        static let defaultCategory = "app"

        // Per-module categories — use these at call sites instead of bare strings.
        static let schemeHandler = "SchemeHandler"
        static let webBridge = "WebBridge"
        static let webContainer = "WebContainer"
        static let webNav = "WebNav"
        static let loopback = "WebContainer"
    }

    // MARK: - Brand Colors

    /// Background colors that match the CSS custom properties in `index.html`.
    /// Used by `WebContainerViewController` to set `underPageBackgroundColor`
    /// so the WKWebView never flashes white before the HTML paints.
    enum Brand {
        // Dark mode: --bg-dark: #0d0d0f  → RGB(13, 13, 15)
        static let darkBackground = UIColor(
            red: 13.0 / 255.0, green: 13.0 / 255.0, blue: 15.0 / 255.0, alpha: 1)
        // Light mode: --ref-neutral-10: #f7f8f4 → RGB(247, 248, 244)
        static let lightBackground = UIColor(
            red: 247.0 / 255.0, green: 248.0 / 255.0, blue: 244.0 / 255.0, alpha: 1)
    }

    // MARK: - Host Appearance

    /// The FortWeb-backed shell is currently light-only. Keep the native container,
    /// safe-area background, and status bar in the matching host appearance until
    /// the web payload exposes an appearance bridge to native.
    enum Appearance {
        static let interfaceStyle: UIUserInterfaceStyle = .light
        static let statusBarStyle: UIStatusBarStyle = .darkContent
        static let backgroundColor = Brand.lightBackground
    }
}
