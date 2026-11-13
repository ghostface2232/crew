import SwiftUI
import AppKit
import UserNotifications

@main
struct CrewApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Window("Crew", id: "main") {
            NavigationStack {
                BoardView(store: delegate.store, openSettings: delegate.openSettings)
            }
            // Small bordered buttons read as pills across the app; sheets inherit this.
            .buttonBorderShape(.capsule)
            .background(WindowAccessor { delegate.configure($0) })
        }
        .defaultSize(width: 1180, height: 780)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Job…") { delegate.show(); delegate.store.showingDispatch = true }
                    .keyboardShortcut("n").disabled(!delegate.store.connected)
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings…", action: delegate.openSettings).keyboardShortcut(",").disabled(delegate.store.state.roles.isEmpty)
            }
            CommandGroup(after: .textEditing) {
                Button("Search Work") { delegate.show(); delegate.store.searchRequest += 1 }.keyboardShortcut("f")
            }
            CommandMenu("Workspace") {
                Button("Overview") { delegate.show(); delegate.store.selection = "overview" }.keyboardShortcut("1")
                Button("Needs You") { delegate.show(); delegate.store.selection = "needs" }.keyboardShortcut("2")
                Button("Activity") { delegate.show(); delegate.store.selection = "activity" }.keyboardShortcut("3")
                Button("History") { delegate.show(); delegate.store.selection = "history" }.keyboardShortcut("4")
                Divider()
                Button("Open Web Board") { NSWorkspace.shared.open(delegate.store.api.baseURL) }
            }
        }
        MenuBarExtra {
            Text(delegate.store.connected ? "Crew is connected" : "Crew is reconnecting")
            Button("Open Crew", action: delegate.show)
            if delegate.store.state.pendingCount > 0 {
                Button("\(delegate.store.state.pendingCount) requests need you") { delegate.show(); delegate.store.selection = "needs" }
            }
            Divider()
            ForEach(Array(delegate.store.state.waitingJobs.prefix(5))) { job in
                Button("\(agentName(job.agent)): \(job.title)") { delegate.show(job: job.id) }
            }
            Divider()
            Button("Settings…", action: delegate.openSettings).disabled(delegate.store.state.roles.isEmpty)
            Button("Open Web Board") { NSWorkspace.shared.open(delegate.store.api.baseURL) }
            Divider()
            Button("Quit Crew — jobs keep running") { NSApp.terminate(nil) }
        } label: {
            Label(delegate.store.state.pendingCount > 0 ? "Crew · \(delegate.store.state.pendingCount) waiting" : "Crew", systemImage: delegate.store.state.pendingCount > 0 ? "circle.dotted.circle.fill" : "circle.dotted.circle")
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
    let store: CrewStore
    private weak var mainWindow: NSWindow?
    private var settingsWindow: NSWindow?
    private var settings: SettingsModel?
    private var noticed = Set<String>()
    private var delivered = Set<String>()
    private var quitting = false
    private var instanceLock: InstanceLock?
    private var completions = CompletionTracker()

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
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let home = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CREW_HOME"] ?? NSHomeDirectory() + "/.crew")
        let lock = InstanceLock(home: home)
        do {
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
        store.onStateChange = { [weak self] in self?.updateNotifications() }
        store.start()
        if ProcessInfo.processInfo.environment["CREW_TEST_MODE"] != "1" {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.setNotificationCategories([UNNotificationCategory(identifier: "approval", actions: [
                UNNotificationAction(identifier: "approve", title: "Approve"),
                UNNotificationAction(identifier: "deny", title: "Deny", options: [.destructive]),
            ], intentIdentifiers: [])])
            Task {
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                let settings = await center.notificationSettings()
                store.notificationsAllowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                if store.notificationsAllowed {
                    await store.sendHeartbeat()
                    updateNotifications()
                }
            }
        }
    }
    func configure(_ window: NSWindow) {
        guard mainWindow !== window else { return }
        mainWindow = window
        window.delegate = self
        window.title = "Crew"
        window.minSize = NSSize(width: 850, height: 560)
        window.isReleasedWhenClosed = false
        let frameName = "CrewMain\(ProcessInfo.processInfo.environment["CREW_HOME"] ?? "")"
        window.setFrameAutosaveName(frameName)
        window.setFrameUsingName(frameName)
        if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) { window.center() }
    }
    func show() { show(job: nil) }
    @objc private func reopenWindow() { show() }
    func show(job: String?) {
        store.windowVisible = true
        if let job { store.openJob(job, navigate: true) }
        mainWindow?.deminiaturize(nil)
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func openSettings() {
        if let window = settingsWindow { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        guard !store.state.roles.isEmpty else { show(); return }
        let model = SettingsModel(api: store.api, roles: store.state.roles)
        let controller = NSHostingController(rootView: CrewSettingsView(model: model, store: store).buttonBorderShape(.capsule))
        let window = NSWindow(contentViewController: controller)
        window.title = "Crew Settings"
        window.styleMask = [.titled, .closable, .resizable]
        window.setContentSize(NSSize(width: 720, height: 620))
        window.minSize = NSSize(width: 640, height: 570)
        window.isReleasedWhenClosed = false
        window.delegate = self
        settings = model; settingsWindow = window
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === settingsWindow {
            guard canLeaveSettings() else { return false }
            settingsWindow = nil; settings = nil
            return true
        }
        if !quitting { store.windowVisible = false; sender.orderOut(nil); return false }
        return true
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { show(); return false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
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
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard canLeaveSettings() else { return .terminateCancel }
        quitting = true
        store.stop()
        return .terminateNow
    }
    private func canLeaveSettings() -> Bool {
        guard let settings else { return true }
        if settings.busy {
            let alert = NSAlert()
            alert.messageText = "Settings are still saving"
            alert.informativeText = "Wait for the save to finish before closing."
            alert.runModal()
            return false
        }
        return !settings.dirty || confirmDiscard("Discard unsaved settings?")
    }
    private func updateNotifications() {
        NSApp.dockTile.badgeLabel = store.state.pendingCount > 0 ? String(store.state.pendingCount) : nil
        let finished = completions.finished(in: store.state.jobs)
        guard ProcessInfo.processInfo.environment["CREW_TEST_MODE"] != "1" else { return }
        if store.state.notifications?.onDone == true {
            for job in finished where job.endedAt.map({ store.ownsCompletion(at: $0) }) == true {
                notify(key: "done:\(job.id):\(job.turns)", title: "\(agentName(job.agent)) finished", body: job.title, job: job.id, persistent: true)
            }
        }
        var live = Set<String>()
        for job in store.state.waitingJobs {
            guard let waiting = job.waiting else { continue }
            let key = job.requestKey
            live.insert(key)
            notify(key: key, title: "\(agentName(job.agent)) needs your input", body: waiting.reason, job: job.id, request: waiting.type == "approval" ? waiting.id : nil)
        }
        for session in store.state.waitingSessions {
            live.insert(session.notificationKey)
            notify(key: session.notificationKey, title: "Claude needs your input", body: session.waitingFor ?? session.title)
        }
        let expired = delivered.subtracting(live)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: Array(expired))
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: Array(expired))
        delivered.subtract(expired)
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
