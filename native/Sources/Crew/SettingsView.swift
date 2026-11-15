import SwiftUI

/// One page of the settings window, listed in the sidebar: the roles by kind of work, then what every agent shares.
enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
    case build, review, edit, presets, instructions
    var id: String { rawValue }
    static let roles: [SettingsPane] = [.build, .review, .edit]
    static let shared: [SettingsPane] = [.presets, .instructions]
    /// The role group (`RoleInfo.group`) a roles page shows; nil for the shared pages.
    var group: String? { switch self { case .build: "Build"; case .review: "Review"; case .edit: "Edit"; default: nil } }
    var title: String { group ?? (self == .presets ? "Presets" : "Instructions") }
    var systemImage: String {
        switch self {
        case .build: "hammer.fill"
        case .review: "checkmark.shield.fill"
        case .edit: "textformat"
        case .presets: "slider.horizontal.3"
        case .instructions: "doc.text.fill"
        }
    }
    var tint: Color {
        switch self {
        case .build: .blue
        case .review: .green
        case .edit: .orange
        case .presets: .gray
        case .instructions: .indigo
        }
    }
}

/// Laid out like System Settings: a sidebar of pages, and a grouped form whose page title sits in the unified
/// toolbar, where the system's soft scroll edge takes over from a hard cut.
struct CrewSettingsView: View {
    private static let sidebarWidth = (min: CGFloat(190), ideal: CGFloat(200), max: CGFloat(260))
    private static let editorHeight: CGFloat = 260
    @Bindable var model: SettingsModel
    var store: CrewStore
    @State private var selection: SettingsPane? = .build
    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                SettingsAppRow().selectionDisabled()
                Section("Roles") { ForEach(SettingsPane.roles) { paneRow($0) } }
                Section("Shared") { ForEach(SettingsPane.shared.filter { $0 != .presets || model.presets != nil }) { paneRow($0) } }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: Self.sidebarWidth.min, ideal: Self.sidebarWidth.ideal, max: Self.sidebarWidth.max)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            let pane = selection ?? .build
            Form { content(pane) }
                .formStyle(.grouped)
                .scrollEdgeEffectStyle(.soft, for: .top)
                .safeAreaBar(edge: .bottom) { saveBar(pane) }
                .navigationTitle(pane.title)
                // NSHostingController does not carry navigationTitle into the window, so the toolbar would be blank.
                .background(WindowTitleSetter(title: pane.title))
        }
        .frame(minWidth: WorkspaceStyle.settingsMinSize.width, idealWidth: WorkspaceStyle.settingsSize.width, minHeight: WorkspaceStyle.settingsMinSize.height, idealHeight: WorkspaceStyle.settingsSize.height)
        .task { if !model.loaded && !model.loading { await model.load(scope: model.scope) } }
    }
    private func paneRow(_ pane: SettingsPane) -> some View {
        Label { Text(pane.title) } icon: { SettingsPaneIcon(pane: pane) }.tag(pane)
    }
    @ViewBuilder private func content(_ pane: SettingsPane) -> some View {
        if let group = pane.group {
            ForEach(model.roleInfo.filter { $0.group == group }) { roleSection($0) }
        } else if pane == .presets {
            presets
        } else {
            instructions
        }
    }
    private func roleSection(_ role: RoleInfo) -> some View {
        Section {
            Picker("Agent", selection: roleBinding(role, \.agent)) {
                if let parent = role.parent {
                    Text("Same as \(model.roleInfo.first { $0.role == parent }?.label ?? parent)").tag("")
                }
                ForEach(store.state.agents.keys.sorted(), id: \.self) { id in
                    Text("\(agentName(id))\(store.state.agents[id]?.enabled == false ? " (disabled)" : "")").tag(id)
                }
            }.accessibilityLabel("Agent for \(role.label)")
            TextField("Model", text: roleBinding(role, \.model), prompt: Text(inheritedValue(role, \.model)))
                .accessibilityLabel("\(role.label) model")
            TextField("Reasoning effort", text: roleBinding(role, \.effort), prompt: Text(inheritedValue(role, \.effort)))
                .accessibilityLabel("\(role.label) reasoning effort")
        } header: {
            HStack(spacing: Space.ml) {
                AgentMark(agent: model.assignment(for: role.role)?.agent ?? "codex", size: MarkSize.card)
                VStack(alignment: .leading, spacing: 2) {
                    Text(role.label).font(.headline).foregroundStyle(.primary)
                    Text(role.summary).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.textCase(nil)
        }
    }
    @ViewBuilder private var presets: some View {
        Section {
            Picker("Global preset", selection: $model.preset) {
                Text("None").tag(nil as PresetName?)
                ForEach(PresetName.allCases, id: \.self) { name in
                    Text(name.rawValue.capitalized).tag(Optional(name))
                }
            }
        } footer: {
            Text(model.preset.flatMap { model.presets?[$0.rawValue]?.description } ?? "Uses each agent's configured model and effort.")
                .settingsFootnote()
        }
        Section {
            LabeledContent("A role's own model or effort", value: "Wins over any preset")
            LabeledContent("A mission's preset", value: "Replaces this one for its new jobs")
        } footer: {
            Text("The lead gives a mission the preset you name for a command; you can also change it from the mission.").settingsFootnote()
        }
    }
    @ViewBuilder private var instructions: some View {
        Section {
            Picker("Applies to", selection: Binding(get: { model.scope }, set: changeScope)) {
                Text("Every project").tag("")
                ForEach(store.projects, id: \.self) { Text(projectName($0, among: store.projects)).tag($0) }
            }.disabled(model.savingText)
        } footer: {
            Text("Given to every agent with its next job and to Claude sessions when they start.").settingsFootnote()
        }
        Section {
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden)
                .frame(minHeight: Self.editorHeight)
                .accessibilityLabel("Shared instructions").disabled(!model.loaded)
        } footer: {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(model.file).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
                if model.text.count > 9000 {
                    Label("Claude sessions will be pointed to this file because it is longer than 9,000 characters.", systemImage: "info.circle").settingsFootnote()
                }
            }
        }
    }
    /// The page's status and its save button. The three roles pages edit one table, so they share one save.
    private func saveBar(_ pane: SettingsPane) -> some View {
        let roles = pane.group != nil
        let status = roles ? model.roleStatus : pane == .presets ? model.presetStatus : model.textStatus
        let unsaved = roles ? model.roleSettings != model.savedRoleSettings : pane == .presets ? model.preset != model.savedPreset : model.text != model.savedText
        let saving = roles ? model.savingRoles : pane == .presets ? model.savingPreset : model.savingText
        return HStack(spacing: Space.l) {
            if model.loading && pane == .instructions { ProgressView().controlSize(.small) }
            Text(status).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
            if unsaved {
                Label("Unsaved changes", systemImage: "circle.fill").font(Typeface.calloutStrong).foregroundStyle(Palette.warning)
                    .labelStyle(UnsavedLabelStyle())
            }
            Spacer()
            if pane == .instructions && !model.loaded && !model.loading {
                Button("Retry Loading") { Task { await model.load(scope: model.scope) } }.pillButton()
            }
            Button(saving ? "Saving…" : roles ? "Save Roles" : pane == .presets ? "Save Preset" : "Save Instructions") {
                Task { if roles { await model.saveRoles() } else if pane == .presets { await model.savePreset() } else { await model.saveInstructions() } }
            }
            .glassPillButton().morphs(on: [model.savingRoles, model.savingPreset, model.savingText]).keyboardShortcut("s")
            .disabled(!store.connected || saving || (pane == .instructions && !model.loaded))
        }.padding(.horizontal, Space.x3l).padding(.vertical, Space.xl)
    }
    private func changeScope(_ scope: String) {
        guard scope != model.scope else { return }
        if model.text != model.savedText && !confirmDiscard("Discard unsaved instructions?") { return }
        Task { await model.load(scope: scope) }
    }
    private func roleBinding(_ role: RoleInfo, _ key: WritableKeyPath<RoleSetting, String?>) -> Binding<String> {
        Binding(get: {
            model.roleSettings[role.role]?[keyPath: key]
                ?? (key == \.agent && role.parent == nil ? model.assignment(for: role.role)?.agent : nil) ?? ""
        }, set: { model.setRole(role.role, key, to: $0) })
    }
    private func inheritedValue(_ role: RoleInfo, _ key: KeyPath<RoleAssignment, String?>) -> String {
        guard model.roleSettings[role.role]?.agent == nil, let parent = role.parent else { return "Agent default" }
        return model.assignment(for: parent)?[keyPath: key] ?? "Agent default"
    }
}

