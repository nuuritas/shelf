import UIKit
import UniformTypeIdentifiers

/// The share sheet target. It extracts the first link, posts it to the
/// configured Shelf server, shows one short confirmation, and dismisses.
/// Shared content is never written to the console.
final class ShareViewController: UIViewController {
    private let statusContainer = UIView()
    private let statusLabel = UILabel()
    private var hasStarted = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        configureStatusView()
        preferredContentSize = CGSize(width: 320, height: 180)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !hasStarted else { return }
        hasStarted = true
        Task { await handleShare() }
    }

    // MARK: - Flow

    private func handleShare() async {
        guard let link = await sharedLink() else {
            showAlert(
                title: "Nothing to save",
                message: "Share a post link, or text that contains a link."
            )
            return
        }

        guard let config = SharedStore.loadConfig(),
              let baseURL = config.base,
              let secret = Keychain.value(for: config.mode.secretKind),
              !secret.isEmpty else {
            showAlert(
                title: "Set up Shelf first",
                message: "Open the Shelf app and connect to a server, then share this link again."
            )
            return
        }

        showStatus("Saving…")
        let resolved = await expandShortLink(link)

        do {
            let result = try await APIClient().saveBookmark(
                baseURL: baseURL,
                secret: secret,
                link: resolved
            )

            if result.succeeded {
                showStatus("Saved to Shelf")
                try? await Task.sleep(nanoseconds: 1_100_000_000)
                finish()
            } else if result.status == 401 {
                showAlert(
                    title: "Not saved",
                    message: "The password or token was rejected. Open Shelf → Settings to reconnect."
                )
            } else {
                showAlert(
                    title: "Not saved",
                    message: result.message ?? "The server answered with HTTP \(result.status)."
                )
            }
        } catch {
            showAlert(title: "Not saved", message: error.localizedDescription)
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    // MARK: - Reading the shared item

    private func sharedLink() async -> URL? {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []

        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let url = await loadURL(from: provider),
                       let scheme = url.scheme?.lowercased(),
                       scheme == "http" || scheme == "https" {
                        return url
                    }
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let text = await loadText(from: provider, typeIdentifier: UTType.plainText.identifier),
                       let url = Self.firstURL(in: text) {
                        return url
                    }
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
                    if let text = await loadText(from: provider, typeIdentifier: UTType.text.identifier),
                       let url = Self.firstURL(in: text) {
                        return url
                    }
                }
            }

            if let text = item.attributedContentText?.string,
               let url = Self.firstURL(in: text) {
                return url
            }
        }

        return nil
    }

    private func loadURL(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let url = item as? NSURL {
                    continuation.resume(returning: url as URL)
                } else if let text = item as? String {
                    continuation.resume(returning: Self.firstURL(in: text))
                } else if let data = item as? Data,
                          let text = String(data: data, encoding: .utf8) {
                    continuation.resume(returning: Self.firstURL(in: text))
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func loadText(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let text = item as? String {
                    continuation.resume(returning: text)
                } else if let attributed = item as? NSAttributedString {
                    continuation.resume(returning: attributed.string)
                } else if let data = item as? Data {
                    continuation.resume(returning: String(data: data, encoding: .utf8))
                } else if let url = item as? URL {
                    continuation.resume(returning: url.absoluteString)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    /// The first http(s) URL in a shared string. NSDataDetector handles the
    /// common case; the regex is a fallback for text the detector skips.
    nonisolated private static func firstURL(in text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
            for match in detector.matches(in: trimmed, options: [], range: range) {
                if let url = match.url,
                   let scheme = url.scheme?.lowercased(),
                   scheme == "http" || scheme == "https" {
                    return url
                }
            }
        }

        guard let regex = try? NSRegularExpression(pattern: "https?://[^\\s]+", options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        guard let match = regex.firstMatch(in: trimmed, options: [], range: range) else {
            return nil
        }

        var candidate = (trimmed as NSString).substring(with: match.range)
        let trailing = CharacterSet(charactersIn: ").,;:!?]}\"'")
        while let last = candidate.unicodeScalars.last, trailing.contains(last) {
            candidate.removeLast()
        }
        return URL(string: candidate)
    }

    // MARK: - t.co

    private func expandShortLink(_ url: URL) async -> URL {
        guard url.host?.lowercased() == "t.co" else { return url }

        let capture = RedirectCapture()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 12
        configuration.timeoutIntervalForResource = 12
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never

        let session = URLSession(configuration: configuration, delegate: capture, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Shelf-iOS/1.0", forHTTPHeaderField: "User-Agent")
        _ = try? await session.data(for: request)

        return capture.finalURL ?? url
    }

    // MARK: - UI

    private func configureStatusView() {
        statusContainer.translatesAutoresizingMaskIntoConstraints = false
        statusContainer.backgroundColor = UIColor.secondarySystemBackground
        statusContainer.layer.cornerRadius = 16
        statusContainer.isHidden = true

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = UIFont.preferredFont(forTextStyle: .headline)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        view.addSubview(statusContainer)
        statusContainer.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            statusContainer.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusContainer.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusContainer.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
            statusLabel.leadingAnchor.constraint(equalTo: statusContainer.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: statusContainer.trailingAnchor, constant: -24),
            statusLabel.topAnchor.constraint(equalTo: statusContainer.topAnchor, constant: 18),
            statusLabel.bottomAnchor.constraint(equalTo: statusContainer.bottomAnchor, constant: -18),
        ])
    }

    private func showStatus(_ text: String) {
        statusLabel.text = text
        statusContainer.isHidden = false
    }

    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.finish()
        })
        present(alert, animated: true)
    }
}

/// Stops at the first redirect and remembers where it pointed.
private final class RedirectCapture: NSObject, URLSessionTaskDelegate {
    private let lock = NSLock()
    private var captured: URL?

    var finalURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return captured
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        lock.lock()
        if captured == nil {
            captured = request.url
        }
        lock.unlock()
        completionHandler(nil)
    }
}
