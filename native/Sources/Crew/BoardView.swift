import SwiftUI

struct BoardView: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var searchFocused: Bool
    @State private var wide = false
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
        .onExitCommand { store.closeDetail() }
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
            .onGeometryChange(for: Bool.self) { $0.size.width >= Self.twoColumnWidth } action: { wide = $0 }
            .background(OverlayScrollers())
            .padding(.horizontal, WorkspaceStyle.pageMargin).padding(.top, WorkspaceStyle.pageTop).padding(.bottom, WorkspaceStyle.pageMargin)
            .frame(maxWidth: 1280).frame(maxWidth: .infinity)
        }
        .id(store.selection ?? "overview")
        // A crossfade layers two full pages at once; only the incoming page animates.
        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .identity))
        // Tied to the page itself, so tabs, the sidebar and keyboard shortcuts all get the same entrance;
        // a withAnimation in the AppKit tab control's action did not reach this view.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: store.selection)
        // The page keeps scrolling and working beside the open panel. A click on it that no control takes
        // closes the panel; one on another job opens that job instead. The sidebar is another column.
        .contentShape(Rectangle())
        .gesture(TapGesture().onEnded { store.closeDetail() }, including: store.detailOpen ? .all : .subviews)
        .overlay(alignment: .trailing) {
            if store.detailOpen {
                let shape = RoundedRectangle(cornerRadius: WorkspaceStyle.panelRadius)
                Group {
                    if let id = store.selectedJob { JobDetailView(store: store, id: id).id(id) }
                    else if let id = store.selectedSession { SessionDetailView(store: store, id: id).id("session:\(id)") }
                }
                    .frame(width: WorkspaceStyle.panelWidth).background(WorkspaceStyle.surface, in: shape)
                    .clipShape(shape)
                    .overlay(shape.strokeBorder(WorkspaceStyle.hairline))
                    .shadow(color: Palette.panelShadow, radius: 26, x: -8, y: 8)
                    .padding(.trailing, WorkspaceStyle.windowInset).padding(.bottom, WorkspaceStyle.windowInset)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                    .zIndex(1)
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.26, extraBounce: 0), value: store.detailOpen)
    }
    /// The content width from which cards pair up, so each column still fits a mission's header.
    private nonisolated static let twoColumnWidth: CGFloat = 1000
    /// The page's cards in two columns on a wide page, each stacked on its own, so a card that grows moves only
    /// the cards below it in its own column. Cards alternate left and right in order and keep their column: filling
    /// the shorter column instead would move cards across whenever one opens or closes. `left` and `right` end their
    /// columns whatever the count above, in the order a single column shows them. With one column's worth of cards,
    /// they keep the full width.
    @ViewBuilder private func masonry<Card: View>(_ tiles: [Tile], left: Tile?, right: Tile?, @ViewBuilder card: @escaping (Tile) -> Card) -> some View {
        let columns = [
            stride(from: 0, to: tiles.count, by: 2).map { tiles[$0] } + [left].compactMap { $0 },
            stride(from: 1, to: tiles.count, by: 2).map { tiles[$0] } + [right].compactMap { $0 },
        ]
        if wide && !columns[0].isEmpty && !columns[1].isEmpty {
            HStack(alignment: .top, spacing: WorkspaceStyle.cardGap) {
                ForEach(columns.indices, id: \.self) { column in
                    LazyVStack(alignment: .leading, spacing: WorkspaceStyle.cardGap) {
                        ForEach(columns[column]) { card($0) }
                    }.frame(maxWidth: .infinity, alignment: .top)
                }
            }
        } else {
            ForEach(tiles + [left, right].compactMap { $0 }) { card($0) }
        }
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
            Button("Retry") { store.start() }.pillButton()
        }.padding(WorkspaceStyle.bannerPadding).background(Palette.attention(Palette.warning), in: RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
    }
    private var attentionBanner: some View {
        Button { store.selection = "needs"; store.search = "" } label: {
            HStack {
                Image(systemName: "bell.badge.fill").foregroundStyle(Palette.warning)
                Text("\(store.state.pendingCount) \(store.state.pendingCount == 1 ? "request needs" : "requests need") your attention").font(Typeface.bodyStrong)
                Spacer()
                Text("Review").font(Typeface.callout)
                Image(systemName: "chevron.right").font(Typeface.captionStrong)
            }.padding(WorkspaceStyle.bannerPadding).contentShape(Rectangle())
        }.buttonStyle(.plain).glassEffect(.regular, in: .rect(cornerRadius: WorkspaceStyle.cardRadius))
    }
    private var heading: some View {
        let overview = store.selection == "overview" || store.selection == nil
        let pending = store.state.pendingCount
        return ViewThatFits(in: .horizontal) {
            if overview || !store.project.isEmpty {
                HStack(alignment: .top, spacing: Space.x5l) {
                    // A fixed ideal width keeps a long project path from forcing the stacked layout;
                    // the path truncates instead.
                    headingCopy(overview: overview, pending: pending)
                        .frame(minWidth: 340, idealWidth: 340, maxWidth: .infinity)
                        // Align the title's cap height, not its line box, with the top of the summary card.
                        .alignmentGuide(.top) { $0[.firstTextBaseline] - Typeface.pageTitleCapHeight }
                    WorkspaceSummary(store: store).frame(minWidth: 430, maxWidth: 500)
                }
            }
            VStack(alignment: .leading, spacing: Space.x3l) {
                headingCopy(overview: overview, pending: pending)
                if overview || !store.project.isEmpty { WorkspaceSummary(store: store) }
            }
        }.padding(.top, Space.s).padding(.bottom, Space.s)
    }
    private func headingCopy(overview: Bool, pending: Int) -> some View {
        VStack(alignment: .leading, spacing: Space.xxl) {
            WorkspaceHeading(title: title, subtitle: store.project.isEmpty ? nil : store.project)
            if overview && pending > 0 {
                Button("Review requests", systemImage: "arrow.up.right") { store.selection = "needs"; store.search = "" }
                    .glassPillButton(prominent: false)
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
        // Jobs of a recent mission already appear inside its panel.
        let panelIDs = Set((shownMissions + recent).map(\.id))
        let loose = jobs.filter { !panelIDs.contains($0.mission ?? "") && (history ? !$0.isActive : $0.isActive) }.sorted { $0.createdAt > $1.createdAt }
        let recentJobs = history ? [] : Array(jobs.filter { !$0.isActive && $0.mission == nil }.sorted { ($0.endedAt ?? 0) > ($1.endedAt ?? 0) }.prefix(4))
        let sessions = history ? [] : store.state.claude.filter { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
        let tiles: [Tile] = shownMissions.map(Tile.mission) + (loose.isEmpty ? [] : [.loose]) + recent.map(Tile.mission)
        masonry(tiles, left: recentJobs.isEmpty ? nil : .finished, right: sessions.isEmpty ? nil : .sessions) { tile in
            switch tile {
            case .mission(let mission):
                MissionPanel(store: store, mission: mission, jobs: missionJobs(mission))
            case .loose:
                ContentPanel(title: history ? "Completed jobs" : "Other jobs", symbol: "rectangle.stack") {
                    ForEach(loose) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.toggleJob(job.id) } }
                }
            case .finished:
                ContentPanel(title: "Recently finished", symbol: "checkmark.circle") {
                    ForEach(recentJobs) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.toggleJob(job.id) } }
                }
            case .sessions:
                ContentPanel(title: "Claude sessions", symbol: "bubble.left.and.bubble.right") {
                    ForEach(sessions) { session in SessionRow(session: session, selected: store.selectedSession == session.id, store: store) { store.toggleSession(session.id) } }
                }
            }
        }
        let emptyHistory = history && shownMissions.isEmpty && loose.isEmpty
        let emptyWorkspace = !history && jobs.isEmpty && scopedMissions.isEmpty && !store.state.claude.contains { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
        if emptyHistory || emptyWorkspace {
            EmptyState(title: store.search.isEmpty ? (emptyHistory ? "No completed work yet" : "Ready when you are") : "No matching work",
                       symbol: store.search.isEmpty ? "square.stack.3d.up" : "magnifyingglass",
                       detail: store.search.isEmpty && !emptyHistory ? "Start with New Job, or /crew:run in Claude." : nil) {
                if store.search.isEmpty && !emptyHistory { Button("New Job", systemImage: "plus") { store.showingDispatch = true }.glassPillButton().disabled(!store.connected) }
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
        VStack(alignment: .leading, spacing: Space.l) {
            Text("Agents").font(Typeface.section).padding(.leading, WorkspaceStyle.titleInset)
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
                // Usage sits further from the agent's row than its own label from its bar, as on the cards.
                VStack(alignment: .leading, spacing: Space.l) {
                    HStack(spacing: Space.ml) {
                        AgentMark(agent: agent, size: MarkSize.list)
                        // The name as on the cards, with the role beside it: the row has room across, not down.
                        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                            Text(agentName(agent)).font(Typeface.cardTitle).fixedSize()
                            Text(agentRole(agent, store: store)).font(Typeface.caption).foregroundStyle(.secondary).fadeTruncated()
                        }
                        Spacer(minLength: 8)
                        let jobs = store.state.jobs.filter { $0.agent == agent && $0.isActive && (store.project.isEmpty || $0.projectPath == store.project) }
                        let sessions = store.state.claude.filter { $0.state != "idle" && (store.project.isEmpty || $0.projectPath == store.project) }
                        let count = agent == "claude" ? sessions.count : jobs.count
                        let waiting = agent == "claude" ? sessions.contains { $0.state == "waiting" } : jobs.contains { $0.state == "waiting" }
                        let stalled = agent == "claude" ? sessions.contains { $0.stalled } : jobs.contains { $0.stalled }
                        let mark = waiting ? "waiting" : stalled ? "stalled" : count > 0 ? "working" : "idle"
                        let idle = agent == "claude" ? idleSessions(store) : 0
                        let summary = [count > 0 ? "\(count) active" : nil, idle > 0 ? "\(idle) idle" : nil].compactMap { $0 }
                        if !summary.isEmpty { Text(summary.joined(separator: " · ")).font(Typeface.caption).foregroundStyle(.secondary) }
                        StatusLabel(state: mark, title: waiting ? "Needs you" : stalled ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : count > 0 ? "Working" : "Ready")
                    }
                    if let usage = store.usage, usage.source != "none" { AgentUsageView(store: store, agent: agent) }
                }.padding(.horizontal, WorkspaceStyle.cardPadding).padding(.vertical, Space.l)
                if agent != agents.last { Divider().padding(.leading, WorkspaceStyle.cardPadding + MarkSize.list + Space.ml) }
            }
        }.card(padding: 0)
    }
}

