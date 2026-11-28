import SwiftUI
import AppKit

struct AgentMark: View {
    let agent: String
    var size: CGFloat = 24
    private var name: String { ["claude": "ClaudeCode", "codex": "Codex", "antigravity": "Antigravity", "cursor": "Cursor"][agent] ?? "Codex" }
    var body: some View {
        Image("Service\(name)").renderingMode(.template).resizable().scaledToFit()
            .frame(width: size, height: size).foregroundStyle(.primary).accessibilityHidden(true)
    }
}

struct StatusLabel: View {
    let state: String
    var title: String? = nil
    /// An active mission's chip and a working agent's turn; a turning symbol on every running row would be restless.
    var spins = false
    var symbol: String {
        switch state {
        case "waiting": return "bell.badge.fill"
        case "failed", "error": return "exclamationmark.triangle.fill"
        case "stalled": return "clock.badge.exclamationmark"
        case "done": return "checkmark.circle.fill"
        case "running", "working", "active": return "progress.indicator"
        case "cancelled", "abandoned": return "stop.circle"
        default: return "circle"
        }
    }
    var color: Color {
        switch state {
        case "waiting", "stalled": return Palette.warning
        case "failed", "error": return Palette.danger
        case "done": return Palette.success
        case "merged": return Palette.merged
        case "running", "working", "active": return Palette.accent
        default: return .secondary
        }
    }
    var body: some View {
        Label { Text(title ?? localizedCrewLabel(state.capitalized)) } icon: { StatusSymbol(name: symbol, color: color, spins: spins) }.chip(color, insets: Chip.symbolInsets)
    }
}

/// A status symbol, turning slowly when asked, as on the board, unless Reduce Motion is on.
struct StatusSymbol: View {
    let name: String
    let color: Color
    let spins: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        // Inked here rather than left to the chip's style, which a turning picture may not see change (see `Turning`).
        Turning(isActive: spins && !reduceMotion) { Image(systemName: name).foregroundStyle(color.ink(scheme)) }
    }
}

/// Turns its content clockwise once every four seconds, a calm turn rather than a busy spinner, as a layer animation
/// on a picture of the content. SwiftUI drives its own animations by rendering the window's whole view graph every
/// frame, which for one turning symbol took a quarter of a core for as long as a mission was active; the render
/// server turns a layer at no cost to the app.
struct Turning<Content: View>: View {
    let isActive: Bool
    let content: Content
    @Environment(\.self) private var environment
    init(isActive: Bool, @ViewBuilder content: () -> Content) {
        self.isActive = isActive; self.content = content()
    }
    var body: some View {
        // Without a picture to turn, the content shows as it is rather than leaving its place empty.
        if isActive, let picture {
            // The content itself keeps its place in the layout, unseen under its turning picture.
            content.hidden().overlay { TurningLayer(image: picture, scale: scale).allowsHitTesting(false) }
        } else {
            content
        }
    }
    /// Twice the display's own scale, so a turned picture stays as crisp as a glyph drawn at that angle.
    private var scale: CGFloat { environment.displayScale * 2 }
    /// Drawn with the environment the content stands in, so its font is the one it would show. A foreground style
    /// belongs on the content itself: a change to an inherited one alone does not update this environment, so the
    /// picture would keep the style from the last other change, such as a chip's gray from before it turned.
    private var picture: CGImage? {
        let renderer = ImageRenderer(content: content.environment(\.self, environment))
        renderer.scale = scale
        return renderer.cgImage
    }
}

