import SwiftUI

// The app's design tokens. Views take sizes, spacing, colors and type from here rather than writing numbers;
// docs/design-tokens.md lists each token with where it is used.

/// The app's motion. Every animation takes one of these, so the same kind of change moves the same way everywhere,
/// and each passes through `reduced` so Reduce Motion turns it off.
enum Motion {
    /// A control or block changing its words or size: a button's label, a reveal opening.
    static let content = Animation.smooth(duration: 0.3)
    /// A card opening or closing, with the cards around it moving along.
    static let expand = Animation.smooth(duration: 0.38)
    /// Work arriving or leaving on its own: cards and rows come and go, and the ones around them move into place.
    static let reflow = Animation.smooth(duration: 0.42)
    /// The detail panel coming in or going out.
    static let panel = Animation.smooth(duration: 0.26, extraBounce: 0)
    /// A page replacing another.
    static let page = Animation.easeOut(duration: 0.22)
    /// A veil or overlay fading in or out.
    static let fade = Animation.easeOut(duration: 0.25)
    /// An opening card's contents: in after the card has started to open, out before it closes over them.
    static let enter = Animation.easeOut(duration: 0.28).delay(0.06)
    static let leave = Animation.easeIn(duration: 0.14)
    /// A control's words swapping while it resizes under `content`: the old leave, then the new arrive once they
    /// are gone, both finishing with the resize.
    static let swapOut = Animation.easeIn(duration: 0.12)
    static let swapIn = Animation.easeOut(duration: 0.24).delay(0.08)
    static func reduced(_ animation: Animation, _ reduce: Bool) -> Animation? { reduce ? nil : animation }
}

/// The spacing scale, in points. Layout spacing and padding use these steps; a component's own geometry
/// (a chip's insets, a control's glyph frame) is a named token below instead.
enum Space {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 6
    static let m: CGFloat = 8
    static let ml: CGFloat = 10
    static let l: CGFloat = 12
    static let xl: CGFloat = 16
    static let xxl: CGFloat = 20
    static let x3l: CGFloat = 24
    static let x4l: CGFloat = 28
    static let x5l: CGFloat = 32
    static let x6l: CGFloat = 40
}

