import SwiftUI

struct WorkspaceToolbar: ToolbarContent {
    @Bindable var store: CrewStore
    var layout: ToolbarLayout
    private var compact: Bool { layout.compact }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some ToolbarContent {
        // A separate item per mode: the toolbar keeps an item's slot at the widest size it has seen,
        // so icon-only tabs in the same item would still hold the titled width and leave no room.
        ToolbarItem(id: compact ? "tabs.icons" : "tabs.titled", placement: .principal) {
            WorkspaceTabs(store: store, compact: compact)
            .background(WindowFrameReader(trigger: layout.trigger) { frame, window in
                if layout.tabsCenter != frame.midX { layout.tabsCenter = frame.midX }
                if compact {
                    if layout.compactTabsWidth != frame.width { layout.compactTabsWidth = frame.width }
                } else if layout.titledTabsWidth != frame.width { layout.titledTabsWidth = frame.width }
                let leading = ToolbarLayout.leadingChromeEnd(in: window)
                if layout.leadingLimit != leading { layout.leadingLimit = leading }
            })
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button("New Job", systemImage: "plus") { store.showingDispatch = true }
                .help("New job (⌘N)").disabled(!store.connected)
                .background(WindowFrameReader(trigger: layout.trigger) { frame, _ in if layout.actionsX != frame.minX { layout.actionsX = frame.minX } })
            Menu {
                Label(store.connected ? "Connected to Crew" : "Reconnecting…", systemImage: store.connected ? "network" : "wifi.slash")
                Divider()
                Button("Open Web Board", systemImage: "globe") { NSWorkspace.shared.open(store.api.baseURL) }
            } label: { Label("Workspace options", systemImage: "ellipsis") }
                .menuIndicator(.hidden).help("Workspace options")
        }
        // The spacer gives search its own glass group so it grows on its own.
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) { ToolbarSearch(store: store, layout: layout) }
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
    var layout: ToolbarLayout
    @State private var expanded = false
    /// Driven frame by frame: the toolbar sizes its items itself and does not animate a SwiftUI
    /// size change, so stepping the width lets the glass, the field and the neighboring items move together.
    @State private var width = ToolbarLayout.searchCollapsed
    @State private var stepper: Task<Void, Never>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            if expanded {
                SearchField(text: $store.search, onCollapse: collapse, onCancel: cancel)
                    .transition(.opacity)
            } else {
                // The toolbar's own button style draws a single icon as a circle, like the other toolbar items.
                // A tinted icon tells that a search still filters the board while the field is closed.
                Button("Search work", systemImage: "magnifyingglass") { open() }
                    .labelStyle(.iconOnly).foregroundStyle(store.search.isEmpty ? Color.primary : Color.accentColor)
                    .help(store.search.isEmpty ? "Search work (⌘F)" : "Searching “\(store.search)” (⌘F)")
                    .transition(.opacity)
            }
        }
        .frame(width: width)
        .background(WindowFrameReader(trigger: layout.trigger) { frame, _ in
            if layout.searchFrame != frame { layout.searchFrame = frame }
        })
        .onChange(of: store.searchRequest) { open() }
        // Keep the open field fitted as the window, the sidebar or the tab mode change.
        .onChange(of: layout.searchFit) { refit() }
    }
    private func open() {
        let wasCompact = layout.compact
        layout.searchOpen = true
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { expanded = true }
        // When the tabs have to drop their titles first, let the toolbar take in their narrower width
        // before the field grows; growing into the titled tabs makes the toolbar move search to overflow.
        resize(to: layout.searchFit, after: !wasCompact && layout.compact ? 0.15 : 0)
    }
    /// Clicking elsewhere closes the field but keeps the filter, so opening a matching job does not lose it.
    private func collapse() {
        layout.searchOpen = false
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { expanded = false }
        resize(to: ToolbarLayout.searchCollapsed)
    }
    /// Escape clears the search as well.
    private func cancel() {
        store.search = ""
        collapse()
    }
    /// Follows the window at once: animating here restarts on every live-resize measurement,
    /// which makes the field lag behind the window in steps. Opening and closing still animate.
    private func refit() {
        guard expanded, stepper == nil else { return }
        let target = layout.searchFit
        guard abs(target - width) > 0.5 else { return }
        width = target
        layout.searchWidth = target
    }
    private func resize(to target: CGFloat, after delay: Double = 0) {
        stepper?.cancel()
        guard !reduceMotion else { width = target; layout.searchWidth = target; stepper = nil; return }
        stepper = Task { @MainActor in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            let start = width, duration = 0.3, begin = Date()
            while !Task.isCancelled {
                let progress = min(1, Date().timeIntervalSince(begin) / duration)
                let eased = 1 - pow(1 - progress, 3) // ease-out, close to the system's own toolbar motion
                width = start + (target - start) * eased
                if progress >= 1 { layout.searchWidth = target; stepper = nil; break }
                try? await Task.sleep(for: .milliseconds(8))
            }
            // A change that arrived while animating is applied once the field has settled.
            if !Task.isCancelled { refit() }
        }
    }
}