struct TurningLayer: NSViewRepresentable {
    let image: CGImage
    let scale: CGFloat
    func makeNSView(context: Context) -> Surface { Surface() }
    func updateNSView(_ view: Surface, context: Context) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        view.turning.contents = image
        view.turning.contentsScale = scale
        // A symbol's weight rarely sits at the middle of its frame; turning about the frame would make it wobble.
        view.turning.anchorPoint = Self.inkCenter(of: image)
        view.turning.frame = view.bounds
        CATransaction.commit()
    }
    /// Where the picture's ink balances, in the layer's unit coordinates.
    static func inkCenter(of image: CGImage) -> CGPoint {
        let width = image.width, height = image.height
        // The context owns its bitmap, so the bytes read below are the ones it drew into.
        guard width > 0, height > 0, let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                                                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) else { return CGPoint(x: 0.5, y: 0.5) }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let data = context.data else { return CGPoint(x: 0.5, y: 0.5) }
        let alpha = data.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * height)
        var total = 0.0, x = 0.0, y = 0.0
        for row in 0..<height {
            for column in 0..<width {
                let weight = Double(alpha[row * context.bytesPerRow + column])
                total += weight; x += weight * (Double(column) + 0.5); y += weight * (Double(row) + 0.5)
            }
        }
        guard total > 0 else { return CGPoint(x: 0.5, y: 0.5) }
        // Bitmap rows run from the top; the layer's unit space runs from the bottom.
        return CGPoint(x: x / total / Double(width), y: 1 - y / total / Double(height))
    }
    final class Surface: NSView {
        let turning = CALayer()
        init() {
            super.init(frame: .zero)
            wantsLayer = true
            turning.contentsGravity = .center
            turning.minificationFilter = .trilinear
            layer?.addSublayer(turning)
            setAccessibilityElement(false)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            turning.frame = bounds
            CATransaction.commit()
            start()
        }
        // A layer's animations leave with it when its view leaves the window.
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            start()
        }
        private func start() {
            guard window != nil, turning.animation(forKey: "turn") == nil else { return }
            let turn = CABasicAnimation(keyPath: "transform.rotation.z")
            turn.fromValue = 0
            turn.toValue = -2 * Double.pi
            turn.duration = 4
            turn.repeatCount = .infinity
            turn.isRemovedOnCompletion = false
            turning.add(turn, forKey: "turn")
        }
    }
}

/// A job's or session's status as its symbol alone, quieter than a chip in a list of them; the word is its name.
struct StatusIcon: View {
    let state: String
    let title: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let label = StatusLabel(state: state)
        Image(systemName: label.symbol).font(Typeface.body).foregroundStyle(label.color.ink(scheme))
            .help(title).accessibilityLabel(title)
    }
}

/// A chip's face: chip type inked in its color, on that color's tint, outlined under Increase Contrast.
private struct ChipStyle<S: InsettableShape>: ViewModifier {
    let color: Color
    let shape: S
    let insets: EdgeInsets
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let text = color.ink(scheme)
        content
            .font(Typeface.chip).foregroundStyle(text).lineLimit(1).fixedSize()
            .padding(insets)
            .background(Palette.chip(color), in: shape)
            .overlay { if contrast == .increased { shape.strokeBorder(text.opacity(0.5)) } }
    }
}

extension View {
    /// A status chip's face in `color`, as `StatusLabel` draws it.
    func chip(_ color: Color, insets: EdgeInsets = Chip.insets) -> some View { chip(color, in: Capsule(), insets: insets) }
    /// The same face in another shape.
    func chip(_ color: Color, in shape: some InsettableShape, insets: EdgeInsets = Chip.insets) -> some View { modifier(ChipStyle(color: color, shape: shape, insets: insets)) }
    /// A text field's or editor's surface: the card's surface in a hairline outline.
    func fieldSurface() -> some View {
        background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius))
            .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(WorkspaceStyle.hairline))
    }
    /// A typed-in text field on `fieldSurface`, at a pill's height so it lines up with the pills beside it.
    func surfaceTextField() -> some View { modifier(SurfaceTextField()) }
}

/// A plain text field draws no focus ring, so the focused one takes an accent outline in its place.
private struct SurfaceTextField: ViewModifier {
    @FocusState private var focused: Bool
    func body(content: Content) -> some View {
        content.textFieldStyle(.plain).font(Typeface.body).focused($focused)
            .padding(.horizontal, Space.ml).padding(.vertical, Pill.insets.top)
            .fieldSurface()
            .overlay { if focused { RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(Palette.accent, lineWidth: 2) } }
    }
}

