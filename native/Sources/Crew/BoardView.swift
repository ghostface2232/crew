import SwiftUI

struct BoardView: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
                ScrollView {
                    // Lazy so a long history builds only the panels on screen.
                    LazyVStack(alignment: .leading, spacing: 24) {
                        if !store.connected { connectionBanner }
                        heading
                        if store.state.pendingCount > 0 && store.selection != "needs" && !store.project.isEmpty { attentionBanner }
                        if store.selection == "needs" { NeedsYouView(store: store) }
                        else if store.selection == "activity" { activity }
                        else { workspace }
                    }
                    .padding(.horizontal, 40).padding(.top, 12).padding(.bottom, 40)
                    .frame(maxWidth: 1280).frame(maxWidth: .infinity)
                }
                .safeAreaBar(edge: .top, spacing: 0) {
                    scopeAndSearch.padding(.horizontal, 40).padding(.top, 8)
                }
                .scrollEdgeEffectStyle(.soft, for: .top)
                .id(store.selection ?? "overview")
                // A crossfade layers two full pages at once; only the incoming page animates.
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .identity))
                .disabled(store.selectedJob != nil)
                .accessibilityHidden(store.selectedJob != nil)
                .overlay(alignment: .trailing) {
                if let id = store.selectedJob {
                    JobDetailView(store: store, id: id).id(id)
                        .frame(width: 420).background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius))
                        .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius))
                        .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius).strokeBorder(WorkspaceStyle.hairline))
                        .shadow(color: .black.opacity(0.14), radius: 26, x: -8, y: 8)
                        .padding(.trailing, 16).padding(.bottom, 16)
                        .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                        .zIndex(1)
                }
            }
            .animation(reduceMotion ? nil : .smooth(duration: 0.26, extraBounce: 0), value: store.selectedJob != nil)
        .toolbar { WorkspaceToolbar(store: store, openSettings: openSettings) }
        .navigationTitle(title)
        .toolbar(removing: .title)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(WorkspaceStyle.canvas.ignoresSafeArea())
        .frame(minWidth: 850, minHeight: 560)
        .onChange(of: store.selection) { store.persistSelection() }
        .onExitCommand { store.selectedJob = nil }
        .sheet(isPresented: $store.showingDispatch) { DispatchView(store: store) }
    }
    private var scopeAndSearch: some View {
HStack(spacing: 16) {
                if store.selection == "overview" || store.selection == nil || !store.project.isEmpty {
                Menu {
                    Button("All projects") { store.selection = "overview" }
                    ForEach(store.projects, id: \.self) { path in
                        Button(projectName(path, among: store.projects)) { store.selection = "project:\(path)" }
                    }
                } label: {
                    Label(store.project.isEmpty ? "All projects" : projectName(store.project, among: store.projects), systemImage: "folder")
                        .font(Typeface.calloutStrong).lineLimit(1)
                }.menuStyle(.borderlessButton).frame(maxWidth: 260, alignment: .leading).help(store.project.isEmpty ? "Filter by project" : store.project)
                }
                Spacer()
            }.padding(.bottom, 8)
    }
    private var title: String {
        if !store.project.isEmpty { return projectName(store.project, among: store.projects) }
        return ["needs": "Needs You", "activity": "Activity", "history": "History"][store.selection ?? ""] ?? "Overview"
    }
    private func matches(_ text: String) -> Bool { store.search.isEmpty || text.localizedCaseInsensitiveContains(store.search) }
    private var connectionBanner: some View {
        HStack(alignment: .top) {
            Label(store.connectionMessage, systemImage: "wifi.exclamationmark").font(Typeface.callout).textSelection(.enabled)
            Spacer()
            Button("Retry") { store.start() }
        }.padding(16).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
    }
    private var attentionBanner: some View {
        Button { store.selection = "needs"; store.search = "" } label: {
            HStack {
                Image(systemName: "bell.badge.fill").foregroundStyle(.orange)
                Text("\(store.state.pendingCount) \(store.state.pendingCount == 1 ? "request needs" : "requests need") your attention").font(Typeface.bodyStrong)
                Spacer()
                Text("Review").font(Typeface.callout)
                Image(systemName: "chevron.right").font(Typeface.captionStrong)
            }.padding(16).contentShape(Rectangle())
        }.buttonStyle(.plain).glassEffect(.regular, in: .rect(cornerRadius: WorkspaceStyle.cardRadius))
    }
    private var heading: some View {
        let overview = store.selection == "overview" || store.selection == nil
        let pending = store.state.pendingCount
        return ViewThatFits(in: .horizontal) {
            if overview || !store.project.isEmpty {
                HStack(alignment: .center, spacing: 32) {
                    headingCopy(overview: overview, pending: pending)
                        .frame(minWidth: 340, maxWidth: .infinity)
                    WorkspaceSummary(store: store).frame(minWidth: 430, maxWidth: 500)
                }
            }
            VStack(alignment: .leading, spacing: 24) {
                headingCopy(overview: overview, pending: pending)
                if overview || !store.project.isEmpty { WorkspaceSummary(store: store) }
            }
        }.padding(.top, 6).padding(.bottom, 6)
    }
    private func headingCopy(overview: Bool, pending: Int) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            WorkspaceHeading(title: title, subtitle: store.project.isEmpty ? nil : store.project)
            if overview && pending > 0 {
                Button("Review requests", systemImage: "arrow.up.right") { store.selection = "needs"; store.search = "" }
                    .buttonStyle(.glass).controlSize(.large)
            }
        }
    }
    @ViewBuilder private var workspace: some View {
        if store.selection != "history" && store.search.isEmpty { AgentOverview(store: store) }
        // Lists are derived once per body: these filters ran per mission before and dominated redraw cost.
        let history = store.selection == "history"
        let inScope = store.state.jobs.filter { store.project.isEmpty || $0.projectPath == store.project }
        let jobs = store.search.isEmpty ? inScope : inScope.filter { matches("\($0.title) \($0.phase) \($0.projectPath) \($0.agent)") }
        let matchedByMission = Dictionary(grouping: jobs.filter { $0.mission != nil }) { $0.mission! }
        let allByMission = store.search.isEmpty ? matchedByMission : Dictionary(grouping: inScope.filter { $0.mission != nil }) { $0.mission! }
        let scopedMissions = store.state.missions.filter { mission in
            (store.project.isEmpty || mission.root == store.project) && (matches(mission.title) || matchedByMission[mission.id] != nil)
        }.sorted { $0.createdAt > $1.createdAt }
        // A mission found by its title shows all of its jobs; one found through its jobs shows only the matches.
        let missionJobs: (Mission) -> [Job] = { mission in
            (store.search.isEmpty || !matches(mission.title) ? matchedByMission[mission.id] : allByMission[mission.id]) ?? []
        }
        let shownMissions = history ? scopedMissions.filter { $0.state != "active" } : scopedMissions.filter { $0.state == "active" }
        let recent = history ? [] : Array(scopedMissions.filter { $0.state != "active" }.prefix(2))
        ForEach(shownMissions) { mission in
            MissionPanel(store: store, mission: mission, jobs: missionJobs(mission))
        }
        // Jobs of a recent mission already appear inside its panel.
        let panelIDs = Set((shownMissions + recent).map(\.id))
        let loose = jobs.filter { !panelIDs.contains($0.mission ?? "") && (history ? !$0.isActive : $0.isActive) }.sorted { $0.createdAt > $1.createdAt }
        if !loose.isEmpty {
            ContentPanel(title: history ? "Completed jobs" : "Other jobs", symbol: "rectangle.stack") {
                ForEach(loose) { job in
                    JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.openJob(job.id) }
                }
            }
        }
        if !history {
            ForEach(recent) { mission in
                MissionPanel(store: store, mission: mission, jobs: missionJobs(mission))
            }
            let recentJobs = jobs.filter { !$0.isActive && $0.mission == nil }.sorted { ($0.endedAt ?? 0) > ($1.endedAt ?? 0) }.prefix(4)
            if !recentJobs.isEmpty {
                ContentPanel(title: "Recently finished", symbol: "checkmark.circle") {
                    ForEach(Array(recentJobs)) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.openJob(job.id) } }
                }
            }
            let sessions = store.state.claude.filter { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
            if !sessions.isEmpty {
                ContentPanel(title: "Claude sessions", symbol: "bubble.left.and.bubble.right") {
                    ForEach(sessions) { SessionView(session: $0) }
                }
            }
        }
        let emptyHistory = history && shownMissions.isEmpty && loose.isEmpty
        let emptyWorkspace = !history && jobs.isEmpty && scopedMissions.isEmpty && !store.state.claude.contains { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
        if emptyHistory || emptyWorkspace {
            ContentUnavailableView {
                Label(store.search.isEmpty ? (emptyHistory ? "No completed work yet" : "Ready when you are") : "No matching work", systemImage: store.search.isEmpty ? "square.stack.3d.up" : "magnifyingglass")
            } description: {
                if store.search.isEmpty && !emptyHistory { Text("Start with New Job, or /crew:run in Claude.") }
            } actions: {
                if store.search.isEmpty && !emptyHistory { Button("New Job", systemImage: "plus") { store.showingDispatch = true }.buttonStyle(.glassProminent).disabled(!store.connected) }
            }.padding(.vertical, 30).frame(maxWidth: .infinity)
        }
    }
    private var activity: some View {
        // The page heading already names this list.
        ContentPanel(title: nil) {
            let events = store.events.filter { matches("\($0.detail) \($0.agent)") }
            if events.isEmpty { Text("No activity yet.").foregroundStyle(.secondary) }
            EventList(events: events) { store.openJob($0) }
        }
    }
}

