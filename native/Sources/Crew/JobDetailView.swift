import SwiftUI

struct JobDetailView: View {
    @Bindable var store: CrewStore
    let id: String
    @State private var detail: Job?
    @State private var events: [CrewEvent] = []
    @State private var error = ""
    @State private var retry = 0
    private var job: Job? {
        guard var current = store.state.jobs.first(where: { $0.id == id }) else { return detail }
        current.prompt = detail?.prompt ?? current.prompt
        return current
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if !error.isEmpty {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                    Button("Retry") { retry += 1 }
                }
                if job == nil && error.isEmpty { ProgressView("Loading details…") }
                if let job { contents(job) }
            }.padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 24).frame(maxWidth: .infinity, alignment: .leading)
        }
        // The header stays while the details scroll under it. As a scroll view's bar, it gets the system's
        // soft edge effect: the content fades and blurs progressively beneath it instead of being cut off.
        .safeAreaBar(edge: .top) { header }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .onExitCommand { store.selectedJob = nil }
        .task(id: "\(id):\(store.revision):\(retry)") { await load() }
    }
    private func load() async {
        error = ""
        let version = store.jobVersion(id)
        do {
            async let fetched: Job = store.api.request("/api/jobs/\(id)")
            async let history: [CrewEvent] = store.api.request("/api/jobs/\(id)/events")
            let result = try await (fetched, history)
            try Task.checkCancellation()
            detail = result.0; events = result.1
            store.applyJob(result.0, since: version)
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                if let job { StatusLabel(state: job.stalled ? "stalled" : job.state, title: job.status) }
                Spacer()
                Button("Close Details", systemImage: "xmark") { store.selectedJob = nil }
                    .buttonStyle(.bordered).buttonBorderShape(.circle).labelStyle(.iconOnly).help("Close details (Esc)").keyboardShortcut(.cancelAction)
            }
            // Two lines at most, so a long title cannot take over the panel. Selectable text drops its
            // truncation once selected, so the full title is copied from a menu instead.
            if let job {
                Text(job.title).font(Typeface.title).lineSpacing(2).lineLimit(2).help(job.title)
                    .contextMenu {
                        Button("Copy Title", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(job.title, forType: .string)
                        }
                    }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 12)
    }
    @ViewBuilder private func contents(_ job: Job) -> some View {
        if job.isActive || job.error != nil {
            VStack(alignment: .leading, spacing: 8) {
                if job.isActive { Text(job.phase).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled) }
                if let failure = job.error { Text(failure.message).font(Typeface.callout).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
        if job.state == "waiting" {
            AnswerView(store: store, job: job)
                .card(fill: .orange.opacity(0.06))
        }
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            // The model the session reported, else the configured one.
            fact("Agent", [agentName(job.agent), job.resolvedModel ?? job.model, (job.resolvedEffort ?? job.effort).map { "\($0) effort" }].compactMap { $0 }.joined(separator: " · "))
            fact("Role", job.kindTitle)
            fact("Project", job.projectPath)
            fact("Duration", elapsed((job.endedAt ?? store.now) - job.createdAt))
            if let worktree = job.worktree { fact("Branch", "\(worktree.branch) (from \(worktree.base.prefix(8)))") }
            if let tokens = job.tokens { fact("Tokens", tokens.formatted()) }
            if let use = job.tokenUse {
                fact("Of which", "\(use.cachedInput.formatted()) cached input · \((use.input - use.cachedInput).formatted()) uncached input · \(use.output.formatted()) output" + (job.turns > 1 ? " · \(use.turn.formatted()) in the latest turn" : ""))
            }
            fact("Turns", String(job.turns))
            if let shared = job.shared, !shared.isEmpty { fact("Instructions", shared.joined(separator: "\n")) }
        }.font(Typeface.callout).textSelection(.enabled).inset()
        if let result = job.result {
            detailSection("Changes", symbol: "arrow.triangle.branch") {
                Text(result.stat.isEmpty ? "No files changed" : result.stat).font(Typeface.code).textSelection(.enabled)
                if let commit = result.commit { Text("Commit \(commit)").font(Typeface.caption).textSelection(.enabled) }
                ForEach(Array(Set(result.files + result.outOfScope)).sorted(), id: \.self) { file in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(file).font(Typeface.code).textSelection(.enabled)
                        if result.outOfScope.contains(file) {
                            Label(result.files.contains(file) ? "Outside the allowed targets" : "Outside the workspace", systemImage: "exclamationmark.triangle")
                                .font(Typeface.caption).foregroundStyle(.red)
                        }
                    }
                }
                if let tree = job.worktree, !result.files.isEmpty {
                    CopyButton(title: "Copy diff command", text: "git diff \(tree.base.prefix(8))..\(tree.branch)")
                }
            }
        }
        if let evidence = job.evidence, !evidence.isEmpty {
            detailSection("Evidence", symbol: "photo.on.rectangle") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 12, alignment: .top)], alignment: .leading, spacing: 12) {
                    // Newest turn first, as on the web board.
                    ForEach(evidence.sorted { $0.turn > $1.turn }, id: \.file) { item in EvidenceTile(item: item) }
                }
            }
        }
        if let rounds = job.rounds, !rounds.isEmpty {
            detailSection("Rounds", symbol: "arrow.counterclockwise") {
                ForEach(rounds.sorted { $0.turn < $1.turn }, id: \.turn) { round in
                    let key = job.roundActionKey(round.turn)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Turn \(round.turn)").font(Typeface.calloutStrong)
                            Label(round.state == "undone" ? "Undone" : "Kept", systemImage: round.state == "undone" ? "arrow.uturn.backward" : "checkmark")
                                .font(Typeface.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button(round.state == "undone" ? "Keep" : "Undo") {
                                Task { await store.setRound(job, turn: round.turn, undo: round.state != "undone") }
                            }
                            .disabled(!store.connected || job.roundUnavailableReason != nil || store.actions[key]?.locked == true)
                            .help(job.roundUnavailableReason ?? (!store.connected ? "Connect to Crew to change rounds." : "Change this round on the job branch."))
                        }
                        Text(round.stat.isEmpty ? "No files changed" : round.stat).font(Typeface.code).textSelection(.enabled)
                        ActionMessage(state: store.actions[key])
                    }
                }
            }
        }
        let refusals = (job.refusals ?? []).filter { $0.turn == job.turns }
        if !refusals.isEmpty {
            detailSection("Automatic review", symbol: "exclamationmark.shield") {
                ForEach(Array(refusals.enumerated()), id: \.offset) { _, refusal in
                    Text("\(refusal.action) — \(refusal.reason)").font(Typeface.callout).foregroundStyle(.red).textSelection(.enabled)
                }
                if job.retrying != nil { Text("Sent back once with your approval.").font(Typeface.callout).foregroundStyle(.secondary) }
            }
        }
        if !job.notes.isEmpty {
            detailSection("Notes", symbol: "note.text") {
                ForEach(Array(job.notes.enumerated()), id: \.offset) { _, note in Text(note).font(Typeface.callout).textSelection(.enabled) }
            }
        }
        if !job.report.isEmpty {
            detailSection("Report", symbol: "doc.text") {
                ReportText(report: job.report)
            }
        }
        if job.sessionId != nil && job.state != "waiting" {
            detailSection(job.isActive ? "Steer" : "Follow up", symbol: "bubble.left") {
                let key = "followup:\(job.id)"
                MessageEditor(title: "Message to \(agentName(job.agent))", text: Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 }))
                Button("Send message", systemImage: "arrow.up") { Task { await store.followUp(job) } }
                    .buttonStyle(.glassProminent)
                    .disabled(!store.connected || store.actions[key]?.locked == true || (store.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ActionMessage(state: store.actions[key])
            }
        }
        if let prompt = job.prompt, !prompt.isEmpty {
            OriginalTask(prompt: prompt)
        }
        let combined = mergeEvents(events, store.events.filter { $0.job_id == id }, limit: 80)
        if !combined.isEmpty {
            detailSection("Activity", symbol: "bolt") { EventList(events: combined) }
        }
        VStack(alignment: .leading, spacing: 10) {
            Divider().padding(.bottom, 4)
            HStack(spacing: 8) {
                if let session = job.sessionId, let worker = store.state.agents[job.agent] {
                    CopyButton(title: "Copy resume command", text: "\(worker.resume) \(session)")
                }
                Spacer(minLength: 0)
                if job.isActive {
                    Button("Cancel Job", systemImage: "stop.circle", role: .destructive) { Task { await store.cancel(job) } }
                        .disabled(!store.connected || store.actions["cancel:\(id):\(job.turns)"]?.locked == true)
                }
            }.font(Typeface.callout)
            ActionMessage(state: store.actions["cancel:\(id):\(job.turns)"])
            Text(job.id).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
        }
    }
    private func fact(_ title: String, _ value: String) -> some View {
        GridRow(alignment: .top) {
            Text(title).foregroundStyle(.secondary).frame(minWidth: 72, alignment: .leading)
            Text(value).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    /// A titled section whose contents sit in a gray inset, as a mission card's rows do, so sections read apart.
    private func detailSection<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol).font(Typeface.subheadline)
            VStack(alignment: .leading, spacing: 12) { content() }.inset()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The task as the worker received it: three lines at first, the last fading out, and the whole of it from a click
/// anywhere on its title row.
private struct OriginalTask: View {
    let prompt: String
    @State private var shown = false
    @State private var height: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// One line of `Typeface.callout`.
    private static let line: CGFloat = {
        let font = NSFont.systemFont(ofSize: 13)
        return ceil(font.ascender - font.descender + font.leading)
    }()
    private var preview: CGFloat { Self.line * 3 }
    private var long: Bool { height > preview + 1 }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { shown.toggle() } } label: {
                HStack {
                    Label("Original task", systemImage: "text.alignleft").font(Typeface.subheadline)
                    Spacer()
                    if long {
                        Text(shown ? "Show less" : "Show all").font(Typeface.caption).foregroundStyle(.secondary)
                        Image(systemName: "chevron.down").font(Typeface.captionStrong).foregroundStyle(.secondary)
                            .rotationEffect(.degrees(shown ? 180 : 0))
                    }
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!long)
            .accessibilityLabel(shown ? "Collapse original task" : "Expand original task")
            // Cut by height rather than a line limit, so the last line fades instead of ending in an ellipsis.
            Text(prompt).font(Typeface.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
                .frame(maxWidth: .infinity, maxHeight: shown || !long ? nil : preview, alignment: .topLeading)
                .clipped()
                .mask {
                    if long && !shown {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 2 / 3),
                                               .init(color: .black.opacity(0.1), location: 1)],
                                       startPoint: .top, endPoint: .bottom)
                    } else {
                        Color.black
                    }
                }
                .inset()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