/// A row of actions at the trailing edge, or of chips at the leading edge. Pills never shrink, so when they do not fit
/// across, the ones that do not fit move onto further lines, still at that edge, rather than running past the edges of
/// what holds them.
struct ActionRow: Layout {
    var spacing = Space.m
    var leading = false
    private struct Line { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    private func lines(_ width: CGFloat, _ sizes: [CGSize]) -> [Line] {
        var lines: [Line] = []
        var line = Line()
        for (index, size) in sizes.enumerated() {
            if !line.items.isEmpty && line.width + spacing + size.width > width { lines.append(line); line = Line() }
            line.width += (line.items.isEmpty ? 0 : spacing) + size.width
            line.height = max(line.height, size.height)
            line.items.append(index)
        }
        return lines + [line]
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = lines(proposal.width ?? .infinity, subviews.map { $0.sizeThatFits(.unspecified) })
        return CGSize(width: lines.map(\.width).max() ?? 0,
                      height: lines.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, lines.count - 1)))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        var y = bounds.minY
        // Split by the width the row was measured at, not its rounded bounds, so the lines match the measured height.
        for line in lines(proposal.width ?? .infinity, sizes) {
            var x = leading ? bounds.minX : bounds.maxX - line.width
            for index in line.items {
                subviews[index].place(at: CGPoint(x: x, y: y + line.height / 2), anchor: .leading, proposal: ProposedViewSize(sizes[index]))
                x += sizes[index].width + spacing
            }
            y += line.height + spacing
        }
    }
}

/// A light, centered empty state; quieter than ContentUnavailableView's bold title.
struct EmptyState<Actions: View>: View {
    var title: String
    var symbol: String
    var detail: String? = nil
    @ViewBuilder var actions: Actions
    var body: some View {
        VStack(spacing: Space.s) {
            VStack(spacing: Space.s) {
                Image(systemName: symbol).font(Symbol.empty).foregroundStyle(.secondary).padding(.bottom, Space.xxs)
                Text(title).font(Typeface.emptyTitle).foregroundStyle(.secondary)
                if let detail { Text(detail).font(Typeface.callout).foregroundStyle(.tertiary) }
            }.accessibilityElement(children: .combine)
            // Kept out of the combined element so the action stays its own control.
            actions.padding(.top, Space.ml)
        }
        .multilineTextAlignment(.center).centeredInPage()
    }
}
extension EmptyState where Actions == EmptyView {
    init(title: String, symbol: String, detail: String? = nil) {
        self.init(title: title, symbol: symbol, detail: detail) { EmptyView() }
    }
}

struct ContentPanel<Content: View>: View {
    var title: String?
    var symbol = ""
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            if let title {
                Label(title, systemImage: symbol).font(Typeface.title).accessibilityAddTraits(.isHeader).padding(.leading, WorkspaceStyle.rowTitleInset)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
    }
}

/// An error in words, the same wherever one shows; the caller sets its type.
struct ErrorLabel: View {
    let message: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle").foregroundStyle(Palette.danger.ink(scheme)).textSelection(.enabled)
    }
}

struct ActionMessage: View {
    var state: ActionState?
    var body: some View {
        if let error = state?.error { ErrorLabel(message: error).font(Typeface.callout) }
        else if state?.pending == true { ProgressView().controlSize(.small).accessibilityLabel("Sending") }
        else if state?.accepted == true { Label("Sent", systemImage: "checkmark").foregroundStyle(.secondary).font(Typeface.callout) }
    }
}

/// Copies text. The copy symbol says what it does, so the title names only what is copied, and `help` says it whole.
struct CopyButton: View {
    var title: String
    var text: String
    var help: String? = nil
    @State private var copied = false
    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
        } label: { Label(copied ? String(localized: "Copied") : title, systemImage: copied ? "checkmark" : "doc.on.doc") }
        .pillButton().morphs(on: copied)
        .help(help ?? title)
        // The title names only what is copied; VoiceOver hears the action too.
        .accessibilityLabel(copied ? String(localized: "Copied") : String(localized: "Copy \(title.lowercased())"))
        .task(id: copied) {
            if copied {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        }
    }
}

struct MessageEditor: View {
    var title: String
    @Binding var text: String
    var prompt: String? = nil
    var disabled = false
    var body: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(Typeface.body).lineSpacing(2)
                .scrollContentBackground(.hidden)
                .accessibilityLabel(title)
            if let prompt, text.isEmpty { FieldPrompt(text: prompt) }
        }
        .padding(Space.ml)
        .frame(minHeight: WorkspaceStyle.editorHeight.lowerBound, maxHeight: WorkspaceStyle.editorHeight.upperBound)
        .fieldSurface()
        .disabled(disabled)
    }
}

/// A text editor's placeholder, laid over it.
private struct FieldPrompt: View {
    let text: String
    var body: some View {
        Text(text).font(Typeface.body).foregroundStyle(.tertiary)
            // The text view's own line fragment padding, so the placeholder sits where typing starts.
            .padding(.leading, 5).allowsHitTesting(false).accessibilityHidden(true)
    }
}

