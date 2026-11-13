import SwiftUI

struct BoardView: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    var body: some View {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
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
                .transition(.opacity)
                .disabled(store.selectedJob != nil)
                .accessibilityHidden(store.selectedJob != nil)
                .overlay(alignment: .trailing) {
                if let id = store.selectedJob {
                    JobDetailView(store: store, id: id).id(id)
                        .frame(width: 420).background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 24))
                        .clipShape(RoundedRectangle(cornerRadius: 24))
                        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.primary.opacity(0.08)))
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
        .searchable(text: $store.search, placement: .toolbar, prompt: "Search work")
        .searchFocused($searchFocused)
        .background(WorkspaceStyle.canvas.ignoresSafeArea())
        .frame(minWidth: 850, minHeight: 560)
        .onChange(of: store.selection) { store.persistSelection() }
        .onExitCommand { store.selectedJob = nil }
        .sheet(isPresented: $store.showingDispatch) { DispatchView(store: store) }
        .onChange(of: store.searchRequest) { searchFocused = true }
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
                        .font(.system(size: 12, weight: .medium)).lineLimit(1)
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
    private var jobs: [Job] {
        store.state.jobs.filter { (store.project.isEmpty || $0.projectPath == store.project) && matches("\($0.title) \($0.phase) \($0.projectPath) \($0.agent)") }
    }
    private var connectionBanner: some View {
        HStack(alignment: .top) {
            Label(store.connectionMessage, systemImage: "wifi.exclamationmark").font(.callout).textSelection(.enabled)
            Spacer()
            Button("Retry") { store.start() }
        }.padding(16).background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }
    private var attentionBanner: some View {
        Button { store.selection = "needs"; store.search = "" } label: {
            HStack {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("\(store.state.pendingCount) \(store.state.pendingCount == 1 ? "request needs" : "requests need") your attention").font(.body.weight(.medium))
                Spacer()
                Text("Review").font(.callout)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
            }.padding(16).contentShape(Rectangle())
        }.buttonStyle(.plain).glassEffect(.regular, in: .rect(cornerRadius: 16))
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
        let scopedMissions = store.state.missions.filter { mission in
            (store.project.isEmpty || mission.root == store.project) && (matches(mission.title) || jobs.contains { $0.mission == mission.id })
        }.sorted { $0.createdAt > $1.createdAt }
        let shownMissions = store.selection == "history" ? scopedMissions.filter { $0.state != "active" } : scopedMissions.filter { $0.state == "active" }
        ForEach(shownMissions) { mission in
            MissionPanel(store: store, mission: mission, jobs: jobs.filter { $0.mission == mission.id })
        }
        let shownIDs = Set(shownMissions.map(\.id))
        let loose = jobs.filter { !shownIDs.contains($0.mission ?? "") && (store.selection == "history" ? !$0.isActive : $0.isActive) }.sorted { $0.createdAt > $1.createdAt }
        if !loose.isEmpty {
            ContentPanel(title: store.selection == "history" ? "Completed jobs" : "Other jobs", symbol: "rectangle.stack") {
                ForEach(loose) { job in
                    JobRow(job: job, selected: store.selectedJob == job.id, now: store.now) { store.openJob(job.id) }
                }
            }
        }
        if store.selection != "history" {
            let recent = scopedMissions.filter { $0.state != "active" }.prefix(2)
            ForEach(Array(recent)) { mission in
                MissionPanel(store: store, mission: mission, jobs: jobs.filter { $0.mission == mission.id })
            }
            let recentJobs = jobs.filter { !$0.isActive && $0.mission == nil }.sorted { ($0.endedAt ?? 0) > ($1.endedAt ?? 0) }.prefix(4)
            if !recentJobs.isEmpty {
                ContentPanel(title: "Recently finished", symbol: "checkmark.circle") {
                    ForEach(Array(recentJobs)) { job in JobRow(job: job, now: store.now) { store.openJob(job.id) } }
                }
            }
            let sessions = store.state.claude.filter { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
            if !sessions.isEmpty {
                ContentPanel(title: "Claude sessions", symbol: "bubble.left.and.bubble.right") {
                    ForEach(sessions) { SessionView(session: $0) }
                }
            }
        }
        let emptyHistory = store.selection == "history" && shownMissions.isEmpty && loose.isEmpty
        let emptyWorkspace = store.selection != "history" && jobs.isEmpty && scopedMissions.isEmpty && !store.state.claude.contains { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
        if emptyHistory || emptyWorkspace {
            ContentUnavailableView {
                Label(store.search.isEmpty ? (emptyHistory ? "No completed work yet" : "Ready when you are") : "No matching work", systemImage: store.search.isEmpty ? "square.stack.3d.up" : "magnifyingglass")
            } description: {
                Text(store.search.isEmpty ? (emptyHistory ? "Finished jobs and missions will appear here." : "Send a job to an agent, or start a mission with /crew:run in Claude.") : "Try a different title, agent, or project.")
            } actions: {
                if store.search.isEmpty && !emptyHistory { Button("New Job", systemImage: "plus") { store.showingDispatch = true }.buttonStyle(.glassProminent).disabled(!store.connected) }
            }.padding(.vertical, 30)
        }
    }
    private var activity: some View {
        ContentPanel(title: "Recent activity", symbol: "waveform.path") {
            let events = store.state.events.filter { matches("\($0.detail) \($0.agent)") }
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
            Text("Agents").font(WorkspaceStyle.section).tracking(-0.5)
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
                    Text(agentName(agent)).font(.system(size: 12, weight: .medium))
                    Spacer()
                    let jobs = store.state.jobs.filter { $0.agent == agent && $0.isActive && (store.project.isEmpty || $0.projectPath == store.project) }
                    let sessions = store.state.claude.filter { $0.state != "idle" && (store.project.isEmpty || $0.projectPath == store.project) }
                    let count = agent == "claude" ? sessions.count : jobs.count
                    let waiting = agent == "claude" ? sessions.contains { $0.state == "waiting" } : jobs.contains { $0.state == "waiting" }
                    let stalled = agent == "claude" ? sessions.contains { $0.stalled } : jobs.contains { $0.stalled }
                    let mark = waiting ? "waiting" : stalled ? "stalled" : count > 0 ? "working" : "idle"
                    if count > 0 { Text("\(count) active").font(.system(size: 11)).foregroundStyle(.secondary) }
                    StatusLabel(state: mark, title: waiting ? "Needs you" : stalled ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : count > 0 ? "Working" : "Ready")
                }.padding(.horizontal, 16).padding(.vertical, 11)
                if agent != agents.last { Divider().padding(.leading, 44) }
            }
        }.background(WorkspaceStyle.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 16))
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
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(spacing: 10) {
                AgentMark(agent: agent, size: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agentName(agent)).font(.system(size: 16, weight: .semibold, design: .rounded)).tracking(-0.35)
                    Text(agent == "claude" ? "Lead" : roleOrder.filter { store.state.roles[$0]?.agent == agent }.compactMap { roleNames[$0] }.joined(separator: " · "))
                        .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(String(agent == "claude" ? sessions.count : jobs.count)).font(.system(size: 32, weight: .regular, design: .rounded)).monospacedDigit().tracking(-0.8)
                Text(agent == "claude" ? "active sessions" : "active jobs").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            HStack {
                StatusLabel(state: mark, title: mark == "waiting" ? "Needs you" : mark == "working" ? "Working" : mark == "stalled" ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : "Ready")
                Spacer(minLength: 0)
                if let usage = store.state.limits[agent] ?? nil, let maximum = usage.windows?.map(\.usedPercent).max() {
                    Text("\(Int(maximum))% used").font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary)
                        .help((usage.windows ?? []).map { "\(Int($0.usedPercent))% of \(Int($0.minutes))-minute limit" }.joined(separator: "\n"))
                }
            }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.primary.opacity(0.04)))
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
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 16) {
                if mission.state == "active" { StageRing(mission: mission).padding(2) }
                VStack(alignment: .leading, spacing: 8) {
                    Text(mission.state == "active" ? "IN PROGRESS" : "RECENT MISSION").font(.system(size: 9, weight: .semibold)).tracking(1.5).foregroundStyle(.secondary)
                    Text(mission.title).font(.system(size: 20, weight: .semibold, design: .rounded)).tracking(-0.5).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Text(elapsed((mission.endedAt ?? store.now) - mission.createdAt)).monospacedDigit()
                        let tokens = jobs.reduce(0) { $0 + ($1.tokens ?? 0) }
                        if tokens > 0 { Text("·"); Text("\(tokens.formatted()) tokens") }
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Menu {
                    if mission.state == "active" {
                        Button("Dismiss mission", systemImage: "xmark.circle") { Task { await store.dismiss(mission) } }
                            .disabled(!store.connected || store.actions["dismiss:\(mission.id)"]?.locked == true)
                    }
                    Button(expanded ? "Collapse details" : "Expand details", systemImage: expanded ? "chevron.up" : "chevron.down") { expanded.toggle() }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24) }
                    .menuStyle(.borderlessButton).fixedSize().help("Mission options")
            }
            if store.project.isEmpty { Text(mission.root).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled) }
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 16) {
                    MissionTrack(mission: mission).padding(.top, 14)
                    if let lead = store.state.claude.first(where: { $0.id == mission.owner }), mission.state == "active" {
                        SessionView(session: lead).padding(12).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
                    }
                    VStack(spacing: 4) {
                        ForEach(jobs) { job in JobRow(job: job, selected: store.selectedJob == job.id, now: store.now) { store.openJob(job.id) } }
                    }
                    if jobs.isEmpty { Text("The lead is coordinating this mission.").font(.callout).foregroundStyle(.secondary) }
                    if !mission.outcome.isEmpty { Text(mission.outcome).font(.callout).textSelection(.enabled) }
                    ActionMessage(state: store.actions["dismiss:\(mission.id)"])
                }
            } label: {
                HStack {
                    Text(mission.state == "active" ? "\(Mission.steps[mission.step]) · Step \(mission.step + 1) of 6" : mission.state.capitalized).font(.system(size: 12, weight: .medium))
                    Spacer()
                    Text("\(jobs.count) \(jobs.count == 1 ? "job" : "jobs")").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        }.animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: expanded)
            .padding(22).background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.primary.opacity(0.05)))
    }
}

