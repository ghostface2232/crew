import Foundation

struct Job: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var kind: String
    var role: String?
    var preset: String?
    var agent: String
    var title: String
    var state: String
    var phase: String
    var project: String
    var root: String?
    var mission: String?
    var missionStep: Int?
    var cwd: String
    var worktree: Worktree?
    var sessionId: String?
    var createdAt: Double
    var activeAt: Double
    var endedAt: Double?
    var turns: Int
    var stalled: Bool
    var waiting: Waiting?
    var report: String
    var result: JobResult?
    var notes: [String]
    var error: JobError?
    var tokens: Int?
    var tokenUse: TokenUse?
    var seq: Int
    /// Last `seq` the lead has read; absent from older daemons.
    var delivered: Int?
    var prompt: String?
    var shared: [String]?
    var model: String?
    var effort: String?
    var resolvedModel: String?
    var resolvedEffort: String?
    var outcome: String?
    var outcomeContradiction: String?
    var refusals: [Refusal]?
    var retrying: [String]?
    var runsApp: Bool?
    var exclusive: Bool?
    var rounds: [Round]?
    var ask: Bool?
    var evidence: [Evidence]?
    /// What each finished turn left behind and what was checked against it; absent on older jobs.
    var receipts: [TurnReceipt]?
    /// What the worker's runtime was set up to allow.
    var capabilities: Capabilities?
    /// Approvals the lead relayed for actions the automatic reviewer refused.
    var approvals: [RelayedApproval]?
    /// The lead's messages and the worker's report for each turn.
    var exchange: [ExchangeEntry]?
    var debate: DebateLimit?
    var tier: String?
    /// The latest turn's receipt when it has something to show: a check the bridge ran, or what a review read.
    /// An older turn's check would speak for a branch that has moved on, so it is not shown in its place.
    var latestReceipt: TurnReceipt? { receipts?.last.flatMap { $0.check != nil || $0.reviewed != nil ? $0 : nil } }
    var hasVerification: Bool { latestReceipt != nil || capabilities != nil || !(approvals ?? []).isEmpty }
    /// The lead and the worker have exchanged more than the first task and report: a debate, or a job the lead followed up.
    var hasConversation: Bool { debate != nil ? !(exchange ?? []).isEmpty : (exchange ?? []).contains { $0.from == "lead" && $0.turn > 1 } }
    /// A debate that has used all its rounds and stopped, in whatever state: the daemon refuses another reply.
    var debateConcluded: Bool { debate.map { state != "running" && state != "waiting" && turns >= $0.rounds } ?? false }
    /// Ended, but its worktree still awaits a merge or discard, or the lead has not read its result.
    var isUnsettled: Bool { worktree != nil || seq > (delivered ?? seq) }
    var kindTitle: String { debate != nil ? "Debate" : ask == true ? "Question" : roleNames[kind] ?? kind }
    var assignedRole: String { role ?? (debate != nil ? "debate" : kind == "review" && runsApp == true ? "verify" : kind) }
    var roundUnavailableReason: String? {
        if state == "running" || state == "waiting" { return "Wait until the job has stopped before changing rounds." }
        if worktree == nil { return "This job has no worktree." }
        return nil
    }
    func roundActionKey(_ turn: Int) -> String { "round:\(id):\(turn)" }
    var projectPath: String { root ?? project }
    var isActive: Bool { endedAt == nil }
    var status: String {
        if state == "waiting" { return waiting?.type == "approval" ? "Needs approval" : "Has a question" }
        if stalled { return "May be stuck" }
        if error?.limit == true { return "Usage limit reached" }
        return ["running": "Working", "done": "Done", "failed": "Failed", "cancelled": "Cancelled"][state] ?? state
    }
    var requestKey: String { "answer:\(id):\(waiting?.id ?? "")" }
}
struct TokenUse: Codable, Sendable, Equatable { var input: Int; var cachedInput: Int; var output: Int; var turn: Int }
struct Round: Codable, Sendable, Equatable {
    var turn: Int
    var commit: String
    var files: [String]
    var stat: String
    var state: String
    var revert: String?
    var at: Double
}
/// A screenshot or recording kept with a job; the daemon runs on this Mac, so `path` is a local file.
struct Evidence: Codable, Sendable, Equatable {
    var file: String
    var path: String
    var turn: Int
    var from: String
    var bytes: Int
    var modified: Double
    var isVideo: Bool { ["webm", "mp4"].contains((file as NSString).pathExtension.lowercased()) }
}
struct Worktree: Codable, Sendable, Equatable { var path: String; var branch: String; var base: String }
struct Waiting: Codable, Sendable, Equatable {
    var type: String; var reason: String; var id: String; var since: Double
    /// What "Allow for This Job" covers; present only on plugin tool approvals that name their target.
    var grant: String?
}
struct JobResult: Codable, Sendable, Equatable { var files: [String]; var stat: String; var commit: String?; var outOfScope: [String] }
struct JobError: Codable, Sendable, Equatable { var message: String; var limit: Bool }
struct Refusal: Codable, Sendable, Equatable { var action: String; var reason: String; var turn: Int }
struct CheckResult: Codable, Sendable, Equatable {
    var command: String
    var exit: Int?
    var timedOut: Bool
    var output: String
    var ms: Double
    var sandboxed: Bool
    var skipped: String?
}
struct ReviewedTarget: Codable, Sendable, Equatable { var target: String; var diff: String? }
struct TurnReceipt: Codable, Sendable, Equatable {
    var turn: Int
    var head: String?
    var check: CheckResult?
    var reviewed: ReviewedTarget?
    var stale: String?
    var at: Double
}
struct Capabilities: Codable, Sendable, Equatable { var filesystem: String; var network: String; var plugins: [String] }
struct RelayedApproval: Codable, Sendable, Equatable { var turn: Int; var quote: String; var matched: Bool; var recorded: Int; var at: Double }
struct ExchangeEntry: Codable, Sendable, Equatable { var turn: Int; var from: String; var text: String; var at: Double }
struct DebateLimit: Codable, Sendable, Equatable { var rounds: Int }
struct CrewEvent: Codable, Sendable, Identifiable, Equatable {
    var seq: Int
    var ts: String
    var agent: String
    var session_id: String?
    var job_id: String?
    var kind: String
    var detail: String
    var id: Int { seq }
}
struct Mission: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var title: String
    var project: String
    var root: String
    var owner: String?
    var stage: String
    var state: String
    var outcome: String
    var createdAt: Double
    var updatedAt: Double
    var endedAt: Double?
    var notes: [MissionNote]?
    var stages: [String]?
    var stageIndex: Int?
    var preset: PresetName?
    private static let stopOfStage = ["plan": 0, "implement": 1, "self-review": 2, "cross-review": 2, "fix": 3, "polish": 4, "final": 5]
    var step: Int { stages.map { stageIndex ?? $0.firstIndex(of: stage) ?? 0 } ?? Self.stopOfStage[stage] ?? 0 }
    static let steps = ["Plan", "Build", "Review", "Fix", "Polish", "Final"]
    var stops: [String] {
        var rounds: [String: Int] = [:]
        return stages?.map {
            let name = Self.steps[Self.stopOfStage[$0] ?? 0]
            let round = (rounds[name] ?? 0) + 1
            rounds[name] = round
            return name + (round > 1 ? " \(round)" : "")
        } ?? Self.steps
    }
    /// Locks the mission's own controls per state: Stop Tracking and Mark Done exclude each other while it runs,
    /// and once it is abandoned, Mark Done takes a fresh lock.
    var actionKey: String { "mission:\(id):\(state)" }
    func passed(_ index: Int) -> Bool { state == "done" || index < step }
    func jobStep(_ job: Job) -> Int {
        if stages != nil, let index = job.missionStep, stops.indices.contains(index) { return index }
        let stop = ["delegate": 1, "review": 2, "polish": 4][job.kind] ?? 1
        let kinds = stages?.map { Self.stopOfStage[$0] ?? 0 } ?? Array(Self.steps.indices)
        // Jobs without a recorded occurrence use current matching stop, first match, then current.
        if kinds[step] == stop { return step }
        return kinds.firstIndex(of: stop) ?? step
    }
    /// A lead working alone touches neither the mission nor any job, so its own session must be quiet too.
    func looksFinished(jobs: [Job], now: Double, lead: ClaudeSession? = nil) -> Bool {
        state == "active" && now - updatedAt >= 20 * 60_000
            && (lead == nil || lead?.state == "idle" || lead?.state == "error")
            && !jobs.contains { $0.mission == id && ($0.state == "running" || $0.state == "waiting") }
    }
}
struct MissionNote: Codable, Sendable, Equatable { var text: String; var at: Double }