struct AnswerView: View {
    @Bindable var store: CrewStore
    let job: Job
    private var locked: Bool { store.actions[job.requestKey]?.locked == true || !store.connected }
    private var draft: Binding<String> {
        Binding(get: { store.drafts[job.requestKey] ?? "" }, set: { store.drafts[job.requestKey] = $0 })
    }
    private var canSend: Bool { !locked && !draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        if job.state == "waiting", let waiting = job.waiting {
            VStack(alignment: .leading, spacing: Space.xl) {
                // The request itself is what the person acts on, so it leads the hierarchy.
                Text(waiting.reason).font(Typeface.headline).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if waiting.type == "question" {
                    composer
                    // Quick replies sit apart from the composer so they don't read as part of sending.
                    GlassEffectContainer(spacing: Space.xs) { ActionRow {
                        decision(String(localized: "No"), symbol: "xmark", value: "deny", prominent: false)
                        decision(String(localized: "Yes"), symbol: "checkmark", value: "approve", prominent: false)
                    }.frame(maxWidth: .infinity, alignment: .trailing) }
                } else {
                    // At the trailing edge with the completing action last, as everywhere a choice ends something.
                    GlassEffectContainer(spacing: Space.xs) { ActionRow {
                        decision(String(localized: "Deny"), symbol: "xmark", value: "deny", prominent: false)
                        if let grant = waiting.grant {
                            decision(String(localized: "Allow for This Job"), symbol: "checkmark.circle", value: "allow_for_job", prominent: false)
                                .help("Also allow this job's later requests for \(grant), without asking")
                        }
                        decision(String(localized: "Approve"), symbol: "checkmark", value: "approve", prominent: true)
                    }.frame(maxWidth: .infinity, alignment: .trailing) }
                }
                ActionMessage(state: store.actions[job.requestKey])
            }
        }
    }
    private var composer: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: draft)
                .font(Typeface.body).lineSpacing(2)
                .scrollContentBackground(.hidden)
                .frame(minHeight: WorkspaceStyle.answerHeight.lowerBound, maxHeight: WorkspaceStyle.answerHeight.upperBound)
                .accessibilityLabel("Your answer")
            if draft.wrappedValue.isEmpty { FieldPrompt(text: String(localized: "Write an answer…")) }
        }
        // The trailing room keeps text clear of the send button laid over the corner: its diameter and inset.
        .padding(.leading, Space.ml).padding(.top, Space.ml).padding(.trailing, IconButton.diameter + Space.m * 2).padding(.bottom, Space.m)
        .overlay(alignment: .bottomTrailing) {
            Button("Send Answer", systemImage: "arrow.up") {
                Task { await store.answer(job, message: draft.wrappedValue) }
            }
            .iconButton(prominent: true)
            .disabled(!canSend).help("Send Answer").padding(Space.m)
        }
        .fieldSurface()
        .disabled(locked)
    }
    @ViewBuilder private func decision(_ title: String, symbol: String, value: String, prominent: Bool) -> some View {
        // A draft typed before a quick reply goes along with it rather than being discarded.
        let note = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        Button(title, systemImage: symbol) { Task { await store.answer(job, decision: value, message: note.isEmpty ? nil : note) } }
            // Liquid Glass, as the app's other primary choices are. Their container samples them together; its spacing, under
            // their gap, keeps them apart at rest.
            .glassPillButton(prominent: prominent).disabled(locked)
    }
}

/// Reads the store's clock in its own body, so the periodic tick redraws only running timers.
struct ElapsedText: View {
    let store: CrewStore
    let start: Double
    let end: Double?
    var body: some View { Text(elapsed((end ?? store.now) - start)) }
}

