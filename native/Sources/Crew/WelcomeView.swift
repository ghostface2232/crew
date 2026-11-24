import SwiftUI
import AppKit

/// First-run guide, matching `Onboarding` on the web board: what Crew is, how to start work, where requests arrive,
/// and what to set up. Its illustrations use the app's own views so they match the UI they describe.
struct WelcomeView: View {
    let store: CrewStore
    @State private var index = 0
    @Environment(\.dismiss) private var dismiss
    /// Keeps focus on the sheet itself so arrow keys page through it.
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let pages = WelcomePage.allCases
    private var last: Bool { index == Self.pages.count - 1 }
    var body: some View {
        VStack(spacing: 0) {
            art
            // Every page's text shares one cell so the sheet keeps the tallest page's height and never jumps;
            // shorter pages sit centered vertically.
            ZStack {
                ForEach(Array(Self.pages.enumerated()), id: \.offset) { n, page in
                    copy(page).opacity(n == index ? 1 : 0).accessibilityHidden(n != index)
                }
            }
            .padding(.horizontal, Welcome.textInset).padding(.top, Space.xxl)
            dots.padding(.top, Space.xxl).padding(.bottom, Space.xl)
            HStack(spacing: Space.ml) {
                if index == 0 {
                    Button { finish() } label: { Text("Skip").frame(maxWidth: .infinity) }.pillButton(insets: Pill.largeInsets)
                } else {
                    Button { move(-1) } label: { Text("Back").frame(maxWidth: .infinity) }.pillButton(insets: Pill.largeInsets)
                }
                Button { if last { finish() } else { move(1) } } label: { Text(last ? String(localized: "Get Started") : String(localized: "Continue")).frame(maxWidth: .infinity) }
                    .glassPillButton(insets: Pill.largeInsets).keyboardShortcut(.defaultAction)
            }
            .padding([.horizontal, .bottom], Welcome.gutter)
        }
        .frame(width: Welcome.width)
        .focusable().focusEffectDisabled().focused($focused)
        .onAppear { focused = true }
        .onKeyPress(.rightArrow) { move(1); return .handled }
        .onKeyPress(.leftArrow) { move(-1); return .handled }
        .onExitCommand { finish() }
    }
    private func move(_ step: Int) {
        let next = min(max(index + step, 0), Self.pages.count - 1)
        withAnimation(Motion.reduced(Motion.page, reduceMotion)) { index = next }
    }
    private func finish() {
        store.markWelcomed()
        dismiss()
    }
    private var art: some View {
        let shape = RoundedRectangle(cornerRadius: Welcome.artRadius)
        return ZStack {
            // Accent tint fading into the sheet background, matching the web board.
            LinearGradient(colors: [Welcome.tintTop, Welcome.tintBottom], startPoint: .top, endPoint: .bottom)
            Self.pages[index].art
                .id(index)
                .transition(.opacity.combined(with: .offset(y: Space.l)))
        }
        .frame(height: Welcome.artHeight).frame(maxWidth: .infinity)
        .clipShape(shape)
        .allowsHitTesting(false).accessibilityHidden(true)
        .padding([.horizontal, .top], Welcome.gutter)
    }
    private func copy(_ page: WelcomePage) -> some View {
        VStack(spacing: Space.ml) {
            Text(page.title).font(Typeface.title).accessibilityAddTraits(.isHeader)
            page.body
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var dots: some View {
        HStack(spacing: Space.ml) {
            ForEach(Array(Self.pages.enumerated()), id: \.offset) { n, page in
                Button { move(n - index) } label: {
                    Circle().fill(n == index ? Palette.accent : Welcome.dotOff)
                        .frame(width: Welcome.dot, height: Welcome.dot)
                        .padding(Space.xs).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "\(page.title), page \(n + 1) of \(Self.pages.count)"))
                .accessibilityAddTraits(n == index ? .isSelected : [])
            }
        }
    }
}

private enum WelcomePage: CaseIterable {
    case welcome, commands, needs, setup
    var title: String {
        switch self {
        case .welcome: String(localized: "Welcome to Crew")
        case .commands: String(localized: "Start in Claude Code")
        case .needs: String(localized: "Answer from here")
        case .setup: String(localized: "Finish setting up")
        }
    }
    @ViewBuilder var body: some View {
        switch self {
        case .welcome:
            paragraph(String(localized: "Crew runs several coding agents together. Claude leads, splits the work, and hands pieces to the other agents to run in parallel. This app shows every agent live and lets you answer them."))
        case .commands:
            VStack(spacing: Space.l) {
                paragraph(String(localized: "Open a new Claude Code session and type a command."))
                Grid(alignment: .leading, horizontalSpacing: Welcome.commandGap, verticalSpacing: Space.s) {
                    ForEach(Self.commandList, id: \.0) { command, what in
                        GridRow {
                            Text(command).font(Typeface.code)
                            Text(what).font(Typeface.callout).foregroundStyle(.secondary)
                        }
                    }
                }
                .multilineTextAlignment(.leading)
            }
        case .needs:
            paragraph(String(localized: "Approvals and questions from agents appear in Needs You. Answer them here, or open a waiting Claude session in Claude. Close the window and Crew stays in the menu bar, still running jobs."))
        case .setup:
            paragraph(String(localized: "Overview lists what is still missing, such as `codex login` for Codex or running `agy` once for Antigravity. Choose which agent does what in Settings."))
        }
    }
    private static let commandList = [
        ("/crew:run", String(localized: "Plan, build, review, and fix with the crew")),
        ("/crew:review", String(localized: "Review a change")),
        ("/crew:debate", String(localized: "Talk through a hard decision")),
        ("/crew:board", String(localized: "Open the board in Claude")),
    ]
    private func paragraph(_ text: String) -> some View {
        Text(withCode(text)).font(Typeface.body).foregroundStyle(.secondary).lineSpacing(Welcome.lineSpacing).fixedSize(horizontal: false, vertical: true)
    }
    @ViewBuilder var art: some View {
        switch self {
        case .welcome: WelcomeArt()
        case .commands: CommandArt()
        case .needs: NeedsArt()
        case .setup: SetupArt()
        }
    }
}

/// The app icon above an agent card with all agents shown working at once; role assignments are user-configured,
/// so none is given a fixed role here.
private struct WelcomeArt: View {
    var body: some View {
        VStack(spacing: Space.s) {
            Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).scaledToFit()
                .frame(width: Welcome.appIcon, height: Welcome.appIcon)
                .shadow(color: Welcome.iconShadow, radius: Welcome.shadowRadius, y: Welcome.shadowOffset)
            // Three equal-width columns without outer padding so the card edges frame the outer columns just as the
            // dividers frame the center one.
            HStack(spacing: 0) {
                ForEach(Array(["claude", "codex", "antigravity"].enumerated()), id: \.offset) { n, agent in
                    VStack(spacing: Space.xxs) {
                        AgentMark(agent: agent, size: MarkSize.card)
                            .overlay(alignment: .bottomTrailing) {
                                // Working status dot ringed in the card's surface color, matching Overview's agent avatars.
                                Circle().fill(Palette.accent).padding(Welcome.dotRing).background(WorkspaceStyle.surface, in: Circle())
                                    .frame(width: Welcome.statusDot, height: Welcome.statusDot)
                                    .offset(x: Welcome.dotRing * 2, y: Welcome.dotRing * 2)
                            }
                            .padding(.bottom, Space.s)
                        Text(agentName(agent)).font(Typeface.subheadline)
                        Text("Working").font(Typeface.caption).foregroundStyle(.secondary)
                    }
                    .frame(width: Welcome.agentColumn)
                    .overlay(alignment: .leading) { if n > 0 { Rectangle().fill(WorkspaceStyle.hairline).frame(width: 1) } }
                }
            }
            .padding(.vertical, Space.l)
            .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.cardRadius))
            .shadow(color: Welcome.cardShadow, radius: Welcome.shadowRadius, y: Welcome.shadowOffset)
        }
    }
}