struct NeedsYouView: View {
    @Bindable var store: CrewStore
    private func matches(_ text: String) -> Bool { store.search.isEmpty || text.localizedCaseInsensitiveContains(store.search) }
    private var jobs: [Job] { store.state.waitingJobs.filter { matches("\($0.title) \($0.projectPath) \($0.agent) \($0.waiting?.reason ?? "")") } }
    private var sessions: [ClaudeSession] { store.state.waitingSessions.filter { matches("\($0.title) \($0.projectPath) Claude \($0.waitingFor ?? "")") } }
    var body: some View {
        if store.state.pendingCount == 0 {
            ContentUnavailableView("All caught up", systemImage: "checkmark.circle", description: Text("Requests from every project appear here."))
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
                            }.font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary).help(job.projectPath)
                            Spacer(minLength: 8)
                            Button("Details", systemImage: "arrow.up.right") { store.openJob(job.id) }
                                .buttonStyle(.borderless).font(.system(size: 11))
                        }
                        Text(job.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2).help(job.title)
                    }
                    AnswerView(store: store, job: job)
                }
                .padding(22).frame(maxWidth: .infinity, alignment: .leading)
                .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 22))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.primary.opacity(0.04)))
            }
        }
        ForEach(sessions) { session in
            ContentPanel(title: session.title, symbol: "bubble.left.and.bubble.right") {
                Text(session.waitingFor ?? "Claude needs your input.").textSelection(.enabled)
                Text(session.projectPath).font(.caption).foregroundStyle(.secondary)
                Text("Answer in the Claude app, in the session that asked.").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}
