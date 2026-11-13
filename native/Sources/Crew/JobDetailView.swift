import SwiftUI

struct JobDetailView: View {
    @Bindable var store: CrewStore
    let id: String
    @State private var detail: Job?
    @State private var events: [CrewEvent] = []
    @State private var error = ""
    @State private var retry = 0
    @FocusState private var closeFocused: Bool
    private var job: Job? {
        guard var current = store.state.jobs.first(where: { $0.id == id }) else { return detail }
        current.prompt = detail?.prompt ?? current.prompt
        return current
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if let job { StatusLabel(state: job.stalled ? "stalled" : job.state, title: job.status) }
                Spacer()
                Button("Close Details", systemImage: "xmark") { store.selectedJob = nil }
                    .buttonStyle(.borderless).labelStyle(.iconOnly).help("Close details (Esc)").keyboardShortcut(.cancelAction)
                    .focused($closeFocused)
            }.padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    if !error.isEmpty {
                        Text(error).foregroundStyle(.red).textSelection(.enabled)
                        Button("Retry") { retry += 1 }
                    }
                    if job == nil && error.isEmpty { ProgressView("Loading details…") }
                    if let job { contents(job) }
                }.padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 24).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onExitCommand { store.selectedJob = nil }
        .onAppear { closeFocused = true }
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
        VStack(alignment: .leading, spacing: 8) {
            Text(job.title).font(Typeface.title).lineSpacing(2).textSelection(.enabled)
            if job.isActive { Text(job.phase).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled) }
            if let failure = job.error { Text(failure.message).font(Typeface.callout).foregroundStyle(.red).textSelection(.enabled) }
        }
        if job.state == "waiting" {
            AnswerView(store: store, job: job)
                .card(fill: .orange.opacity(0.06))
        }
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            fact("Agent", [agentName(job.agent), job.model, job.effort.map { "\($0) effort" }].compactMap { $0 }.joined(separator: " · "))
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
        }.font(Typeface.callout).textSelection(.enabled)
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
                Text(job.report).font(Typeface.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
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
            DisclosureGroup("Original task") { Text(prompt).font(Typeface.callout).textSelection(.enabled).padding(.top, 8) }
        }
        let combined = mergeEvents(events, store.events.filter { $0.job_id == id }, limit: 80)
        if !combined.isEmpty {
            detailSection("Activity", symbol: "bolt") { EventList(events: combined) { store.openJob($0) } }
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
    private func detailSection<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().padding(.bottom, 4)
            Label(title, systemImage: symbol).font(Typeface.subheadline)
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