enum WorkspaceStyle {
    // MARK: Surfaces
    // Dark mode follows Apple's own apps (Fitness, Health): a near-black canvas and #1C1C1E cards, set in sRGB so
    // they render as written; calibrated grays came out lighter on screen (0.16 drew as #363636).
    static let canvas = dynamic(light: NSColor(calibratedRed: 0.955, green: 0.955, blue: 0.965, alpha: 1),
                                dark: NSColor(srgbRed: 11 / 255, green: 11 / 255, blue: 12 / 255, alpha: 1))
    static let inverse = Color(nsColor: .windowBackgroundColor)
    static let surface = dynamic(light: .white, dark: NSColor(srgbRed: 28 / 255, green: 28 / 255, blue: 30 / 255, alpha: 1))
    /// Rows and insets inside a card.
    static let rowFill = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.04), dark: NSColor(calibratedWhite: 1, alpha: 0.06))
    static let hairline = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.08), dark: NSColor(calibratedWhite: 1, alpha: 0.08))
    static func dynamic(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }

    // MARK: Layout
    /// The page's side margin, and the room below its last card.
    static let pageMargin = Space.x6l
    static let pageTop = Space.l
    static let cardPadding = Space.xxl
    /// The space between neighboring cards, the same across as down.
    static let cardGap = Space.xl
    /// Between the blocks stacked inside a card or panel section.
    static let blockGap = Space.xl
    /// Between the sections of the detail panel.
    static let sectionGap = Space.x4l
    /// A banner's padding: a notice, not a card of its own.
    static let bannerPadding = Space.xl
    /// The detail panel's and sheets' side padding.
    static let panelPadding = Space.x3l
    /// The detail panel's width until the user drags it, and the range a drag keeps to. The page keeps at least
    /// `panelPageRoom` beside it, so a narrow window shrinks the panel's limit rather than hide the page.
    static let panelWidth: CGFloat = 420
    static let panelMinWidth: CGFloat = 360
    static let panelMaxWidth: CGFloat = 760
    static let panelPageRoom: CGFloat = 240
    /// The strip on the panel's leading edge that takes a resize drag.
    static let panelHandleWidth = Space.l
    /// The panel's width for `wanted` on a page `page` points wide.
    /// `contentMinWidth` leaves room for both the minimum panel and the page beside it.
    static func panelWidth(_ wanted: CGFloat, page: CGFloat) -> CGFloat {
        let fits = page - windowInset * 2
        let upper = max(panelMinWidth, min(panelMaxWidth, page - panelPageRoom - windowInset))
        return max(0, min(fits, min(upper, max(panelMinWidth, wanted))))
    }
    /// A row in a list: an icon, two lines and trailing status.
    static let rowInsets = EdgeInsets(top: Space.ml, leading: Space.l, bottom: Space.ml, trailing: Space.l)
    /// Between rows in a list.
    static let rowGap = Space.xs
    /// The gray inset that holds a section's contents.
    static let insetPadding = Space.l
    /// The column a row's leading icon or mark sits in, so titles line up.
    static let iconColumn: CGFloat = 20
    /// Titles outside a card sit this far in from the cards' edge: a card's rounded corner pulls its edge in,
    /// so text flush with it looks outdented.
    static let titleInset = Space.s
    /// The same correction inside a card, for text beside its gray rows and insets, whose smaller corners need less.
    static let rowTitleInset = Space.xs
    /// The toolbar's glass items sit this far in from the window's edges; floating panels keep the same margin.
    static let windowInset = Space.m

    /// The detail panel's shadow, cast down and away from the window edge it floats beside.
    static let panelShadowRadius: CGFloat = 26
    static let panelShadowOffset = CGSize(width: -8, height: 8)
    /// A fact's label column in the detail panel, and the gaps of its grid.
    static let factLabelWidth: CGFloat = 72
    static let factColumnGap = Space.xl
    static let factRowGap = Space.m
    /// The elapsed time at a row's end, wide enough that "<1m" and "59m" line up.
    static let elapsedColumn: CGFloat = 28
    /// The least room between a row's text and what follows it.
    static let rowSpacer = Space.m
    static let summaryBarHeight: CGFloat = 5
    static let usageBarHeight: CGFloat = 3
    /// Message editors grow with their text between these heights.
    static let editorHeight: ClosedRange<CGFloat> = 80...180
    static let answerHeight: ClosedRange<CGFloat> = 56...160
    /// A running turn's diff scrolls inside this height.
    static let liveDiffHeight: CGFloat = 360

    // MARK: Windows
    /// The page stops widening here and centers; below `contentMinWidth` the window stops narrowing.
    static let pageMaxWidth: CGFloat = 1280
    /// The minimum panel, its inset and the page room beside it.
    static let contentMinWidth: CGFloat = panelMinWidth + panelPageRoom + windowInset
    static let windowMinHeight: CGFloat = 560
    static let windowDefaultSize = CGSize(width: 1180, height: 780)
    static let sidebarWidth = (min: CGFloat(180), ideal: CGFloat(210), max: CGFloat(300))
    static let sheetWidth: CGFloat = 560
    static let settingsSize = CGSize(width: 720, height: 620)
    static let settingsMinSize = CGSize(width: 640, height: 570)

    // MARK: Radii
    static let cardRadius: CGFloat = 20
    /// Concentric with the window's corner across `windowInset`, and the same as the toolbar items' capsules.
    static let panelRadius: CGFloat = 18
    static let fieldRadius: CGFloat = 14
    /// Rows, insets and thumbnails inside a card.
    static let rowRadius: CGFloat = 12
}

