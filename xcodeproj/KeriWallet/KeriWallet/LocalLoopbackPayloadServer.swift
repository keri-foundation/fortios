import Foundation
import Network

struct LoopbackOrigin: Equatable {
    let scheme: String
    let host: String
    let port: UInt16

    var baseURL: URL {
        URL(string: "\(scheme)://\(host):\(port)")!
    }

    var entryURL: URL {
        baseURL.appendingPathComponent(AppConfig.Scheme.defaultIndexPath)
    }

    func matches(url: URL) -> Bool {
        url.scheme?.lowercased() == scheme
            && url.host?.lowercased() == host.lowercased()
            && url.port == Int(port)
    }
}

enum LocalLoopbackPayloadServerError: Error {
    case missingPayloadDirectory
    case invalidListenerPort
    case invalidRequest
    case invalidURL
    case startTimedOut
    case unsupportedMethod
}

private struct LoopbackRequest {
    let method: String
    let path: String
    let url: URL
}

final class LocalLoopbackPayloadServer {
    private let queue = DispatchQueue(label: "com.kerifoundation.wallet.loopback")
    private let listener: NWListener
    private let originHost: String
    private let payloadLoader: PayloadSchemeHandler
    private var currentOrigin: LoopbackOrigin?
    private var isRunning = false

    init(originHost: String = AppConfig.Loopback.host, fileManager: FileManager = .default) throws {
        guard
            let payloadDirectory = Bundle.main.resourceURL?.appendingPathComponent(
                AppConfig.Payload.bundleSubdirectory,
                isDirectory: true)
        else {
            throw LocalLoopbackPayloadServerError.missingPayloadDirectory
        }

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        parameters.allowLocalEndpointReuse = true

        guard let port = NWEndpoint.Port(rawValue: 0) else {
            throw LocalLoopbackPayloadServerError.invalidListenerPort
        }

        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(originHost), port: port)

