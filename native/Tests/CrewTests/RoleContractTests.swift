import Foundation
import Testing
@testable import Crew

@Suite struct RoleContractTests {
    @Test func roleAndPresetFieldsDecodeWithLegacyFallbacks() throws {
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(RoleAssignment.self, from: Data("{}".utf8)) }
        #expect(try JSONDecoder().decode(RoleSetting.self, from: Data("{}".utf8)) == RoleSetting())
        let legacy = try fixture()
        #expect(legacy.roleInfo == nil && legacy.roleSettings == nil)
        #expect(legacy.availableRoles.map(\.role) == ["delegate", "review", "polish"])
        #expect(legacy.editableRoleSettings == legacy.roles.mapValues(RoleSetting.init))
        #expect(legacy.jobs.allSatisfy { $0.role == nil && $0.preset == nil })
        #expect(legacy.missions.allSatisfy { $0.preset == nil })

        let current = try fixture("state-extended")
        #expect(current.availableRoles.map(\.role) == ["delegate", "refactor", "release", "debate", "review", "verify", "polish"])
        #expect(current.availableRoles.map(\.group) == ["Build", "Build", "Build", "Build", "Review", "Review", "Edit"])
        #expect(current.roleInfo?.first { $0.role == "verify" }?.parent == "review")
        #expect(current.roleSettings?["refactor"] == nil)
        #expect(current.roleSettings?["release"]?.agent == nil)
        #expect(current.roleSettings?["release"]?.model == "release-model")
        #expect(current.roleSettings?["verify"] == RoleSetting())
        #expect(current.roles["refactor"]?.agent == "codex")
        #expect(current.jobs[0].role == "delegate" && current.jobs[0].preset == "economy")
        #expect(current.jobs[1].role == "verify" && current.jobs[1].preset == nil)
        #expect(current.missions[0].preset == .best)
        #expect(current.roleLabel(current.jobs[1].assignedRole) == "Review that runs the app")
    }
    @Test func olderJobsDeriveTheirRoleAndExplicitRolesTakePrecedence() throws {
        var job = try fixture().jobs[0]
        #expect(job.assignedRole == "delegate")
        job.kind = "review"
        #expect(job.assignedRole == "review")
        job.runsApp = true
        #expect(job.assignedRole == "verify")
        job.debate = DebateLimit(rounds: 2)
        #expect(job.assignedRole == "debate")
        job.role = "release"
        #expect(job.assignedRole == "release")
    }
    @Test func submissionsSendRolesAndLegacyKindsWithoutConfusingRolesWithKinds() throws {
        let state = try fixture("state-extended")
        for info in state.availableRoles where info.role != "debate" {
            let submission = JobSubmission(role: info, cwd: "/project", project: "/project", task: "Check this")
            let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as? [String: Any])
            #expect(body["role"] as? String == info.role)
            #expect(body["kind"] as? String == (roleOrder.contains(info.role) ? info.kind : nil))
            #expect((body["review"] != nil) == (info.kind == "review"))
        }
    }
    @Test @MainActor func settingsResolveInheritedDraftsWithoutMaterializingThem() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: state.roleSettings, roleInfo: state.roleInfo)
        // Only blanks are dropped: an empty role entry is the same as one left out.
        #expect(settings.roleSettings == SettingsModel.normalized(state.roleSettings ?? [:]))
        #expect(settings.assignment(for: "refactor") == state.roles["delegate"])
        #expect(settings.assignment(for: "release")?.model == "release-model")
        #expect(settings.assignment(for: "verify") == state.roles["review"])
        settings.roleSettings["delegate"] = RoleSetting(agent: "antigravity", model: "new-model", effort: "low")
        #expect(settings.assignment(for: "refactor")?.agent == "antigravity")
        #expect(settings.assignment(for: "refactor")?.model == "new-model")
        #expect(settings.assignment(for: "release")?.model == "release-model")
        settings.roleSettings["refactor"] = RoleSetting(agent: "codex")
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agent: "codex"))
        #expect(settings.roleSettings["verify"]?.agent == nil)
        #expect(settings.roleSettings["debate"] == nil)
    }
    @Test @MainActor func aParentlessRolesShownAgentIsNoChange() throws {
        let state = try fixture("state-extended")
        // No agent written for any role: each parentless picker shows the agent its role resolves to.
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: [:], roleInfo: state.roleInfo)
        let agent = try #require(state.roles["review"]?.agent)
        settings.setRole("review", \.agent, to: agent)
        #expect(!settings.dirty)
        settings.setRole("review", \.agent, to: agent == "codex" ? "antigravity" : "codex")
        #expect(settings.dirty)
        settings.setRole("review", \.agent, to: agent)
        #expect(settings.roleSettings["review"] == nil && !settings.dirty)
    }
    @Test @MainActor func fieldsThatEndEditingUnchangedLeaveSettingsClean() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: state.roleSettings, roleInfo: state.roleInfo)
        // Focus leaving each empty field writes its value back unchanged, as closing the window does.
        for role in settings.roleInfo.map(\.role) {
            settings.setRole(role, \.model, to: settings.roleSettings[role]?.model ?? "")
            settings.setRole(role, \.effort, to: settings.roleSettings[role]?.effort ?? "")
        }
        #expect(!settings.dirty)
        // A role saved as an empty entry, as a hand-edited config.json may hold, comes back clean after an undone edit.
        #expect(state.roleSettings?["verify"] == RoleSetting())
        settings.setRole("verify", \.effort, to: "high")
        settings.setRole("verify", \.effort, to: "")
        #expect(!settings.dirty)
        settings.setRole("refactor", \.effort, to: "high")
        #expect(settings.dirty)
        // Trying another agent and coming back to the saved one is no change, written or shown.
        if let agent = state.roles["review"]?.agent {
            settings.setRole("review", \.agent, to: agent == "codex" ? "antigravity" : "codex")
            #expect(settings.dirty)
            settings.setRole("review", \.agent, to: agent)
            #expect(settings.roleSettings["review"] == settings.savedRoleSettings["review"])
        }
        settings.setRole("refactor", \.agent, to: "antigravity")
        settings.setRole("refactor", \.agent, to: "")
        #expect(settings.roleSettings["refactor"]?.agent == nil)
        // Clearing it again is the same as never having set it.
        settings.setRole("refactor", \.effort, to: "")
        #expect(settings.roleSettings["refactor"] == nil)
        #expect(!settings.dirty)
    }
    @Test func holderFieldsDecodeWithAndWithoutAlso() throws {
        for agent in ["codex", "antigravity", "claude"] {
            let legacy = Data("{\"agent\":\"\(agent)\"}".utf8)
            #expect(try JSONDecoder().decode(RoleAssignment.self, from: legacy).also == nil)
            #expect(try JSONDecoder().decode(RoleSetting.self, from: legacy).also == nil)
            let current = Data("{\"agent\":\"\(agent)\",\"also\":[\"antigravity\",\"codex\"]}".utf8)
            let assignment = try JSONDecoder().decode(RoleAssignment.self, from: current)
            #expect(assignment.agent == agent && assignment.also == ["antigravity", "codex"])
            #expect(try JSONDecoder().decode(RoleSetting.self, from: current) == RoleSetting(assignment))
        }
    }
    @Test @MainActor func alsoFollowsTheWholeAssignmentUntilReplacedOrAnAgentIsNamed() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: [:], roleInfo: state.roleInfo)
        settings.roleSettings["delegate"] = RoleSetting(agent: "claude", model: "lead-model", effort: "high", also: ["antigravity", "codex", "antigravity", "claude"])
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agent: "claude", model: "lead-model", effort: "high", also: ["antigravity", "codex"]))
        settings.roleSettings["refactor"] = RoleSetting(effort: "low", also: ["codex", "claude", "codex"])
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agent: "claude", model: "lead-model", effort: "low", also: ["codex"]))
        settings.roleSettings["refactor"] = RoleSetting(agent: "codex")
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agent: "codex"))
        settings.roleSettings["refactor"] = RoleSetting(also: [])
        #expect(settings.assignment(for: "refactor")?.also == nil)
    }
    @Test @MainActor func togglingAlsoBackRestoresSavedOrderAndLeavesNoEmptyEntries() throws {
        let state = try fixture("state-extended")
        for raw in [[:], ["delegate": RoleSetting(agent: "claude", also: ["antigravity", "codex"])]] {
            let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: raw, roleInfo: state.roleInfo)
            let holder = raw.isEmpty ? "claude" : "antigravity"
            let enabled = settings.assignment(for: "delegate")?.also?.contains(holder) == true
            settings.setAlso("delegate", holder: holder, enabled: !enabled)
            #expect(settings.dirty)
            settings.setAlso("delegate", holder: holder, enabled: enabled)
            #expect(settings.roleSettings == settings.savedRoleSettings && !settings.dirty)
        }
        #expect(SettingsModel.normalized(["delegate": RoleSetting(also: [])]).isEmpty)
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: ["delegate": RoleSetting(agent: "codex", also: ["claude"])], roleInfo: state.roleInfo)
        settings.setAlso("refactor", holder: "claude", enabled: false)
        #expect(settings.assignment(for: "refactor")?.also == nil)
        #expect(settings.roleSettings["refactor"]?.also == ["codex"])
        settings.setAlso("refactor", holder: "claude", enabled: true)
        #expect(settings.roleSettings["refactor"] == nil && !settings.dirty)
        settings.setAlso("refactor", holder: "codex", enabled: true)
        #expect(!settings.dirty)
    }
    @Test @MainActor func inheritedAlsoCanBeOverriddenAfterEditingItsParent() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: ["delegate": RoleSetting(agent: "codex", also: ["claude"])], roleInfo: state.roleInfo)
        settings.setAlso("delegate", holder: "antigravity", enabled: true)
        settings.setAlso("refactor", holder: "antigravity", enabled: false)
        #expect(settings.assignment(for: "refactor")?.also == ["claude"])
        settings.setAlso("refactor", holder: "antigravity", enabled: true)
        #expect(settings.roleSettings["refactor"] == nil)
        settings.setAlso("delegate", holder: "antigravity", enabled: false)
        #expect(!settings.dirty)
        settings.setRole("delegate", \.agent, to: "claude")
        settings.setAlso("delegate", holder: "antigravity", enabled: true)
        settings.setAlso("delegate", holder: "antigravity", enabled: false)
        #expect(settings.roleSettings["delegate"]?.also == nil)
        settings.setRole("delegate", \.agent, to: "codex")
        #expect(!settings.dirty)
    }
    @Test @MainActor func changingTheDefaultRemovesDuplicateHoldersAndUndoRestoresThem() throws {
        let state = try fixture("state-extended")
        let saved = ["delegate": RoleSetting(agent: "claude", also: ["antigravity", "codex"]),
                     "refactor": RoleSetting(agent: "codex", model: "own-model")]
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: saved, roleInfo: state.roleInfo)
        settings.setRole("delegate", \.agent, to: "codex")
        #expect(settings.roleSettings["delegate"]?.also == ["antigravity"])
        settings.setRole("delegate", \.agent, to: "claude")
        #expect(!settings.dirty)
        settings.setRole("refactor", \.agent, to: "")
        #expect(settings.roleSettings["refactor"]?.model == nil)
        settings.setRole("refactor", \.agent, to: "codex")
        #expect(settings.roleSettings == settings.savedRoleSettings && !settings.dirty)
    }
    @Test func dispatchSelectsOnlyWorkerHoldersAndEncodesThePick() throws {
        let state = try fixture()
        let assignment = RoleAssignment(agent: "claude", also: ["antigravity", "codex"])
        var dispatch = JobDispatch(assignment: assignment, workers: state.agents)
        #expect(dispatch.holders == ["antigravity", "codex"])
        #expect(dispatch.agent == "antigravity")
        dispatch.picked = "codex"
        #expect(dispatch.agent == "codex" && dispatch.canSend)
        let submission = JobSubmission(role: state.availableRoles[0], cwd: "/project", project: "/project", task: "Build", agent: dispatch.submissionAgent)
        let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as? [String: Any])
        #expect(body["agent"] as? String == "codex")
        dispatch.assignment = RoleAssignment(agent: "antigravity")
        #expect(dispatch.agent == "antigravity" && dispatch.submissionAgent == nil)
        dispatch.assignment = RoleAssignment(agent: "claude", also: ["antigravity"])
        #expect(dispatch.submissionAgent == "antigravity")
        dispatch.workers["antigravity"]?.enabled = false
        #expect(!dispatch.canSend)
        dispatch.assignment = RoleAssignment(agent: "claude")
        #expect(dispatch.holders.isEmpty && dispatch.agent == nil && !dispatch.canSend && dispatch.requiresClaude)
    }
    @Test @MainActor func overviewListsEveryHolderAndOmitsUnchangedInheritedHolders() throws {
        let state = try fixture("state-extended")
        let store = CrewStore(api: CrewAPI(port: 0))
        store.state.roleInfo = state.roleInfo
        let assignment = RoleAssignment(agent: "claude", also: ["codex", "antigravity"])
        store.state.roles = ["delegate": assignment, "refactor": assignment, "release": RoleAssignment(agent: "codex", also: ["claude"])]
        let delegate = state.roleLabel("delegate"), release = state.roleLabel("release")
        #expect(agentRole("claude", store: store) == "Lead · \(delegate) · \(release)")
        #expect(agentRole("codex", store: store) == "\(delegate) · \(release)")
        #expect(agentRole("antigravity", store: store) == delegate)
    }

}
