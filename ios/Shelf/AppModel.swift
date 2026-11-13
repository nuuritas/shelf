import Foundation
import SwiftUI
import WebKit

@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case onboarding
        case library
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var config: ServerConfig?
    @Published var isBusy = false
    @Published var errorMessage: String?

    private let api = APIClient()

    init() {
        if let saved = SharedStore.loadConfig() {
            config = saved
            phase = .library
        } else {
            phase = .onboarding
        }
    }

    // MARK: - Onboarding

    func connectSelfHosted(urlText: String, password: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            let base = try ServerConfig.normalizeBaseURL(urlText)
            try await api.validateSelfHosted(baseURL: base, password: password)
            try Keychain.set(password, for: .password)

            // A failed login is not fatal: the WebView can still show the
            // server's own login page.
            let cookies = await api.loginForWeb(baseURL: base, password: password)
            if cookies.isEmpty {
                await WebSession.clearAll()
            } else {
                await WebSession.install(cookies)
            }

            let saved = ServerConfig(
                mode: .selfHosted,
                baseURL: base.absoluteString,
                email: "",
                displayName: base.host ?? base.absoluteString
            )
            SharedStore.saveConfig(saved)
            config = saved
            phase = .library
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func connectCloud(email: String, password: String, baseText: String) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedEmail.isEmpty, !password.isEmpty else {
            errorMessage = "Enter your email and password."
            return
        }

        do {
            let base = try ServerConfig.normalizedCloudBaseURL(baseText)
            let session = try await api.cloudLogin(baseURL: base, email: trimmedEmail, password: password)
            try Keychain.set(session.token, for: .cloudToken)

            if session.cookies.isEmpty {
                await WebSession.clearAll()
            } else {
                await WebSession.install(session.cookies)
            }

            let saved = ServerConfig(
                mode: .cloud,
                baseURL: base.absoluteString,
                email: trimmedEmail,
                displayName: session.displayName
            )
            SharedStore.saveConfig(saved)
            config = saved
            phase = .library
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Session

    /// Make sure the WebView has a session cookie before loading the library.
    /// The app re-logs in with the stored password when the cookie is missing;
    /// cloud cookies arrive with the sign-in response and are kept by WebKit.
    func prepareWebSession() async -> Bool {
        guard let config, let base = config.base else { return false }
        if await WebSession.hasSessionCookie(for: base) {
            return true
        }
        guard config.mode == .selfHosted,
              let password = Keychain.value(for: .password) else {
            return false
        }
        let cookies = await api.loginForWeb(baseURL: base, password: password)
        guard !cookies.isEmpty else { return false }
        await WebSession.install(cookies)
        return true
    }

    func signOut() async {
        Keychain.removeAll()
        SharedStore.clearConfig()
        await WebSession.clearAll()
        URLCache.shared.removeAllCachedResponses()
        config = nil
        errorMessage = nil
        phase = .onboarding
    }
}

/// Cookie handoff between `URLSession` and the WebView's cookie store.
@MainActor
enum WebSession {
    private static var cookieStore: WKHTTPCookieStore {
        WKWebsiteDataStore.default().httpCookieStore
    }

    static func install(_ cookies: [HTTPCookie]) async {
        guard !cookies.isEmpty else { return }
        let store = cookieStore
        for cookie in cookies {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                store.setCookie(cookie) {
                    continuation.resume()
                }
            }
        }
    }

    static func allCookies() async -> [HTTPCookie] {
        let store = cookieStore
        return await withCheckedContinuation { (continuation: CheckedContinuation<[HTTPCookie], Never>) in
            store.getAllCookies { cookies in
                continuation.resume(returning: cookies)
            }
        }
    }

    static func hasSessionCookie(for baseURL: URL) async -> Bool {
        let host = (baseURL.host ?? "").lowercased()
        guard !host.isEmpty else { return false }
        return await allCookies().contains { cookie in
            guard cookie.name == "shelf_session" else { return false }
            let domain = cookie.domain.lowercased()
            if domain == host { return true }
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            return host == bare || host.hasSuffix(".\(bare)")
        }
    }

    static func clearAll() async {
        let store = cookieStore
        let cookies = await allCookies()
        for cookie in cookies {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                store.delete(cookie) {
                    continuation.resume()
                }
            }
        }
        URLCache.shared.removeAllCachedResponses()
    }
}
