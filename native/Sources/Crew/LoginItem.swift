import AppKit
import ServiceManagement

/// Open at Login. macOS holds the state (System Settings > General > Login Items), so nothing is stored here: the
/// switch reads it each time About opens, since the user can also turn it off there.
enum LoginItem {
    enum State: Equatable { case on, off, needsApproval }

    /// Only a copy run from an app bundle, as for updates, and never a test or alternate profile (`CREW_HOME`), which
    /// must not change what the user's login starts.
    static func supported(environment: [String: String] = ProcessInfo.processInfo.environment, bundle: Bundle = .main) -> Bool {
        bundle.bundleURL.pathExtension == "app" && environment["CREW_HOME"] == nil
    }

    /// On only while macOS will open the app at login; turned off in Login Items, it waits there for the user's approval.
    static var state: State {
        switch SMAppService.mainApp.status {
        case .enabled: .on
        case .requiresApproval: .needsApproval
        default: .off
        }
    }

    static func set(_ open: Bool) throws {
        if open { try SMAppService.mainApp.register() }
        else if SMAppService.mainApp.status != .notRegistered { try SMAppService.mainApp.unregister() }
    }

    static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }

    /// Whether macOS opened the app at login: its launch event says so (`keyAELaunchedAsLogInItem`). Read while that
    /// event is current, in `applicationDidFinishLaunching`.
    static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}
