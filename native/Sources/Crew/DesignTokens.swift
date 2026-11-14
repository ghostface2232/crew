import SwiftUI

// The app's design tokens. Views take sizes, spacing, colors and type from here rather than writing numbers;
// docs/10-design-tokens.md lists each token with where it is used.

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
    // Dark mode keeps cards about 9% lighter than the canvas so they stay distinct without heavy borders.
    static let canvas = dynamic(light: NSColor(calibratedRed: 0.955, green: 0.955, blue: 0.965, alpha: 1),
                                dark: NSColor(calibratedRed: 0.07, green: 0.07, blue: 0.075, alpha: 1))
    static let inverse = Color(nsColor: .windowBackgroundColor)
    static let surface = dynamic(light: .white, dark: NSColor(calibratedWhite: 0.16, alpha: 1))
    /// Rows and insets inside a card.
    static let rowFill = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.04), dark: NSColor(calibratedWhite: 1, alpha: 0.06))
    static let hairline = dynamic(light: NSColor(calibratedWhite: 0, alpha: 0.08), dark: NSColor(calibratedWhite: 1, alpha: 0.08))
    private static func dynamic(light: NSColor, dark: NSColor) -> Color {
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
    static let panelWidth: CGFloat = 420
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
    /// A row or card that needs attention, tinted with its status color.
    static func attention(_ color: Color) -> Color { color.opacity(0.07) }
    /// A chip's background.
    static func chip(_ color: Color) -> Color { color.opacity(0.12) }
    static let selection = accent.opacity(0.09)
    /// Outlines when the user asks for more contrast.
    static let contrastStroke = Color.primary.opacity(0.25)
    static let panelShadow = Color.black.opacity(0.14)
}

/// The type scale. Titles are SF Pro Rounded, headlines SF Pro Display, body text SF Pro Text, source text SF Mono.
enum Typeface {
    static let pageTitle = Font.system(size: 38, weight: .semibold, design: .rounded)
    static let pageTitleCapHeight = NSFont.systemFont(ofSize: 38, weight: .semibold).capHeight
    static let windowTitle = Font.system(size: 30, weight: .semibold, design: .rounded)
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
    static let chip = Font.system(size: 12, weight: .medium)
    static let caption = Font.system(size: 12)
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
    /// A row's leading icon.
    static let row = Font.system(size: 14)
    /// A thumbnail placeholder or a settings section's icon.
    static let large = Font.system(size: 17, weight: .medium)
    /// An empty state's illustration.
    static let empty = Font.system(size: 30, weight: .light)
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
}

/// A pill button: a capsule a little taller than the system's regular bordered button, whose 5-point top and
/// bottom made its label look pressed flat against the edges.
enum Pill {
    static let insets = EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14)
    /// Taken off the leading inset when the label starts with a symbol: a symbol's round shape sits inside its
    /// frame, so an even inset looks wider on that side. Text-only pills stay symmetric.
    static let symbolTrim: CGFloat = 3
    /// Between a pill's symbol and its title.
    static let symbolGap = Space.s
    /// The plain pill's fill, close to the system bordered button's.
    static let fill = Color.primary.opacity(0.08)
    enum Kind { case plain, prominent, warning }
}

/// A pill's symbol and title, with the optical trim on the symbol's side.
struct PillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Pill.symbolGap) { configuration.icon; configuration.title }.padding(.leading, -Pill.symbolTrim)
    }
}

/// A primary action in Liquid Glass, at the pill's size and face so it lines up with the pills around it.
struct GlassPillButtonStyle: ButtonStyle {
    var prominent = true
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.calloutStrong).foregroundStyle(prominent ? Color.white : .primary).lineLimit(1)
            .padding(Pill.insets)
            .glassEffect(prominent ? .regular.tint(Palette.accent).interactive() : .regular.interactive(), in: .capsule)
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
    }
}

/// Draws pills with `Pill.insets`. A destructive role takes the danger color whatever the kind.
struct PillButtonStyle: ButtonStyle {
    var kind = Pill.Kind.plain
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    func makeBody(configuration: Configuration) -> some View {
        let status: Color? = configuration.role == .destructive ? Palette.danger : kind == .warning ? Palette.warning : nil
        // As on chips: darkened in light mode so the tinted label stays readable on its tint.
        let tinted = status.map { scheme == .light ? $0.mix(with: .black, by: 0.22) : $0 }
        let text: Color = kind == .prominent && status == nil ? .white : tinted ?? .primary
        let fill: Color = status.map(Palette.chip) ?? (kind == .prominent ? Palette.accent : Pill.fill)
        configuration.label
            .font(Typeface.calloutStrong).foregroundStyle(text).lineLimit(1)
            .padding(Pill.insets)
            .background(fill, in: Capsule())
            .overlay { if contrast == .increased { Capsule().strokeBorder(text.opacity(0.5)) } }
            .overlay { if configuration.isPressed { Capsule().fill(Color.primary.opacity(0.08)) } }
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
    }
}

extension View {
    /// The gray inset that holds a section's or card's contents.
    func inset() -> some View {
        padding(WorkspaceStyle.insetPadding).frame(maxWidth: .infinity, alignment: .leading)
            .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius))
    }
    /// A secondary action as a pill, so pills read the same wherever they sit. `.prominent` fills it for the one
    /// action a group leads with; `.warning` marks one that drops work without completing it.
    func pillButton(_ kind: Pill.Kind = .plain) -> some View { buttonStyle(PillButtonStyle(kind: kind)).labelStyle(PillLabelStyle()) }
    /// A primary action in glass at the pill's size; `prominent` tints it with the accent.
    func glassPillButton(prominent: Bool = true) -> some View { buttonStyle(GlassPillButtonStyle(prominent: prominent)).labelStyle(PillLabelStyle()) }
    func pillButton(prominent: Bool) -> some View { pillButton(prominent ? .prominent : .plain) }
    /// An icon-only bordered circle; its label's symbol takes `Symbol.control` in `Symbol.controlFrame`.
    func iconButton() -> some View {
        labelStyle(.iconOnly).font(Symbol.control).buttonStyle(.bordered).buttonBorderShape(.circle).controlSize(.regular)
    }
}
