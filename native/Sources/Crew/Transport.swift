import Foundation

struct ServerEvent: Sendable, Equatable {
    var name: String
    var data: Data
}

struct SSEParser: Sendable {
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
            guard let text = String(data: line, encoding: .utf8) else { throw CrewFailure("Invalid UTF-8 from the daemon.") }
            if text.isEmpty {
                if !lines.isEmpty { events.append(ServerEvent(name: name, data: Data(lines.joined(separator: "\n").utf8))) }
                name = "message"; lines = []; eventSize = 0
            } else if text.hasPrefix("event:") {
                name = field(text)
            } else if text.hasPrefix("data:") {
                lines.append(field(text)); eventSize += line.count
            }
            guard eventSize < 16 * 1024 * 1024 else { throw CrewFailure("The daemon sent an oversized event.") }
        }
        scanOffset = buffer.count
        guard buffer.count < 16 * 1024 * 1024 else { throw CrewFailure("The daemon sent an oversized event.") }
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
    var errorDescription: String? { "Could not sign in to the Crew daemon. Check the token file at \(tokenFile.path)." }
}

enum CrewHome {
    static func directory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        URL(fileURLWithPath: environment["CREW_HOME"] ?? NSHomeDirectory() + "/.crew")
    }
}

struct EmptyReply: Codable, Sendable {}
struct Instructions: Codable, Sendable { var file: String; var text: String }

final class CrewAPI: Sendable {
    let baseURL: URL
    let tokenFile: URL
    @MainActor var onSignInFailure: (@MainActor @Sendable (DaemonSignInFailure) -> Void)?
    private let session: URLSession
    init(port: Int = Int(ProcessInfo.processInfo.environment["CREW_PORT"] ?? "") ?? 47615, configuration: URLSessionConfiguration? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        tokenFile = CrewHome.directory(environment: environment).appendingPathComponent("token")
        baseURL = URL(string: "http://127.0.0.1:\(port)")!
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 35
        config.timeoutIntervalForResource = 60 * 60 * 24
        session = URLSession(configuration: config)
    }
    func request<T: Decodable & Sendable>(_ path: String, body: Data? = nil, timeout: TimeInterval? = nil) async throws -> T {
        var request = URLRequest(url: URL(string: path, relativeTo: baseURL)!)
        // Worktree creation and review preparation can take minutes. A short timeout leaves
        // the daemon working while the UI offers a duplicate submission.
        request.timeoutInterval = timeout ?? (body == nil ? 10 : 60 * 60 * 24)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let original = request
        let data = try await authenticated { token in
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
    var webBoardURL: URL {
        guard let token = readToken() else { return baseURL }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.fragment = "token=\(token)"
        return components.url!
    }
    private func readToken() -> String? {
        guard let contents = try? String(contentsOf: tokenFile, encoding: .utf8) else { return nil }
        let token = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.utf8.count == 64, token.utf8.allSatisfy({
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }) else { return nil }
        return token
    }
    private func authenticated<T: Sendable>(_ operation: (String?) async throws -> T) async throws -> T {
        let token = readToken()
        do { return try await operation(token) }
        catch {
            try Task.checkCancellation()
            guard error is DaemonSignInFailure || (token == nil && error is URLError) else { throw error }
            // Startup can create the file after a connection failure; a 401 can mean it was replaced.
            do { return try await operation(readToken()) }
            catch let failure as DaemonSignInFailure {
                try Task.checkCancellation()
                await onSignInFailure?(failure)
                throw failure
            }
        }
    }
    func stream(receive: @escaping @MainActor @Sendable (ServerEvent) async throws -> Void) async throws {
        try await authenticated { token in
            var request = URLRequest(url: baseURL.appendingPathComponent("api/stream"))
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
            throw CrewFailure((try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? "The daemon could not complete the request.")
        }
    }
}

enum DaemonLauncher {
    static func start() async throws {
        if ProcessInfo.processInfo.environment["CREW_ATTACH_ONLY"] == "1" { return }
        guard let resources = Bundle.main.resourceURL else { throw CrewFailure("Missing application resources.") }
        let node = resources.appendingPathComponent("runtime/node")
        let cli = resources.appendingPathComponent("bridge/plugin/bridge/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            throw CrewFailure("The bundled daemon is missing. Rebuild Crew with npm run package:desktop.")
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
                else { continuation.resume(throwing: CrewFailure("Could not start the daemon. Check ~/.crew/daemon.log, then retry.")) }
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
            finish(CrewFailure("Could not open the daemon event stream."))
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
                    finish(CrewFailure("Catching up with the daemon…"))
                    return
                }
            }
        } catch { finish(error) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error ?? CrewFailure("Connection closed. Reconnecting…"))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