/// The roles an agent holds, as the user assigned them; Claude always leads.
@MainActor private func agentRole(_ agent: String, store: CrewStore) -> String {
    agent == "claude" ? "Lead" : roleOrder.filter { store.state.roles[$0]?.agent == agent }.compactMap { roleNames[$0] }.joined(separator: " · ")
}

/// Claude sessions open in this scope but between turns.
@MainActor private func idleSessions(_ store: CrewStore) -> Int {
    store.state.claude.filter { $0.state == "idle" && (store.project.isEmpty || $0.projectPath == store.project) }.count
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
    private var busy: Bool { (agent == "claude" ? sessions.count + idleSessions(store) : jobs.count) > 0 }
    private var activity: String {
        let count = agent == "claude" ? sessions.count : jobs.count
        let noun = agent == "claude" ? "session" : "job"
        // Only Claude sessions sit idle between turns; a worker's job is either running or over.
        let idle = agent == "claude" ? idleSessions(store) : 0
        if count == 0 { return idle == 0 ? "No active \(noun)s" : "\(idle) idle \(noun)\(idle == 1 ? "" : "s")" }
        return "\(count) active \(noun)\(count == 1 ? "" : "s")" + (idle > 0 ? " · \(idle) idle" : "")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            // The status keeps to the card's top padding; the mark sits on the middle of the name and role together.
            HStack(alignment: .top, spacing: Space.ml) {
                HStack(alignment: .center, spacing: Space.ml) {
                    AgentMark(agent: agent, size: MarkSize.card)
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text(agentName(agent)).font(Typeface.cardTitle).fixedSize()
                        // The role truncates and claims no width of its own, so the name and status set
                        // the card's minimum and the cards give way to the list only when those no longer fit.
                        Text(agentRole(agent, store: store))
                            .font(Typeface.caption).foregroundStyle(.secondary).fadeTruncated()
                    }
                }
                Spacer(minLength: Space.m)
                StatusLabel(state: mark, title: mark == "waiting" ? "Needs you" : mark == "working" ? "Working" : mark == "stalled" ? "May be stuck" : store.state.agents[agent]?.enabled == false ? "Disabled" : "Ready")
            }
            // The agent's work in a gray inset, apart from its name above and its account usage below; with
            // nothing open, the inset is left out rather than saying so.
            if busy { Text(activity).font(Typeface.callout).monospacedDigit().foregroundStyle(.secondary).inset() }
            if store.usage == nil || store.usage?.source == "none" { AgentUsageView(store: store, agent: agent) }
            // Cards in a row share a height; usage sits at the bottom, so one bar lines up with the last of two.
            if let usage = store.usage, usage.source != "none" {
                // Set apart from the activity line above, which is about the work, not the account.
                AgentUsageView(store: store, agent: agent).padding(.top, Space.m).frame(maxHeight: .infinity, alignment: .bottom)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).card()
    }
}

