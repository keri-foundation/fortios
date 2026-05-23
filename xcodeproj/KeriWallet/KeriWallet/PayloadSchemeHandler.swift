import Foundation
import WebKit

enum PayloadSchemeError: Error {
    case invalidURL
    case disallowedPath
    case missingResource
    case invalidPayloadManifest
    case resourceTooLarge
}

private struct PayloadResourceLoadResult {
    let data: Data
    let mime: String
    let headers: [String: String]
    let normalizedPath: String
}

final class PayloadSchemeHandler: NSObject, WKURLSchemeHandler {
    private let maxBytes: Int
    /// Overrides the default Bundle.main-derived payload directory. Inject a
    /// temporary directory URL in unit tests to avoid requiring a real app bundle.
    private let payloadDirectory: URL?
    private let fileManager: FileManager
    private var didValidatePayloadManifest = false

    init(
        maxBytes: Int = AppConfig.Payload.maxResourceBytes,
        payloadDirectory: URL? = nil,
        fileManager: FileManager = .default
    ) {
        self.maxBytes = maxBytes
        self.payloadDirectory = payloadDirectory
        self.fileManager = fileManager
        super.init()
    }

    private var resolvedBaseURL: URL? {
        if let dir = payloadDirectory { return dir }
        return Bundle.main.resourceURL?.appendingPathComponent(
            AppConfig.Payload.bundleSubdirectory, isDirectory: true)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let requestID = String(UUID().uuidString.prefix(8)).lowercased()
        let startedAt = Date()

        guard let url = urlSchemeTask.request.url else {
            logRequestError(
                requestID: requestID,
                startedAt: startedAt,
                errorKind: "invalid_url",
                errorDescription: String(describing: PayloadSchemeError.invalidURL))
            urlSchemeTask.didFailWithError(PayloadSchemeError.invalidURL)
            return
        }

        let requestPath = requestPath(for: url)

        logRequestStart(requestID: requestID, url: url, requestPath: requestPath)

        do {
            let result = try loadResourceDetails(for: url)

            guard
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: 200,
                    httpVersion: AppConfig.HTTP.version,
                    headerFields: result.headers
                )
            else {
                logRequestError(
                    requestID: requestID,
                    startedAt: startedAt,
                    url: url,
                    requestPath: requestPath,
                    normalizedPath: nil,
                    errorKind: "response_construction_failed",
                    errorDescription: String(describing: PayloadSchemeError.missingResource))
                urlSchemeTask.didFailWithError(PayloadSchemeError.missingResource)
                return
            }

            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(result.data)
            urlSchemeTask.didFinish()

            logRequestSuccess(
                requestID: requestID,
                startedAt: startedAt,
                url: url,
                requestPath: requestPath,
                result: result,
                statusCode: response.statusCode)
        } catch {
            let normalizedPath = normalizedPathIfAvailable(from: error, url: url)
            logRequestError(
                requestID: requestID,
                startedAt: startedAt,
                url: url,
                requestPath: requestPath,
                normalizedPath: normalizedPath,
                errorKind: errorKind(for: error),
                errorDescription: String(describing: error))
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // No async work to cancel.
    }

    /// Exposed as `internal` (not `private`) so `@testable import KeriWallet`
    /// can exercise the full request-handling logic without requiring a live
    /// `WKURLSchemeTask`. Production callers use the `WKURLSchemeHandler` protocol.
    func loadResource(for url: URL) throws -> (Data, String, [String: String]) {
        let result = try loadResourceDetails(for: url)
        return (result.data, result.mime, result.headers)
    }

    private func loadResourceDetails(for url: URL) throws -> PayloadResourceLoadResult {
        guard url.scheme?.lowercased() == AppConfig.Scheme.name else {
            throw PayloadSchemeError.invalidURL
        }

        let relPath = try normalizedRelativePath(urlPath: url.path)

        guard let baseURL = resolvedBaseURL else {
            throw PayloadSchemeError.missingResource
        }

        try validatePayloadManifestIfNeeded(baseURL: baseURL)

        let fileURL = baseURL.appendingPathComponent(relPath, isDirectory: false)

        guard fileManager.fileExists(atPath: fileURL.path) else {
            throw PayloadSchemeError.missingResource
        }

        let attrs = try fileManager.attributesOfItem(atPath: fileURL.path)
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        if size > maxBytes {
            throw PayloadSchemeError.resourceTooLarge
        }

        let data = try Data(contentsOf: fileURL)
        let mime = AppConfig.MIME.contentType(for: fileURL.pathExtension)
        let contentTypeHeader = AppConfig.MIME.isText(mime) ? "\(mime); charset=utf-8" : mime
        let headers: [String: String] = [
            "Content-Type": contentTypeHeader,
            "Content-Length": "\(data.count)"
        ]
        // Append cross-origin isolation headers (COOP/COEP/CORP).
        var allHeaders = headers
        for (key, value) in AppConfig.HTTP.crossOriginHeaders {
            allHeaders[key] = value
        }

        return PayloadResourceLoadResult(
            data: data,
            mime: mime,
            headers: allHeaders,
            normalizedPath: relPath)
    }

