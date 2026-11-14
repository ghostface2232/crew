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
        case "waiting": return "bell.badge.fill"
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
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        // Darkened in light mode so orange and green text reach about 3:1 on the tint; dark mode already does.
        let text = scheme == .light ? color.mix(with: .black, by: 0.22) : color
        Label(title ?? state.capitalized, systemImage: symbol)
            .font(Typeface.chip).foregroundStyle(text).lineLimit(1).fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
            .overlay { if contrast == .increased { Capsule().strokeBorder(text.opacity(0.5)) } }
    }
}

/// A light, centered empty state; quieter than ContentUnavailableView's bold title.
struct EmptyState<Actions: View>: View {
    var title: String
    var symbol: String
    var detail: String? = nil
    @ViewBuilder var actions: Actions
    var body: some View {
        VStack(spacing: 6) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 30, weight: .light)).foregroundStyle(.secondary).padding(.bottom, 2)
                Text(title).font(Typeface.emptyTitle).foregroundStyle(.secondary)
                if let detail { Text(detail).font(Typeface.callout).foregroundStyle(.tertiary) }
            }.accessibilityElement(children: .combine)
            // Kept out of the combined element so the action stays its own control.
            actions.padding(.top, 10)
        }
        .multilineTextAlignment(.center).centeredInPage()
    }
}
extension EmptyState where Actions == EmptyView {
    init(title: String, symbol: String, detail: String? = nil) {
        self.init(title: title, symbol: symbol, detail: detail) { EmptyView() }
    }
}

struct ContentPanel<Content: View>: View {
    var title: String?
    var symbol = ""
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title {
                Label(title, systemImage: symbol).font(Typeface.title).accessibilityAddTraits(.isHeader)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

struct ActionMessage: View {
    var state: ActionState?
    var body: some View {
        if let error = state?.error { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(Typeface.callout).textSelection(.enabled) }
        else if state?.pending == true { ProgressView().controlSize(.small).accessibilityLabel("Sending") }
        else if state?.accepted == true { Label("Sent", systemImage: "checkmark").foregroundStyle(.secondary).font(Typeface.callout) }
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
            .font(Typeface.body)
            .scrollContentBackground(.hidden)
            .padding(10)
            .frame(minHeight: 80, maxHeight: 180)
            .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius))
            .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(WorkspaceStyle.hairline))
            .accessibilityLabel(title)
            .disabled(disabled)
    }
}

struct AnswerView: View {
    @Bindable var store: CrewStore
    let job: Job
    private var locked: Bool { store.actions[job.requestKey]?.locked == true || !store.connected }
    private var draft: Binding<String> {
        Binding(get: { store.drafts[job.requestKey] ?? "" }, set: { store.drafts[job.requestKey] = $0 })
    }
    private var canSend: Bool { !locked && !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        if job.state == "waiting", let waiting = job.waiting {
            VStack(alignment: .leading, spacing: 14) {
                // The request itself is what the person acts on, so it leads the hierarchy.
                Text(waiting.reason).font(Typeface.headline).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if waiting.type == "question" {
                    composer
                    // Quick replies sit apart from the composer so they don't read as part of sending.
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        decision("Yes", symbol: "checkmark", value: "approve", prominent: false)
                        decision("No", symbol: "xmark", value: "deny", prominent: false)
                    }
                } else {
                    HStack(spacing: 8) {
                        decision("Approve", symbol: "checkmark", value: "approve", prominent: true)
                        decision("Deny", symbol: "xmark", value: "deny", prominent: false)
                    }
                }
                ActionMessage(state: store.actions[job.requestKey])
            }
        }
    }
    private var composer: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: draft)
                .font(Typeface.body).lineSpacing(2)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 56, maxHeight: 160)
                .accessibilityLabel("Your answer")
            if draft.wrappedValue.isEmpty {
                Text("Write an answer…").font(Typeface.body).foregroundStyle(.tertiary)
                    .padding(.leading, 5).allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .padding(.leading, 10).padding(.top, 10).padding(.trailing, 44).padding(.bottom, 8)
        .overlay(alignment: .bottomTrailing) {
            Button("Send answer", systemImage: "arrow.up") {
                Task { await store.answer(job, message: draft.wrappedValue) }
            }
            .labelStyle(.iconOnly).font(.system(size: 12, weight: .bold))
            .buttonStyle(.borderedProminent).buttonBorderShape(.circle).controlSize(.small)
            .disabled(!canSend).help("Send answer").padding(8)
        }
        .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius))
        .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(WorkspaceStyle.hairline))
        .disabled(locked)
    }
    @ViewBuilder private func decision(_ title: String, symbol: String, value: String, prominent: Bool) -> some View {
        // A draft typed before a quick reply goes along with it rather than being discarded.
        let note = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let button = Button(title, systemImage: symbol) { Task { await store.answer(job, decision: value, message: note.isEmpty ? nil : note) } }
            .font(Typeface.calloutStrong).buttonBorderShape(.capsule).disabled(locked)
        if prominent { button.buttonStyle(.borderedProminent) } else { button.buttonStyle(.bordered) }
    }
}