        self.listener = try NWListener(using: parameters, on: port)
        self.originHost = originHost
        self.payloadLoader = PayloadSchemeHandler(
            payloadDirectory: payloadDirectory,
            fileManager: fileManager)
    }

    deinit {
        stop()
    }

    func start() throws -> LoopbackOrigin {
        if let currentOrigin, isRunning {
            return currentOrigin
        }

        var startupError: Error?
        let semaphore = DispatchSemaphore(value: 0)
        var didSignal = false

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }

            let signalIfNeeded: () -> Void = {
                if !didSignal {
                    didSignal = true
                    semaphore.signal()
                }
            }

            switch state {
            case .ready:
                guard let port = self.listener.port?.rawValue else {
                    startupError = LocalLoopbackPayloadServerError.invalidListenerPort
                    signalIfNeeded()
                    return
                }

                let origin = LoopbackOrigin(
                    scheme: AppConfig.Loopback.scheme,
                    host: self.originHost,
                    port: port)
                self.currentOrigin = origin
                self.isRunning = true

                AppLogger.notice(
                    "[Loopback] loopback.server.ready host=\"\(self.originHost)\" port=\"\(port)\" base_url=\"\(origin.baseURL.absoluteString)\"",
                    category: AppConfig.Log.loopback)
                signalIfNeeded()
            case .failed(let error):
                startupError = error
                self.isRunning = false
                signalIfNeeded()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }

        AppLogger.notice(
            "[Loopback] loopback.server.start host=\"\(originHost)\" port=\"0\"",
            category: AppConfig.Log.loopback)
        listener.start(queue: queue)

        if semaphore.wait(timeout: .now() + 5) == .timedOut {
            listener.cancel()
            throw LocalLoopbackPayloadServerError.startTimedOut
        }

        if let startupError {
            throw startupError
        }

        guard let currentOrigin else {
            throw LocalLoopbackPayloadServerError.startTimedOut
        }

        return currentOrigin
    }

    func stop() {
        guard isRunning else { return }
        let port = currentOrigin?.port ?? 0

        AppLogger.notice(
            "[Loopback] loopback.server.stop host=\"\(originHost)\" port=\"\(port)\"",
            category: AppConfig.Log.loopback)

        isRunning = false
        listener.cancel()
    }

    private func handle(connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.receiveRequest(on: connection, buffer: Data())
            case .failed:
                connection.cancel()
            default:
                break
            }
        }

        connection.start(queue: queue)
    }

    private func receiveRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }

            if error != nil {
                connection.cancel()
                return
            }

            var accumulated = buffer
            if let data {
                accumulated.append(data)
            }

            if accumulated.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(on: connection, requestData: accumulated)
                return
            }

            if isComplete || accumulated.count >= 65_536 {
                self.respond(on: connection, requestData: accumulated)
                return
            }

            self.receiveRequest(on: connection, buffer: accumulated)
        }
    }

    private func respond(on connection: NWConnection, requestData: Data) {
        let requestID = String(UUID().uuidString.prefix(8)).lowercased()
        let startedAt = Date()

        do {
            let request = try parseRequest(from: requestData)
            logRequestStart(requestID: requestID, request: request)

            guard request.method == "GET" || request.method == "HEAD" else {
                throw LocalLoopbackPayloadServerError.unsupportedMethod
            }

            let bundleURL = try appSchemeURL(for: request.path)
            let (body, mime, headers) = try payloadLoader.loadResource(for: bundleURL)

            var responseHeaders = headers
            responseHeaders["Cache-Control"] = "no-store"
            responseHeaders["Connection"] = "close"

            sendResponse(
                on: connection,
                statusCode: 200,
                reasonPhrase: "OK",
                headers: responseHeaders,
                body: request.method == "HEAD" ? Data() : body)

            logRequestSuccess(
                requestID: requestID,
                startedAt: startedAt,
                request: request,
                mime: mime,
                bytes: body.count,
                statusCode: 200)
        } catch {
            let response = responseDetails(for: error)
            let body = Data("\(response.statusCode) \(response.reasonPhrase)\n".utf8)

            sendResponse(
                on: connection,
                statusCode: response.statusCode,
                reasonPhrase: response.reasonPhrase,
                headers: [
                    "Content-Type": "text/plain; charset=utf-8",
                    "Content-Length": "\(body.count)",
                    "Cache-Control": "no-store",
                    "Connection": "close",
                ],
                body: body)

            logRequestError(
                requestID: requestID,
                startedAt: startedAt,
                requestData: requestData,
                statusCode: response.statusCode,
                errorKind: response.errorKind,
                errorDescription: String(describing: error))
        }
    }

    private func parseRequest(from requestData: Data) throws -> LoopbackRequest {
        guard let requestText = String(data: requestData, encoding: .utf8) else {
            throw LocalLoopbackPayloadServerError.invalidRequest
        }

        guard let requestLine = requestText.components(separatedBy: "\r\n").first else {
            throw LocalLoopbackPayloadServerError.invalidRequest
        }

        let parts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count >= 2 else {
            throw LocalLoopbackPayloadServerError.invalidRequest
        }

        let method = String(parts[0]).uppercased()
        let target = String(parts[1])
        let url = try loopbackURL(for: target)
        let path = url.path.isEmpty ? "/" : url.path

        return LoopbackRequest(method: method, path: path, url: url)
    }

    private func loopbackURL(for target: String) throws -> URL {
        guard let currentOrigin else {
            throw LocalLoopbackPayloadServerError.invalidURL
        }

        guard var components = URLComponents(url: currentOrigin.baseURL, resolvingAgainstBaseURL: false) else {
            throw LocalLoopbackPayloadServerError.invalidURL
        }

        if let absoluteURL = URL(string: target), absoluteURL.scheme != nil {
            guard
                let absoluteComponents = URLComponents(
                    url: absoluteURL,
                    resolvingAgainstBaseURL: false)
            else {
                throw LocalLoopbackPayloadServerError.invalidURL
            }

            components.percentEncodedPath = absoluteComponents.percentEncodedPath.isEmpty
                ? "/"
                : absoluteComponents.percentEncodedPath
            components.percentEncodedQuery = absoluteComponents.percentEncodedQuery
        } else {
            let normalizedTarget = target.hasPrefix("/") ? target : "/\(target)"
            if let queryDelimiter = normalizedTarget.firstIndex(of: "?") {
                components.percentEncodedPath = String(normalizedTarget[..<queryDelimiter])
                components.percentEncodedQuery = String(normalizedTarget[normalizedTarget.index(after: queryDelimiter)...])
            } else {
                components.percentEncodedPath = normalizedTarget
            }
        }

        guard let url = components.url else {
            throw LocalLoopbackPayloadServerError.invalidURL
        }

        return url
    }

    private func appSchemeURL(for requestPath: String) throws -> URL {
        let normalizedPath = requestPath.hasPrefix("/") ? requestPath : "/\(requestPath)"
        guard let url = URL(string: "\(AppConfig.Scheme.name)://local\(normalizedPath)") else {
            throw LocalLoopbackPayloadServerError.invalidURL
        }
        return url
    }

    private func sendResponse(
        on connection: NWConnection,
        statusCode: Int,
        reasonPhrase: String,
        headers: [String: String],
        body: Data
    ) {
        var responseData = Data("\(AppConfig.HTTP.version) \(statusCode) \(reasonPhrase)\r\n".utf8)

        for (key, value) in headers.sorted(by: { $0.key < $1.key }) {
            responseData.append(Data("\(key): \(value)\r\n".utf8))
        }

        responseData.append(Data("\r\n".utf8))
        responseData.append(body)

        connection.send(content: responseData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func responseDetails(for error: Error) -> (statusCode: Int, reasonPhrase: String, errorKind: String) {
        switch error {
        case PayloadSchemeError.invalidURL:
            return (400, "Bad Request", "invalid_url")
        case PayloadSchemeError.disallowedPath:
            return (403, "Forbidden", "disallowed_path")
        case PayloadSchemeError.missingResource:
            return (404, "Not Found", "missing_resource")
        case PayloadSchemeError.invalidPayloadManifest:
            return (500, "Internal Server Error", "invalid_payload_manifest")
        case PayloadSchemeError.resourceTooLarge:
            return (413, "Payload Too Large", "resource_too_large")
        case LocalLoopbackPayloadServerError.unsupportedMethod:
            return (405, "Method Not Allowed", "unsupported_method")
        case LocalLoopbackPayloadServerError.invalidRequest:
            return (400, "Bad Request", "invalid_request")
        case LocalLoopbackPayloadServerError.invalidURL:
            return (400, "Bad Request", "invalid_url")
        default:
            return (500, "Internal Server Error", String(describing: type(of: error)))
        }
    }

    private func logRequestStart(requestID: String, request: LoopbackRequest) {
        logRequest(
            levelForPath(request.path),
            label: "loopback.request.start",
            fields: [
                "request_id": requestID,
                "method": request.method,
                "url": request.url.absoluteString,
                "path": request.path,
            ])
    }

    private func logRequestSuccess(
        requestID: String,
        startedAt: Date,
        request: LoopbackRequest,
        mime: String,
        bytes: Int,
        statusCode: Int
    ) {
        logRequest(
            levelForPath(request.path),
            label: "loopback.request.success",
            fields: [
                "request_id": requestID,
                "method": request.method,
                "url": request.url.absoluteString,
                "path": request.path,
                "mime": mime,
                "bytes": "\(bytes)",
                "duration_ms": "\(durationMilliseconds(since: startedAt))",
                "status": "\(statusCode)",
            ])
    }

    private func logRequestError(
        requestID: String,
        startedAt: Date,
        requestData: Data,
        statusCode: Int,
        errorKind: String,
        errorDescription: String
    ) {
        let request = try? parseRequest(from: requestData)

        logRequest(
            levelForPath(request?.path ?? "/"),
            label: "loopback.request.error",
            fields: [
                "request_id": requestID,
                "method": request?.method ?? "",
                "url": request?.url.absoluteString ?? "",
                "path": request?.path ?? "",
                "duration_ms": "\(durationMilliseconds(since: startedAt))",
                "status": "\(statusCode)",
                "error_kind": errorKind,
                "error": errorDescription,
            ])
    }

    private func levelForPath(_ path: String) -> LogLevel {
        if path == "/" || path == "/\(AppConfig.Scheme.defaultIndexPath)" {
            return .notice
        }
        return .debug
    }

    private func logRequest(_ level: LogLevel, label: String, fields: [String: String]) {
        let message = (["[Loopback]", label] + fields
            .filter { !$0.value.isEmpty }
            .sorted { $0.key < $1.key }
            .map { key, value in "\(key)=\(quoted(value))" })
            .joined(separator: " ")

        switch level {
        case .verbose:
            AppLogger.verbose(message, category: AppConfig.Log.loopback)
        case .debug:
            AppLogger.debug(message, category: AppConfig.Log.loopback)
        case .info:
            AppLogger.info(message, category: AppConfig.Log.loopback)
        case .notice:
            AppLogger.notice(message, category: AppConfig.Log.loopback)
        case .warning:
            AppLogger.warning(message, category: AppConfig.Log.loopback)
        case .error:
            AppLogger.error(message, category: AppConfig.Log.loopback)
        }
    }

    private func durationMilliseconds(since startedAt: Date) -> Int {
        max(0, Int(Date().timeIntervalSince(startedAt) * 1000))
    }

    private func quoted(_ value: String) -> String {
        let escapedValue = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escapedValue)\""
    }
}