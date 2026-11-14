import SwiftUI

struct BoardView: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    var body: some View {
        NavigationSplitView {
            ProjectSidebar(store: store, openSettings: openSettings)
        } detail: {
            page
                // Narrow enough for the sidebar to be optional; the window adds the sidebar's own minimum when shown.
                .frame(minWidth: 560)
                .toolbar { WorkspaceToolbar(store: store) }
                // The window keeps its standard title bar: a hidden one is transparent, and AppKit then
                // draws no scroll edge effect under the toolbar at all.
                .scrollEdgeEffectStyle(.soft, for: .top)
                // The system search item folds into a button when the toolbar runs out of room.
                .searchable(text: $store.search, placement: .toolbar, prompt: "Search work")
                .searchFocused($searchFocused)
                .onChange(of: store.searchRequest) { searchFocused = true }
                .navigationTitle(title)
                .toolbar(removing: .title)
                .background(WorkspaceStyle.canvas.ignoresSafeArea())
                .overlay(alignment: .top) {
                    if store.fullScreenToolbarHeight > 0 { FullScreenToolbarFade(toolbarHeight: store.fullScreenToolbarHeight) }
                }
        }
        .frame(minHeight: 560)
        .onChange(of: store.selection) { store.persistSelection() }
        .onExitCommand { store.selectedJob = nil }
        .sheet(isPresented: $store.showingDispatch) { DispatchView(store: store) }
    }
    private var page: some View {
                ScrollView {
                    // Lazy so a long history builds only the panels on screen.
                    LazyVStack(alignment: .leading, spacing: WorkspaceStyle.cardGap) {
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
                .id(store.selection ?? "overview")
                // A crossfade layers two full pages at once; only the incoming page animates.
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .identity))
                // Tied to the page itself, so tabs, the sidebar and keyboard shortcuts all get the same entrance;
                // a withAnimation in the AppKit tab control's action did not reach this view.
                .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: store.selection)
                .disabled(store.selectedJob != nil)
                .accessibilityHidden(store.selectedJob != nil)
                // A click anywhere on the page beside the open panel closes it. The sidebar is another column and is not covered.
                .overlay {
                    if store.selectedJob != nil {
                        Color.clear.contentShape(Rectangle()).onTapGesture { store.selectedJob = nil }.accessibilityHidden(true)
                    }
                }
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
                HStack(alignment: .top, spacing: 32) {
                    // A fixed ideal width keeps a long project path from forcing the stacked layout;
                    // the path truncates instead.
                    headingCopy(overview: overview, pending: pending)
                        .frame(minWidth: 340, idealWidth: 340, maxWidth: .infinity)
                        // Align the title's cap height, not its line box, with the top of the summary card.
                        .alignmentGuide(.top) { $0[.firstTextBaseline] - Typeface.pageTitleCapHeight }
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
            EmptyState(title: store.search.isEmpty ? (emptyHistory ? "No completed work yet" : "Ready when you are") : "No matching work",
                       symbol: store.search.isEmpty ? "square.stack.3d.up" : "magnifyingglass",
                       detail: store.search.isEmpty && !emptyHistory ? "Start with New Job, or /crew:run in Claude." : nil) {
                if store.search.isEmpty && !emptyHistory { Button("New Job", systemImage: "plus") { store.showingDispatch = true }.buttonStyle(.glassProminent).disabled(!store.connected) }
            }
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
            Text("Agents").font(Typeface.section)
            if compact { compactAgents }
            else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: WorkspaceStyle.cardGap) {
                        ForEach(agents, id: \.self) { agent in AgentCard(store: store, agent: agent) }
                    }.fixedSize(horizontal: false, vertical: true)
                    compactAgents
                }
            }
        }
    }
    private var compactAgents: some View {
        VStack(spacing: 0) {
            ForEach(agents, id: \.self) { agent in
                VStack(alignment: .leading, spacing: 8) {
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
                    }
                    if let usage = store.usage, usage.source != "none" { AgentUsageView(store: store, agent: agent) }
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
            // The mark and the status sit on the middle of the name and role together, not on the name alone.
            HStack(alignment: .center, spacing: 10) {
                AgentMark(agent: agent, size: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(agentName(agent)).font(Typeface.cardTitle).fixedSize()
                    // The role truncates and claims no width of its own, so the name and status set
                    // the card's minimum and the cards give way to the list only when those no longer fit.
                    Text(agent == "claude" ? "Lead" : roleOrder.filter { store.state.roles[$0]?.agent == agent }.compactMap { roleNames[$0] }.joined(separator: " · "))
                        .font(Typeface.caption).foregroundStyle(.secondary).lineLimit(1)
                        .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 8)
                StatusLabel(state: mark, title: mark == "waiting" ? "Needs you" : mark == "working" ? "Working" : mark == "stalled" ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : "Ready")
            }
            HStack {
                Text(activity).font(Typeface.callout).monospacedDigit().foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if store.usage == nil || store.usage?.source == "none" { AgentUsageView(store: store, agent: agent) }
            }
            // Cards in a row share a height; usage sits at the bottom, so one bar lines up with the last of two.
            if let usage = store.usage, usage.source != "none" {
                AgentUsageView(store: store, agent: agent).frame(maxHeight: .infinity, alignment: .bottom)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).card()
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
            // Progress, status and the controls sit on the middle of the title and its meta line together.
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(mission.title).font(Typeface.title).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 0) {
                        ElapsedText(store: store, start: mission.createdAt, end: mission.endedAt)
                        Text(" · " + meta)
                    }.font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).help(mission.root)
                }
                Spacer(minLength: 8)
                Text(missionProgress(mission, jobs: jobs), format: .percent.precision(.fractionLength(0)))
                    .font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).help("Mission progress")
                StatusLabel(state: mission.state == "active" ? "running" : mission.state, title: mission.state.capitalized)
                if mission.looksFinished(jobs: store.state.jobs, now: store.now, lead: store.state.claude.first { $0.id == mission.owner }) {
                    Text("Looks finished").font(Typeface.caption).foregroundStyle(.secondary)
                }
                // Bordered circles, so each control shows its hit area; equal glyph frames keep them the same size.
                HStack(spacing: 6) {
                    Button { expanded.toggle() } label: {
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                            .rotationEffect(.degrees(expanded ? 0 : -90)).frame(width: 16, height: 16)
                    }.buttonStyle(.bordered).buttonBorderShape(.circle).accessibilityLabel(expanded ? "Collapse mission" : "Expand mission").help(expanded ? "Collapse" : "Expand")
                    if mission.state == "active" {
                        Menu {
                            Button("Mark done", systemImage: "checkmark.circle") { Task { await store.markDone(mission) } }
                                .disabled(!store.connected || store.actions["dismiss:\(mission.id)"]?.locked == true)
                            Button("Stop tracking", systemImage: "xmark.circle") { Task { await store.dismiss(mission) } }
                                .help("Stops tracking without marking done. Its jobs keep running.")
                                .disabled(!store.connected || store.actions["dismiss:\(mission.id)"]?.locked == true)
                        } label: {
                            Image(systemName: "ellipsis").font(.system(size: 11, weight: .semibold)).frame(width: 16, height: 16)
                        }.menuStyle(.button).buttonStyle(.bordered).buttonBorderShape(.circle).menuIndicator(.hidden).fixedSize().help("Mission options")
                    }
                }
            }
            if expanded {
                ForEach(Array((mission.notes ?? []).enumerated()), id: \.offset) { _, note in
                    Text(note.text).font(Typeface.callout).textSelection(.enabled)
                }
                MissionTrack(mission: mission).padding(.vertical, 4)
                VStack(spacing: 4) {
                    ForEach(mission.stops.indices, id: \.self) { index in
                        let mine = jobs.filter { mission.jobStep($0) == index }
                        let lead = mission.state == "active" && index == mission.step ? store.state.claude.first { $0.id == mission.owner } : nil
                        if !mine.isEmpty || lead != nil {
                            Text(mission.stops[index]).font(Typeface.captionStrong).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                            if let lead {
                                SessionView(session: lead).padding(.horizontal, 12).padding(.vertical, 10)
                                    .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
                            }
                            ForEach(mine) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.openJob(job.id) } }
                        }
                    }
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
            EmptyState(title: "All caught up", symbol: "checkmark.circle")
        } else if jobs.isEmpty && sessions.isEmpty {
            EmptyState(title: "No matching requests", symbol: "magnifyingglass")
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
                                .buttonStyle(.bordered).controlSize(.small).font(Typeface.caption)
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

/// Projects live in a sidebar so a long list stays scannable; choosing one scopes the overview to it.
struct ProjectSidebar: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    var body: some View {
        let projects = store.projects
        List(selection: Binding<String?>(
            // The other pages select no row, so choosing All projects from them returns to the overview.
            get: { !store.project.isEmpty ? store.project : (store.selection ?? "overview") == "overview" ? "" : nil },
            set: { path in store.selection = path.map { $0.isEmpty ? "overview" : "project:\($0)" } ?? "overview" }
        )) {
            Label("All projects", systemImage: "square.stack").tag("")
            Section("Projects") {
                ForEach(projects, id: \.self) { path in
                    Label(projectName(path, among: projects), systemImage: "folder").tag(path).help(path)
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            Button(action: openSettings) {
                Label("Settings", systemImage: "gearshape").font(Typeface.bodyStrong)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 7).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .disabled(store.state.roles.isEmpty).help("Settings (⌘,)")
            .padding(.horizontal, 10).padding(.bottom, 10)
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 300)
    }
}

extension View {
    /// Places an empty state in the middle of the visible page rather than under the heading.
    func centeredInPage() -> some View {
        frame(maxWidth: .infinity).containerRelativeFrame(.vertical) { height, _ in height * 0.6 }
    }
}

/// In full screen the toolbar moves to its own window, where the scroll edge effect has no content to blur
/// and paints an opaque bar instead. With that bar hidden, this fade stands in for the soft edge.
private struct FullScreenToolbarFade: View {
    var toolbarHeight: CGFloat
    var body: some View {
        // Blur under the toolbar that fades out below it, close to the soft scroll edge effect.
        let height = toolbarHeight + 24
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            WorkspaceStyle.canvas.opacity(0.6)
        }
        .mask(LinearGradient(stops: [.init(color: .black, location: 0),
                                     .init(color: .black, location: toolbarHeight * 0.6 / height),
                                     .init(color: .clear, location: 1)],
                             startPoint: .top, endPoint: .bottom))
        .frame(height: height)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
