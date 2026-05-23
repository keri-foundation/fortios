import XCTest

final class KeriWalletUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()

        let environment = ProcessInfo.processInfo.environment
        if let flag = environment["FORTIOS_LOOPBACK_ORIGIN"]?.lowercased(),
            ["1", "true", "yes"].contains(flag)
        {
            app.launchEnvironment["FORTIOS_LOOPBACK_ORIGIN"] = "1"
            app.launchArguments.append("--fortios-loopback-origin")
        }

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

    func test_create_vault_passcode_field_captures_input_before_submit() {
        let alias = "diag-ios-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        let passcode = "0123456789abcdefghijk"

        guard prepareCreateVaultFormWithTrustedInput(alias: alias, passcode: passcode) != nil else {
            return
        }
    }

    func test_create_vault_completes_without_stuck_creating_state() {
        let alias = "diag-ios-\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        let passcode = "0123456789abcdefghijk"

        guard let submitButton = prepareCreateVaultFormWithTrustedInput(alias: alias, passcode: passcode) else {
            return
        }

        let webView = app.webViews.firstMatch

        submitButton.tap()

        let creatingStatus = webView.staticTexts["Creating vault..."]
        let creatingButton = webView.buttons["Creating..."]
        let successCandidates = [
            webView.buttons["Open"],
            webView.buttons["Open Vault"],
            webView.links["Identifiers"],
            webView.links["Settings"],
            webView.staticTexts["Available Vaults"],
        ]

        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if successCandidates.contains(where: { $0.exists }) && !creatingStatus.exists && !creatingButton.exists {
                return
            }

            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }

        attachFailureArtifacts(named: "create-vault-stuck-creating")
        XCTFail("Create vault remained in a stuck creating state instead of reaching a success surface within 30 seconds")
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

    private func attachFailureArtifacts(named name: String) {
        let screenshotAttachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshotAttachment.name = name
        screenshotAttachment.lifetime = .keepAlways
        add(screenshotAttachment)

        let treeAttachment = XCTAttachment(string: app.debugDescription)
        treeAttachment.name = "\(name)-tree"
        treeAttachment.lifetime = .keepAlways
        add(treeAttachment)
    }

    private func attachCreateVaultDiagnostics(named name: String) {
        attachFailureArtifacts(named: name)

        let focusAttachment = XCTAttachment(string: createVaultFocusHints())
        focusAttachment.name = "\(name)-focus"
        focusAttachment.lifetime = .keepAlways
        add(focusAttachment)
    }

    private func createVaultFocusHints() -> String {
        app.debugDescription
            .components(separatedBy: .newlines)
            .filter { line in
                line.contains("label: 'Name'") || line.contains("label: 'Passcode'") || line.contains("Focused")
            }
            .joined(separator: "\n")
    }

    private func prepareCreateVaultFormWithTrustedInput(alias: String, passcode: String) -> XCUIElement? {
        let webView = app.webViews.firstMatch
        guard webView.waitForExistence(timeout: 30) else {
            XCTFail("WKWebView did not appear")
            return nil
        }

        let createVaultButton = webView.buttons["Create Vault"]
        guard createVaultButton.waitForExistence(timeout: 15) else {
            attachCreateVaultDiagnostics(named: "create-vault-entry-missing")
            XCTFail("Create Vault entry did not appear")
            return nil
        }

        createVaultButton.tap()

        let dialogTitle = webView.staticTexts["Vault Initialization"]
        guard dialogTitle.waitForExistence(timeout: 10) else {
            attachCreateVaultDiagnostics(named: "create-vault-dialog-missing")
            XCTFail("Create vault dialog did not appear")
            return nil
        }

        let nameField = webView.textFields["Name"]
        guard nameField.waitForExistence(timeout: 10) else {
            attachCreateVaultDiagnostics(named: "create-vault-name-missing")
            XCTFail("Create vault Name field did not appear")
            return nil
        }

        let passcodeField = webView.secureTextFields["Passcode"]
        guard passcodeField.waitForExistence(timeout: 10) else {
            attachCreateVaultDiagnostics(named: "create-vault-passcode-missing")
            XCTFail("Create vault Passcode field did not appear")
            return nil
        }

        guard enterCreateVaultAlias(alias, in: webView) else {
            return nil
        }
        guard assertNameField(alias, matches: webView.textFields["Name"], artifactName: "create-vault-name-corrupted-before-passcode") else {
            return nil
        }

        guard enterCreateVaultPasscodeSecurely(passcode, alias: alias, in: webView) else {
            return nil
        }
        guard assertNameField(alias, matches: webView.textFields["Name"], artifactName: "create-vault-name-corrupted-after-passcode") else {
            return nil
        }

        dismissKeyboardIfNeeded(using: dialogTitle)
        guard assertNameField(alias, matches: webView.textFields["Name"], artifactName: "create-vault-name-corrupted-before-submit") else {
            return nil
        }

        let submitButton = webView.buttons["Create"]
        guard submitButton.waitForExistence(timeout: 5) else {
            attachCreateVaultDiagnostics(named: "create-vault-submit-missing")
            XCTFail("Create vault submit button did not appear")
            return nil
        }

        return submitButton
    }

    private func enterCreateVaultAlias(_ alias: String, in webView: XCUIElement) -> Bool {
        let nameField = webView.textFields["Name"]
        guard nameField.waitForExistence(timeout: 5) else {
            attachCreateVaultDiagnostics(named: "create-vault-name-missing-before-entry")
            XCTFail("Create vault Name field disappeared before alias entry")
            return false
        }

        return focusAndType(alias, into: nameField, fieldName: "Name")
    }

    private func enterCreateVaultPasscodeSecurely(_ passcode: String, alias: String, in webView: XCUIElement) -> Bool {
        let keyboard = app.keyboards.firstMatch

        for attempt in 1...3 {
            let nameField = webView.textFields["Name"]
            let passcodeField = webView.secureTextFields["Passcode"]

            guard nameField.waitForExistence(timeout: 5), passcodeField.waitForExistence(timeout: 5) else {
                attachCreateVaultDiagnostics(named: "Passcode-field-missing-before-entry")
                XCTFail("Create vault form fields disappeared before secure passcode entry")
                return false
            }

            bringElementIntoViewIfNeeded(passcodeField, within: webView)
            focusCreateVaultPasscodeField(passcodeField, keyboard: keyboard, attempt: attempt)

            guard keyboard.waitForExistence(timeout: 5) else {
                continue
            }

            guard secureFieldAppearsFocused(passcodeField) else {
                continue
            }

            let initialRawValue = rawFieldValue(passcodeField)
            let initialValue = normalizedFieldValue(passcodeField)
            app.typeText(passcode)

            let refreshedNameField = webView.textFields["Name"]
            guard assertNameField(alias, matches: refreshedNameField, artifactName: "create-vault-name-corrupted-after-passcode") else {
                return false
            }

            let refreshedPasscodeField = webView.secureTextFields["Passcode"]
            return assertSecureFieldCapturedInput(
                refreshedPasscodeField,
                fieldName: "Passcode",
                initialRawValue: initialRawValue,
                initialValue: initialValue
            )
        }

        attachCreateVaultDiagnostics(named: "Passcode-focus-missing")
        XCTFail("Passcode field did not gain a trustworthy focused state after semantic and coordinate taps; refusing to submit Create Vault because runtime evidence would be contaminated.")
        return false
    }

    private func bringElementIntoViewIfNeeded(_ element: XCUIElement, within container: XCUIElement) {
        guard element.exists, !element.isHittable else { return }

        if element.frame.midY > container.frame.midY {
            container.swipeUp()
        } else {
            container.swipeDown()
        }

        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    }

    private func focusCreateVaultPasscodeField(_ field: XCUIElement, keyboard: XCUIElement, attempt: Int) {
        field.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))

        if secureFieldAppearsFocused(field) {
            return
        }

        if !keyboard.waitForExistence(timeout: 1) || !secureFieldAppearsFocused(field) || attempt > 1 {
            tapElementCenter(field)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
    }

    private func tapElementCenter(_ element: XCUIElement) {
        let coordinate = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        coordinate.tap()
    }

    private func secureFieldAppearsFocused(_ field: XCUIElement) -> Bool {
        let rawValue = rawFieldValue(field).trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawValue.isEmpty && rawValue != "Passcode" && rawValue != "Secure Text Field" {
            return true
        }

        return createVaultFocusHints()
            .components(separatedBy: .newlines)
            .contains { line in
                line.contains("SecureTextField") && line.contains("label: 'Passcode'") && line.contains("Focused")
            }
    }

    @discardableResult
    private func focusAndType(_ text: String, into field: XCUIElement, fieldName: String) -> Bool {
        field.tap()

        let keyboard = app.keyboards.firstMatch
        if !keyboard.waitForExistence(timeout: 2) {
            let coordinate = field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            coordinate.tap()
        }

        guard keyboard.waitForExistence(timeout: 5) else {
            attachCreateVaultDiagnostics(named: "\(fieldName)-keyboard-missing")
            XCTFail("\(fieldName) field did not gain keyboard focus")
            return false
        }

        clearTextIfNeeded(in: field)

        if field.elementType == .secureTextField {
            let initialRawValue = rawFieldValue(field)
            let initialValue = normalizedFieldValue(field)
            app.typeText(text)
            return assertSecureFieldCapturedInput(
                field,
                fieldName: fieldName,
                initialRawValue: initialRawValue,
                initialValue: initialValue
            )
        }

        app.typeText(text)
        return true
    }

    private func clearTextIfNeeded(in field: XCUIElement) {
        let existingText = normalizedFieldValue(field)
        guard !existingText.isEmpty else { return }

        app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existingText.count))
    }

    private func rawFieldValue(_ field: XCUIElement) -> String {
        field.value.map(String.init(describing:)) ?? ""
    }

    private func normalizedFieldValue(_ field: XCUIElement) -> String {
        let rawValue = rawFieldValue(field)
        let trimmedValue = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)

        switch trimmedValue {
        case "", "Name", "Passcode", "Secure Text Field", "Text Field":
            return ""
        default:
            return trimmedValue
        }
    }

    @discardableResult
    private func assertNameField(_ expectedAlias: String, matches field: XCUIElement, artifactName: String) -> Bool {
        let actualValue = normalizedFieldValue(field)

        guard actualValue == expectedAlias else {
            attachCreateVaultDiagnostics(named: artifactName)

            if actualValue.hasPrefix(expectedAlias) && actualValue.count > expectedAlias.count {
                XCTFail("Name field was mutated after passcode targeting; passcode text leaked into Name")
                return false
            }

            XCTFail("Name field did not preserve the expected alias")
            return false
        }

        return true
    }

    @discardableResult
    private func assertSecureFieldCapturedInput(
        _ field: XCUIElement,
        fieldName: String,
        initialRawValue: String,
        initialValue: String
    ) -> Bool {
        let actualRawValue = rawFieldValue(field).trimmingCharacters(in: .whitespacesAndNewlines)
        let actualValue = normalizedFieldValue(field)

        guard !actualValue.isEmpty else {
            attachCreateVaultDiagnostics(named: "\(fieldName)-input-missing")
            XCTFail("\(fieldName) field did not capture input after targeting; refusing to submit Create Vault because runtime evidence would be contaminated.")
            return false
        }

        guard actualRawValue != initialRawValue || actualValue != initialValue else {
            attachCreateVaultDiagnostics(named: "\(fieldName)-input-unchanged")
            XCTFail("\(fieldName) field did not change after targeting; refusing to submit Create Vault because runtime evidence would be contaminated.")
            return false
        }

        return true
    }

    private func dismissKeyboardIfNeeded(using anchor: XCUIElement) {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }

        let dismissalButtons = ["Done", "Hide keyboard", "Return"]
        for label in dismissalButtons {
            let button = keyboard.buttons[label]
            if button.exists && button.isHittable {
                button.tap()
                return
            }
        }

        if anchor.exists && anchor.isHittable {
            anchor.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        }
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
