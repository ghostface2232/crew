import SwiftUI

/// What Crew needs and whether each is in place (`GET /api/setup`), from the same checks as `crew doctor`.
struct SetupState: Decodable, Sendable {
    /// A fresh check runs the CLIs one after another, and asking Codex about its hooks alone may take 20 seconds.
    static let timeout: TimeInterval = 90
    struct Item: Decodable, Sendable, Identifiable {
        var id: String
        var label: String
        var ok: Bool
        var detail: String
        var summary: String?
        var repairable: Bool?
        var trustable: Bool?
    }
    struct Registration: Decodable, Sendable { var ok: Bool; var detail: String }
    var items: [Item]
    var registering: Bool
    var registration: Registration?
}

/// The overview's setup checklist. The daemon installs the bundled Claude Code plugin by itself; this shows what is
/// still missing, offers Install for what Crew can put in place and Trust Hooks for Crew's Codex hooks, and leaves
/// installing and signing in to the CLIs to the user. It hides once every item passes.
struct SetupCard: View {
    let api: CrewAPI
    @State private var setup: SetupState?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Group {
            if let setup, !setup.items.allSatisfy(\.ok) {
                ContentPanel(title: String(localized: "Set up Crew"), symbol: "wrench.and.screwdriver") {
                    VStack(alignment: .leading, spacing: Space.m) {
                        ForEach(setup.items) { item in
                            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                                Image(systemName: item.ok ? "checkmark.circle" : "exclamationmark.circle")
                                    .font(Typeface.callout).foregroundStyle(item.ok ? .secondary : Palette.warning).frame(width: Symbol.controlFrame)
                                Text(withCode(localizedCrewLabel(item.label))).font(Typeface.callout)
                                Text(withCode(localizedCrewLabel(item.summary ?? item.detail)))
                                    .font(Typeface.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                    .help(item.summary == nil ? "" : item.detail)
                            }
                        }
                    }
                    if let message = error ?? setup.registration.flatMap({ $0.ok ? nil : $0.detail }) {
                        ErrorLabel(message: message).font(Typeface.caption)
                    }
                    // The card's actions end it at the trailing edge, as a section's do.
                    ActionRow {
                        Button("Check Again") { act { try await api.request("/api/setup?refresh", timeout: SetupState.timeout) } }.pillButton().disabled(busy)
                        if setup.items.contains(where: { !$0.ok && $0.repairable == true }) {
                            Button(busy ? String(localized: "Installing…") : String(localized: "Install")) { act { try await api.post("/api/setup/repair", [String: String](), timeout: 180) } }
                                .glassPillButton().morphs(on: busy).disabled(busy || setup.registering)
                        }
                        if setup.items.contains(where: { !$0.ok && $0.trustable == true }) {
                            Button("Trust Hooks") { act { try await api.post("/api/setup/trust-hooks", [String: String](), timeout: SetupState.timeout) } }
                                .glassPillButton().disabled(busy || setup.registering)
                        }
                    }.frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .task {
            while !Task.isCancelled {
                if let next: SetupState = try? await api.request("/api/setup", timeout: SetupState.timeout) { setup = next }
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
    private func act(_ call: @escaping @MainActor () async throws -> SetupState) {
        busy = true
        error = nil
        Task {
            do { setup = try await call() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Shows the `backticked` names in a setup item as code. Only backticks count: details carry paths and command output,
/// which Markdown would reshape.
func withCode(_ text: String) -> AttributedString {
    var result = AttributedString()
    for (index, part) in text.split(separator: "`", omittingEmptySubsequences: false).enumerated() {
        var run = AttributedString(String(part))
        if index % 2 == 1 { run.inlinePresentationIntent = .code }
        result += run
    }
    return result
}

/// Open issues of the project's repository that are the user's to start: assigned to them, or to no one. Each can be
/// copied as a run command or dismissed for good. Says nothing when there are none or gh cannot list them, as in the board.
struct IssueSuggestionsCard: View {
    let store: CrewStore
    let project: String
    /// How many show at once; the next one takes the place of one the user dismisses.
    private static let shown = 3
    var body: some View {
        Group {
            if let found = store.issues[project], !found.issues.isEmpty {
                ContentPanel(title: String(localized: "Start from an issue"), symbol: "checklist") {
                    VStack(alignment: .leading, spacing: Space.s) {
                        ForEach(found.issues.prefix(Self.shown)) { issue in
                            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                                Link(destination: URL(string: issue.url) ?? URL(fileURLWithPath: "/")) {
                                    Text(verbatim: "#\(issue.number) ").foregroundStyle(.secondary) + Text(verbatim: issue.title)
                                }
                                .font(Typeface.callout).lineLimit(1).truncationMode(.tail).help(issue.title)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                if !issue.labels.isEmpty {
                                    Text(verbatim: issue.labels.prefix(3).joined(separator: " · ")).font(Typeface.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                CopyButton(title: String(localized: "Command"), text: "\(command) \(issue.url)")
                                Button { Task { await store.dismissIssue(issue.url, project: project) } } label: {
                                    Image(systemName: "xmark").font(Symbol.control)
                                }
                                .iconButton()
                                .disabled(store.actions["issue:\(issue.url)"]?.locked == true)
                                .accessibilityLabel(String(localized: "Dismiss #\(issue.number)"))
                                .help("Dismiss. This issue is not suggested again.")
                            }
                        }
                    }
                }
            }
        }
        // The daemon keeps each answer ten minutes, so asking more often only reads its cache.
        .task(id: project) {
            while !Task.isCancelled {
                await store.loadIssues(project)
                try? await Task.sleep(for: .seconds(600))
            }
        }
    }
    /// Codex names a plugin skill with $, so the command is copied in the form the project's latest lead takes.
    private var command: String {
        store.state.claude.filter { $0.projectPath == project }.max { $0.activeAt < $1.activeAt }?.host == "codex" ? "$crew:run" : "/crew:run"
    }
}