struct MissionPanel: View {
    @Bindable var store: CrewStore
    let mission: Mission
    let jobs: [Job]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var expanded: Bool { store.isExpanded(mission) }
    private var meta: String {
        let tokens = jobs.reduce(0) { $0 + ($1.tokens ?? 0) }
        return [
            tokens > 0 ? "\(tokens.formatted()) tokens" : nil,
            store.project.isEmpty ? projectName(mission.root, among: store.projects) : nil,
            "\(jobs.count) \(jobs.count == 1 ? "job" : "jobs")",
        ].compactMap { $0 }.joined(separator: " · ")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            // Progress, status and the controls sit on the middle of the title and its meta line together.
            HStack(alignment: .center, spacing: Space.m) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    // One line each, so cards side by side keep the same height whatever their titles.
                    Text(mission.title).font(Typeface.title).fadeTruncated().help(mission.title)
                    HStack(spacing: 0) {
                        ElapsedText(store: store, start: mission.createdAt, end: mission.endedAt)
                        Text(" · " + meta)
                    }.font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).fadeTruncated().help(mission.root)
                }
                Spacer(minLength: 8)
                Text(missionProgress(mission, jobs: jobs), format: .percent.precision(.fractionLength(0)))
                    .font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).help("Mission progress")
                StatusLabel(state: mission.state == "active" ? "running" : mission.state, title: mission.state.capitalized)
                // A filled circle, so the control shows its hit area.
                Button { toggle() } label: {
                    Image(systemName: "chevron.down").font(Symbol.control)
                        .rotationEffect(.degrees(expanded ? 0 : -90)).frame(width: Symbol.controlFrame, height: Symbol.controlFrame)
                }.iconButton().accessibilityLabel(expanded ? "Collapse mission" : "Expand mission").help(expanded ? "Collapse" : "Expand")
            }
            // The title row opens and closes the card; its button keeps its own click.
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            if expanded {
                VStack(alignment: .leading, spacing: Space.xl) {
                    ForEach(Array((mission.notes ?? []).enumerated()), id: \.offset) { _, note in
                        Text(note.text).font(Typeface.callout).textSelection(.enabled).padding(.leading, WorkspaceStyle.rowTitleInset)
                    }
                    MissionTrack(mission: mission).padding(.vertical, Space.xs)
                    VStack(spacing: WorkspaceStyle.rowGap) {
                        ForEach(mission.stops.indices, id: \.self) { index in
                            let mine = jobs.filter { mission.jobStep($0) == index }
                            let lead = mission.state == "active" && index == mission.step ? store.state.claude.first { $0.id == mission.owner } : nil
                            if !mine.isEmpty || lead != nil {
                                Text(mission.stops[index]).font(Typeface.captionStrong).foregroundStyle(.secondary).padding(.leading, WorkspaceStyle.rowTitleInset)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, Space.m)
                                if let lead {
                                    SessionRow(session: lead, selected: store.selectedSession == lead.id, store: store) { store.toggleSession(lead.id) }
                                }
                                ForEach(mine) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.toggleJob(job.id) } }
                            }
                        }
                    }
                    if !mission.outcome.isEmpty { Text(mission.outcome).font(Typeface.callout).textSelection(.enabled).padding(.leading, WorkspaceStyle.rowTitleInset) }
                    // The mission's own controls close its contents, at the trailing edge with the hint that calls
                    // for them; the action that completes it comes last.
                    // Offered only once the mission looks finished; until then the lead is still at it.
                    if mission.state == "active" && finished {
                        HStack(spacing: Space.m) {
                            Spacer(minLength: 0)
                            Text("Looks finished").font(Typeface.caption).foregroundStyle(.secondary)
                            actions
                        }.padding(.top, Space.xs)
                    }
                }
                .transition(reduceMotion ? .opacity : .asymmetric(
                    // In after the card has started to open; out quickly, before the card closes over it.
                    insertion: .modifier(active: Reveal(shown: false), identity: Reveal(shown: true)).animation(.easeOut(duration: 0.28).delay(0.06)),
                    removal: .modifier(active: Reveal(shown: false), identity: Reveal(shown: true)).animation(.easeIn(duration: 0.14))))
            }
            ActionMessage(state: store.actions["dismiss:\(mission.id)"])
        }
        .card()
        // Closing, the contents fade while the card shrinks; they must not spill over the card below.
        .clipShape(RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
        // Closed, the whole card opens it. Open, only the title row closes it, so text inside stays selectable
        // and the job rows and sessions keep their clicks.
        .contentShape(RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
        .gesture(TapGesture().onEnded(toggle), including: expanded ? .subviews : .all)
    }
    private var finished: Bool {
        mission.looksFinished(jobs: store.state.jobs, now: store.now, lead: store.state.claude.first { $0.id == mission.owner })
    }
    @ViewBuilder private var actions: some View {
        let locked = !store.connected || store.actions["dismiss:\(mission.id)"]?.locked == true
        // In the warning color: it drops the mission without completing it.
        Button("Stop tracking", systemImage: "xmark.circle") { Task { await store.dismiss(mission) } }
            .pillButton(.warning)
            .help("Stops tracking without marking done. Its jobs keep running.").disabled(locked)
        Button("Mark done", systemImage: "checkmark.circle") { Task { await store.markDone(mission) } }
            .pillButton(.prominent).disabled(locked)
    }
    /// Animated from here rather than inside the card, so the cards below move with it instead of jumping.
    private func toggle() {
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.38)) { store.missionExpanded[mission.id] = !expanded }
    }
}

