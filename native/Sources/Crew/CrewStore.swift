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
    var state = BoardState()
    // Kept apart from `state` so the frequent event and usage updates only redraw the views that show them.
    var events: [CrewEvent] = []
    var limits: [String: LimitUsage?] = [:]
    var usage: Usage?
    var signInRequired = false
    var connected = false
    var connectionMessage = "Connecting to Crew…"
    var revision = 0
    var clockSkew: Double = 0
    var selection: String? = "overview" {
        didSet { if selection != oldValue { closeDetail() } }
    }
    var selectedJob: String?
    /// A Claude session shown in the detail panel instead of a job; at most one of the two is set.
    var selectedSession: String?
    var detailOpen: Bool { selectedJob != nil || selectedSession != nil }
    func closeDetail() { selectedJob = nil; selectedSession = nil }
    func openSession(_ id: String) { selectedJob = nil; selectedSession = id }
    /// A row clicked again closes the panel it opened.
    func toggleJob(_ id: String) { if selectedJob == id { closeDetail() } else { openJob(id) } }
    func toggleSession(_ id: String) { if selectedSession == id { closeDetail() } else { openSession(id) } }
    var search = ""
    var searchRequest = 0
    var showingDispatch = false
    var actions: [String: ActionState] = [:]
    var drafts: [String: String] = [:]
    /// Missions the user opened or closed; the rest are open while active. Kept here rather than in each card,
    /// so a card keeps its state when the layout moves it between one column and two.
    var missionExpanded: [String: Bool] = [:]
    func isExpanded(_ mission: Mission) -> Bool { missionExpanded[mission.id] ?? (mission.state == "active") }
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
        selection = defaults.string(forKey: "selection") ?? "overview"
        let saved = defaults.double(forKey: "panelWidth")
        panelWidth = saved > 0 ? saved : WorkspaceStyle.panelWidth
        api.onSignInFailure = { [weak self] error in self?.connectionFailed(error) }
    }
    var project: String { selection?.hasPrefix("project:") == true ? String(selection!.dropFirst(8)) : "" }
    var now: Double { displayTime + clockSkew }
    var projects: [String] { Array(Set(state.projects + (project.isEmpty ? [] : [project]))).sorted() }
    func persistSelection() { defaults.set(selection, forKey: "selection") }
    /// The detail panel's width as the user last dragged it, kept across launches.
    var panelWidth: CGFloat = WorkspaceStyle.panelWidth
    func persistPanelWidth() { defaults.set(Double(panelWidth), forKey: "panelWidth") }
    func openJob(_ id: String, navigate: Bool = false) {
        if navigate {
            search = ""
            if let job = state.jobs.first(where: { $0.id == id }) { selection = "project:\(job.projectPath)" }
            else { selection = "overview" }
        }
        selectedSession = nil
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
        connected = false
        signInRequired = error is DaemonSignInFailure
        connectionMessage = error.localizedDescription
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
            usage = try JSONDecoder().decode(Usage.self, from: event.data)
            return
        case "limits":
            limits.merge(try JSONDecoder().decode([String: LimitUsage?].self, from: event.data)) { _, new in new }
            return
        default: break
        }
        if let id = try state.receive(event) { jobVersions[id, default: 0] += 1 }
        if event.name == "state" {
            events = state.events; limits = state.limits; usage = state.usage
            state.events = []; state.limits = [:]; state.usage = nil
            for id in Set(jobVersions.keys).union(state.jobs.map(\.id)) { jobVersions[id, default: 0] += 1 }
            signInRequired = false; connected = true; connectionMessage = "Connected"
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
            let updated: Job = try await api.post("/api/jobs/\(job.id)/reply", Reply(message: draft))
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
    var resolvedRoles: [String: RoleAssignment]
    let roleInfo: [RoleInfo]
    var preset: PresetName?
    var savedPreset: PresetName?
    var presets: [String: Preset]?
    var savingPreset = false
    var presetStatus = ""
    var scope = ""
    var text = ""
    var savedText = ""
    var file = ""
    var loaded = false
    var loading = false
    var savingText = false
    var savingRoles = false
    var textStatus = ""
    var roleStatus = ""
    private var generation = 0
    private let api: CrewAPI
    var rolesDirty: Bool { Self.normalized(roleSettings) != Self.normalized(savedRoleSettings) }
    var dirty: Bool { text != savedText || rolesDirty || preset != savedPreset }
    var busy: Bool { savingText || savingRoles || savingPreset }
    init(api: CrewAPI, roles: [String: RoleAssignment], roleSettings: [String: RoleSetting]? = nil, roleInfo: [RoleInfo]? = nil, preset: PresetName? = nil, presets: [String: Preset]? = nil) {
        self.api = api; self.resolvedRoles = roles
        self.roleInfo = roleInfo ?? RoleInfo.legacy
        self.roleSettings = Self.normalized(roleSettings ?? roles.mapValues(RoleSetting.init))
        self.savedRoleSettings = self.roleSettings
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
              let parent = roleInfo.first(where: { $0.role == role })?.parent else { return "Agent default" }
        let name = models.first { $0.id == value }?.name ?? value
        let label = roleInfo.first { $0.role == parent }?.label ?? parent
        return "\(name) (same as \(label))"
    }
    func fieldChoices(_ role: String, agent: String, _ key: KeyPath<RoleAgentSettings, String?>, models: [ModelChoice]) -> [ModelChoice] {
        var choices = models
        if key == \.effort {
            let model = roleSettings[role]?[agent]?.model.flatMap { $0.isEmpty ? nil : $0 }
                ?? inheritedValue(role, agent: agent, \.model)
            let efforts = models.first { $0.id == model }?.efforts ?? models.flatMap { $0.efforts ?? [] }
            choices = []
            for effort in efforts where !choices.contains(where: { $0.id == effort }) {
                choices.append(ModelChoice(id: effort, name: effort))
            }
        }
        if let value = roleSettings[role]?[agent]?[keyPath: key], !value.isEmpty, !choices.contains(where: { $0.id == value }) {
            choices.append(ModelChoice(id: value, name: value))
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
        if enabled {
            setting[holder] = setting[holder] ?? savedRoleSettings[role]?[holder]
        } else {
            setting[holder] = nil
        }
        // A root with no written holders returns to that form when its original holders are checked again.
        if roleInfo.first(where: { $0.role == role })?.parent == nil,
           savedRoleSettings[role]?.agents == nil, setting.agents == resolvedRoles[role]?.holders {
            setting.agents = nil
        }
        storeRole(role, setting)
    }
    func setRole(_ role: String, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>, to value: String) {
        guard assignment(for: role)?.workerHolders.contains(agent) == true,
              agent == "codex" || key == \.model else { return }
        var setting = roleSettings[role] ?? RoleSetting()
        var fields = setting[agent] ?? RoleAgentSettings()
        fields[keyPath: key] = value.isEmpty ? nil : value
        setting[agent] = fields
        storeRole(role, setting)
    }
    private func storeRole(_ role: String, _ setting: RoleSetting) {
        let clean = setting.normalized
        roleSettings[role] = clean == RoleSetting() ? nil : clean
    }
    func assignment(for role: String) -> RoleAssignment? {
        let settings = Self.normalized(roleSettings)
        var resolved: [String: RoleAssignment] = [:]
        for info in roleInfo {
            let setting = settings[info.role] ?? RoleSetting()
            let base = setting.agents.map { RoleAssignment(agents: $0) }
                ?? info.parent.flatMap { resolved[$0] }
                ?? resolvedRoles[info.role].map { RoleAssignment(agents: $0.holders) }
            if var assignment = base {
                for agent in assignment.workerHolders {
                    let inherited = RoleSetting(assignment)[agent]
                    let own = setting[agent]
                    let merged = RoleAgentSettings(model: own?.model ?? inherited?.model, effort: own?.effort ?? inherited?.effort)
                    if agent == "codex" { assignment.codex = merged.normalized() }
                    else { assignment.antigravity = merged.normalized(effort: false) }
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
        if !next.isEmpty { components.queryItems = [URLQueryItem(name: "project", value: next)] }
        do {
            let result: Instructions = try await api.request(components.string!)
            guard generation == attempt else { return }
            text = result.text; savedText = result.text; file = result.file; loaded = true
        } catch {
            guard generation == attempt else { return }
            text = ""; savedText = ""; file = ""; textStatus = error.localizedDescription
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
            savedText = result.text; file = result.file; textStatus = "Saved"
        } catch { if generation == attempt { textStatus = error.localizedDescription } }
        if generation == attempt { savingText = false }
    }
    func savePreset() async {
        guard presets != nil && !savingPreset else { return }
        savingPreset = true; presetStatus = ""
        let draft = preset
        do {
            let result: PresetState = try await api.post("/api/preset", PresetSelection(preset: draft))
            if preset == draft { preset = result.preset }
            savedPreset = result.preset; presets = result.presets; presetStatus = "Saved"
        } catch { presetStatus = error.localizedDescription }
        savingPreset = false
    }
    /// Saves every page with unsaved changes; true when nothing is left unsaved.
    func saveAll() async -> Bool {
        if rolesDirty { await saveRoles() }
        if preset != savedPreset && presets != nil { await savePreset() }
        if text != savedText && loaded { await saveInstructions() }
        return !dirty
    }
    func saveRoles() async {
        guard !savingRoles else { return }
        savingRoles = true; roleStatus = ""
        let draft = Self.normalized(roleSettings)
        struct Save: Encodable, Sendable { var roles: [String: RoleSetting] }
        do {
            let result: RoleState = try await api.post("/api/roles", Save(roles: draft))
            let stored = Self.normalized(result.roleSettings)
            if Self.normalized(roleSettings) == draft { roleSettings = stored }
            resolvedRoles = result.roles; savedRoleSettings = stored; roleStatus = "Saved"
        } catch { roleStatus = error.localizedDescription }
        savingRoles = false
    }
}
