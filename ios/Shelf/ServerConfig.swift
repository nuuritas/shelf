import Foundation

/// How the app reaches a Shelf library.
enum ShelfMode: String, Codable, CaseIterable, Identifiable, Hashable {
    case selfHosted
    case cloud

    var id: String { rawValue }

    var title: String {
        switch self {
        case .selfHosted: return "Self-hosted"
        case .cloud: return "Shelf Cloud"
        }
    }

    var subtitle: String {
        switch self {
        case .selfHosted: return "Your own Cloudflare Worker"
        case .cloud: return "Hosted, sign in with email"
        }
    }

    /// Keychain account that holds the secret for this mode.
    var secretKind: SecretKind {
        switch self {
        case .selfHosted: return .password
        case .cloud: return .cloudToken
        }
    }
}

/// Non-secret connection settings. This is shared with the extension through
/// the App Group's `UserDefaults`; secrets live in the Keychain.
struct ServerConfig: Codable, Equatable {
    var mode: ShelfMode
    var baseURL: String
    var email: String
    var displayName: String

    var base: URL? { URL(string: baseURL) }

    static var defaultCloudBaseURL: String {
        if let value = Bundle.main.object(forInfoDictionaryKey: "ShelfCloudBaseURL") as? String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && !trimmed.contains("$(") {
                return trimmed
            }
        }
        return "https://shelfcloud.nuritas.tr"
    }

    /// Trim, add a scheme when missing, require HTTPS except on loopback, and
    /// drop trailing slashes from the path.
    static func normalizeBaseURL(_ raw: String) throws -> URL {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw ConfigError.emptyURL }

        if !text.contains("://") {
            text = "https://" + text
        }

        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(),
              let host = components.host,
              !host.isEmpty else {
            throw ConfigError.invalidURL
        }
        guard scheme == "https" || scheme == "http" else {
            throw ConfigError.insecureURL
        }

        let loopback = ["localhost", "127.0.0.1", "::1"]
        if scheme != "https" && !loopback.contains(host.lowercased()) {
            throw ConfigError.insecureURL
        }

        var path = components.path
        while path.hasSuffix("/") {
            path.removeLast()
        }
        components.path = path
        components.query = nil
        components.fragment = nil

        guard let url = components.url else { throw ConfigError.invalidURL }
        return url
    }

    /// Cloud sign-in always goes over HTTPS.
    static func normalizedCloudBaseURL(_ raw: String) throws -> URL {
        let url = try normalizeBaseURL(raw)
        guard url.scheme?.lowercased() == "https" else { throw ConfigError.insecureURL }
        return url
    }
}

enum ConfigError: LocalizedError {
    case emptyURL
    case invalidURL
    case insecureURL

    var errorDescription: String? {
        switch self {
        case .emptyURL:
            return "Enter the server address first."
        case .invalidURL:
            return "That does not look like a valid server address."
        case .insecureURL:
            return "Use an https:// address. Plain http is only allowed for localhost or 127.0.0.1."
        }
    }
}

/// Small wrapper around the shared App Group defaults. The fallback keeps the
/// app usable in unsigned/simulator builds where the App Group is unavailable;
/// the extension then cannot see the config until the app is signed.
enum SharedStore {
    static let appGroupID = "group.tr.nuritas.shelf"
    private static let configKey = "shelf.config.v1"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    static func loadConfig() -> ServerConfig? {
        guard let data = defaults.data(forKey: configKey) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    static func saveConfig(_ config: ServerConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        defaults.set(data, forKey: configKey)
        defaults.synchronize()
    }

    static func clearConfig() {
        defaults.removeObject(forKey: configKey)
        defaults.synchronize()
    }
}