/// Status and emphasis colors. Text, symbols and bars take the color itself; surfaces take one of its fills.
enum Palette {
    static let accent = Color.accentColor
    static let success = Color.green
    static let warning = Color.orange
    static let danger = Color.red
    /// GitHub's own merged purple, so a merged PR reads as it does there.
    static let merged = WorkspaceStyle.dynamic(light: NSColor(srgbRed: 0x82 / 255, green: 0x50 / 255, blue: 0xdf / 255, alpha: 1),
                                               dark: NSColor(srgbRed: 0xa3 / 255, green: 0x71 / 255, blue: 0xf7 / 255, alpha: 1))
    /// A row or card that needs attention, tinted with its status color.
    static func attention(_ color: Color) -> Color { color.opacity(0.07) }
    /// A chip's background.
    static func chip(_ color: Color) -> Color { color.opacity(0.12) }
    static let selection = accent.opacity(0.09)
    /// Outlines when the user asks for more contrast.
    static let contrastStroke = Color.primary.opacity(0.25)
    /// Deeper in dark mode, where a light-mode shadow vanishes into the canvas (as --shadow-pop does on the web board).
    static let panelShadow = WorkspaceStyle.dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.14), dark: NSColor(calibratedWhite: 0, alpha: 0.4))
}

extension Color {
    /// A status color as text: darkened in light mode and lightened in dark mode, so it reads on its own tint and on
    /// gray rows (about 3:1 on chips, 4.5:1 for red captions on rows in dark).
    func ink(_ scheme: ColorScheme) -> Color { scheme == .light ? mix(with: .black, by: 0.22) : mix(with: .white, by: 0.35) }
}

/// The type scale. Titles are SF Pro Rounded, headlines SF Pro Display, body text SF Pro Text, source text SF Mono.
enum Typeface {
    static let pageTitle = Font.system(size: 38, weight: .semibold, design: .rounded)
    static let pageTitleCapHeight = NSFont.systemFont(ofSize: 38, weight: .semibold).capHeight
    static let title = Font.system(size: 19, weight: .semibold, design: .rounded)
    static let cardTitle = Font.system(size: 17, weight: .semibold, design: .rounded)
    static let emptyTitle = Font.system(size: 18, weight: .regular, design: .rounded)
    static let number = Font.system(size: 40, weight: .regular, design: .rounded)
    static let section = display(21, .semibold)
    static let headline = display(16, .medium)
    static let subheadline = Font.system(size: 14, weight: .semibold)
    static let bodyStrong = Font.system(size: 14, weight: .medium)
    static let body = Font.system(size: 14)
    static let calloutStrong = Font.system(size: 13, weight: .medium)
    static let callout = Font.system(size: calloutSize)
    /// For layout that counts lines of `callout`.
    static let calloutSize: CGFloat = 13
    static let captionStrong = Font.system(size: 12, weight: .semibold)
    static let chip = Font.system(size: chipSize, weight: .medium)
    /// For layout that measures `chip` text.
    static let chipSize: CGFloat = 12
    static let caption = Font.system(size: captionSize)
    /// For layout that counts lines of caption type.
    static let captionSize: CGFloat = 12
    static let micro = Font.system(size: 11, weight: .semibold)
    static let code = Font.system(size: 13, design: .monospaced)
    static let codeSmall = Font.system(size: 12, design: .monospaced)

    /// The system picks the Text cut below 20 pt; headlines keep the Display cut at any size.
    private static func display(_ size: CGFloat, _ weight: NSFont.Weight) -> Font {
        let base = NSFont.systemFont(ofSize: size, weight: weight)
        var variation = base.fontDescriptor.object(forKey: .variation) as? [NSNumber: Any] ?? [:]
        // Without an explicit optical size the font uses its default, the Display cut.
        variation[NSNumber(value: 0x6F70737A)] = nil // 'opsz'
        return Font(NSFont(descriptor: base.fontDescriptor.addingAttributes([.variation: variation]), size: size) ?? base)
    }
}

/// SF Symbols that stand alone; a symbol inside a label takes the label's font instead.
enum Symbol {
    /// Inside a small filled shape, such as a passed step on the mission track.
    static let badge = Font.system(size: 9, weight: .bold)
    /// The glyph of a circular icon button.
    static let control = Font.system(size: 11, weight: .semibold)
    /// A debate point's stance, leading its line.
    static let stance = Font.system(size: 14, weight: .medium)
    /// A thumbnail placeholder.
    static let large = Font.system(size: 17, weight: .medium)
    /// An empty state's illustration.
    static let empty = Font.system(size: 30, weight: .light)
    /// Shifts a sideways chevron toward its point, where its frame leaves it looking off center.
    static let chevronNudge: CGFloat = 0.5
    /// A small dot before words, such as Unsaved changes.
    static let dot = Font.system(size: 6)
    /// A dot drawn as a shape that marks a row on its own, such as an update ready to install.
    static let indicator: CGFloat = 8
    /// The frame a control glyph sits in, so icon buttons match whatever their symbol.
    static let controlFrame: CGFloat = 16
}

