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
        guard descriptor >= 0 else { throw CrewFailure("Could not open the Crew instance lock.") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(descriptor); descriptor = -1
            if code == EWOULDBLOCK { return false }
            throw CrewFailure("Could not lock the Crew instance file.")
        }
        return true
    }
    deinit { if descriptor >= 0 { close(descriptor) } }
}
