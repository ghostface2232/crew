import AppKit
import Observation

struct ActionState: Sendable {
    var pending = false
    var accepted = false
    var error: String?
    var locked: Bool { pending || accepted }
}
struct Reply: Encodable, Sendable {
    var request_id: String?
    var decision: String?
    var message: String?
}
struct JobSubmission: Encodable, Sendable {
    var kind: String?
    var role: String
    var agent: String?
    var cwd: String
    var project: String
    var task: String
    var isolation = "worktree"
    var targets: [String]?
    var review: Review?
    init(role: RoleInfo, cwd: String, project: String, task: String, targets: [String]? = nil, agent: String? = nil) {
        self.role = role.role; self.agent = agent
        kind = roleOrder.contains(role.role) ? role.kind : nil
        self.cwd = cwd; self.project = project; self.task = task; self.targets = targets
        review = role.kind == "review" ? Review() : nil
    }
    struct Review: Encodable, Sendable {
        var target = Target()
        var mode = "adversarial"
        struct Target: Encodable, Sendable { var type = "uncommittedChanges" }
    }
}
struct PresetSelection: Encodable, Sendable {
    var preset: PresetName?
    enum CodingKeys: String, CodingKey { case preset }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(preset, forKey: .preset)
    }
}

@MainActor @Observable
final class CrewStore {
    /// The daemon's state as last heard. Updates that change what is shown where run inside `Motion.arrive`,
    /// so views need not track which changes to animate.
    var state: BoardState {
        get { board }
        set {
            if newValue.rearranges(board) { Motion.arrive { board = newValue } } else { board = newValue }
        }
    }
    private var board = BoardState() {
        didSet {
            let pending = board.pendingCount
            if pending != pendingCount { pendingCount = pending }
        }
    }
    // Kept apart from `state` so the frequent event and usage updates only redraw the views that show them.
    var events: [CrewEvent] = []
    var limits: [String: LimitUsage?] = [:]
    var usage: Usage?
    /// `state.pendingCount`, kept by `state` itself and written only when it changes: the menu bar item redraws its
    /// image whenever its label is evaluated again, which reading `state` would cause on every event.
    private(set) var pendingCount = 0
    var signInRequired = false
    var connected = false
    var connectionMessage = String(localized: "Connecting to Crew…")
    var revision = 0
    var clockSkew: Double = 0
    var selection: String? = "overview" {
        didSet { if selection != oldValue { closeDetail() } }
    }
    var project: String = "" {
        didSet { if project != oldValue { closeDetail() } }
    }
    var selectedJob: String?
    /// A Claude session shown in the detail panel instead of a job; at most one of the three is set.
    var selectedSession: String?
    /// The mission whose decisions the detail panel lists instead of a job or a session.
    var selectedDecisions: String?
    var detailOpen: Bool { selectedJob != nil || selectedSession != nil || selectedDecisions != nil }
    func closeDetail() { selectedJob = nil; selectedSession = nil; selectedDecisions = nil }
    func openSession(_ id: String, navigate: Bool = false) {
        if navigate {
            search = ""
            project = state.claude.first(where: { $0.id == id })?.projectPath ?? ""
            selection = "overview"
        }
        closeDetail()
        selectedSession = id
    }
    /// A row clicked again closes the panel it opened.
    func toggleJob(_ id: String) { if selectedJob == id { closeDetail() } else { openJob(id) } }
    func toggleSession(_ id: String) { if selectedSession == id { closeDetail() } else { openSession(id) } }
    func toggleDecisions(_ mission: String) { if selectedDecisions == mission { closeDetail() } else { closeDetail(); selectedDecisions = mission } }
    var search = ""
    var searchRequest = 0
    var showingDispatch = false
    /// A task New Job opens with once, such as an issue the user chose to start from.
    var dispatchDraft: String?
    /// Opens New Job on the issue's project with the issue as its task, for the user to check and send.
    func startWork(on issue: IssueList.Issue) {
        dispatchDraft = "Work on issue #\(issue.number): \(issue.title)\n\n\(issue.url)"
        showingDispatch = true
    }
    /// The first-run guide (`WelcomeView`): owed once after a first install (`welcomePending`), or opened from Help.
    var showingWelcome = false
    static let welcomePending = "welcomePending"
    func markWelcomed() { defaults.removeObject(forKey: Self.welcomePending) }
    /// Shows the guide a first install owes, once the daemon has answered.
    private func greetIfNew() {
        if defaults.bool(forKey: Self.welcomePending) { showingWelcome = true }
    }
    var actions: [String: ActionState] = [:]
    var drafts: [String: String] = [:]
    /// Missions the user opened or closed; the rest are open while active. Kept here rather than in each card,
    /// so a card keeps its state when the layout moves it between one column and two.
    var missionExpanded: [String: Bool] = [:]
    func isExpanded(_ mission: Mission) -> Bool { missionExpanded[mission.id] ?? (mission.state == "active") }
    /// Stages the user opened or folded, by mission and stop, kept as a mission's state is.
    var stageExpanded: [String: Bool] = [:]
    /// Wrap-ups the user opened or folded, by mission, kept as a mission's state is; folded by default.
    var summaryExpanded: [String: Bool] = [:]
    /// Whether a folding mission shows a stage's rows: the user's pick, or else `stageOpensByDefault`.
    func isStageOpen(_ mission: Mission, _ index: Int, jobs: [Job], hasLead: Bool) -> Bool {
        stageExpanded["\(mission.id):\(index)"] ?? stageOpensByDefault(mission, index, jobs: jobs, hasLead: hasLead)
    }
    /// A stage with this many jobs or fewer stays open by default, as reopening each one would cost more than it saves.
    static let stageOpensUpTo = 3
    /// A busy stage the mission has moved past folds once nothing in it is live or selected. `jobs` are the stage's own.
    func stageOpensByDefault(_ mission: Mission, _ index: Int, jobs: [Job], hasLead: Bool) -> Bool {
        jobs.count <= Self.stageOpensUpTo || index >= mission.step || hasLead
            || jobs.contains { $0.isActive || $0.waiting != nil || selectedJob == $0.id }
    }
    var notificationsAllowed = false
    private var completionLeases = CompletionLeases()
    var windowVisible = true
    /// The full-screen toolbar's height, or 0 outside full screen.
    var fullScreenToolbarHeight: CGFloat = 0
    var displayTime = Date().timeIntervalSince1970 * 1000
    var onStateChange: (() -> Void)?
    let api: CrewAPI
    let defaults: UserDefaults
    private var streamTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var generation = 0
    private var jobVersions: [String: Int] = [:]

