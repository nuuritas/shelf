import Foundation

struct CloudSession {
    let token: String
    let displayName: String
    let cookies: [HTTPCookie]
}

struct SaveResult {
    let status: Int
    let message: String?

    var succeeded: Bool { (200..<300).contains(status) }
}

enum APIError: LocalizedError {
    case invalidURL
    case unreachable
    case invalidServer
    case unauthorized
    case server(String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "That server address could not be used."
        case .unreachable:
            return "Could not reach the server. Check the address and your connection."
        case .invalidServer:
            return "That address does not answer like a Shelf server."
        case .unauthorized:
            return "The password was not accepted."
        case .server(let message):
            return message
        case .network(let message):
            return message
        }
    }
}

/// All HTTP is plain `URLSession`; no third-party dependencies.
struct APIClient {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    /// `GET /healthz` must return `{"ok":true}`, then `GET /api/stats` with the
    /// password as a bearer token proves the password is correct.
    func validateSelfHosted(baseURL: URL, password: String) async throws {
        var health = URLRequest(url: endpoint(baseURL, "healthz"))
        health.timeoutInterval = 15
        health.setValue("application/json", forHTTPHeaderField: "Accept")
        health.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let (healthData, healthResponse) = try await data(for: health)
        guard healthResponse.statusCode == 200 else {
            throw APIError.server("The server answered /healthz with HTTP \(healthResponse.statusCode).")
        }
        guard let ok = try? decoder.decode(HealthResponse.self, from: healthData).ok, ok == true else {
            throw APIError.invalidServer
        }

        var stats = URLRequest(url: endpoint(baseURL, "api/stats"))
        stats.timeoutInterval = 15
        stats.setValue("application/json", forHTTPHeaderField: "Accept")
        stats.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
        stats.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let (statsData, statsResponse) = try await data(for: stats)
        guard statsResponse.statusCode == 200 else {
            if statsResponse.statusCode == 401 {
                throw APIError.unauthorized
            }
            throw APIError.server(errorMessage(from: statsData) ?? "The server answered /api/stats with HTTP \(statsResponse.statusCode).")
        }
    }

    /// Log in for the WebView. The request must not follow redirects: the
    /// session lives in the `Set-Cookie` header of the 303 response.
    func loginForWeb(baseURL: URL, password: String) async -> [HTTPCookie] {
        var request = URLRequest(url: endpoint(baseURL, "login"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
        request.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")
        request.httpBody = Self.formBody(password: password)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never

        let delegate = NoRedirectDelegate()
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<400).contains(http.statusCode) else {
                return []
            }
            return Self.cookies(from: http, fallbackURL: baseURL)
        } catch {
            return []
        }
    }

    /// Shelf Cloud sign-in: JSON `{email,password}` in, `{token,user,tenant}`
    /// (and ideally `Set-Cookie`) out.
    func cloudLogin(baseURL: URL, email: String, password: String) async throws -> CloudSession {
        // Start from a clean cookie jar so any cookie captured below belongs to
        // this sign-in, not to a previous account on the same host.
        if let existing = HTTPCookieStorage.shared.cookies(for: baseURL) {
            for cookie in existing {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }

        var request = URLRequest(url: endpoint(baseURL, "api/auth/login"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")
        request.httpBody = try encoder.encode(CloudLoginBody(email: email, password: password))

        let (data, response) = try await data(for: request)
        let cookies = Self.merge(
            Self.cookies(from: response, fallbackURL: baseURL),
            Self.storedCookies(for: baseURL)
        )

        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 {
                throw APIError.unauthorized
            }
            throw APIError.server(errorMessage(from: data) ?? "Sign-in failed (HTTP \(response.statusCode)).")
        }

        let decoded = try? decoder.decode(CloudLoginResponse.self, from: data)
        if let error = decoded?.error, !error.isEmpty {
            throw APIError.server(error)
        }
        guard let token = decoded?.token?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else {
            throw APIError.server("The cloud did not return a session token.")
        }

        let displayName = decoded?.user?.displayName
            ?? decoded?.user?.name
            ?? decoded?.user?.email
            ?? email

        return CloudSession(token: token, displayName: displayName, cookies: cookies)
    }

    /// `POST /api/bookmarks` with either the self-hosted password or the cloud
    /// token as a bearer token.
    func saveBookmark(baseURL: URL, secret: String, link: URL) async throws -> SaveResult {
        var request = URLRequest(url: endpoint(baseURL, "api/bookmarks"))
        request.httpMethod = "POST"
        request.timeoutInterval = 25
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        request.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")
        request.httpBody = try encoder.encode(SaveBookmarkBody(url: link.absoluteString))

        let (data, response) = try await data(for: request)
        return SaveResult(status: response.statusCode, message: errorMessage(from: data))
    }

    // MARK: - Helpers

    private func endpoint(_ baseURL: URL, _ path: String) -> URL {
        var url = baseURL
        for component in path.split(separator: "/") {
            url.appendPathComponent(String(component))
        }
        return url
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw APIError.invalidServer
            }
            return (data, http)
        } catch let error as APIError {
            throw error
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
                 .notConnectedToInternet, .networkConnectionLost, .timedOut:
                throw APIError.unreachable
            default:
                throw APIError.network(error.localizedDescription)
            }
        } catch {
            throw APIError.network(error.localizedDescription)
        }
    }

    private func errorMessage(from data: Data) -> String? {
        if let body = try? decoder.decode(APIErrorBody.self, from: data),
           let message = body.error,
           !message.isEmpty {
            return message
        }
        guard let text = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return nil
        }
        return String(text.prefix(160))
    }

    private static func formBody(password: String) -> Data {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "password", value: password),
            URLQueryItem(name: "next", value: "/"),
        ]
        return Data((components.percentEncodedQuery ?? "").utf8)
    }

    private static func cookies(from response: HTTPURLResponse, fallbackURL: URL) -> [HTTPCookie] {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            guard let key = key as? String else { continue }
            headers[key] = String(describing: value)
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: response.url ?? fallbackURL)
    }

    /// `URLSession.shared` also stores `Set-Cookie` from redirect responses, so
    /// pick those up for the WebView as well.
    private static func storedCookies(for baseURL: URL) -> [HTTPCookie] {
        HTTPCookieStorage.shared.cookies(for: baseURL) ?? []
    }

    private static func merge(_ primary: [HTTPCookie], _ secondary: [HTTPCookie]) -> [HTTPCookie] {
        var seen = Set<String>()
        var result: [HTTPCookie] = []
        for cookie in primary + secondary {
            let key = "\(cookie.name)|\(cookie.domain)|\(cookie.path)"
            if seen.insert(key).inserted {
                result.append(cookie)
            }
        }
        return result
    }
}

private struct HealthResponse: Decodable {
    let ok: Bool?
}

private struct CloudLoginBody: Encodable {
    let email: String
    let password: String
}

private struct CloudLoginResponse: Decodable {
    struct User: Decodable {
        let name: String?
        let displayName: String?
        let email: String?
    }

    let token: String?
    let user: User?
    let error: String?
}

private struct SaveBookmarkBody: Encodable {
    let url: String
}

private struct APIErrorBody: Decodable {
    let error: String?
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
