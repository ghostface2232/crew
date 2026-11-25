import SwiftUI
import AppKit
import UserNotifications

@main @MainActor
enum CrewEntry {
    static let updateStartup = AppUpdater.startupDirectory(arguments: CommandLine.arguments)
    private(set) static var bundleUse: FileHandle?

    static func main() {
        do {
            let home = CrewHome.directory()
            let launch = try BundleLaunchLock(installed: Bundle.main.bundleURL)
            guard let running = try launch.admit(home: home, work: updateStartup) else { return }
            if let work = updateStartup { try AppUpdater.recordStartup(in: work) }
            bundleUse = running
        } catch {
            if updateStartup == nil {
                _ = NSApplication.shared
                let alert = NSAlert()
                alert.messageText = error.localizedDescription
                alert.runModal()
            }
            return
        }
        CrewApp.main()
    }
}

struct CrewApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("Crew", id: "main") {
            BoardView(store: delegate.store, openSettings: delegate.openSettings)
            // Small bordered buttons read as pills across the app; sheets inherit this.
            .buttonBorderShape(.capsule)
            .environment(delegate.updater)
            .background(WindowAccessor { delegate.configure($0) })
        }
        .defaultSize(WorkspaceStyle.windowDefaultSize)
        .commands {
            // View > Show/Hide Sidebar (⌃⌘S), the standard way to toggle it from the keyboard.
            SidebarCommands()
            CommandGroup(replacing: .newItem) {
                Button("New Job…") { delegate.show(); delegate.store.showingDispatch = true }
                    .keyboardShortcut("n").disabled(!delegate.store.connected)
            }
            CommandGroup(replacing: .appSettings) {
                SettingsCommand(store: delegate.store, open: delegate.openSettings).keyboardShortcut(",")
            }
            CommandGroup(after: .textEditing) {
                Button("Search Work") { delegate.show(); delegate.store.searchRequest += 1 }.keyboardShortcut("f")
            }
            CommandGroup(replacing: .help) {
                Button("Welcome to Crew") { delegate.show(); delegate.store.showingWelcome = true }
            }
            CommandMenu("Workspace") {
                Button("Overview") { delegate.show(); delegate.store.selection = "overview" }.keyboardShortcut("1")
                Button("Needs You") { delegate.show(); delegate.store.selection = "needs" }.keyboardShortcut("2")
                Button("Activity") { delegate.show(); delegate.store.selection = "activity" }.keyboardShortcut("3")
                Button("History") { delegate.show(); delegate.store.selection = "history" }.keyboardShortcut("4")
                Divider()
                Button("Open Web Board") { Task { NSWorkspace.shared.open(await delegate.store.api.webBoardURL()) } }
            }
        }
        // The menu bar reads live state in its own views so the App body is not re-evaluated on every update.
        MenuBarExtra {
            MenuBarMenu(store: delegate.store, show: { delegate.show(job: $0) }, openSettings: delegate.openSettings)
                .environment(delegate.updater)
        } label: {
            MenuBarLabel(store: delegate.store) { delegate.openMainWindow = $0 }
        }
    }
}

private struct MenuBarMenu: View {
    let store: CrewStore
    let show: (String?) -> Void
    let openSettings: () -> Void
    @Environment(AppUpdater.self) private var updater
    var body: some View {
        let waiting = store.state.waitingJobs
        let pending = store.state.pendingCount
        Text(store.connected ? String(localized: "Crew is connected") : String(localized: "Crew is reconnecting"))
        Button("Open Crew") { show(nil) }
        if pending > 0 {
            Button(pending == 1 ? String(localized: "1 request needs you") : String(localized: "\(pending) requests need you")) { show(nil); store.selection = "needs" }
        }
        Divider()
        ForEach(Array(waiting.prefix(5))) { job in
            Button("\(agentName(job.agent)): \(job.title)") { show(job.id) }
        }
        Divider()
        SettingsCommand(store: store, open: openSettings)
        Button("Open Web Board") { Task { NSWorkspace.shared.open(await store.api.webBoardURL()) } }
        if updater.phase == .ready {
            Button("Update to \(updater.latest ?? "")") { updater.onInstall() }
        }
        Divider()
        Button("Quit Crew — jobs keep running") { NSApp.terminate(nil) }
    }
}

