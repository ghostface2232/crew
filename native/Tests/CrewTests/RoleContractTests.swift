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
        #expect(settings.roleSettings == state.roleSettings)
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
    @Test @MainActor func fieldsThatEndEditingUnchangedLeaveSettingsClean() throws {
        let state = try fixture("state-extended")
        let settings = SettingsModel(api: CrewAPI(port: 0), roles: state.roles, roleSettings: state.roleSettings, roleInfo: state.roleInfo)
        // Focus leaving each empty field writes its value back unchanged, as closing the window does.
        for role in settings.roleInfo.map(\.role) {
            settings.setRole(role, \.model, to: settings.roleSettings[role]?.model ?? "")
            settings.setRole(role, \.effort, to: settings.roleSettings[role]?.effort ?? "")
        }
        #expect(!settings.dirty)
        // The picker of a role without a parent shows its resolved agent; choosing it again is no change.
        if settings.roleSettings["review"]?.agent == nil, let agent = state.roles["review"]?.agent {
            settings.setRole("review", \.agent, to: agent)
            #expect(!settings.dirty)
        }
        settings.setRole("refactor", \.effort, to: "high")
        #expect(settings.dirty)
        // Clearing it again is the same as never having set it.
        settings.setRole("refactor", \.effort, to: "")
        #expect(settings.roleSettings["refactor"] == nil)
        #expect(!settings.dirty)
    }
}
