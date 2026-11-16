import SwiftUI

/// What Crew needs and whether each is in place (`GET /api/setup`), from the same checks as `crew doctor`.
struct SetupState: Decodable, Sendable {
    struct Item: Decodable, Sendable, Identifiable {
        var id: String
        var label: String
        var ok: Bool
        var detail: String
        var repairable: Bool?
    }
    struct Registration: Decodable, Sendable { var ok: Bool; var detail: String }
    var items: [Item]
    var registering: Bool
    var registration: Registration?
}

/// The overview's setup checklist. The daemon installs the bundled Claude Code plugin by itself; this shows what is
/// still missing, offers Install for what Crew can put in place, and leaves installing and signing in to the CLIs
/// to the user. It hides once every item passes.
struct SetupCard: View {
    let api: CrewAPI
    @State private var setup: SetupState?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Group {
            if let setup, !setup.items.allSatisfy(\.ok) {
                VStack(alignment: .leading, spacing: Space.m) {
                    HStack {
                        Text("Set up Crew").font(Typeface.bodyStrong)
                        Spacer()
                        Button("Check again") { act { try await api.request("/api/setup?refresh") } }.pillButton().disabled(busy)
                        if setup.items.contains(where: { !$0.ok && $0.repairable == true }) {
                            Button(busy ? "Installing…" : "Install") { act { try await api.post("/api/setup/repair", [String: String](), timeout: 180) } }
                                .pillButton().disabled(busy || setup.registering)
                        }
                    }
                    ForEach(setup.items) { item in
                        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                            Image(systemName: item.ok ? "checkmark.circle" : "exclamationmark.circle")
                                .foregroundStyle(item.ok ? .secondary : Palette.warning)
                            Text(item.label).font(Typeface.callout)
                            Text(item.detail).font(Typeface.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }
                    if let message = error ?? setup.registration.flatMap({ $0.ok ? nil : $0.detail }) {
                        Text(message).font(Typeface.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .card()
            }
        }
        .task {
            while !Task.isCancelled {
                if let next: SetupState = try? await api.request("/api/setup") { setup = next }
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
