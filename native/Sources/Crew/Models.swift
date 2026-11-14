import Foundation

struct Job: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var kind: String
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
    var refusals: [Refusal]?
    var retrying: [String]?
    var runsApp: Bool?
    var exclusive: Bool?
    var rounds: [Round]?
    var ask: Bool?
    /// Ended, but its worktree still awaits a merge or discard, or the lead has not read its result.
    var isUnsettled: Bool { worktree != nil || seq > (delivered ?? seq) }
    var kindTitle: String { ask == true ? "Question" : roleNames[kind] ?? kind }
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
struct Worktree: Codable, Sendable, Equatable { var path: String; var branch: String; var base: String }
struct Waiting: Codable, Sendable, Equatable { var type: String; var reason: String; var id: String; var since: Double }
struct JobResult: Codable, Sendable, Equatable { var files: [String]; var stat: String; var commit: String?; var outOfScope: [String] }
struct JobError: Codable, Sendable, Equatable { var message: String; var limit: Bool }
struct Refusal: Codable, Sendable, Equatable { var action: String; var reason: String; var turn: Int }
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
    var projectPath: String { root ?? cwd }
    var notificationKey: String { "session:\(id):\(waitingId ?? waitingFor ?? "")" }
}
struct Worker: Codable, Sendable, Equatable { var name: String; var resume: String; var enabled: Bool }
struct RoleAssignment: Codable, Sendable, Equatable {
    var agent: String
    var model: String?
    var effort: String?
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
    var description: String {
        let agents = [("Codex", codex), ("Antigravity", antigravity)].compactMap { name, agent in
            agent.map { name + ": " + [$0.model ?? "Agent default", $0.effort.map { "\($0) effort" }].compactMap { $0 }.joined(separator: " · ") }
        }
        return (agents + ["Subagents: " + (subagentModel ?? "inherit")]).joined(separator: "; ")
    }
}
struct PresetState: Codable, Sendable, Equatable { var preset: PresetName?; var presets: [String: Preset] }
struct NotificationPreferences: Codable, Sendable, Equatable { var enabled: Bool; var onDone: Bool }
struct BoardState: Codable, Sendable, Equatable {
    var now: Double = 0
    var jobs: [Job] = []
    var missions: [Mission] = []
    var claude: [ClaudeSession] = []
    var agents: [String: Worker] = [:]
    var roles: [String: RoleAssignment] = [:]
    var limits: [String: LimitUsage?] = [:]
    var events: [CrewEvent] = []
    var notifications: NotificationPreferences?
    var usage: Usage?
    var preset: PresetName?
    var presets: [String: Preset]?
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
        case "roles": roles = try decoder.decode([String: RoleAssignment].self, from: event.data)
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
let roleNames = ["delegate": "Implementation", "review": "Read-only review", "polish": "Wording polish"]
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
