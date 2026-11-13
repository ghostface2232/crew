import SwiftUI

enum WorkspaceStyle {
    static let signal = Color(red: 0.70, green: 0.91, blue: 0.29)
    static let canvas = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedRed: 0.105, green: 0.105, blue: 0.11, alpha: 1)
            : NSColor(calibratedRed: 0.955, green: 0.955, blue: 0.965, alpha: 1)
    })
    static let inverse = Color(nsColor: .windowBackgroundColor)
    static let surface = Color(nsColor: .controlBackgroundColor)
    static let title = Font.system(size: 38, weight: .semibold, design: .rounded)
    static let section = Font.system(size: 20, weight: .semibold, design: .rounded)
    static let number = Font.system(size: 40, weight: .regular, design: .rounded)
}

struct WorkspaceHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(WorkspaceStyle.title).tracking(-1.1).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WorkspaceSummary: View {
    var store: CrewStore
    private var jobs: [Job] { store.state.jobs.filter { store.project.isEmpty || $0.projectPath == store.project } }
    private var metrics: [(String, Int, String, Color)] {
        [("In progress", jobs.filter { $0.state == "running" }.count, "circle.dotted.circle", .primary),
         ("Needs you", jobs.filter { $0.state == "waiting" }.count + store.state.claude.filter { $0.state == "waiting" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "hand.raised", .orange),
         ("Finished", jobs.filter { $0.state == "done" }.count, "checkmark.circle", .secondary),
         ("Failed", jobs.filter { $0.state == "failed" }.count, "exclamationmark.circle", .red)]
    }
    var body: some View {
        VStack(spacing: 20) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(metrics.indices, id: \.self) { index in
                    let metric = metrics[index]
                    VStack(alignment: .leading, spacing: 7) {
                        Label(metric.0, systemImage: metric.2).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                        Text(metric.1.formatted()).font(WorkspaceStyle.number).tracking(-1.2).monospacedDigit()
                            .foregroundStyle(metric.1 == 0 ? Color.secondary.opacity(0.7) : metric.3)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                }
            }
            GeometryReader { geometry in
                let total = max(1, metrics.reduce(0) { $0 + $1.1 })
                let gaps = CGFloat(max(0, metrics.filter { $0.1 > 0 }.count - 1)) * 3
                HStack(spacing: 3) {
                    ForEach(metrics.indices, id: \.self) { index in
                        if metrics[index].1 > 0 {
                            Capsule().fill(index == 0 ? WorkspaceStyle.signal : metrics[index].3.opacity(0.65))
                                .frame(width: max(0, (geometry.size.width - gaps) * Double(metrics[index].1) / Double(total)))
                        }
                    }
                }
            }.frame(height: 5).background(.quaternary, in: Capsule()).accessibilityHidden(true)
        }.padding(22).background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct MissionTrack: View {
    let mission: Mission
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(Mission.steps.enumerated()), id: \.offset) { index, title in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 0) {
                        ZStack {
                            Circle().fill(index == mission.step && mission.state == "active" ? WorkspaceStyle.signal : .clear)
                            if index < mission.step || mission.state == "done" {
                                Circle().fill(.primary)
                                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WorkspaceStyle.surface)
                            } else {
                                Circle().strokeBorder(.primary.opacity(index == mission.step ? 0 : 0.15))
                                Text(String(index + 1)).font(.system(size: 10, weight: .medium)).foregroundStyle(index == mission.step && mission.state == "active" ? Color.black : .secondary)
                            }
                        }.frame(width: 24, height: 24)
                        Rectangle().fill(index < mission.step ? Color.primary.opacity(0.6) : .primary.opacity(0.1)).frame(height: 1)
                            .opacity(index == 5 ? 0 : 1)
                    }
                    Text(title).font(.system(size: 11, weight: index == mission.step ? .semibold : .regular))
                        .foregroundStyle(index == mission.step ? .primary : .secondary).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(mission.step + 1) of 6, \(Mission.steps[mission.step])")
    }
}

struct StageRing: View {
    let mission: Mission
    var body: some View {
        ZStack {
            ForEach(0..<6, id: \.self) { index in
                Circle().trim(from: Double(index) / 6 + 0.015, to: Double(index + 1) / 6 - 0.015)
                    .stroke(index < mission.step || mission.state == "done" ? Color.primary : index == mission.step ? WorkspaceStyle.signal : .primary.opacity(0.10), style: StrokeStyle(lineWidth: 5, lineCap: .round))
            }.rotationEffect(.degrees(-90))
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text(mission.state == "done" ? "6" : String(mission.step + 1)).font(.system(size: 28, weight: .medium, design: .rounded)).tracking(-1)
                Text("/6").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }.frame(width: 66, height: 66).accessibilityHidden(true)
    }
}
