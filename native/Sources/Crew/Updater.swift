import AppKit
import CryptoKit
import Foundation
import Observation
import Security

/// The macOS build a GitHub release offers for this Mac.
struct ReleaseInfo: Equatable, Sendable {
    var version: String
    var url: URL
    var sha256: String
    var page: URL?
}

/// Reading GitHub releases, as the Windows app does (desktop/updater.ts). GitHub's own SHA-256 digest of the asset proves
/// the download is intact; it arrives over the same TLS connection as the download link, so it is no signature.
enum Releases {
    static let latest = URL(string: "https://api.github.com/repos/ghostface2232/crew/releases/latest")!
    #if arch(arm64)
    static let arch = "arm64"
    #else
    static let arch = "x64"
    #endif
    /// One archive per architecture, since the bundled Node runtime is built for one (scripts/package-desktop.mjs).
    static func assetName(_ version: String) -> String { "Crew-macOS-\(arch)-\(version).zip" }

    static func isVersion(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        return (1...4).contains(parts.count) && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }
    }
    /// Compares dotted numeric versions.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let b = current.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(a.count, b.count) {
            let left = index < a.count ? a[index] : 0, right = index < b.count ? b[index] : 0
            if left != right { return left > right }
        }
        return false
    }
    /// Downloads must be HTTPS; a loopback feed is allowed for testing against a local server.
    static func fetchable(_ url: URL) -> Bool {
        url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(url.host() ?? ""))
    }
    /// The archive a release offers, or nil for a draft, a prerelease, or one without a usable asset or digest.
    static func parse(_ data: Data) -> ReleaseInfo? {
        guard let release = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              release["draft"] as? Bool != true, release["prerelease"] as? Bool != true,
              let tag = release["tag_name"] as? String else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        guard isVersion(version),
              let asset = (release["assets"] as? [[String: Any]])?.first(where: { $0["name"] as? String == assetName(version) }),
              let link = asset["browser_download_url"] as? String, let url = URL(string: link), fetchable(url),
              let digest = asset["digest"] as? String, digest.hasPrefix("sha256:") else { return nil }
        let hex = digest.dropFirst("sha256:".count).lowercased()
        guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return nil }
        let page = (release["html_url"] as? String).flatMap(URL.init(string:)).flatMap { fetchable($0) ? $0 : nil }
        return ReleaseInfo(version: version, url: url, sha256: hex, page: page)
    }
}

/// Checks for a newer release, downloads it while the user is away, and keeps it staged across launches until the user
/// chooses to install. The app delegate runs the install itself (AppDelegate.installUpdate), since it stops the daemon.
@MainActor @Observable final class AppUpdater {
    enum Phase: Equatable { case unsupported, idle, checking, available, downloading, ready, installing }
    private(set) var phase: Phase
    private(set) var latest: String?
    private(set) var page: URL?
    private(set) var progress = 0.0
    private(set) var checkedAt: Date?
    private(set) var error: String?
    /// While installing: the running jobs the install waits for, 0 while it waits on a daemon that has not answered.
    /// The install can be called off while this is set; it is nil once the daemon is being stopped.
    private(set) var waiting: Int?
    let current: String
    /// Set by the app delegate, which runs the install.
    @ObservationIgnored var onInstall: () -> Void = {}
    @ObservationIgnored private var release: ReleaseInfo?
    @ObservationIgnored private var busy = false
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let feed: URL
    @ObservationIgnored private let session: URLSession

    /// CREW_UPDATE_FEED points the app at another releases endpoint, for testing against a local server.
    init(environment: [String: String] = ProcessInfo.processInfo.environment, bundle: Bundle = .main) {
        current = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        feed = environment["CREW_UPDATE_FEED"].flatMap(URL.init(string:)) ?? Releases.latest
        if let home = environment["CREW_HOME"] {
            directory = URL(fileURLWithPath: home).appending(path: "desktop/updates", directoryHint: .isDirectory)
        } else {
            directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appending(path: "Crew/Updates", directoryHint: .isDirectory)
        }
        // A copy run from the build folder through swift run has no bundle to replace.
        phase = bundle.bundleURL.pathExtension == "app" ? .idle : .unsupported
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 6 * 3600
        configuration.httpAdditionalHeaders = ["User-Agent": "Crew-Desktop"]
        session = URLSession(configuration: configuration)
    }