private struct MenuBarLabel: View {
    let store: CrewStore
    /// Hands the app delegate a way to open the main window; the status item exists from launch.
    let register: (OpenWindowAction) -> Void
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        let pending = store.pendingCount
        Group {
            if let mark = Self.mark {
                // Waiting requests show as a count beside the mark, which has no filled variant to switch to.
                HStack(spacing: Space.xs) {
                    Image(nsImage: mark)
                    if pending > 0 { Text(String(pending)).monospacedDigit() }
                }
            } else {
                Label("Crew", systemImage: pending > 0 ? "circle.dotted.circle.fill" : "circle.dotted.circle")
            }
        }
        .accessibilityLabel(pending > 0 ? String(localized: "Crew, \(pending) waiting") : "Crew")
        .onAppear { register(openWindow) }
    }
    /// The Crew mark at menu bar size. A menu bar label ignores SwiftUI's frame, so the image itself is sized.
    /// Nil when the app runs outside its bundle, which has no asset catalog.
    private static let mark: NSImage? = {
        guard let source = NSImage(named: "MenuBarCrew")?.copy() as? NSImage, source.size.height > 0 else { return nil }
        let height: CGFloat = 16
        source.size = NSSize(width: (source.size.width / source.size.height * height).rounded(), height: height)
        source.isTemplate = true
        return source
    }()
}

