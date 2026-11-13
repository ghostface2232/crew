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
    var kind: String
    var cwd: String
    var project: String
    var task: String
    var isolation = "worktree"
    var targets: [String]?
    var review: Review?
    struct Review: Encodable, Sendable {
        var target = Target()
        var mode = "adversarial"
        struct Target: Encodable, Sendable { var type = "uncommittedChanges" }
    }
}

@MainActor @Observable
final class CrewStore {
    var state = BoardState()
    // Kept apart from `state` so the frequent event and usage updates only redraw the views that show them.
    var events: [CrewEvent] = []
    var limits: [String: LimitUsage?] = [:]
    var usage: Usage?
    var connected = false
    var connectionMessage = "Connecting to Crew…"
    var revision = 0
    var clockSkew: Double = 0
    var selection: String? = "overview" {
        didSet { if selection != oldValue { selectedJob = nil } }
    }
    var selectedJob: String?
    var search = ""
    var searchRequest = 0
    var showingDispatch = false
    var actions: [String: ActionState] = [:]
    var drafts: [String: String] = [:]
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
    }
    var project: String { selection?.hasPrefix("project:") == true ? String(selection!.dropFirst(8)) : "" }
    var now: Double { displayTime + clockSkew }
    var projects: [String] { Array(Set(state.projects + (project.isEmpty ? [] : [project]))).sorted() }
    func persistSelection() { defaults.set(selection, forKey: "selection") }
    func openJob(_ id: String, navigate: Bool = false) {
        if navigate {
            search = ""
            if let job = state.jobs.first(where: { $0.id == id }) { selection = "project:\(job.projectPath)" }
            else { selection = "overview" }
        }
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
                    connected = false
                    connectionMessage = error.localizedDescription
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
            connected = true; connectionMessage = "Connected"
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
        await run("dismiss:\(mission.id)", once: true) {
            let updated: Mission = try await api.post("/api/missions/\(mission.id)", Dismiss())
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
    func submitQuestion(_ text: String, project: String) async throws -> Job {
        struct Question: Encodable, Sendable { var kind = "delegate"; var ask = true; var task: String; var cwd: String }
        let job: Job = try await api.post("/api/jobs", Question(task: text, cwd: project))
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
    var roles: [String: RoleAssignment] = [:]
    var savedRoles: [String: RoleAssignment] = [:]
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
    var dirty: Bool { text != savedText || roles != savedRoles || preset != savedPreset }
    var busy: Bool { savingText || savingRoles || savingPreset }
    init(api: CrewAPI, roles: [String: RoleAssignment], preset: PresetName? = nil, presets: [String: Preset]? = nil) {
        self.api = api; self.roles = roles; self.savedRoles = roles
        self.preset = preset; self.savedPreset = preset; self.presets = presets
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
        struct Save: Encodable, Sendable {
            var preset: PresetName?
            enum CodingKeys: String, CodingKey { case preset }
            func encode(to encoder: Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(preset, forKey: .preset)
            }
        }
        do {
            let result: PresetState = try await api.post("/api/preset", Save(preset: draft))
            if preset == draft { preset = result.preset }
            savedPreset = result.preset; presets = result.presets; presetStatus = "Saved"
        } catch { presetStatus = error.localizedDescription }
        savingPreset = false
    }
    func saveRoles() async {
        guard !savingRoles else { return }
        savingRoles = true; roleStatus = ""
        let draft = roles
        struct Save: Encodable, Sendable { var roles: [String: RoleAssignment] }
        do {
            let normalized: [String: RoleAssignment] = try await api.post("/api/roles", Save(roles: draft))
            if roles == draft { roles = normalized }
            savedRoles = normalized; roleStatus = "Saved"
        } catch { roleStatus = error.localizedDescription }
        savingRoles = false
    }
}
