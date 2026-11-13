import Foundation
import Security

enum SecretKind: String {
    case password
    case cloudToken
}

enum KeychainError: LocalizedError {
    case storeFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .storeFailed:
            return "The secret could not be stored in the Keychain. Check the app's Keychain Sharing entitlement."
        }
    }
}

/// Keychain access for the app and its share extension.
///
/// Both targets declare `$(AppIdentifierPrefix)group.tr.nuritas.shelf` in
/// their keychain-access-groups entitlement. The team prefix is not available
/// as a build setting in Swift code, so it is derived from the default
/// Keychain group. Unsigned builds have no shared group and fall back to the
/// local Keychain; signing is required for the extension to read the secret.
enum Keychain {
    private static let service = "tr.nuritas.shelf"
    private static let sharedGroupSuffix = "group.tr.nuritas.shelf"

    static func set(_ value: String, for kind: SecretKind) throws {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: kind.rawValue,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        var lastStatus = errSecSuccess
        for group in candidateGroups() {
            var query = base
            if let group = group {
                query[kSecAttrAccessGroup as String] = group
            }
            SecItemDelete(query as CFDictionary)

            var add = query
            for (key, value) in attributes {
                add[key] = value
            }
            let status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecSuccess {
                return
            }
            lastStatus = status
        }
        throw KeychainError.storeFailed(lastStatus)
    }

    static func value(for kind: SecretKind) -> String? {
        for group in candidateGroups() {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: kind.rawValue,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            if let group = group {
                query[kSecAttrAccessGroup as String] = group
            }

            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess,
               let data = result as? Data,
               let text = String(data: data, encoding: .utf8) {
                return text
            }
        }
        return nil
    }

    static func remove(_ kind: SecretKind) {
        for group in candidateGroups() {
            var query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: kind.rawValue,
            ]
            if let group = group {
                query[kSecAttrAccessGroup as String] = group
            }
            SecItemDelete(query as CFDictionary)
        }
    }

    static func removeAll() {
        remove(.password)
        remove(.cloudToken)
    }

    private static func candidateGroups() -> [String?] {
        if let group = sharedAccessGroup() {
            return [group, nil]
        }
        return [nil]
    }

    /// Derive the team prefix from the app's default Keychain group, because
    /// Swift code cannot expand `$(AppIdentifierPrefix)` at runtime. The
    /// Info.plist value is only a fallback when it already contains a team
    /// prefix; unsigned builds expand it to a prefixless group, which would
    /// never match the entitlement.
    private static func sharedAccessGroup() -> String? {
        if let prefix = teamIdentifierPrefix(), !prefix.isEmpty {
            return "\(prefix).\(sharedGroupSuffix)"
        }
        if let configured = Bundle.main.object(forInfoDictionaryKey: "ShelfKeychainAccessGroup") as? String {
            let trimmed = configured.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty,
               !trimmed.contains("$("),
               trimmed.hasSuffix(".\(sharedGroupSuffix)") {
                return trimmed
            }
        }
        return nil
    }

    private static func teamIdentifierPrefix() -> String? {
        let probeAccount = "shelf.access-group-probe"
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
        ]

        var add = base
        add[kSecValueData as String] = Data("probe".utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
            return nil
        }

        var query = base
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        SecItemDelete(base as CFDictionary)

        guard status == errSecSuccess,
              let attributes = result as? [String: Any],
              let group = attributes[kSecAttrAccessGroup as String] as? String,
              let prefix = group.split(separator: ".").first,
              !prefix.isEmpty else {
            return nil
        }
        return String(prefix)
    }
}
