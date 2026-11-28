import CryptoKit
import Foundation
import Synchronization
import Testing
@testable import Crew

private final class AuthenticationProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)
    static let handler = Mutex<Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let handler = Self.handler.withLock { $0 }
            let (status, data) = try handler!(request)
            // A redirect names its target in the body.
            if (300..<400).contains(status), let location = String(data: data, encoding: .utf8) {
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Location": location])!
                client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: location)!), redirectResponse: response)
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            let contentType = request.url?.path == "/api/stream" && status == 200 ? "text/event-stream" : "application/json"
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                                               headerFields: ["Content-Type": contentType])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@Suite(.serialized) @MainActor struct AuthenticationTests {
    private let firstToken = String(repeating: "a1", count: 32)
    private let nextToken = String(repeating: "B2", count: 32)
    private func home() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("crew-auth-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
    private func write(_ token: String, home: URL) throws {
        try (token + "\n").write(to: home.appendingPathComponent("token"), atomically: true, encoding: .utf8)
    }
    /// Health as a current daemon answers it: the challenge signed with the token in `home`.
    nonisolated private static func signedHealth(home: URL, pid: Int = 4242) -> AuthenticationProtocol.Handler {
        { request in (200, Data(#"{"name":"crew","pid":\#(pid),"proof":"\#(try proof(for: request, home: home))"}"#.utf8)) }
    }
    nonisolated private static func proof(for request: URLRequest, home: URL) throws -> String {
        let challenge = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "challenge" }?.value ?? ""
        let token = try String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let code = HMAC<SHA256>.authenticationCode(for: Data("crew-health:\(challenge)".utf8), using: SymmetricKey(data: Data(token.utf8)))
        return code.map { String(format: "%02x", $0) }.joined()
    }
    private func api(home: URL, port: Int? = 0, health: AuthenticationProtocol.Handler? = nil, handler: @escaping AuthenticationProtocol.Handler) -> CrewAPI {
        let health = health ?? Self.signedHealth(home: home)
        AuthenticationProtocol.handler.withLock {
            $0 = { request in
                guard request.url?.path == "/api/health" else { return try handler(request) }
                // Health proves the daemon before the token goes out, so it never carries it.
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                return try health(request)
            }
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AuthenticationProtocol.self]
        return CrewAPI(port: port, configuration: config, environment: ["CREW_HOME": home.path])
    }
    @Test func jsonRequestCarriesToken() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let token = firstToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            calls.withLock { $0 += 1 }
            return (200, Data("{}".utf8))
        }
        let _: EmptyReply = try await api.post("/api/jobs", EmptyReply())
        #expect(calls.withLock { $0 } == 1)
    }
    @Test func missingTokenIsReadAgainWhenFileAppearsOnRetry() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let token = nextToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 {
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                try (token + "\n").write(to: home.appendingPathComponent("token"), atomically: true, encoding: .utf8)
                throw URLError(.cannotConnectToHost)
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            return (200, Data("{}".utf8))
        }
        let _: EmptyReply = try await api.request("/api/state")
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func unauthorizedRequestReloadsChangedTokenAndRetriesOnce() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let old = firstToken, new = nextToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            #expect(request.httpMethod == "POST")
            let count = calls.withLock { $0 += 1; return $0 }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(count == 1 ? old : new)")
            if count == 1 {
                try (new + "\n").write(to: home.appendingPathComponent("token"), atomically: true, encoding: .utf8)
                return (401, Data(#"{"error":"unauthorized"}"#.utf8))
            }
            return (200, Data("{}".utf8))
        }
        let _: EmptyReply = try await api.post("/api/jobs", EmptyReply())
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func persistentUnauthorizedRequestSetsSignInStateAndSafeMessage() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let calls = Mutex(0)
        let api = api(home: home) { _ in
            calls.withLock { $0 += 1 }
            return (401, Data(#"{"error":"unauthorized"}"#.utf8))
        }
        let store = CrewStore(api: api)
        store.connected = true
        do {
            let _: EmptyReply = try await api.request("/api/state")
            Issue.record("Unauthorized request unexpectedly succeeded")
        } catch { #expect(error is DaemonSignInFailure) }
        #expect(calls.withLock { $0 } == 2)
        #expect(!store.connected && store.signInRequired)
        #expect(store.connectionMessage == "Could not sign in to the Crew daemon. Check the token file at \(home.appendingPathComponent("token").path).")
        #expect(!store.connectionMessage.contains(firstToken))
        try store.receive(event("state", fixture()))
        #expect(store.connected && !store.signInRequired)
    }
    @Test func streamCarriesTokenAndReloadsAfterUnauthorized() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let old = firstToken, new = nextToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            #expect(request.url?.path == "/api/stream")
            #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
            let count = calls.withLock { $0 += 1; return $0 }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(count == 1 ? old : new)")
            if count == 1 {
                try (new + "\n").write(to: home.appendingPathComponent("token"), atomically: true, encoding: .utf8)
                return (401, Data())
            }
            return (200, Data("event: ready\ndata: {}\n\n".utf8))
        }
        var received = false
        do {
            try await api.stream { event in
                #expect(event.name == "ready")
                received = true
                throw CancellationError()
            }
        } catch {}
        #expect(received)
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func streamFindsTokenCreatedAfterFirstUnauthorized() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let token = firstToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 {
                #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
                try (token + "\n").write(to: home.appendingPathComponent("token"), atomically: true, encoding: .utf8)
                return (401, Data())
            }
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            return (200, Data("event: ready\ndata: {}\n\n".utf8))
        }
        var received = false
        do {
            try await api.stream { _ in received = true; throw CancellationError() }
        } catch {}
        #expect(received)
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func persistentStreamUnauthorizedProducesSignInFailure() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let calls = Mutex(0)
        let api = api(home: home) { _ in calls.withLock { $0 += 1 }; return (401, Data()) }
        let store = CrewStore(api: api)
        do {
            try await api.stream { _ in Issue.record("Unauthorized stream delivered an event") }
            Issue.record("Unauthorized stream unexpectedly succeeded")
        } catch {
            #expect(error is DaemonSignInFailure)
            store.connectionFailed(error)
        }
        #expect(calls.withLock { $0 } == 2)
        #expect(store.signInRequired && !store.connected)
        #expect(store.connectionMessage.contains(home.appendingPathComponent("token").path))
    }
    @Test func legacyDaemonWorksWithoutTokenAndMissingIsNotCached() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let token = firstToken
        let calls = Mutex(0)
        let api = api(home: home) { request in
            let count = calls.withLock { $0 += 1; return $0 }
            #expect(request.value(forHTTPHeaderField: "Authorization") == (count == 1 ? nil : "Bearer \(token)"))
            return (200, Data("{}".utf8))
        }
        let _: EmptyReply = try await api.request("/api/state")
        try write(token, home: home)
        let _: EmptyReply = try await api.request("/api/state")
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func applicationErrorsDoNotRetryMutationsWithoutToken() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let calls = Mutex(0)
        let api = api(home: home) { _ in
            calls.withLock { $0 += 1 }
            return (400, Data(#"{"error":"Try again"}"#.utf8))
        }
        do {
            let _: EmptyReply = try await api.post("/api/jobs", EmptyReply())
            Issue.record("Failed mutation unexpectedly succeeded")
        } catch { #expect(error.localizedDescription == "Try again") }
        #expect(calls.withLock { $0 } == 1)
    }
    @Test func missingTokenConnectionFailureRetriesOnlyOnce() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let calls = Mutex(0)
        let api = api(home: home) { _ in
            calls.withLock { $0 += 1 }
            throw URLError(.cannotConnectToHost)
        }
        do {
            let _: EmptyReply = try await api.request("/api/state")
            Issue.record("Unavailable daemon unexpectedly succeeded")
        } catch { #expect(error is URLError) }
        #expect(calls.withLock { $0 } == 2)
    }
    @Test func webBoardURLCarriesATicketOrIsThePlainAddress() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let token = firstToken
        let ticket = String(repeating: "c3", count: 32)
        let refused = Mutex(false)
        let api = api(home: home) { request in
            #expect(request.url?.path == "/api/session/ticket")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            return refused.withLock { $0 } ? (404, Data(#"{"error":"not found"}"#.utf8)) : (200, Data(#"{"ticket":"\#(ticket)"}"#.utf8))
        }
        // The secret itself never enters the address.
        #expect(await api.webBoardURL().absoluteString == "http://127.0.0.1:0/#ticket=\(ticket)")
        // A daemon from before tickets has no such route: the page then shows how to sign in.
        refused.withLock { $0 = true }
        #expect(await api.webBoardURL() == api.baseURL)
    }
    @Test func requestsAndStreamsReadTheCurrentPortAndKeepTicketsOnTheirIssuingPort() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let record = home.appendingPathComponent("daemon.json")
        let addresses = Mutex<[Int]>([])
        let api = api(home: home, port: nil) { request in
            addresses.withLock { $0.append(request.url!.port!) }
            switch request.url?.path {
            case "/api/session/ticket":
                try #"{"port":32615}"#.write(to: record, atomically: true, encoding: .utf8)
                return (200, Data(#"{"ticket":"ticket"}"#.utf8))
            case "/api/stream":
                return (200, Data("event: state\ndata: {}\n\n".utf8))
            default:
                return (200, Data("{}".utf8))
            }
        }
        let _: EmptyReply = try await api.request("/api/state")
        try #"{"port":42615}"#.write(to: record, atomically: true, encoding: .utf8)
        await openStream(api)
        try #"{"port":37615}"#.write(to: record, atomically: true, encoding: .utf8)
        await openStream(api)
        #expect(await api.webBoardURL().absoluteString == "http://127.0.0.1:37615/#ticket=ticket")
        let _: EmptyReply = try await api.request("/api/state")
        #expect(addresses.withLock { $0 } == [47615, 42615, 37615, 37615, 32615])
    }

    private func openStream(_ api: CrewAPI) async {
        let delivered = Mutex(false)
        do {
            try await api.stream { event in
                #expect(event.name == "state")
                delivered.withLock { $0 = true }
            }
        } catch {
            // The fixture closes the stream after one event.
            #expect(error is CrewFailure)
        }
        #expect(delivered.withLock { $0 })
    }

    @Test func aValidPortOverrideTakesPrecedenceOverTheDaemonRecord() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let record = home.appendingPathComponent("daemon.json")
        try #"{"port":42615}"#.write(to: record, atomically: true, encoding: .utf8)
        let environment = ["CREW_HOME": home.path, "CREW_PORT": "59253"]
        #expect(CrewAPI(environment: environment).baseURL.port == 59253)
        #expect(CrewAPI(port: 0, environment: environment).baseURL.port == 0)
        let fallback = CrewAPI(environment: ["CREW_HOME": home.path, "CREW_PORT": "bad"])
        #expect(fallback.baseURL.port == 42615)
        for invalid in [#"{"port":59253}"#, #"{"port":0}"#, #"{"port":65536}"#, #"{"port":"42615"}"#, "{"] {
            try invalid.write(to: record, atomically: true, encoding: .utf8)
            #expect(fallback.baseURL.port == 47615)
        }
    }

    @Test func theTokenGoesOnlyToADaemonThatSignsTheChallenge() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let challenges = Mutex<[String]>([])
        let forged: AuthenticationProtocol.Handler = { request in
            let challenge = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "challenge" }?.value ?? ""
            challenges.withLock { $0.append(challenge) }
            return (200, Data(#"{"name":"crew","pid":4242,"proof":"\#(String(repeating: "0", count: 64))"}"#.utf8))
        }
        let calls = Mutex(0)
        let api = api(home: home, health: forged) { _ in calls.withLock { $0 += 1 }; return (200, Data("{}".utf8)) }
        do {
            let _: EmptyReply = try await api.request("/api/state")
            Issue.record("A listener that could not sign the challenge was sent the token")
        } catch { #expect((error as? URLError)?.code == .cannotConnectToHost) }
        #expect(calls.withLock { $0 } == 0)
        let sent = challenges.withLock { $0 }
        #expect(!sent.isEmpty && Set(sent).count == sent.count)
        #expect(sent.allSatisfy { $0.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } })
    }
    @Test func aProvenDaemonIsCheckedOnceUntilAConnectionFails() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let own = Int(ProcessInfo.processInfo.processIdentifier)
        try #"{"port":0,"pid":\#(own)}"#.write(to: home.appendingPathComponent("daemon.json"), atomically: true, encoding: .utf8)
        let checks = Mutex(0), fail = Mutex(false)
        let signed = Self.signedHealth(home: home, pid: own)
        let api = api(home: home, health: { request in checks.withLock { $0 += 1 }; return try signed(request) }) { _ in
            if fail.withLock({ $0 }) { throw URLError(.networkConnectionLost) }
            return (200, Data("{}".utf8))
        }
        let _: EmptyReply = try await api.request("/api/state")
        let _: EmptyReply = try await api.request("/api/state")
        #expect(checks.withLock { $0 } == 1)
        fail.withLock { $0 = true }
        let _: EmptyReply? = try? await api.request("/api/state")
        fail.withLock { $0 = false }
        let _: EmptyReply = try await api.request("/api/state")
        #expect(checks.withLock { $0 } == 2)
    }
    @Test func aVerificationIsReusedOnlyWhileTheRecordedLiveProcessAndTokenStillMatch() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let record = home.appendingPathComponent("daemon.json")
        let own = Int(ProcessInfo.processInfo.processIdentifier)
        let reported = Mutex(own), checks = Mutex(0)
        let api = api(home: home, health: { request in
            checks.withLock { $0 += 1 }
            return try Self.signedHealth(home: home, pid: reported.withLock { $0 })(request)
        }) { _ in (200, Data("{}".utf8)) }
        func checked(after change: () throws -> Void) async throws -> Int {
            try change()
            let before = checks.withLock { $0 }
            let _: EmptyReply = try await api.request("/api/state")
            return checks.withLock { $0 } - before
        }
        let current = #"{"port":0,"pid":\#(own)}"#
        #expect(try await checked { try current.write(to: record, atomically: true, encoding: .utf8) } == 1)
        #expect(try await checked {} == 0)
        // The record removed, naming another port, or naming another process each prove the listener again.
        #expect(try await checked { try FileManager.default.removeItem(at: record) } == 1)
        #expect(try await checked {} == 1)
        #expect(try await checked { try #"{"port":42615,"pid":\#(own)}"#.write(to: record, atomically: true, encoding: .utf8) } == 1)
        #expect(try await checked { try #"{"port":0,"pid":\#(own + 1)}"#.write(to: record, atomically: true, encoding: .utf8) } == 1)
        #expect(try await checked {} == 1)
        #expect(try await checked { try current.write(to: record, atomically: true, encoding: .utf8) } == 0)
        // So does a token that is not the one the daemon proved.
        #expect(try await checked { try write(nextToken, home: home) } == 1)
        #expect(try await checked {} == 0)
        // And a recorded process that has exited, even one that signed while it was recorded.
        let gone = Int(Int32.max)
        reported.withLock { $0 = gone }
        #expect(try await checked { try #"{"port":0,"pid":\#(gone)}"#.write(to: record, atomically: true, encoding: .utf8) } == 1)
        #expect(try await checked {} == 1)
    }
    @Test func aHealthCheckIsNeverRedirected() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let ports = Mutex<[Int]>([])
        let redirecting: AuthenticationProtocol.Handler = { request in
            let port = request.url!.port!
            ports.withLock { $0.append(port) }
            // A listener on this port sends the challenge on to the real daemon on another.
            guard port == 0 else { return try Self.signedHealth(home: home)(request) }
            return (302, Data("http://127.0.0.1:1\(request.url!.path)?\(request.url!.query!)".utf8))
        }
        let calls = Mutex(0)
        let api = api(home: home, health: redirecting) { _ in calls.withLock { $0 += 1 }; return (200, Data("{}".utf8)) }
        do {
            let _: EmptyReply = try await api.request("/api/state")
            Issue.record("A redirected health check was taken as proof")
        } catch { #expect((error as? URLError)?.code == .cannotConnectToHost) }
        #expect(calls.withLock { $0 } == 0)
        #expect(!ports.withLock { $0 }.isEmpty && ports.withLock { $0 }.allSatisfy { $0 == 0 })
    }
    @Test func healthMustNameCrewAndAProcessAndAPresentProofMustBeValid() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let own = Int(ProcessInfo.processInfo.processIdentifier)
        // The record would let a daemon that predates signing in, so only the answer itself is refused.
        try #"{"port":0,"pid":\#(own)}"#.write(to: home.appendingPathComponent("daemon.json"), atomically: true, encoding: .utf8)
        let answers: [@Sendable (String) -> String] = [
            { #"{"pid":\#(own),"proof":"\#($0)"}"# },
            { #"{"name":"other","pid":\#(own),"proof":"\#($0)"}"# },
            { #"{"name":"crew","pid":0,"proof":"\#($0)"}"# },
            { _ in #"{"name":"crew","pid":\#(own),"proof":null}"# },
            { _ in #"{"name":"crew","pid":\#(own),"proof":5}"# },
        ]
        let answer = Mutex(0)
        let calls = Mutex(0)
        let api = api(home: home, health: { request in
            let proof = try Self.proof(for: request, home: home)
            return (200, Data(answers[answer.withLock { $0 }](proof).utf8))
        }) { _ in calls.withLock { $0 += 1 }; return (200, Data("{}".utf8)) }
        for index in answers.indices {
            answer.withLock { $0 = index }
            let _: EmptyReply? = try? await api.request("/api/state")
            #expect(calls.withLock { $0 } == 0, "Answer \(index) was taken as proof")
        }
    }
    @Test func aDaemonWithoutProofsIsTrustedOnlyAsTheRecordedLiveProcess() async throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try write(firstToken, home: home)
        let record = home.appendingPathComponent("daemon.json")
        let own = Int(ProcessInfo.processInfo.processIdentifier)
        let reported = Mutex(own)
        let legacy: AuthenticationProtocol.Handler = { _ in (200, Data(#"{"name":"crew","pid":\#(reported.withLock { $0 })}"#.utf8)) }
        let calls = Mutex(0)
        let api = api(home: home, health: legacy) { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") != nil)
            calls.withLock { $0 += 1 }
            return (200, Data("{}".utf8))
        }
        // No record, a record for another port, and a record naming another process are all refused.
        for contents in [nil, #"{"port":42615,"pid":\#(own)}"#, #"{"port":0,"pid":\#(own + 1)}"#] {
            if let contents { try contents.write(to: record, atomically: true, encoding: .utf8) }
            let _: EmptyReply? = try? await api.request("/api/state")
        }
        #expect(calls.withLock { $0 } == 0)
        try #"{"port":0,"pid":\#(own)}"#.write(to: record, atomically: true, encoding: .utf8)
        let _: EmptyReply = try await api.request("/api/state")
        #expect(calls.withLock { $0 } == 1)
        // A recorded process that has exited is not taken on its word either.
        let gone = Int32.max
        reported.withLock { $0 = Int(gone) }
        try #"{"port":0,"pid":\#(gone)}"#.write(to: record, atomically: true, encoding: .utf8)
        let _: EmptyReply? = try? await api.request("/api/state")
        #expect(calls.withLock { $0 } == 1)
    }

    @Test func crewHomeControlsTokenLocationAndDefaultsToUserHome() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let api = api(home: home) { _ in (200, Data()) }
        #expect(api.tokenFile.path == home.appendingPathComponent("token").path)
        #expect(CrewHome.directory(environment: ["CREW_HOME": home.path]).path == home.path)
        #expect(CrewHome.directory(environment: [:]).path == NSHomeDirectory() + "/.crew")
    }
}