private struct SettingsCommand: View {
    let store: CrewStore
    let open: () -> Void
    var body: some View {
        Button("Settings…", action: open).disabled(store.state.roles.isEmpty)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
    let store: CrewStore
    let updater = AppUpdater()
    private var updateTask: Task<Void, Never>?
    private var updateStartup = CrewEntry.updateStartup
    private var didFinishLaunching = false
    private weak var mainWindow: NSWindow?
    /// Opens the main window scene when it does not exist: SwiftUI sometimes launches without
    /// presenting it, which leaves only the menu bar item.
    var openMainWindow: OpenWindowAction?
    private var settingsWindow: NSWindow?
    private var settings: SettingsModel?
    private var noticed = Set<String>()
    private var delivered = Set<String>()
    private var quitting = false
    private var instanceLock: InstanceLock?
    private var completions = CompletionTracker()
    private var hiddenToolbarBackgrounds: [NSView] = []

    override init() {
        let home = ProcessInfo.processInfo.environment["CREW_HOME"]
        let defaults: UserDefaults
        if let home {
            defaults = UserDefaults(suiteName: "dev.crew.native.\(InstanceLock.profileID(home: URL(fileURLWithPath: home)))")!
            // Keep the saved selection from the first native build's profile name.
            if defaults.string(forKey: "selection") == nil,
               let old = UserDefaults(suiteName: "dev.crew.native.\(Data(home.utf8).base64EncodedString())")?.string(forKey: "selection") {
                defaults.set(old, forKey: "selection")
            }
        } else { defaults = .standard }
        store = CrewStore(defaults: defaults)
        // AppKit's password AutoFill check walks the key view loop when a field takes focus, and in full screen
        // that walk never ends inside the toolbar's separate window, which froze the app on search. Crew has no
        // credential fields, so the check is turned off.
        UserDefaults.standard.register(defaults: ["NSAutoFillHeuristicsEnabled": false])
        // macOS 27 draws the scroll edge effect as a filled band under the toolbar. This AppKit switch restores
        // the fading blur, so the toolbar does not read as a region of its own. A user's own setting still wins.
        UserDefaults.standard.register(defaults: ["MPV8": false])
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let home = CrewHome.directory()
        let lock = InstanceLock(home: home)
        do {
            // The instance lock creates the home on a first install.
            if !FileManager.default.fileExists(atPath: home.path) { store.defaults.set(true, forKey: CrewStore.welcomePending) }
            guard try lock.acquire(home: home) else {
                DistributedNotificationCenter.default().postNotificationName(lock.notificationName, object: nil, userInfo: nil, deliverImmediately: true)
                NSApp.terminate(nil)
                return
            }
            instanceLock = lock
            DistributedNotificationCenter.default().addObserver(self, selector: #selector(reopenWindow), name: lock.notificationName, object: nil)
        } catch {
            let alert = NSAlert(); alert.messageText = error.localizedDescription; alert.runModal()
            NSApp.terminate(nil)
            return
        }
        // A click outside the field being edited ends the editing. AppKit otherwise keeps the cursor in a text
        // view until another one takes it, so a message box stayed active after clicking anywhere else.
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            MainActor.assumeIsolated {
                // Hit-tested from the frame view, which holds the toolbar too; its point is in window coordinates.
                if let window = event.window, let editor = window.firstResponder as? NSTextView,
                   let frame = window.contentView?.superview, let hit = frame.hitTest(event.locationInWindow) {
                    // The editor's own scroll bars and any text field, the search field among them, keep editing.
                    let keeps = sequence(first: hit, next: \.superview).contains { view in
                        view is NSText || view is NSTextField || view === editor.enclosingScrollView
                    }
                    if !keeps { window.makeFirstResponder(nil) }
                }
            }
            return event
        }
        // SwiftUI's toolbar search has no width setting and sizes its field past the system item's preferred width.
        // A ceiling rather than a fixed width, so the toolbar can still fold the field when room runs out.
        NotificationCenter.default.addObserver(forName: NSToolbar.willAddItemNotification, object: nil, queue: .main) { note in
            guard let item = note.userInfo?["item"] as? NSSearchToolbarItem else { return }
            MainActor.assumeIsolated { item.searchField.widthAnchor.constraint(lessThanOrEqualToConstant: 180).isActive = true }
        }
        store.onStateChange = { [weak self] in self?.updateNotifications() }
        updater.onInstall = { [weak self] in self?.installUpdate() }
        if updateStartup == nil {
            store.start()
            watchUpdates()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.mainWindow == nil else { return }
            self.openMainWindow?(id: "main")
        }
        if ProcessInfo.processInfo.environment["CREW_TEST_MODE"] != "1" {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.setNotificationCategories([UNNotificationCategory(identifier: "approval", actions: [
                UNNotificationAction(identifier: "approve", title: String(localized: "Approve")),
                UNNotificationAction(identifier: "deny", title: String(localized: "Deny"), options: [.destructive]),
            ], intentIdentifiers: [])])
            Task {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                let settings = await center.notificationSettings()
                store.notificationsAllowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                if store.notificationsAllowed && updateStartup == nil {
                    await store.sendHeartbeat()
                    updateNotifications()
                }
            }
        }
        didFinishLaunching = true
        startAfterUpdateIfReady()
    }
    private func startAfterUpdateIfReady() {
        guard didFinishLaunching, mainWindow != nil, let work = updateStartup else { return }
        updateStartup = nil
        // The replacement must not start a bundled daemon before the helper can keep this app.
        guard AppUpdater.markStartupReady(in: work) else { NSApp.terminate(nil); return }
        store.start()
        watchUpdates()
    }
    func configure(_ window: NSWindow) {
        guard mainWindow !== window else { return }
        mainWindow = window
        window.delegate = self
        window.title = "Crew"
        window.isReleasedWhenClosed = false
        let frameName = "CrewMain\(ProcessInfo.processInfo.environment["CREW_HOME"] ?? "")"
        window.setFrameAutosaveName(frameName)
        window.setFrameUsingName(frameName)
        if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) { window.center() }
        startAfterUpdateIfReady()
    }
    func show() { show(job: nil) }
    @objc private func reopenWindow() { show() }
    func show(job: String?) {
        if mainWindow == nil { openMainWindow?(id: "main") }
        store.windowVisible = true
        if let job { store.openJob(job, navigate: true) }
        mainWindow?.deminiaturize(nil)
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func openSettings() {
        if let window = settingsWindow { window.deminiaturize(nil); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        guard !store.state.roles.isEmpty else { show(); return }
        let model = SettingsModel(api: store.api, roles: store.state.roles, roleSettings: store.state.roleSettings, roleInfo: store.state.roleInfo, preset: store.state.preset, presets: store.state.presets)
        let controller = NSHostingController(rootView: CrewSettingsView(model: model, store: store).buttonBorderShape(.capsule).environment(updater))
        // Laid out like System Settings: the sidebar runs up under the window controls, and a unified toolbar shows
        // the page's title. A real toolbar is what gives the page the system's soft scroll edge.
        controller.sceneBridgingOptions = [.toolbars]
        let window = NSWindow(contentViewController: controller)
        window.title = String(localized: "Settings")
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        let toolbar = NSToolbar(identifier: "CrewSettings")
        // The default display mode reserves a label row, which makes the toolbar taller than System Settings'.
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.setContentSize(WorkspaceStyle.settingsSize)
        window.minSize = WorkspaceStyle.settingsMinSize
        window.isReleasedWhenClosed = false
        window.delegate = self
        settings = model; settingsWindow = window
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { Self.pinSidebar(in: window) }
    }
    /// SwiftUI has no way to stop a split view's divider: without this the sidebar could be resized, and dragged
    /// shut with no toggle to bring it back. Pinned in the split view SwiftUI built, as System Settings' is.
    private static func pinSidebar(in window: NSWindow) {
        func split(in view: NSView) -> NSSplitView? { view as? NSSplitView ?? view.subviews.lazy.compactMap(split).first }
        guard let view = window.contentView.flatMap(split), let controller = view.delegate as? NSSplitViewController,
              let sidebar = controller.splitViewItems.first else { NSLog("Crew: settings sidebar not pinned; no split view controller found"); return }
        for item in controller.splitViewItems { item.canCollapse = false }
        sidebar.minimumThickness = CrewSettingsView.sidebarWidth
        sidebar.maximumThickness = CrewSettingsView.sidebarWidth
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === settingsWindow {
            guard leaveSettings(then: { [weak self] in self?.dismissSettings() }) else { return false }
            settingsWindow = nil; settings = nil
            return true
        }
        // Settings leave with the window, so closing it leaves nothing of the app on screen.
        if !quitting {
            guard leaveSettings(then: { [weak self] in self?.dismissSettings(); self?.hideMain(sender) }) else { return false }
            dismissSettings()
            hideMain(sender)
            return false
        }
        return true
    }
    private func hideMain(_ window: NSWindow) { store.windowVisible = false; window.orderOut(nil) }
    /// Closes the settings window without asking again; whoever calls it has already settled any unsaved changes.
    private func dismissSettings() {
        guard let window = settingsWindow else { return }
        settingsWindow = nil; settings = nil
        window.close()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowDidEnterFullScreen(_ notification: Notification) {
        guard let window = mainWindow, notification.object as? NSWindow === window else { return }
        store.fullScreenToolbarHeight = window.frame.height - window.contentLayoutRect.height
        // The full-screen toolbar window draws an opaque bar because its scroll edge effect cannot reach the
        // content; hiding it lets the content show through under BoardView's own fade.
        for toolbarWindow in NSApp.windows where String(describing: type(of: toolbarWindow)) == "NSToolbarFullScreenWindow" {
            func hideBackground(in view: NSView) {
                if String(describing: type(of: view)) == "NSTitlebarBackgroundView" {
                    view.isHidden = true
                    hiddenToolbarBackgrounds.append(view)
                    return
                }
                view.subviews.forEach(hideBackground)
            }
            toolbarWindow.contentView?.superview.map(hideBackground)
        }
    }
    func windowWillExitFullScreen(_ notification: Notification) {
        guard notification.object as? NSWindow === mainWindow else { return }
        // The titlebar moves back into the window, where its scroll edge effect works again.
        hiddenToolbarBackgrounds.forEach { $0.isHidden = false }
        hiddenToolbarBackgrounds = []
    }
    func windowDidExitFullScreen(_ notification: Notification) {
        if notification.object as? NSWindow === mainWindow { store.fullScreenToolbarHeight = 0 }
    }
    func windowDidMiniaturize(_ notification: Notification) { if notification.object as? NSWindow === mainWindow { store.windowVisible = false } }
    func windowDidDeminiaturize(_ notification: Notification) { if notification.object as? NSWindow === mainWindow { store.windowVisible = true } }
    func applicationDidHide(_ notification: Notification) { store.windowVisible = false }
    func applicationDidUnhide(_ notification: Notification) { store.windowVisible = mainWindow?.isVisible == true }
    func applicationDidBecomeActive(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["CREW_TEST_MODE"] != "1" else { return }
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            store.notificationsAllowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        }
    }
    /// Checks a minute after launch and then every six hours; a found release downloads only once the user has been away
    /// from Crew for two minutes: the app in the background, or the Mac idle.
    private func watchUpdates() {
        updateTask = Task {
            await updater.load()
            var nextCheck = Date().addingTimeInterval(60)
            var lastUsed = Date()
            while !Task.isCancelled {
                let now = Date()
                if now >= nextCheck {
                    await updater.check()
                    nextCheck = now.addingTimeInterval(6 * 3600)
                }
                let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
                if NSApp.isActive && idle < 120 { lastUsed = now }
                // One that failed waits for the next check, rather than downloading again every few seconds.
                if now.timeIntervalSince(lastUsed) >= 120 && updater.error == nil { await updater.download() }
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }
    private struct DaemonHealth: Decodable, Sendable { var pid: Int32; var active: Int? }
    private struct DaemonRecord: Decodable { var pid: Int32; var root: String? }
    private static func alive(_ pid: Int32) -> Bool { pid > 0 && (kill(pid, 0) == 0 || errno == EPERM) }
    /// The daemon running from this bundle's bridge, found by the record it keeps in the Crew home and its process, since
    /// a health request can time out on a busy daemon. `active` is nil when its health did not answer.
    private func ownDaemon() async -> (pid: Int32, active: Int?)? {
        let file = CrewHome.directory().appendingPathComponent("daemon.json")
        guard let data = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(DaemonRecord.self, from: data),
              Self.alive(record.pid), let root = record.root, let resources = Bundle.main.resourceURL else { return nil }
        let bundled = resources.appending(path: "bridge/plugin").resolvingSymlinksInPath().standardizedFileURL.path
        guard URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL.path == bundled else { return nil }
        let health: DaemonHealth? = try? await store.api.request("/api/health", timeout: 2)
        return (record.pid, health?.pid == record.pid ? (health?.active ?? 0) : nil)
    }
    /// Counts each install the user starts, so a cancelled one that is still sleeping does not carry on beside a new one.
    private var installAttempt = 0
    /// The swap helper waiting for this app to quit, and the bundle it would move in; a quit that is cancelled undoes it.
    private var handOver: (helper: Int32, staged: URL, work: URL)?
    /// Installs the staged update without losing work, as the Windows app does. The daemon this app started runs from
    /// the bundle being replaced, so it has to stop first, but it is only ever asked to stop while idle: it refuses while
    /// a job runs or a change is being saved, and otherwise saves jobs and missions before it exits. Until then the
    /// install waits, and the user can call it off. Jobs, missions and settings live in the Crew home, outside the bundle.
    func installUpdate() {
        guard updater.phase == .ready else { return }
        installAttempt += 1
        let attempt = installAttempt
        Task { await performUpdate(attempt) }
    }
    private func performUpdate(_ attempt: Int) async {
        let installed = Bundle.main.bundleURL
        if let reason = AppUpdater.canReplace(installed: installed) {
            if attempt == installAttempt, updater.installing() { updater.failed(reason) }
            return
        }
        let first = await ownDaemon()
        if let active = first?.active, active > 0 {
            let alert = NSAlert()
            alert.messageText = active == 1 ? String(localized: "1 job is still running.") : String(localized: "\(active) jobs are still running.")
            alert.informativeText = String(localized: "Crew will install the update as soon as they finish. Nothing is stopped, and jobs, missions and settings are kept.")
            alert.addButton(withTitle: String(localized: "Update When Finished"))
            alert.addButton(withTitle: String(localized: "Cancel"))
            guard alert.runModal() == .alertFirstButtonReturn, attempt == installAttempt else { return }
        }
        // A second click while the daemon was asked supersedes this one; only the latest attempt takes the install.
        guard attempt == installAttempt, updater.installing(waiting: first?.active ?? 0) else { return }
        // Read afresh each time: the user can cancel while the install waits.
        let current = { attempt == self.installAttempt && !self.quitting && self.updater.phase == .installing }
        // Once the store is paused, anything that calls the install off must start it again; it starts the daemon too.
        var paused = false
        let abandon = { if paused && !self.quitting { self.store.start() } }
        var refusals = 0
        var unanswered = 0
        while true {
            guard current() else { return abandon() }
            let found = await ownDaemon()
            // The user may have called it off while that was asked.
            guard current() else { return abandon() }
            guard let daemon = found else { break }
            if daemon.active == 0 {
                // From here the install can no longer be called off. Settings with unsaved edits would hold up the quit
                // after the daemon has stopped, so they are settled first; saving them means trying the update again.
                updater.stoppingDaemon()
                guard leaveSettings(then: { [weak self] in self?.dismissSettings() }) else {
                    updater.failed()
                    return abandon()
                }
                dismissSettings()
                // The store's reconnect loop would start the daemon again as soon as it stopped.
                store.stop()
                paused = true
                do {
                    let _: EmptyReply = try await store.api.post("/api/shutdown", ["ifIdle": true], timeout: 10)
                    // It saves jobs and missions, then exits; the process going is what counts, not a quiet health check.
                    var waited = 0.0
                    while Self.alive(daemon.pid) {
                        guard waited < 30 else { throw CrewFailure(String(localized: "The Crew daemon (process \(Int(daemon.pid))) did not stop.")) }
                        try? await Task.sleep(for: .milliseconds(200))
                        waited += 0.2
                    }
                    // Checked again before going on, in case another daemon from this bundle has started meanwhile.
                    continue
                } catch {
                    if !Self.alive(daemon.pid) { continue }
                    // Refused because work started meanwhile, or slow to go after agreeing: the store follows the board
                    // again either way, and its reconnect loop starts the daemon once one that agreed has gone.
                    store.start()
                    paused = false
                    refusals += 1
                    if refusals >= 3 {
                        updater.failed(String(localized: "Could not stop the Crew daemon for the update: \(error.localizedDescription)"))
                        return
                    }
                    updater.waitFor(0)
                }
            } else if daemon.active != nil { refusals = 0 }
            // A daemon whose health does not answer is waited for, never taken as gone, but not for ever.
            if let active = daemon.active {
                unanswered = 0
                updater.waitFor(active)
            } else {
                unanswered += 1
                if unanswered >= 24 {
                    updater.failed(String(localized: "The Crew daemon is not answering, so the update was not installed. Try again later."))
                    return abandon()
                }
            }
            try? await Task.sleep(for: .seconds(5))
        }
        guard current(), let archive = updater.archive, let version = updater.latest, let bundleUse = CrewEntry.bundleUse else { return abandon() }
        // The hand-over below awaits and then quits without checking again, so it can no longer be called off. With no
        // daemon of this bundle to stop, the loop above never said so.
        updater.stoppingDaemon()
        store.stop()
        paused = true
        let pid = ProcessInfo.processInfo.processIdentifier
        let result = updater.failureReport
        do {
            handOver = try await Task.detached {
                try AppUpdater.handOver(archive: archive, version: version, installed: installed, processID: pid,
                                        result: result, home: CrewHome.directory(), running: bundleUse)
            }.value
        } catch let error as AppUpdater.InvalidArchive {
            updater.discard(error.localizedDescription)
            return abandon()
        } catch {
            // The archive stays staged, so the update can be tried again.
            updater.failed(error.localizedDescription)
            return abandon()
        }
        NSApp.terminate(nil)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard leaveSettings(then: { [weak self] in self?.dismissSettings(); NSApp.terminate(nil) }) else {
            // An update waiting for this quit is called off: its helper must not swap the bundle under a running app.
            if let pending = handOver {
                handOver = nil
                kill(pending.helper, SIGTERM)
                try? FileManager.default.removeItem(at: pending.staged)
                try? FileManager.default.removeItem(at: pending.work)
                updater.failed(String(localized: "The update was not installed because Crew did not quit. Try again."))
                store.start()
            }
            return .terminateCancel
        }
        quitting = true
        let announced = store.connected && store.notificationsAllowed
        store.stop()
        guard announced else { return .terminateNow }
        // Without this the daemon keeps deferring alerts to a quit app until its heartbeat lease expires.
        Task {
            await store.sendDeparture()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    /**
     Whether settings can go now. Unsaved changes are asked about once: Don't Save leaves at once; Save saves them and,
     when every save worked, runs `leave` (the caller then gets false and does nothing itself); Cancel stays.
     */
    private func leaveSettings(then leave: @escaping @MainActor () -> Void) -> Bool {
        guard let settings else { return true }
        if settings.busy {
            let alert = NSAlert()
            alert.messageText = String(localized: "Settings are still saving")
            alert.informativeText = String(localized: "Wait for the save to finish before closing.")
            alert.runModal()
            return false
        }
        guard settings.dirty else { return true }
        settingsWindow?.makeKeyAndOrderFront(nil)
        let alert = NSAlert()
        alert.messageText = String(localized: "Save changes to Settings?")
        alert.informativeText = String(localized: "Your changes will be lost if you don't save them.")
        alert.addButton(withTitle: String(localized: "Save"))
        alert.addButton(withTitle: String(localized: "Don't Save"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            // A save that fails keeps the window open with its error showing, so nothing is lost silently.
            Task { if await settings.saveAll() { leave() } }
            return false
        case .alertSecondButtonReturn:
            settings.discardDrafts()
            return true
        default:
            return false
        }
    }
    private func updateNotifications() {
        let badge = store.state.pendingCount > 0 ? String(store.state.pendingCount) : nil
        if NSApp.dockTile.badgeLabel != badge { NSApp.dockTile.badgeLabel = badge }
        let finished = completions.finished(in: store.state.jobs)
        guard ProcessInfo.processInfo.environment["CREW_TEST_MODE"] != "1" else { return }
        if store.state.notifications?.onDone == true {
            for job in finished where job.endedAt.map({ store.ownsCompletion(at: $0) }) == true {
                notify(key: "done:\(job.id):\(job.turns)", title: String(localized: "\(agentName(job.agent)) finished"), body: job.title, job: job.id, persistent: true)
            }
        }
        var live = Set<String>()
        for job in store.state.waitingJobs {
            guard let waiting = job.waiting else { continue }
            let key = job.requestKey
            live.insert(key)
            notify(key: key, title: String(localized: "\(agentName(job.agent)) needs your input"), body: waiting.reason, job: job.id, request: waiting.type == "approval" ? waiting.id : nil)
        }
        for session in store.state.waitingSessions {
            live.insert(session.notificationKey)
            notify(key: session.notificationKey, title: String(localized: "\(agentName(session.agent)) needs your input"), body: session.waitingFor ?? session.title)
        }
        let expired = delivered.subtracting(live)
        // These are calls into the notification service; most updates expire nothing.
        if !expired.isEmpty {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(expired))
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: Array(expired))
            delivered.subtract(expired)
        }
        noticed.formIntersection(live)
    }
    private func notify(key: String, title: String, body: String, job: String? = nil, request: String? = nil, persistent: Bool = false) {
        guard store.notificationsAllowed else { return }
        guard !noticed.contains(key) else { return }
        noticed.insert(key)
        guard store.state.notifications?.enabled != false, mainWindow?.isKeyWindow != true else { return }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body
        if let job { content.userInfo["job"] = job }
        if let request { content.userInfo["request"] = request; content.categoryIdentifier = "approval" }
        if !persistent { delivered.insert(key) }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let jobID = response.notification.request.content.userInfo["job"] as? String
        let requestID = response.notification.request.content.userInfo["request"] as? String
        let action = response.actionIdentifier
        await handleNotification(jobID: jobID, requestID: requestID, action: action)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // The main board suppresses notifications at creation; Settings can remain frontmost.
        [.banner, .list]
    }
    private func handleNotification(jobID: String?, requestID: String?, action: String) async {
            guard let jobID, let requestID, action == "approve" || action == "deny" else { show(job: jobID); return }
            do {
                let current: Job = try await store.api.request("/api/jobs/\(jobID)")
                guard current.state == "waiting", current.waiting?.id == requestID else { show(job: jobID); return }
                await store.answer(current, decision: action)
                if store.actions[current.requestKey]?.error != nil { show(job: jobID) }
            } catch { show(job: jobID) }
    }
}

private struct WindowAccessor: NSViewRepresentable {
    var resolve: (NSWindow) -> Void
    func makeNSView(context: Context) -> WindowProbe { WindowProbe(resolve: resolve) }
    func updateNSView(_ view: WindowProbe, context: Context) {}
    final class WindowProbe: NSView {
        var resolve: (NSWindow) -> Void
        init(resolve: @escaping (NSWindow) -> Void) { self.resolve = resolve; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { DispatchQueue.main.async { self.resolve(window) } }
        }
    }
}