/// A job as a row: the mark of the agent that ran it, its title and what it is doing. Under a mission stop the stop
/// names the kind of work; elsewhere `showsKind` puts it in the detail line instead.
struct JobRow: View {
    let job: Job
    var selected = false
    var showsKind = true
    let store: CrewStore
    var open: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let detail = [showsKind ? job.kindTitle : job.debate != nil ? String(localized: "Debate") : job.ask == true ? String(localized: "Question") : nil, job.error?.message ?? (job.isActive ? job.phase : nil),
                      job.runsApp == true ? String(localized: "Runs the app") : nil, job.exclusive == true ? String(localized: "Runs alone") : nil]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        Button(action: open) {
            HStack(spacing: Space.l) {
                AgentMark(agent: job.agent, size: MarkSize.row).frame(width: WorkspaceStyle.iconColumn).help(agentName(job.agent))
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(job.title).font(Typeface.bodyStrong).foregroundStyle(.primary).lineLimit(2)
                    if !detail.isEmpty {
                        Text(detail).font(Typeface.caption).foregroundStyle(job.error == nil ? Color.secondary : Palette.danger.ink(scheme)).lineLimit(1)
                    }
                }
                Spacer(minLength: WorkspaceStyle.rowSpacer)
                ElapsedText(store: store, start: job.createdAt, end: job.endedAt).monospacedDigit().font(Typeface.caption).foregroundStyle(.secondary)
                    .frame(minWidth: WorkspaceStyle.elapsedColumn, alignment: .trailing)
                StatusIcon(state: job.stalled ? "stalled" : job.state, title: job.status)
                Image(systemName: "chevron.right").font(Typeface.micro).foregroundStyle(.tertiary)
            }
            .padding(WorkspaceStyle.rowInsets).contentShape(Rectangle())
            // A request is marked by its status icon alone, as a failure is: a tinted row read as louder than either.
            .background(selected ? Palette.selection : WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
        }.buttonStyle(WorkspacePressStyle())
        .accessibilityElement(children: .combine)
        // The mark is decorative to VoiceOver, so the agent it shows is read here.
        .accessibilityValue(agentName(job.agent))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A lead session as a row like a job's, opening the same detail panel.
struct SessionRow: View {
    let session: ClaudeSession
    var selected = false
    let store: CrewStore
    var open: () -> Void
    var body: some View {
        // The mark names the agent, so the detail line says only what the session is doing.
        let detail = [session.waitingFor ?? (session.state == "idle" ? nil : session.phase), session.inTool ? String(localized: "Running a tool") : nil, session.agentSummary]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        Button(action: open) {
            HStack(spacing: Space.l) {
                AgentMark(agent: session.agent, size: MarkSize.row).frame(width: WorkspaceStyle.iconColumn)
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(session.title).font(Typeface.bodyStrong).foregroundStyle(.primary).lineLimit(2)
                    // A new status line swaps in over the old one rather than cutting to it.
                    ZStack(alignment: .leading) {
                        if !detail.isEmpty {
                            Text(detail).font(Typeface.caption).foregroundStyle(.secondary).lineLimit(1).id(detail).transition(.wordSwap(anchor: .leading))
                        }
                    }
                }
                Spacer(minLength: WorkspaceStyle.rowSpacer)
                // An idle session stops its clock at its last activity.
                ElapsedText(store: store, start: session.startedAt, end: session.state == "idle" ? session.activeAt : nil)
                    .monospacedDigit().font(Typeface.caption).foregroundStyle(.secondary).frame(minWidth: WorkspaceStyle.elapsedColumn, alignment: .trailing)
                StatusIcon(state: session.stalled ? "stalled" : session.state, title: session.stalled ? String(localized: "May be stuck") : localizedCrewLabel(session.state.capitalized))
                Image(systemName: "chevron.right").font(Typeface.micro).foregroundStyle(.tertiary)
            }
            .padding(WorkspaceStyle.rowInsets).contentShape(Rectangle())
            // A request is marked by its status icon alone, as a failure is: a tinted row read as louder than either.
            .background(selected ? Palette.selection : WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
        }.buttonStyle(WorkspacePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(agentName(session.agent))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
struct EventList: View {
    var events: [CrewEvent]
    /// Nil inside a job's own details, where every event belongs to the job already shown.
    var openJob: ((String) -> Void)? = nil
    var body: some View {
        LazyVStack(alignment: .leading, spacing: Space.xl) {
            ForEach(events.reversed()) { event in
                HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                    Image(systemName: event.kind == "error" ? "exclamationmark.circle" : event.kind == "done" ? "checkmark.circle" : "circle.fill")
                        .font(Typeface.caption).foregroundStyle(event.kind == "error" ? Palette.danger : .secondary).frame(width: Symbol.controlFrame)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(agentName(event.agent)).font(Typeface.calloutStrong)
                            if let date = ISO8601DateFormatter.crew.date(from: event.ts) {
                                Text(date, style: .time).font(Typeface.caption).monospacedDigit().foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        // Laid over the line rather than in it, so a row with a job is as tall as one without.
                        .overlay(alignment: .trailing) {
                            if let id = event.job_id, let openJob {
                                Button("Show Job", systemImage: "arrow.up.right") { openJob(id) }.iconButton().help("Show Job")
                            }
                        }
                        Text(event.detail).font(Typeface.callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    }
                }
                // Eases in only where the caller animates the list's changes.
                .transition(.card)
            }
        }
    }
}
extension ISO8601DateFormatter {
    @MainActor static let crew: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct WorkspacePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.68 : 1)
    }
}

struct AgentUsageView: View {
    let store: CrewStore
    let agent: String
    var body: some View {
        if let usage = store.usage, usage.source != "none" {
            if let provider = usage.providers.first(where: { $0.agent == agent }) {
                VStack(alignment: .leading, spacing: Space.s) {
                    if provider.shownWindows.isEmpty {
                        Text(localizedCrewLabel(provider.status.rawValue.capitalized)).foregroundStyle(.secondary)
                    }
                    ForEach(provider.shownWindows, id: \.key) { window in
                        // The provider's status overrides a window's when the reading is old or a job just hit the limit.
                        let status = [.stale, .unknown, .exhausted].contains(provider.status) ? provider.status : window.status
                        VStack(alignment: .leading, spacing: Space.m) {
                            HStack(spacing: Space.s) {
                                Text(window.name)
                                Text(window.usedRatio, format: .percent.precision(.fractionLength(0))).monospacedDigit()
                                if status == .stale || status == .unknown || (status == .exhausted && window.status != .exhausted) { Text(status == .exhausted ? String(localized: "limit reached") : localizedCrewLabel(status.rawValue)) }
                                Spacer(minLength: 0)
                                if let reset = window.resetTime {
                                    Text("Resets \(Date(timeIntervalSince1970: reset / 1000), style: .relative)")
                                }
                            }
                            GeometryReader { geometry in
                                Capsule().fill(tint(window.usedRatio, status)).frame(width: geometry.size.width * min(1, max(0, window.usedRatio)))
                            }.frame(height: WorkspaceStyle.usageBarHeight).background(.quaternary, in: Capsule()).accessibilityHidden(true)
                        }.foregroundStyle(tint(window.usedRatio, status))
                    }
                }.font(Typeface.caption).help(([provider.reason] + provider.windows.filter { $0.group != nil }.map {
                    let percent = "\(Int($0.usedRatio * 100))%"
                    return String(localized: "\($0.group!): \($0.name), \(percent), \(localizedCrewLabel($0.status.rawValue))")
                }).joined(separator: "\n"))
            } else {
                Text("Usage unknown").font(Typeface.caption).foregroundStyle(.secondary)
            }
        } else if let usage = store.limits[agent] ?? nil, let maximum = usage.windows?.map(\.usedPercent).max() {
            let percent = "\(Int(maximum))%"
            Text("\(percent) of limit").font(Typeface.caption).monospacedDigit().foregroundStyle(tint(maximum / 100, .ok))
                .help((usage.windows ?? []).map { window in
                    let percent = "\(Int(window.usedPercent))%"
                    let limit = window.minutes.map { String(localized: "\(Int($0))-minute limit") } ?? String(localized: "limit")
                    return String(localized: "\(percent) of \(limit)")
                }.joined(separator: "\n"))
        }
    }
    /// AgentGauge's thresholds: caution from 70% used or when it reports the window tight, danger from 90% or when the limit was hit.
    private func tint(_ used: Double, _ status: UsageStatus) -> Color {
        if status == .exhausted || used >= 0.9 { return Palette.danger }
        return used >= 0.7 || status == .tight ? Palette.warning : .secondary
    }
}

/// Keeps content to its single line and, when the line runs out of room, fades its end out instead of cutting it
/// with an ellipsis, so a long title neither wraps nor changes the height of what holds it.
private struct FadeTruncation: ViewModifier {
    var fade: CGFloat = 36
    @State private var natural: CGFloat = 0
    @State private var available: CGFloat = 0
    func body(content: Content) -> some View {
        content.lineLimit(1).fixedSize(horizontal: true, vertical: false)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { natural = $0 }
            // No ideal width of its own, so a long line never decides a layout that fits by ideal sizes.
            .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
            .clipped()
            .mask {
                if natural > available + 0.5 {
                    HStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: fade)
                    }
                } else {
                    Color.black
                }
            }
    }
}
extension View {
    func fadeTruncated() -> some View { modifier(FadeTruncation()) }
}