func missionProgress(_ mission: Mission, jobs: [Job]) -> Double {
    if mission.state == "done" { return 1 }
    let stages = mission.stages ?? ["plan", "implement", "self-review", "cross-review", "fix", "polish", "final"]
    let stageIndex = mission.stages == nil ? stages.firstIndex(of: mission.stage) ?? 0 : mission.step
    let weights = jobs.filter { $0.mission == mission.id && $0.endedAt == nil }.map { $0.state == "running" || $0.state == "waiting" ? 0.5 : 0 }
    let share = weights.isEmpty ? 0.5 : weights.reduce(0, +) / Double(weights.count)
    // Zero-based plan position plus at most half a step of running work; only done reaches 100%.
    // Missions without a plan retain the original seven-stage progress formula.
    return max(0, (Double(stageIndex) + share) / Double(stages.count))
}

struct ClaudeSession: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var cwd: String
    var root: String?
    var title: String
    var state: String
    var phase: String
    var waitingFor: String?
    var waitingId: String?
    var inTool: Bool
    var stalled: Bool
    var startedAt: Double
    var activeAt: Double
    /// Missing from a daemon older than sub-agent tracking, as are the workflows.
    var agents: [SubAgent]?
    var workflows: [WorkflowRun]?
    var projectPath: String { root ?? cwd }
    /// "2 sub-agents · review 12 running", or nil with none running.
    var agentSummary: String? {
        let agents = self.agents ?? []
        let plain = agents.filter { $0.workflow == nil }.count
        let runs = (workflows ?? []).filter { run in agents.contains { $0.workflow == run.id } }
        let running = agents.count - plain
        let parts = [plain > 0 ? "\(plain) sub-agent\(plain == 1 ? "" : "s")" : nil,
                     runs.isEmpty ? nil : "\(runs.count == 1 ? runs[0].name : "\(runs.count) workflows") \(running) running"]
        let summary = parts.compactMap { $0 }.joined(separator: " · ")
        return summary.isEmpty ? nil : summary
    }
    var notificationKey: String { "session:\(id):\(waitingId ?? waitingFor ?? "")" }
}
struct SubAgent: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var type: String
    var title: String
    var phase: String
    var startedAt: Double
    /// The id of the workflow run it belongs to.
    var workflow: String?
    /// The workflow phase it was started in.
    var stage: String?
}
/// A run's running agents are the session's agents that name it; the total is not known ahead.
struct WorkflowRun: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var name: String
    var startedAt: Double
    var activeAt: Double
    var done: Int
}
struct ModelChoice: Codable, Sendable, Identifiable, Equatable { var id: String; var name: String; var efforts: [String]? }
struct Worker: Codable, Sendable, Equatable { var name: String; var resume: String; var enabled: Bool; var models: [ModelChoice]? }
struct RoleAssignment: Codable, Sendable, Equatable {
    static let holderOrder = ["codex", "antigravity", "claude"]
    var agents: [String]
    var codex: RoleAgentSettings?
    var antigravity: RoleAgentSettings?
    var holders: [String] { Self.holderOrder.filter { agents.contains($0) } }
    var workerHolders: [String] { holders.filter { $0 == "codex" || $0 == "antigravity" } }
    init(agents: [String], codex: RoleAgentSettings? = nil, antigravity: RoleAgentSettings? = nil) {
        self.agents = Self.holderOrder.filter { agents.contains($0) }
        self.codex = codex; self.antigravity = antigravity
    }
    init(from decoder: Decoder) throws {
        let setting = try RoleSetting(from: decoder)
        guard let agents = setting.agents, !agents.isEmpty else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "A resolved role needs at least one holder."))
        }
        self.init(agents: agents, codex: setting.codex, antigravity: setting.antigravity)
    }
    func encode(to encoder: Encoder) throws { try RoleSetting(self).encode(to: encoder) }
}
struct RoleAgentSettings: Codable, Sendable, Equatable {
    var model: String?
    var effort: String?
    func normalized() -> Self? {
        let clean = Self(model: model?.isEmpty == true ? nil : model, effort: effort?.isEmpty == true ? nil : effort)
        return clean == Self() ? nil : clean
    }
}
struct RoleSetting: Codable, Sendable, Equatable {
    var agents: [String]?
    var codex: RoleAgentSettings?
    var antigravity: RoleAgentSettings?
    init(agents: [String]? = nil, codex: RoleAgentSettings? = nil, antigravity: RoleAgentSettings? = nil) {
        self.agents = agents; self.codex = codex; self.antigravity = antigravity
    }
    init(_ assignment: RoleAssignment) {
        agents = assignment.holders; codex = assignment.codex; antigravity = assignment.antigravity
    }
    subscript(agent: String) -> RoleAgentSettings? {
        get { agent == "codex" ? codex : agent == "antigravity" ? antigravity : nil }
        set { if agent == "codex" { codex = newValue } else if agent == "antigravity" { antigravity = newValue } }
    }
    var normalized: Self {
        Self(agents: agents.map { agents in RoleAssignment.holderOrder.filter { agents.contains($0) } },
             codex: codex?.normalized(), antigravity: antigravity?.normalized())
    }
    private enum CodingKeys: String, CodingKey { case agents, codex, antigravity, agent, also, model, effort }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agents = try values.decodeIfPresent([String].self, forKey: .agents)
        codex = try values.decodeIfPresent(RoleAgentSettings.self, forKey: .codex)
        antigravity = try values.decodeIfPresent(RoleAgentSettings.self, forKey: .antigravity)
        if agents == nil, let agent = try values.decodeIfPresent(String.self, forKey: .agent) {
            agents = [agent] + (try values.decodeIfPresent([String].self, forKey: .also) ?? [])
        }
        if values.contains(.model) || values.contains(.effort) {
            // Legacy entries without an agent used the role's default worker, or Codex for a following child.
            let owner = try values.decodeIfPresent(String.self, forKey: .agent) ?? (decoder.codingPath.last?.stringValue == "polish" ? "antigravity" : "codex")
            // A legacy effort was Codex's alone, as the daemon reads it.
            self[owner] = try RoleAgentSettings(model: values.decodeIfPresent(String.self, forKey: .model), effort: owner == "codex" ? values.decodeIfPresent(String.self, forKey: .effort) : nil)
        }
        self = normalized
    }
    func encode(to encoder: Encoder) throws {
        let clean = normalized
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(clean.agents, forKey: .agents)
        try values.encodeIfPresent(clean.codex, forKey: .codex)
        try values.encodeIfPresent(clean.antigravity, forKey: .antigravity)
    }
}
struct RoleInfo: Codable, Sendable, Identifiable, Equatable {
    var role: String
    var kind: String
    var parent: String?
    var label: String
    var summary: String
    var unable: [String]?
    var id: String { role }
    /// Fixing review findings sits with the reviews it answers, though it runs as a build job.
    var group: String { role == "fix" || kind == "review" ? "Review" : kind == "delegate" ? "Build" : "Edit" }
    static let legacy = [
        RoleInfo(role: "delegate", kind: "delegate", label: "Implementation", summary: "Builds separable pieces of a change."),
        RoleInfo(role: "review", kind: "review", label: "Read-only review", summary: "Reviews a change without modifying it."),
        RoleInfo(role: "polish", kind: "polish", label: "Wording polish", summary: "Improves UI strings, comments, and docs."),
    ]
}
struct RoleState: Decodable, Sendable {
    var roles: [String: RoleAssignment]
    var roleSettings: [String: RoleSetting]
    private enum CodingKeys: String, CodingKey { case roles, roleSettings }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if values.contains(.roles) {
            roles = try values.decode([String: RoleAssignment].self, forKey: .roles)
            roleSettings = try values.decodeIfPresent([String: RoleSetting].self, forKey: .roleSettings) ?? roles.mapValues(RoleSetting.init)
        } else {
            roles = try [String: RoleAssignment](from: decoder)
            roleSettings = roles.mapValues(RoleSetting.init)
        }
    }
}
// The legacy limit event reports a window length only when the provider does.
struct LimitWindow: Codable, Sendable, Equatable { var usedPercent: Double; var minutes: Double? }
struct LimitUsage: Codable, Sendable, Equatable { var windows: [LimitWindow]? }
enum UsageStatus: String, Codable, Sendable { case ok, tight, exhausted, stale, unknown }
struct UsageWindow: Codable, Sendable, Equatable {
    var key: String
    var kind: String
    var group: String?
    var usedRatio: Double
    var resetTime: Double?
    var durationSec: Double?
    var projectedExhaustion: Double?
    var status: UsageStatus
    var name: String {
        switch kind.lowercased() {
        case "fivehour", "five-hour", "5-hour": return "5-hour"
        case "weekly": return "Weekly"
        case "billingcycle", "billing-cycle", "billing cycle", "monthly": return "Billing cycle"
        default: return kind
        }
    }
}
struct ProviderUsage: Codable, Sendable, Equatable {
    var agent: String
    var plan: String?
    var capturedAt: Double?
    var status: UsageStatus
    var reason: String
    var windows: [UsageWindow]
    var accountWindows: [UsageWindow] { windows.filter { $0.group == nil } }
    /// What the board shows: the account-wide windows, or for Antigravity, which reports only per model family,
    /// its own Gemini family's 5-hour and weekly windows, whichever of the two it has.
    var shownWindows: [UsageWindow] {
        if agent != "antigravity" || !accountWindows.isEmpty { return accountWindows }
        let gemini = windows.filter { $0.group == "Gemini" }
        return ["fiveHour", "weekly"].compactMap { kind in gemini.first { $0.kind == kind } }
    }
}
struct Usage: Codable, Sendable, Equatable {
    var generatedAt: Double
    var source: String
    var providers: [ProviderUsage]
}
enum PresetName: String, Codable, Sendable, CaseIterable { case economy, balanced, best }
struct Preset: Codable, Sendable, Equatable {
    struct Agent: Codable, Sendable, Equatable { var model: String?; var effort: String? }
    var codex: Agent?
    var antigravity: Agent?
    var subagentModel: String?
    var subagentMax: String?
    var maxTier: String?
    var description: String {
        let agents = [("Codex", codex), ("Antigravity", antigravity)].compactMap { name, agent in
            agent.map { name + ": " + [$0.model ?? "Agent default", $0.effort.map { "\($0) effort" }].compactMap { $0 }.joined(separator: " · ") }
        }
        let subagents = "Subagents: " + (subagentModel ?? "inherit") + (subagentMax.map { " (up to \($0))" } ?? "")
        return (agents + [subagents] + [maxTier.map { "Workers up to the \($0) tier" }].compactMap { $0 }).joined(separator: "; ")
    }
}
struct PresetState: Codable, Sendable, Equatable { var preset: PresetName?; var presets: [String: Preset] }
/// One model's standing from its review notes (plugin/bridge/notes.ts).
struct ModelScore: Codable, Sendable, Equatable, Identifiable {
    var model: String
    var agent: String
    var score: Double?
    var build: Double?
    var fix: Double?
    var samples: Int
    /// Absent from a daemon that predates split counts.
    var buildSamples: Int?
    var fixSamples: Int?
    /// How the lead took the model's delegated work; absent from an older daemon, null when none says.
    var adoption: Adoption?
    struct Adoption: Codable, Sendable, Equatable { var judged: Int; var asIs: Int; var afterReply: Int; var partly: Int; var rejected: Int; var rounds: Int }
    var status: String
    var summary: String
    var id: String { model }
}
struct NotificationPreferences: Codable, Sendable, Equatable { var enabled: Bool; var onDone: Bool }
struct BoardState: Codable, Sendable, Equatable {
    var now: Double = 0
    var jobs: [Job] = []
    var missions: [Mission] = []
    var claude: [ClaudeSession] = []
    var agents: [String: Worker] = [:]
    var roles: [String: RoleAssignment] = [:]
    var roleSettings: [String: RoleSetting]?
    var roleInfo: [RoleInfo]?
    var limits: [String: LimitUsage?] = [:]
    var events: [CrewEvent] = []
    var notifications: NotificationPreferences?
    var usage: Usage?
    var preset: PresetName?
    var presets: [String: Preset]?
    /// Absent from a daemon that predates model notes.
    var modelScores: [ModelScore]?
    var availableRoles: [RoleInfo] { roleInfo ?? RoleInfo.legacy }
    var editableRoleSettings: [String: RoleSetting] { roleSettings ?? roles.mapValues(RoleSetting.init) }
    func roleLabel(_ role: String) -> String {
        availableRoles.first { $0.role == role }?.label ?? roleNames[role] ?? role.capitalized
    }
    var projects: [String] {
        Array(Set(jobs.map(\.projectPath) + missions.map(\.root) + claude.map(\.projectPath))).filter { !$0.isEmpty }.sorted()
    }
    var waitingJobs: [Job] { jobs.filter { $0.state == "waiting" }.sorted { ($0.waiting?.since ?? 0) < ($1.waiting?.since ?? 0) } }
    var waitingSessions: [ClaudeSession] { claude.filter { $0.state == "waiting" } }
    var pendingCount: Int { waitingJobs.count + waitingSessions.count }