/// Agent marks, by where they appear.
enum MarkSize {
    /// Beside caption text, in a chip line.
    static let inline: CGFloat = 13
    /// A row's leading mark, in `WorkspaceStyle.iconColumn`.
    static let row: CGFloat = 16
    /// The compact agent list.
    static let list: CGFloat = 20
    /// Agent cards and settings.
    static let card: CGFloat = 22
}

/// A status chip: chip type in a tinted capsule.
enum Chip {
    static let insets = EdgeInsets(top: 5, leading: Space.m, bottom: 5, trailing: Space.m)
    /// A status chip, which leads with its symbol: the symbol's own side bearing already stands it off the edge, so
    /// the leading inset is two points less and the symbol looks as far in as the text does at the other end.
    static let symbolInsets = EdgeInsets(top: 5, leading: Space.s, bottom: 5, trailing: Space.m)
    /// A pull request's chip is a rounded square, so it does not read as one more status pill beside the mission's.
    static let squareRadius: CGFloat = 6
}

/// A pill button: a capsule a little taller than the system's regular bordered button, whose 5-point top and
/// bottom made its label look pressed flat against the edges.
enum Pill {
    static let insets = EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14)
    /// A sheet's footer pill that spans its half of the row, as tall as the web board's large buttons.
    static let largeInsets = EdgeInsets(top: 11, leading: 18, bottom: 11, trailing: 18)
    /// Taken off the leading inset when the label starts with a symbol: a symbol's round shape sits inside its
    /// frame, so an even inset looks wider on that side. Text-only pills stay symmetric.
    static let symbolTrim: CGFloat = 3
    /// Between a pill's symbol and its title.
    static let symbolGap = Space.s
    /// The plain pill's fill, close to the system bordered button's.
    static let fill = Color.primary.opacity(0.08)
}

/// The first-run welcome sheet, matching the web board's (`Onboarding.module.css`).
enum Welcome {
    static let width: CGFloat = 480
    /// One margin frames both the picture and the buttons.
    static let gutter = Space.ml
    static let artHeight: CGFloat = 232
    /// The system sheet's corner, which an app cannot set (`presentationCornerRadius` has no effect on a macOS sheet);
    /// measured from the macOS 27 sheet, about 18 points.
    static let sheetRadius: CGFloat = 18
    /// The picture's corner, concentric with the sheet's around the gutter.
    static let artRadius = sheetRadius - gutter
    /// The app icon's image, whose artwork fills about four fifths of it.
    static let appIcon: CGFloat = 88
    /// One agent's column in the first page's card.
    static let agentColumn: CGFloat = 116
    /// The width of the pictures that show a card, such as the command prompts.
    static let artCard: CGFloat = 340
    static let textInset = Space.x5l
    static let dot: CGFloat = 7
    static let dotOff = Color.primary.opacity(0.12)
    /// The pages' paragraphs, as loose as the board's 1.55 line height.
    static let lineSpacing: CGFloat = 3
    /// An agent's working dot with its ring in the card's color, and the ring's width.
    static let statusDot: CGFloat = 14
    static let dotRing: CGFloat = 2
    /// The command column on the second page.
    /// The picture's accent tint, fading toward the sheet.
    static let tintTop = Palette.accent.opacity(0.13)
    static let tintBottom = Palette.accent.opacity(0.03)
    /// The soft drop under the pictures' cards and the app icon.
    static let cardShadow = Color.black.opacity(0.06)
    static let iconShadow = Color.black.opacity(0.16)
    static let shadowRadius: CGFloat = 12
    static let shadowOffset: CGFloat = 8
    /// The waiting Claude session's card, set back behind the approval.
    static let behindScale: CGFloat = 0.92
    static let behindOpacity: CGFloat = 0.7
    /// The prompt's send button, a little smaller than an icon button so it sits inside the prompt card, and its arrow.
    static let sendButton: CGFloat = 26
    static let onAccent = Color.white
}

