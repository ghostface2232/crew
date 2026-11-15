import SwiftUI

/// One page of the settings window, listed in the sidebar: the roles by kind of work, what every agent shares,
/// then each project's own instructions.
enum SettingsPane: Hashable, Identifiable {
    case build, review, edit, presets, instructions
    case project(String)
    var id: Self { self }
    static let roles: [SettingsPane] = [.build, .review, .edit]
    static let shared: [SettingsPane] = [.presets, .instructions]
    /// The role group (`RoleInfo.group`) a roles page shows; nil for the other pages.
    var group: String? { switch self { case .build: "Build"; case .review: "Review"; case .edit: "Edit"; default: nil } }
    /// The instructions a page edits: "" for every project, a project's path for its own; nil for the other pages.
    var scope: String? { switch self { case .instructions: ""; case .project(let path): path; default: nil } }
    var systemImage: String {
        switch self {
        case .build: "hammer.fill"
        case .review: "checkmark.shield.fill"
        case .edit: "textformat"
        case .presets: "slider.horizontal.3"
        case .instructions: "doc.text.fill"
        case .project: "folder.fill"
        }
    }
    var tint: Color {
        switch self {
        case .build: .blue
        case .project: .teal
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
    /// Moving to another set of instructions loads it in place of the one being edited, so unsaved edits are asked about first.
    private var pages: Binding<SettingsPane?> {
        Binding(get: { selection }, set: { next in
            if let scope = next?.scope, scope != model.scope {
                // Text being saved is not unsaved; the next set loads once the save is done.
                if model.savingText { return }
                if model.text != model.savedText && !confirmDiscard("Discard unsaved instructions?") { return }
                Task { await model.load(scope: scope) }
            }
            selection = next
        })
    }
    var body: some View {
        NavigationSplitView {
            List(selection: pages) {
                SettingsAppRow().selectionDisabled()
                Section("Roles") { ForEach(SettingsPane.roles) { paneRow($0) } }
                Section("Shared") { ForEach(SettingsPane.shared.filter { $0 != .presets || model.presets != nil }) { paneRow($0) } }
                if !store.projects.isEmpty {
                    Section("Projects") { ForEach(store.projects.map(SettingsPane.project)) { paneRow($0) } }
                }
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
                .navigationTitle(title(pane))
                // NSHostingController does not carry navigationTitle into the window, so the toolbar would be blank.
                .background(WindowTitleSetter(title: title(pane)))
        }
        .frame(minWidth: WorkspaceStyle.settingsMinSize.width, idealWidth: WorkspaceStyle.settingsSize.width, minHeight: WorkspaceStyle.settingsMinSize.height, idealHeight: WorkspaceStyle.settingsSize.height)
        .task { if !model.loaded && !model.loading { await model.load(scope: model.scope) } }
    }
    private func title(_ pane: SettingsPane) -> String {
        switch pane {
        case .presets: "Presets"
        case .instructions: "Instructions"
        case .project(let path): projectName(path, among: store.projects)
        default: pane.group ?? ""
        }
    }
    private func paneRow(_ pane: SettingsPane) -> some View {
        Label {
            Text(title(pane))
        } icon: {
            SettingsPaneIcon(pane: pane)
        }.tag(pane)
    }
    @ViewBuilder private func content(_ pane: SettingsPane) -> some View {
        if let group = pane.group {
            ForEach(model.roleInfo.filter { $0.group == group }) { roleSection($0) }
            Section {} footer: {
                Text("The lead picks one of a role's holders for each job, using Codex before Antigravity when it names none. Claude means the lead does the work itself or in a subagent. Each agent's model and effort apply when it takes the role's work.").settingsFootnote()
            }
        } else if pane == .presets {
            presets
        } else {
            instructions(pane)
        }
    }
    private func roleSection(_ role: RoleInfo) -> some View {
        Section {
            if let parent = role.parent {
                Toggle("Same as \(model.roleInfo.first { $0.role == parent }?.label ?? parent)", isOn: Binding(
                    get: { model.followsParent(role.role) },
                    set: { model.setFollowParent(role.role, enabled: $0) }
                )).toggleStyle(.checkbox).accessibilityLabel("Follow parent for \(role.label)")
            }
            LabeledContent("Agents") {
                HStack(spacing: Space.l) {
                    ForEach(RoleAssignment.holderOrder, id: \.self) { holder in
                        Toggle(holderLabel(holder), isOn: Binding(
                            get: { model.assignment(for: role.role)?.holders.contains(holder) == true },
                            set: { model.setHolder(role.role, holder: holder, enabled: $0) }
                        )).toggleStyle(.checkbox).accessibilityLabel("\(agentName(holder)) for \(role.label)")
                            .disabled(model.assignment(for: role.role)?.holders == [holder])
                    }
                }.disabled(model.followsParent(role.role))
            }
            ForEach(model.assignment(for: role.role)?.workerHolders ?? [], id: \.self) { agent in
                TextField("\(agentName(agent)) model", text: roleBinding(role, agent: agent, \.model), prompt: Text(inheritedValue(role, agent: agent, \.model)))
                    .accessibilityLabel("\(role.label) \(agentName(agent)) model")
                if agent == "codex" {
                    TextField("Codex reasoning effort", text: roleBinding(role, agent: agent, \.effort), prompt: Text(inheritedValue(role, agent: agent, \.effort)))
                        .accessibilityLabel("\(role.label) Codex reasoning effort")
                }
            }
        } header: {
            HStack(spacing: Space.ml) {
                AgentMark(agent: model.assignment(for: role.role)?.holders.first ?? "codex", size: MarkSize.card)
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
    @ViewBuilder private func instructions(_ pane: SettingsPane) -> some View {
        Section {
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden)
                .frame(minHeight: Self.editorHeight)
                .accessibilityLabel("Shared instructions").disabled(!model.loaded || model.scope != pane.scope)
        } header: {
            Text(pane == .instructions ? "Given to every agent with its next job, in every project, and to Claude sessions when they start."
                 : "Given to every agent working in this project, after the instructions for every project.")
                .settingsFootnote().textCase(nil)
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
        let unsaved = roles ? model.rolesDirty : pane == .presets ? model.preset != model.savedPreset : model.text != model.savedText
        let saving = roles ? model.savingRoles : pane == .presets ? model.savingPreset : model.savingText
        return HStack(spacing: Space.l) {
            if model.loading && pane.scope != nil { ProgressView().controlSize(.small) }
            Text(status).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
            if unsaved {
                Label("Unsaved changes", systemImage: "circle.fill").font(Typeface.calloutStrong).foregroundStyle(Palette.warning)
                    .labelStyle(UnsavedLabelStyle())
            }
            Spacer()
            if pane.scope != nil && !model.loaded && !model.loading {
                Button("Retry Loading") { Task { await model.load(scope: model.scope) } }.pillButton()
            }
            Button(saving ? "Saving…" : roles ? "Save Roles" : pane == .presets ? "Save Preset" : "Save Instructions") {
                Task { if roles { await model.saveRoles() } else if pane == .presets { await model.savePreset() } else { await model.saveInstructions() } }
            }
            .glassPillButton().morphs(on: [model.savingRoles, model.savingPreset, model.savingText]).keyboardShortcut("s")
            .disabled(!store.connected || saving || (pane.scope != nil && !model.loaded))
        }.padding(.horizontal, Space.x3l).padding(.vertical, Space.xl)
    }
    private func holderLabel(_ holder: String) -> String {
        holder == "claude" ? "Claude (the lead)" : "\(agentName(holder))\(store.state.agents[holder]?.enabled == false ? " (disabled)" : "")"
    }
    private func roleBinding(_ role: RoleInfo, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>) -> Binding<String> {
        Binding(get: { model.roleSettings[role.role]?[agent]?[keyPath: key] ?? "" },
                set: { model.setRole(role.role, agent: agent, key, to: $0) })
    }
    private func inheritedValue(_ role: RoleInfo, agent: String, _ key: KeyPath<RoleAgentSettings, String?>) -> String {
        guard model.followsParent(role.role), let parent = role.parent, let assignment = model.assignment(for: parent) else { return "Agent default" }
        return RoleSetting(assignment)[agent]?[keyPath: key] ?? "Agent default"
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