    @discardableResult mutating func receive(_ event: ServerEvent) throws -> String? {
        let decoder = JSONDecoder()
        switch event.name {
        case "state": self = try decoder.decode(Self.self, from: event.data)
        case "job":
            let job = try decoder.decode(Job.self, from: event.data)
            upsert(&jobs, job)
            return job.id
        case "mission": upsert(&missions, try decoder.decode(Mission.self, from: event.data))
        case "claude":
            let change = try decoder.decode(SessionChange.self, from: event.data)
            if change.removed == true { claude.removeAll { $0.id == change.session.id } }
            else { upsert(&claude, change.session) }
        case "usage": usage = try decoder.decode(Usage.self, from: event.data)
        case "preset":
            let change = try decoder.decode(PresetState.self, from: event.data)
            preset = change.preset; presets = change.presets
        case "modelScores": modelScores = try decoder.decode([ModelScore].self, from: event.data)
        case "roles": roles = try decoder.decode([String: RoleAssignment].self, from: event.data)
        case "roleSettings": roleSettings = try decoder.decode([String: RoleSetting].self, from: event.data)
        default: break
        }
        return nil
    }
}
private struct SessionChange: Decodable, Sendable { var session: ClaudeSession; var removed: Bool? }
func upsert<T: Identifiable>(_ items: inout [T], _ value: T) {
    if let index = items.firstIndex(where: { $0.id == value.id }) { items[index] = value }
    else { items.append(value) }
}
func mergeEvents(_ previous: [CrewEvent], _ incoming: [CrewEvent], limit: Int = 400) -> [CrewEvent] {
    var byID = Dictionary(previous.map { ($0.seq, $0) }, uniquingKeysWith: { _, new in new })
    for event in incoming { byID[event.seq] = event }
    return Array(byID.values.sorted { $0.seq < $1.seq }.suffix(limit))
}
func agentName(_ id: String) -> String { ["claude": "Claude", "codex": "Codex", "antigravity": "Antigravity"][id] ?? id }
let roleNames = ["delegate": "Implementation", "refactor": "Refactoring", "release": "Release preparation", "debate": "Debate", "review": "Read-only review", "verify": "Review that runs the app", "fix": "Fix", "polish": "Wording polish"]
let roleOrder = ["delegate", "review", "polish"]
func projectName(_ path: String, among paths: [String]) -> String {
    let name = URL(fileURLWithPath: path).lastPathComponent
    return paths.filter { URL(fileURLWithPath: $0).lastPathComponent == name }.count > 1 ? path : name
}
func elapsed(_ milliseconds: Double) -> String {
    let seconds = max(0, Int(milliseconds / 1000))
    if seconds < 60 { return "<1m" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
}

/// One numbered point of a debater's reply, as its role asks it to end each message.
struct DebatePoint: Equatable, Sendable {
    enum Stance: String, Sendable { case agree, disagree, alternative }
    var number: Int
    var stance: Stance
    var title: String
}

/// The points a reply marks agree, disagree or alternative: "1. **[agree]** Title…", "2. [disagree] …", "3. **disagree** — …",
/// optionally followed by how it is known, which the headline leaves out: "4. agree · inferred — …".
/// Only the first sentence of each is kept, as a headline; the full reply stays one disclosure away.
func debatePoints(_ text: String) -> [DebatePoint] {
    let pattern = /^\s*(?:[-*]\s*)?(\d+)\.\s*(?:\*\*)?\[?(agree|disagree|alternative)\b\]?(?:\*\*)?[\s:.\-—–·,]*(.*)$/.ignoresCase()
    // A basis must be followed by a separator, so a headline that starts with "Read" stays whole.
    let basisPattern = /^[(\[]?(?:\*\*)?(?:verified|read|inferred)(?:\*\*)?[)\]]?\s*[:\-—–·,]+\s*(.*)$/.ignoresCase()
    var points: [DebatePoint] = []
    for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
        guard let match = String(line).wholeMatch(of: pattern), let number = Int(match.1),
              let stance = DebatePoint.Stance(rawValue: match.2.lowercased()) else { continue }
        var title = String(match.3)
        if let found = title.wholeMatch(of: basisPattern) { title = String(found.1) }
        title = title.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        if let end = title.firstIndex(where: { ".!?。".contains($0) }), title.distance(from: title.startIndex, to: end) > 12 {
            title = String(title[...end])
        }
        if title.count > 140 { title = String(title.prefix(139)) + "…" }
        points.append(DebatePoint(number: number, stance: stance, title: title))
    }
    return points
}