/// An icon button: a filled circle a little larger than a chip, where the system's regular circle read smaller
/// than the chip beside it and left a small target.
enum IconButton {
    static let diameter: CGFloat = 28
}

struct IconButtonStyle: ButtonStyle {
    /// Filled with the accent for the action a field leads to, such as sending.
    var prominent = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.pillSwap) private var swap
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Symbol.control).foregroundStyle(prominent ? Color.white : .primary)
            .frame(width: IconButton.diameter, height: IconButton.diameter)
            .background(prominent ? Palette.accent : Pill.fill, in: Circle())
            .overlay { if contrast == .increased { Circle().strokeBorder(Palette.contrastStroke) } }
            .overlay { if configuration.isPressed { Circle().fill(Color.primary.opacity(0.08)) } }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Circle())
    }
}

/// Shows or hides more of something already on screen. Pills run actions; this only reveals, so it reads as a
/// quiet link with a chevron, sits right under what it reveals, and takes a click on its words or the room around them.
struct RevealToggle: View {
    var show = String(localized: "Show all")
    var hide = String(localized: "Show less")
    /// What it reveals, for VoiceOver, where several "Show all" can sit in one view.
    var subject: String? = nil
    @Binding var shown: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Button { withAnimation(Motion.reduced(Motion.content, reduceMotion)) { shown.toggle() } } label: {
            HStack(spacing: Space.xs) {
                Text(shown ? hide : show)
                Image(systemName: "chevron.down").font(Symbol.badge).rotationEffect(.degrees(shown ? 180 : 0)).accessibilityHidden(true)
            }
            .font(Typeface.captionStrong).foregroundStyle(.secondary)
            .padding(.vertical, Space.xs).padding(.trailing, Space.l)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(subject.map { "\(shown ? hide : show): \($0)" } ?? (shown ? hide : show))
        .accessibilityValue(shown ? String(localized: "Expanded") : String(localized: "Collapsed"))
    }
}

/// A pill's symbol and title, with the optical trim on the symbol's side. Only the title sets the height, so a
/// symbol swap such as Copy's to a checkmark leaves the pill, and whatever is aligned beside it, still.
struct PillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Pill.symbolGap) { configuration.icon.frame(height: 0); configuration.title }.padding(.leading, -Pill.symbolTrim)
    }
}

/// A primary action in Liquid Glass, at the pill's size and face so it lines up with the pills around it.
struct GlassPillButtonStyle: ButtonStyle {
    var prominent = true
    var insets = Pill.insets
    @Environment(\.isEnabled) private var enabled
    @Environment(\.pillSwap) private var swap
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        PillWords(label: configuration.label)
            .font(Typeface.calloutStrong).foregroundStyle(prominent ? Color.white : .primary).lineLimit(1)
            .padding(insets).clipShape(Capsule())
            .glassEffect(prominent ? .regular.tint(Palette.accent).interactive() : .regular.interactive(), in: .capsule)
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
            // Here rather than on the button: an animation set outside does not reach the capsule the style draws.
            .animation(Motion.reduced(Motion.content, reduceMotion), value: swap)
    }
}

/// Draws pills with `Pill.insets`. A destructive role takes the danger color, and a pill that is switched on the accent.
struct PillButtonStyle: ButtonStyle {
    var insets = Pill.insets
    var selected = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.pillSwap) private var swap
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        let status: Color? = configuration.role == .destructive ? Palette.danger : selected ? Palette.accent : nil
        // As on chips: inked toward black in light mode and white in dark, so the tinted label stays readable on its tint.
        let text: Color = status.map { $0.ink(scheme) } ?? .primary
        let fill: Color = status.map(Palette.chip) ?? Pill.fill
        PillWords(label: configuration.label)
            .font(Typeface.calloutStrong).foregroundStyle(text).lineLimit(1)
            .padding(insets).clipShape(Capsule())
            .background(fill, in: Capsule())
            .overlay { if contrast == .increased { Capsule().strokeBorder(text.opacity(0.5)) } }
            .overlay { if configuration.isPressed { Capsule().fill(Color.primary.opacity(0.08)) } }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
            .animation(Motion.reduced(Motion.content, reduceMotion), value: swap)
    }
}

