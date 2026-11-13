import SwiftUI

@main
struct ShelfApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
        }
    }
}

private struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView()
            case .onboarding:
                OnboardingView()
            case .library:
                LibraryView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: model.phase)
    }
}
