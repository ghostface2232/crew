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
            // A segmented picker in the toolbar renders titles only, so the tabs are drawn here to keep their symbols.
            HStack(spacing: 2) {
                tab("Overview", symbol: "square.grid.2x2", page: "overview")
                tab("Needs You", symbol: "bell", page: "needs", badge: store.state.pendingCount)
                tab("Activity", symbol: "list.bullet.rectangle", page: "activity")
                tab("History", symbol: "clock.arrow.circlepath", page: "history")
            }.padding(3).accessibilityElement(children: .contain).accessibilityLabel("Workspace")
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
                .menuIndicator(.hidden).help("Workspace options")
        }
        // The spacer gives search its own glass group so it grows on its own.
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) { ToolbarSearch(store: store) }
    }
    private func tab(_ title: String, symbol: String, page: String, badge: Int = 0) -> some View {
        let selected = (store.project.isEmpty ? store.selection ?? "overview" : "overview") == page
        return Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) { store.selection = page }
        } label: {
            Label(title, systemImage: symbol).labelStyle(.titleAndIcon)
                .foregroundStyle(selected ? .primary : .secondary)
                .font(.system(size: 12, weight: .medium))
                // An overlay keeps the tab width fixed when requests come and go.
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Circle().fill(.orange).frame(width: 6, height: 6).offset(x: 5, y: -2)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(selected ? Color.primary.opacity(0.08) : .clear, in: Capsule())
                .contentShape(Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityLabel(title).accessibilityValue(badge > 0 ? "\(badge) waiting" : "")
            .animation(reduceMotion ? nil : .spring(duration: 0.25), value: badge)
    }
}

struct WorkspacePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.68 : 1)
    }
}

// macOS has no minimized search toolbar behavior, so the field opens from a button on demand.
struct ToolbarSearch: View {
    @Bindable var store: CrewStore
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Group {
            if expanded {
                SearchField(text: $store.search, onEnd: { if store.search.isEmpty { close() } }, onCancel: close)
                    .frame(width: 200)
                    .transition(.opacity)
            } else {
                // The toolbar's own button style draws a single icon as a circle, like the other toolbar items.
                Button("Search work", systemImage: "magnifyingglass") { open() }
                    .labelStyle(.iconOnly).help("Search work (⌘F)")
            }
        }
        .onChange(of: store.searchRequest) { open() }
    }
    private func open() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { expanded = true }
    }
    private func close() {
        store.search = ""
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { expanded = false }
    }
}

// SwiftUI focus does not reach a field inside the toolbar, so the AppKit field takes focus itself when shown.
private struct SearchField: NSViewRepresentable {
    @Binding var text: String
    var onEnd: () -> Void
    var onCancel: () -> Void
    func makeNSView(context: Context) -> FocusingSearchField {
        let field = FocusingSearchField()
        field.placeholderString = "Search work"
        field.sendsSearchStringImmediately = true
        // The toolbar's glass capsule already frames the field.
        field.focusRingType = .none
        field.delegate = context.coordinator
        field.setAccessibilityLabel("Search work")
        return field
    }
    func updateNSView(_ field: FocusingSearchField, context: Context) {
        context.coordinator.parent = self
        if field.stringValue != text { field.stringValue = text }
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    final class Coordinator: NSObject, NSSearchFieldDelegate {
        var parent: SearchField
        init(parent: SearchField) { self.parent = parent }
        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField else { return }
            parent.text = field.stringValue
        }
        func controlTextDidEndEditing(_ notification: Notification) { parent.onEnd() }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            parent.onCancel()
            return true
        }
    }
    final class FocusingSearchField: NSSearchField {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(self) }
        }
    }
}