private extension View {
    func inset() -> some View {
        padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
    }
}

/// A worker's report, with its Markdown headings shown as headings and inline styles applied; the rest stays as written.
private struct ReportText: View {
    let report: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                if block.heading {
                    Text(block.text).font(Typeface.bodyStrong).padding(.top, index == 0 ? 0 : 8)
                } else {
                    Text(Self.inline(block.text)).font(Typeface.body)
                }
            }
        }.textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    /// Headings on their own; the lines between them kept together as written.
    private var blocks: [(heading: Bool, text: String)] {
        var result: [(heading: Bool, text: String)] = []
        var body: [Substring] = []
        func flush() {
            let text = body.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !text.isEmpty { result.append((false, text)) }
            body = []
        }
        for line in report.split(separator: "\n", omittingEmptySubsequences: false) {
            if let match = line.firstMatch(of: /^#{1,6}\s+(.+)$/) {
                flush()
                result.append((true, String(match.1)))
            } else {
                body.append(line)
            }
        }
        flush()
        return result
    }
    private static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Opens in the default viewer on click; a recording shows its name, since a still frame would need decoding it.
private struct EvidenceTile: View {
    let item: Evidence
    @State private var thumbnail: NSImage?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.quaternary.opacity(0.5))
                    if let thumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFit().padding(1)
                    } else {
                        Image(systemName: item.isVideo ? "play.rectangle" : "photo").font(.title2).foregroundStyle(.secondary)
                    }
                }
                .aspectRatio(4 / 3, contentMode: .fit)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .help(item.path)
            Text("\(item.from == "lead" ? "Attached by the lead" : "Turn \(item.turn)") · \(item.file)")
                .font(Typeface.caption).foregroundStyle(.secondary).textSelection(.enabled)
        }
        // Decoded once per version, off the main thread and at tile size, not on every refresh of a live job.
        .task(id: "\(item.path)|\(item.modified)") {
            guard !item.isVideo else { return }
            let path = item.path
            thumbnail = await Task.detached { Self.thumbnail(path) }.value
        }
    }
    private nonisolated static func thumbnail(_ path: String) -> NSImage? {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: 600,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary)
        else { return nil }
        return NSImage(cgImage: image, size: .zero)
    }
}
