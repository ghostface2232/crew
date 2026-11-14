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
    var store: CrewStore
    private var jobs: [Job] { store.state.jobs.filter { store.project.isEmpty || $0.projectPath == store.project } }
    private var metrics: [(String, Int, String, Color)] {
        // Lead sessions count like jobs, as they already do under Needs you.
        [("In progress", jobs.filter { $0.state == "running" }.count + store.state.claude.filter { $0.state == "working" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "circle.dotted.circle", Palette.accent),
         ("Needs you", jobs.filter { $0.state == "waiting" }.count + store.state.claude.filter { $0.state == "waiting" && (store.project.isEmpty || $0.projectPath == store.project) }.count, "bell.badge", Palette.warning),
         // Settled jobs stay in the list but leave the totals, which would otherwise only grow.
         ("Finished", jobs.filter { $0.state == "done" && $0.isUnsettled }.count, "checkmark.circle", .secondary),
         ("Failed", jobs.filter { $0.state == "failed" && $0.isUnsettled }.count, "exclamationmark.circle", Palette.danger)]
    }
    var body: some View {
        let metrics = self.metrics
        VStack(spacing: Space.xxl) {
            HStack(alignment: .top, spacing: Space.xl) {
                ForEach(metrics.indices, id: \.self) { index in
                    let metric = metrics[index]
                    // A count above zero colors its label too; an empty one fades back.
                    VStack(alignment: .leading, spacing: Space.m) {
                        Label(metric.0, systemImage: metric.2).font(Typeface.chip)
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
    static let upcoming = Color.primary.opacity(0.12)
    /// From the edge to the first and last markers' centers, so a name centered under an end marker has room.
    static let inset = Space.x3l
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
            // Never negative, however narrow the card or long the plan.
            let span = count > 1 ? max(0, (geometry.size.width - Self.inset * 2) / CGFloat(count - 1)) : 0
            let center = { (index: Int) in count > 1 ? Self.inset + span * CGFloat(index) : geometry.size.width / 2 }
            ZStack(alignment: .topLeading) {
                ForEach(0..<max(0, count - 1), id: \.self) { index in
                    Rectangle().fill(mission.passed(index) ? passedColor.opacity(0.6) : Self.upcoming)
                        .frame(width: span, height: Self.line)
                        .position(x: center(index) + span / 2, y: Self.marker / 2)
                }
                ForEach(Array(mission.stops.enumerated()), id: \.offset) { index, title in
                    marker(index).position(x: center(index), y: Self.marker / 2)
                    Text(title).font(index == mission.step ? Typeface.captionStrong : Typeface.caption)
                        .foregroundStyle(index == mission.step && mission.state == "active" ? .primary : .secondary)
                        .lineLimit(1).frame(maxWidth: count > 1 ? max(0, span - Space.xs) : nil)
                        .position(x: center(index), y: Self.marker + Space.m + Self.labelHeight / 2)
                }
            }
        }
        .frame(height: Self.marker + Space.m + Self.labelHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mission.state == "done" ? "Done, all \(mission.stops.count) steps passed" : "Step \(mission.step + 1) of \(mission.stops.count), \(mission.stops[mission.step])")
    }
    private func marker(_ index: Int) -> some View {
        let current = index == mission.step
        // The step a mission ended on without passing it is filled like the passed ones, not left blank.
        let stopped = current && mission.state != "active" && !mission.passed(index)
        // An abandoned mission outlines its passed and stopped steps instead of filling them: its lighter color would
        // leave a white glyph on it nearly unreadable.
        let outlined = mission.state == "abandoned"
        let glyph = outlined ? passedColor : WorkspaceStyle.surface
        return ZStack {
            Circle().fill(current && mission.state == "active" ? Palette.accent : stopped && !outlined ? passedColor : .clear)
            if mission.passed(index) {
                if outlined { Circle().strokeBorder(passedColor, lineWidth: Self.line) } else { Circle().fill(passedColor) }
                Image(systemName: "checkmark").font(Symbol.badge).foregroundStyle(glyph)
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

/// The shared card surface: one padding, radius and outline for every card.
struct CardSurface: ViewModifier {
    var padding = WorkspaceStyle.cardPadding
    var fill = WorkspaceStyle.surface
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius)
        content.padding(padding)
            .background(fill, in: shape)
            .overlay(shape.strokeBorder(contrast == .increased ? Palette.contrastStroke : WorkspaceStyle.hairline))
    }
}
extension View {
    func card(padding: CGFloat = WorkspaceStyle.cardPadding, fill: Color = WorkspaceStyle.surface) -> some View {
        modifier(CardSurface(padding: padding, fill: fill))
    }
}