struct AgentOverview: View {
    var store: CrewStore
    var compact = false
    private var agents: [String] { ["claude"] + ["codex", "antigravity"].filter { store.state.agents[$0] != nil } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Agents").font(Typeface.section).tracking(-0.5)
            if compact { compactAgents }
            else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(agents, id: \.self) { agent in AgentCard(store: store, agent: agent).frame(minWidth: 205) }
                    }
                    compactAgents
                }
            }
        }
    }
    private var compactAgents: some View {
        VStack(spacing: 0) {
            ForEach(agents, id: \.self) { agent in
                HStack(spacing: 10) {
                    AgentMark(agent: agent, size: 18)
                    Text(agentName(agent)).font(Typeface.calloutStrong)
                    Spacer()
                    let jobs = store.state.jobs.filter { $0.agent == agent && $0.isActive && (store.project.isEmpty || $0.projectPath == store.project) }
                    let sessions = store.state.claude.filter { $0.state != "idle" && (store.project.isEmpty || $0.projectPath == store.project) }
                    let count = agent == "claude" ? sessions.count : jobs.count
                    let waiting = agent == "claude" ? sessions.contains { $0.state == "waiting" } : jobs.contains { $0.state == "waiting" }
                    let stalled = agent == "claude" ? sessions.contains { $0.stalled } : jobs.contains { $0.stalled }
                    let mark = waiting ? "waiting" : stalled ? "stalled" : count > 0 ? "working" : "idle"
                    if count > 0 { Text("\(count) active").font(Typeface.caption).foregroundStyle(.secondary) }
                    StatusLabel(state: mark, title: waiting ? "Needs you" : stalled ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : count > 0 ? "Working" : "Ready")
                }.padding(.horizontal, WorkspaceStyle.cardPadding).padding(.vertical, 11)
                if agent != agents.last { Divider().padding(.leading, WorkspaceStyle.cardPadding + 28) }
            }
        }.card(padding: 0)
    }
}

