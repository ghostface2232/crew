import Foundation

struct DesktopLease: Codable, Sendable {
    var completionNotifications: Bool?
    var from: Double?
    var until: Double?
}

struct CompletionTracker {
    private var previous: [String: (state: String, turn: Int)] = [:]
    mutating func finished(in jobs: [Job]) -> [Job] {
        let finished = jobs.filter { job in
            guard job.state == "done", let old = previous[job.id] else { return false }
            return old.state != "done" || old.turn < job.turns
        }
        previous = Dictionary(jobs.map { ($0.id, (state: $0.state, turn: $0.turns)) }, uniquingKeysWith: { _, new in new })
        return finished
    }
}

struct CompletionLeases {
    private struct Transition: Equatable {
        var from: Double
        var until: Double
        var granted: Bool
    }
    private var transitions: [Transition] = []
    private var windows: [Range<Double>] = []
    mutating func accept(_ lease: DesktopLease) {
        guard let from = lease.from, let until = lease.until, from.isFinite, until.isFinite,
              until > from else { return }
        let transition = Transition(from: from, until: until, granted: lease.completionNotifications == true)
        guard !transitions.contains(transition) else { return }
        transitions.append(transition)
        transitions.sort {
            if $0.from != $1.from { return $0.from < $1.from }
            // A revocation wins when the daemon's millisecond timestamps coincide.
            if $0.granted != $1.granted { return $0.granted }
            return $0.until < $1.until
        }
        // Preserve grant boundaries until delayed revocations arrive, with bounded history.
        transitions = Array(transitions.suffix(512))
        windows = []
        for (index, change) in transitions.enumerated() where change.granted {
            let next = index + 1 < transitions.count ? transitions[index + 1].from : change.until
            let end = min(change.until, next)
            guard change.from < end else { continue }
            if let last = windows.last, last.upperBound == change.from {
                windows[windows.count - 1] = last.lowerBound..<end
            } else {
                windows.append(change.from..<end)
            }
        }
    }
    mutating func record(from: Double, until: Double) {
        accept(DesktopLease(completionNotifications: true, from: from, until: until))
    }
    func owns(_ timestamp: Double) -> Bool {
        windows.contains { $0.contains(timestamp) }
    }
}
