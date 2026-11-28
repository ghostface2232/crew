import CryptoKit
import Foundation
import Synchronization

struct ServerEvent: Sendable, Equatable {
    var name: String
    var data: Data
}

struct SSEParser: Sendable {
    /// The daemon sends its whole state as one event on each connection, already about 8 MB with a few hundred jobs, and
    /// a limit it outgrows would reconnect for ever. This bound only stops a runaway stream from exhausting memory.
    static let limit = 256 * 1024 * 1024
    private var buffer = Data()
    private var name = "message"
    private var lines: [String] = []
    private var eventSize = 0
    private var scanOffset = 0
    mutating func feed(_ bytes: Data) throws -> [ServerEvent] {
        buffer.append(bytes)
        var events: [ServerEvent] = []
        while let end = buffer[buffer.index(buffer.startIndex, offsetBy: scanOffset)...].firstIndex(of: 10) {
            var line = buffer.subdata(in: buffer.startIndex..<end)
            buffer.removeSubrange(buffer.startIndex...end)
            scanOffset = 0
            if line.last == 13 { line.removeLast() }
            guard let text = String(data: line, encoding: .utf8) else { throw CrewFailure(String(localized: "Invalid UTF-8 from the daemon.")) }
            if text.isEmpty {
                if !lines.isEmpty { events.append(ServerEvent(name: name, data: Data(lines.joined(separator: "\n").utf8))) }
                name = "message"; lines = []; eventSize = 0
            } else if text.hasPrefix("event:") {
                name = field(text)
            } else if text.hasPrefix("data:") {
                lines.append(field(text)); eventSize += line.count
            }
            guard eventSize < Self.limit else { throw CrewFailure(String(localized: "The daemon sent an oversized event.")) }
        }
        scanOffset = buffer.count
        guard buffer.count < Self.limit else { throw CrewFailure(String(localized: "The daemon sent an oversized event.")) }
        return events
    }
    private func field(_ text: String) -> String {
        let value = text.dropFirst(text.firstIndex(of: ":")!.utf16Offset(in: text) + 1)
        return String(value.first == " " ? value.dropFirst() : value)
    }
}

struct CrewFailure: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
struct DaemonSignInFailure: LocalizedError {
    let tokenFile: URL
    var errorDescription: String? { String(localized: "Could not sign in to the Crew daemon. Check the token file at \(tokenFile.path).") }
}

enum CrewHome {
    static func directory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        URL(fileURLWithPath: environment["CREW_HOME"] ?? NSHomeDirectory() + "/.crew")
    }
}

struct EmptyReply: Codable, Sendable {}
struct Instructions: Codable, Sendable { var text: String }