    private func validatePayloadManifestIfNeeded(baseURL: URL) throws {
        if didValidatePayloadManifest {
            return
        }

        let manifestURL = baseURL.appendingPathComponent("build-manifest.json", isDirectory: false)

        guard fileManager.fileExists(atPath: manifestURL.path) else {
            throw PayloadSchemeError.invalidPayloadManifest
        }

        let data = try Data(contentsOf: manifestURL)
        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let producer = json["producer"] as? String,
            let payloadProfile = json["payload_profile"] as? String,
            let entryDocument = json["entry_document"] as? String,
            producer == AppConfig.Payload.requiredProducer,
            payloadProfile == AppConfig.Payload.requiredProfile,
            entryDocument == AppConfig.Payload.requiredEntryDocument
        else {
            throw PayloadSchemeError.invalidPayloadManifest
        }

        didValidatePayloadManifest = true
    }

    private func normalizedRelativePath(urlPath: String) throws -> String {
        let decoded = urlPath.removingPercentEncoding ?? urlPath
        let trimmed = decoded.hasPrefix("/") ? String(decoded.dropFirst()) : decoded

        let parts = trimmed.split(separator: "/", omittingEmptySubsequences: true)
        if parts.isEmpty {
            return AppConfig.Scheme.defaultIndexPath
        }

        for part in parts {
            if part == "." || part == ".." {
                throw PayloadSchemeError.disallowedPath
            }
        }

        return parts.joined(separator: "/")
    }

    private func requestPath(for url: URL) -> String {
        url.path.isEmpty ? "/" : url.path
    }

    private func isInitialDocumentPath(_ path: String) -> Bool {
        path == "/" || path == AppConfig.Scheme.defaultIndexPath
            || path == "/\(AppConfig.Scheme.defaultIndexPath)"
    }

    private func normalizedPathIfAvailable(from error: Error, url: URL) -> String? {
        try? normalizedRelativePath(urlPath: url.path)
    }

    private func logRequestStart(requestID: String, url: URL, requestPath: String) {
        logRequest(
            levelForPath(requestPath),
            label: "scheme_handler.request.start",
            fields: [
                "request_id": requestID,
                "url": url.absoluteString,
                "scheme": url.scheme ?? "",
                "host": url.host ?? "",
                "path": requestPath,
            ])
        logTraceAssetIfNeeded(
            phase: "start",
            requestID: requestID,
            url: url,
            requestPath: requestPath,
            normalizedPath: nil,
            mime: nil,
            bytes: nil,
            errorKind: nil)
    }

    private func logRequestSuccess(
        requestID: String,
        startedAt: Date,
        url: URL,
        requestPath: String,
        result: PayloadResourceLoadResult,
        statusCode: Int
    ) {
        logRequest(
            levelForPath(requestPath),
            label: "scheme_handler.request.success",
            fields: [
                "request_id": requestID,
                "url": url.absoluteString,
                "scheme": url.scheme ?? "",
                "host": url.host ?? "",
                "path": requestPath,
                "normalized_path": result.normalizedPath,
                "mime": result.mime,
                "bytes": String(result.data.count),
                "duration_ms": String(durationMilliseconds(since: startedAt)),
                "status": String(statusCode),
                "response_headers": summarizedHeaders(result.headers),
            ])
        logTraceAssetIfNeeded(
            phase: "success",
            requestID: requestID,
            url: url,
            requestPath: requestPath,
            normalizedPath: result.normalizedPath,
            mime: result.mime,
            bytes: result.data.count,
            errorKind: nil)
    }

    private func logRequestError(
        requestID: String,
        startedAt: Date,
        url: URL? = nil,
        requestPath: String? = nil,
        normalizedPath: String? = nil,
        errorKind: String,
        errorDescription: String
    ) {
        let path = requestPath ?? url?.path ?? ""
        logRequest(
            levelForPath(path),
            label: "scheme_handler.request.error",
            fields: [
                "request_id": requestID,
                "url": url?.absoluteString ?? "",
                "scheme": url?.scheme ?? "",
                "host": url?.host ?? "",
                "path": path,
                "normalized_path": normalizedPath ?? "",
                "duration_ms": String(durationMilliseconds(since: startedAt)),
                "status": "error",
                "error_kind": errorKind,
                "error": errorDescription,
            ])
        logTraceAssetIfNeeded(
            phase: "error",
            requestID: requestID,
            url: url,
            requestPath: path,
            normalizedPath: normalizedPath,
            mime: nil,
            bytes: nil,
            errorKind: errorKind)
    }

