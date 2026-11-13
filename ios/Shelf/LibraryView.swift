import SwiftUI
import UIKit
import WebKit

/// The library itself: the configured server inside a WKWebView. The session
/// cookie is installed before the first load; off-site links open in Safari.
struct LibraryView: View {
    @EnvironmentObject private var model: AppModel

    @State private var showSettings = false
    @State private var reloadToken = UUID()
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ZStack {
                if let base = model.config?.base {
                    ShelfWebView(
                        baseURL: base,
                        reloadToken: reloadToken,
                        isLoading: $isLoading,
                        prepareSession: { await model.prepareWebSession() }
                    )
                    .ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView(
                        "No server configured",
                        systemImage: "server.rack",
                        description: Text("Open Settings to connect Shelf to a library.")
                    )
                }

                if isLoading {
                    ProgressView()
                        .controlSize(.large)
                        .padding(20)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .navigationTitle("Shelf")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        isLoading = true
                        reloadToken = UUID()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload library")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
    }
}

private struct ShelfWebView: UIViewRepresentable {
    let baseURL: URL
    let reloadToken: UUID
    @Binding var isLoading: Bool
    let prepareSession: () async -> Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(isLoading: $isLoading, prepareSession: prepareSession)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.keyboardDismissMode = .interactive
        webView.allowsBackForwardNavigationGestures = true
        context.coordinator.webView = webView
        context.coordinator.load(webView: webView, baseURL: baseURL, token: reloadToken)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.loadedURL != baseURL {
            context.coordinator.load(webView: webView, baseURL: baseURL, token: reloadToken)
        } else if context.coordinator.loadedToken != reloadToken {
            context.coordinator.loadedToken = reloadToken
            context.coordinator.isLoading = $isLoading
            context.coordinator.prepareSession = prepareSession
            isLoading = true
            webView.reload()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
        var loadedToken: UUID?
        var isLoading: Binding<Bool>
        var prepareSession: () async -> Bool
        weak var webView: WKWebView?
        private var baseHost = ""

        init(isLoading: Binding<Bool>, prepareSession: @escaping () async -> Bool) {
            self.isLoading = isLoading
            self.prepareSession = prepareSession
        }

        func load(webView: WKWebView, baseURL: URL, token: UUID) {
            loadedURL = baseURL
            loadedToken = token
            baseHost = (baseURL.host ?? "").lowercased()
            isLoading.wrappedValue = true

            Task { @MainActor in
                _ = await prepareSession()
                guard self.loadedURL == baseURL else { return }
                webView.load(URLRequest(url: baseURL))
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            isLoading.wrappedValue = true
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoading.wrappedValue = false
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            isLoading.wrappedValue = false
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            isLoading.wrappedValue = false
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.targetFrame?.isMainFrame != false,
                  let url = navigationAction.request.url,
                  let scheme = url.scheme?.lowercased() else {
                decisionHandler(.allow)
                return
            }

            if scheme == "about" || scheme == "data" || scheme == "blob" {
                decisionHandler(.allow)
                return
            }

            guard scheme == "http" || scheme == "https" else {
                if UIApplication.shared.canOpenURL(url) {
                    UIApplication.shared.open(url)
                }
                decisionHandler(.cancel)
                return
            }

            let host = (url.host ?? "").lowercased()
            if host == baseHost {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }
    }
}
