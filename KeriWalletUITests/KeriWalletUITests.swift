import XCTest

final class KeriWalletUITests: XCTestCase {
    private var app: XCUIApplication!

    private var webView: XCUIElement {
        app.webViews.firstMatch
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        if let run = testRun, !run.hasSucceeded {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Failure Screenshot"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    private func waitForShell() {
        XCTAssertTrue(webView.waitForExistence(timeout: 15))
    }

    func test_app_launches_into_web_shell() {
        XCTAssertTrue(app.state == .runningForeground)
        waitForShell()
        XCTAssertTrue(webView.staticTexts["KERI Wallet"].waitForExistence(timeout: 15))
    }

    func test_can_open_settings_and_see_settings_content() {
        waitForShell()

        let settingsButton = webView.buttons["Settings"]
        XCTAssertTrue(settingsButton.waitForExistence(timeout: 15))

        XCTContext.runActivity(named: "Open Settings tab") { _ in
            settingsButton.tap()
        }

        XCTContext.runActivity(named: "Assert stable settings content is present") { _ in
            XCTAssertTrue(webView.staticTexts["Appearance"].waitForExistence(timeout: 15))
            XCTAssertTrue(webView.staticTexts["Active Vault"].waitForExistence(timeout: 15))
        }
    }

    func test_can_open_vault_from_home_and_see_identifier_controls() {
        waitForShell()

        let openVaultButton = webView.buttons["Open Vault"]
        XCTAssertTrue(openVaultButton.waitForExistence(timeout: 15))

        XCTContext.runActivity(named: "Open vault from home") { _ in
            openVaultButton.tap()
        }

        XCTContext.runActivity(named: "Assert identifiers controls are present") { _ in
            XCTAssertTrue(webView.staticTexts["Identifiers"].waitForExistence(timeout: 15))
            XCTAssertTrue(webView.buttons["Seed Test Data"].waitForExistence(timeout: 15))
            XCTAssertTrue(webView.buttons["List Identifiers"].waitForExistence(timeout: 15))
        }
    }

    func test_can_switch_vault_sections_and_see_notifications_page() {
        waitForShell()

        let openVaultButton = webView.buttons["Open Vault"]
        XCTAssertTrue(openVaultButton.waitForExistence(timeout: 15))
        openVaultButton.tap()

        let alertsButton = webView.buttons["Alerts"]
        XCTAssertTrue(alertsButton.waitForExistence(timeout: 15))

        XCTContext.runActivity(named: "Open alerts section from vault") { _ in
            alertsButton.tap()
        }

        XCTContext.runActivity(named: "Assert notifications content is visible") { _ in
            XCTAssertTrue(webView.staticTexts["Notifications"].waitForExistence(timeout: 15))
            XCTAssertTrue(webView.staticTexts["Doer events"].waitForExistence(timeout: 15))
            XCTAssertTrue(webView.staticTexts["Toast UX"].waitForExistence(timeout: 15))
        }
    }
}
