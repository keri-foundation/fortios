import Foundation
import Testing

@Suite("Runtime origin contract integrity")
struct PayloadIntegrityTests {

    private func loadContract() throws -> [String: Any] {
        // Locate the contract relative to the source checkout
        let sourceFile = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceFile
            .deletingLastPathComponent()  // KeriWalletTests/
            .deletingLastPathComponent()  // Fort-ios/
        let contractURL = repoRoot
            .appendingPathComponent("WebPayload/fortweb/app/runtime-origin-contract.json")

        let data = try Data(contentsOf: contractURL)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        return json
    }

    // MARK: - Schema

    @Test("contract schema is fortweb.runtime-origin.v1")
    func schemaIsCorrect() throws {
        let contract = try loadContract()
        #expect((contract["schema"] as? String) == "fortweb.runtime-origin.v1")
    }

    // MARK: - Platform

    @Test("platform is ios-wkwebview")
    func platformIsIosWkwebview() throws {
        let contract = try loadContract()
        #expect((contract["platform"] as? String) == "ios-wkwebview")
    }

    @Test("mode is bundled-offline")
    func modeIsBundledOffline() throws {
        let contract = try loadContract()
        #expect((contract["mode"] as? String) == "bundled-offline")
    }

    // MARK: - Origins

    @Test("documentOrigin is app://local")
    func documentOriginIsAppLocal() throws {
        let contract = try loadContract()
        #expect((contract["documentOrigin"] as? String) == "app://local")
    }

    @Test("appBaseUrl is app://local")
    func appBaseUrlIsAppLocal() throws {
        let contract = try loadContract()
        #expect((contract["appBaseUrl"] as? String) == "app://local")
    }

    // MARK: - Capabilities

    @Test("httpsLikeAssetOrigin is false")
    func httpsLikeAssetOriginIsFalse() throws {
        let contract = try loadContract()
        let caps = contract["capabilities"] as? [String: Any]
        #expect((caps?["httpsLikeAssetOrigin"] as? Bool) == false)
    }

    @Test("implicitBlobOriginSafe is false")
    func implicitBlobOriginSafeIsFalse() throws {
        let contract = try loadContract()
        let caps = contract["capabilities"] as? [String: Any]
        #expect((caps?["implicitBlobOriginSafe"] as? Bool) == false)
    }

    @Test("bundledAssetsOnly is true")
    func bundledAssetsOnlyIsTrue() throws {
        let contract = try loadContract()
        let caps = contract["capabilities"] as? [String: Any]
        #expect((caps?["bundledAssetsOnly"] as? Bool) == true)
    }

    @Test("networkAllowed is false")
    func networkAllowedIsFalse() throws {
        let contract = try loadContract()
        let caps = contract["capabilities"] as? [String: Any]
        #expect((caps?["networkAllowed"] as? Bool) == false)
    }

    @Test("customScheme is true")
    func customSchemeIsTrue() throws {
        let contract = try loadContract()
        let caps = contract["capabilities"] as? [String: Any]
        #expect((caps?["customScheme"] as? Bool) == true)
    }
}
