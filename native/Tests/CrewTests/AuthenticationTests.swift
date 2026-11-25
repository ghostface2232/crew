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
    private func api(home: URL, port: Int? = 0, handler: @escaping AuthenticationProtocol.Handler) -> CrewAPI {
        AuthenticationProtocol.handler.withLock { $0 = handler }
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

    @Test func crewHomeControlsTokenLocationAndDefaultsToUserHome() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        let api = api(home: home) { _ in (200, Data()) }
        #expect(api.tokenFile.path == home.appendingPathComponent("token").path)
        #expect(CrewHome.directory(environment: ["CREW_HOME": home.path]).path == home.path)
        #expect(CrewHome.directory(environment: [:]).path == NSHomeDirectory() + "/.crew")
    }
}