final class CrewAPI: Sendable {
    private struct DaemonRecord: Decodable { var port: Int; var pid: Int32? }
    // Keep the discovery list in sync with the bundled CLI's default PORTS.
    private static let daemonPorts = [47615, 42615, 37615, 32615, 27615]
    private let portOverride: Int?
    private let daemonFile: URL
    var baseURL: URL {
        let port = portOverride ?? recordedPort() ?? Self.daemonPorts[0]
        return URL(string: "http://127.0.0.1:\(port)")!
    }
    let tokenFile: URL
    @MainActor var onSignInFailure: (@MainActor @Sendable (DaemonSignInFailure) -> Void)?
    private let session: URLSession
    /// The daemon process each port proved to be, so the token is not sent to whatever else may listen there.
    private let verified = Mutex<[Int: Int32]>([:])
    init(port: Int? = nil, configuration: URLSessionConfiguration? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        let home = CrewHome.directory(environment: environment)
        tokenFile = home.appendingPathComponent("token")
        daemonFile = home.appendingPathComponent("daemon.json")
        portOverride = port ?? environment["CREW_PORT"].flatMap(Int.init).flatMap { (1...65535).contains($0) ? $0 : nil }
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 60 * 60 * 24
        session = URLSession(configuration: config)
    }
    func request<T: Decodable & Sendable>(_ path: String, body: Data? = nil, timeout: TimeInterval? = nil) async throws -> T {
        try await request(URL(string: path, relativeTo: baseURL)!, body: body, timeout: timeout)
    }
    private func request<T: Decodable & Sendable>(_ url: URL, body: Data?, timeout: TimeInterval?) async throws -> T {
        var request = URLRequest(url: url)
        // Worktree creation and review preparation can take minutes. A short timeout leaves
        // the daemon working while the UI offers a duplicate submission.
        request.timeoutInterval = timeout ?? (body == nil ? 10 : 60 * 60 * 24)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let original = request
        let data = try await authenticated(port: url.absoluteURL.port ?? 0) { token in
            var request = original
            request.setValue(token.map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization")
            let (data, response) = try await session.data(for: request)
            try validate(response, data: data)
            return data
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func post<T: Decodable & Sendable, B: Encodable & Sendable>(_ path: String, _ body: B, timeout: TimeInterval? = nil) async throws -> T {
        try await request(path, body: JSONEncoder().encode(body), timeout: timeout)
    }
    /// The board's address with a sign-in ticket in its fragment. A ticket signs one page in once, within a minute,
    /// so the address is worth nothing in a browser's history. Without one, the page says how to sign in.
    func webBoardURL() async -> URL {
        struct Issued: Decodable, Sendable { var ticket: String }
        let address = baseURL
        let url = address.appendingPathComponent("api/session/ticket")
        guard let issued: Issued = try? await request(url, body: JSONEncoder().encode(EmptyReply()), timeout: 5) else { return address }
        var components = URLComponents(url: address, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.fragment = "ticket=\(issued.ticket)"
        return components.url!
    }
    private func record() -> DaemonRecord? {
        guard let data = try? Data(contentsOf: daemonFile) else { return nil }
        return try? JSONDecoder().decode(DaemonRecord.self, from: data)
    }
    private func recordedPort() -> Int? {
        guard let port = record()?.port, Self.daemonPorts.contains(port) else { return nil }
        return port
    }
    private func readToken() -> String? {
        guard let contents = try? String(contentsOf: tokenFile, encoding: .utf8) else { return nil }
        let token = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.utf8.count == 64, token.utf8.allSatisfy({
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }) else { return nil }
        return token
    }
    /// The token, once the listener on `port` has shown it is this Crew home's daemon. Without a token nothing secret
    /// goes out, so nothing is checked. A listener that cannot show it reads as no daemon at all.
    private func verifiedToken(port: Int) async throws -> String? {
        guard let token = readToken() else { return nil }
        let record = record()
        // A daemon restarted on the same port records a new process; any other change shows up as a failed connection.
        if let pid = verified.withLock({ $0[port] }), record?.port != port || record?.pid == nil || record?.pid == pid { return token }
        guard let pid = await prove(port: port, token: token, record: record) else { throw URLError(.cannotConnectToHost) }
        verified.withLock { $0[port] = pid }
        return token
    }
    /// The daemon's process when the listener on `port` is Crew's daemon for this home: it signs a fresh challenge with
    /// the token, or, from a daemon that predates signing, it is the live process this home recorded on that port.
    private func prove(port: Int, token: String, record: DaemonRecord?) async -> Int32? {
        struct Health: Decodable { var pid: Int32; var proof: String? }
        let challenge = SymmetricKey(size: .bits256).withUnsafeBytes { bytes in bytes.map { String(format: "%02x", $0) }.joined() }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health?challenge=\(challenge)")!)
        request.timeoutInterval = 10
        guard let (data, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200,
              let health = try? JSONDecoder().decode(Health.self, from: data) else { return nil }
        if let proof = health.proof {
            guard let code = Self.digest(hex: proof) else { return nil }
            let signed = HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data("crew-health:\(challenge)".utf8),
                                                                  using: SymmetricKey(data: Data(token.utf8)))
            return signed ? health.pid : nil
        }
        guard let record, record.port == port, record.pid == health.pid, health.pid > 0,
              kill(health.pid, 0) == 0 || errno == EPERM else { return nil }
        return health.pid
    }
    /// A SHA-256 digest written as lowercase hex.
    private static func digest(hex: String) -> Data? {
        let digits = Array(hex.utf8)
        guard digits.count == 64 else { return nil }
        let nibble = { (digit: UInt8) -> UInt8? in
            switch digit { case 48...57: digit - 48; case 97...102: digit - 87; default: nil }
        }
        var bytes = Data(capacity: 32)
        for index in stride(from: 0, to: digits.count, by: 2) {
            guard let high = nibble(digits[index]), let low = nibble(digits[index + 1]) else { return nil }
            bytes.append(high << 4 | low)
        }
        return bytes
    }
    /// A failed connection or sign-in may mean another process holds the port now, so it proves itself again.
    private func forget(_ port: Int, after error: Error) {
        guard error is URLError || error is DaemonSignInFailure else { return }
        verified.withLock { _ = $0.removeValue(forKey: port) }
    }
    private func authenticated<T: Sendable>(port: Int, _ operation: (String?) async throws -> T) async throws -> T {
        var token: String?
        do {
            token = try await verifiedToken(port: port)
            return try await operation(token)
        } catch {
            forget(port, after: error)
            try Task.checkCancellation()
            guard error is DaemonSignInFailure || (token == nil && error is URLError) else { throw error }
            // Startup can create the file after a connection failure; a 401 can mean it was replaced.
            do { return try await operation(try await verifiedToken(port: port)) }
            catch let failure as DaemonSignInFailure {
                forget(port, after: failure)
                try Task.checkCancellation()
                await onSignInFailure?(failure)
                throw failure
            } catch {
                forget(port, after: error)
                throw error
            }
        }
    }
    func stream(receive: @escaping @MainActor @Sendable (ServerEvent) async throws -> Void) async throws {
        let address = baseURL
        let port = address.port ?? 0
        // However the stream ends, the daemon behind it may have gone, so the next one proves itself again.
        defer { verified.withLock { _ = $0.removeValue(forKey: port) } }
        try await authenticated(port: port) { token in
            var request = URLRequest(url: address.appendingPathComponent("api/stream"))
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue(token.map { "Bearer \($0)" }, forHTTPHeaderField: "Authorization")
            let connection = StreamConnection(request: request, configuration: session.configuration, tokenFile: tokenFile)
            let events = connection.events()
            try await withTaskCancellationHandler {
                defer { connection.cancel() }
                for try await event in events {
                    try Task.checkCancellation()
                    try await receive(event)
                }
            } onCancel: { connection.cancel() }
        }
    }
    private func validate(_ response: URLResponse, data: Data) throws {
        if (response as? HTTPURLResponse)?.statusCode == 401 { throw DaemonSignInFailure(tokenFile: tokenFile) }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            struct ErrorBody: Decodable { var error: String }
            throw CrewFailure((try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? String(localized: "The daemon could not complete the request."))
        }
    }
}

enum DaemonLauncher {
    static func start() async throws {
        if ProcessInfo.processInfo.environment["CREW_ATTACH_ONLY"] == "1" { return }
        // A downloaded app opened where it was unpacked runs from a temporary read-only copy (App Translocation). The
        // daemon outlives the app, so one started from there would keep the port after the copy is gone and stop
        // answering, and no later launch could replace it.
        if Bundle.main.bundlePath.contains("/AppTranslocation/") {
            throw CrewFailure(String(localized: "Move Crew to the Applications folder, then open it from there."))
        }
        guard let resources = Bundle.main.resourceURL else { throw CrewFailure(String(localized: "Missing application resources.")) }
        let node = resources.appendingPathComponent("runtime/node")
        let cli = resources.appendingPathComponent("bridge/plugin/bridge/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            throw CrewFailure(String(localized: "The bundled daemon is missing. Rebuild Crew with npm run package:desktop."))
        }
        // The existing CLI owns version negotiation and never replaces a daemon with active jobs.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = node
            process.arguments = [cli.path, "daemon", "start"]
            process.environment = ProcessInfo.processInfo.environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { process in
                if process.terminationStatus == 0 { continuation.resume() }
                else { continuation.resume(throwing: CrewFailure(String(localized: "Could not start the daemon. Check ~/.crew/daemon.log, then retry."))) }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }
}

// URLSession delivers chunks on a serial delegate queue. Cancellation can arrive on any executor.
private final class StreamConnection: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private let configuration: URLSessionConfiguration
    private let tokenFile: URL
    private let lock = NSLock()
    private var parser = SSEParser()
    private var continuation: AsyncThrowingStream<ServerEvent, Error>.Continuation?
    private var session: URLSession?
    private var finished = false
    init(request: URLRequest, configuration: URLSessionConfiguration, tokenFile: URL) {
        self.request = request; self.configuration = configuration; self.tokenFile = tokenFile
    }

    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(512)) { continuation in
            lock.lock()
            guard !finished else { lock.unlock(); continuation.finish(throwing: CancellationError()); return }
            self.continuation = continuation
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            lock.unlock()
            continuation.onTermination = { [weak self] _ in self?.cancel() }
            session.dataTask(with: request).resume()
        }
    }
    func cancel() { finish(CancellationError()) }
    private func finish(_ error: Error) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation, session = self.session
        self.continuation = nil; self.session = nil
        lock.unlock()
        continuation?.finish(throwing: error)
        session?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            finish(DaemonSignInFailure(tokenFile: tokenFile))
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true else {
            completionHandler(.cancel)
            finish(CrewFailure(String(localized: "Could not open the daemon event stream.")))
            return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        do {
            let events = try parser.feed(data)
            lock.lock()
            let continuation = self.continuation
            lock.unlock()
            for event in events {
                // Never silently drop state updates when the UI is busy; reconnect for a fresh snapshot.
                if case .dropped = continuation?.yield(event) {
                    finish(CrewFailure(String(localized: "Catching up with the daemon…")))
                    return
                }
            }
        } catch { finish(error) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error ?? CrewFailure(String(localized: "Connection closed. Reconnecting…")))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
