import SwiftUI

struct WorkspaceHeading: View {
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text(title).font(Typeface.pageTitle).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            if let subtitle {
                // Selectable text on macOS drops truncation once selected and never restores it,
                // so the path is copied from a menu instead and always shows its truncated form.
                Text(subtitle).font(Typeface.code).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    .help(subtitle)
                    .contextMenu {
                        Button("Copy Path", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(subtitle, forType: .string)
                        }
                    }
            }
        }.padding(.leading, WorkspaceStyle.titleInset).frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct WorkspaceSummary: View {
    /// The narrowest card that keeps every label on one line in four equal columns, with room for a label's symbol and gap.
    static let minimumWidth: CGFloat = {
        let font = NSFont.systemFont(ofSize: Typeface.chipSize, weight: .medium)
        let widest = [String(localized: "In progress"), String(localized: "Needs you"), String(localized: "Finished"), String(localized: "Failed")].map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return ceil(4 * (widest + Typeface.chipSize * 2) + 3 * Space.xl + 2 * WorkspaceStyle.cardPadding)
    }()
    var store: CrewStore
    private var jobs: [Job] { store.state.jobs.filter { store.project.isEmpty || $0.projectPath == store.project } }
    private var metrics: [(String, Int, String, Color)] {
        // Lead sessions count like jobs, as they already do under Needs you.
        [(String(localized: "In progress"), jobs.filter { $0.state == "running" }.count + store.state.claude.filter { $0.state == "working" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "circle.dotted.circle", Palette.accent),
         (String(localized: "Needs you"), jobs.filter { $0.state == "waiting" }.count + store.state.claude.filter { $0.state == "waiting" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "bell.badge", Palette.warning),
         // Settled jobs stay in the list but leave the totals, which would otherwise only grow.
         (String(localized: "Finished"), jobs.filter { $0.state == "done" && $0.isUnsettled }.count, "checkmark.circle", .secondary),
         (String(localized: "Failed"), jobs.filter { $0.state == "failed" && $0.isUnsettled }.count, "exclamationmark.circle", Palette.danger)]
    }
    var body: some View {
        let metrics = self.metrics
        VStack(spacing: Space.xxl) {
            HStack(alignment: .top, spacing: Space.xl) {
                ForEach(metrics.indices, id: \.self) { index in
                    let metric = metrics[index]
                    // A count above zero colors its label too; an empty one fades back.
                    VStack(alignment: .leading, spacing: Space.m) {
                        Label(metric.0, systemImage: metric.2).font(Typeface.chip).lineLimit(1)
                            .foregroundStyle(metric.1 == 0 ? AnyShapeStyle(.tertiary) : AnyShapeStyle(metric.3))
                        Text(metric.1.formatted()).font(Typeface.number).monospacedDigit()
                            .foregroundStyle(metric.1 == 0 ? Color.secondary.opacity(0.4) : metric.3)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                }
            }
            GeometryReader { geometry in
                let total = max(1, metrics.reduce(0) { $0 + $1.1 })
                let gaps = CGFloat(max(0, metrics.filter { $0.1 > 0 }.count - 1)) * Space.xs
                HStack(spacing: Space.xs) {
                    ForEach(metrics.indices, id: \.self) { index in
                        if metrics[index].1 > 0 {
                            Capsule().fill(metrics[index].3.opacity(index == 0 ? 1 : 0.65))
                                .frame(width: max(0, (geometry.size.width - gaps) * Double(metrics[index].1) / Double(total)))
                        }
                    }
                }
            }
            // Made of its colored parts alone; only an empty summary shows the bare track.
            .frame(height: WorkspaceStyle.summaryBarHeight).background(metrics.allSatisfy { $0.1 == 0 } ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.clear), in: Capsule())
            .accessibilityHidden(true)
        }.card()
    }
}

struct MissionTrack: View {
    static let marker: CGFloat = 24
    /// Thick enough to read as a track rather than a hairline.
    static let line: CGFloat = 2
    /// Steps not reached yet: their outline and the track leading to them share one weight and color.
    /// Stronger in dark mode, where 0.12 measured about 1.4:1 against the card.
    static let upcoming = WorkspaceStyle.dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.12), dark: NSColor(calibratedWhite: 1, alpha: 0.22))
    /// The least room from the edge to the first and last markers' centers.
    static let inset = Space.x3l
    /// A step name's width in `Typeface.captionStrong`, the wider of the two fonts it takes.
    private static func labelWidth(_ title: String) -> CGFloat {
        ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: Typeface.captionSize, weight: .semibold)]).width)
    }
    /// One line of a step name in `Typeface.captionStrong`.
    private static let labelHeight: CGFloat = {
        let font = NSFont.systemFont(ofSize: Typeface.captionSize, weight: .semibold)
        return ceil(font.ascender - font.descender + font.leading)
    }()
    let mission: Mission
    /// Passed steps: strongest while the mission runs, quieter once it is done, and quieter still once abandoned.
    private var passedColor: Color {
        switch mission.state {
        case "active": .primary
        case "abandoned": Color.secondary.opacity(0.55)
        default: .secondary
        }
    }
    var body: some View {
        let count = mission.stops.count
        // Markers spread evenly between the insets; each name sits centered under its marker.
        GeometryReader { geometry in
            let width = geometry.size.width
            // Wide enough for the longer end name centered under its marker, so it stays inside the card. At most half
            // an equal column, where an end name has as much room as any other and truncates like them.
            let ends = [mission.stops.first, mission.stops.last].compactMap { $0 }.map(Self.labelWidth).max() ?? 0
            let inset = count > 1 ? min(max(Self.inset, ceil(ends / 2)), width / CGFloat(count * 2)) : width / 2
            // Never negative, however narrow the card or long the plan.
            let span = count > 1 ? max(0, (width - inset * 2) / CGFloat(count - 1)) : 0
            let center = { (index: Int) in inset + span * CGFloat(index) }
            ZStack(alignment: .topLeading) {
                ForEach(0..<max(0, count - 1), id: \.self) { index in
                    Rectangle().fill(mission.passed(index) ? passedColor.opacity(0.6) : Self.upcoming)
                        .frame(width: span, height: Self.line)
                        .position(x: center(index) + span / 2, y: Self.marker / 2)
                }
                ForEach(Array(mission.stops.enumerated()), id: \.offset) { index, title in
                    // The step in progress, or the one an ended mission stopped on unpassed. A mission marked done
                    // can keep its step on an earlier stop, and that stop is passed like the rest.
                    let emphasized = index == mission.step && (mission.state == "active" || !mission.passed(index))
                    marker(index).position(x: center(index), y: Self.marker / 2)
                    Text(title).font(emphasized ? Typeface.captionStrong : Typeface.caption)
                        .foregroundStyle(index == mission.step && mission.state == "active" ? .primary : .secondary)
                        .lineLimit(1)
                        .frame(maxWidth: max(0, min(count > 1 ? span - Space.m : width, index == 0 || index == count - 1 ? inset * 2 : width)))
                        // A name the lead gave can be longer than its column.
                        .help(title)
                        .position(x: center(index), y: Self.marker + Space.m + Self.labelHeight / 2)
                }
            }
        }
        .frame(height: Self.marker + Space.m + Self.labelHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mission.state == "done" ? String(localized: "Done, all \(mission.stops.count) steps passed") : String(localized: "Step \(mission.step + 1) of \(mission.stops.count), \(mission.stops[mission.step])"))
    }
    private func marker(_ index: Int) -> some View {
        let current = index == mission.step
        // The step a mission ended on without passing it is filled like the passed ones, not left blank.
        let stopped = current && mission.state != "active" && !mission.passed(index)
        // An abandoned mission outlines its passed and stopped steps instead of filling its stopped one: its lighter
        // color would leave the surface-colored number on it nearly unreadable.
        let outlined = mission.state == "abandoned"
        let glyph = outlined ? passedColor : WorkspaceStyle.surface
        return ZStack {
            // The step in progress is accent-tinted glass, the passed ones clear glass: one material along the track.
            if current && mission.state == "active" { Color.clear.glassEffect(.regular.tint(Palette.accent), in: .circle) }
            Circle().fill(stopped && !outlined ? passedColor : .clear)
            if mission.passed(index) {
                // A passed step is a glass bead with the check in the passed color, rather than a solid disc that
                // glares in dark mode and outweighs the step in progress.
                if outlined { Circle().strokeBorder(passedColor, lineWidth: Self.line) } else { Color.clear.glassEffect(.regular.tint(passedColor.opacity(0.12)), in: .circle) }
                Image(systemName: "checkmark").font(Symbol.badge).foregroundStyle(passedColor)
            } else {
                Circle().strokeBorder(stopped && outlined ? passedColor : current ? .clear : Self.upcoming, lineWidth: Self.line)
                Text(String(index + 1)).font(Typeface.chip)
                    .foregroundStyle(current && mission.state == "active" ? Color.white : stopped ? glyph : .secondary)
            }
        }
        .frame(width: Self.marker, height: Self.marker)
        // The track runs under the markers; an outlined one hides it behind the card's own color.
        .background(WorkspaceStyle.surface, in: Circle())
    }
}

/// The shared card surface: one padding and radius for every card, outlined only under Increase Contrast.
struct CardSurface: ViewModifier {
    var padding = WorkspaceStyle.cardPadding
    var fill = WorkspaceStyle.surface
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius)
        content.padding(padding)
            .background(fill, in: shape)
            .overlay { if contrast == .increased { shape.strokeBorder(Palette.contrastStroke) } }
    }
}
extension View {
    func card(padding: CGFloat = WorkspaceStyle.cardPadding, fill: Color = WorkspaceStyle.surface) -> some View {
        modifier(CardSurface(padding: padding, fill: fill))
    }
}
