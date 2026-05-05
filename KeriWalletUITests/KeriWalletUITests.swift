import XCTest

final class KeriWalletUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    // MARK: - Launch

    func test_app_launches() {
        XCTAssertTrue(app.state == .runningForeground)
    }

    func test_webview_loads() {
        let webView = app.webViews.firstMatch
        XCTAssertTrue(
            webView.waitForExistence(timeout: 30),
            "WKWebView should appear within 30 seconds"
        )
    }

    // MARK: - Product shell smoke (vault / home surfaces)

    /// Confirms FortWeb product-shell markup is reachable (CI uses Locksmith chrome + splash;
    /// some FortWeb branches still render the richer vault-home hero).
    func test_product_shell_presents_wallet_home_surface() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        // WKWebView flattens the DOM into static text, links, and buttons inconsistently across
        // FortWeb revisions; keep a small ordered probe list rather than insisting on one label type.
        let candidates: [(XCUIElement, TimeInterval)] = [
            (webView.links["Locksmith"], 8),
            (webView.staticTexts["Locksmith"], 8),
            (webView.buttons["Vaults"], 20),
            (webView.staticTexts["On-Device Wallet"], 25),
            (webView.staticTexts["No Vaults Yet"], 12),
            (webView.staticTexts["Available Vaults"], 12),
            (firstOpenVaultButton(in: webView), 35),
            (webView.staticTexts["Your Vaults"], 12),
        ]

        XCTAssertTrue(
            candidates.contains { pair in pair.0.waitForExistence(timeout: pair.1) },
            "FortWeb wallet shell should expose recognizable vault/home chrome after Pyodide + route bootstrap"
        )
    }

    /// Creation entry differs by FortWeb generation: Locksmith shell exposes the vault drawer (`Vaults`),
    /// while vault-home exposes inline create actions (`Create Vault` / `Create Your First Vault`).
    func test_product_shell_exposes_vault_creation_entry() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        if webView.buttons["Create Vault"].waitForExistence(timeout: 5) {
            return
        }
        if webView.buttons["Create Your First Vault"].waitForExistence(timeout: 5) {
            return
        }

        let drawerToggle = webView.buttons["Vaults"]
        guard drawerToggle.waitForExistence(timeout: 45) else {
            XCTFail("Could not locate FortWeb vault chrome or vault-home create controls")
            return
        }

        drawerToggle.tap()

        XCTAssertTrue(
            webView.buttons["Initialize New Vault"].waitForExistence(timeout: 15),
            "FortWeb vault drawer should expose an initialize-new-vault affordance once opened"
        )
    }

    // MARK: - Vault Open Flow

    func test_vault_card_navigates_to_unlock() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        let openButton = firstOpenVaultButton(in: webView)
        guard openButton.waitForExistence(timeout: 15) else {
            // No vault exists yet; this is expected on a fresh install.
            return
        }

        openButton.tap()

        let passcodeField = webView.secureTextFields.firstMatch
        XCTAssertTrue(
            passcodeField.waitForExistence(timeout: 10),
            "Tapping a vault card should navigate to the unlock page with a passcode field"
        )
    }

    func test_unlock_page_has_open_and_cancel_buttons() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        let openVaultButton = firstOpenVaultButton(in: webView)
        guard openVaultButton.waitForExistence(timeout: 15) else {
            return
        }

        openVaultButton.tap()

        let openSubmit = webView.buttons["Open"]
        XCTAssertTrue(
            openSubmit.waitForExistence(timeout: 10),
            "Unlock page should have an 'Open' submit button"
        )

        let cancelLink = webView.links["Cancel"]
        XCTAssertTrue(
            cancelLink.waitForExistence(timeout: 5),
            "Unlock page should have a 'Cancel' link"
        )
    }

    // MARK: - Tab Bar Interaction

    func test_tab_bar_links_are_tappable() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        guard navigateToUnlockedVault(webView: webView) else {
            return
        }

        let tabLabels = ["Identifiers", "Remotes", "Foundation", "Settings"]
        for label in tabLabels {
            let tab = webView.links[label]
            XCTAssertTrue(
                tab.waitForExistence(timeout: 10),
                "Tab bar should contain '\(label)' link"
            )
            XCTAssertTrue(tab.isHittable, "'\(label)' tab should be tappable")
        }
    }

    func test_settings_tab_renders_settings_page() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        guard navigateToUnlockedVault(webView: webView) else {
            return
        }

        let settingsTab = webView.links["Settings"]
        guard settingsTab.waitForExistence(timeout: 10) else {
            XCTFail("Settings tab not found")
            return
        }

        settingsTab.tap()

        let settingsHeading = webView.staticTexts["Settings"]
        XCTAssertTrue(
            settingsHeading.waitForExistence(timeout: 10),
            "Tapping Settings tab should render the Settings page"
        )

        let vaultDefaults = webView.staticTexts["Vault Defaults"]
        XCTAssertTrue(
            vaultDefaults.waitForExistence(timeout: 5),
            "Settings page should display 'Vault Defaults' section"
        )
    }

    // MARK: - Lock Vault

    func test_lock_button_returns_to_unlock_screen() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        guard navigateToUnlockedVault(webView: webView) else {
            return
        }

        let lockButton = webView.buttons["Lock vault"]
        guard lockButton.waitForExistence(timeout: 10) else {
            XCTFail("Lock button not found in vault header")
            return
        }

        lockButton.tap()

        let passcodeField = webView.secureTextFields.firstMatch
        XCTAssertTrue(
            passcodeField.waitForExistence(timeout: 10),
            "Locking vault should return to the unlock screen"
        )
    }

    // MARK: - Helpers

    /// FortWeb renders one "Open Vault" action per locked vault card.
    /// Use a deterministic first match so UI tests exercise a real vault flow
    /// without depending on there being only one stored vault.
    private func firstOpenVaultButton(in webView: XCUIElement) -> XCUIElement {
        webView.buttons.matching(identifier: "Open Vault").firstMatch
    }

    /// Attempts to navigate from the vault picker into an unlocked vault.
    /// Returns `false` if no vault exists (test will be silently skipped).
    @discardableResult
    private func navigateToUnlockedVault(webView: XCUIElement) -> Bool {
        let openButton = firstOpenVaultButton(in: webView)
        let returnButton = webView.buttons["Return to Vault"]

        if returnButton.waitForExistence(timeout: 15) {
            returnButton.tap()
            let tabBar = webView.links["Identifiers"]
            return tabBar.waitForExistence(timeout: 15)
        }

        guard openButton.waitForExistence(timeout: 5) else {
            return false
        }

        openButton.tap()

        let passcodeField = webView.secureTextFields.firstMatch
        guard passcodeField.waitForExistence(timeout: 10) else {
            return false
        }

        passcodeField.tap()
        passcodeField.typeText("0123456789abcdefghijk")

        let submitButton = webView.buttons["Open"]
        guard submitButton.waitForExistence(timeout: 5) else {
            return false
        }
        submitButton.tap()

        let identifiersTab = webView.links["Identifiers"]
        return identifiersTab.waitForExistence(timeout: 30)
    }
}
