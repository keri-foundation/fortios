import XCTest

@testable import KeriWallet

final class WebNavigationPolicyTests: XCTestCase {
    func test_allows_app_scheme() {
        let policy = WebNavigationPolicy()
        XCTAssertTrue(policy.isAllowed(url: URL(string: AppConfig.Scheme.entryURL)!))
    }

    func test_allows_app_scheme_case_insensitively() {
        let policy = WebNavigationPolicy()
        XCTAssertTrue(policy.isAllowed(url: URL(string: "APP://local/index.html")!))
    }

    func test_allows_about_blank_only() {
        let policy = WebNavigationPolicy()
        XCTAssertTrue(policy.isAllowed(url: URL(string: "about:blank")!))
        XCTAssertFalse(policy.isAllowed(url: URL(string: "about:config")!))
    }

    func test_blocks_https() {
        let policy = WebNavigationPolicy()
        XCTAssertFalse(policy.isAllowed(url: URL(string: "https://example.com")!))
    }

    func test_blocks_scheme_less_relative_urls() {
        let policy = WebNavigationPolicy()
        XCTAssertFalse(policy.isAllowed(url: URL(string: "/fortweb/app/index.html")!))
    }

    func test_respects_custom_allowed_scheme_set() {
        let policy = WebNavigationPolicy(allowedSchemes: [])
        XCTAssertFalse(policy.isAllowed(url: URL(string: AppConfig.Scheme.entryURL)!))
        XCTAssertTrue(policy.isAllowed(url: URL(string: AppConfig.Scheme.aboutBlankURL)!))
    }
}