// SwiftUI focus does not reach a field inside the toolbar, so the AppKit field takes focus itself when shown.
private struct SearchField: NSViewRepresentable {
    @Binding var text: String
    var onCollapse: () -> Void
    var onCancel: () -> Void
    func makeNSView(context: Context) -> FocusingSearchField {
        let field = FocusingSearchField()
        field.placeholderString = "Search work"
        field.sendsSearchStringImmediately = true
        // The toolbar's glass capsule already frames the field.
        field.focusRingType = .none
        field.delegate = context.coordinator
        field.setAccessibilityLabel("Search work")
        field.stringValue = text
        field.onOutsideClick = { context.coordinator.parent.onCollapse() }
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
        func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            parent.onCancel()
            return true
        }
    }
    final class FocusingSearchField: NSSearchField {
        var onOutsideClick: (() -> Void)?
        private var monitor: Any?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.window?.makeFirstResponder(self) }
            // Clicks on cards and empty areas do not take focus, so a click anywhere else in the window
            // closes the field directly. The click still goes through to whatever was hit.
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                if let self, event.window === self.window,
                   !self.convert(self.bounds, to: nil).contains(event.locationInWindow) {
                    DispatchQueue.main.async { self.onOutsideClick?() }
                }
                return event
            }
        }
    }
}


/// Window-space geometry of the toolbar, which SwiftUI hosts outside the window content's coordinate space.
@MainActor @Observable
final class ToolbarLayout {
    static let gap: CGFloat = 12
    static let searchCollapsed: CGFloat = 36
    static let searchExpanded: CGFloat = 200

    var detailFrame: CGRect = .zero
    /// The window buttons' right edge; with the sidebar closed the toggle follows them.
    var leadingLimit: CGFloat = 0
    var tabsCenter: CGFloat = 0
    var titledTabsWidth: CGFloat = 0
    var compactTabsWidth: CGFloat = 0
    var actionsX: CGFloat = .greatestFiniteMagnitude
    /// The search item's frame. Its trailing edge and its distance to the actions do not change with its width.
    var searchFrame: CGRect = .zero
    /// The search item's settled width; a change moves the actions, so the readers measure again.
    var searchWidth: CGFloat = 0
    var searchOpen = false
    /// Changes whenever the toolbar may have moved, so the readers measure again.
    var trigger: CGRect { CGRect(x: detailFrame.minX, y: searchWidth, width: detailFrame.width, height: detailFrame.height) }

    /// Where the actions would start if the search item were `width` wide. The search item's trailing
    /// edge and the actions' distance to it are fixed, so this does not depend on when it was measured.
    private func actionsStart(searchWidth width: CGFloat) -> CGFloat? {
        guard searchFrame.width > 0, actionsX < .greatestFiniteMagnitude else { return nil }
        let actionsSpan = searchFrame.minX - actionsX
        return searchFrame.maxX - width - actionsSpan
    }

    /// Titled tabs are kept while they clear the window controls and the actions, with the search field
    /// at the width it wants: collapsed, or fully open while searching. Decided from scratch each time,
    /// so widening the window brings the titles back.
    var compact: Bool {
        guard titledTabsWidth > 0,
              let actions = actionsStart(searchWidth: searchOpen ? Self.searchExpanded : Self.searchCollapsed) else { return false }
        let half = titledTabsWidth / 2
        // With the sidebar closed the toggle follows the window buttons: one 36 pt toolbar button and its spacing.
        let leading = detailFrame.minX > 0 ? detailFrame.minX : leadingLimit + 8 + 36
        return tabsCenter - half < leading + Self.gap || tabsCenter + half > actions - Self.gap
    }

