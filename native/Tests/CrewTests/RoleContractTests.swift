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
        #expect(current.roleSettings?["release"]?.agents == nil)
        #expect(current.roleSettings?["release"]?.codex?.model == "release-model")
        #expect(current.roleSettings?["verify"] == RoleSetting())
        #expect(current.roles["refactor"]?.holders == ["codex"])
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
    @Test func legacyHoldersAndWorkerSettingsDecodeIntoTheNewShape() throws {
        for agent in RoleAssignment.holderOrder {
            let data = Data("{\"agent\":\"\(agent)\",\"also\":[\"claude\",\"antigravity\",\"codex\",\"codex\"],\"model\":\"legacy-model\",\"effort\":\"high\"}".utf8)
            let assignment = try JSONDecoder().decode(RoleAssignment.self, from: data)
            #expect(assignment.holders == RoleAssignment.holderOrder)
            #expect(assignment.workerHolders == ["codex", "antigravity"])
            #expect(assignment.codex == (agent == "codex" ? RoleAgentSettings(model: "legacy-model", effort: "high") : nil))
            #expect(assignment.antigravity == (agent == "antigravity" ? RoleAgentSettings(model: "legacy-model") : nil))
            #expect(try JSONDecoder().decode(RoleSetting.self, from: data) == RoleSetting(assignment))
            let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(assignment)) as? [String: Any])
            #expect(body["agents"] as? [String] == RoleAssignment.holderOrder)
            #expect(body["agent"] == nil && body["also"] == nil && body["model"] == nil && body["effort"] == nil)
        }
        let single = try JSONDecoder().decode(RoleAssignment.self, from: Data(#"{"agent":"antigravity"}"#.utf8))
        #expect(single.holders == ["antigravity"] && single.antigravity == nil)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(RoleAssignment.self, from: Data(#"{"agents":[]}"#.utf8)) }
    }
    @Test func currentAssignmentsKeepEachWorkersSettingsAndCanonicalHolderOrder() throws {
        let data = Data(#"{"agents":["claude","antigravity","codex"],"codex":{"model":"codex-model","effort":"high"},"antigravity":{"model":"agy-model"}}"#.utf8)
        let assignment = try JSONDecoder().decode(RoleAssignment.self, from: data)
        #expect(assignment.agents == RoleAssignment.holderOrder)
        #expect(assignment.codex == RoleAgentSettings(model: "codex-model", effort: "high"))
        #expect(assignment.antigravity == RoleAgentSettings(model: "agy-model"))
        #expect(try JSONDecoder().decode(RoleSetting.self, from: data) == RoleSetting(assignment))
        #expect(try JSONDecoder().decode(RoleAssignment.self, from: JSONEncoder().encode(assignment)) == assignment)
    }
    @Test @MainActor func settingsResolvePerAgentInheritanceAndExplicitHoldersStartFresh() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: state.roleSettings, roleInfo: state.roleInfo)
        #expect(settings.roleSettings == SettingsModel.normalized(state.roleSettings ?? [:]))
        #expect(settings.assignment(for: "refactor") == state.roles["delegate"])
        #expect(settings.assignment(for: "release")?.codex?.model == "release-model")
        #expect(settings.assignment(for: "verify") == state.roles["review"])
        settings.roleSettings["delegate"] = RoleSetting(agents: ["codex", "antigravity", "claude"], codex: .init(model: "build", effort: "high"), antigravity: .init(model: "review"))
        settings.roleSettings["refactor"] = RoleSetting(codex: .init(effort: "low"), antigravity: .init(model: "child"))
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agents: RoleAssignment.holderOrder, codex: .init(model: "build", effort: "low"), antigravity: .init(model: "child")))
        #expect(settings.assignment(for: "release")?.codex == RoleAgentSettings(model: "release-model", effort: "high"))
        settings.roleSettings["refactor"] = RoleSetting(agents: ["codex"], antigravity: .init(model: "ignored"))
        #expect(settings.assignment(for: "refactor") == RoleAssignment(agents: ["codex"]))
        #expect(settings.roleSettings["debate"] == nil)
    }
    @Test @MainActor func holderTogglesKeepOneHolderAndReturnToClean() throws {
        let state = try fixture("state-extended")
        for raw in [[:], ["delegate": RoleSetting(agents: ["claude", "codex"], codex: .init(model: "saved", effort: "high"))]] {
            let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: raw, roleInfo: state.roleInfo)
            let saved = settings.savedRoleSettings
            let checked = settings.assignment(for: "delegate")?.holders.contains("claude") == true
            settings.setHolder("delegate", holder: "claude", enabled: !checked)
            #expect(settings.dirty)
            settings.setHolder("delegate", holder: "claude", enabled: checked)
            #expect(settings.roleSettings == saved && !settings.dirty)
            settings.setHolder("delegate", holder: "codex", enabled: false)
            #expect(settings.assignment(for: "delegate")?.holders.isEmpty == false)
            if checked {
                #expect(settings.roleSettings["delegate"]?.codex == nil)
                settings.setHolder("delegate", holder: "codex", enabled: true)
                #expect(settings.roleSettings == saved && !settings.dirty)
            } else {
                #expect(settings.assignment(for: "delegate")?.holders == ["codex"] && !settings.dirty)
            }
        }
    }
    @Test @MainActor func followParentCopiesCurrentHoldersAndPreservesOwnAgentOverrides() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: [:], roleInfo: state.roleInfo)
        #expect(settings.followsParent("refactor") && !settings.followsParent("delegate"))
        settings.setHolder("refactor", holder: "claude", enabled: true)
        #expect(!settings.dirty)
        settings.setHolder("delegate", holder: "antigravity", enabled: true)
        settings.setRole("delegate", agent: "codex", \.model, to: "parent-model")
        settings.setRole("refactor", agent: "codex", \.effort, to: "low")
        settings.setFollowParent("refactor", enabled: false)
        #expect(settings.roleSettings["refactor"]?.agents == ["codex", "antigravity"])
        #expect(settings.assignment(for: "refactor")?.codex == RoleAgentSettings(effort: "low"))
        settings.setHolder("delegate", holder: "antigravity", enabled: false)
        #expect(settings.assignment(for: "refactor")?.holders == ["codex", "antigravity"])
        settings.setFollowParent("refactor", enabled: true)
        #expect(settings.roleSettings["refactor"]?.agents == nil)
        #expect(settings.assignment(for: "refactor")?.holders == ["codex"])
        #expect(settings.assignment(for: "refactor")?.codex == RoleAgentSettings(model: "parent-model", effort: "low"))
        settings.setRole("delegate", agent: "codex", \.model, to: "")
        settings.setRole("refactor", agent: "codex", \.effort, to: "")
        #expect(!settings.dirty)
    }
    @Test @MainActor func uncheckingAWorkerDropsOnlyItsOwnSettings() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: [:], roleInfo: state.roleInfo)
        settings.roleSettings["delegate"] = RoleSetting(agents: RoleAssignment.holderOrder, codex: .init(model: "codex-model", effort: "high"), antigravity: .init(model: "agy-model"))
        settings.setHolder("delegate", holder: "codex", enabled: false)
        #expect(settings.roleSettings["delegate"]?.codex == nil)
        #expect(settings.roleSettings["delegate"]?.antigravity?.model == "agy-model")
        settings.setHolder("delegate", holder: "antigravity", enabled: false)
        #expect(settings.roleSettings["delegate"]?.antigravity == nil)
        #expect(settings.assignment(for: "delegate")?.holders == ["claude"])
        settings.setHolder("delegate", holder: "claude", enabled: false)
        #expect(settings.assignment(for: "delegate")?.holders == ["claude"])
    }
    @Test @MainActor func perAgentFieldsAndNormalizedTablesReturnToClean() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: state.roleSettings, roleInfo: state.roleInfo)
        for role in settings.roleInfo.map(\.role) {
            for agent in settings.assignment(for: role)?.workerHolders ?? [] {
                settings.setRole(role, agent: agent, \.model, to: settings.roleSettings[role]?[agent]?.model ?? "")
                settings.setRole(role, agent: agent, \.effort, to: settings.roleSettings[role]?[agent]?.effort ?? "")
            }
        }
        #expect(!settings.dirty)
        settings.setRole("delegate", agent: "codex", \.model, to: "changed")
        #expect(settings.dirty)
        settings.setRole("delegate", agent: "codex", \.model, to: "build-model")
        settings.setRole("release", agent: "codex", \.effort, to: "low")
        settings.setRole("release", agent: "codex", \.effort, to: "")
        settings.setRole("verify", agent: "antigravity", \.model, to: "changed")
        settings.setRole("verify", agent: "antigravity", \.model, to: "")
        #expect(!settings.dirty)
        settings.roleSettings["delegate"]?.agents = ["codex", "codex"]
        settings.roleSettings["verify"] = RoleSetting(codex: .init(model: "", effort: ""), antigravity: .init())
        #expect(!settings.rolesDirty)
        let clean = SettingsModel.normalized(["delegate": RoleSetting(agents: ["claude", "antigravity", "codex", "codex"], codex: .init(model: "", effort: "high"), antigravity: .init(model: "", effort: "ignored")), "refactor": RoleSetting(codex: .init())])
        #expect(clean == ["delegate": RoleSetting(agents: RoleAssignment.holderOrder, codex: .init(effort: "high"))])
    }
    @Test func dispatchSelectsOnlyWorkerHoldersAndEncodesEveryPick() throws {
        let state = try fixture()
        var dispatch = JobDispatch(assignment: RoleAssignment(agents: ["claude", "antigravity", "codex"]), workers: state.agents)
        #expect(dispatch.holders == ["codex", "antigravity"])
        #expect(dispatch.agent == "codex" && dispatch.submissionAgent == "codex")
        for picked in ["codex", "antigravity"] {
            dispatch.picked = picked
            #expect(dispatch.agent == picked && dispatch.canSend)
            let submission = JobSubmission(role: state.availableRoles[0], cwd: "/project", project: "/project", task: "Build", agent: dispatch.submissionAgent)
            let body = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as? [String: Any])
            #expect(body["agent"] as? String == picked)
        }
        dispatch.assignment = RoleAssignment(agents: ["codex"])
        #expect(dispatch.agent == "codex" && dispatch.submissionAgent == "codex" && dispatch.canSend)
        dispatch.assignment = RoleAssignment(agents: ["claude", "antigravity"])
        #expect(dispatch.submissionAgent == "antigravity")
        dispatch.workers["antigravity"]?.enabled = false
        #expect(!dispatch.canSend)
        dispatch.assignment = RoleAssignment(agents: ["claude"])
        #expect(dispatch.holders.isEmpty && dispatch.agent == nil && dispatch.submissionAgent == nil && !dispatch.canSend && dispatch.requiresClaude)
        dispatch.assignment = nil
        #expect(!dispatch.canSend && !dispatch.requiresClaude)
    }
    @Test @MainActor func overviewListsEveryHolderAndOmitsUnchangedInheritedHolders() throws {
        let state = try fixture("state-extended")
        let store = CrewStore(api: CrewAPI(port: 0))
        store.state.roleInfo = state.roleInfo
        let assignment = RoleAssignment(agents: RoleAssignment.holderOrder)
        store.state.roles = ["delegate": assignment, "refactor": assignment, "release": RoleAssignment(agents: ["codex", "claude"])]
        let delegate = state.roleLabel("delegate"), release = state.roleLabel("release")
        #expect(agentRole("claude", store: store) == "Lead · \(delegate) · \(release)")
        #expect(agentRole("codex", store: store) == "\(delegate) · \(release)")
        #expect(agentRole("antigravity", store: store) == delegate)
        store.state.roleSettings = ["refactor": RoleSetting(agents: RoleAssignment.holderOrder)]
        #expect(agentRole("antigravity", store: store) == "\(delegate) · \(state.roleLabel("refactor"))")
    }
}
