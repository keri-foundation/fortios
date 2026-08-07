import CryptoKit
import Foundation
import Testing

@Suite("Runtime requirements packaging integrity")
struct PayloadIntegrityTests {

    // MARK: - Host application bundle resolution

    /// Resolves the host application bundle containing WebPayload.
    /// XCTest app-hosted tests run inside the host app; `Bundle.main`
    /// IS the host application in that context.
    private var hostBundle: Bundle {
        return Bundle.main
    }

    /// The WebPayload root inside the host application bundle.
    private var payloadRootURL: URL {
        guard let resourceURL = hostBundle.resourceURL else {
            preconditionFailure("Host application bundle has no resource URL")
        }
        return resourceURL.appendingPathComponent("WebPayload", isDirectory: true)
    }

    // MARK: - Manifest

    private func loadManifest() throws -> (dict: [String: Any], data: Data) {
        let url = payloadRootURL.appendingPathComponent("manifest.json")
        let data = try Data(contentsOf: url)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return (json, data)
    }

    // MARK: - Requirements discovery and byte-integrity

    /// Discovered requirements artifact with verified byte integrity.
    private struct RequirementsArtifact {
        let data: Data
        let text: String
        let dict: [String: Any]
        let path: String
        let manifestBytes: Int
        let manifestSHA256: String
    }

    private func discoverRequirements() throws -> RequirementsArtifact {
        let (manifest, _) = try loadManifest()

        // Typed descriptor
        guard let contracts = manifest["contracts"] as? [String: Any],
              let rr = contracts["runtime_requirements"] as? [String: Any],
              let path = rr["path"] as? String,
              !path.trimmingCharacters(in: .whitespaces).isEmpty
        else {
            throw PayloadIntegrityError.missingDescriptor
        }

        // Path safety
        try validateDescriptorPath(path)

        // Conventional path
        if path != "contracts/runtime-requirements.json" {
            throw PayloadIntegrityError.wrongPath(path)
        }

        // Inventory match: exactly one entry
        guard let files = manifest["files"] as? [[String: Any]] else {
            throw PayloadIntegrityError.missingInventory
        }
        let matches = files.filter { ($0["path"] as? String) == path }
        guard matches.count == 1,
              let entry = matches.first,
              let manifestBytes = entry["bytes"] as? Int,
              let manifestSHA256 = entry["sha256"] as? String
        else {
            throw PayloadIntegrityError.inventoryCount(path, matches.count)
        }

        // Byte-integrity: read exact bytes
        let artifactURL = payloadRootURL.appendingPathComponent(path)
        let data = try Data(contentsOf: artifactURL)

        // Byte count
        guard data.count == manifestBytes else {
            throw PayloadIntegrityError.byteCountMismatch(
                path, actual: data.count, expected: manifestBytes)
        }

        // SHA-256
        let actualSHA256 = SHA256.hash(data: data)
            .compactMap { String(format: "%02x", $0) }
            .joined()
        guard actualSHA256 == manifestSHA256.lowercased() else {
            throw PayloadIntegrityError.sha256Mismatch(
                path, actual: actualSHA256, expected: manifestSHA256)
        }

        // Strict UTF-8
        guard let text = String(data: data, encoding: .utf8) else {
            throw PayloadIntegrityError.invalidUTF8(path)
        }
        if text.contains("\u{FFFD}") {
            throw PayloadIntegrityError.replacementCharacter(path)
        }

        // JSON parse
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PayloadIntegrityError.malformedJSON(path)
        }

        return RequirementsArtifact(
            data: data,
            text: text,
            dict: dict,
            path: path,
            manifestBytes: manifestBytes,
            manifestSHA256: manifestSHA256
        )
    }

    private func validateDescriptorPath(_ path: String) throws {
        if path.isEmpty { throw PayloadIntegrityError.unsafePath }
        if path.hasPrefix("/") { throw PayloadIntegrityError.unsafePath }
        if path.contains("\\") { throw PayloadIntegrityError.unsafePath }
        if path.contains("..") { throw PayloadIntegrityError.unsafePath }

        let standardizedRoot = payloadRootURL.standardizedFileURL
        let resolved = URL(
            fileURLWithPath: path,
            relativeTo: standardizedRoot
        ).standardizedFileURL

        let rootPath = standardizedRoot.path.hasSuffix("/")
            ? standardizedRoot.path
            : standardizedRoot.path + "/"

        guard resolved.path.hasPrefix(rootPath) else {
            throw PayloadIntegrityError.unsafePath
        }
    }

    // MARK: - Manifest presence

    @Test("host application contains WebPayload/manifest.json")
    func manifestPresent() throws {
        let (_, _) = try loadManifest()
    }

    // MARK: - Schema identity

    @Test("requirements schema is fort.runtime-requirements.v1")
    func schemaMatches() throws {
        let artifact = try discoverRequirements()
        #expect((artifact.dict["schema"] as? String) == "fort.runtime-requirements.v1")
    }

    @Test("requirements version is 1")
    func versionIsOne() throws {
        let artifact = try discoverRequirements()
        #expect((artifact.dict["version"] as? Int) == 1)
    }

    @Test("requirements producer is fortweb")
    func producerIsFortweb() throws {
        let artifact = try discoverRequirements()
        #expect((artifact.dict["producer"] as? String) == "fortweb")
    }

    @Test("requirements payload profile is offline-runtime")
    func profileIsOfflineRuntime() throws {
        let artifact = try discoverRequirements()
        #expect((artifact.dict["payload_profile"] as? String) == "offline-runtime")
    }

    // MARK: - Byte integrity (proves exact producer preservation)

    @Test("requirements byte count matches manifest inventory")
    func byteCountMatches() throws {
        let artifact = try discoverRequirements()
        #expect(artifact.data.count == artifact.manifestBytes)
    }

    @Test("requirements SHA-256 matches manifest inventory")
    func sha256Matches() throws {
        _ = try discoverRequirements() // throws if mismatch
    }

    @Test("requirements bytes are valid strict UTF-8")
    func utf8IsValid() throws {
        let artifact = try discoverRequirements()
        #expect(!artifact.text.contains("\u{FFFD}"))
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
    case sha256Mismatch(String, actual: String, expected: String)
    case invalidUTF8(String)
    case replacementCharacter(String)
    case malformedJSON(String)
}
