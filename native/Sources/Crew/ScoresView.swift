import SwiftUI

/// Model scores from the lead's review notes: a podium for the leaders, then every model's standing.
/// Mirrors plugin/board/src/Scores.tsx.
extension ModelScore {
    var shown: String { Self.shown(score) }
    static func shown(_ value: Double?) -> String { value.map { String(format: "%.1f", $0) } ?? "—" }
    /// A word for where the score sits; a model still short of reviews gets none.
    var band: (word: String, tone: Color)? {
        guard let score, status != "too few samples" else { return nil }
        switch score {
        case 9...: return (String(localized: "Outstanding"), Palette.success)
        case 8..<9: return (String(localized: "Strong"), Palette.success)
        case 7..<8: return (String(localized: "Solid"), Palette.accent)
        case 6..<7: return (String(localized: "Mixed"), Palette.warning)
        default: return (String(localized: "Shaky"), Palette.danger)
        }
    }
    var tone: Color { band?.tone ?? Color.secondary.opacity(0.5) }
    /// The count beside the status: builds, or reviews for a model that only reviewed; an older daemon gives one total.
    /// Mirrors samplesText in Scores.tsx.
    var countsText: String {
        let reviews = reviewSamples ?? 0
        let count = buildSamples.map { builds in
            score == nil && reviews > 0
                ? (reviews == 1 ? String(localized: "1 review") : String(localized: "\(reviews) reviews"))
                : (builds == 1 ? String(localized: "1 build") : String(localized: "\(builds) builds"))
        } ?? (samples == 1 ? String(localized: "1 review") : String(localized: "\(samples) reviews"))
        return statusText + " · " + count
    }
    /// What a row's ring shows: the score, or for a model that only reviewed, how its findings held up. Mirrors ringValue in Scores.tsx.
    var ringValue: Double? { score ?? items?.findings }
    var statusText: String { status == "settled" ? String(localized: "Settled") : status == "on trial" ? String(localized: "On trial") : String(localized: "Too few reviews") }
}

private let medals: [Color] = [Color(red: 1, green: 0.8, blue: 0), Color(red: 0.78, green: 0.78, blue: 0.8), Color(red: 0.83, green: 0.6, blue: 0.42)]

