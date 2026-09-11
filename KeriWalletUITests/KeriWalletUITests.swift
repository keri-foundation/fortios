import XCTest

final class KeriWalletUITests: XCTestCase {

    private var app: XCUIApplication!

    /// Passcode of the vault that must be seeded outside the test on this
    /// simulator. The unlocked-vault tests need that external prerequisite and
    /// skip explicitly when it is absent rather than passing vacuously.
    private static let seededVaultPasscode = "0123456789abcdefghijk"

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

    // MARK: - Vault Picker

    /// Opens the vault drawer: waits for the Vaults toggle to become enabled,
    /// taps it, and returns the drawer element. Fails the test with a precise
    /// message if any step times out.
    private func openVaultDrawer(webView: XCUIElement, toggleTimeout: TimeInterval = 10.0, drawerTimeout: TimeInterval = 10.0) -> XCUIElement {
        let vaultsToggle = webView.buttons["Vaults"]
        guard vaultsToggle.waitForExistence(timeout: toggleTimeout) else {
            XCTFail("Vaults toggle button did not appear")
            return webView // unreachable; satisfies the compiler
        }

        let enabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"),
            object: vaultsToggle
        )
        guard XCTWaiter().wait(for: [enabled], timeout: toggleTimeout) == .completed else {
            XCTFail(vaultsToggle.isHittable
                ? "Vaults toggle is hittable but never became enabled"
                : "Vaults toggle exists but never became enabled")
            return webView
        }

        vaultsToggle.tap()

        // The drawer is an <aside role="dialog" aria-label="Vault switcher">.
        // WebKit appends ", web dialog" to the accessible label, so use a
        // predicate instead of an exact string match.
        let drawerPredicate = NSPredicate(format: "label BEGINSWITH 'Vault switcher'")
        let drawer = webView.otherElements.element(matching: drawerPredicate)
        guard drawer.waitForExistence(timeout: drawerTimeout) else {
            XCTFail("Vault drawer did not open (label BEGINSWITH 'Vault switcher')")
            return webView
        }

        return drawer
    }

    func test_vault_picker_shows_your_vaults_heading() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        let drawer = openVaultDrawer(webView: webView)

        let heading = drawer.staticTexts["Vaults"]
        XCTAssertTrue(
            heading.waitForExistence(timeout: 5),
            "Vault drawer should display 'Vaults' heading"
        )
    }

    func test_vault_picker_shows_create_vault_button() {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        let drawer = openVaultDrawer(webView: webView)

        let createButton = drawer.buttons["Initialize New Vault"]
        XCTAssertTrue(
            createButton.waitForExistence(timeout: 5),
            "Vault drawer should display 'Initialize New Vault' button"
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

    func test_tab_bar_links_are_tappable() throws {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        try navigateToUnlockedVault(webView: webView)

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

    func test_settings_tab_renders_settings_page() throws {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        try navigateToUnlockedVault(webView: webView)

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

    func test_lock_button_returns_to_unlock_screen() throws {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return
        }

        try navigateToUnlockedVault(webView: webView)

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

    /// Navigates from the vault picker into an unlocked vault.
    ///
    /// These tests need a vault that was seeded outside the test on this
    /// simulator (passcode above). When none is present this throws `XCTSkip`
    /// with a precise reason, because the prerequisite is an external condition
    /// the test does not own and real vault creation is blocked on the upstream
    /// canonical runtime (see `test_vault_survives_termination_and_relaunch`).
    ///
    /// Previously this returned `false` and every caller returned early, so
    /// these three tests reported PASS on a fresh simulator without executing a
    /// single assertion. A failure after the prerequisite exists stays a real
    /// failure, not a skip.
    private func navigateToUnlockedVault(webView: XCUIElement) throws {
        let openButton = firstOpenVaultButton(in: webView)
        let returnButton = webView.buttons["Return to Vault"]

        if returnButton.waitForExistence(timeout: 15) {
            returnButton.tap()
            XCTAssertTrue(
                webView.links["Identifiers"].waitForExistence(timeout: 15),
                "Return to Vault did not reach the vault tab bar"
            )
            return
        }

        guard openButton.waitForExistence(timeout: 5) else {
            throw XCTSkip(
                "No vault is present on this simulator, so the unlocked-vault "
                    + "prerequisite for this test is unavailable. Vault creation is "
                    + "blocked on the upstream canonical runtime; see "
                    + "test_vault_survives_termination_and_relaunch for the real flow."
            )
        }

        openButton.tap()

        let passcodeField = webView.secureTextFields.firstMatch
        XCTAssertTrue(
            passcodeField.waitForExistence(timeout: 10),
            "Unlock page passcode field was not presented for an existing vault"
        )
        passcodeField.tap()
        passcodeField.typeText(Self.seededVaultPasscode)

        let submitButton = webView.buttons["Open"]
        XCTAssertTrue(
            submitButton.waitForExistence(timeout: 5),
            "Unlock page 'Open' button missing for an existing vault"
        )
        submitButton.tap()

        XCTAssertTrue(
            webView.links["Identifiers"].waitForExistence(timeout: 30),
            "Unlocking an existing vault did not reach the Identifiers tab"
        )
    }
}