/// How a mission's contents enter and leave: a short drift down out of a soft blur, never a plain cut.
private struct Reveal: ViewModifier {
    var shown: Bool
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).blur(radius: shown ? 0 : 6).offset(y: shown ? 0 : -10)
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
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 420, maximum: 620), spacing: WorkspaceStyle.cardGap)], alignment: .leading, spacing: WorkspaceStyle.cardGap) {
            ForEach(jobs) { job in
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: Space.ml) {
                        HStack(spacing: Space.ml) {
                            StatusLabel(state: "waiting", title: job.waiting?.type == "approval" ? "Approval" : "Question")
                            HStack(spacing: Space.s) {
                                AgentMark(agent: job.agent, size: MarkSize.inline)
                                Text("\(agentName(job.agent)) · \(projectName(job.projectPath, among: store.projects))").lineLimit(1)
                            }.font(Typeface.chip).foregroundStyle(.secondary).help(job.projectPath)
                            Spacer(minLength: 8)
                            Button("Details", systemImage: "arrow.up.right") { store.openJob(job.id) }.pillButton()
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

/// A card on the overview or history page.
private enum Tile: Identifiable {
    case mission(Mission), loose, finished, sessions
    var id: String {
        switch self {
        case .mission(let mission): mission.id
        case .loose: "loose"
        case .finished: "finished"
        case .sessions: "sessions"
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
                    .padding(.horizontal, Space.ml).padding(.vertical, Space.m).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .disabled(store.state.roles.isEmpty).help("Settings (⌘,)")
            .padding(.horizontal, Space.ml).padding(.bottom, Space.ml)
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
