import SwiftUI

struct WorkspaceToolbar: ToolbarContent {
    @Bindable var store: CrewStore
    var body: some ToolbarContent {
        ToolbarItem(placement: .principal) { WorkspaceTabs(store: store) }
        ToolbarItemGroup(placement: .primaryAction) {
            Button("New Job", systemImage: "plus") { store.showingDispatch = true }
                .help("New job (⌘N)").disabled(!store.connected)
            Menu {
                Label(store.connected ? "Connected to Crew" : "Reconnecting…", systemImage: store.connected ? "network" : "wifi.slash")
                Divider()
                Button("Open Web Board", systemImage: "globe") { NSWorkspace.shared.open(store.api.baseURL) }
            } label: { Label("Workspace options", systemImage: "ellipsis") }
                .menuIndicator(.hidden).help("Workspace options")
        }
    }
}

/// The page tabs: the system segmented control, which draws the toolbar's glass selection,
/// its sliding motion and the press lens. SwiftUI's segmented Picker drops the symbols here.
struct WorkspaceTabs: NSViewRepresentable {
    @Bindable var store: CrewStore
    private static let pages = ["overview", "needs", "activity", "history"]
    private static let titles = ["Overview", "Needs You", "Activity", "History"]
    private static let symbols = ["square.grid.2x2", "bell", "bolt", "clock.arrow.circlepath"]
    private var current: String { store.project.isEmpty ? store.selection ?? "overview" : "overview" }

    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: Self.titles, trackingMode: .selectOne,
                                         target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        control.setAccessibilityLabel("Workspace")
        control.segmentDistribution = .fit
        return control
    }
    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        let coordinator = context.coordinator
        coordinator.store = store
        // Only touch the control when something it shows has changed. Setting images or the selection
        // again on every toolbar update restarts the system's sliding selection animation.
        let badged = store.state.pendingCount > 0
        if coordinator.badged != badged {
            coordinator.badged = badged
            for index in Self.pages.indices {
                control.setImage(image(index, badged: index == 1 && badged), forSegment: index)
            }
            control.invalidateIntrinsicContentSize()
        }
        let selected = Self.pages.firstIndex(of: current) ?? 0
        if control.selectedSegment != selected { control.selectedSegment = selected }
    }
    /// Waiting requests show as the bell's own orange badge, which keeps the segment's width fixed.
    private func image(_ index: Int, badged: Bool) -> NSImage? {
        // Unsized symbols follow the toolbar's large control size and outgrow the labels.
        let size = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
        guard badged else { return NSImage(systemSymbolName: Self.symbols[index], accessibilityDescription: nil)?.withSymbolConfiguration(size) }
        let config = size.applying(NSImage.SymbolConfiguration(paletteColors: [.systemOrange, .labelColor]))
        let image = NSImage(systemSymbolName: "bell.badge", accessibilityDescription: "Waiting requests")?.withSymbolConfiguration(config)
        image?.isTemplate = false
        return image
    }
    /// Without this the toolbar stretches the control into all free space, which pushes the
    /// trailing items into the overflow menu.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView control: NSSegmentedControl, context: Context) -> CGSize? {
        control.intrinsicContentSize
    }
    func makeCoordinator() -> Coordinator { Coordinator(store: store) }
    @MainActor final class Coordinator: NSObject {
        var badged: Bool?
        var store: CrewStore
        init(store: CrewStore) { self.store = store }
        @objc func changed(_ control: NSSegmentedControl) {
            store.selection = WorkspaceTabs.pages[control.selectedSegment]
        }
    }
}
