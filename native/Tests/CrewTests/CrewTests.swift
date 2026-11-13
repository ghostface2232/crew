import Foundation
import Synchronization
import Testing
@testable import Crew

func fixture(_ name: String = "state") throws -> BoardState {
    let file = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")!
    return try JSONDecoder().decode(BoardState.self, from: Data(contentsOf: file))
}
func event<T: Encodable>(_ name: String, _ value: T) throws -> ServerEvent {
    ServerEvent(name: name, data: try JSONEncoder().encode(value))
}

@Suite struct StreamTests {
    @Test func shortElapsedLabelsDoNotJumpInSeconds() {
        #expect(elapsed(12_000) == "<1m")
        #expect(elapsed(59_999) == "<1m")
        #expect(elapsed(60_000) == "1m")
    }
    @Test func profileIdentifiersAreStablePathSafeAndDistinct() {
        let first = InstanceLock.profileID(home: URL(fileURLWithPath: "/tmp/crew/../crew-test"))
        #expect(first == InstanceLock.profileID(home: URL(fileURLWithPath: "/tmp/crew-test")))
        #expect(first.count == 64)
        #expect(first.allSatisfy { $0.isHexDigit })
        #expect(first != InstanceLock.profileID(home: URL(fileURLWithPath: "/tmp/crew-other")))
    }
    @Test func completionOwnershipFollowsDaemonTimeAcrossReconnectGaps() {
        var leases = CompletionLeases()
        leases.record(from: 1000, until: 16000)
        #expect(leases.owns(3000))
        #expect(!leases.owns(16000))
        leases.record(from: 21000, until: 36000)
        #expect(leases.owns(3000))
        #expect(!leases.owns(19000))
        leases.record(from: 26000, until: 41000)
        #expect(leases.owns(39000))
        #expect(!leases.owns(41000))
        leases.accept(DesktopLease(completionNotifications: false, from: 30000, until: 45000))
        #expect(leases.owns(29000))
        #expect(!leases.owns(30000))
        leases.accept(DesktopLease(completionNotifications: true, from: 26000, until: 41000))
        #expect(!leases.owns(39000))
    }
    @Test func delayedLeasePreservesHistoricalCompletionOwnership() {
        var leases = CompletionLeases()
        leases.record(from: 21000, until: 36000)
        leases.record(from: 1000, until: 16000)
        #expect(leases.owns(3000))
        #expect(!leases.owns(19000))
        #expect(leases.owns(22000))
    }
    @Test func delayedRevocationsPreserveLaterGrantsWithoutRestoringRevokedTime() {
        let changes = [
            DesktopLease(completionNotifications: true, from: 1000, until: 16000),
            DesktopLease(completionNotifications: false, from: 4000, until: 19000),
            DesktopLease(completionNotifications: true, from: 7000, until: 22000),
            DesktopLease(completionNotifications: true, from: 27000, until: 42000),
        ]
        for order in [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]] {
            var leases = CompletionLeases()
            for index in order { leases.accept(changes[index]) }
            leases.accept(changes[0])
            #expect(!leases.owns(999))
            #expect(leases.owns(1000))
            #expect(leases.owns(3999))
            #expect(!leases.owns(4000))
            #expect(!leases.owns(6999))
            #expect(leases.owns(7000))
            #expect(leases.owns(21999))
            #expect(!leases.owns(22000))
            #expect(!leases.owns(26999))
            #expect(leases.owns(27000))
            #expect(!leases.owns(42000))
        }
    }
    @Test func completionsIgnoreHistoryAndNotifyOncePerTurn() throws {
        var tracker = CompletionTracker()
        var job = try fixture().jobs[0]
        job.state = "done"; job.endedAt = 5_000
        #expect(tracker.finished(in: [job]).isEmpty)
        job.state = "running"; job.endedAt = nil; job.turns += 1
        #expect(tracker.finished(in: [job]).isEmpty)
        job.state = "done"; job.endedAt = 5_000
        #expect(tracker.finished(in: [job]).map(\.id) == [job.id])
        #expect(tracker.finished(in: [job]).isEmpty)
        job.state = "failed"
        #expect(tracker.finished(in: [job]).isEmpty)
        job.state = "done"; job.turns += 1
        #expect(tracker.finished(in: [job]).count == 1)
        job.state = "running"; job.endedAt = nil
        #expect(tracker.finished(in: [job]).isEmpty)
        job.state = "done"; job.endedAt = 5_000
        #expect(tracker.finished(in: [job]).count == 1)
        #expect(tracker.finished(in: [job]).isEmpty)
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CREW_STREAM_TEST_PORT"] != nil))
    @MainActor func realStreamDecodesSnapshotsAndCancelsConnection() async throws {
        let port = Int(ProcessInfo.processInfo.environment["CREW_STREAM_TEST_PORT"]!)!
        let api = CrewAPI(port: port, environment: ["CREW_HOME": FileManager.default.temporaryDirectory.appendingPathComponent("crew-test-\(UUID())").path])
        let store = CrewStore(api: api)
        let stream = Task {
            try await api.stream { event in try store.receive(event) }
        }
        defer { stream.cancel() }
        for _ in 0..<200 {
            if store.state.jobs.first?.phase == "실제 스트림 연결 확인 🙂" { break }
            try await Task.sleep(for: .milliseconds(25))
        }
        #expect(store.connected)
        #expect(store.state.jobs.first?.phase == "실제 스트림 연결 확인 🙂")
        #expect(store.ownsCompletion(at: 5000))
        #expect(store.state.jobs.count == (try fixture()).jobs.count)
        stream.cancel()
        do { try await stream.value; Issue.record("Cancelled stream unexpectedly completed") }
        catch { #expect(error is CancellationError || (error as? URLError)?.code == .cancelled) }
        struct Connections: Decodable, Sendable { var count: Int }
        var active = 1
        for _ in 0..<100 {
            let reply: Connections = try await api.request("/active")
            active = reply.count
            if active == 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(active == 0)
    }
    @Test func parsesChunksIncludingSplitKoreanAndCRLF() throws {
        var parser = SSEParser()
        let wire = Data(": heartbeat\r\nevent: job\r\ndata: {\"message\":\r\ndata: \"한글🙂\"}\r\n\r\nevent: roles\ndata: {}\n\n".utf8)
        var events: [ServerEvent] = []
        for byte in wire { events += try parser.feed(Data([byte])) }
        #expect(events.count == 2)
        #expect(events[0].name == "job")
        #expect(String(data: events[0].data, encoding: .utf8) == "{\"message\":\n\"한글🙂\"}")
        #expect(events[1].name == "roles")
    }
    @Test func processesLargeSnapshotInChunks() throws {
        var parser = SSEParser()
        let payload = String(repeating: "한글 state ", count: 100_000)
        let wire = Data("event: state\ndata: \(payload)\n\n".utf8)
        var events: [ServerEvent] = []
        for start in stride(from: 0, to: wire.count, by: 16384) {
            events += try parser.feed(wire.subdata(in: start..<min(wire.count, start + 16384)))
        }
        #expect(events.count == 1)
        #expect(events[0].data == Data(payload.utf8))
    }
    @Test func rejectsOversizedOrInvalidEvents() throws {
        var parser = SSEParser()
        #expect(throws: CrewFailure.self) { try parser.feed(Data(repeating: 65, count: 16 * 1024 * 1024)) }
        var invalid = SSEParser()
        #expect(throws: CrewFailure.self) { try invalid.feed(Data([0xff, 10])) }
    }
    @Test func reconnectReplacesSnapshotAndRestartedSequence() throws {
        var state = try fixture()
        var changed = state.jobs[0]
        changed.phase = "New phase"
        try state.receive(event("job", changed))
        #expect(state.jobs[0].phase == "New phase")
        var fresh = try fixture()
        fresh.jobs = []
        fresh.events = [CrewEvent(seq: 1, ts: "2026-11-13T00:00:00.000Z", agent: "codex", kind: "started", detail: "Restarted")]
        try state.receive(event("state", fresh))
        #expect(state.jobs.isEmpty)
        #expect(state.events.count == 1)
        #expect(state.events[0].detail == "Restarted")
    }
    @Test func usageWindowWithoutLengthStillDecodes() throws {
        let wire = #"{"codex":{"windows":[{"minutes":null,"usedPercent":42,"resetsAt":null}]}}"#
        let limits = try JSONDecoder().decode([String: LimitUsage?].self, from: Data(wire.utf8))
        #expect(limits["codex"]??.windows?.first?.minutes == nil)
        #expect(limits["codex"]??.windows?.first?.usedPercent == 42)
    }
    @Test func optionalContractFieldsDecodeAndLegacyStateStillWorks() throws {
        let legacy = try fixture()
        #expect(legacy.usage == nil && legacy.preset == nil && legacy.presets == nil)
        #expect(legacy.jobs.allSatisfy { $0.rounds == nil && $0.ask == nil })
        #expect(legacy.missions.allSatisfy { $0.notes == nil })
        #expect(legacy.limits["codex"]??.windows?.first?.usedPercent == 42)
        let current = try fixture("state-extended")
        #expect(current.usage?.providers.count == 3)
        let claude = try #require(current.usage?.providers.first)
        #expect(claude.status == .tight)
        #expect(claude.accountWindows.map(\.name) == ["5-hour", "Weekly"])
        #expect(claude.windows.last?.group == "sonnet")
        #expect(claude.windows.last?.status == .exhausted)
        #expect(current.preset == .balanced)
        #expect(current.presets?["best"]?.subagentModel == "large")
        #expect(current.presets?["economy"]?.description.contains("low effort") == true)
        #expect(current.jobs[0].rounds?.map(\.state) == ["kept", "undone"])
        #expect(current.jobs[0].rounds?.last?.revert == "revert2")
        #expect(current.jobs[0].kindTitle == "Question")
        #expect(current.missions[0].notes?.first?.text == "Preserve compatibility.")
    }
    @Test func progressUsesSevenStagesAndOnlyUnendedMissionJobs() throws {
        var mission = try fixture().missions[0]
        var job = try fixture().jobs[0]
        for (index, stage) in ["plan", "implement", "self-review", "cross-review", "fix", "polish", "final"].enumerated() {
            mission.stage = stage
            let expected = (Double(index) + 0.5) / 7
            #expect(missionProgress(mission, jobs: []) == expected)
            for state in ["running", "waiting", "done", "failed", "cancelled"] {
                job.state = state; job.endedAt = state == "running" || state == "waiting" ? nil : 100
                #expect(missionProgress(mission, jobs: [job]) == expected)
            }
            job.mission = "another-mission"; job.endedAt = nil
            #expect(missionProgress(mission, jobs: [job]) == expected)
            job.mission = mission.id
        }
        mission.state = "done"
        #expect(missionProgress(mission, jobs: []) == 1)
        mission.state = "abandoned"; mission.stage = "unknown"
        #expect(missionProgress(mission, jobs: []) == 0.5 / 7)
    }
    @Test func eventHistoryDeduplicatesAndStaysBounded() {
        let events = (0..<500).map { CrewEvent(seq: $0, ts: "", agent: "codex", kind: "progress", detail: String($0)) }
        let merged = mergeEvents(Array(events.prefix(350)), Array(events.suffix(200)))
        #expect(merged.count == 400)
        #expect(merged.first?.seq == 100)
        #expect(merged.last?.seq == 499)
    }
    @Test func repeatedClaudeQuestionsHaveDifferentKeys() throws {
        var session = try fixture().claude[0]
        session.waitingId = "first"; session.waitingFor = "Same question"
        let key = session.notificationKey
        session.waitingId = "second"
        #expect(session.notificationKey != key)
    }
}

private final class MockProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data, TimeInterval)
    static let handler = Mutex<Handler?>(nil)
    private let cancelled = Mutex(false)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let handler = Self.handler.withLock { $0 }
            let (status, data, delay) = try handler!(request)
            DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [self] in
                guard !cancelled.withLock({ $0 }) else { return }
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { cancelled.withLock { $0 = true } }
}

