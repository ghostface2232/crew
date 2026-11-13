import SwiftUI

struct WorkspaceToolbar: ToolbarContent {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Text("Crew").font(.system(size: 17, weight: .semibold, design: .rounded)).lineLimit(1)
        }.sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .principal) {
            Picker("Workspace", selection: Binding(get: {
                store.project.isEmpty ? store.selection ?? "overview" : "overview"
            }, set: { page in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { store.selection = page }
            })) {
                Text("Overview").tag("overview")
                Text(store.state.pendingCount > 0 ? "Needs You (\(store.state.pendingCount))" : "Needs You").tag("needs")
                Text("Activity").tag("activity")
                Text("History").tag("history")
            }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 440)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button("New Job", systemImage: "plus") { store.showingDispatch = true }
                .help("New job (⌘N)").disabled(!store.connected)
            Menu {
                Label(store.connected ? "Connected to Crew" : "Reconnecting…", systemImage: store.connected ? "network" : "wifi.slash")
                Divider()
                Button("Settings…", systemImage: "gearshape", action: openSettings).disabled(store.state.roles.isEmpty)
                Button("Open Web Board", systemImage: "globe") { NSWorkspace.shared.open(store.api.baseURL) }
            } label: { Label("Workspace options", systemImage: "ellipsis") }
                .help("Workspace options")
        }
    }
}

struct WorkspacePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.68 : 1)
    }
}
