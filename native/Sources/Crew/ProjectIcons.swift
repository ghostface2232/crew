import AppKit
import SwiftUI

/// The icons a project can wear in the sidebar, by group, in the order the picker shows them. A key is the SF Symbol's
/// name, stored as `projects[path].icon`; the board maps the same keys to its own icons, so the two lists change together.
enum ProjectIcons {
    struct Icon: Sendable, Identifiable {
        let key: String
        let name: LocalizedStringResource
        var id: String { key }
    }
    struct Group: Sendable, Identifiable {
        let title: LocalizedStringResource
        let icons: [Icon]
        var id: String { icons.first?.key ?? "" }
    }
    static let folder = "folder"
    static let groups: [Group] = [
        Group(title: "General", icons: [
            Icon(key: "folder", name: "Folder"), Icon(key: "star", name: "Star"), Icon(key: "heart", name: "Heart"),
            Icon(key: "bookmark", name: "Bookmark"), Icon(key: "flag", name: "Flag"), Icon(key: "tag", name: "Tag"),
            Icon(key: "archivebox", name: "Archive"), Icon(key: "briefcase", name: "Briefcase"), Icon(key: "house", name: "Home"),
            Icon(key: "lock", name: "Lock"),
        ]),
        Group(title: "Development", icons: [
            Icon(key: "apple.terminal", name: "Terminal"), Icon(key: "chevron.left.forwardslash.chevron.right", name: "Code"),
            Icon(key: "hammer", name: "Tools"), Icon(key: "gearshape", name: "Settings"), Icon(key: "cpu", name: "Chip"),
            Icon(key: "server.rack", name: "Server"), Icon(key: "ant", name: "Bug"), Icon(key: "puzzlepiece", name: "Extension"),
            Icon(key: "arrow.triangle.branch", name: "Branch"), Icon(key: "shield", name: "Security"),
        ]),
        Group(title: "Platforms", icons: [
            Icon(key: "globe", name: "Web"), Icon(key: "app", name: "App"), Icon(key: "iphone", name: "Phone"),
            Icon(key: "laptopcomputer", name: "Laptop"), Icon(key: "desktopcomputer", name: "Desktop"),
            Icon(key: "gamecontroller", name: "Game"), Icon(key: "cloud", name: "Cloud"), Icon(key: "shippingbox", name: "Package"),
            Icon(key: "cube", name: "3D"), Icon(key: "wifi", name: "Network"),
        ]),
        Group(title: "Data & AI", icons: [
            Icon(key: "brain", name: "AI"), Icon(key: "sparkles", name: "Sparkles"), Icon(key: "chart.bar", name: "Chart"),
            Icon(key: "chart.pie", name: "Pie Chart"), Icon(key: "cylinder.split.1x2", name: "Database"),
            Icon(key: "tablecells", name: "Table"), Icon(key: "function", name: "Math"), Icon(key: "magnifyingglass", name: "Search"),
            Icon(key: "lightbulb", name: "Idea"), Icon(key: "flask", name: "Lab"),
        ]),
        Group(title: "Content", icons: [
            Icon(key: "doc.text", name: "Document"), Icon(key: "book", name: "Book"), Icon(key: "pencil", name: "Writing"),
            Icon(key: "paintbrush", name: "Design"), Icon(key: "paintpalette", name: "Palette"), Icon(key: "photo", name: "Photo"),
            Icon(key: "camera", name: "Camera"), Icon(key: "video", name: "Video"), Icon(key: "music.note", name: "Music"),
            Icon(key: "mic", name: "Audio"),
        ]),
        Group(title: "Work", icons: [
            Icon(key: "cart", name: "Shop"), Icon(key: "creditcard", name: "Payments"), Icon(key: "building.2", name: "Company"),
            Icon(key: "person.2", name: "Team"), Icon(key: "envelope", name: "Mail"),
            Icon(key: "bubble.left.and.bubble.right", name: "Chat"), Icon(key: "calendar", name: "Calendar"),
            Icon(key: "graduationcap", name: "Learning"), Icon(key: "airplane", name: "Travel"), Icon(key: "leaf", name: "Nature"),
        ]),
    ]
    /// The keys this Mac can draw; another app's key, or one an older macOS lacks, falls back to the folder.
    private static let shown: Set<String> = Set(groups.flatMap(\.icons).map(\.key).filter {
        NSImage(systemSymbolName: $0, accessibilityDescription: nil) != nil
    })
    /// The table's key for a stored one.
    static func key(_ stored: String?) -> String { stored.flatMap { shown.contains($0) ? $0 : nil } ?? folder }
    /// The symbol to draw for a stored key.
    static func symbol(_ stored: String?) -> String {
        let key = key(stored)
        // The desktop's screen is solid even in monochrome; the bare display matches the other outlines.
        return key == "desktopcomputer" ? "display" : key
    }
    /// The filled cut for a white glyph on a colored tile, as in the Settings sidebar, where the symbol has one.
    static func filledSymbol(_ stored: String?) -> String {
        let key = key(stored), filled = key + ".fill"
        return NSImage(systemSymbolName: filled, accessibilityDescription: nil) != nil ? filled : key
    }
}

