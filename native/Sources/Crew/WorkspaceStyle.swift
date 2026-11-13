import SwiftUI

enum WorkspaceStyle {
    // Dark mode keeps cards about 9% lighter than the canvas so they stay distinct without heavy borders.
    static let canvas = dynamic(light: NSColor(calibratedRed: 0.955, green: 0.955, blue: 0.965, alpha: 1),
                                dark: NSColor(calibratedRed: 0.07, green: 0.07, blue: 0.075, alpha: 1))
    static let inverse = Color(nsColor: .windowBackgroundColor)
    static let surface = dynamic(light: .white, dark: NSColor(calibratedWhite: 0.16, alpha: 1))
    static let rowFill = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.04), dark: NSColor(calibratedWhite: 1, alpha: 0.06))
    static let hairline = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.08), dark: NSColor(calibratedWhite: 1, alpha: 0.08))
    private static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }
    static let cardPadding: CGFloat = 20
    static let cardRadius: CGFloat = 20
    static let rowRadius: CGFloat = 12
    static let fieldRadius: CGFloat = 14
    static let panelRadius: CGFloat = 24
}

/// The type scale. Titles are SF Pro Rounded, headlines SF Pro Display, body text SF Pro Text, source text SF Mono.
enum Typeface {
    static let pageTitle = Font.system(size: 38, weight: .semibold, design: .rounded)
    static let title = Font.system(size: 18, weight: .semibold, design: .rounded)
    static let cardTitle = Font.system(size: 16, weight: .semibold, design: .rounded)
    static let number = Font.system(size: 40, weight: .regular, design: .rounded)
    static let section = display(20, .semibold)
    static let headline = display(15, .medium)
    static let subheadline = Font.system(size: 13, weight: .semibold)
    static let bodyStrong = Font.system(size: 13, weight: .medium)
    static let body = Font.system(size: 13)
    static let calloutStrong = Font.system(size: 12, weight: .medium)
    static let callout = Font.system(size: 12)
    static let captionStrong = Font.system(size: 11, weight: .semibold)
    static let chip = Font.system(size: 11, weight: .medium)
    static let caption = Font.system(size: 11)
    static let micro = Font.system(size: 10, weight: .semibold)
    static let code = Font.system(size: 12, design: .monospaced)
    static let codeSmall = Font.system(size: 11, design: .monospaced)

    /// The system picks the Text cut below 20 pt; headlines keep the Display cut at any size.
    private static func display(_ size: CGFloat, _ weight: NSFont.Weight) -> Font {
        let base = NSFont.systemFont(ofSize: size, weight: weight)
        var variation = base.fontDescriptor.object(forKey: .variation) as? [NSNumber: Any] ?? [:]
        // Without an explicit optical size the font uses its default, the Display cut.
        variation[NSNumber(value: 0x6F70737A)] = nil // 'opsz'
        return Font(NSFont(descriptor: base.fontDescriptor.addingAttributes([.variation: variation]), size: size) ?? base)
    }
}

struct WorkspaceHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(Typeface.pageTitle).tracking(-1.1).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle).font(Typeface.code).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WorkspaceSummary: View {
    var store: CrewStore
    private var jobs: [Job] { store.state.jobs.filter { store.project.isEmpty || $0.projectPath == store.project } }
    private var metrics: [(String, Int, String, Color)] {
        [("In progress", jobs.filter { $0.state == "running" }.count, "circle.dotted.circle", .accentColor),
         ("Needs you", jobs.filter { $0.state == "waiting" }.count + store.state.claude.filter { $0.state == "waiting" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "bell.badge", .orange),
         ("Finished", jobs.filter { $0.state == "done" }.count, "checkmark.circle", .secondary),
         ("Failed", jobs.filter { $0.state == "failed" }.count, "exclamationmark.circle", .red)]
    }
    var body: some View {
        let metrics = self.metrics
        VStack(spacing: 20) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(metrics.indices, id: \.self) { index in
                    let metric = metrics[index]
                    VStack(alignment: .leading, spacing: 7) {
                        Label(metric.0, systemImage: metric.2).font(Typeface.chip).foregroundStyle(.secondary)
                        Text(metric.1.formatted()).font(Typeface.number).tracking(-1.2).monospacedDigit()
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
                            Capsule().fill(metrics[index].3.opacity(index == 0 ? 1 : 0.65))
                                .frame(width: max(0, (geometry.size.width - gaps) * Double(metrics[index].1) / Double(total)))
                        }
                    }
                }
            }.frame(height: 5).background(.quaternary, in: Capsule()).accessibilityHidden(true)
        }.card()
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
                            Circle().fill(index == mission.step && mission.state == "active" ? Color.accentColor : .clear)
                            if index < mission.step || mission.state == "done" {
                                Circle().fill(.primary)
                                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(WorkspaceStyle.surface)
                            } else {
                                Circle().strokeBorder(.primary.opacity(index == mission.step ? 0 : 0.15))
                                Text(String(index + 1)).font(Typeface.chip).foregroundStyle(index == mission.step && mission.state == "active" ? Color.white : .secondary)
                            }
                        }.frame(width: 24, height: 24)
                        if index < Mission.steps.count - 1 {
                            Rectangle().fill(index < mission.step ? Color.primary.opacity(0.6) : .primary.opacity(0.1)).frame(height: 1)
                        }
                    }
                    Text(title).font(index == mission.step ? Typeface.captionStrong : Typeface.caption)
                        .foregroundStyle(index == mission.step ? .primary : .secondary).lineLimit(1)
                }
                // The last step takes only its own width so the track ends at the card's edge.
                .frame(maxWidth: index < Mission.steps.count - 1 ? .infinity : nil, alignment: .leading)
            }
        }.accessibilityElement(children: .ignore)
            .accessibilityLabel("Step \(mission.step + 1) of 6, \(Mission.steps[mission.step])")
    }
}

/// The shared card surface: one padding, radius and outline for every card.
struct CardSurface: ViewModifier {
    var padding = WorkspaceStyle.cardPadding
    var fill = WorkspaceStyle.surface
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius)
        content.padding(padding)
            .background(fill, in: shape)
            .overlay(shape.strokeBorder(contrast == .increased ? Color.primary.opacity(0.25) : WorkspaceStyle.hairline))
    }
}
extension View {
    func card(padding: CGFloat = WorkspaceStyle.cardPadding, fill: Color = WorkspaceStyle.surface) -> some View {
        modifier(CardSurface(padding: padding, fill: fill))
    }
}