/// A Claude Code prompt with a command entered.
private struct CommandArt: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(spacing: Space.s) {
                AgentMark(agent: "claude", size: MarkSize.inline)
                Text("Claude Code")
            }.font(Typeface.chip).foregroundStyle(.secondary)
            HStack(spacing: Space.xxs) {
                Text("\(Text("/crew:run").foregroundStyle(Palette.accent).fontWeight(.medium)) Add a dark mode")
                Rectangle().fill(Palette.accent).frame(width: Welcome.caret.width, height: Welcome.caret.height)
            }.font(Typeface.body)
            HStack {
                Text("~/Projects/app").font(Typeface.caption).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "arrow.up").font(Symbol.control).foregroundStyle(Welcome.onAccent)
                    .frame(width: Welcome.sendButton, height: Welcome.sendButton)
                    .background(Palette.accent, in: Circle())
            }
        }
        .frame(width: Welcome.artCard)
        .card(padding: Space.xl)
        .shadow(color: Welcome.cardShadow, radius: Welcome.shadowRadius, y: Welcome.shadowOffset)
    }
}

/// A Needs You approval card layered over a waiting Claude session card.
private struct NeedsArt: View {
    var body: some View {
        ZStack(alignment: .top) {
            HStack(spacing: Space.ml) {
                StatusLabel(state: "waiting", title: String(localized: "Input"))
                who("claude", "Claude")
                Spacer()
            }
            .frame(width: Welcome.artCard - 2 * Space.xl)
            .card(padding: Space.xl)
            .scaleEffect(Welcome.behindScale, anchor: .top).opacity(Welcome.behindOpacity)
            VStack(alignment: .leading, spacing: Space.l) {
                VStack(alignment: .leading, spacing: Space.ml) {
                    HStack(spacing: Space.ml) {
                        StatusLabel(state: "waiting", title: String(localized: "Approval"))
                        who("codex", "Codex")
                        Spacer()
                        Text("2m").font(Typeface.chip).foregroundStyle(.secondary)
                    }
                    Text("Add a dark mode to the settings page").font(Typeface.callout).foregroundStyle(.secondary)
                }
                Text(withCode(String(localized: "Run `npm test`"))).font(Typeface.headline)
                HStack(spacing: Space.m) {
                    Spacer()
                    Button("Deny") {}.pillButton()
                    Button("Approve") {}.glassPillButton()
                }
            }
            .frame(width: Welcome.artCard - 2 * Space.xl)
            .card(padding: Space.xl)
            .shadow(color: Welcome.cardShadow, radius: Welcome.shadowRadius, y: Welcome.shadowOffset)
            // Positioned low enough that the waiting session's header shows above it.
            .padding(.top, Space.x6l)
        }
    }
    private func who(_ agent: String, _ name: String) -> some View {
        HStack(spacing: Space.s) {
            AgentMark(agent: agent, size: MarkSize.inline)
            Text(name)
        }.font(Typeface.chip).foregroundStyle(.secondary)
    }
}