    /// The width the open search field can take beside the tabs in their current mode.
    var searchFit: CGFloat {
        // Icon tabs have not been measured the first time they are needed; four icon segments are about 150 pt.
        let tabsWidth = compact ? (compactTabsWidth > 0 ? compactTabsWidth : 150) : titledTabsWidth
        guard tabsWidth > 0, let actions = actionsStart(searchWidth: 0) else { return Self.searchExpanded }
        let room = actions - (tabsCenter + tabsWidth / 2) - Self.gap
        return max(Self.searchCollapsed, min(Self.searchExpanded, room))
    }

    static func leadingChromeEnd(in window: NSWindow) -> CGFloat {
        window.standardWindowButton(.zoomButton).map { $0.convert($0.bounds, to: nil).maxX } ?? 0
    }
}

/// Reports a view's frame in window coordinates whenever `trigger` changes.
struct WindowFrameReader: NSViewRepresentable {
    var trigger: CGRect
    var report: (CGRect, NSWindow) -> Void
    func makeNSView(context: Context) -> ReaderView { ReaderView() }
    func updateNSView(_ view: ReaderView, context: Context) {
        view.report = report
        view.measureSoon()
    }

    /// Also measures when the window resizes: SwiftUI's own geometry updates do not reach the toolbar
    /// during a live resize, which left the readers with the previous window's positions.
    final class ReaderView: NSView {
        var report: ((CGRect, NSWindow) -> Void)?
        private var observers: [NSObjectProtocol] = []
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            guard let window else { return }
            for name in [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.measureSoon() }
                })
            }
            measureSoon()
        }
        /// After this layout pass, and again once a sidebar or window animation settles.
        func measureSoon() {
            for delay in [0, 0.35] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self, let window = self.window else { return }
                    self.report?(self.convert(self.bounds, to: nil), window)
                }
            }
        }
    }
}

/// The page tabs: the system segmented control, which draws the toolbar's glass selection,
/// its sliding motion and the press lens. SwiftUI's segmented Picker drops the symbols here.
struct WorkspaceTabs: NSViewRepresentable {
    @Bindable var store: CrewStore
    var compact: Bool
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
        // Only touch the control when something it shows has changed. Setting labels, images or the
        // selection again on every toolbar update restarts the system's sliding selection animation.
        let style = Coordinator.Style(compact: compact, badged: store.state.pendingCount > 0)
        if coordinator.style != style {
            coordinator.style = style
            for index in Self.pages.indices {
                control.setLabel(compact ? "" : Self.titles[index], forSegment: index)
                control.setToolTip(compact ? Self.titles[index] : nil, forSegment: index)
                control.setImage(image(index, badged: index == 1 && style.badged), forSegment: index)
                control.setWidth(0, forSegment: index)
            }
            control.invalidateIntrinsicContentSize()
        }
        let selected = Self.pages.firstIndex(of: current) ?? 0
        if control.selectedSegment != selected { control.selectedSegment = selected }
    }
    /// Waiting requests show as the bell's own orange badge, which keeps the segment's width fixed.
    private func image(_ index: Int, badged: Bool) -> NSImage? {
        // A little smaller than the 13 pt labels; unsized symbols follow the toolbar's large control size.
        let size = NSImage.SymbolConfiguration(pointSize: 10, weight: .medium)
        guard badged else { return NSImage(systemSymbolName: Self.symbols[index], accessibilityDescription: nil)?.withSymbolConfiguration(size) }
        let config = size.applying(NSImage.SymbolConfiguration(paletteColors: [.systemOrange, .labelColor]))
        let image = NSImage(systemSymbolName: "bell.badge", accessibilityDescription: "Waiting requests")?.withSymbolConfiguration(config)
        image?.isTemplate = false
        return image
    }
    /// Without this the toolbar stretches the control into all free space, which pushes the
    /// trailing items into the overflow menu even when only icons are shown.
    func sizeThatFits(_ proposal: ProposedViewSize, nsView control: NSSegmentedControl, context: Context) -> CGSize? {
        control.intrinsicContentSize
    }
    func makeCoordinator() -> Coordinator { Coordinator(store: store) }
    @MainActor final class Coordinator: NSObject {
        struct Style: Equatable { var compact: Bool; var badged: Bool }
        var style: Style?
        var store: CrewStore
        init(store: CrewStore) { self.store = store }
        @objc func changed(_ control: NSSegmentedControl) {
            let page = WorkspaceTabs.pages[control.selectedSegment]
            store.selection = page
        }
    }
}
