import SwiftUI

struct BoardView: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var searchFocused: Bool
    @State private var wide = false
    /// The page column's width, the panel floating over its trailing part; it bounds how wide the panel may be dragged.
    @State private var pageWidth: CGFloat = 0
    @State private var scroll = ScrollPosition(edge: .top)
    /// Lets a card that changes column glide across instead of fading out of one and into the other.
    @Namespace private var cards
    private var pageKey: String { "\(store.project)|\(store.selection ?? "overview")" }
    private var overview: Bool { (store.selection ?? "overview") == "overview" }
    var body: some View {
        NavigationSplitView {
            ProjectSidebar(store: store, openSettings: openSettings)
        } detail: {
            page
                // Narrow enough for the sidebar to be optional; the window adds the sidebar's own minimum when shown.
                .frame(minWidth: WorkspaceStyle.contentMinWidth)
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
        .frame(minHeight: WorkspaceStyle.windowMinHeight)
        .onChange(of: pageKey) {
            store.persistSelection()
            scroll.scrollTo(edge: .top)
        }
        .onExitCommand { store.closeDetail() }
        .sheet(isPresented: $store.showingDispatch, onDismiss: { store.dispatchDraft = nil }) { DispatchView(store: store) }
        .sheet(isPresented: $store.showingWelcome, onDismiss: store.markWelcomed) { WelcomeView(store: store) }
    }
    private var page: some View {
        let pending = store.scopedPendingCount
        let issuesProject = store.connected && overview ? store.project : ""
        return ScrollView {
            // Lazy so a long history builds only the panels on screen.
            LazyVStack(alignment: .leading, spacing: WorkspaceStyle.cardGap) {
                if !store.connected { connectionBanner }
                heading(pending: pending)
                if store.connected && store.project.isEmpty && overview { SetupCard(api: store.api) }
                // Overview puts the banner in its heading instead.
                if pending > 0 && store.selection != "needs" && !overview { attentionBanner(pending: pending).transition(.card) }
                if store.selection == "needs" { NeedsYouView(store: store) }
                else if store.selection == "activity" { activity }
                else { workspace }
            }
            .onGeometryChange(for: Bool.self) { $0.size.width >= Self.twoColumnWidth } action: { wide = $0 }
            // A project's issue suggestions, read again on reconnect. The daemon keeps each answer ten minutes, so
            // asking more often only reads its cache.
            .task(id: issuesProject) {
                guard !issuesProject.isEmpty else { return }
                while !Task.isCancelled {
                    await store.loadIssues(issuesProject)
                    try? await Task.sleep(for: .seconds(600))
                }
            }
            // The banner, across the page or in the heading, comes and goes with requests; the page below makes room.
            .animation(Motion.reduced(Motion.reflow, reduceMotion), value: pending > 0)
            .background(OverlayScrollers())
            .padding(.horizontal, WorkspaceStyle.pageMargin).padding(.top, WorkspaceStyle.pageTop).padding(.bottom, WorkspaceStyle.pageMargin)
            .frame(maxWidth: WorkspaceStyle.pageMaxWidth).frame(maxWidth: .infinity)
            // Only the contents change during navigation. Replacing the scroll view itself left the toolbar's scroll edge
            // effect with nothing under it for a few frames, which showed as a light flash at the top.
            .id(pageKey)
            // A crossfade layers two full pages at once; only the incoming page animates.
            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .identity))
            // Tied to the page itself, so tabs, the sidebar and keyboard shortcuts all get the same entrance;
            // a withAnimation in the AppKit tab control's action did not reach this view.
            .animation(Motion.reduced(Motion.page, reduceMotion), value: pageKey)
        }
        .scrollPosition($scroll)
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
                    else if let id = store.selectedDecisions { MissionDecisionsView(store: store, id: id).id("decisions:\(id)") }
                }
                    .frame(width: WorkspaceStyle.panelWidth(store.panelWidth, page: pageWidth)).background(WorkspaceStyle.surface, in: shape)
                    .clipShape(shape)
                    .overlay { if contrast == .increased { shape.strokeBorder(Palette.contrastStroke) } }
                    .overlay(alignment: .leading) { PanelResizeHandle(store: store, page: pageWidth) }
                    .shadow(color: Palette.panelShadow, radius: WorkspaceStyle.panelShadowRadius, x: WorkspaceStyle.panelShadowOffset.width, y: WorkspaceStyle.panelShadowOffset.height)
                    .padding(.trailing, WorkspaceStyle.windowInset).padding(.bottom, WorkspaceStyle.windowInset)
                    .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                    .zIndex(1)
            }
        }
        .animation(Motion.reduced(Motion.panel, reduceMotion), value: store.detailOpen)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pageWidth = $0 }
    }
    /// The content width from which cards pair up, so each column still fits a mission's header.
    private nonisolated static let twoColumnWidth: CGFloat = 1000
    /// The heading's copy and summary side by side: below these the summary moves under the title.
    private static let headingCopyWidth: CGFloat = 340
    private static let summaryWidth: ClosedRange<CGFloat> = 430...500
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
                        ForEach(columns[column]) { placed(card($0), $0) }
                    }.frame(maxWidth: .infinity, alignment: .top)
                }
            }
        } else {
            ForEach(tiles + [left, right].compactMap { $0 }) { placed(card($0), $0) }
        }
    }
    /// Matched within the page only: the same mission on another page must not fly across when the page changes.
    private func placed<Card: View>(_ card: Card, _ tile: Tile) -> some View {
        card.matchedGeometryEffect(id: "\(pageKey)/\(tile.id)", in: cards).transition(.card)
    }
    private var title: String {
        if !store.project.isEmpty { return projectName(store.project, among: store.projects) }
        return ["needs": String(localized: "Needs You"), "activity": String(localized: "Activity"), "history": String(localized: "History")][store.selection ?? ""] ?? String(localized: "Overview")
    }
    private func matches(_ text: String) -> Bool { store.search.isEmpty || text.localizedCaseInsensitiveContains(store.search) }
    /// A folding mission's stages that fold by default, so a stage folding by itself as its last job ends moves the
    /// cards like other work leaving. The user's own picks stay out: they animate within their card, as a mission's do.
    private func foldedStages(_ mission: Mission, jobs: [Job], lead: ClaudeSession?) -> [String] {
        guard jobs.count > MissionPanel.foldStagesAfter else { return [] }
        return mission.stops.indices.filter { index in
            let mine = jobs.filter { mission.jobStep($0) == index }, hasLead = lead != nil && index == mission.step
            // A stage the panel does not draw has nothing to fold.
            return (!mine.isEmpty || hasLead) && !store.stageOpensByDefault(mission, index, jobs: mine, hasLead: hasLead)
        }.map { "\(mission.id)#\($0)" }
    }
    private var connectionBanner: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.l) {
            Label(store.connectionMessage, systemImage: "wifi.exclamationmark").font(Typeface.callout).textSelection(.enabled)
            Spacer()
            Button("Retry") { store.start() }.pillButton()
        }.padding(WorkspaceStyle.bannerPadding).background(Palette.attention(Palette.warning), in: RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
    }
    /// Requests waiting on the user, opening Needs You: a row's size, whether it runs across the page or sits in
    /// Overview's heading.
    private func attentionBanner(pending: Int) -> some View {
        Button { store.selection = "needs"; store.search = "" } label: {
            HStack {
                Image(systemName: "bell.badge.fill").foregroundStyle(Palette.warning)
                Text(pending == 1 ? String(localized: "1 request needs your attention") : String(localized: "\(pending) requests need your attention"))
                    .font(Typeface.calloutStrong)
                Spacer()
                Text("Review").font(Typeface.caption)
                Image(systemName: "chevron.right").font(Typeface.micro)
            }
            .padding(.vertical, Space.ml).padding(.horizontal, Space.l).contentShape(Rectangle())
        }.buttonStyle(.plain).glassEffect(.regular, in: .rect(cornerRadius: WorkspaceStyle.rowRadius))
    }
    private func heading(pending: Int) -> some View {
        // Only Overview, of all projects or of one: on the other pages the banner runs across the page under the heading.
        let review = overview ? pending : 0
        return ViewThatFits(in: .horizontal) {
            if overview {
                HStack(alignment: .top, spacing: Space.x5l) {
                    // A fixed ideal width keeps a long project path from forcing the stacked layout;
                    // the path truncates instead. The column is as tall as the summary card, so the banner
                    // at its foot ends where the card does.
                    headingCopy(review: review, fills: false)
                        .frame(minWidth: Self.headingCopyWidth, idealWidth: Self.headingCopyWidth, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        // Align the title's cap height, not its line box, with the top of the summary card.
                        .alignmentGuide(.top) { $0[.firstTextBaseline] - Typeface.pageTitleCapHeight }
                    WorkspaceSummary(store: store).frame(minWidth: max(Self.summaryWidth.lowerBound, WorkspaceSummary.minimumWidth), maxWidth: max(Self.summaryWidth.upperBound, WorkspaceSummary.minimumWidth))
                }
                // The row is as tall as its taller side, and the other side is given that height.
                .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: Space.x3l) {
                headingCopy(review: review, fills: true)
                if overview { WorkspaceSummary(store: store) }
            }
        }.padding(.top, Space.s).padding(.bottom, Space.s)
    }
    /// The title and, with requests waiting, the banner. Beside the summary card the banner is as wide as
    /// the title's column and sits at the column's foot, level with the card's; once the two stack (`fills`) it
    /// follows the title across the page.
    private func headingCopy(review: Int, fills: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            WorkspaceHeading(title: title, subtitle: store.project.isEmpty ? nil : store.project)
            if review > 0 {
                if fills { Spacer().frame(height: Space.xxl) } else { Spacer(minLength: Space.xxl) }
                attentionBanner(pending: review).frame(maxWidth: fills ? .infinity : Self.headingCopyWidth)
            }
        }
    }
    @ViewBuilder private var workspace: some View {
        if overview && store.search.isEmpty {
            // The page already puts cardGap between its items; the rest makes up a section's gap.
            AgentOverview(store: store).padding(.bottom, WorkspaceStyle.sectionGap - WorkspaceStyle.cardGap)
            if store.connected && !store.project.isEmpty {
                IssueSuggestions(store: store, project: store.project).padding(.bottom, WorkspaceStyle.sectionGap - WorkspaceStyle.cardGap)
            }
        }
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
        let emptyHistory = history && shownMissions.isEmpty && loose.isEmpty
        let emptyWorkspace = !history && jobs.isEmpty && scopedMissions.isEmpty && !store.state.claude.contains { (store.project.isEmpty || $0.projectPath == store.project) && matches($0.title) }
        // What is shown where. Work arriving or leaving changes it, and only then do the cards animate, so a status
        // or timer updating in place does not set the page moving.
        // A mission's rows as its panel places them: each job and the lead's session under their step, and its notes
        // and outcome.
        let missionRows = (shownMissions + recent).flatMap { mission in
            let lead = store.state.leadRow(for: mission)
            return ["\(mission.id):\(mission.notes?.count ?? 0):\(mission.outcome.isEmpty)"]
                + missionJobs(mission).map { "\(mission.id)/\($0.id)@\(mission.jobStep($0))" }
                + (lead.map { ["\(mission.id)/\($0.id)@\(mission.step)"] } ?? [])
                + foldedStages(mission, jobs: missionJobs(mission), lead: lead)
        }
        let layout = tiles.map(\.id) + loose.map(\.id) + ["finished"] + recentJobs.map(\.id) + ["sessions"] + sessions.map(\.id)
            + missionRows + [emptyHistory || emptyWorkspace ? "empty" : ""]
        Group {
        masonry(tiles, left: recentJobs.isEmpty ? nil : .finished, right: sessions.isEmpty ? nil : .sessions) { tile in
            switch tile {
            case .mission(let mission):
                MissionPanel(store: store, mission: mission, jobs: missionJobs(mission))
            case .loose:
                ContentPanel(title: history ? String(localized: "Jobs") : String(localized: "Other jobs"), symbol: "rectangle.stack") {
                    VStack(spacing: WorkspaceStyle.rowGap) { ForEach(loose) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.toggleJob(job.id) }.transition(.card) } }
                }
            case .finished:
                ContentPanel(title: String(localized: "Recently finished"), symbol: "checkmark.circle") {
                    VStack(spacing: WorkspaceStyle.rowGap) { ForEach(recentJobs) { job in JobRow(job: job, selected: store.selectedJob == job.id, store: store) { store.toggleJob(job.id) }.transition(.card) } }
                }
            case .sessions:
                ContentPanel(title: String(localized: "Lead sessions"), symbol: "bubble.left.and.bubble.right") {
                    VStack(spacing: WorkspaceStyle.rowGap) { ForEach(sessions) { session in SessionRow(session: session, selected: store.selectedSession == session.id, store: store) { store.toggleSession(session.id) }.transition(.card) } }
                }
            }
        }
        if emptyHistory || emptyWorkspace {
            EmptyState(title: store.search.isEmpty ? (emptyHistory ? String(localized: "No completed work yet") : String(localized: "Ready when you are")) : String(localized: "No matching work"),
                       symbol: store.search.isEmpty ? "square.stack.3d.up" : "magnifyingglass",
                       detail: store.search.isEmpty && !emptyHistory ? String(localized: "Hand a task to an agent, or run /crew:run in Claude Code or $crew:run in Codex.") : nil) {
                if store.search.isEmpty && !emptyHistory { Button("New Job", systemImage: "plus") { store.showingDispatch = true }.glassPillButton().disabled(!store.connected) }
            }.transition(.card)
        }
        }.animation(Motion.reduced(Motion.reflow, reduceMotion), value: layout)
    }
    private var activity: some View {
        let events = store.scopedEvents.filter { matches("\($0.detail) \($0.agent)") }
        // The page heading already names this list.
        return ContentPanel(title: nil) {
            if events.isEmpty { Text(store.search.isEmpty ? String(localized: "No activity yet.") : String(localized: "No matching activity.")).foregroundStyle(.secondary) }
            EventList(events: events) { store.openJob($0) }
        }
        // On the panel rather than the list, so the panel grows with the rows instead of snapping to its new height.
        .animation(Motion.reduced(Motion.reflow, reduceMotion), value: events.last?.id)
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
                        Spacer(minLength: WorkspaceStyle.rowSpacer)
                        let activity = AgentActivity(store: store, agent: agent)
                        let count = activity.open + activity.jobs
                        // Beside jobs, idle must say sessions, as on the card.
                        let idle = activity.jobs == 0 ? String(localized: "\(activity.idle) idle")
                            : activity.idle == 1 ? String(localized: "1 idle session") : String(localized: "\(activity.idle) idle sessions")
                        let summary = [count > 0 ? String(localized: "\(count) active") : nil, activity.idle > 0 ? idle : nil].compactMap { $0 }
                        if !summary.isEmpty { Text(summary.joined(separator: " · ")).font(Typeface.caption).foregroundStyle(.secondary) }
                        StatusLabel(state: activity.mark, title: activity.title, spins: activity.mark == "working")
                    }
                    if let usage = store.usage, usage.source != "none" { AgentUsageView(store: store, agent: agent) }
                }.padding(.horizontal, WorkspaceStyle.cardPadding).padding(.vertical, Space.l)
                if agent != agents.last { Divider().padding(.leading, WorkspaceStyle.cardPadding + MarkSize.list + Space.ml) }
            }
        }.card(padding: 0)
    }
}