/// Keeps the scroll views of its window on thin overlay scroll bars, which show only while scrolling. With a mouse
/// attached, macOS otherwise switches every scroll view to wide legacy bars that always take a strip of the page.
/// Lists, forms and text editors build their scroll views beside the view that asks, so the whole window is covered.
struct OverlayScrollers: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Probe() }
    func updateNSView(_ view: NSView, context: Context) {}
    final class Probe: NSView {
        nonisolated(unsafe) private var observer: NSObjectProtocol?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // The scroll views beside this one are built in the same pass.
            DispatchQueue.main.async { [weak self] in self?.apply() }
            guard observer == nil else { return }
            // The scroll view takes the new system style on this notice too; applied after it, so ours wins.
            observer = NotificationCenter.default.addObserver(forName: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                DispatchQueue.main.async { self?.apply() }
            }
        }
        private func apply() {
            func walk(_ view: NSView) {
                if let scroll = view as? NSScrollView, scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
                view.subviews.forEach(walk)
            }
            if let root = window?.contentView?.superview { walk(root) }
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}

/// One item in a detail section's gray inset: a title row, then the item's body starting below it at the same
/// leading edge. Status words, marks and the item's own action sit at the end of the title row.
struct DetailItem<Accessory: View, Content: View>: View {
    let title: String
    var symbol: String? = nil
    var tint: Color? = nil
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.s) {
                Group {
                    if let symbol { Label(title, systemImage: symbol) } else { Text(title) }
                }
                .font(Typeface.bodyStrong).foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary))
                Spacer(minLength: WorkspaceStyle.rowSpacer)
                accessory
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
extension DetailItem where Accessory == EmptyView {
    init(title: String, symbol: String? = nil, tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, symbol: symbol, tint: tint, accessory: { EmptyView() }, content: content)
    }
}