/// Reads the store's clock in its own body, so the periodic tick redraws only running timers.
struct ElapsedText: View {
    let store: CrewStore
    let start: Double
    let end: Double?
    var body: some View { Text(elapsed((end ?? store.now) - start)) }
}

struct JobRow: View {
    let job: Job
    var selected = false
    let store: CrewStore
    var open: () -> Void
    var body: some View {
        let detail = [agentName(job.agent), job.ask == true ? "Question" : nil, job.error?.message ?? (job.isActive ? job.phase : nil),
                      job.runsApp == true ? "Runs the app" : nil, job.exclusive == true ? "Runs alone" : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: job.ask == true ? "questionmark.bubble" : job.kind == "review" ? "checkmark.shield" : job.kind == "polish" ? "text.badge.checkmark" : "hammer")
                    .font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 20)
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.title).font(Typeface.bodyStrong).foregroundStyle(.primary).lineLimit(2)
                    Text(detail).font(Typeface.caption).foregroundStyle(job.error == nil ? Color.secondary : .red).lineLimit(1)
                }
                Spacer(minLength: 8)
                StatusLabel(state: job.stalled ? "stalled" : job.state, title: job.status)
                ElapsedText(store: store, start: job.createdAt, end: job.endedAt).monospacedDigit().font(Typeface.caption).foregroundStyle(.secondary)
                    .frame(minWidth: 28, alignment: .trailing)
                Image(systemName: "chevron.right").font(Typeface.micro).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
            .background(selected ? Color.accentColor.opacity(0.09) : job.state == "waiting" ? Color.orange.opacity(0.07) : WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
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
                Text(session.cwd).font(Typeface.caption).foregroundStyle(.secondary)
                if session.state == "waiting" { Text("Answer in Claude.").foregroundStyle(.secondary) }
                if session.inTool { Label("A tool is running", systemImage: "wrench.and.screwdriver").font(Typeface.caption) }
            }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
        } label: {
            HStack(spacing: 10) {
                AgentMark(agent: "claude", size: 14)
                Text(session.title).font(Typeface.bodyStrong).lineLimit(1)
                Spacer(minLength: 8)
                StatusLabel(state: session.stalled ? "stalled" : session.state, title: session.stalled ? "May be stuck" : session.state.capitalized)
            }
        }
    }
}

