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
                }.transition(.card)
            }
        }
        .task {
            while !Task.isCancelled {
                if let next: SetupState = try? await api.request("/api/setup", timeout: SetupState.timeout) { Motion.arrive { setup = next } }
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
    private func act(_ call: @escaping @MainActor () async throws -> SetupState) {
        busy = true
        error = nil
        Task {
            do {
                let next = try await call()
                Motion.arrive { setup = next }
            } catch { self.error = error.localizedDescription }
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

/// Open issues of the project's repository that are the user's to start: assigned to them, or to no one. Shown as a
/// section of cards under the agents, one per issue: what the issue is, a way to open it, and a way to start work on it.
/// Says nothing when there are none or gh cannot list them, as in the board. The page loads them (`BoardView.page`):
/// a view that shows nothing has no body for a task to run on.
struct IssueSuggestions: View {
    let store: CrewStore
    let project: String
    /// Three across, as the agent cards above, until a card would be narrower than this; then one under another.
    private static let cardMinWidth: CGFloat = 220
    @State private var across = true
    /// How many show at once; the next one takes the place of one the user dismisses.
    private static let shown = 3
    var body: some View {
        if let found = store.issues[project], !found.issues.isEmpty {
            let issues = Array(found.issues.prefix(Self.shown))
            VStack(alignment: .leading, spacing: Space.l) {
                Text("Start from an issue").font(Typeface.section).accessibilityAddTraits(.isHeader)
                    .padding(.leading, WorkspaceStyle.titleInset)
                if across {
                    HStack(alignment: .top, spacing: WorkspaceStyle.cardGap) {
                        ForEach(issues) { IssueCard(store: store, project: project, issue: $0).transition(.card) }
                        // Fewer issues keep the cards' width rather than stretching across the row.
                        ForEach(issues.count..<Self.shown, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity, maxHeight: 0) }
                    }.fixedSize(horizontal: false, vertical: true)
                } else {
                    VStack(spacing: WorkspaceStyle.cardGap) {
                        ForEach(issues) { IssueCard(store: store, project: project, issue: $0).transition(.card) }
                    }
                }
            }
            .onGeometryChange(for: Bool.self) {
                $0.size.width >= CGFloat(Self.shown) * Self.cardMinWidth + CGFloat(Self.shown - 1) * WorkspaceStyle.cardGap
            } action: { across = $0 }
            .transition(.card)
        }
    }
}

/// One issue, headed as a mission card is, with its two actions at the bottom, where they line up across a row.
private struct IssueCard: View {
    let store: CrewStore
    let project: String
    let issue: IssueList.Issue
    @Environment(\.openURL) private var openURL
    private var key: String { "issue:\(issue.url)" }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            // The mission cards' header: a one-line title over its meta line. Dismiss sits in the corner, as far from the
            // card's top as from its side.
            HStack(alignment: .top, spacing: Space.m) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    // Under a mission's and an agent's names: a suggestion, not work under way.
                    Text(verbatim: issue.title).font(Typeface.minorTitle).fadeTruncated().help(issue.title)
                    // Labels start with a capital, so a priority such as p1 reads as P1.
                    Text(verbatim: (["#\(issue.number)"] + issue.labels.prefix(3).map { $0.prefix(1).uppercased() + $0.dropFirst() }).joined(separator: " · "))
                        .font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).fadeTruncated()
                }
                Spacer(minLength: WorkspaceStyle.rowSpacer)
                Button { Task { await store.dismissIssue(issue.url, project: project) } } label: {
                    Image(systemName: "xmark").font(Symbol.control)
                }
                .iconButton()
                .disabled(store.actions[key]?.locked == true)
                .accessibilityLabel(String(localized: "Dismiss #\(issue.number)"))
                .help("Dismiss. This issue is not suggested again.")
            }
            if let error = store.actions[key]?.error { ErrorLabel(message: error).font(Typeface.callout) }
            HStack(spacing: Space.m) {
                if let url = URL(string: issue.url) {
                    Button { openURL(url) } label: { Label("Open Issue", systemImage: "arrow.up.right").frame(maxWidth: .infinity) }
                        .pillButton()
                        // Each card's own names, as on the board; three alike would not say which issue.
                        .accessibilityLabel(String(localized: "Open issue #\(issue.number)"))
                }
                // The accent's tint rather than its solid glass: three cards of solid buttons would outshout the page.
                Button { store.startWork(on: issue) } label: { Label("Start Work", systemImage: "play.fill").frame(maxWidth: .infinity) }
                    .pillButton(selected: true)
                    .accessibilityLabel(String(localized: "Start work on #\(issue.number)"))
                    .disabled(!store.connected)
                    .help("Opens New Job with this issue as the task.")
            }
            .frame(maxHeight: .infinity, alignment: .bottom)
        }
        // Set into the page rather than raised on it as missions are: a suggestion, not work under way.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).card(fill: WorkspaceStyle.rowFill)
    }
}
