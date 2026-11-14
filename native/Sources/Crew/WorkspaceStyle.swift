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
                let gaps = CGFloat(max(0, metrics.filter { $0.1 > 0 }.count - 1)) * 3
                HStack(spacing: Space.xs) {
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
    private var passedColor: Color { mission.state == "active" ? .primary : .secondary }
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(mission.stops.enumerated()), id: \.offset) { index, title in
                VStack(alignment: .leading, spacing: Space.m) {
                    HStack(spacing: 0) {
                        ZStack {
                            Circle().fill(index == mission.step && mission.state == "active" ? Palette.accent : .clear)
                            if mission.passed(index) {
                                Circle().fill(passedColor)
                                Image(systemName: "checkmark").font(Symbol.badge).foregroundStyle(WorkspaceStyle.surface)
                            } else {
                                Circle().strokeBorder(.primary.opacity(index == mission.step ? 0 : 0.15))
                                Text(String(index + 1)).font(Typeface.chip).foregroundStyle(index == mission.step && mission.state == "active" ? Color.white : .secondary)
                            }
                        }.frame(width: 24, height: 24)
                        if index < mission.stops.count - 1 {
                            Rectangle().fill(mission.passed(index) ? passedColor.opacity(0.6) : .primary.opacity(0.1)).frame(height: 1)
                        }
                    }
                    Text(title).font(index == mission.step ? Typeface.captionStrong : Typeface.caption)
                        .foregroundStyle(index == mission.step && mission.state == "active" ? .primary : .secondary).lineLimit(1)
                }
                // The last step takes only its own width so the track ends at the card's edge.
                .frame(maxWidth: index < mission.stops.count - 1 ? .infinity : nil, alignment: .leading)
            }
        }.accessibilityElement(children: .ignore)
            .accessibilityLabel(mission.state == "done" ? "Done, all \(mission.stops.count) steps passed" : "Step \(mission.step + 1) of \(mission.stops.count), \(mission.stops[mission.step])")
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
