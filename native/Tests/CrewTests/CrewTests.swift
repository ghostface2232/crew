import Foundation
import Synchronization
import Testing
@testable import Crew

func fixture() throws -> BoardState {
    let file = Bundle.module.url(forResource: "state", withExtension: "json", subdirectory: "Fixtures")!
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
        let api = CrewAPI(port: port)
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
        let limits = try JSONDecoder().decode([String: Usage?].self, from: Data(wire.utf8))
        #expect(limits["codex"]??.windows?.first?.minutes == nil)
        #expect(limits["codex"]??.windows?.first?.usedPercent == 42)
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
        return CrewAPI(configuration: config)
    }
    private func store(api: CrewAPI = CrewAPI()) throws -> CrewStore {
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