    private var manifest: URL { directory.appending(path: "staged.json") }
    var failureReport: URL { directory.appending(path: "failed.txt") }
    /// The staged archive, while one is ready or being installed.
    var archive: URL? {
        guard phase == .ready || phase == .installing, let latest else { return nil }
        return directory.appending(path: Releases.assetName(latest))
    }

    private struct Staged: Codable { var version: String; var sha256: String; var page: URL? }

    /// Picks up an archive an earlier launch staged; one no newer than this app, or no longer intact, is removed.
    func load() async {
        guard phase != .unsupported, !busy else { return }
        busy = true
        defer { busy = false }
        if let reason = try? String(contentsOf: failureReport, encoding: .utf8) {
            let message = Self.localizedFailure(reason.trimmingCharacters(in: .whitespacesAndNewlines))
            error = String(localized: "Could not install the update: \(message)")
            try? FileManager.default.removeItem(at: failureReport)
        }
        if let data = try? Data(contentsOf: manifest), let staged = try? JSONDecoder().decode(Staged.self, from: data),
           Releases.isVersion(staged.version), Releases.isNewer(staged.version, than: current) {
            let file = directory.appending(path: Releases.assetName(staged.version))
            let intact = await Task.detached { (try? Self.sha256(of: file)) == staged.sha256 }.value
            if intact {
                latest = staged.version; page = staged.page; phase = .ready
                return
            }
        }
        clean()
    }

    /// Asks GitHub for the latest release. An archive already staged stays ready.
    func check() async {
        guard phase != .unsupported, phase != .installing, !busy else { return }
        busy = true
        defer { busy = false }
        let wasReady = phase == .ready
        if !wasReady { phase = .checking }
        do {
            var request = URLRequest(url: feed)
            request.timeoutInterval = 15
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // A repository with no release yet answers 404: there is simply nothing newer.
            guard status == 404 || (200..<300).contains(status) else { throw CrewFailure(String(localized: "GitHub answered \(status).")) }
            let found = status == 404 ? nil : Releases.parse(data)
            // An install that started while this check ran keeps its archive.
            guard phase != .installing else { return }
            checkedAt = Date()
            error = nil
            if let found, !Releases.isNewer(found.version, than: current) {
                // As new as the latest release: anything staged is out of date.
                release = nil; latest = nil; page = nil; phase = .idle
                clean()
            } else if wasReady && (found == nil || found?.version == latest) {
                // No release, or one without this Mac's archive (it is built and uploaded apart), leaves the staged one ready.
                page = found?.page ?? page
            } else if let found {
                release = found; latest = found.version; page = found.page; phase = .available
            } else {
                release = nil; latest = nil; page = nil; phase = .idle
            }
        } catch {
            // A failed check leaves a staged archive ready, and an install under way alone.
            if !wasReady && phase != .installing { phase = .idle; self.error = String(localized: "Could not check for updates: \(error.localizedDescription)") }
        }
    }

