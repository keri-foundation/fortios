import Foundation
import Testing

@testable import KeriWallet

@Suite("AppLogger breadcrumbs")
struct AppLoggerBreadcrumbTests {

    @Test("retains only the most recent breadcrumb entries")
    func retainsMostRecentEntries() {
        let category = "AppLoggerBreadcrumbTests.\(UUID().uuidString)"
        AppLogger.resetRetainedBreadcrumbs()

        for index in 0..<105 {
            AppLogger.notice("breadcrumb-\(index)", category: category)
        }

        let retained = AppLogger.retainedBreadcrumbs().filter { $0.category == category }
        #expect(!retained.isEmpty)
        #expect(retained.count <= 100)
        #expect(retained.first?.message == "breadcrumb-\(105 - retained.count)")
        #expect(retained.last?.message == "breadcrumb-104")
        #expect(retained.allSatisfy { $0.level == .notice })
    }

    @Test("reset clears retained breadcrumb buffer")
    func resetClearsBuffer() {
        let category = "AppLoggerBreadcrumbTests.\(UUID().uuidString)"
        AppLogger.resetRetainedBreadcrumbs()
        AppLogger.warning("stale breadcrumb", category: category)

        #expect(!AppLogger.retainedBreadcrumbs().filter { $0.category == category }.isEmpty)

        AppLogger.resetRetainedBreadcrumbs()

        #expect(AppLogger.retainedBreadcrumbs().filter { $0.category == category }.isEmpty)
    }

    @Test("error breadcrumbs retain appended error description")
    func errorBreadcrumbRetainsErrorDescription() {
        let category = "AppLoggerBreadcrumbTests.\(UUID().uuidString)"
        let error = NSError(
            domain: "AppLoggerBreadcrumbTests", code: 7,
            userInfo: [NSLocalizedDescriptionKey: "bridge unavailable"])

        AppLogger.resetRetainedBreadcrumbs()
        AppLogger.error("request failed", error: error, category: category)

        let retained = AppLogger.retainedBreadcrumbs().last { $0.category == category }
        #expect(retained?.level == .error)
        #expect(retained?.message == "request failed | Error: bridge unavailable")
    }
}