    private func logTraceAssetIfNeeded(
        phase: String,
        requestID: String,
        url: URL?,
        requestPath: String,
        normalizedPath: String?,
        mime: String?,
        bytes: Int?,
        errorKind: String?
    ) {
        guard WKRuntimeTraceAssetLog.isEnabled else { return }

        let candidatePath = normalizedPath ?? requestPath
        guard let assetKind = WKRuntimeTraceAssetLog.assetKind(for: candidatePath) else { return }

        let label = WKRuntimeTraceAssetLog.label(for: assetKind)
        let fields = [
            "request_id": requestID,
            "phase": phase,
            "asset_kind": assetKind,
            "url": url?.absoluteString ?? "",
            "path": requestPath,
            "normalized_path": normalizedPath ?? "",
            "mime": mime ?? "",
            "bytes": bytes.map(String.init) ?? "",
            "error_kind": errorKind ?? "",
        ]
            .filter { !$0.value.isEmpty }
            .sorted { $0.key < $1.key }
            .map { key, value in "\(key)=\(quoted(value))" }
            .joined(separator: " ")

        let message = "[SchemeHandler] \(label) \(fields)"

        switch phase {
        case "error":
            AppLogger.warning(message, category: AppConfig.Log.schemeHandler)
        default:
            AppLogger.info(message, category: AppConfig.Log.schemeHandler)
        }
    }

    private func errorKind(for error: Error) -> String {
        switch error {
        case PayloadSchemeError.invalidURL:
            return "invalid_url"
        case PayloadSchemeError.disallowedPath:
            return "disallowed_path"
        case PayloadSchemeError.missingResource:
            return "missing_resource"
        case PayloadSchemeError.invalidPayloadManifest:
            return "invalid_payload_manifest"
        case PayloadSchemeError.resourceTooLarge:
            return "resource_too_large"
        default:
            return String(describing: type(of: error))
        }
    }

    private func durationMilliseconds(since startedAt: Date) -> Int {
        max(0, Int(Date().timeIntervalSince(startedAt) * 1000))
    }

    private func summarizedHeaders(_ headers: [String: String]) -> String {
        let orderedKeys = [
            "Content-Type",
            "Content-Length",
            "Cross-Origin-Opener-Policy",
            "Cross-Origin-Embedder-Policy",
            "Cross-Origin-Resource-Policy",
        ]

        return orderedKeys.compactMap { key in
            guard let value = headers[key] else { return nil }
            return "\(key)=\(quoted(value))"
        }.joined(separator: " ")
    }

    private func levelForPath(_ path: String) -> LogLevel {
        isInitialDocumentPath(path) ? .notice : .debug
    }

    private func logRequest(_ level: LogLevel, label: String, fields: [String: String]) {
        let message = (["[SchemeHandler]", label] + fields
            .filter { !$0.value.isEmpty }
            .sorted { $0.key < $1.key }
            .map { key, value in "\(key)=\(quoted(value))" })
            .joined(separator: " ")

        switch level {
        case .verbose:
            AppLogger.verbose(message, category: AppConfig.Log.schemeHandler)
        case .debug:
            AppLogger.debug(message, category: AppConfig.Log.schemeHandler)
        case .info:
            AppLogger.info(message, category: AppConfig.Log.schemeHandler)
        case .notice:
            AppLogger.notice(message, category: AppConfig.Log.schemeHandler)
        case .warning:
            AppLogger.warning(message, category: AppConfig.Log.schemeHandler)
        case .error:
            AppLogger.error(message, category: AppConfig.Log.schemeHandler)
        }
    }

    private func quoted(_ value: String) -> String {
        let escapedValue = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escapedValue)\""
    }
}

private enum WKRuntimeTraceAssetLog {
    private static let environmentKey = "FORTIOS_WK_TRACE"

    static var isEnabled: Bool {
        #if DEBUG
            let environment = ProcessInfo.processInfo.environment
            if let flag = environment[environmentKey]?.lowercased() {
                return ["1", "true", "yes"].contains(flag)
            }

            let arguments = ProcessInfo.processInfo.arguments
            return arguments.contains("-FORTIOS_WK_TRACE")
                || arguments.contains("\(environmentKey)=1")
        #else
            return false
        #endif
    }

    static func assetKind(for path: String) -> String? {
        let lowercased = path.lowercased()

        if lowercased.contains("wallet-worker.py") {
            return "worker_python"
        }
        if lowercased.contains("pyscript-ci.toml") {
            return "pyodide_config"
        }
        if lowercased.contains("pyodide") {
            return "pyodide_runtime"
        }
        if lowercased.hasSuffix(".wasm") {
            return "wasm"
        }
        if lowercased.hasSuffix(".whl") {
            return "wheel"
        }
        if lowercased.hasSuffix(".py") {
            return "python"
        }
        if lowercased.hasSuffix(".js") || lowercased.hasSuffix(".mjs") {
            return "javascript"
        }

        return nil
    }

    static func label(for assetKind: String) -> String {
        switch assetKind {
        case "pyodide_config", "pyodide_runtime", "wasm", "wheel", "python":
            return "wk_trace.pyodide_asset"
        default:
            return "wk_trace.scheme_asset"
        }
    }
}