/// Overview's setup checklist with one incomplete item.
private struct SetupArt: View {
    @Environment(\.colorScheme) private var scheme
    private static let items = [
        ("Crew plugin and `crew` command", "Installed", true),
        ("Claude Code", "2.1.326", true),
        ("Codex CLI and sign-in", "Run `codex login`", false),
        ("Antigravity CLI", "1.4.0", true),
    ]
    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            Label("Set up Crew", systemImage: "wrench.and.screwdriver").font(Typeface.headline)
            VStack(alignment: .leading, spacing: Space.m) {
                ForEach(Self.items, id: \.0) { label, detail, ok in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Image(systemName: ok ? "checkmark.circle" : "exclamationmark.circle")
                            .foregroundStyle(ok ? Color.secondary : Palette.warning.ink(scheme)).frame(width: Symbol.controlFrame)
                        Text(withCode(label))
                        Text(withCode(detail)).font(Typeface.caption).foregroundStyle(.secondary)
                    }.font(Typeface.callout)
                }
            }
            HStack { Spacer(); Button("Check Again") {}.pillButton() }
        }
        .frame(width: Welcome.artCard)
        .card(padding: Space.xl)
        .shadow(color: Welcome.cardShadow, radius: Welcome.shadowRadius, y: Welcome.shadowOffset)
    }
}