/// The three best-scored models on a podium, the winner in the middle and highest. They rise third, second, then first.
struct ModelPodium: View {
    let top: [ModelScore]
    /// Starts settled, as a snapshot needs; on screen it rises in when it appears.
    @State private var shown: Bool
    init(top: [ModelScore], settled: Bool = false) { self.top = top; _shown = State(initialValue: settled) }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    private static let heights: [CGFloat] = [92, 68, 52]
    var body: some View {
        HStack(alignment: .bottom, spacing: Space.s) {
            ForEach([1, 0, 2].filter { $0 < top.count }, id: \.self) { index in place(index) }
        }
        .padding(.horizontal, top.count == 2 ? 80 : Space.l)
        .padding(.top, Space.xxl)
        .frame(maxWidth: .infinity)
        // A grouped Form insets the row within its card and ignores listRowInsets and listRowBackground, so nothing
        // here may stay lit up to the row's edge: the glow fades out inside the row, as the pedestals do at their foot.
        .background {
            EllipticalGradient(colors: [medals[0].opacity(0.14), .clear], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Top models")
        .onAppear { if reduceMotion { shown = true } else { withAnimation(.spring(duration: 0.6, bounce: 0.18)) { shown = true } } }
    }
    private func place(_ index: Int) -> some View {
        let score = top[index]
        let medal = medals[index]
        let order = Double(2 - index)
        return VStack(spacing: Space.ml) {
            VStack(spacing: Space.s) {
                if index == 0 {
                    Image(systemName: "trophy.fill").font(.system(size: 16)).foregroundStyle(medal.gradient)
                }
                ZStack(alignment: .bottomTrailing) {
                    Circle().fill(.quaternary).frame(width: index == 0 ? 60 : 50, height: index == 0 ? 60 : 50)
                        .overlay { AgentMark(agent: score.agent, size: index == 0 ? 28 : MarkSize.card) }
                        .overlay { Circle().strokeBorder(medal.opacity(0.85), lineWidth: 2.5).padding(-4) }
                    Text("\(index + 1)").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundStyle(.black.opacity(0.72))
                        .frame(width: 20, height: 20).background(medal, in: Circle()).offset(x: 4, y: 4)
                }
                .padding(Space.xs)
                Text(score.model).font(Typeface.bodyStrong).lineLimit(1).truncationMode(.tail).padding(.top, Space.xxs)
                HStack(alignment: .firstTextBaseline, spacing: Space.xxs) {
                    Text(score.shown).font(Typeface.cardTitle).monospacedDigit()
                        .contentTransition(.numericText(value: score.score ?? 0))
                    Text("/10").font(.system(size: 11, weight: .medium, design: .rounded)).foregroundStyle(.secondary)
                }
                // The glass carries the tone; the number stays in the label color, since a toned number on toned
                // glass falls under 2:1 (blue measured 1.8:1 in dark).
                .foregroundStyle(.primary)
                .padding(.horizontal, Space.ml).padding(.vertical, Space.xs)
                .glassEffect(.regular.tint(score.tone.opacity(0.3)), in: .capsule)
            }
            .opacity(shown ? 1 : 0).offset(y: shown ? 0 : 10).blur(radius: shown ? 0 : 4)
            .animation(reduceMotion ? nil : .spring(duration: 0.55, bounce: 0.15).delay(0.26 + order * 0.09), value: shown)
            UnevenRoundedRectangle(topLeadingRadius: WorkspaceStyle.rowRadius, topTrailingRadius: WorkspaceStyle.rowRadius, style: .continuous)
                .fill(LinearGradient(colors: [medal.opacity(0.32), medal.opacity(0)], startPoint: .top, endPoint: .bottom))
                .overlay(alignment: .top) {
                    Text("\(index + 1)").font(.system(size: 30, weight: .semibold, design: .rounded))
                        // On a dark surface a darkened numeral sinks into its pedestal, so it takes the medal itself.
                        .foregroundStyle(scheme == .dark ? medal.opacity(0.7) : medal.mix(with: .black, by: 0.3).opacity(0.6)).padding(.top, Space.s)
                }
                .frame(height: Self.heights[index])
                .scaleEffect(x: 1, y: shown ? 1 : 0.001, anchor: .bottom)
                .animation(reduceMotion ? nil : .spring(duration: 0.62, bounce: 0.12).delay(order * 0.09), value: shown)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Place \(index + 1): \(score.model), \(agentName(score.agent)), \(score.shown) out of 10")
    }
}

/// The score as a ring filling out of 10, with the number in its middle.
struct ScoreRing: View {
    let score: ModelScore
    var size: CGFloat = 46
    @State private var filled: Bool
    init(score: ModelScore, size: CGFloat = 46, settled: Bool = false) { self.score = score; self.size = size; _filled = State(initialValue: settled) }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            Circle().stroke(.quaternary, lineWidth: 3.5)
            Circle().trim(from: 0, to: filled ? (score.ringValue ?? 0) / 10 : 0)
                .stroke(score.tone, style: StrokeStyle(lineWidth: 3.5, lineCap: .round)).rotationEffect(.degrees(-90))
            Text(ModelScore.shown(score.ringValue)).font(.system(size: 14, weight: .semibold, design: .rounded)).monospacedDigit()
                .foregroundStyle(score.status == "settled" ? .primary : .secondary)
        }
        .frame(width: size, height: size)
        .onAppear { if reduceMotion { filled = true } else { withAnimation(.easeOut(duration: 0.9).delay(0.2)) { filled = true } } }
    }
}

/// One model's standing: rank, mark, verdict word, status, and the ring.
struct ModelScoreRow: View {
    let rank: Int?
    let score: ModelScore
    var settled = false
    var body: some View {
        HStack(alignment: .center, spacing: Space.l) {
            Text(rank.map(String.init) ?? "").font(.system(size: 15, weight: .semibold, design: .rounded)).monospacedDigit().foregroundStyle(.secondary).frame(width: 18)
            Circle().fill(.quaternary).frame(width: 34, height: 34).overlay { AgentMark(agent: score.agent, size: MarkSize.list) }
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(spacing: Space.s) {
                    Text(score.model).font(Typeface.bodyStrong).lineLimit(1).textSelection(.enabled)
                    if let band = score.band { Text(band.word).chip(band.tone) }
                }
                Text(score.countsText).font(Typeface.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            // The text takes every point the ring leaves, so a line wraps only when the row is really that narrow.
            .frame(maxWidth: .infinity, alignment: .leading)
            ScoreRing(score: score, settled: settled)
        }
        .padding(.vertical, Space.s)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([rank.map { String(localized: "Rank \($0)") }, String(localized: "\(score.model), \(agentName(score.agent)), \(ModelScore.shown(score.ringValue)) out of 10"), score.band?.word]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityValue(score.countsText)
    }
}