/// What a waiting Claude session asks beyond its headline: each question's choices, or the tool input an approval is for.
struct ClaudeAskView: View {
    let session: ClaudeSession
    var body: some View {
        if session.state == "waiting", let ask = session.ask {
            if let questions = ask.questions {
                VStack(alignment: .leading, spacing: Space.m) {
                    ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                        // The first question is the headline above.
                        if index > 0 { Text(question.question).font(Typeface.callout).textSelection(.enabled) }
                        ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                            Text(option).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
                                // About a pill's height, as on the board, rather than a thin row.
                                .padding(.horizontal, Space.l).padding(.vertical, Space.ml)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius).strokeBorder(WorkspaceStyle.hairline))
                        }
                    }
                }
            } else if let input = ask.input {
                ScrollView {
                    Text(input).font(Typeface.codeSmall).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(maxHeight: 160).fixedSize(horizontal: false, vertical: true).inset()
            }
        }
    }
}

/// Opens the session in its agent's desktop app, where its prompts are answered; nothing when no app can open it.
struct OpenInAgentButton: View {
    let session: ClaudeSession

    /// Codex's link is offered only with an app registered for it; Claude's exists only for a desktop session.
    static func availableURL(for session: ClaudeSession) -> URL? {
        guard let url = session.appURL else { return nil }
        if session.agent == "codex" && NSWorkspace.shared.urlForApplication(toOpen: url) == nil { return nil }
        return url
    }

    var body: some View {
        if let url = Self.availableURL(for: session) {
            let name = agentName(session.agent)
            Button("Open in \(name)", systemImage: "arrow.up.right") { NSWorkspace.shared.open(url) }
                .pillButton().help("Open this session in the \(name) app")
        }
    }
}

/// The detail panel's last row: its actions at the trailing edge.
struct DetailFooter<Actions: View>: View {
    @ViewBuilder var actions: Actions
    var body: some View {
        VStack(alignment: .leading, spacing: Space.ml) {
            Divider().padding(.bottom, Space.xs)
            HStack(spacing: Space.m) { Spacer(minLength: 0); actions }
        }
    }
}