/// Chooses a project's icon, opened from its sidebar row. Each click is saved at once and the sidebar follows the
/// daemon's broadcast, so the picker stays open for another try, as Finder's does.
struct ProjectIconPicker: View {
    var store: CrewStore
    let path: String
    let name: String
    /// A grid of these, one row of `columns` per group.
    static let cell: CGFloat = 40
    static let columns = 10
    static let cellRadius: CGFloat = 8
    static let glyph = Font.system(size: 18)
    /// The current icon in the header.
    static let tile: CGFloat = 36
    static let tileGlyph = Font.system(size: 20)
    var body: some View {
        let current = ProjectIcons.key(store.state.projects?[path]?.icon)
        let key = CrewStore.projectIconKey(path)
        VStack(alignment: .leading, spacing: Space.xl) {
            HStack(spacing: Space.ml) {
                Image(systemName: ProjectIcons.symbol(current)).font(Self.tileGlyph).symbolVariant(.none).symbolRenderingMode(.monochrome)
                    .foregroundStyle(.secondary)
                    .frame(width: Self.tile, height: Self.tile)
                    .background(WorkspaceStyle.rowFill, in: RoundedRectangle(cornerRadius: WorkspaceStyle.rowRadius, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text(name).font(Typeface.bodyStrong).lineLimit(1)
                    Text((path as NSString).abbreviatingWithTildeInPath).font(Typeface.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            VStack(alignment: .leading, spacing: Space.xl) {
                ForEach(ProjectIcons.groups) { group in
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text(group.title).font(Typeface.caption).foregroundStyle(.secondary)
                            .padding(.leading, WorkspaceStyle.rowTitleInset)
                        HStack(spacing: 0) {
                            ForEach(group.icons) { icon in
                                IconCell(icon: icon, selected: icon.key == current) {
                                    Task { await store.setProjectIcon(path, icon.key == ProjectIcons.folder ? nil : icon.key) }
                                }
                            }
                        }
                    }
                    .accessibilityElement(children: .contain).accessibilityLabel(Text(group.title))
                }
            }
            .disabled(!store.connected)
            HStack(spacing: Space.l) {
                if let error = store.actions[key]?.error {
                    ErrorLabel(message: error).font(Typeface.caption).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button("Reset to Folder") { Task { await store.setProjectIcon(path, nil) } }
                    .pillButton().disabled(!store.connected || current == ProjectIcons.folder)
            }
        }
        // As wide as the grid, so a long path truncates and an error wraps rather than widen the popover.
        .frame(width: Self.cell * CGFloat(Self.columns), alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(WorkspaceStyle.cardPadding)
    }
}

private struct IconCell: View {
    let icon: ProjectIcons.Icon
    let selected: Bool
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            Image(systemName: ProjectIcons.symbol(icon.key)).font(ProjectIconPicker.glyph)
                // Outlined and in one color, as in the sidebar, so devices' screens do not read as solid.
                .symbolVariant(.none).symbolRenderingMode(.monochrome)
                .foregroundStyle(selected ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                .frame(width: ProjectIconPicker.cell, height: ProjectIconPicker.cell)
                .background {
                    let shape = RoundedRectangle(cornerRadius: ProjectIconPicker.cellRadius, style: .continuous)
                    if selected { shape.fill(Palette.accent) } else if hovering { shape.fill(Pill.fill) }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(Text(icon.name))
        .accessibilityLabel(Text(icon.name))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