/// The colored rounded-square icon System Settings puts beside each page.
private struct SettingsPaneIcon: View {
    let pane: SettingsPane
    var size: CGFloat = 20
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        shape.fill(pane.tint.gradient).frame(width: size, height: size)
            .overlay { Image(systemName: pane.systemImage).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white) }
            // A light rim keeps a blue tile apart from the blue selection behind it.
            .overlay { shape.strokeBorder(.white.opacity(0.25), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.2), radius: 0.75, y: 0.5)
            .accessibilityHidden(true)
    }
}

/// The app's icon and name at the top of the sidebar, where System Settings shows the account.
private struct SettingsAppRow: View {
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    var body: some View {
        HStack(spacing: Space.ml) {
            Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).scaledToFit()
                .frame(width: 36, height: 36).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text("Crew").font(.body.weight(.semibold))
                if let version { Text("v\(version)").font(.subheadline).foregroundStyle(.secondary) }
            }
        }.padding(.vertical, Space.xs)
    }
}

/// Sets the hosting window's title, which the unified toolbar shows.
private struct WindowTitleSetter: NSViewRepresentable {
    let title: String
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ nsView: NSView, context: Context) {
        let title = title
        // The view has no window until it is in the hierarchy.
        DispatchQueue.main.async { nsView.window?.title = title }
    }
}

private extension View {
    func settingsFootnote() -> some View { font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
}

/// A small dot before the words, sized to the text.
private struct UnsavedLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: Space.s) { configuration.icon.font(Symbol.dot); configuration.title }
    }
}

@MainActor func confirmDiscard(_ title: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = "Your changes have not been saved."
    alert.addButton(withTitle: "Keep Editing")
    alert.addButton(withTitle: "Discard Changes")
    return alert.runModal() == .alertSecondButtonReturn
}
