import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject private var model: AppModel

    @State private var mode: ShelfMode = .selfHosted
    @State private var serverURL = ""
    @State private var password = ""
    @State private var email = ""
    @State private var cloudPassword = ""
    @State private var cloudBase = ServerConfig.defaultCloudBaseURL
    @State private var showAdvanced = false

    private let accent = Color(red: 0.76, green: 0.29, blue: 0.13)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header

                Picker("Mode", selection: $mode) {
                    ForEach(ShelfMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: mode) { _, _ in
                    model.errorMessage = nil
                }

                VStack(alignment: .leading, spacing: 16) {
                    if mode == .selfHosted {
                        selfHostedFields
                    } else {
                        cloudFields
                    }

                    if let error = model.errorMessage {
                        errorBanner(error)
                    }

                    connectButton
                }
                .padding(20)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))

                Text(footnote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "books.vertical.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(accent)
            Text("Shelf")
                .font(.largeTitle.weight(.bold))
            Text("A private archive for the posts you want to keep.")
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 12)
    }

    private var selfHostedFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            fieldLabel("Worker URL")
            styledField {
                TextField("https://your-worker.workers.dev", text: $serverURL)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            fieldLabel("APP_PASSWORD")
            styledField {
                SecureField("Your Worker password", text: $password)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            Text("The address is trimmed, gets https:// when the scheme is missing, and trailing slashes are removed. http:// is accepted only for localhost.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var cloudFields: some View {
        VStack(alignment: .leading, spacing: 14) {
            fieldLabel("Email")
            styledField {
                TextField("you@example.com", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            fieldLabel("Password")
            styledField {
                SecureField("Cloud password", text: $cloudPassword)
                    .textContentType(.password)
            }

            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 10) {
                    fieldLabel("Cloud server")
                    styledField {
                        TextField(ServerConfig.defaultCloudBaseURL, text: $cloudBase)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Button("Use the default server") {
                        cloudBase = ServerConfig.defaultCloudBaseURL
                    }
                    .font(.footnote)
                }
                .padding(.top, 8)
            }
            .tint(accent)
        }
    }

    private var connectButton: some View {
        Button {
            connect()
        } label: {
            HStack(spacing: 8) {
                if model.isBusy {
                    ProgressView()
                        .tint(.white)
                }
                Text(model.isBusy ? "Connecting…" : "Connect")
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .tint(accent)
        .disabled(!canConnect || model.isBusy)
        .padding(.top, 4)
    }

    private var canConnect: Bool {
        switch mode {
        case .selfHosted:
            return !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !password.isEmpty
        case .cloud:
            return !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !cloudPassword.isEmpty
        }
    }

    private var footnote: String {
        switch mode {
        case .selfHosted:
            return "Shelf never ships with a personal server address or password. The password is kept in the iOS Keychain; the extension reads it through the shared App Group."
        case .cloud:
            return "Shelf Cloud stores a session token in the iOS Keychain and injects the returned cookie into the WebView."
        }
    }

    private func connect() {
        switch mode {
        case .selfHosted:
            Task { await model.connectSelfHosted(urlText: serverURL, password: password) }
        case .cloud:
            Task { await model.connectCloud(email: email, password: cloudPassword, baseText: cloudBase) }
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    private func styledField<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(14)
            .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}
