import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var confirmDisconnect = false

    var body: some View {
        NavigationStack {
            Form {
                if let config = model.config {
                    Section("Server") {
                        LabeledContent("Mode", value: config.mode.title)
                        LabeledContent("Address", value: config.baseURL)
                        if !config.email.isEmpty {
                            LabeledContent("Account", value: config.email)
                        }
                        if config.mode == .cloud && !config.displayName.isEmpty {
                            LabeledContent("Library", value: config.displayName)
                        }
                    }

                    Section {
                        Button("Change server") {
                            confirmDisconnect = true
                        }
                        Button("Sign out", role: .destructive) {
                            confirmDisconnect = true
                        }
                    } footer: {
                        Text("Changing the server or signing out clears the saved password, cloud token, and browser cookies.")
                    }
                } else {
                    Section {
                        Text("No server is configured.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "Shelf")
                    LabeledContent("Version", value: version)
                    LabeledContent("Bundle", value: Bundle.main.bundleIdentifier ?? "—")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Disconnect from this server?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) {
                    Task {
                        await model.signOut()
                        dismiss()
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The password or token and the browser session will be removed. You can connect to another server next.")
            }
        }
    }

    private var version: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(short) (\(build))"
    }
}