/// Marks a pill whose words follow `value`, such as Save turning into Saving…: its style resizes the capsule with
/// `Motion.content` while `PillWords` swaps the words.
private struct Morphs<Value: Hashable>: ViewModifier {
    let value: Value
    func body(content: Content) -> some View { content.environment(\.pillSwap, AnyHashable(value)) }
}

extension EnvironmentValues {
    /// The state a pill's words follow; set by `.morphs(on:)`.
    @Entry var pillSwap: AnyHashable? = nil
}

/// A pill's words. The capsule sizes to the current words through a hidden copy; the visible words sit over it at
/// their own size, so when `pillSwap` changes the old fade out and the new fade in, clipped to the capsule, rather
/// than squeezing or spilling while it resizes.
private struct PillWords<Label: View>: View {
    let label: Label
    @Environment(\.pillSwap) private var swap
    var body: some View {
        label.hidden().accessibilityHidden(true)
            .overlay {
                label.fixedSize().id(swap).transition(.wordSwap)
            }
    }
}

extension AnyTransition {
    /// Words come and go softly: faded, slightly shrunk and blurred. It carries its own timing, so text that changes
    /// on its own, such as a live status line, swaps the same way a pill's words do. Leading-aligned text shrinks
    /// toward its leading edge, so it does not drift sideways.
    static var wordSwap: AnyTransition { wordSwap(anchor: .center) }
    static func wordSwap(anchor: UnitPoint) -> AnyTransition {
        let swapping = AnyTransition.modifier(active: Swapping(shown: false, anchor: anchor), identity: Swapping(shown: true, anchor: anchor))
        return .asymmetric(insertion: swapping.animation(Motion.swapIn), removal: swapping.animation(Motion.swapOut))
    }
}

extension AnyTransition {
    /// A card or row arriving or leaving on its own, as work comes and goes: it settles in from slightly smaller
    /// out of a soft blur, and leaves the same way, while `Motion.reflow` moves its neighbors into place.
    static var card: AnyTransition {
        .modifier(active: Arriving(shown: false), identity: Arriving(shown: true))
    }
}

private struct Arriving: ViewModifier {
    let shown: Bool
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).scaleEffect(shown ? 1 : 0.96).blur(radius: shown ? 0 : 4)
    }
}

private struct Swapping: ViewModifier {
    let shown: Bool
    let anchor: UnitPoint
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).scaleEffect(shown ? 1 : 0.9, anchor: anchor).blur(radius: shown ? 0 : 2)
    }
}

extension View {
    /// See `Morphs`: for a control whose words change with state it does not set itself.
    func morphs<Value: Hashable>(on value: Value) -> some View { modifier(Morphs(value: value)) }
    /// The gray inset that holds a section's or card's contents.
    func inset() -> some View {
        padding(WorkspaceStyle.insetPadding).frame(maxWidth: .infinity, alignment: .leading)
            .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
    }
    /// A secondary action as a pill, so pills read the same wherever they sit.
    /// `selected` marks a pill that toggles something on.
    func pillButton(insets: EdgeInsets = Pill.insets, selected: Bool = false) -> some View {
        buttonStyle(PillButtonStyle(insets: insets, selected: selected)).labelStyle(PillLabelStyle())
    }
    /// A primary action in glass at the pill's size; `prominent` tints it with the accent.
    func glassPillButton(prominent: Bool = true, insets: EdgeInsets = Pill.insets) -> some View {
        buttonStyle(GlassPillButtonStyle(prominent: prominent, insets: insets)).labelStyle(PillLabelStyle())
    }
    /// An icon-only circle at `IconButton.diameter`; its symbol takes `Symbol.control`.
    func iconButton(prominent: Bool = false) -> some View { labelStyle(.iconOnly).buttonStyle(IconButtonStyle(prominent: prominent)) }
}
