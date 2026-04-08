import XCTest

final class KeriWalletUITests: XCTestCase {
    private var app: XCUIApplication!

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

    func test_app_launches_into_web_shell() {
        XCTAssertTrue(app.state == .runningForeground)
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.webViews.firstMatch.staticTexts["KERI Wallet"].waitForExistence(timeout: 15))
    }

    func test_can_open_settings_and_see_settings_content() {
        let webView = app.webViews.firstMatch
        XCTAssertTrue(webView.waitForExistence(timeout: 15))

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
}