    init(api: CrewAPI = CrewAPI(), defaults: UserDefaults = .standard) {
        self.api = api; self.defaults = defaults
        let page = defaults.string(forKey: "selection") ?? "overview"
        let legacyPrefix = "project:"
        if page.hasPrefix(legacyPrefix) {
            project = String(page.dropFirst(legacyPrefix.count))
            persistSelection()
        } else {
            selection = ["overview", "needs", "activity", "history"].contains(page) ? page : "overview"
            project = defaults.string(forKey: "project") ?? ""
        }
        let saved = defaults.double(forKey: "panelWidth")
        panelWidth = saved > 0 ? saved : WorkspaceStyle.panelWidth
        api.onSignInFailure = { [weak self] error in self?.connectionFailed(error) }
    }
    var now: Double { displayTime + clockSkew }
    var projects: [String] { Array(Set(state.projectPaths + (project.isEmpty ? [] : [project]))).sorted() }
    var scopedWaitingJobs: [Job] { state.waitingJobs.filter { project.isEmpty || $0.projectPath == project } }
    var scopedWaitingSessions: [ClaudeSession] { state.waitingSessions.filter { project.isEmpty || $0.projectPath == project } }
    var scopedPendingCount: Int { project.isEmpty ? pendingCount : scopedWaitingJobs.count + scopedWaitingSessions.count }
    var scopedEvents: [CrewEvent] {
        guard !project.isEmpty else { return events }
        let jobs = Dictionary(state.jobs.map { ($0.id, $0.projectPath) }, uniquingKeysWith: { first, _ in first })
        let sessions = Dictionary(state.claude.map { ($0.id, $0.projectPath) }, uniquingKeysWith: { first, _ in first })
        let known = Set(state.projectPaths + [project])
        var owners: [String: String] = [:]
        // The innermost known project a recorded folder sits in, so a nested repository keeps its own events.
        let owner = { (path: String) -> String in
            if let found = owners[path] { return found }
            let found = known.filter { Self.path(path, isInside: $0) }.max { $0.count < $1.count } ?? ""
            owners[path] = found
            return found
        }
        let nonEmpty = { (path: String?) in path.flatMap { $0.isEmpty ? nil : $0 } }
        return events.filter { event in
            // A live job or session wins: a session may have resolved its root since recording the event.
            if let live = nonEmpty(event.job_id.flatMap { jobs[$0] }) ?? nonEmpty(event.session_id.flatMap { sessions[$0] }) {
                return live == project
            }
            // A session's first events carry its folder until git names the root, so a recorded folder counts for
            // the innermost known project it sits in, as on the board (`eventsIn`).
            return owner(event.project ?? "") == project
        }
    }
    /// Whether a path is a project's folder or inside it, in either platform's separators.
    nonisolated static func path(_ path: String, isInside project: String) -> Bool {
        var base = Substring(project)
        while base.last == "/" || base.last == "\\" { base.removeLast() }
        guard path.hasPrefix(base) else { return false }
        let rest = path.dropFirst(base.count)
        return rest.isEmpty || rest.first == "/" || rest.first == "\\"
    }
    func persistSelection() {
        defaults.set(selection, forKey: "selection")
        defaults.set(project, forKey: "project")
    }
    /// The detail panel's width as the user last dragged it, kept across launches.
    var panelWidth: CGFloat = WorkspaceStyle.panelWidth
    func persistPanelWidth() { defaults.set(Double(panelWidth), forKey: "panelWidth") }
    func openJob(_ id: String, navigate: Bool = false) {
        if navigate {
            search = ""
            project = state.jobs.first(where: { $0.id == id })?.projectPath ?? ""
            selection = "overview"
        }
        selectedSession = nil
        selectedDecisions = nil
        selectedJob = id
    }
    func start() {
        generation += 1
        let attempt = generation
        streamTask?.cancel(); heartbeatTask?.cancel()
        streamTask = Task { [self] in
            var backoff: UInt64 = 1
            while !Task.isCancelled && attempt == generation {
                do {
                    try await DaemonLauncher.start()
                    try await api.stream { [weak self] event in
                        try self?.receive(event, generation: attempt)
                    }
                } catch {
                    guard !Task.isCancelled, attempt == generation else { return }
                    if connected { backoff = 1 }
                    connectionFailed(error)
                    if signInRequired { backoff = max(backoff, 5) }
                }
                try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                backoff = min(backoff * 2, 10)
            }
        }
        heartbeatTask = Task {
            while !Task.isCancelled && attempt == generation {
                if windowVisible { displayTime = Date().timeIntervalSince1970 * 1000 }
                if connected && notificationsAllowed {
                    await sendHeartbeat()
                }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }
    func connectionFailed(_ error: Error) {
        Motion.arrive {
            connected = false
            signInRequired = error is DaemonSignInFailure
            connectionMessage = error.localizedDescription
        }
    }
    func stop() { generation += 1; streamTask?.cancel(); heartbeatTask?.cancel() }
    func sendHeartbeat() async {
        struct Heartbeat: Encodable, Sendable { var handlesCompletion = true }
        if let lease: DesktopLease = try? await api.post("/api/desktop/heartbeat", Heartbeat(), timeout: 4) {
            completionLeases.accept(lease)
        }
    }
    /// Hands notifications back to the daemon before the app quits.
    func sendDeparture() async {
        struct Departure: Encodable, Sendable { var leaving = true }
        let _: EmptyReply? = try? await api.post("/api/desktop/heartbeat", Departure(), timeout: 1)
    }
    func ownsCompletion(at timestamp: Double) -> Bool { completionLeases.owns(timestamp) }
    func receive(_ event: ServerEvent, generation attempt: Int? = nil) throws {
        if let attempt, attempt != generation { return }
        switch event.name {
        case "desktopLease":
            completionLeases.accept(try JSONDecoder().decode(DesktopLease.self, from: event.data))
            return
        case "event":
            events = mergeEvents(events, [try JSONDecoder().decode(CrewEvent.self, from: event.data)])
            return
        case "usage":
            let latest = try JSONDecoder().decode(Usage.self, from: event.data)
            Motion.arrive { usage = latest }
            return
        case "turnTokenBudget": turnTokenBudgetRevision += 1
        case "projects": projectsRevision += 1
        case "state":
            turnTokenBudgetRevision += 1
            projectsRevision += 1
        case "limits":
            let latest = try JSONDecoder().decode([String: LimitUsage?].self, from: event.data)
            Motion.arrive { limits.merge(latest) { _, new in new } }
            return
        default: break
        }
        guard event.name == "state" else {
            if let id = try state.receive(event) { jobVersions[id, default: 0] += 1 }
            // A daemon that predates the setting says nothing about it, which must not clear what Crew wrote.
            if event.name == "language" && state.hasLanguageSetting == true { applyLanguage(state.language) }
            onStateChange?()
            return
        }
        // A snapshot brings everything at once, the connection with it, so all of it arrives as one change.
        try Motion.arrive {
            try state.receive(event)
            if state.hasLanguageSetting == true { applyLanguage(state.language) }
            events = state.events; limits = state.limits; usage = state.usage
            board.events = []; board.limits = [:]; board.usage = nil
            for id in Set(jobVersions.keys).union(state.jobs.map(\.id)) { jobVersions[id, default: 0] += 1 }
            signInRequired = false; connected = true; connectionMessage = String(localized: "Connected")
            greetIfNew()
            clockSkew = state.now - Date().timeIntervalSince1970 * 1000
            displayTime = Date().timeIntervalSince1970 * 1000
            revision += 1
            // A reconnect replaces history; stale request locks no longer need to be retained.
            let live = Set(state.waitingJobs.map(\.requestKey))
            actions = actions.filter { !$0.key.hasPrefix("answer:") || live.contains($0.key) || $0.value.pending }
        }
        onStateChange?()
    }
    func run(_ key: String, once: Bool = false, operation: () async throws -> Void) async {
        guard actions[key]?.locked != true else { return }
        actions[key] = ActionState(pending: true)
        do {
            try await operation()
            actions[key] = ActionState(accepted: once)
        } catch { actions[key] = ActionState(error: error.localizedDescription) }
    }
    func answer(_ job: Job, decision: String? = nil, message: String? = nil) async {
        guard let waiting = job.waiting else { return }
        await run(job.requestKey, once: true) {
            let version = jobVersion(job.id)
            let updated: Job = try await api.post("/api/jobs/\(job.id)/reply", Reply(request_id: waiting.id, decision: decision, message: message))
            applyJob(updated, since: version)
            drafts[job.requestKey] = nil
        }
    }
    func followUp(_ job: Job) async {
        let key = "followup:\(job.id)"
        let draft = drafts[key] ?? ""
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        await run(key) {
            let version = jobVersion(job.id)
            // The daemon titles a turn by its first line.
            let updated: Job = try await api.post("/api/jobs/\(job.id)/reply", Reply(message: draft.trimmingCharacters(in: .whitespacesAndNewlines)))
            applyJob(updated, since: version)
            if drafts[key] == draft { drafts[key] = "" }
        }
    }
    func cancel(_ job: Job) async {
        await run("cancel:\(job.id):\(job.turns)", once: true) {
            let version = jobVersion(job.id)
            let updated: Job = try await api.post("/api/jobs/\(job.id)/cancel", EmptyReply())
            applyJob(updated, since: version)
        }
    }
    func dismiss(_ mission: Mission) async {
        struct Dismiss: Encodable, Sendable { var abandoned = true; var outcome = "Dismissed in Crew." }
        await run(mission.actionKey, once: true) {
            let updated: Mission = try await api.post("/api/missions/\(mission.id)", Dismiss())
            upsert(&state.missions, updated)
        }
    }
    func markDone(_ mission: Mission) async {
        // An abandoned mission is reopened explicitly, so only this choice of the user's can mark it done.
        struct Done: Encodable, Sendable { var done = true; var reopen: Bool?; var outcome = "Marked done in Crew." }
        await run(mission.actionKey, once: true) {
            let updated: Mission = try await api.post("/api/missions/\(mission.id)", Done(reopen: mission.state == "abandoned" ? true : nil))
            upsert(&state.missions, updated)
        }
    }
    func setPreset(_ preset: PresetName?, for mission: Mission) async {
        guard mission.state == "active" else { return }
        await run(mission.actionKey) {
            let updated: Mission = try await api.post("/api/missions/\(mission.id)", PresetSelection(preset: preset))
            upsert(&state.missions, updated)
        }
    }
    static let peerRatingsKey = "peer-ratings"
    func setPeerRatings(_ enabled: Bool) async {
        struct Change: Encodable, Sendable { var enabled: Bool }
        struct Saved: Decodable, Sendable { var peerRatings: Bool }
        await run(Self.peerRatingsKey) {
            let saved: Saved = try await api.post("/api/peer-ratings", Change(enabled: enabled))
            state.peerRatings = saved.peerRatings
        }
    }
    static let progressCardsKey = "progress-cards"
    func setProgressCards(_ enabled: Bool) async {
        struct Change: Encodable, Sendable { var enabled: Bool }
        struct Saved: Decodable, Sendable { var progressCards: Bool }
        await run(Self.progressCardsKey) {
            let saved: Saved = try await api.post("/api/progress-cards", Change(enabled: enabled))
            state.progressCards = saved.progressCards
        }
    }
    static let turnTokenBudgetKey = "turn-token-budget"
    /// Counts budgets received from the daemon, so a save's reply does not undo a newer one that arrived meanwhile.
    private var turnTokenBudgetRevision = 0
    func setTurnTokenBudget(_ budget: TurnTokenBudget) async {
        struct Change: Encodable, Sendable { var budget: TurnTokenBudget }
        struct Saved: Decodable, Sendable { var turnTokenBudget: TurnTokenBudget }
        await run(Self.turnTokenBudgetKey) {
            let revision = turnTokenBudgetRevision
            let saved: Saved = try await api.post("/api/turn-token-budget", Change(budget: budget))
            if turnTokenBudgetRevision == revision { state.turnTokenBudget = saved.turnTokenBudget }
        }
    }
    static func projectSwitchKey(_ project: String) -> String { "project-settings:\(project)" }
    /// As for the budget: a save's reply does not undo switches that arrived from the stream meanwhile.
    private var projectsRevision = 0
    /// One of a project's switches, saved as it is flipped, as in the board.
    func setProjectSwitch(_ project: String, _ key: String, on: Bool) async {
        struct Change: Encodable, Sendable { var project: String; var changes: [String: Bool] }
        struct Saved: Decodable, Sendable { var projects: [String: ProjectSettings] }
        await run(Self.projectSwitchKey(project)) {
            let revision = projectsRevision
            let saved: Saved = try await api.post("/api/project-settings", Change(project: project, changes: [key: on]))
            if projectsRevision == revision { state.projects = saved.projects }
        }
    }
    static func projectIconKey(_ project: String) -> String { "project-icon:\(project)" }
    /// The latest pick made while a project's icon save is in flight, sent once that save lands so it is not lost.
    private var queuedIcons: [String: String?] = [:]
    /// A project's sidebar icon, or nil for the folder; a save of its own, so picking icons leaves the switches free.
    func setProjectIcon(_ project: String, _ icon: String?) async {
        let key = Self.projectIconKey(project)
        if actions[key]?.pending == true { queuedIcons[project] = .some(icon); return }
        // A nil value is sent as JSON null, which the daemon reads as the folder.
        struct Change: Encodable, Sendable { var project: String; var changes: [String: String?] }
        struct Saved: Decodable, Sendable { var projects: [String: ProjectSettings] }
        await run(key) {
            let revision = projectsRevision
            let saved: Saved = try await api.post("/api/project-settings", Change(project: project, changes: ["icon": icon]))
            if projectsRevision == revision { state.projects = saved.projects }
        }
        if let next = queuedIcons.removeValue(forKey: project) { await setProjectIcon(project, next) }
    }
    /// Drops a decision the user no longer wants later jobs of the mission to follow.
    func forget(_ entry: MissionMemory, in mission: Mission) async {
        struct Forget: Encodable, Sendable { var forget: [String] }
        await run(mission.actionKey) {
            let updated: Mission = try await api.post("/api/missions/\(mission.id)", Forget(forget: [entry.key]))
            upsert(&state.missions, updated)
        }
    }
    /// What Resume sends a stopped worker; workers read English, whatever language the app is in.
    static let resumeMessage = "Continue where you stopped."
    func resume(_ job: Job) async {
        await run("followup:\(job.id)") {
            let version = jobVersion(job.id)
            let updated: Job = try await api.post("/api/jobs/\(job.id)/reply", Reply(message: Self.resumeMessage))
            applyJob(updated, since: version)
        }
    }
    /// Each project's issue suggestions as last read; the daemon keeps each answer ten minutes.
    var issues: [String: IssueList] = [:]
    func loadIssues(_ project: String) async {
        var components = URLComponents()
        components.path = "/api/issues"
        components.queryItems = [URLQueryItem(name: "project", value: project)]
        // URLQueryItem leaves "+" as it is, which the daemon would read as a space in the path.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        if let found: IssueList = try? await api.request(components.string!) { Motion.arrive { issues[project] = found } }
    }
    /// The setup checklist as last read, shown on all projects' overview (`SetupCard`).
    var setup: SetupState?
    func loadSetup() async {
        if let next: SetupState = try? await api.request("/api/setup", timeout: SetupState.timeout) { Motion.arrive { setup = next } }
    }
    func dismissIssue(_ url: String, project: String) async {
        struct Dismiss: Encodable, Sendable { var url: String }
        await run("issue:\(url)") {
            let _: EmptyReply = try await api.post("/api/issues/dismiss", Dismiss(url: url))
            Motion.arrive { issues[project]?.issues.removeAll { $0.url == url } }
        }
    }
    static let languageKey = "language"
    func setLanguage(_ language: String?) async {
        await run(Self.languageKey) {
            let saved: LanguageState = try await api.post("/api/language", LanguageState(language: language))
            state.language = saved.language
            applyLanguage(saved.language)
        }
    }
    /// What the app last wrote to AppleLanguages, so that only its own write is undone.
    static let appliedLanguageKey = "appliedLanguage"
    /// Keeps the app's own language list, which macOS reads as the app opens, on the language setting. Without a
    /// setting the app follows macOS, including a language chosen for Crew in System Settings, which is kept unless
    /// the setting wrote over it.
    func applyLanguage(_ language: String?) {
        if let language {
            defaults.set([language], forKey: "AppleLanguages")
            defaults.set(language, forKey: Self.appliedLanguageKey)
        } else if let applied = defaults.string(forKey: Self.appliedLanguageKey) {
            // A language picked in System Settings since replaced Crew's and is not Crew's to clear.
            if defaults.stringArray(forKey: "AppleLanguages") == [applied] { defaults.removeObject(forKey: "AppleLanguages") }
            defaults.removeObject(forKey: Self.appliedLanguageKey)
        }
    }
    func setRound(_ job: Job, turn: Int, undo: Bool) async {
        guard job.roundUnavailableReason == nil else { return }
        struct Change: Encodable, Sendable { var undo: Bool?; var keep: Bool? }
        await run(job.roundActionKey(turn)) {
            let version = jobVersion(job.id)
            let updated: Job = try await api.post("/api/jobs/\(job.id)/rounds/\(turn)", Change(undo: undo ? true : nil, keep: undo ? nil : true))
            applyJob(updated, since: version)
        }
    }
    func submitQuestion(_ text: String, project: String, agent: String? = nil) async throws -> Job {
        struct Question: Encodable, Sendable { var role = "delegate"; var kind = "delegate"; var ask = true; var task: String; var cwd: String; var agent: String? }
        let job: Job = try await api.post("/api/jobs", Question(task: text, cwd: project, agent: agent))
        applyJob(job, since: 0)
        return job
    }
    func addInformation(_ text: String, mission: String?, project: String?) async throws {
        if let mission {
            struct Note: Encodable, Sendable { var note: String }
            let updated: Mission = try await api.post("/api/missions/\(mission)", Note(note: text))
            upsert(&state.missions, updated)
        } else {
            struct Append: Encodable, Sendable {
                var append: String
                var project: String?
                enum CodingKeys: String, CodingKey { case append, project }
                func encode(to encoder: Encoder) throws {
                    var values = encoder.container(keyedBy: CodingKeys.self)
                    try values.encode(append, forKey: .append)
                    try values.encode(project, forKey: .project)
                }
            }
            let _: Instructions = try await api.post("/api/instructions", Append(append: text, project: project))
        }
    }
    func jobVersion(_ id: String) -> Int { jobVersions[id, default: 0] }
    func applyJob(_ job: Job, since version: Int? = nil) {
        if let version, version != jobVersion(job.id) { return }
        // An HTTP response can arrive after a newer SSE update.
        if let current = state.jobs.first(where: { $0.id == job.id }), current.seq > job.seq { return }
        upsert(&state.jobs, job)
        jobVersions[job.id, default: 0] += 1
        onStateChange?()
    }
}

@MainActor @Observable
final class SettingsModel {
    var roleSettings: [String: RoleSetting] = [:]
    var savedRoleSettings: [String: RoleSetting] = [:]
    let roleInfo: [RoleInfo]
    var preset: PresetName?
    var savedPreset: PresetName?
    var presets: [String: Preset]?
    var savingPreset = false
    var presetStatus = ""
    var scope = ""
    var text = ""
    var savedText = ""
    var loaded = false
    var loading = false
    var savingText = false
    var savingRoles = false
    var textStatus = ""
    var roleStatus = ""
    /// Why the last change to the roles or to the preset could not be stored; empty once one has been.
    var roleError = ""
    var presetError = ""
    /// The role last changed, under whose rows `roleError` shows.
    private(set) var changedRole: String?
    /// The table and the resolved roles as Settings opened. Stored changes lag the form by one request, so a role is
    /// resolved, and returns to writing no holders, against these rather than the last stored.
    private let openedRoleSettings: [String: RoleSetting]
    private let openedRoles: [String: RoleAssignment]
    /// Each agent's settings as it was turned off in a role (`role:agent`), to bring back if it is turned on again.
    private var dropped: [String: RoleAgentSettings] = [:]
    /// A model or effort being typed by hand, named by its role, agent, and whether it is the model.
    struct TypedField: Hashable {
        let role: String; let agent: String; let model: Bool
        var key: WritableKeyPath<RoleAgentSettings, String?> { model ? \.model : \.effort }
    }
    /// Text typed into those fields and not yet committed. It stays out of `roleSettings`, so a store already under
    /// way never sends half a name and a failed one does not take the typing back; closing asks about it.
    private(set) var drafts: [TypedField: String] = [:]
    private var generation = 0
    private let api: CrewAPI
    var rolesDirty: Bool { Self.normalized(roleSettings) != Self.normalized(savedRoleSettings) }
    var dirty: Bool { text != savedText || rolesDirty || drafts.contains { $0.value != stored($0.key) } || preset != savedPreset }
    var busy: Bool { savingText || savingRoles || savingPreset }
    init(api: CrewAPI, roles: [String: RoleAssignment], roleSettings: [String: RoleSetting]? = nil, roleInfo: [RoleInfo]? = nil, preset: PresetName? = nil, presets: [String: Preset]? = nil) {
        self.api = api
        self.roleInfo = roleInfo ?? RoleInfo.legacy
        let table = Self.normalized(roleSettings ?? roles.mapValues(RoleSetting.init))
        self.roleSettings = table; self.savedRoleSettings = table
        self.openedRoleSettings = table; self.openedRoles = roles
        self.preset = preset; self.savedPreset = preset; self.presets = presets
    }
    /// Compare and save the same canonical table the daemon stores.
    static func normalized(_ table: [String: RoleSetting]) -> [String: RoleSetting] {
        table.compactMapValues { setting in
            let clean = setting.normalized
            return clean == RoleSetting() ? nil : clean
        }
    }
    func followsParent(_ role: String) -> Bool {
        roleInfo.first { $0.role == role }?.parent != nil && roleSettings[role]?.agents == nil
    }
    func canToggleHolder(_ role: String, holder: String) -> Bool {
        guard !followsParent(role), let assignment = assignment(for: role) else { return false }
        let held = assignment.holders.contains(holder)
        return assignment.holders != [holder] && (held || roleInfo.first { $0.role == role }?.unable?.contains(holder) != true)
    }
    func inheritedValue(_ role: String, agent: String, _ key: KeyPath<RoleAgentSettings, String?>) -> String? {
        guard followsParent(role), let parent = roleInfo.first(where: { $0.role == role })?.parent,
              let assignment = assignment(for: parent) else { return nil }
        return RoleSetting(assignment)[agent]?[keyPath: key]
    }
    func blankTitle(_ role: String, agent: String, _ key: KeyPath<RoleAgentSettings, String?>, models: [ModelChoice]) -> String {
        guard let value = inheritedValue(role, agent: agent, key), !value.isEmpty,
              let parent = roleInfo.first(where: { $0.role == role })?.parent else { return String(localized: "Agent default") }
        let name = key == \.model ? models.first { $0.id == value }?.name ?? value : localizedCrewLabel(value)
        let label = roleInfo.first { $0.role == parent }?.localizedLabel ?? parent
        return String(localized: "\(name) (same as \(label))")
    }
    func fieldChoices(_ role: String, agent: String, _ key: KeyPath<RoleAgentSettings, String?>, models: [ModelChoice]) -> [ModelChoice] {
        var choices = models
        if key == \.effort {
            let model = roleSettings[role]?[agent]?.model.flatMap { $0.isEmpty ? nil : $0 }
                ?? inheritedValue(role, agent: agent, \.model)
            // A model that lists no efforts says nothing about them, so every offered effort stays a choice.
            let listed = models.first { $0.id == model }?.efforts ?? []
            let efforts = listed.isEmpty ? models.flatMap { $0.efforts ?? [] } : listed
            choices = []
            for effort in efforts where !choices.contains(where: { $0.id == effort }) {
                choices.append(ModelChoice(id: effort, name: localizedCrewLabel(effort)))
            }
        }
        if let value = roleSettings[role]?[agent]?[keyPath: key], !value.isEmpty, !choices.contains(where: { $0.id == value }) {
            choices.append(ModelChoice(id: value, name: key == \.model ? value : localizedCrewLabel(value)))
        }
        return choices
    }
    func setFollowParent(_ role: String, enabled: Bool) {
        guard let parent = roleInfo.first(where: { $0.role == role })?.parent,
              followsParent(role) != enabled, let inherited = assignment(for: parent) else { return }
        var setting = roleSettings[role] ?? RoleSetting()
        setting.agents = enabled ? nil : inherited.holders
        storeRole(role, setting)
    }
    func setHolder(_ role: String, holder: String, enabled: Bool) {
        guard RoleAssignment.holderOrder.contains(holder), canToggleHolder(role, holder: holder),
              let assignment = assignment(for: role), assignment.holders.contains(holder) != enabled else { return }
        var holders = assignment.holders
        if enabled { holders.append(holder) } else {
            guard holders.count > 1 else { return }
            holders.removeAll { $0 == holder }
        }
        var setting = roleSettings[role] ?? RoleSetting()
        setting.agents = RoleAssignment.holderOrder.filter { holders.contains($0) }
        let key = "\(role):\(holder)"
        if enabled {
            setting[holder] = setting[holder] ?? dropped[key]
        } else {
            dropped[key] = setting[holder]
            setting[holder] = nil
            drafts = drafts.filter { $0.key.role != role || $0.key.agent != holder }
        }
        // A root with no written holders returns to that form when its original holders are checked again.
        if roleInfo.first(where: { $0.role == role })?.parent == nil,
           openedRoleSettings[role]?.agents == nil, setting.agents == openedRoles[role]?.holders {
            setting.agents = nil
        }
        storeRole(role, setting)
    }
    /// What a typed field shows: its draft, or the value in the table.
    func typed(_ field: TypedField) -> String { drafts[field] ?? stored(field) }
    func type(_ field: TypedField, _ text: String) { drafts[field] = text == stored(field) ? nil : text }
    private func stored(_ field: TypedField) -> String { roleSettings[field.role]?[field.agent]?[keyPath: field.key] ?? "" }
    /// Drops what was typed, for Don't Save: a field that gives up focus as the window goes then commits nothing.
    func discardDrafts() { drafts = [:] }
    /// Moves a field's draft into the table, on Return or when the field is left.
    func commit(_ field: TypedField) {
        guard let draft = drafts.removeValue(forKey: field) else { return }
        setRole(field.role, agent: field.agent, field.key, to: draft)
    }
    func setRole(_ role: String, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>, to value: String, offered: [ModelChoice] = []) {
        guard assignment(for: role)?.workerHolders.contains(agent) == true else { return }
        var setting = roleSettings[role] ?? RoleSetting()
        var fields = setting[agent] ?? RoleAgentSettings()
        fields[keyPath: key] = value.isEmpty ? nil : value
        // A new model drops an effort it does not accept, rather than send the pair.
        if key == \.model, let effort = fields.effort, let accepts = offered.first(where: { $0.id == value })?.efforts,
           !accepts.isEmpty, !accepts.contains(effort) {
            fields.effort = nil
        }
        setting[agent] = fields
        storeRole(role, setting)
    }
    private func storeRole(_ role: String, _ setting: RoleSetting) {
        let clean = setting.normalized
        let next = clean == RoleSetting() ? nil : clean
        guard roleSettings[role] != next else { return }
        roleSettings[role] = next; changedRole = role
    }
    func assignment(for role: String) -> RoleAssignment? {
        let settings = Self.normalized(roleSettings)
        var resolved: [String: RoleAssignment] = [:]
        for info in roleInfo {
            let setting = settings[info.role] ?? RoleSetting()
            let base = setting.agents.map { RoleAssignment(agents: $0) }
                ?? info.parent.flatMap { resolved[$0] }
                ?? openedRoles[info.role].map { RoleAssignment(agents: $0.holders) }
            if var assignment = base {
                for agent in assignment.workerHolders {
                    let inherited = RoleSetting(assignment)[agent]
                    let own = setting[agent]
                    let merged = RoleAgentSettings(model: own?.model ?? inherited?.model, effort: own?.effort ?? inherited?.effort)
                    switch agent {
                    case "codex": assignment.codex = merged.normalized()
                    case "claude": assignment.claude = merged.normalized()
                    default: assignment.antigravity = merged.normalized()
                    }
                }
                resolved[info.role] = assignment
            }
        }
        return resolved[role]
    }
    func load(scope next: String) async {
        generation += 1
        let attempt = generation
        scope = next; loaded = false; loading = true; textStatus = ""; savingText = false
        var components = URLComponents()
        components.path = "/api/instructions"
        if !next.isEmpty {
            components.queryItems = [URLQueryItem(name: "project", value: next)]
            // URLQueryItem leaves "+" as it is, which the daemon would read as a space in the path.
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        do {
            let result: Instructions = try await api.request(components.string!)
            guard generation == attempt else { return }
            text = result.text; savedText = result.text; loaded = true
        } catch {
            guard generation == attempt else { return }
            text = ""; savedText = ""; textStatus = error.localizedDescription
        }
        if generation == attempt { loading = false }
    }
    func saveInstructions() async {
        guard loaded && !savingText else { return }
        savingText = true; textStatus = ""
        let draft = text, attempt = generation
        struct Save: Encodable, Sendable { var project: String?; var text: String }
        do {
            let result: Instructions = try await api.post("/api/instructions", Save(project: scope.isEmpty ? nil : scope, text: draft))
            guard generation == attempt else { return }
            if text == draft { text = result.text }
            savedText = result.text; textStatus = String(localized: "Saved")
        } catch { if generation == attempt { textStatus = error.localizedDescription } }
        if generation == attempt { savingText = false }
    }
    /// True when the preset was stored.
    @discardableResult func savePreset() async -> Bool {
        guard presets != nil && !savingPreset else { return false }
        savingPreset = true; presetStatus = ""
        defer {
            savingPreset = false
            if let (stored, table) = presetStoredMeanwhile { presetStoredMeanwhile = nil; adopt(preset: stored, presets: table) }
        }
        let draft = preset
        do {
            let result: PresetState = try await api.post("/api/preset", PresetSelection(preset: draft))
            if preset == draft { preset = result.preset }
            savedPreset = result.preset; presets = result.presets; presetStatus = String(localized: "Saved")
            return true
        } catch {
            presetStatus = error.localizedDescription
            return false
        }
    }
    /// Stores the preset as it is picked, with no save step, as the board does. A pick made while one is being stored
    /// goes out when that returns; one that cannot be stored is undone, and `presetError` says why.
    func applyPreset() async {
        guard !savingPreset else { return }
        while presets != nil && preset != savedPreset {
            if await savePreset() { presetError = "" } else { presetError = presetStatus; preset = savedPreset }
        }
    }
    /// Stores the role table as it is changed, likewise.
    func applyRoles() async {
        guard !savingRoles else { return }
        while rolesDirty {
            if await saveRoles() { roleError = "" } else { roleError = roleStatus; roleSettings = savedRoleSettings }
        }
    }
    /// Saves every page with unsaved changes; true when nothing is left unsaved.
    func saveAll() async -> Bool {
        for field in Array(drafts.keys) { commit(field) }
        // A failure says why where the change was made, and the change stays for another try.
        if rolesDirty { roleError = await saveRoles() ? "" : roleStatus }
        if preset != savedPreset && presets != nil { presetError = await savePreset() ? "" : presetStatus }
        if text != savedText && loaded { await saveInstructions() }
        return !dirty
    }
    /// Takes a role table stored elsewhere (the board, `config.json`) as the stored one, so the next change here
    /// starts from it: each change stores the whole table, and an older copy would undo that change. Not while a
    /// change made here is unsaved or being stored, which goes out as it was made. Text being typed is kept apart
    /// in `drafts` and stays.
    func adopt(roleSettings table: [String: RoleSetting]) {
        let table = Self.normalized(table)
        guard !savingRoles, !rolesDirty, table != Self.normalized(savedRoleSettings) else { return }
        roleSettings = table; savedRoleSettings = table
    }
    /// The last preset stored elsewhere while one from here was being stored, taken once that store settles, as the
    /// board does: the stream may not change again to offer it.
    private var presetStoredMeanwhile: (PresetName?, [String: Preset])?
    /// Takes a preset stored elsewhere as the stored one, as `adopt(roleSettings:)` does for the role table. A daemon
    /// without presets sends none, which leaves the page as it is.
    func adopt(preset stored: PresetName?, presets table: [String: Preset]?) {
        guard let table else { return }
        if savingPreset { presetStoredMeanwhile = (stored, table); return }
        guard preset == savedPreset else { return }
        presets = table
        preset = stored; savedPreset = stored
    }
    /// True when the table was stored.
    @discardableResult func saveRoles() async -> Bool {
        guard !savingRoles else { return false }
        savingRoles = true; roleStatus = ""
        defer { savingRoles = false }
        let draft = Self.normalized(roleSettings)
        struct Save: Encodable, Sendable { var roles: [String: RoleSetting] }
        do {
            let result: RoleState = try await api.post("/api/roles", Save(roles: draft))
            let stored = Self.normalized(result.roleSettings)
            if Self.normalized(roleSettings) == draft { roleSettings = stored }
            savedRoleSettings = stored; roleStatus = String(localized: "Saved")
            return true
        } catch {
            roleStatus = error.localizedDescription
            return false
        }
    }
}
