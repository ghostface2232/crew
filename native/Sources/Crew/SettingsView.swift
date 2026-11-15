import SwiftUI

struct CrewSettingsView: View {
    /// The tab control's width with two or three tabs, and the scope picker's.
    private static let tabsWidth = (two: CGFloat(210), three: CGFloat(300))
    private static let scopeWidth: CGFloat = 250
    @Bindable var model: SettingsModel
    var store: CrewStore
    @State private var tab = "roles"
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The window has no title bar of its own: the heading sits on the canvas under the window controls.
            HStack(alignment: .center) {
                Text("Settings").font(Typeface.windowTitle).accessibilityAddTraits(.isHeader).padding(.leading, WorkspaceStyle.titleInset)
                Spacer()
                Picker("Settings section", selection: $tab) {
                    Text("Roles").tag("roles")
                    Text("Instructions").tag("instructions")
                    if model.presets != nil { Text("Presets").tag("presets") }
                }.pickerStyle(.segmented).labelsHidden().frame(width: model.presets == nil ? Self.tabsWidth.two : Self.tabsWidth.three)
            }.padding(.horizontal, Space.x4l).padding(.top, 46).padding(.bottom, Space.xxl) // The top clears the window's transparent title bar.
            Group {
                if tab == "roles" { roles } else if tab == "presets" { presets } else { instructions }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: Space.l) {
                if model.loading && tab == "instructions" { ProgressView().controlSize(.small) }
                Text(tab == "roles" ? model.roleStatus : tab == "presets" ? model.presetStatus : model.textStatus).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
                if tab == "roles" ? model.roleSettings != model.savedRoleSettings : tab == "presets" ? model.preset != model.savedPreset : model.text != model.savedText {
                    Label("Unsaved changes", systemImage: "circle.fill").font(Typeface.calloutStrong).foregroundStyle(Palette.warning)
                        .labelStyle(UnsavedLabelStyle())
                }
                Spacer()
                if tab == "instructions" && !model.loaded && !model.loading {
                    Button("Retry Loading") { Task { await model.load(scope: model.scope) } }.pillButton()
                }
                Button(tab == "roles" ? (model.savingRoles ? "Saving…" : "Save Roles") : tab == "presets" ? (model.savingPreset ? "Saving…" : "Save Preset") : (model.savingText ? "Saving…" : "Save Instructions")) {
                    Task { if tab == "roles" { await model.saveRoles() } else if tab == "presets" { await model.savePreset() } else { await model.saveInstructions() } }
                }
                .glassPillButton().morphs(on: [model.savingRoles, model.savingPreset, model.savingText]).keyboardShortcut("s")
                .disabled(!store.connected || (tab == "roles" ? model.savingRoles : tab == "presets" ? model.savingPreset : !model.loaded || model.savingText))
            }.padding(.horizontal, Space.x4l).padding(.vertical, Space.xxl)
        }
        .ignoresSafeArea(.container, edges: .top)
        .background(WorkspaceStyle.canvas.ignoresSafeArea())
        .frame(minWidth: WorkspaceStyle.settingsMinSize.width, idealWidth: WorkspaceStyle.settingsSize.width, minHeight: WorkspaceStyle.settingsMinSize.height, idealHeight: WorkspaceStyle.settingsSize.height)
        .task { if !model.loaded && !model.loading { await model.load(scope: model.scope) } }
    }
    private var roles: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.x3l) {
                ForEach(["Build", "Review", "Edit"], id: \.self) { group in
                    VStack(alignment: .leading, spacing: Space.l) {
                        Text(group).font(Typeface.section).padding(.leading, WorkspaceStyle.titleInset)
                        ForEach(model.roleInfo.filter { $0.group == group }) { role in
                            roleRow(role)
                        }
                    }
                }
            }.padding(.horizontal, Space.x4l).padding(.bottom, Space.m)
        }
    }
    private func roleRow(_ role: RoleInfo) -> some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            HStack(spacing: Space.ml) {
                AgentMark(agent: model.assignment(for: role.role)?.agent ?? "codex", size: MarkSize.card)
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(role.label).font(Typeface.cardTitle)
                    Text(role.summary).font(Typeface.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Space.m)
                Picker("Agent for \(role.label)", selection: roleBinding(role, \.agent)) {
                    if let parent = role.parent {
                        Text("Same as \(model.roleInfo.first { $0.role == parent }?.label ?? parent)").tag("")
                    }
                    ForEach(store.state.agents.keys.sorted(), id: \.self) { id in
                        Text("\(agentName(id))\(store.state.agents[id]?.enabled == false ? " (disabled)" : "")").tag(id)
                    }
                }.labelsHidden().fixedSize().frame(minWidth: WorkspaceStyle.pickerWidth, alignment: .trailing)
            }
            HStack(spacing: Space.xxl) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Model").font(Typeface.captionStrong).foregroundStyle(.secondary)
                    TextField(inheritedValue(role, \.model), text: roleBinding(role, \.model)).accessibilityLabel("\(role.label) model")
                }
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Reasoning effort").font(Typeface.captionStrong).foregroundStyle(.secondary)
                    TextField(inheritedValue(role, \.effort), text: roleBinding(role, \.effort)).accessibilityLabel("\(role.label) reasoning effort")
                }
            }.textFieldStyle(.roundedBorder)
        }.card()
    }
    private var presets: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            VStack(alignment: .leading, spacing: Space.xl) {
                HStack(spacing: Space.ml) {
                    Image(systemName: "slider.horizontal.3").font(Symbol.large).foregroundStyle(.tint).frame(width: MarkSize.card)
                    Text("Model preset").font(Typeface.cardTitle)
                    Spacer()
                    Picker("Model preset", selection: $model.preset) {
                        Text("None").tag(nil as PresetName?)
                        ForEach(PresetName.allCases, id: \.self) { name in
                            Text(name.rawValue.capitalized).tag(Optional(name))
                        }
                    }.labelsHidden().frame(width: WorkspaceStyle.pickerWidth)
                }
                Text(model.preset.flatMap { model.presets?[$0.rawValue]?.description } ?? "Uses each agent's configured model and effort.")
                    .font(Typeface.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("A model or effort set on a role overrides the preset.").font(Typeface.caption).foregroundStyle(.tertiary)
                Text("A mission can use its own preset. The lead passes the preset you name for a command, overriding this global preset for that mission's new jobs.")
                    .font(Typeface.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.card()
            Spacer()
        }.padding(.horizontal, Space.x4l)
    }
    private var instructions: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            HStack {
                Text("Shared instructions").font(Typeface.cardTitle)
                Spacer()
                Picker("Applies to", selection: Binding(get: { model.scope }, set: changeScope)) {
                    Text("Every project").tag("")
                    ForEach(store.projects, id: \.self) { Text(projectName($0, among: store.projects)).tag($0) }
                }.frame(maxWidth: Self.scopeWidth).disabled(model.savingText)
            }
            Text("Given to every agent with its next job and to Claude sessions when they start.")
                .font(Typeface.callout).foregroundStyle(.secondary)
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden).padding(Space.xl)
                .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius))
                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(WorkspaceStyle.hairline))
                .accessibilityLabel("Shared instructions").disabled(!model.loaded)
            Text(model.file).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
            if model.text.count > 9000 { Label("Claude sessions will be pointed to this file because it is longer than 9,000 characters.", systemImage: "info.circle").font(Typeface.callout).foregroundStyle(.secondary) }
        }.padding(.horizontal, Space.x4l)
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
        }, set: { value in
            var setting = model.roleSettings[role.role] ?? RoleSetting()
            setting[keyPath: key] = value.isEmpty ? nil : value
            model.roleSettings[role.role] = setting
        })
    }
    private func inheritedValue(_ role: RoleInfo, _ key: KeyPath<RoleAssignment, String?>) -> String {
        guard model.roleSettings[role.role]?.agent == nil, let parent = role.parent else { return "Agent default" }
        return model.assignment(for: parent)?[keyPath: key] ?? "Agent default"
    }
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
