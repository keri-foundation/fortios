import Foundation
import WebKit

struct WebNavigationPolicy {
    let allowedSchemes: Set<String>
    let allowedLoopbackOrigin: LoopbackOrigin?

    init(
        allowedSchemes: Set<String> = AppConfig.Scheme.allowedSchemes,
        allowedLoopbackOrigin: LoopbackOrigin? = nil
    ) {
        self.allowedSchemes = allowedSchemes
        self.allowedLoopbackOrigin = allowedLoopbackOrigin
    }

    func isAllowed(url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "about" {
            return url.absoluteString == AppConfig.Scheme.aboutBlankURL
        }

        if let allowedLoopbackOrigin {
            return allowedLoopbackOrigin.matches(url: url)
        }

        return allowedSchemes.contains(scheme)
    }

    var isLoopbackDebugEnabled: Bool {
        allowedLoopbackOrigin != nil
    }
}

final class WebNavDelegate: NSObject, WKNavigationDelegate {
    private let policy: WebNavigationPolicy
    var onDidFinish: ((WKWebView) -> Void)?

    init(policy: WebNavigationPolicy) {
        self.policy = policy
        super.init()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            AppLogger.error(
                "[WebNav] webnav.navigation.block error_description=\"missing URL\" navigation_type=\"\(navigationTypeName(for: navigationAction.navigationType))\"",
                category: AppConfig.Log.webNav)
            decisionHandler(.cancel)
            return
        }

        AppLogger.notice(
            "[WebNav] webnav.navigation.start \(navigationFields(url: url, navigationType: navigationAction.navigationType))",
            category: AppConfig.Log.webNav)

        if policy.isAllowed(url: url) {
            AppLogger.notice(
                "[WebNav] webnav.navigation.allow \(navigationFields(url: url, navigationType: navigationAction.navigationType))",
                category: AppConfig.Log.webNav)
            decisionHandler(.allow)
            return
        }

        AppLogger.warning(
            "[WebNav] webnav.navigation.block \(navigationFields(url: url, navigationType: navigationAction.navigationType))",
            category: AppConfig.Log.webNav)
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppLogger.error("[WebNav] web content process terminated", category: AppConfig.Log.webNav)
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        AppLogger.notice(
            "[WebNav] webnav.did_finish \(navigationFields(url: webView.url, navigationType: nil))",
            category: AppConfig.Log.webNav)
        onDidFinish?(webView)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        AppLogger.error(
            "[WebNav] webnav.provisional_error \(errorFields(url: webView.url, error: error))",
            category: AppConfig.Log.webNav)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        AppLogger.error(
            "[WebNav] webnav.navigation_error \(errorFields(url: webView.url, error: error))",
            category: AppConfig.Log.webNav)
    }

    private func navigationTypeName(for navigationType: WKNavigationType) -> String {
        switch navigationType {
        case .linkActivated:
            return "link_activated"
        case .formSubmitted:
            return "form_submitted"
        case .backForward:
            return "back_forward"
        case .reload:
            return "reload"
        case .formResubmitted:
            return "form_resubmitted"
        case .other:
            return "other"
        @unknown default:
            return "unknown"
        }
    }

    private func navigationFields(url: URL?, navigationType: WKNavigationType?) -> String {
        var fields: [String] = []

        fields.append("loopback_debug=\"\(policy.isLoopbackDebugEnabled ? "true" : "false")\"")

        if let allowedLoopbackOrigin = policy.allowedLoopbackOrigin {
            fields.append("loopback_origin=\"\(quoted(allowedLoopbackOrigin.baseURL.absoluteString))\"")
        }

        if let url {
            fields.append("url=\"\(quoted(url.absoluteString))\"")
            fields.append("scheme=\"\(quoted(url.scheme ?? ""))\"")
            fields.append("host=\"\(quoted(url.host ?? ""))\"")
        }

        if let navigationType {
            fields.append("navigation_type=\"\(quoted(navigationTypeName(for: navigationType)))\"")
        }

        return fields.joined(separator: " ")
    }

    private func errorFields(url: URL?, error: Error) -> String {
        let nsError = error as NSError
        var fields: [String] = []

        if let url {
            fields.append("url=\"\(quoted(url.absoluteString))\"")
            fields.append("scheme=\"\(quoted(url.scheme ?? ""))\"")
            fields.append("host=\"\(quoted(url.host ?? ""))\"")
        }

        fields.append("error_domain=\"\(quoted(nsError.domain))\"")
        fields.append("error_code=\"\(nsError.code)\"")
        fields.append("error_description=\"\(quoted(nsError.localizedDescription))\"")
        return fields.joined(separator: " ")
    }

    private func quoted(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}
