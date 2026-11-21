import Foundation
import Testing
@testable import Crew

@Suite struct MissionTests {
    @Test func leadRowFollowsFocusOrNewestActiveOwnedMission() throws {
        var state = try fixture()
        var older = state.missions[0]
        var lead = state.claude[0]
        older.owner = lead.id
        older.state = "active"
        older.createdAt = 1000
        older.updatedAt = 9999
        var newer = older
        newer.id = "newer"
        newer.createdAt = 2000
        newer.updatedAt = 2000
        var closed = newer
        closed.id = "closed"
        closed.state = "done"
        closed.createdAt = 3000
        var foreign = newer
        foreign.id = "foreign"
        foreign.owner = "other"
        foreign.createdAt = 4000
        state.missions = [older, newer, closed, foreign]

        lead.mission = older.id
        state.claude = [lead]
        #expect(state.missions.filter { state.leadRow(for: $0) != nil }.map(\.id) == [older.id])
        for focus in [nil, "missing", closed.id, foreign.id] {
            lead.mission = focus
            state.claude = [lead]
            #expect(state.missions.filter { state.leadRow(for: $0) != nil }.map(\.id) == [newer.id])
        }
        state.missions = [older]
        #expect(state.leadRow(for: older)?.id == lead.id)
        #expect(lead.leadMission(in: [closed, foreign]) == nil)
    }

    @Test func openTasksAndWorkingOwnerKeepAMissionFromLookingFinished() throws {
        let state = try fixture()
        var mission = state.missions[0]
        mission.state = "active"
        let now = mission.updatedAt + 20 * 60_000
        var owner = state.claude[0]
        owner.mission = "other-mission"
        owner.state = "working"
        #expect(!mission.looksFinished(jobs: [], now: now, lead: owner))
        owner.state = "idle"
        #expect(mission.looksFinished(jobs: [], now: now, lead: owner))
        for status in ["todo", "doing", "done", "dropped"] {
            mission.tasks = [MissionTask(id: "task", title: "Test", state: status)]
            #expect(mission.looksFinished(jobs: [], now: now, lead: owner) == (status == "done" || status == "dropped"))
        }
    }

    @Test func pullStatusesComeMostUrgentFirst() throws {
        var pull = MissionPull(
            id: "pr-1", url: try #require(URL(string: "https://github.com/example/crew/pull/42")), repo: "example/crew",
            number: 42, title: "Update board", mission: "m", state: "open", checks: "none", review: "", conflict: false, checkedAt: 0
        )
        #expect(pull.statuses.isEmpty)
        pull.checks = "failing"
        pull.review = "changes_requested"
        pull.conflict = true
        #expect(pull.statuses.map(\.word) == ["Conflict", "Checks failing", "Changes requested"])
        #expect(pull.statuses.allSatisfy { $0.needsLead })
        pull.conflict = false
        pull.checks = "pending"
        pull.review = "approved"
        #expect(pull.statuses == [PullStatus(word: "Checks running", tone: "running"), PullStatus(word: "Approved", tone: "done")])
        pull.checks = "passing"
        #expect(pull.statuses.map(\.word) == ["Approved", "Checks passed"])
        pull.state = "merged"
        #expect(pull.statuses == [PullStatus(word: "Merged", tone: "done")])
        pull.state = "closed"
        #expect(pull.statuses == [PullStatus(word: "Closed", tone: "")])
    }

    @Test func decodesNewFieldsAndAcceptsAnOlderDaemonSnapshot() throws {
        let legacy = try fixture()
        #expect(legacy.pulls == nil)
        #expect(legacy.missions[0].tasks == nil)
        #expect(legacy.claude[0].mission == nil)

        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any])
        var missions = try #require(json["missions"] as? [[String: Any]])
        var sessions = try #require(json["claude"] as? [[String: Any]])
        let mission = legacy.missions[0].id
        missions[0]["tasks"] = [["id": "verify", "title": "Verify", "after": ["build"], "state": "done", "result": "Passed"]]
        sessions[0]["mission"] = mission
        json["missions"] = missions
        json["claude"] = sessions
        json["pulls"] = [[
            "id": "pr-1", "url": "https://github.com/example/crew/pull/42", "number": 42, "repo": "example/crew",
            "title": "Update board", "mission": mission, "state": "open", "head": "abc", "checks": "failing",
            "review": "", "conflict": false, "told": ["head": "abc", "checks": ["build"]], "failingHeads": 1,
            "createdAt": 1000, "checkedAt": 2000, "changedAt": 2000,
        ]]
        let data = try JSONSerialization.data(withJSONObject: json)
        let state = try JSONDecoder().decode(BoardState.self, from: data)
        #expect(state.claude[0].mission == mission)
        #expect(state.missions[0].tasks == [MissionTask(id: "verify", title: "Verify", after: ["build"], state: "done", result: "Passed")])
        var pull = try #require(state.pulls?.first)
        #expect(pull.mission == mission)
        #expect(pull.checks == "failing")
        #expect(pull.url.absoluteString == "https://github.com/example/crew/pull/42")

        var streamed = legacy
        try streamed.receive(event("pull", pull))
        pull.checks = "passing"
        try streamed.receive(event("pull", pull))
        #expect(streamed.pulls == [pull])
        try streamed.receive(event("state", legacy))
        #expect(streamed.pulls == nil)
    }
}
