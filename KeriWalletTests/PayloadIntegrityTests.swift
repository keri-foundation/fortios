import Foundation
import Testing

@Suite("Runtime requirements contract integrity")
struct PayloadIntegrityTests {

    // MARK: - Bundle-based discovery

    /// Resolves the payload root directory. Uses the host application bundle
    /// when running in the test host; falls back to the repository source
    /// tree for direct local execution.
    private var payloadRootURL: URL {
        if let hostBundle = Bundle(identifier: "com.kerifoundation.KeriWallet") {
            // Running inside the test host app — read from the app bundle
            return hostBundle.resourceURL!
                .appendingPathComponent("WebPayload", isDirectory: true)
        }
        // Direct execution fallback: locate relative to source checkout
        let sourceFile = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceFile
            .deletingLastPathComponent()  // KeriWalletTests/
            .deletingLastPathComponent()  // Fort-ios/
        return repoRoot.appendingPathComponent("WebPayload", isDirectory: true)
    }

    /// Reads the producer manifest from the payload root.
    private func loadManifest() throws -> [String: Any] {
        let url = payloadRootURL.appendingPathComponent("manifest.json")
        let data = try Data(contentsOf: url)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    /// Discovers and reads the runtime requirements artifact through the
    /// typed manifest descriptor.
    private func loadRequirements() throws -> [String: Any] {
        let manifest = try loadManifest()

        // Typed descriptor
        guard let contracts = manifest["contracts"] as? [String: Any],
              let rr = contracts["runtime_requirements"] as? [String: Any],
              let path = rr["path"] as? String,
              !path.trimmingCharacters(in: .whitespaces).isEmpty
        else {
            throw PayloadIntegrityError.missingDescriptor
        }

        // Path safety
        if path.hasPrefix("/") { throw PayloadIntegrityError.unsafePath }
        if path.contains("\\") { throw PayloadIntegrityError.unsafePath }
        if path.contains("..") { throw PayloadIntegrityError.unsafePath }

        // Conventional path
        let conventional = "contracts/runtime-requirements.json"
        if path != conventional {
            throw PayloadIntegrityError.wrongPath(path)
        }

        // Inventory match
        guard let files = manifest["files"] as? [[String: Any]] else {
            throw PayloadIntegrityError.missingInventory
        }
        let matches = files.filter { ($0["path"] as? String) == path }
        if matches.count != 1 {
            throw PayloadIntegrityError.inventoryCount(path, matches.count)
        }

        // Read and validate bytes
        let artifactURL = payloadRootURL.appendingPathComponent(path)
        let data = try Data(contentsOf: artifactURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]

        // Inventory byte count
        if let expectedBytes = matches[0]["bytes"] as? Int, data.count != expectedBytes {
            throw PayloadIntegrityError.byteCountMismatch(path, actual: data.count, expected: expectedBytes)
        }

        return json
    }

    // MARK: - Schema identity

    @Test("requirements schema is fort.runtime-requirements.v1")
    func schemaMatches() throws {
        let rr = try loadRequirements()
        #expect((rr["schema"] as? String) == "fort.runtime-requirements.v1")
    }

    @Test("requirements version is 1")
    func versionIsOne() throws {
        let rr = try loadRequirements()
        #expect((rr["version"] as? Int) == 1)
    }

    @Test("requirements producer is fortweb")
    func producerIsFortweb() throws {
        let rr = try loadRequirements()
        #expect((rr["producer"] as? String) == "fortweb")
    }

    @Test("requirements payload profile is offline-runtime")
    func profileIsOfflineRuntime() throws {
        let rr = try loadRequirements()
        #expect((rr["payload_profile"] as? String) == "offline-runtime")
    }

    // MARK: - Capabilities (presence, not behavioral proof)

    @Test("requirements include stable_origin_across_launches")
    func hasStableOrigin() throws {
        let rr = try loadRequirements()
        let caps = rr["capabilities"] as? [String: Any]
        #expect(caps?["stable_origin_across_launches"] != nil)
    }

    @Test("requirements include secure_context")
    func hasSecureContext() throws {
        let rr = try loadRequirements()
        let caps = rr["capabilities"] as? [String: Any]
        #expect(caps?["secure_context"] != nil)
    }

    @Test("requirements include remote_network_prohibition")
    func hasNetworkProhibition() throws {
        let rr = try loadRequirements()
        let caps = rr["capabilities"] as? [String: Any]
        #expect(caps?["remote_network_prohibition"] != nil)
    }

    @Test("requirements include bundled_assets_only")
    func hasBundledAssets() throws {
        let rr = try loadRequirements()
        let caps = rr["capabilities"] as? [String: Any]
        #expect(caps?["bundled_assets_only"] != nil)
    }

    @Test("requirements include worker_availability")
    func hasWorkerAvailability() throws {
        let rr = try loadRequirements()
        let caps = rr["capabilities"] as? [String: Any]
        #expect(caps?["worker_availability"] != nil)
    }

    // MARK: - Forbidden behaviors (presence)

    @Test("requirements include network_fetch in forbidden behaviors")
    func forbidsNetworkFetch() throws {
        let rr = try loadRequirements()
        let fb = rr["forbidden_behaviors"] as? [String] ?? []
        #expect(fb.contains("network_fetch"))
    }

    @Test("requirements include http_fallback in forbidden behaviors")
    func forbidsHttpFallback() throws {
        let rr = try loadRequirements()
        let fb = rr["forbidden_behaviors"] as? [String] ?? []
        #expect(fb.contains("http_fallback"))
    }
}

// MARK: - Errors

enum PayloadIntegrityError: Error {
    case missingDescriptor
    case unsafePath
    case wrongPath(String)
    case missingInventory
    case inventoryCount(String, Int)
    case byteCountMismatch(String, actual: Int, expected: Int)
}
