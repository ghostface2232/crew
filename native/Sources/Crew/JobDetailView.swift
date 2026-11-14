import SwiftUI

struct JobDetailView: View {
    @Bindable var store: CrewStore
    let id: String
    @State private var detail: Job?
    @State private var events: [CrewEvent] = []
    @State private var error = ""
    @State private var retry = 0
    @State private var scrolled = false
    private var job: Job? {
        guard var current = store.state.jobs.first(where: { $0.id == id }) else { return detail }
        current.prompt = detail?.prompt ?? current.prompt
        return current
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WorkspaceStyle.sectionGap) {
                if !error.isEmpty {
                    Text(error).foregroundStyle(Palette.danger).textSelection(.enabled)
                    Button("Retry") { retry += 1 }.pillButton()
                }
                if job == nil && error.isEmpty { ProgressView("Loading details…") }
                if let job { contents(job) }
            }.padding(.horizontal, WorkspaceStyle.panelPadding).padding(.top, Space.m).padding(.bottom, WorkspaceStyle.panelPadding).frame(maxWidth: .infinity, alignment: .leading)
                .background(OverlayScrollers())
        }
        // The header stays while the details scroll under it. As a scroll view's bar, it gets the system's
        // soft edge effect: the content fades and blurs progressively beneath it instead of being cut off.
        .safeAreaBar(edge: .top) {
            DetailHeader(title: job?.title, subtitle: job?.isActive == true ? job?.phase : nil, scrolled: scrolled, close: store.closeDetail) {
                if let job { StatusLabel(state: job.stalled ? "stalled" : job.state, title: job.status) }
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 1 } action: { _, now in scrolled = now }
        .onExitCommand { store.closeDetail() }
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
    @ViewBuilder private func contents(_ job: Job) -> some View {
        if let failure = job.error { Text(failure.message).font(Typeface.callout).foregroundStyle(Palette.danger).textSelection(.enabled) }
        if job.state == "waiting" {
            AnswerView(store: store, job: job)
                .card(fill: Palette.attention(Palette.warning))
        }
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            // The model the session reported, else the configured one.
            fact("Agent", [agentName(job.agent), job.resolvedModel ?? job.model, (job.resolvedEffort ?? job.effort).map { "\($0) effort" }, job.tier.map { "\($0) tier" }].compactMap { $0 }.joined(separator: " · "))
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
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text(file).font(Typeface.code).textSelection(.enabled)
                        if result.outOfScope.contains(file) {
                            Label(result.files.contains(file) ? "Outside the allowed targets" : "Outside the workspace", systemImage: "exclamationmark.triangle")
                                .font(Typeface.caption).foregroundStyle(Palette.danger)
                        }
                    }
                }
                // A section's own action ends it at the trailing edge; an item's sits on the item's header row.
                if let tree = job.worktree, !result.files.isEmpty {
                    HStack { Spacer(minLength: 0); CopyButton(title: "Copy diff command", text: "git diff \(tree.base.prefix(8))..\(tree.branch)") }
                }
            }
        }
        if job.hasVerification {
            detailSection("Verification", symbol: "checkmark.shield") { VerificationView(job: job) }
        }
        if let evidence = job.evidence, !evidence.isEmpty {
            detailSection("Evidence", symbol: "photo.on.rectangle") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: Space.l, alignment: .top)], alignment: .leading, spacing: Space.l) {
                    // Newest turn first, as on the web board.
                    ForEach(evidence.sorted { $0.turn > $1.turn }, id: \.file) { item in EvidenceTile(item: item) }
                }
            }
        }
        if let rounds = job.rounds, !rounds.isEmpty {
            detailSection("Rounds", symbol: "arrow.counterclockwise") {
                ForEach(rounds.sorted { $0.turn < $1.turn }, id: \.turn) { round in
                    let key = job.roundActionKey(round.turn)
                    VStack(alignment: .leading, spacing: Space.m) {
                        HStack {
                            Text("Turn \(round.turn)").font(Typeface.calloutStrong)
                            Label(round.state == "undone" ? "Undone" : "Kept", systemImage: round.state == "undone" ? "arrow.uturn.backward" : "checkmark")
                                .font(Typeface.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button(round.state == "undone" ? "Keep" : "Undo") {
                                Task { await store.setRound(job, turn: round.turn, undo: round.state != "undone") }
                            }
                            .pillButton()
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
                    Text("\(refusal.action) — \(refusal.reason)").font(Typeface.callout).foregroundStyle(Palette.danger).textSelection(.enabled)
                }
                if job.retrying != nil { Text("Sent back once with your approval.").font(Typeface.callout).foregroundStyle(.secondary) }
            }
        }
        if !job.notes.isEmpty {
            detailSection("Notes", symbol: "note.text") {
                ForEach(Array(job.notes.enumerated()), id: \.offset) { _, note in Text(noteText(note)).font(Typeface.callout).textSelection(.enabled) }
            }
        }
        if job.hasConversation, let exchange = job.exchange {
            detailSection(job.debate != nil ? "Debate" : "Conversation", symbol: "bubble.left.and.bubble.right") {
                DebateView(job: job, rounds: job.debate?.rounds, entries: exchange)
            }
        } else if !job.report.isEmpty {
            detailSection("Report", symbol: "doc.text") {
                ReportText(report: job.report)
            }
        }
        if job.debateConcluded {
            Label("This debate has used all its rounds. Decide from it, or start a new debate.", systemImage: "checkmark.bubble")
                .font(Typeface.callout).foregroundStyle(.secondary).inset()
        } else if job.sessionId != nil && job.state != "waiting" {
            detailSection(job.isActive ? "Steer" : job.debate != nil ? "Reply" : "Follow up", symbol: "bubble.left") {
                let key = "followup:\(job.id)"
                MessageEditor(title: "Message to \(agentName(job.agent))", text: Binding(get: { store.drafts[key] ?? "" }, set: { store.drafts[key] = $0 }))
                HStack {
                    Spacer(minLength: 0)
                    Button("Send message", systemImage: "arrow.up") { Task { await store.followUp(job) } }
                        .glassPillButton()
                        .disabled(!store.connected || store.actions[key]?.locked == true || (store.drafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
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
        VStack(alignment: .leading, spacing: Space.ml) {
            Divider().padding(.bottom, Space.xs)
            HStack(spacing: Space.m) {
                Spacer(minLength: 0)
                if let session = job.sessionId, let worker = store.state.agents[job.agent] {
                    CopyButton(title: "Copy resume command", text: "\(worker.resume) \(session)")
                }
                if job.isActive {
                    Button("Cancel Job", systemImage: "stop.circle", role: .destructive) { Task { await store.cancel(job) } }.pillButton()
                        .disabled(!store.connected || store.actions["cancel:\(id):\(job.turns)"]?.locked == true)
                }
            }.font(Typeface.callout)
            ActionMessage(state: store.actions["cancel:\(id):\(job.turns)"])
            Text(job.id).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
        }
    }
}

/// The start of a note and how much was left out. A job's notes once held whole command output, and SwiftUI
/// draws nothing for text that tall, leaving an empty box.
private func noteText(_ text: String, limit: Int = 2_000) -> String {
    guard text.count > limit else { return text }
    let rest = text.dropFirst(limit).split(separator: "\n", omittingEmptySubsequences: false).count
    return text.prefix(limit) + "… and \(rest) more line(s)"
}

@MainActor private func fact(_ title: String, _ value: String) -> some View {
    GridRow(alignment: .top) {
        Text(title).foregroundStyle(.secondary).frame(minWidth: 72, alignment: .leading)
        Text(value).frame(maxWidth: .infinity, alignment: .leading)
    }
}
/// A titled section whose contents sit in a gray inset, as a mission card's rows do, so sections read apart.
@MainActor private func detailSection<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: Space.ml) {
        Label(title, systemImage: symbol).font(Typeface.subheadline).padding(.leading, WorkspaceStyle.rowTitleInset)
        VStack(alignment: .leading, spacing: Space.l) { content() }.inset()
    }.frame(maxWidth: .infinity, alignment: .leading)
}

/// The panel's pinned top: status and close button, then the title.
private struct DetailHeader<Status: View>: View {
    let title: String?
    /// What the work is doing now, read with the title rather than as the first section.
    var subtitle: String? = nil
    /// Whether details have scrolled under the header; at the top there is nothing for its veil to cover.
    var scrolled = false
    let close: () -> Void
    @ViewBuilder var status: Status
    /// VoiceOver moves to the title when the panel opens; keyboard focus stays where it was.
    @AccessibilityFocusState private var titleFocused: Bool
    /// How far below the header its background fades out.
    private static var fade: CGFloat { Space.x6l }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            HStack {
                status
                Spacer()
                Button("Close Details", systemImage: "xmark", action: close)
                    .iconButton().help("Close details (Esc)").keyboardShortcut(.cancelAction)
            }
            // Two lines at most, so a long title cannot take over the panel. Selectable text drops its
            // truncation once selected, so the full title is copied from a menu instead.
            if let title {
                Text(title).font(Typeface.title).lineSpacing(2).lineLimit(2).help(title)
                    .accessibilityAddTraits(.isHeader).accessibilityFocused($titleFocused)
                    .contextMenu {
                        Button("Copy Title", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(title, forType: .string)
                        }
                    }
                    // Tighter than the status row above, so the two read as one heading.
                    .padding(.bottom, subtitle?.isEmpty == false ? -Space.m : 0)
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle).font(Typeface.callout).foregroundStyle(.secondary).lineLimit(2).help(subtitle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, WorkspaceStyle.panelPadding).padding(.top, Space.xxl).padding(.bottom, Space.l)
        // Scrolled details show through gradually: solid at the panel's top edge, then a veil of the panel color
        // over a blur that both thin out past the header, so the heading stays legible without a hard band.
        .background(alignment: .top) {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55),
                                                 .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
                LinearGradient(stops: [.init(color: WorkspaceStyle.surface, location: 0),
                                       .init(color: WorkspaceStyle.surface.opacity(0.9), location: 0.35),
                                       .init(color: WorkspaceStyle.surface.opacity(0.6), location: 0.65),
                                       .init(color: WorkspaceStyle.surface.opacity(0), location: 1)],
                               startPoint: .top, endPoint: .bottom)
            }
            .padding(.bottom, -Self.fade)
            .opacity(scrolled ? 1 : 0)
            .animation(.easeOut(duration: 0.25), value: scrolled)
            .allowsHitTesting(false)
        }
        .onAppear { titleFocused = true }
    }
}

/// A Claude session in the detail panel. Crew sees only what Claude's hooks report, so this shows its state,
/// what it waits for, where it runs and the missions it leads; the conversation itself stays in Claude.
struct SessionDetailView: View {
    @Bindable var store: CrewStore
    let id: String
    @State private var scrolled = false
    private var session: ClaudeSession? { store.state.claude.first { $0.id == id } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WorkspaceStyle.sectionGap) {
                if let session { contents(session) } else { Text("This session has ended.").foregroundStyle(.secondary) }
            }.padding(.horizontal, WorkspaceStyle.panelPadding).padding(.top, Space.m).padding(.bottom, WorkspaceStyle.panelPadding).frame(maxWidth: .infinity, alignment: .leading)
                .background(OverlayScrollers())
        }
        .safeAreaBar(edge: .top) {
            DetailHeader(title: session?.title, subtitle: session.flatMap { $0.state == "working" ? $0.phase : nil }, scrolled: scrolled, close: store.closeDetail) {
                if let session {
                    StatusLabel(state: session.stalled ? "stalled" : session.state, title: session.stalled ? "May be stuck" : session.state.capitalized)
                }
            }
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.y + $0.contentInsets.top > 1 } action: { _, now in scrolled = now }
        .onExitCommand { store.closeDetail() }
    }
    @ViewBuilder private func contents(_ session: ClaudeSession) -> some View {
        if session.state == "waiting" {
            VStack(alignment: .leading, spacing: Space.m) {
                Text(session.waitingFor ?? "Claude needs your input.").font(Typeface.body).textSelection(.enabled)
                Text("Answer in Claude.").font(Typeface.callout).foregroundStyle(.secondary)
            }.card(fill: Palette.attention(Palette.warning))
        }
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            fact("Agent", "Claude · Lead")
            fact("Project", session.projectPath)
            if session.cwd != session.projectPath { fact("Directory", session.cwd) }
            fact("Started", "\(elapsed(store.now - session.startedAt)) ago")
            fact("Last active", "\(elapsed(store.now - session.activeAt)) ago")
            if session.inTool { fact("Now", "Running a tool") }
        }.font(Typeface.callout).textSelection(.enabled).inset()
        let missions = store.state.missions.filter { $0.owner == session.id }.sorted { $0.createdAt > $1.createdAt }
        if !missions.isEmpty {
            detailSection("Missions", symbol: "flag") {
                ForEach(missions) { mission in
                    HStack(spacing: Space.ml) {
                        Text(mission.title).font(Typeface.callout).lineLimit(2)
                        Spacer(minLength: 8)
                        StatusLabel(state: mission.state == "active" ? "running" : mission.state, title: mission.state.capitalized)
                    }
                }
            }
        }
        VStack(alignment: .leading, spacing: Space.ml) {
            Divider().padding(.bottom, Space.xs)
            HStack { Spacer(minLength: 0); CopyButton(title: "Copy resume command", text: "claude --resume \(session.id)") }
            Text(session.id).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
        }
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
        let font = NSFont.systemFont(ofSize: Typeface.calloutSize)
        return ceil(font.ascender - font.descender + font.leading)
    }()
    private var preview: CGFloat { Self.line * 3 }
    private var long: Bool { height > preview + 1 }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.ml) {
            Label("Original task", systemImage: "text.alignleft").font(Typeface.subheadline).padding(.leading, WorkspaceStyle.rowTitleInset)
            VStack(alignment: .leading, spacing: Space.xs) {
                // Cut by height rather than a line limit, so the last line fades instead of ending in an ellipsis.
                // Folded, a click anywhere on it opens it; open, the text is selectable instead.
                Group {
                    if shown || !long { Text(prompt).textSelection(.enabled) } else { Text(prompt) }
                }
                    .font(Typeface.callout).fixedSize(horizontal: false, vertical: true)
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
                    .contentShape(Rectangle())
                    .onTapGesture { if long && !shown { toggle() } }
                if long { RevealToggle(shown: $shown) }
            }
            .inset()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func toggle() { withAnimation(reduceMotion ? nil : .smooth(duration: 0.3)) { shown.toggle() } }
}

