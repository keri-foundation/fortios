import Foundation
import WebKit

enum WebBridgeMessageType: String, Decodable {
    case jsError = "js_error"
    case unhandledRejection = "unhandled_rejection"
    case log
    case lifecycle
    case cryptoResult = "crypto_result"
}

/// Typed payload for crypto_result messages posted by JS after a Python op completes.
struct CryptoResultPayload: Decodable {
    /// Correlates to the `id` field of the originating WorkerCommand.
    let id: String
    /// JSON-encoded WorkerOutbound value (blake3_result, sign_result, verify_result, error).
    let message: String
    /// Non-nil when the operation failed; mirrors WorkerOutbound.error.
    let error: String?
}

struct WebBridgeEnvelope: Decodable {
    let type: WebBridgeMessageType
    let timestamp: String
    let message: String

    let stack: String?
    let source: String?
    let line: Int?
    let col: Int?
}

struct BridgeLogDisposition: Equatable {
    let level: LogLevel
    let message: String
}

struct FortWebRuntimeDiagnostic: Equatable {
    let event: String
    let level: String?
    let state: String?

    static func parse(_ message: String) -> FortWebRuntimeDiagnostic? {
        guard message.hasPrefix("[fortweb.runtime]") else { return nil }

        let event = field("event", in: message) ?? ""
        guard !event.isEmpty else { return nil }

        return FortWebRuntimeDiagnostic(
            event: event,
            level: field("level", in: message),
            state: field("state", in: message))
    }

    private static func field(_ name: String, in message: String) -> String? {
        let quotedPattern = "\(name)=\""
        if let quotedRange = message.range(of: quotedPattern) {
            let valueStart = quotedRange.upperBound
            if let end = message[valueStart...].firstIndex(of: "\"") {
                return String(message[valueStart..<end])
            }
        }

        let plainPattern = "\(name)="
        if let plainRange = message.range(of: plainPattern) {
            let valueStart = plainRange.upperBound
            let suffix = message[valueStart...]
            let terminator = suffix.firstIndex(where: { $0.isWhitespace }) ?? suffix.endIndex
            return String(suffix[..<terminator])
        }

        return nil
    }
}

final class WebBridge: NSObject, WKScriptMessageHandler {
    /// Called on the main thread whenever a `crypto_result` message arrives from JS.
    /// Set this before the WebView loads its first URL.
    var onCryptoResult: ((CryptoResultPayload) -> Void)?
    private var hasLoggedFirstReceipt = false

    private static let lifecycleNoticeStates: Set<String> = [
        "boot",
        "ready"
    ]

    private static let maxLoggedMessageLength = 512
    private static let maxLoggedStackLength = 1024

    static func logDisposition(for envelope: WebBridgeEnvelope) -> BridgeLogDisposition {
        switch envelope.type {
        case .jsError, .unhandledRejection:
            return javaScriptErrorDisposition(for: envelope)
        case .log:
            if envelope.message.hasPrefix("[storage_canary]") {
                return storageCanaryDisposition(for: envelope.message)
            }

            if envelope.message.hasPrefix("worker.error") {
                return workerDisposition(label: "worker.error", message: envelope.message)
            }

            if envelope.message.hasPrefix("worker.messageerror") {
                return workerDisposition(label: "worker.messageerror", message: envelope.message)
            }

            if let diagnostic = FortWebRuntimeDiagnostic.parse(envelope.message) {
                return logDisposition(for: diagnostic, originalMessage: envelope.message)
            }

            let lowercased = envelope.message.lowercased()
            if lowercased.contains("error") || lowercased.contains("exception")
                || lowercased.contains("fatal") {
                return BridgeLogDisposition(
                    level: .error,
                    message: "[WebBridge] log escalated to error: \(envelope.message)")
            }

            if lowercased.contains("warn") || lowercased.contains("failed")
                || lowercased.contains("failure") {
                return BridgeLogDisposition(
                    level: .warning,
                    message: "[WebBridge] log escalated to warning: \(envelope.message)")
            }

            return BridgeLogDisposition(
                level: .info,
                message: "[WebBridge] log: \(envelope.message)")
        case .lifecycle:
            let state = (FortWebRuntimeDiagnostic.parse(envelope.message)?.state ?? envelope.message)
                .lowercased()
            if lifecycleNoticeStates.contains(state) {
                return BridgeLogDisposition(
                    level: .notice,
                    message: "[WebBridge] lifecycle: \(state)")
            }

            return BridgeLogDisposition(
                level: .warning,
                message: "[WebBridge] lifecycle drift: \(envelope.message)")
        case .cryptoResult:
            return BridgeLogDisposition(
                level: .info,
                message: "[WebBridge] crypto_result received")
        }
    }

    static func cryptoResultDisposition(for payload: CryptoResultPayload) -> BridgeLogDisposition {
        if let error = payload.error, !error.isEmpty {
            return BridgeLogDisposition(
                level: .warning,
                message: "[WebBridge] crypto_result id=\(payload.id) error")
        }

        return BridgeLogDisposition(
            level: .info,
            message: "[WebBridge] crypto_result id=\(payload.id) ok")
    }

    private static func logDisposition(
        for diagnostic: FortWebRuntimeDiagnostic,
        originalMessage: String
    ) -> BridgeLogDisposition {
        switch diagnostic.level?.lowercased() {
        case "error":
            return BridgeLogDisposition(
                level: .error,
                message: "[WebBridge] log escalated to error: \(originalMessage)")
        case "warning":
            return BridgeLogDisposition(
                level: .warning,
                message: "[WebBridge] log escalated to warning: \(originalMessage)")
        case "info":
            if diagnostic.event == "request_start" || diagnostic.event == "request_end" {
                return BridgeLogDisposition(
                    level: .debug,
                    message: "[WebBridge] runtime: \(originalMessage)")
            }
        default:
            break
        }

        return BridgeLogDisposition(
            level: .info,
            message: "[WebBridge] runtime: \(originalMessage)")
    }

