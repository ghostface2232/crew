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
    var seq: Int
    var prompt: String?
    var shared: [String]?
    var model: String?
    var effort: String?
    var refusals: [Refusal]?
    var retrying: [String]?
    var runsApp: Bool?
    var exclusive: Bool?
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
    var step: Int { ["plan": 0, "implement": 1, "self-review": 2, "cross-review": 2, "fix": 3, "polish": 4, "final": 5][stage] ?? 0 }
    static let steps = ["Plan", "Build", "Review", "Fix", "Polish", "Final"]
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
// The daemon reports a window length only when the provider does.
struct UsageWindow: Codable, Sendable, Equatable { var usedPercent: Double; var minutes: Double? }
struct Usage: Codable, Sendable, Equatable { var windows: [UsageWindow]? }
struct NotificationPreferences: Codable, Sendable, Equatable { var enabled: Bool; var onDone: Bool }
struct BoardState: Codable, Sendable, Equatable {
    var now: Double = 0
    var jobs: [Job] = []
    var missions: [Mission] = []
    var claude: [ClaudeSession] = []
    var agents: [String: Worker] = [:]
    var roles: [String: RoleAssignment] = [:]
    var limits: [String: Usage?] = [:]
    var events: [CrewEvent] = []
    var notifications: NotificationPreferences?
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
