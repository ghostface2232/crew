import SwiftUI
import AppKit

struct AgentMark: View {
    let agent: String
    var size: CGFloat = 24
    private var name: String { ["claude": "ClaudeCode", "codex": "Codex", "antigravity": "Antigravity", "cursor": "Cursor"][agent] ?? "Codex" }
    var body: some View {
        Image("Service\(name)").renderingMode(.template).resizable().scaledToFit()
            .frame(width: size, height: size).foregroundStyle(.primary).accessibilityHidden(true)
    }
}

struct StatusLabel: View {
    let state: String
    var title: String? = nil
    var symbol: String {
        switch state {
        case "waiting": return "hand.raised.fill"
        case "failed", "error": return "exclamationmark.triangle.fill"
        case "stalled": return "clock.badge.exclamationmark"
        case "done": return "checkmark.circle.fill"
        case "running", "working", "active": return "circle.dotted.circle"
        case "cancelled", "abandoned": return "stop.circle"
        default: return "circle"
        }
    }
    var color: Color {
        switch state {
        case "waiting", "stalled": return .orange
        case "failed", "error": return .red
        case "done": return .green
        case "running", "working", "active": return .accentColor
        default: return .secondary
        }
    }
    var body: some View {
        Label(title ?? state.capitalized, systemImage: symbol)
            .font(.system(size: 10, weight: .medium)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(color.opacity(0.09), in: Capsule())
    }
}

struct ContentPanel<Content: View>: View {
    var title: String
    var symbol: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: symbol).font(.system(size: 16, weight: .semibold, design: .rounded)).tracking(-0.3).accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.primary.opacity(0.04)))
    }
}

struct ActionMessage: View {
    var state: ActionState?
    var body: some View {
        if let error = state?.error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.callout).textSelection(.enabled) }
        else if state?.pending == true { ProgressView().controlSize(.small).accessibilityLabel("Sending") }
        else if state?.accepted == true { Label("Sent", systemImage: "checkmark").foregroundStyle(.secondary).font(.callout) }
    }
}

struct CopyButton: View {
    var title: String
    var text: String
    @State private var copied = false
    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
        } label: { Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc") }
        .help(title)
        .task(id: copied) {
            if copied { try? await Task.sleep(for: .seconds(2)); copied = false }
        }
    }
}

struct MessageEditor: View {
    var title: String
    @Binding var text: String
    var disabled = false
    var body: some View {
        TextEditor(text: $text)
            .font(.body)
            .scrollContentBackground(.hidden)
            .padding(8)
            .frame(minHeight: 80, maxHeight: 180)
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
            .accessibilityLabel(title)
            .disabled(disabled)
    }
}

struct AnswerView: View {
    @Bindable var store: CrewStore
    let job: Job
    private var locked: Bool { store.actions[job.requestKey]?.locked == true || !store.connected }
    var body: some View {
        if job.state == "waiting", let waiting = job.waiting {
            VStack(alignment: .leading, spacing: 14) {
                // The request itself is what the person acts on, so it leads the hierarchy.
                Text(waiting.reason).font(.system(size: 15, weight: .medium)).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if waiting.type == "question" {
                    MessageEditor(title: "Your answer", text: Binding(
                        get: { store.drafts[job.requestKey] ?? "" }, set: { store.drafts[job.requestKey] = $0 }
                    ), disabled: locked)
                }
                GlassEffectContainer {
                    HStack(spacing: 12) {
                        if waiting.type == "question" {
                            Button("Send answer", systemImage: "arrow.up") {
                                Task { await store.answer(job, message: store.drafts[job.requestKey]) }
                            }
                            .buttonStyle(.glassProminent)
                            .disabled((store.drafts[job.requestKey] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        Button(waiting.type == "approval" ? "Approve" : "Yes", systemImage: "checkmark") {
                            Task { await store.answer(job, decision: "approve") }
                        }.buttonStyle(.glass)
                        Button(waiting.type == "approval" ? "Deny" : "No", systemImage: "xmark") {
                            Task { await store.answer(job, decision: "deny") }
                        }.buttonStyle(.glass)
                    }
                }.disabled(locked)
                ActionMessage(state: store.actions[job.requestKey])
            }
        }
    }
}

struct JobRow: View {
    let job: Job
    var selected = false
    var now: Double
    var open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: job.kind == "review" ? "checkmark.shield" : job.kind == "polish" ? "text.badge.checkmark" : "hammer")
                    .font(.title3).foregroundStyle(.secondary).frame(width: 24).padding(.top, 2)
                VStack(alignment: .leading, spacing: 5) {
                    Text(job.title).font(.system(size: 13, weight: .medium)).foregroundStyle(.primary).lineLimit(3)
                    HStack {
                        Text(agentName(job.agent)).foregroundStyle(.secondary)
                        StatusLabel(state: job.stalled ? "stalled" : job.state, title: job.status)
                    }.font(.callout)
                    if job.isActive || job.error != nil {
                        Text(job.error?.message ?? job.phase).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                    }
                    if job.runsApp == true || job.exclusive == true {
                        Text([job.runsApp == true ? "Runs the app" : nil, job.exclusive == true ? "Runs alone" : nil].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                Text(elapsed((job.endedAt ?? now) - job.createdAt)).monospacedDigit().font(.caption).foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(12).contentShape(Rectangle())
            .background(selected ? Color.accentColor.opacity(0.09) : job.state == "waiting" ? Color.orange.opacity(0.07) : .primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(WorkspacePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SessionView: View {
    var session: ClaudeSession
    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                Text(session.waitingFor ?? session.phase)
                Text(session.cwd).font(.caption).foregroundStyle(.secondary)
                if session.state == "waiting" { Text("Answer in the Claude app, in the session that asked.").foregroundStyle(.secondary) }
                if session.inTool { Label("A tool is running", systemImage: "wrench.and.screwdriver").font(.caption) }
            }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.title).font(.body.weight(.medium))
                StatusLabel(state: session.stalled ? "stalled" : session.state, title: "Claude · \(session.stalled ? "May be stuck" : session.state.capitalized)")
            }
        }
    }
}

struct EventList: View {
    var events: [CrewEvent]
    var openJob: (String) -> Void
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(events.reversed()) { event in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: event.kind == "error" ? "exclamationmark.circle" : event.kind == "done" ? "checkmark.circle" : "circle.fill")
                        .font(.caption).foregroundStyle(event.kind == "error" ? .red : .secondary).frame(width: 16).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(agentName(event.agent)).font(.callout.weight(.medium))
                            if let date = ISO8601DateFormatter.crew.date(from: event.ts) {
                                Text(date, style: .time).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let id = event.job_id {
                                Button("Show job", systemImage: "arrow.up.right") { openJob(id) }.labelStyle(.iconOnly).buttonStyle(.borderless).help("Show job")
                            }
                        }
                        Text(event.detail).font(.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}
extension ISO8601DateFormatter {
    @MainActor static let crew: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
