import Foundation
import CryptoKit
import Darwin

final class InstanceLock {
    private var descriptor: Int32 = -1
    let notificationName: Notification.Name
    static func profileID(home: URL) -> String {
        SHA256.hash(data: Data(home.standardizedFileURL.path.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    init(home: URL) {
        let digest = Self.profileID(home: home)
        notificationName = Notification.Name("dev.crew.native.reopen.\(digest)")
    }
    func acquire(home: URL) throws -> Bool {
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        descriptor = open(home.appendingPathComponent("native.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw CrewFailure(String(localized: "Could not open the Crew instance lock.")) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor); descriptor = -1
            if code == EWOULDBLOCK { return false }
            throw CrewFailure(String(localized: "Could not lock the Crew instance file."))
        }
        return true
    }
    deinit { if descriptor >= 0 { close(descriptor) } }
}

struct BundleLaunchLock {
    private struct Claim: Codable, Equatable {
        let work: URL
        let profile: String

        init(work: URL, home: URL) {
            self.work = work.resolvingSymlinksInPath().standardizedFileURL
            profile = InstanceLock.profileID(home: home)
        }
    }

    private let gate: URL
    private let usage: URL

    init(installed: URL, directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appending(path: "Crew/UpdateLaunch", directoryHint: .isDirectory)) throws {
        let bundle = installed.resolvingSymlinksInPath().standardizedFileURL.path
        let id = SHA256.hash(data: Data(bundle.utf8)).map { String(format: "%02x", $0) }.joined()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        gate = directory.appending(path: id + ".gate")
        usage = directory.appending(path: id + ".usage")
    }

    // Hold the shared gate through admission. An updater that gets it next must see this process's usage lock.
    func admit(home: URL, work: URL?) throws -> FileHandle? {
        let access = try openLock(gate)
        defer { try? access.close() }
        if try lock(access, LOCK_SH) {
            guard work == nil else { return nil }
        } else {
            guard let work, let data = try access.readToEnd(),
                  let claim = try? JSONDecoder().decode(Claim.self, from: data),
                  claim == Claim(work: work, home: home) else { return nil }
        }
        let running = try openLock(usage)
        do {
            if try lock(running, LOCK_SH) { return running }
        } catch {
            try? running.close()
            throw error
        }
        try running.close()
        return nil
    }

    func prepareHandover(home: URL, work: URL, running: FileHandle) throws -> FileHandle {
        let access = try openLock(gate)
        var handedOff = false
        defer { if !handedOff { try? access.close() } }
        guard try lock(access, LOCK_EX) else { throw lockError }
        // With admission closed, temporarily promote the old app's lease to check for another running copy.
        let alone = try lock(running, LOCK_EX)
        guard flock(running.fileDescriptor, LOCK_SH) == 0, alone else { throw lockError }
        try access.truncate(atOffset: 0)
        try access.write(contentsOf: JSONEncoder().encode(Claim(work: work, home: home)))
        handedOff = true
        return access
    }

    private var lockError: CrewFailure { CrewFailure(String(localized: "Could not lock the Crew instance file.")) }

    private func openLock(_ url: URL) throws -> FileHandle {
        let fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw CrewFailure(String(localized: "Could not open the Crew instance lock.")) }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    private func lock(_ file: FileHandle, _ mode: Int32) throws -> Bool {
        if flock(file.fileDescriptor, mode | LOCK_NB) == 0 { return true }
        if errno == EWOULDBLOCK { return false }
        throw lockError
    }
}