    /// Downloads the release on offer, verifies it, and stages it.
    func download() async {
        guard phase == .available, let release, !busy else { return }
        busy = true
        defer { busy = false }
        phase = .downloading; progress = 0; error = nil
        let file = directory.appending(path: Releases.assetName(release.version))
        let partial = file.appendingPathExtension("partial")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            clean()
            try await Self.fetch(release.url, to: partial, session: session) { [weak self] value in
                Task { @MainActor in
                    // Progress shows in whole percents, not on every chunk.
                    if let self, self.phase == .downloading, value - self.progress >= 0.01 { self.progress = value }
                }
            }
            let actual = try await Task.detached { try Self.sha256(of: partial) }.value
            guard actual == release.sha256 else { throw CrewFailure(String(localized: "the download did not match the release’s SHA-256 digest")) }
            try FileManager.default.moveItem(at: partial, to: file)
            try JSONEncoder().encode(Staged(version: release.version, sha256: release.sha256, page: release.page)).write(to: manifest)
            phase = .ready
        } catch {
            try? FileManager.default.removeItem(at: partial)
            phase = .available
            self.error = String(localized: "Could not download \(release.version): \(error.localizedDescription)")
        }
    }

    /// Asked for by the user, so a release on offer downloads at once.
    func checkNow() async {
        await check()
        await download()
    }

    /// Starts installing the staged update; `waiting` counts the jobs it waits for first. False unless an update is ready.
    func installing(waiting: Int = 0) -> Bool {
        guard phase == .ready else { return false }
        phase = .installing; self.waiting = waiting; error = nil
        return true
    }

    /// Sets how many jobs an install waits for, which it can be called off during. An install called off stays off.
    func waitFor(_ count: Int) {
        if phase == .installing { waiting = count }
    }

    /// The daemon is being asked to stop: from here the install can no longer be called off.
    func stoppingDaemon() {
        if phase == .installing { waiting = nil }
    }

    /// Puts the staged archive back: the user cancelled, or the install could not go ahead (`message`).
    func failed(_ message: String? = nil) {
        guard phase == .installing else { return }
        phase = .ready; waiting = nil; error = message
    }

    /// Invalid archives must be downloaded again, rather than offered for another install.
    func discard(_ message: String) {
        clean()
        phase = .idle; latest = nil; page = nil; release = nil; waiting = nil; error = message
    }

    /// Removes everything staged.
    private func clean() {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [] where name != "failed.txt" {
            try? FileManager.default.removeItem(at: directory.appending(path: name))
        }
    }

    /// Runs the download task, moving its file into place before the system removes it.
    nonisolated private static func fetch(_ url: URL, to destination: URL, session: URLSession, progress: @escaping @Sendable (Double) -> Void) async throws {
        final class Watch: @unchecked Sendable { var observation: NSKeyValueObservation? }
        let watch = Watch()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let task = session.downloadTask(with: url) { file, response, error in
                watch.observation?.invalidate()
                if let error { continuation.resume(throwing: error); return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let file, (200..<300).contains(status) else {
                    continuation.resume(throwing: CrewFailure(String(localized: "the download answered \(status)"))); return
                }
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: file, to: destination)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
            watch.observation = task.progress.observe(\.fractionCompleted) { value, _ in progress(value.fractionCompleted) }
            task.resume()
        }
    }

    nonisolated static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func canReplace(installed: URL) -> String? {
        let parent = installed.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path), FileManager.default.isWritableFile(atPath: installed.path) else {
            return String(localized: "Crew can’t replace itself in \(parent.path). Move Crew to a folder you can write to, such as Applications, and try again.")
        }
        return nil
    }

    struct InvalidArchive: LocalizedError {
        var version: String
        var errorDescription: String? { String(localized: "The downloaded update is not a valid Crew \(version).") }
    }

    /// What an update must satisfy to be this app from the same signer: the running app's own designated requirement,
    /// which names the certificate it was signed with (the release certificate, self-signed or Apple-issued). An ad hoc
    /// or unsigned build's requirement names only its own code hash, which no other build meets, so it has none and
    /// its updates get the integrity check alone.
    nonisolated private static func runningRequirement() throws -> String? {
        var code: SecCode?
        var origin: SecStaticCode?
        var info: CFDictionary?
        var requirement: SecRequirement?
        var text: CFString?
        let failure = CrewFailure(String(localized: "Could not read the running app’s signing identity."))
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { throw failure }
        let validity = SecCodeCheckValidity(code, [], nil)
        if validity == errSecCSUnsigned { return nil }
        guard validity == errSecSuccess,
              SecCodeCopyStaticCode(code, [], &origin) == errSecSuccess, let origin,
              SecCodeCopySigningInformation(origin, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let info else { throw failure }
        let flags = ((info as NSDictionary)[kSecCodeInfoFlags] as? NSNumber)?.uint32Value ?? 0
        if flags & SecCodeSignatureFlags.adhoc.rawValue != 0 { return nil }
        guard SecCodeCopyDesignatedRequirement(origin, [], &requirement) == errSecSuccess, let requirement,
              SecRequirementCopyString(requirement, [], &text) == errSecSuccess, let text else { throw failure }
        return text as String
    }

    nonisolated static func verificationArguments(requirement: String?) -> [String] {
        var arguments = ["--verify", "--deep", "--strict"]
        // codesign reads a requirement given as text from an argument that starts with "=".
        if let requirement { arguments += ["-R", "=\(requirement)"] }
        return arguments
    }

    /// Unpacks the staged archive and checks that it is this app at the release's version, signed intact, then starts a
    /// helper that swaps it in for `installed` once this process exits and opens the new copy. The caller must then quit;
    /// it gets the helper's process and the staged bundle, to undo the hand-over if the quit is cancelled.
    nonisolated static func handOver(archive: URL, version: String, installed: URL, processID: Int32, result: URL) throws -> (helper: Int32, staged: URL, work: URL) {
        if let reason = canReplace(installed: installed) { throw CrewFailure(reason) }
        let parent = installed.deletingLastPathComponent()
        let work = FileManager.default.temporaryDirectory.appending(path: "Crew-update-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false)
        var handedOff = false
        defer { if !handedOff { try? FileManager.default.removeItem(at: work) } }
        let unpacked = work.appending(path: "unpacked", directoryHint: .isDirectory)
        let app = unpacked.appending(path: "Crew.app", directoryHint: .isDirectory)
        guard run("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path]), isExpectedBundle(app, version: version) else {
            throw InvalidArchive(version: version)
        }
        let verification = verificationArguments(requirement: try runningRequirement())
        guard run("/usr/bin/codesign", verification + [app.path]) else {
            throw InvalidArchive(version: version)
        }
        // Staged beside the installed copy so the final move is a same-volume rename; named apart from an earlier
        // attempt's, whose helper may still be waiting to clean up.
        let staged = parent.appending(path: ".Crew-update-\(version)-\(UUID().uuidString).app", directoryHint: .isDirectory)
        try FileManager.default.moveItem(at: app, to: staged)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Paths travel as arguments, never interpolated into the script.
        process.arguments = ["-c", swapScript, "crew-swap", String(processID), installed.path, staged.path, work.path, result.path] + verification
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            handedOff = true
            return (process.processIdentifier, staged, work)
        } catch {
            try? FileManager.default.removeItem(at: staged)
            throw CrewFailure(String(localized: "Could not start the update: \(error.localizedDescription)"))
        }
    }

    nonisolated private static func isExpectedBundle(_ app: URL, version: String) -> Bool {
        guard let info = NSDictionary(contentsOf: app.appending(path: "Contents/Info.plist")) as? [String: Any],
              info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier ?? "dev.crew.native",
              info["CFBundleShortVersionString"] as? String == version else { return false }
        return FileManager.default.isExecutableFile(atPath: app.appending(path: "Contents/MacOS/Crew").path)
    }

    nonisolated private static func run(_ tool: String, _ arguments: [String]) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return false }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    /// The app's PID, installed and staged bundles, work folder, failure report, then the original codesign arguments.
    /// The old copy is kept until the new one opens, and put back if the move or launch fails. If the app has not quit within
    /// a minute (its quit was cancelled), nothing is swapped: a running copy is never moved out from under itself.
    // The helper reports its failure in English so a later launch can render it in the current app language.
    nonisolated private static func localizedFailure(_ reason: String) -> String {
        let reopenMessage = "The previous Crew app could not reopen."
        let suffix = " " + reopenMessage
        let failedToReopen = reason.hasSuffix(suffix)
        let message = failedToReopen ? String(reason.dropLast(suffix.count)) : reason
        let restorePrefix = "Could not restore Crew; the previous app is at "
        let movePrefix = "Could not move the failed update aside; the previous Crew app is at "
        let localized: String
        if message.hasPrefix(restorePrefix), message.hasSuffix(".") {
            let path = String(message.dropFirst(restorePrefix.count).dropLast())
            localized = String(localized: "Could not restore Crew; the previous app is at \(path).")
        } else if message.hasPrefix(movePrefix), message.hasSuffix(".") {
            let path = String(message.dropFirst(movePrefix.count).dropLast())
            localized = String(localized: "Could not move the failed update aside; the previous Crew app is at \(path).")
        } else {
            localized = localizedCrewLabel(message)
        }
        return failedToReopen ? localized + " " + localizedCrewLabel(reopenMessage) : localized
    }

    nonisolated static let swapScript = """
    #!/bin/sh
    pid="$1"; target="$2"; staged="$3"; work="$4"; result="$5"
    shift 5
    fail() {
        printf '%s\\n' "$1" > "$result"
        rm -rf "$staged" "$work"
        if [ "${2:-}" != no ] && ! open "$target"; then
            printf '%s\\n' "$1 The previous Crew app could not reopen." > "$result"
        fi
        exit 1
    }
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
        fail "Crew did not quit within 60 seconds." no
    fi
    if ! /usr/bin/codesign "$@" "$staged"; then
        fail "Could not verify the staged Crew app."
    fi
    # A folder of this run's own: nothing already there is touched, and one left by a failed run cannot stop the next.
    if ! backup=$(/usr/bin/mktemp -d "$target.previous.XXXXXX"); then
        fail "Could not make a folder beside Crew for the update backup."
    fi
    previous="$backup/${target##*/}"
    if ! mv "$target" "$previous"; then
        rmdir "$backup"
        fail "Could not back up the installed Crew app."
    fi
    if ! mv "$staged" "$target"; then
        mv "$previous" "$target" || fail "Could not restore Crew; the previous app is at $previous." no
        rmdir "$backup"
        fail "Could not move the updated Crew app into place."
    fi
    if ! open "$target" --args --updated; then
        mv "$target" "$staged" || fail "Could not move the failed update aside; the previous Crew app is at $previous." no
        mv "$previous" "$target" || fail "Could not restore Crew; the previous app is at $previous." no
        rmdir "$backup"
        fail "The updated Crew app could not open."
    fi
    rm -rf "$previous" "$work"
    rmdir "$backup"
    """
}

/// What the About page and the sidebar say about the update.
extension AppUpdater {
    var summary: String {
        let percent = "\(Int((progress * 100).rounded()))%"
        return switch phase {
        case .unsupported: String(localized: "Updates come with the Crew app bundle")
        case .idle:
            if checkedAt != nil, error == nil { String(localized: "Crew is up to date") }
            else if let checkedAt { String(localized: "Last checked at \(checkedAt.formatted(date: .omitted, time: .shortened))") }
            else { String(localized: "Not checked yet") }
        case .checking: String(localized: "Checking for updates…")
        case .available: String(localized: "Version \(latest ?? "") is available")
        case .downloading: String(localized: "Downloading version \(latest ?? "")… \(percent)")
        case .ready: String(localized: "Version \(latest ?? "") is ready to install")
        case .installing:
            if let waiting, waiting > 0 {
                waiting == 1 ? String(localized: "Version \(latest ?? "") will install when 1 running job finishes") : String(localized: "Version \(latest ?? "") will install when \(waiting) running jobs finish")
            } else if waiting == 0 {
                String(localized: "Version \(latest ?? "") will install once the Crew daemon answers")
            } else {
                String(localized: "Restarting to install version \(latest ?? "")…")
            }
        }
    }
}