private struct AgentCard: View {
    var store: CrewStore
    var agent: String
    private var jobs: [Job] { store.state.jobs.filter { $0.agent == agent && $0.isActive && (store.project.isEmpty || $0.projectPath == store.project) } }
    private var sessions: [ClaudeSession] { store.state.claude.filter { $0.state != "idle" && (store.project.isEmpty || $0.projectPath == store.project) } }
    private var mark: String {
        if agent == "claude" { return sessions.contains { $0.state == "waiting" } ? "waiting" : sessions.contains { $0.stalled } ? "stalled" : sessions.isEmpty ? "idle" : "working" }
        return jobs.contains { $0.state == "waiting" } ? "waiting" : jobs.contains { $0.stalled } ? "stalled" : jobs.isEmpty ? "idle" : "working"
    }
    private var activity: String {
        let count = agent == "claude" ? sessions.count : jobs.count
        let noun = agent == "claude" ? "session" : "job"
        return count == 0 ? "No active \(noun)s" : "\(count) active \(noun)\(count == 1 ? "" : "s")"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                AgentMark(agent: agent, size: 22).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agentName(agent)).font(Typeface.cardTitle).tracking(-0.3)
                    Text(agent == "claude" ? "Lead" : roleOrder.filter { store.state.roles[$0]?.agent == agent }.compactMap { roleNames[$0] }.joined(separator: " · "))
                        .font(Typeface.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                StatusLabel(state: mark, title: mark == "waiting" ? "Needs you" : mark == "working" ? "Working" : mark == "stalled" ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : "Ready")
            }
            HStack {
                Text(activity).font(Typeface.callout).monospacedDigit().foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if let usage = store.limits[agent] ?? nil, let maximum = usage.windows?.map(\.usedPercent).max() {
                    Text("\(Int(maximum))% of limit").font(Typeface.caption).monospacedDigit().foregroundStyle(maximum >= 90 ? Color.orange : .secondary)
                        .help((usage.windows ?? []).map { window in
                            "\(Int(window.usedPercent))% of " + (window.minutes.map { "\(Int($0))-minute limit" } ?? "limit")
                        }.joined(separator: "\n"))
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading).card()
    }
}