@Suite(.serialized) @MainActor struct ActionTests {
    private func api(_ handler: @escaping MockProtocol.Handler) -> CrewAPI {
        MockProtocol.handler.withLock { $0 = handler }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockProtocol.self]
        return CrewAPI(port: 0, configuration: config, environment: ["CREW_HOME": FileManager.default.temporaryDirectory.appendingPathComponent("crew-test-\(UUID())").path])
    }
    private func store(api: CrewAPI = CrewAPI(port: 0)) throws -> CrewStore {
        let suite = "crew-tests-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        let store = CrewStore(api: api, defaults: defaults)
        try store.receive(event("state", fixture()))
        return store
    }
    @Test func answerLocksAcrossSurfacesAndNewRequestGetsNewLock() async throws {
        var job = try fixture().waitingJobs[0]
        let response = try JSONEncoder().encode(job)
        let calls = Mutex(0)
        let jobID = job.id
        let api = api { request in
            #expect(request.url?.path == "/api/jobs/\(jobID)/reply")
            calls.withLock { $0 += 1 }
            return (200, response, 0.05)
        }
        let store = try store(api: api)
        let original = job
        let first = Task { await store.answer(original, decision: "approve") }
        await Task.yield()
        await store.answer(original, decision: "deny")
        await first.value
        await store.answer(original, decision: "approve")
        #expect(calls.withLock { $0 } == 1)
        #expect(store.actions[original.requestKey]?.accepted == true)
        job.waiting?.id = "next-request"
        #expect(store.actions[job.requestKey]?.locked != true)
    }
    @Test func failedAnswersKeepDraftAndAllowRetry() async throws {
        let calls = Mutex(0)
        let job = try fixture().waitingJobs[0]
        let response = try JSONEncoder().encode(job)
        let api = api { _ in
            let count = calls.withLock { $0 += 1; return $0 }
            return count == 1 ? (400, Data("{\"error\":\"Try again\"}".utf8), 0) : (200, response, 0)
        }
        let store = try store(api: api)
        store.drafts[job.requestKey] = "한글 답변"
        await store.answer(job, message: store.drafts[job.requestKey])
        #expect(store.drafts[job.requestKey] == "한글 답변")
        #expect(store.actions[job.requestKey]?.error == "Try again")
        await store.answer(job, message: store.drafts[job.requestKey])
        #expect(calls.withLock { $0 } == 2)
        #expect(store.drafts[job.requestKey] == nil)
    }
    @Test func lateHTTPReplyCannotOverwriteNewerStream() throws {
        let store = try store()
        var current = store.state.jobs[0]
        let old = current
        current.seq += 1; current.state = "done"
        store.applyJob(current); store.applyJob(old)
        #expect(store.state.jobs[0].state == "done")
    }
    @Test func sameSequenceStreamUpdateWinsOverInFlightHTTP() throws {
        let store = try store()
        let old = store.state.jobs[0]
        let version = store.jobVersion(old.id)
        var current = old
        current.phase = "A newer phase without a new event"
        try store.receive(event("job", current))
        store.applyJob(old, since: version)
        #expect(store.state.jobs[0].phase == current.phase)
        let beforeReconnect = store.jobVersion(old.id)
        var snapshot = try fixture()
        snapshot.jobs = []
        try store.receive(event("state", snapshot))
        store.applyJob(old, since: beforeReconnect)
        #expect(store.state.jobs.isEmpty)
    }
    @Test func pendingAcrossProjectsAndSavedFilterRemainReachable() throws {
        let store = try store()
        store.selection = "project:/missing/project"
        #expect(store.projects.contains("/missing/project"))
        #expect(store.state.pendingCount == 1)
        store.openJob("cx-question", navigate: true)
        #expect(store.project == "/workspace/Crew")
        #expect(store.selectedJob == "cx-question")
    }
    @Test func openingInspectorPreservesListContext() throws {
        let store = try store()
        store.selection = "history"; store.search = "query"
        store.openJob("cx-question")
        #expect(store.selection == "history")
        #expect(store.search == "query")
        #expect(store.selectedJob == "cx-question")
        store.selection = "needs"
        #expect(store.selectedJob == nil)
        store.openJob("cx-question", navigate: true)
        #expect(store.selectedJob == "cx-question")
    }
    @Test func completionLeasePreservesOwnershipAcrossTransientFailure() async throws {
        let calls = Mutex(0)
        let api = api { request in
            #expect(request.timeoutInterval == 4)
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 { return (200, Data("{\"completionNotifications\":true,\"from\":1000,\"until\":16000}".utf8), 0) }
            if count == 2 { throw URLError(.timedOut) }
            return (200, Data("{}".utf8), 0)
        }
        let store = try store(api: api)
        await store.sendHeartbeat()
        #expect(store.ownsCompletion(at: 5000))
        await store.sendHeartbeat()
        #expect(store.ownsCompletion(at: 5000))
        await store.sendHeartbeat()
        #expect(!store.ownsCompletion(at: 16000))
    }
    @Test func createResponsePreservesSameSequenceStreamProgress() throws {
        let store = try store()
        var created = store.state.jobs[0]
        created.id = "newly-created"
        var streamed = created
        streamed.phase = "Working"; streamed.sessionId = "new-session"
        try store.receive(event("job", streamed))
        store.applyJob(created, since: 0)
        #expect(store.state.jobs.first { $0.id == created.id }?.sessionId == "new-session")
        created.id = "created-before-stream"
        store.applyJob(created, since: 0)
        #expect(store.state.jobs.contains { $0.id == created.id })
    }
    @Test func usageAndPresetEventsReplaceReadingsAndReconnectClearsThem() throws {
        let store = try store()
        let current = try fixture("state-extended")
        try store.receive(event("usage", try #require(current.usage)))
        try store.receive(event("preset", PresetState(preset: current.preset, presets: try #require(current.presets))))
        #expect(store.usage == current.usage)
        #expect(store.state.preset == .balanced)
        #expect(store.state.presets == current.presets)
        try store.receive(event("job", current.jobs[0]))
        try store.receive(event("mission", current.missions[0]))
        #expect(store.state.jobs[0].rounds?.count == 2)
        #expect(store.state.missions[0].notes?.count == 1)
        try store.receive(event("preset", PresetState(preset: nil, presets: [:])))
        #expect(store.state.preset == nil)
        try store.receive(event("state", current))
        #expect(store.usage == current.usage)
        try store.receive(event("state", fixture()))
        #expect(store.usage == nil && store.state.presets == nil)
    }
    @Test func presetSendsNameOrNullAndPreservesEditsWhileSaving() async throws {
        let definitions = try #require(fixture("state-extended").presets)
        let calls = Mutex(0)
        let api = api { request in
            #expect(request.url?.path == "/api/preset")
            let body = try requestBody(request)
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 { #expect(body["preset"] as? String == "economy") }
            else { #expect(body["preset"] is NSNull) }
            let result = PresetState(preset: count == 1 ? .economy : nil, presets: definitions)
            return (200, try JSONEncoder().encode(result), 0.05)
        }
        let settings = SettingsModel(api: api, roles: [:], preset: .balanced, presets: definitions)
        settings.preset = .economy
        #expect(settings.dirty)
        let save = Task { await settings.savePreset() }
        try await Task.sleep(for: .milliseconds(10))
        #expect(settings.busy)
        await settings.savePreset()
        settings.preset = .best
        await save.value
        #expect(settings.preset == .best && settings.savedPreset == .economy)
        #expect(settings.dirty && !settings.busy)
        settings.preset = nil
        await settings.savePreset()
        #expect(calls.withLock { $0 } == 2)
        #expect(!settings.dirty && settings.presetStatus == "Saved")
    }
    @Test func failedPresetSaveRetainsDraftAndCanRetry() async throws {
        let definitions = try #require(fixture("state-extended").presets)
        let calls = Mutex(0)
        let api = api { _ in
            if calls.withLock({ $0 += 1; return $0 }) == 1 {
                return (400, Data(#"{"error":"Cannot save preset"}"#.utf8), 0)
            }
            return (200, try JSONEncoder().encode(PresetState(preset: .best, presets: definitions)), 0)
        }
        let settings = SettingsModel(api: api, roles: [:], presets: definitions)
        settings.preset = .best
        await settings.savePreset()
        #expect(settings.preset == .best && settings.savedPreset == nil)
        #expect(settings.dirty && !settings.busy)
        #expect(settings.presetStatus == "Cannot save preset")
        await settings.savePreset()
        #expect(!settings.dirty && !settings.busy)
        #expect(settings.savedPreset == .best && settings.presetStatus == "Saved")
    }
    @Test func roundRequestsLockAndSendUndoOrKeep() async throws {
        var job = try fixture("state-extended").jobs[0]
        job.state = "done"; job.endedAt = 1
        let originalJob = job
        let id = job.id
        let calls = Mutex(0)
        let api = api { request in
            #expect(request.url?.path == "/api/jobs/\(id)/rounds/1")
            let body = try requestBody(request)
            let count = calls.withLock { $0 += 1; return $0 }
            #expect(body.count == 1)
            #expect(body[count == 1 ? "undo" : "keep"] as? Bool == true)
            var updated = originalJob
            updated.rounds?[0].state = count == 1 ? "undone" : "kept"
            return (200, try JSONEncoder().encode(updated), 0.05)
        }
        let store = try store(api: api)
        let original = job
        let first = Task { await store.setRound(original, turn: 1, undo: true) }
        try await Task.sleep(for: .milliseconds(10))
        await store.setRound(original, turn: 1, undo: true)
        await first.value
        #expect(store.state.jobs.first { $0.id == id }?.rounds?.first?.state == "undone")
        await store.setRound(original, turn: 1, undo: false)
        #expect(store.state.jobs.first { $0.id == id }?.rounds?.first?.state == "kept")
        #expect(calls.withLock { $0 } == 2)
        #expect(store.actions[job.roundActionKey(1)]?.locked == false)
        for state in ["running", "waiting"] {
            job.state = state
            #expect(job.roundUnavailableReason != nil)
            await store.setRound(job, turn: 1, undo: true)
        }
        job.state = "done"; job.worktree = nil
        #expect(job.roundUnavailableReason != nil)
        await store.setRound(job, turn: 1, undo: true)
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func roundServerErrorsAreInlineAndRetryable() async throws {
        var job = try fixture("state-extended").jobs[0]
        job.state = "done"
        let api = api { _ in (400, Data(#"{"error":"Revert conflicts"}"#.utf8), 0) }
        let store = try store(api: api)
        await store.setRound(job, turn: 1, undo: true)
        #expect(store.actions[job.roundActionKey(1)]?.error == "Revert conflicts")
        #expect(store.actions[job.roundActionKey(1)]?.locked == false)
    }
    @Test func questionSendsReadOnlyIntentAndAppliesJob() async throws {
        var job = try fixture().jobs[0]
        job.id = "new-question"; job.ask = true
        let response = try JSONEncoder().encode(job)
        let api = api { request in
            #expect(request.url?.path == "/api/jobs")
            let body = try requestBody(request)
            #expect(body.count == 4)
            #expect(body["kind"] as? String == "delegate")
            #expect(body["ask"] as? Bool == true)
            #expect(body["task"] as? String == "Why?")
            #expect(body["cwd"] as? String == "/project")
            return (200, response, 0)
        }
        let store = try store(api: api)
        let created = try await store.submitQuestion("Why?", project: "/project")
        #expect(created.kindTitle == "Question")
        #expect(store.state.jobs.contains { $0.id == "new-question" && $0.ask == true })
    }
    @Test func informationSendsMissionNotesOrScopedInstructionAppend() async throws {
        var mission = try fixture().missions[0]
        mission.notes = [MissionNote(text: "Remember this", at: 1)]
        let response = try JSONEncoder().encode(mission)
        let calls = Mutex(0)
        let api = api { request in
            let body = try requestBody(request)
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 {
                #expect(request.url?.path == "/api/missions/mission-1")
                #expect(body.count == 1 && body["note"] as? String == "Remember this")
                return (200, response, 0)
            }
            #expect(request.url?.path == "/api/instructions")
            #expect(body.count == 2 && body["append"] as? String == "Remember this")
            if count == 2 { #expect(body["project"] as? String == "/project") }
            else { #expect(body["project"] is NSNull) }
            return (200, Data(#"{"file":"instructions.md","text":"Remember this"}"#.utf8), 0)
        }
        let store = try store(api: api)
        try await store.addInformation("Remember this", mission: "mission-1", project: "/project")
        #expect(store.state.missions[0].notes?.first?.text == "Remember this")
        try await store.addInformation("Remember this", mission: nil, project: "/project")
        try await store.addInformation("Remember this", mission: nil, project: nil)
        #expect(calls.withLock { $0 } == 3)
    }
    @Test func lateSettingsLoadCannotReplaceNewScope() async throws {
        let api = api { request in
            let slow = request.url?.query == nil
            return (200, Data("{\"file\":\"\(slow ? "global" : "project")\",\"text\":\"\(slow ? "old" : "new")\"}".utf8), slow ? 0.1 : 0)
        }
        let settings = SettingsModel(api: api, roles: [:])
        let first = Task { await settings.load(scope: "") }
        try await Task.sleep(for: .milliseconds(10))
        await settings.load(scope: "/project")
        await first.value
        #expect(settings.scope == "/project")
        #expect(settings.text == "new")
        #expect(settings.file == "project")
    }
    @Test func editsDuringSaveArePreserved() async throws {
        let api = api { request in
            if request.httpMethod == "POST" { return (200, Data("{\"file\":\"global\",\"text\":\"submitted\\n\"}".utf8), 0.1) }
            return (200, Data("{\"file\":\"global\",\"text\":\"\"}".utf8), 0)
        }
        let settings = SettingsModel(api: api, roles: [:])
        await settings.load(scope: "")
        settings.text = "submitted"
        let save = Task { await settings.saveInstructions() }
        try await Task.sleep(for: .milliseconds(10))
        settings.text = "newer edit"
        await save.value
        #expect(settings.text == "newer edit")
        #expect(settings.savedText == "submitted\n")
        #expect(settings.dirty)
    }
    @Test func failedLoadDisablesSave() async {
        let calls = Mutex(0)
        let api = api { _ in calls.withLock { $0 += 1 }; return (500, Data("{\"error\":\"Cannot read\"}".utf8), 0) }
        let settings = SettingsModel(api: api, roles: [:])
        await settings.load(scope: "")
        await settings.saveInstructions()
        #expect(!settings.loaded)
        #expect(calls.withLock { $0 } == 1)
        #expect(settings.textStatus == "Cannot read")
    }
}

private func requestBody(_ request: URLRequest) throws -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? CrewFailure("Cannot read request body") }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}