/// A role following its parent to the same holders adds nothing to the overview.
@MainActor func agentRole(_ agent: String, store: CrewStore) -> String {
    let roles = store.state.roles
    let labels = store.state.availableRoles.filter { info in
        guard let assignment = roles[info.role], assignment.holders.contains(agent) else { return false }
        if store.state.roleSettings?[info.role]?.agents == nil, let parent = info.parent, let inherited = roles[parent],
           Set(assignment.holders) == Set(inherited.holders) { return false }
        return true
    }.map(\.localizedLabel)
    // Claude and Codex alike say Lead while one of their sessions is open in this scope, as on the board.
    let leads = store.state.claude.contains { $0.agent == agent && (store.project.isEmpty || $0.projectPath == store.project) }
    return ((leads ? [String(localized: "Lead")] : []) + labels).joined(separator: " · ")
}

/// What an agent has open in this scope: its lead sessions, working or between turns, and its jobs (as the board's agentActivity).
@MainActor private struct AgentActivity {
    var open = 0, idle = 0, jobs = 0
    var mark = "idle"
    var title = ""
    init(store: CrewStore, agent: String) {
        let scoped = { (path: String) in store.project.isEmpty || path == store.project }
        let sessions = store.state.claude.filter { $0.agent == agent && scoped($0.projectPath) }
        let active = sessions.filter { $0.state != "idle" }
        let jobs = store.state.jobs.filter { $0.agent == agent && $0.isActive && scoped($0.projectPath) }
        open = active.count; idle = sessions.count - active.count; self.jobs = jobs.count
        mark = active.contains { $0.state == "waiting" } || jobs.contains { $0.state == "waiting" } ? "waiting"
            : active.contains { $0.stalled } || jobs.contains { $0.stalled } ? "stalled"
            : open + self.jobs > 0 ? "working" : "idle"
        title = mark == "waiting" ? String(localized: "Needs you") : mark == "stalled" ? String(localized: "May be stuck") : mark == "working" ? String(localized: "Working")
            : store.state.agents[agent]?.enabled == false ? String(localized: "Disabled") : String(localized: "Ready")
    }
    /// Sessions and jobs apart, then idle sessions; nil with nothing open.
    var line: String? {
        let parts = [
            open > 0 ? (open == 1 ? String(localized: "1 active session") : String(localized: "\(open) active sessions")) : nil,
            jobs > 0 ? (jobs == 1 ? String(localized: "1 active job") : String(localized: "\(jobs) active jobs")) : nil,
            // Beside active sessions alone "idle" is clear; beside jobs it must say sessions.
            idle > 0 ? (open > 0 && jobs == 0 ? String(localized: "\(idle) idle") : idle == 1 ? String(localized: "1 idle session") : String(localized: "\(idle) idle sessions")) : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

private struct AgentCard: View {
    var store: CrewStore
    var agent: String
    var body: some View {
        let activity = AgentActivity(store: store, agent: agent)
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
                StatusLabel(state: activity.mark, title: activity.title, spins: activity.mark == "working")
            }
            // The agent's work in a gray inset, apart from its name above and its account usage below; with
            // nothing open, the inset is left out rather than saying so.
            if let line = activity.line { Text(line).font(Typeface.callout).monospacedDigit().foregroundStyle(.secondary).inset() }
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
        let tasks = (mission.tasks ?? []).filter { $0.state != "dropped" }
        return [
            tokens > 0 ? String(localized: "\(tokens.formatted()) tokens") : nil,
            store.project.isEmpty ? projectName(mission.root, among: store.projects) : nil,
            jobs.count == 1 ? String(localized: "1 job") : String(localized: "\(jobs.count) jobs"),
            tasks.isEmpty ? nil : String(localized: "\(tasks.filter { $0.state == "done" }.count)/\(tasks.count) tasks"),
            mission.preset.map { localizedCrewLabel($0.rawValue.capitalized) },
        ].compactMap { $0 }.joined(separator: " · ")
    }
    /// Missions from before the daemon recorded their lead fall back to their session while it is still known.
    private var leadAgent: String? { mission.lead ?? store.state.claude.first { $0.id == mission.owner }?.agent }
    var body: some View {
        let leadRow = store.state.leadRow(for: mission)
        let pulls = (store.state.pulls ?? []).filter { $0.mission == mission.id }
        VStack(alignment: .leading, spacing: Space.xl) {
            VStack(alignment: .leading, spacing: Space.xs) {
                // Status and the controls sit on the middle of the title and its meta line together.
                HStack(alignment: .center, spacing: Space.m) {
                    // The lead's mark sits before the title and meta together, the same for every lead.
                    // The header starts as far in as the stop names and outcomes below, which take the same inset
                    // beside their rows: the mark when there is one, else the title.
                    if let leadAgent { AgentMark(agent: leadAgent, size: MarkSize.list).padding(.leading, WorkspaceStyle.rowTitleInset) }
                    VStack(alignment: .leading, spacing: Space.xs) {
                        // One line each, so cards side by side keep the same height whatever their titles.
                        Text(mission.title).font(Typeface.title).fadeTruncated().help(mission.title)
                        HStack(spacing: 0) {
                            if let leadAgent { Text(String(localized: "Led by \(agentName(leadAgent))") + " · ") }
                            ElapsedText(store: store, start: mission.createdAt, end: mission.endedAt)
                            Text(" · " + meta)
                        }.font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary).fadeTruncated().help(mission.root)
                    }
                    .padding(.leading, leadAgent == nil ? WorkspaceStyle.rowTitleInset : 0)
                    Spacer(minLength: WorkspaceStyle.rowSpacer)
                    StatusLabel(state: mission.state == "active" ? "running" : mission.state, title: localizedCrewLabel(mission.state.capitalized), spins: mission.state == "active")
                    if mission.state != "done" { missionMenu }
                    // A filled circle, so the control shows its hit area.
                    Button { toggle() } label: {
                        Image(systemName: "chevron.down").font(Symbol.control)
                            .rotationEffect(.degrees(expanded ? 0 : -90)).frame(width: Symbol.controlFrame, height: Symbol.controlFrame)
                            // Pointing right, the chevron's weight sits left of its frame; a point over centers it optically.
                            .offset(x: expanded ? 0 : Symbol.chevronNudge)
                    }.iconButton().accessibilityLabel(expanded ? String(localized: "Collapse mission") : String(localized: "Expand mission")).help(expanded ? String(localized: "Collapse") : String(localized: "Expand"))
                }
                // The title row opens and closes the card; its button keeps its own click.
                .contentShape(Rectangle())
                .onTapGesture(perform: toggle)
            }
            if expanded {
                VStack(alignment: .leading, spacing: Space.xl) {
                    ForEach(Array((mission.notes ?? []).enumerated()), id: \.offset) { _, note in
                        Text(note.text).font(Typeface.callout).textSelection(.enabled).padding(.leading, WorkspaceStyle.rowTitleInset)
                    }
                    // As far from the title above as from what follows below.
                    MissionTrack(mission: mission).padding(.vertical, Space.l)
                    decisions
                    let shown = mission.stops.indices.filter { index in
                        jobs.contains { mission.jobStep($0) == index } || (index == mission.step && leadRow != nil)
                    }
                    // Left out when empty, so it adds no second gap above the outcome.
                    if !shown.isEmpty {
                        VStack(spacing: WorkspaceStyle.rowGap) {
                            ForEach(shown, id: \.self) { index in
                                let mine = jobs.filter { mission.jobStep($0) == index }
                                let lead = index == mission.step ? leadRow : nil
                                let open = !foldsStages || store.isStageOpen(mission, index, jobs: mine, hasLead: lead != nil)
                                // The first stage sits as far under the track as the track sits under the title.
                                stageLabel(index, count: mine.count, open: open)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, index == shown.first ? 0 : Space.m)
                                if open {
                                    if let lead {
                                        SessionRow(session: lead, selected: store.selectedSession == lead.id, store: store) { store.toggleSession(lead.id) }.transition(.card)
                                    }
                                    ForEach(mine) { job in JobRow(job: job, selected: store.selectedJob == job.id, showsKind: false, store: store) { store.toggleJob(job.id) }.transition(.card) }
                                }
                            }
                        }
                    }
                    outcome
                }
                .transition(reduceMotion ? .opacity : .asymmetric(
                    // In after the card has started to open; out quickly, before the card closes over it.
                    insertion: .modifier(active: Reveal(shown: false), identity: Reveal(shown: true)).animation(Motion.enter),
                    removal: .modifier(active: Reveal(shown: false), identity: Reveal(shown: true)).animation(Motion.leave)))
            }
            // Its menu holds Mark Done, so the card only says so.
            if finished { Text("Looks finished").font(Typeface.caption).foregroundStyle(.secondary) }
            ActionMessage(state: store.actions[mission.actionKey])
            if !pulls.isEmpty {
                // Pull requests sit in a band across the card's foot, below a hairline that runs to the card's edges, whether
                // the card is open or closed. The negative padding runs the hairline out over the card's side padding; the
                // card's own bottom padding keeps the chips as far from its bottom as from its sides.
                ActionRow(spacing: Space.s, leading: true) {
                    ForEach(pulls) { MissionPullChip(pull: $0, now: store.now) }
                }
                .padding(.horizontal, WorkspaceStyle.cardPadding).padding(.top, Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(WorkspaceStyle.hairline).frame(height: 1) }
                .padding(.horizontal, -WorkspaceStyle.cardPadding)
                .padding(.top, WorkspaceStyle.cardPadding - Space.xl)
            }
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
    private var locked: Bool { !store.connected || store.actions[mission.actionKey]?.locked == true }
    /// Every action on the mission. An abandoned one can only be marked done; an active one can also be dropped, and
    /// sets the preset its new jobs take, while jobs already running keep theirs.
    private var missionMenu: some View {
        Menu {
            Button("Mark Done", systemImage: "checkmark.circle") { Task { await store.markDone(mission) } }
            if mission.state == "active" {
                Button("Stop Tracking", systemImage: "xmark.circle") { Task { await store.dismiss(mission) } }
                    .help("Stops tracking without marking done. Its jobs keep running.")
                Divider()
                Picker("Model Preset", selection: Binding(get: { mission.preset }, set: { preset in
                    Task { await store.setPreset(preset, for: mission) }
                })) {
                    Text("Default").tag(nil as PresetName?)
                    ForEach(PresetName.allCases, id: \.self) { preset in
                        Text(localizedCrewLabel(preset.rawValue.capitalized)).tag(Optional(preset))
                    }
                }.pickerStyle(.inline)
            }
        } label: {
            Image(systemName: "ellipsis").font(Symbol.control)
                .frame(width: Symbol.controlFrame, height: Symbol.controlFrame)
        }
        .menuStyle(.button).menuIndicator(.hidden).iconButton().fixedSize()
        .disabled(locked).accessibilityLabel("Mission options").help("Mission options")
    }
    @ViewBuilder private var outcome: some View {
        if !mission.outcome.isEmpty {
            let outcome = switch mission.outcome {
            case "Dismissed in Crew.": String(localized: "Dismissed in Crew.")
            case "Marked done in Crew.": String(localized: "Marked done in Crew.")
            default: mission.outcome
            }
            Text(outcome).font(Typeface.callout).textSelection(.enabled).padding(.leading, WorkspaceStyle.rowTitleInset)
        }
        // The lead's wrap-up of finished work: what changed, what was verified, what is left for the user. Folded until
        // asked for: with several finished cards open, each wrap-up in full buries the cards themselves.
        if mission.state == "done", let summary = mission.summary, !summary.isEmpty {
            let shown = store.summaryExpanded[mission.id] ?? false
            // Its label folds it as a stage's label folds its rows.
            VStack(alignment: .leading, spacing: Space.m) {
                foldLabel(String(localized: "Wrap-up"), open: shown) { store.summaryExpanded[mission.id] = !shown }
                if shown {
                    // A group, as in the board: a label on the text itself would be read in place of the summary.
                    ReportText(report: summary).padding(.leading, WorkspaceStyle.rowTitleInset)
                        .accessibilityElement(children: .contain).accessibilityLabel(String(localized: "Wrap-up"))
                }
            }
        }
    }
    /// One row however many decisions there are, so a long mission's card stays short; the detail panel lists them.
    @ViewBuilder private var decisions: some View {
        if mission.state == "active", let memory = mission.memory, !memory.isEmpty {
            let selected = store.selectedDecisions == mission.id
            Button { store.toggleDecisions(mission.id) } label: {
                HStack(spacing: Space.l) {
                    Image(systemName: "list.bullet.rectangle").font(Symbol.control).foregroundStyle(.secondary).frame(width: WorkspaceStyle.iconColumn)
                    Text("Decisions").font(Typeface.bodyStrong).foregroundStyle(.primary)
                    Spacer(minLength: WorkspaceStyle.rowSpacer)
                    Text(memory.count, format: .number).monospacedDigit().font(Typeface.caption).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(Typeface.micro).foregroundStyle(.tertiary)
                }
                .padding(WorkspaceStyle.rowInsets).contentShape(Rectangle())
                .background(selected ? Palette.selection : WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
            }.buttonStyle(WorkspacePressStyle())
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }
    /// Animated from here rather than inside the card, so the cards below move with it instead of jumping.
    private func toggle() {
        withAnimation(Motion.reduced(Motion.expand, reduceMotion)) { store.missionExpanded[mission.id] = !expanded }
    }
    /// A mission with more jobs than this lets each stage fold from its label.
    static let foldStagesAfter = 1
    private var foldsStages: Bool { jobs.count > Self.foldStagesAfter }
    /// A stop's name; on a folding mission, the button that folds it, with the stage's job count.
    @ViewBuilder private func stageLabel(_ index: Int, count: Int, open: Bool) -> some View {
        if foldsStages {
            foldLabel(mission.stops[index], count: count, open: open) { store.stageExpanded["\(mission.id):\(index)"] = !open }
                .accessibilityLabel(count == 1 ? String(localized: "\(mission.stops[index]), 1 job") : String(localized: "\(mission.stops[index]), \(count) jobs"))
        } else {
            Text(mission.stops[index]).font(Typeface.bodyStrong).foregroundStyle(.secondary)
                .padding(.leading, WorkspaceStyle.rowTitleInset).accessibilityAddTraits(.isHeader)
        }
    }
    /// A label that folds what is under it, a stage's rows or a finished mission's wrap-up: its name, a count when it
    /// has one, and a chevron.
    private func foldLabel(_ title: String, count: Int? = nil, open: Bool, toggle: @escaping () -> Void) -> some View {
        Button {
            withAnimation(Motion.reduced(Motion.expand, reduceMotion)) { toggle() }
        } label: {
            HStack(spacing: Space.s) {
                Text(title).font(Typeface.bodyStrong).foregroundStyle(.secondary)
                if let count { Text(count, format: .number).font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary) }
                Image(systemName: "chevron.down").font(Symbol.badge).foregroundStyle(.secondary)
                    .rotationEffect(.degrees(open ? 0 : -90)).offset(x: open ? 0 : Symbol.chevronNudge)
                    .accessibilityHidden(true)
            }
            .padding(.leading, WorkspaceStyle.rowTitleInset).padding(.vertical, Space.xs).padding(.trailing, Space.l)
            .contentShape(Rectangle())
        }
        .buttonStyle(WorkspacePressStyle())
        // The padding widens the target only; the label stays where an unfolding stage's name sits.
        .padding(.vertical, -Space.xs)
        .accessibilityValue(open ? String(localized: "Expanded") : String(localized: "Collapsed"))
        .accessibilityAddTraits(.isHeader)
    }
}

/// A chip that names a pull request's most urgent status and counts the others the lead must act on; it opens the
/// pull request.
private struct MissionPullChip: View {
    let pull: MissionPull
    let now: Double

    var body: some View {
        let statuses = pull.statuses
        let stale = pull.isStale(now: now)
        // A failed read leaves the last statuses in doubt, so the chip names the failure in their place.
        let unread = stale && pull.error != nil
        let word = unread ? String(localized: "Could not be read") : statuses.first?.localizedWord
        let more = unread ? 0 : statuses.dropFirst().filter(\.needsLead).count
        let checked = elapsed(now - pull.checkedAt)
        let details = ([pull.title] + statuses.map(\.localizedWord) + (unread ? [String(localized: "Could not be read")] : []) + (stale ? [String(localized: "Checked \(checked) ago")] : []))
            .filter { !$0.isEmpty }.joined(separator: " · ")
        Link(destination: pull.url) {
            HStack(spacing: Space.xs) {
                Image(systemName: pull.state == "merged" ? "arrow.triangle.merge" : pull.state == "closed" ? "xmark.circle" : "arrow.triangle.pull")
                Text("#\(pull.number)")
                if let word { Text(word) }
                if more > 0 { Text("+\(more)").fontWeight(.regular) }
                if stale {
                    Image(systemName: "clock")
                    Text(checked)
                }
            }
            .monospacedDigit()
            // Stale statuses keep their words but lose their color.
            .chip(stale ? .secondary : StatusLabel(state: statuses.first?.tone ?? "").color,
                  in: RoundedRectangle(cornerRadius: Chip.squareRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(details)
        .accessibilityLabel("Pull request \(pull.repo) #\(pull.number)\(details.isEmpty ? "" : ": \(details)")")
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
    /// Request cards fill the page in columns of this width.
    private static let requestWidth: ClosedRange<CGFloat> = 420...620
    @Bindable var store: CrewStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private func matches(_ text: String) -> Bool { store.search.isEmpty || text.localizedCaseInsensitiveContains(store.search) }
    private var jobs: [Job] { store.scopedWaitingJobs.filter { matches("\($0.title) \($0.projectPath) \($0.agent) \($0.waiting?.reason ?? "")") } }
    private var sessions: [ClaudeSession] { store.scopedWaitingSessions.filter { matches("\($0.title) \($0.projectPath) \(agentName($0.agent)) \($0.waitingFor ?? "")") } }
    var body: some View {
        let jobs = jobs, sessions = sessions
        // Requests come and go as agents ask and get answered; the cards around them close up or make room.
        Group { content(jobs: jobs, sessions: sessions) }
            .animation(Motion.reduced(Motion.reflow, reduceMotion), value: jobs.map(\.id) + ["sessions"] + sessions.map(\.id))
    }
    @ViewBuilder private func content(jobs: [Job], sessions: [ClaudeSession]) -> some View {
        if store.scopedPendingCount == 0 {
            EmptyState(title: String(localized: "All caught up"), symbol: "checkmark.circle").transition(.card)
        } else if jobs.isEmpty && sessions.isEmpty {
            EmptyState(title: String(localized: "No matching requests"), symbol: "magnifyingglass").transition(.card)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.requestWidth.lowerBound, maximum: Self.requestWidth.upperBound), spacing: WorkspaceStyle.cardGap)], alignment: .leading, spacing: WorkspaceStyle.cardGap) {
            ForEach(jobs) { job in
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: Space.ml) {
                        requestHeader(job.waiting?.type == "approval" ? String(localized: "Approval") : String(localized: "Question"), agent: job.agent, who: agentName(job.agent),
                                      project: job.projectPath, since: job.waiting?.since) { store.openJob(job.id) }
                        Text(job.title).font(Typeface.callout).foregroundStyle(.secondary).lineLimit(2).help(job.title)
                    }
                    AnswerView(store: store, job: job)
                }
                .frame(maxWidth: .infinity, alignment: .leading).card()
                .transition(.card)
            }
            // As on the web board: a lead session is answered in its own app, so its tile says so instead of offering a composer.
            ForEach(sessions) { session in
                VStack(alignment: .leading, spacing: Space.xl) {
                    // Laid out as a job's tile: who on the header, the session's title under it.
                    VStack(alignment: .leading, spacing: Space.ml) {
                        HStack(spacing: Space.ml) {
                            StatusLabel(state: "waiting", title: String(localized: "Input"))
                            HStack(spacing: Space.s) {
                                AgentMark(agent: session.agent, size: MarkSize.inline)
                                Text(verbatim: agentName(session.agent)).lineLimit(1)
                            }.font(Typeface.chip).foregroundStyle(.secondary).help(session.projectPath)
                            Spacer(minLength: WorkspaceStyle.rowSpacer)
                            OpenInAgentButton(session: session)
                        }
                        Text(session.title).font(Typeface.callout).foregroundStyle(.secondary).lineLimit(2).help(session.title)
                    }
                    Text(session.waitingFor ?? String(localized: "\(agentName(session.agent)) needs your input.")).font(Typeface.headline).lineSpacing(4).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                    ClaudeAskView(session: session)
                    if OpenInAgentButton.availableURL(for: session) == nil {
                        Label("Answer in \(agentName(session.agent)).", systemImage: "bubble.left.and.bubble.right").font(Typeface.callout).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).card()
                // The whole tile opens the details, as a row does.
                .contentShape(.rect).onTapGesture { store.toggleSession(session.id) }
                .accessibilityAction(named: "Show Details") { store.openSession(session.id) }
                .transition(.card)
            }
        }
    }
    /// A request tile's first line: what kind of request it is, who asks and from where, how long it has waited, and Details.
    private func requestHeader(_ kind: String, agent: String, who: String, project: String, since: Double? = nil, details: @escaping () -> Void) -> some View {
        HStack(spacing: Space.ml) {
            StatusLabel(state: "waiting", title: kind)
            HStack(spacing: Space.s) {
                AgentMark(agent: agent, size: MarkSize.inline)
                Text(who).lineLimit(1)
            }.font(Typeface.chip).foregroundStyle(.secondary).help(project)
            Spacer(minLength: WorkspaceStyle.rowSpacer)
            // How long the request has waited, as the web board's request cards show.
            if let since {
                ElapsedText(store: store, start: since, end: nil).font(Typeface.chip).monospacedDigit().foregroundStyle(.secondary)
            }
            Button("Details", systemImage: "arrow.up.right", action: details).pillButton()
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

/// Projects live in a sidebar so a long list stays scannable; choosing one scopes every page to it.
struct ProjectSidebar: View {
    @Bindable var store: CrewStore
    var openSettings: () -> Void
    @Environment(AppUpdater.self) private var updater
    var body: some View {
        let projects = store.projects
        // A project's pages show only its own requests, so the sidebar says which other projects have one, as the board's does.
        let waiting = Set(store.state.waitingJobs.map(\.projectPath) + store.state.waitingSessions.map(\.projectPath))
        List(selection: Binding<String?>(
            get: { store.project },
            set: { path in store.project = path ?? "" }
        )) {
            Label("All projects", systemImage: "square.stack").tag("")
            ForEach(projects, id: \.self) { path in
                ProjectRow(name: projectName(path, among: projects), waiting: waiting.contains(path)).tag(path).help(path)
            }
        }
        .listStyle(.sidebar)
        .background(OverlayScrollers())
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Space.xs) {
                // A downloaded update, ready to install with one click.
                if updater.phase == .ready || updater.phase == .installing {
                    Button(action: updater.onInstall) {
                        HStack(spacing: Space.s) {
                            Label(updateTitle, systemImage: "arrow.down.circle.fill")
                            Spacer(minLength: 0)
                            Text(updater.latest ?? "").font(Typeface.caption).monospacedDigit().foregroundStyle(.tint.secondary)
                        }
                        .font(Typeface.bodyStrong)
                        .padding(.horizontal, Space.ml).padding(.vertical, Space.m)
                        .background(Palette.chip(Palette.accent), in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(.tint)
                    .disabled(updater.phase == .installing)
                    .help("Restart Crew to install version \(updater.latest ?? "")")
                }
                Button(action: openSettings) {
                    Label("Settings", systemImage: "gearshape").font(Typeface.bodyStrong)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Space.ml).padding(.vertical, Space.m).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .disabled(store.state.roles.isEmpty).help("Settings (⌘,)")
            }
            .padding(.horizontal, Space.ml).padding(.bottom, Space.ml)
        }
        .navigationSplitViewColumnWidth(min: WorkspaceStyle.sidebarWidth.min, ideal: WorkspaceStyle.sidebarWidth.ideal, max: WorkspaceStyle.sidebarWidth.max)
    }
    private var updateTitle: String {
        // Kept short enough to fit on one line at the narrowest sidebar width; the tooltip says what happens.
        if updater.phase == .ready { return String(localized: "Update Now") }
        guard let jobs = updater.waiting else { return String(localized: "Updating…") }
        return jobs == 1 ? String(localized: "1 job left…") : jobs > 1 ? String(localized: "\(jobs) jobs left…") : String(localized: "Waiting…")
    }
}

extension View {
    /// Places an empty state in the middle of the visible page rather than under the heading.
    func centeredInPage() -> some View {
        frame(maxWidth: .infinity).containerRelativeFrame(.vertical) { height, _ in height * 0.6 }
    }
}

/// A project in the sidebar, with a dot while one of its agents waits on the user.
private struct ProjectRow: View {
    var name: String
    var waiting: Bool
    @Environment(\.backgroundProminence) private var prominence
    var body: some View {
        HStack(spacing: Space.s) {
            Label(name, systemImage: "folder")
            if waiting {
                Spacer(minLength: 0)
                // White on the selected row's accent, as the Settings sidebar's update dot turns.
                Circle().fill(prominence == .increased ? AnyShapeStyle(.white) : AnyShapeStyle(Palette.warning))
                    .frame(width: Symbol.indicator, height: Symbol.indicator).accessibilityLabel("Needs you")
            }
        }
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

/// The detail panel's leading edge: dragged, it resizes the panel within its range; double-clicked, it returns the
/// panel to its default width. A faint grip shows on hover so the edge reads as something to take hold of.
private struct PanelResizeHandle: View {
    @Bindable var store: CrewStore
    let page: CGFloat
    /// The width a drag began from; a gesture state, so a drag the system cancels leaves nothing behind.
    @GestureState private var start: CGFloat?
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let grip = CGSize(width: 5, height: 44)
    private static let step: CGFloat = 40
    var body: some View {
        let width = WorkspaceStyle.panelWidth(store.panelWidth, page: page)
        Rectangle().fill(.clear)
            .frame(width: WorkspaceStyle.panelHandleWidth)
            .overlay {
                Capsule().fill(.secondary.opacity(start != nil ? 0.5 : 0.3))
                    .frame(width: Self.grip.width, height: Self.grip.height)
                    .opacity(hovering || start != nil ? 1 : 0)
                    .animation(Motion.reduced(Motion.fade, reduceMotion), value: hovering || start != nil)
            }
            .contentShape(Rectangle())
            .pointerStyle(.frameResize(position: .leading))
            .onHover { hovering = $0 }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .updating($start) { _, start, _ in if start == nil { start = width } }
                    .onChanged { drag in
                        // Dragging left widens the panel, which grows from the window's trailing edge.
                        let from = start ?? width
                        var instant = Transaction(); instant.disablesAnimations = true
                        withTransaction(instant) { store.panelWidth = WorkspaceStyle.panelWidth(from - drag.translation.width, page: page) }
                    }
                    .onEnded { _ in store.persistPanelWidth() }
            )
            .onTapGesture(count: 2) {
                withAnimation(Motion.reduced(Motion.panel, reduceMotion)) { store.panelWidth = WorkspaceStyle.panelWidth }
                store.persistPanelWidth()
            }
            .accessibilityElement()
            .accessibilityLabel("Details width")
            .accessibilityValue("\(Int(width)) points")
            .accessibilityAdjustableAction { direction in
                let change: CGFloat = direction == .increment ? Self.step : direction == .decrement ? -Self.step : 0
                store.panelWidth = WorkspaceStyle.panelWidth(width + change, page: page)
                store.persistPanelWidth()
            }
    }
}