struct MissionPanel: View {
    @Bindable var store: CrewStore
    let mission: Mission
    let jobs: [Job]
    @State private var expanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    init(store: CrewStore, mission: Mission, jobs: [Job]) {
        self.store = store; self.mission = mission; self.jobs = jobs
        _expanded = State(initialValue: mission.state == "active")
    }
    private var meta: String {
        let tokens = jobs.reduce(0) { $0 + ($1.tokens ?? 0) }
        return [
            tokens > 0 ? "\(tokens.formatted()) tokens" : nil,
            store.project.isEmpty ? projectName(mission.root, among: store.projects) : nil,
            "\(jobs.count) \(jobs.count == 1 ? "job" : "jobs")",
        ].compactMap { $0 }.joined(separator: " · ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(mission.title).font(Typeface.cardTitle).tracking(-0.3).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 0) {
                        ElapsedText(store: store, start: mission.createdAt, end: mission.endedAt)
                        Text(" · " + meta)
                    }.font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).help(mission.root)
                }
                Spacer(minLength: 8)
                if mission.state != "active" { StatusLabel(state: mission.state, title: mission.state.capitalized) }
                // Both controls share one 28pt hit area so their glyphs sit on the same center line.
                HStack(spacing: 2) {
                    Button { expanded.toggle() } label: {
                        Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 0 : -90)).frame(width: 28, height: 28).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(expanded ? "Collapse mission" : "Expand mission").help(expanded ? "Collapse" : "Expand")
                    if mission.state == "active" {
                        Menu {
                            Button("Dismiss mission", systemImage: "xmark.circle") { Task { await store.dismiss(mission) } }
                                .disabled(!store.connected || store.actions["dismiss:\(mission.id)"]?.locked == true)
                        } label: {
                            Image(systemName: "ellipsis").font(Typeface.subheadline).frame(width: 28, height: 28).contentShape(Rectangle())
                        }.menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize().help("Mission options")
                    }
                }.foregroundStyle(.secondary).padding(.top, -4).padding(.trailing, -6)
            }
            if expanded {
                if mission.state == "active" { MissionTrack(mission: mission).padding(.vertical, 4) }
                VStack(spacing: 4) {
                    if let lead = store.state.claude.first(where: { $0.id == mission.owner }), mission.state == "active" {
                        SessionView(session: lead).padding(.horizontal, 12).padding(.vertical, 10)
                            .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
                    }
                    ForEach(jobs) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.openJob(job.id) } }
                }
                if !mission.outcome.isEmpty { Text(mission.outcome).font(Typeface.callout).textSelection(.enabled) }
            }
            ActionMessage(state: store.actions["dismiss:\(mission.id)"])
        }.animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: expanded)
            .card()
    }
}

struct NeedsYouView: View {
    @Bindable var store: CrewStore
    private func matches(_ text: String) -> Bool { store.search.isEmpty || text.localizedCaseInsensitiveContains(store.search) }
    private var jobs: [Job] { store.state.waitingJobs.filter { matches("\($0.title) \($0.projectPath) \($0.agent) \($0.waiting?.reason ?? "")") } }
    private var sessions: [ClaudeSession] { store.state.waitingSessions.filter { matches("\($0.title) \($0.projectPath) Claude \($0.waitingFor ?? "")") } }
    var body: some View {
        if store.state.pendingCount == 0 {
            ContentUnavailableView("All caught up", systemImage: "checkmark.circle")
        } else if jobs.isEmpty && sessions.isEmpty {
            ContentUnavailableView.search(text: store.search)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 420, maximum: 620), spacing: 16)], alignment: .leading, spacing: 16) {
            ForEach(jobs) { job in
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            StatusLabel(state: "waiting", title: job.waiting?.type == "approval" ? "Approval" : "Question")
                            HStack(spacing: 5) {
                                AgentMark(agent: job.agent, size: 13)
                                Text("\(agentName(job.agent)) · \(projectName(job.projectPath, among: store.projects))").lineLimit(1)
                            }.font(Typeface.chip).foregroundStyle(.secondary).help(job.projectPath)
                            Spacer(minLength: 8)
                            Button("Details", systemImage: "arrow.up.right") { store.openJob(job.id) }
                                .buttonStyle(.borderless).font(Typeface.caption)
                        }
                        Text(job.title).font(Typeface.callout).foregroundStyle(.secondary).lineLimit(2).help(job.title)
                    }
                    AnswerView(store: store, job: job)
                }
                .frame(maxWidth: .infinity, alignment: .leading).card()
            }
        }
        ForEach(sessions) { session in
            ContentPanel(title: session.title, symbol: "bubble.left.and.bubble.right") {
                Text(session.waitingFor ?? "Claude needs your input.").textSelection(.enabled)
                Text(session.projectPath).font(Typeface.caption).foregroundStyle(.secondary)
                Text("Answer in Claude.").font(Typeface.callout).foregroundStyle(.secondary)
            }
        }
    }
}