/// A worker's report, with its Markdown headings shown as headings, code blocks in the code face and inline styles
/// applied. One text, so the whole report still selects and copies at once.
struct ReportText: View {
    let report: String
    var body: some View {
        Text(Self.render(report)).font(Typeface.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    nonisolated static func render(_ report: String) -> AttributedString {
        enum Kind { case heading, code, prose }
        var blocks: [(kind: Kind, text: String)] = []
        var lines: [Substring] = []
        var fenced = false
        func flush(_ kind: Kind) {
            let text = lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !text.isEmpty { blocks.append((kind, text)) }
            lines = []
        }
        // `\.isNewline` also takes "\r\n", which is a single Character.
        for line in report.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            let trimmed = line.drop { $0 == " " }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                // The fence lines themselves are left out; the block's face shows what it is.
                flush(fenced ? .code : .prose)
                fenced.toggle()
            } else if !fenced, let match = line.firstMatch(of: /^#{1,6}\s+(.*?)[\s#]*$/), !match.1.isEmpty {
                flush(.prose)
                blocks.append((.heading, String(match.1)))
            } else {
                lines.append(line)
            }
        }
        flush(fenced ? .code : .prose)
        var result = AttributedString()
        for (index, block) in blocks.enumerated() {
            if index > 0 { result += AttributedString("\n\n") }
            switch block.kind {
            case .heading:
                var heading = AttributedString(block.text)
                heading.font = Typeface.bodyStrong
                result += heading
            case .code:
                var code = AttributedString(block.text)
                code.font = Typeface.code
                result += code
            case .prose:
                result += (try? AttributedString(markdown: block.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(block.text)
            }
        }
        return result
    }
}

/// Opens in the default viewer on click; a recording shows its name, since a still frame would need decoding it.
/// What verified the result: the latest check the bridge itself ran (or what a review read), what the worker's
/// runtime could do, and approvals the lead relayed. Decision support, so the status reads first and detail folds.
private struct VerificationView: View {
    let job: Job
    @State private var outputShown = false

    var body: some View {
        if let receipt = job.latestReceipt {
            VStack(alignment: .leading, spacing: Space.s) {
                if let check = receipt.check {
                    checkStatus(check, stale: receipt.stale != nil)
                    Text(check.command).font(Typeface.code).textSelection(.enabled)
                    Text(caption(receipt, extra: check.skipped == nil ? duration(check.ms) : nil)).font(Typeface.caption).foregroundStyle(.secondary)
                    if check.skipped == nil && check.exit != 0 && !check.output.isEmpty {
                        RevealToggle(show: "Show the end of the output", hide: "Hide the output", shown: $outputShown)
                        if outputShown {
                            Text(check.output.split(separator: "\n", omittingEmptySubsequences: false).suffix(15).joined(separator: "\n"))
                                .font(Typeface.codeSmall).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else if let reviewed = receipt.reviewed {
                    Label("Reviewed", systemImage: "eye").font(Typeface.calloutStrong)
                        .foregroundStyle(receipt.stale == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    Text(reviewed.target).font(Typeface.callout).textSelection(.enabled)
                    Text(caption(receipt, extra: reviewed.diff.map { "diff \($0)" })).font(Typeface.caption).foregroundStyle(.secondary)
                }
                if let stale = receipt.stale {
                    Label("No longer current: \(stale)", systemImage: "clock.arrow.circlepath")
                        .font(Typeface.caption).foregroundStyle(Palette.warning)
                }
            }
        }
        if let capabilities = job.capabilities {
            Grid(alignment: .leading) { fact("Runs with", runsWith(capabilities)) }.font(Typeface.callout).textSelection(.enabled)
        }
        ForEach(Array((job.approvals ?? []).enumerated()), id: \.offset) { _, approval in
            VStack(alignment: .leading, spacing: Space.xs) {
                Label("Approval relayed for turn \(approval.turn)", systemImage: approval.recorded > 0 ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.questionmark")
                    .font(Typeface.calloutStrong)
                Text(approvalBasis(approval)).font(Typeface.caption).foregroundStyle(.secondary)
                Text("\u{201C}\(approval.quote)\u{201D}").font(Typeface.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private func checkStatus(_ check: CheckResult, stale: Bool) -> some View {
        let (title, symbol, color): (String, String, Color) =
            check.skipped != nil ? ("Check not run", "minus.circle", .secondary)
            : check.timedOut ? ("Check timed out after \(duration(check.ms))", "clock.badge.exclamationmark", Palette.warning)
            : check.exit == 0 ? ("Check passed", "checkmark.circle.fill", Palette.success)
            : check.exit == nil ? ("Check stopped before it finished", "xmark.octagon.fill", Palette.danger)
            : ("Check failed with exit code \(check.exit!)", "xmark.octagon.fill", Palette.danger)
        // A stale result keeps its words but loses its color: it describes a tree that is gone.
        Label(title, systemImage: symbol).font(Typeface.calloutStrong).foregroundStyle(stale ? .secondary : color)
        if let skipped = check.skipped { Text(skipped.prefix(1).uppercased() + skipped.dropFirst() + ".").font(Typeface.caption).foregroundStyle(.secondary) }
    }

    private func caption(_ receipt: TurnReceipt, extra: String?) -> String {
        ["Turn \(receipt.turn)", receipt.head.map { String($0.prefix(8)) }, extra].compactMap { $0 }.joined(separator: " · ")
    }

    private func duration(_ ms: Double) -> String {
        ms < 60_000 ? "\(max(1, Int((ms / 1000).rounded())))s" : "\(Int(ms / 60_000))m \(Int(ms.truncatingRemainder(dividingBy: 60_000) / 1000))s"
    }

    private func runsWith(_ c: Capabilities) -> String {
        let network = ["on": "network on", "off": "no network", "agent-managed": "network as the agent allows"][c.network] ?? "network \(c.network)"
        return ([c.filesystem, network] + (c.plugins.isEmpty ? [] : ["plugins \(c.plugins.joined(separator: ", ")) (act outside the sandbox)"])).joined(separator: " · ")
    }

    private func approvalBasis(_ approval: RelayedApproval) -> String {
        guard approval.recorded > 0 else { return "No messages of the user were recorded, so only the lead\u{2019}s quote went with it." }
        return "The user\u{2019}s own words went with it" + (approval.matched ? ", and the quote matches them." : "; the quote is a translation or paraphrase.")
    }
}

/// A conversation by turn: each pairs the lead's message with the reply, whose numbered points read as
/// stance-marked headlines with the full text one disclosure away. A debate adds a stepper over its rounds.
/// Turns recorded before conversations were kept are left out rather than shown empty.
private struct DebateView: View {
    let job: Job
    /// The debate's round limit; nil for a job the lead followed up.
    let rounds: Int?
    let entries: [ExchangeEntry]

    private var replied: Int { entries.filter { $0.from == "worker" }.map(\.turn).max() ?? 0 }

    var body: some View {
        if let rounds {
            DebateStepper(rounds: rounds, replied: replied, current: min(job.turns, rounds), working: job.isActive, concluded: job.debateConcluded)
        }
        let turns = Array(Set(entries.map(\.turn))).sorted()
        // A job that began before the bridge kept its conversation has its first turns missing; say so rather than
        // start the story partway through.
        if let first = turns.first, first > 1 {
            let label = rounds == nil ? "Turn" : "Round"
            Text(first == 2 ? "\(label) 1 was not recorded." : "\(label)s 1–\(first - 1) were not recorded.")
                .font(Typeface.caption).foregroundStyle(.secondary)
        }
        ForEach(turns, id: \.self) { turn in
            let lead = entries.last { $0.turn == turn && $0.from == "lead" }
            let reply = entries.last { $0.turn == turn && $0.from == "worker" }
            DebateRound(turn: turn, label: rounds == nil ? "Turn" : "Round", final: turn == rounds, last: turn == turns.last,
                        lead: lead, reply: reply, worker: agentName(job.agent), working: job.isActive && turn == job.turns)
        }
    }
}

private struct DebateStepper: View {
    let rounds: Int
    let replied: Int
    let current: Int
    let working: Bool
    let concluded: Bool

    var body: some View {
        HStack(spacing: Space.s) {
            // Done steps take the done color and the step in progress the accent, as mission stops do.
            ForEach(1...rounds, id: \.self) { round in
                step(round <= replied ? "checkmark.circle.fill" : round == current && working ? "circle.dotted.circle" : "circle",
                     "Round \(round)", color: round <= replied ? Palette.success : round == current && working ? Palette.accent : nil)
                Rectangle().fill(WorkspaceStyle.hairline).frame(height: 1).frame(maxWidth: Space.x4l)
            }
            step(concluded ? "flag.checkered.circle.fill" : "flag.circle", "Conclusion", color: concluded ? Palette.success : nil)
        }
        .font(Typeface.caption)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(concluded ? "Debate concluded after \(rounds) rounds" : "Debate, round \(current) of \(rounds)")
    }

    private func step(_ symbol: String, _ title: String, color: Color?) -> some View {
        Label(title, systemImage: symbol).labelStyle(.titleAndIcon).lineLimit(1).fixedSize()
            .foregroundStyle(color.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
    }
}

private struct DebateRound: View {
    let turn: Int
    let label: String
    let final: Bool
    let last: Bool
    let lead: ExchangeEntry?
    let reply: ExchangeEntry?
    let worker: String
    let working: Bool
    @State private var leadShown = false
    @State private var replyShown = false
    /// Earlier rounds start folded to their heading and stances; the latest starts open.
    @State private var open: Bool?

    var body: some View {
        let points = reply.map { debatePoints($0.text) } ?? []
        let opened = Binding(get: { open ?? last }, set: { open = $0 })
        VStack(alignment: .leading, spacing: Space.ml) {
            HStack(spacing: Space.m) {
                Text(final ? "\(label) \(turn) · final" : "\(label) \(turn)").font(Typeface.calloutStrong)
                Spacer(minLength: 0)
                ForEach([DebatePoint.Stance.agree, .disagree, .alternative], id: \.self) { stance in
                    let count = points.filter { $0.stance == stance }.count
                    if count > 0 { StanceChip(stance: stance, count: count) }
                }
            }
            if !last { RevealToggle(show: "Show this \(label.lowercased())", hide: "Hide this \(label.lowercased())", shown: opened) }
            if opened.wrappedValue { exchange(points) }
        }
        if !last { Divider().padding(.vertical, Space.xs) }
    }

    @ViewBuilder private func exchange(_ points: [DebatePoint]) -> some View {
        if let lead {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Lead").font(Typeface.captionStrong).foregroundStyle(Palette.accent)
                ReportText(report: lead.text).lineLimit(leadShown ? nil : 4)
                if lead.text.split(separator: "\n").count > 4 || lead.text.count > 400 {
                    RevealToggle(shown: $leadShown)
                }
            }
            .padding(.leading, Space.l)
            // A 2-point edge, the width of a focus ring's stroke, marks the lead's voice without a second fill.
            .overlay(alignment: .leading) { Rectangle().fill(Palette.accent).frame(width: 2) }
        }
        if let reply {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(worker).font(Typeface.captionStrong).foregroundStyle(.secondary)
                if points.isEmpty {
                    ReportText(report: reply.text).lineLimit(replyShown ? nil : 8)
                    RevealToggle(shown: $replyShown)
                } else {
                    ForEach(points, id: \.number) { point in
                        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                            StanceChip(stance: point.stance, count: nil)
                            Text(point.title).font(Typeface.callout).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    RevealToggle(show: "Show the full reply", hide: "Hide the full reply", shown: $replyShown)
                    if replyShown { ReportText(report: reply.text) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if working {
            Label("\(worker) is answering…", systemImage: "ellipsis.bubble").font(Typeface.caption).foregroundStyle(.secondary)
        }
    }
}

/// A point's stance: green agree, red disagree, accent alternative, with a count when it sums a round.
private struct StanceChip: View {
    let stance: DebatePoint.Stance
    let count: Int?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let (title, symbol, color): (String, String, Color) = switch stance {
        case .agree: ("Agree", "checkmark", Palette.success)
        case .disagree: ("Disagree", "xmark", Palette.danger)
        case .alternative: ("Alternative", "arrow.triangle.branch", Palette.accent)
        }
        let text = scheme == .light ? color.mix(with: .black, by: 0.22) : color
        Label(count.map { "\(title) \($0)" } ?? title, systemImage: symbol)
            .font(Typeface.chip).foregroundStyle(text).lineLimit(1).fixedSize()
            .padding(Chip.insets)
            .background(Palette.chip(color), in: Capsule())
            .overlay { if contrast == .increased { Capsule().strokeBorder(text.opacity(0.5)) } }
    }
}

private struct EvidenceTile: View {
    let item: Evidence
    @State private var thumbnail: NSImage?
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Button { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius, style: .continuous).fill(.quaternary.opacity(0.5))
                    if let thumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFit().padding(1)
                    } else {
                        Image(systemName: item.isVideo ? "play.rectangle" : "photo").font(Symbol.large).foregroundStyle(.secondary)
                    }
                }
                .aspectRatio(4 / 3, contentMode: .fit)
                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius, style: .continuous).strokeBorder(.separator))
                .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius, style: .continuous))
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