struct EventList: View {
    var events: [CrewEvent]
    /// Nil inside a job's own details, where every event belongs to the job already shown.
    var openJob: ((String) -> Void)? = nil
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(events.reversed()) { event in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: event.kind == "error" ? "exclamationmark.circle" : event.kind == "done" ? "checkmark.circle" : "circle.fill")
                        .font(Typeface.caption).foregroundStyle(event.kind == "error" ? .red : .secondary).frame(width: 16).padding(.top, 3)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(agentName(event.agent)).font(Typeface.calloutStrong)
                            if let date = ISO8601DateFormatter.crew.date(from: event.ts) {
                                Text(date, style: .time).font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let id = event.job_id, let openJob {
                                Button("Show job", systemImage: "arrow.up.right") { openJob(id) }.labelStyle(.iconOnly)
                                    .buttonStyle(.bordered).buttonBorderShape(.circle).controlSize(.small).help("Show job")
                            }
                        }
                        Text(event.detail).font(Typeface.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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

struct WorkspacePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.68 : 1)
    }
}

struct AgentUsageView: View {
    let store: CrewStore
    let agent: String
    var body: some View {
        if let usage = store.usage, usage.source != "none" {
            if let provider = usage.providers.first(where: { $0.agent == agent }) {
                VStack(alignment: .leading, spacing: 6) {
                    if provider.shownWindows.isEmpty {
                        Text(provider.status.rawValue.capitalized).foregroundStyle(.secondary)
                    }
                    ForEach(provider.shownWindows, id: \.key) { window in
                        // The provider's status overrides a window's when the reading is old or a job just hit the limit.
                        let status = [.stale, .unknown, .exhausted].contains(provider.status) ? provider.status : window.status
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 6) {
                                Text(window.name)
                                Text(window.usedRatio, format: .percent.precision(.fractionLength(0))).monospacedDigit()
                                if status == .stale || status == .unknown || (status == .exhausted && window.status != .exhausted) { Text(status == .exhausted ? "limit reached" : status.rawValue) }
                                Spacer(minLength: 0)
                                if let reset = window.resetTime {
                                    Text("Resets \(Date(timeIntervalSince1970: reset / 1000), style: .relative)")
                                }
                            }
                            GeometryReader { geometry in
                                Capsule().fill(tint(window.usedRatio, status)).frame(width: geometry.size.width * min(1, max(0, window.usedRatio)))
                            }.frame(height: 3).background(.quaternary, in: Capsule()).accessibilityHidden(true)
                        }.foregroundStyle(tint(window.usedRatio, status))
                    }
                }.font(Typeface.caption).help(([provider.reason] + provider.windows.filter { $0.group != nil }.map {
                    "\($0.group!): \($0.name), \(Int($0.usedRatio * 100))%, \($0.status.rawValue)"
                }).joined(separator: "\n"))
            } else {
                Text("Usage unknown").font(Typeface.caption).foregroundStyle(.secondary)
            }
        } else if let usage = store.limits[agent] ?? nil, let maximum = usage.windows?.map(\.usedPercent).max() {
            Text("\(Int(maximum))% of limit").font(Typeface.caption).monospacedDigit().foregroundStyle(tint(maximum / 100, .ok))
                .help((usage.windows ?? []).map { window in
                    "\(Int(window.usedPercent))% of " + (window.minutes.map { "\(Int($0))-minute limit" } ?? "limit")
                }.joined(separator: "\n"))
        }
    }
    /// AgentGauge's thresholds: caution from 70% used, danger from 90% or when the limit was hit.
    private func tint(_ used: Double, _ status: UsageStatus) -> Color {
        if status == .exhausted || used >= 0.9 { return .red }
        return used >= 0.7 ? .orange : .secondary
    }
}

/// Keeps content to its single line and, when the line runs out of room, fades its end out instead of cutting it
/// with an ellipsis, so a long title neither wraps nor changes the height of what holds it.
private struct FadeTruncation: ViewModifier {
    var fade: CGFloat = 36
    @State private var natural: CGFloat = 0
    @State private var available: CGFloat = 0
    func body(content: Content) -> some View {
        content.lineLimit(1).fixedSize(horizontal: true, vertical: false)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { natural = $0 }
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
            .clipped()
            .mask {
                if natural > available + 0.5 {
                    HStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: fade)
                    }
                } else {
                    Color.black
                }
            }
    }
}
extension View {
    func fadeTruncated() -> some View { modifier(FadeTruncation()) }
}