    private static func storageCanaryDisposition(for message: String) -> BridgeLogDisposition {
        if message.contains(".error") {
            return BridgeLogDisposition(
                level: .error,
                message: "[WebBridge] \(message)")
        }

        return BridgeLogDisposition(
            level: .notice,
            message: "[WebBridge] \(message)")
    }

    private static func javaScriptErrorDisposition(for envelope: WebBridgeEnvelope)
        -> BridgeLogDisposition
    {
        let label = envelope.type == .jsError
            ? "js_error.window" : "js_error.unhandled_rejection"
        var fields: [String: String] = [
            "event_type": envelope.type.rawValue,
            "message": truncated(envelope.message, maxLength: maxLoggedMessageLength),
        ]

        if let source = envelope.source, !source.isEmpty {
            fields["source"] = source
        }

        if let line = envelope.line {
            fields["line"] = String(line)
        }

        if let column = envelope.col {
            fields["column"] = String(column)
        }

        if let stack = envelope.stack, !stack.isEmpty {
            let truncatedStack = truncated(stack, maxLength: maxLoggedStackLength)
            fields["stack"] = truncatedStack
            if truncatedStack != stack {
                fields["stack_truncated"] = "true"
            }
        }

        return BridgeLogDisposition(
            level: .error,
            message: "[WebBridge] \(label) \(formattedFields(fields))")
    }

    private static func workerDisposition(label: String, message: String) -> BridgeLogDisposition {
        let fields = formattedFields([
            "event_type": label,
            "message": truncated(message, maxLength: maxLoggedMessageLength),
        ])

        return BridgeLogDisposition(
            level: .error,
            message: "[WebBridge] \(label) \(fields)"
        )
    }

    private static func formattedFields(_ fields: [String: String]) -> String {
        fields
            .filter { !$0.value.isEmpty }
            .sorted { $0.key < $1.key }
            .map { key, value in "\(key)=\(quoted(value))" }
            .joined(separator: " ")
    }

    private static func truncated(_ value: String, maxLength: Int) -> String {
        guard value.count > maxLength else {
            return value
        }

        return String(value.prefix(maxLength))
    }

    private static func quoted(_ value: String) -> String {
        let escapedValue = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escapedValue)\""
    }

    override init() {
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
    ) {
        guard message.name == AppConfig.Bridge.handlerName else {
            AppLogger.error(
                "[WebBridge] unexpected handler name: \(message.name)", category: AppConfig.Log.webBridge)
            return
        }

        guard let envelope = decodeEnvelope(body: message.body) else {
            AppLogger.warning("[WebBridge] ignored malformed message", category: AppConfig.Log.webBridge)
            return
        }

        logFirstReceiptIfNeeded(envelope)

        switch envelope.type {
        case .jsError, .unhandledRejection, .log, .lifecycle:
            log(disposition: Self.logDisposition(for: envelope))
        case .cryptoResult:
            if let callback = onCryptoResult {
                // Re-decode with the narrower CryptoResultPayload type
                if let dict = message.body as? [String: Any],
                    let data = try? JSONSerialization.data(withJSONObject: dict),
                    let payload = try? JSONDecoder().decode(CryptoResultPayload.self, from: data) {
                    log(disposition: Self.cryptoResultDisposition(for: payload))
                    callback(payload)
                } else {
                    AppLogger.warning(
                        "[WebBridge] crypto_result: failed to decode CryptoResultPayload",
                        category: AppConfig.Log.webBridge)
                }
            } else {
                AppLogger.info(
                    "[WebBridge] crypto_result (no callback registered)", category: AppConfig.Log.webBridge)
            }
        }
    }

    private func decodeEnvelope(body: Any) -> WebBridgeEnvelope? {
        if let dict = body as? [String: Any] {
            return decodeFromJSONObject(dict)
        }

        if let str = body as? String,
            let data = str.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data),
            let dict = obj as? [String: Any] {
            return decodeFromJSONObject(dict)
        }

        return nil
    }

    private func decodeFromJSONObject(_ obj: [String: Any]) -> WebBridgeEnvelope? {
        guard JSONSerialization.isValidJSONObject(obj),
            let data = try? JSONSerialization.data(withJSONObject: obj)
        else {
            return nil
        }

        return try? JSONDecoder().decode(WebBridgeEnvelope.self, from: data)
    }

    private func logFirstReceiptIfNeeded(_ envelope: WebBridgeEnvelope) {
        guard !hasLoggedFirstReceipt else { return }
        hasLoggedFirstReceipt = true
        AppLogger.notice(
            "[WebBridge] first bridge receipt type=\(envelope.type.rawValue)",
            category: AppConfig.Log.webBridge)
    }

    private func log(disposition: BridgeLogDisposition) {
        switch disposition.level {
        case .verbose:
            AppLogger.verbose(disposition.message, category: AppConfig.Log.webBridge)
        case .debug:
            AppLogger.debug(disposition.message, category: AppConfig.Log.webBridge)
        case .info:
            AppLogger.info(disposition.message, category: AppConfig.Log.webBridge)
        case .notice:
            AppLogger.notice(disposition.message, category: AppConfig.Log.webBridge)
        case .warning:
            AppLogger.warning(disposition.message, category: AppConfig.Log.webBridge)
        case .error:
            AppLogger.error(disposition.message, category: AppConfig.Log.webBridge)
        }
    }
}
