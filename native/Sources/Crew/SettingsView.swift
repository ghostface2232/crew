import SwiftUI

struct CrewSettingsView: View {
    @Bindable var model: SettingsModel
    var store: CrewStore
    @State private var tab = "roles"
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The window has no title bar of its own: the heading sits on the canvas under the window controls.
            HStack(alignment: .center) {
                Text("Settings").font(Typeface.windowTitle).accessibilityAddTraits(.isHeader)
                Spacer()
                Picker("Settings section", selection: $tab) {
                    Text("Roles").tag("roles")
                    Text("Instructions").tag("instructions")
                    if model.presets != nil { Text("Presets").tag("presets") }
                }.pickerStyle(.segmented).labelsHidden().frame(width: model.presets == nil ? 210 : 300)
            }.padding(.horizontal, 28).padding(.top, 46).padding(.bottom, 22)
            Group {
                if tab == "roles" { roles } else if tab == "presets" { presets } else { instructions }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 12) {
                if model.loading && tab == "instructions" { ProgressView().controlSize(.small) }
                Text(tab == "roles" ? model.roleStatus : tab == "presets" ? model.presetStatus : model.textStatus).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
                if tab == "roles" ? model.roles != model.savedRoles : tab == "presets" ? model.preset != model.savedPreset : model.text != model.savedText {
                    Label("Unsaved changes", systemImage: "circle.fill").font(Typeface.calloutStrong).foregroundStyle(.orange)
                        .labelStyle(UnsavedLabelStyle())
                }
                Spacer()
                if tab == "instructions" && !model.loaded && !model.loading {
                    Button("Retry Loading") { Task { await model.load(scope: model.scope) } }
                }
                Button(tab == "roles" ? (model.savingRoles ? "Saving…" : "Save Roles") : tab == "presets" ? (model.savingPreset ? "Saving…" : "Save Preset") : (model.savingText ? "Saving…" : "Save Instructions")) {
                    Task { if tab == "roles" { await model.saveRoles() } else if tab == "presets" { await model.savePreset() } else { await model.saveInstructions() } }
                }
                .buttonStyle(.glassProminent).controlSize(.large).keyboardShortcut("s")
                .disabled(!store.connected || (tab == "roles" ? model.savingRoles : tab == "presets" ? model.savingPreset : !model.loaded || model.savingText))
            }.padding(.horizontal, 28).padding(.vertical, 18)
        }
        .ignoresSafeArea(.container, edges: .top)
        .background(WorkspaceStyle.canvas.ignoresSafeArea())
        .frame(minWidth: 640, idealWidth: 720, minHeight: 570, idealHeight: 620)
        .task { if !model.loaded && !model.loading { await model.load(scope: model.scope) } }
    }
    private var roles: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(roleOrder, id: \.self) { role in
                    VStack(alignment: .leading, spacing: 16) {
                        HStack(spacing: 10) {
                            AgentMark(agent: model.roles[role]?.agent ?? "codex", size: 23)
                            Text(roleNames[role]!).font(Typeface.cardTitle)
                            Spacer()
                            Picker("Agent for \(roleNames[role]!)", selection: roleBinding(role, \.agent)) {
                                ForEach(store.state.agents.keys.sorted(), id: \.self) { id in
                                    Text("\(agentName(id))\(store.state.agents[id]?.enabled == false ? " (disabled)" : "")").tag(id)
                                }
                            }.labelsHidden().frame(width: 180)
                        }
                        HStack(spacing: 20) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Model").font(Typeface.captionStrong).foregroundStyle(.secondary)
                                TextField("Agent default", text: optionalRoleBinding(role, \.model)).accessibilityLabel("\(roleNames[role]!) model")
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Reasoning effort").font(Typeface.captionStrong).foregroundStyle(.secondary)
                                TextField("Agent default", text: optionalRoleBinding(role, \.effort)).accessibilityLabel("\(roleNames[role]!) reasoning effort")
                            }
                        }.textFieldStyle(.roundedBorder)
                    }.card()
                }
            }.padding(.horizontal, 28).padding(.bottom, 8)
        }
    }
    private var presets: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Image(systemName: "slider.horizontal.3").font(.system(size: 17, weight: .medium)).foregroundStyle(.tint).frame(width: 23)
                    Text("Model preset").font(Typeface.cardTitle)
                    Spacer()
                    Picker("Model preset", selection: $model.preset) {
                        Text("None").tag(nil as PresetName?)
                        ForEach(PresetName.allCases, id: \.self) { name in
                            Text(name.rawValue.capitalized).tag(Optional(name))
                        }
                    }.labelsHidden().frame(width: 180)
                }
                Text(model.preset.flatMap { model.presets?[$0.rawValue]?.description } ?? "Uses each agent's configured model and effort.")
                    .font(Typeface.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("A model or effort set on a role overrides the preset.").font(Typeface.caption).foregroundStyle(.tertiary)
            }.card()
            Spacer()
        }.padding(.horizontal, 28)
    }
    private var instructions: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Shared instructions").font(Typeface.cardTitle)
                Spacer()
                Picker("Applies to", selection: Binding(get: { model.scope }, set: changeScope)) {
                    Text("Every project").tag("")
                    ForEach(store.projects, id: \.self) { Text(projectName($0, among: store.projects)).tag($0) }
                }.frame(maxWidth: 250).disabled(model.savingText)
            }
            Text("Given to every agent with its next job and to Claude sessions when they start.")
                .font(Typeface.callout).foregroundStyle(.secondary)
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden).padding(14)
                .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius))
                .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.fieldRadius).strokeBorder(WorkspaceStyle.hairline))
                .accessibilityLabel("Shared instructions").disabled(!model.loaded)
            Text(model.file).font(Typeface.codeSmall).foregroundStyle(.tertiary).textSelection(.enabled)
            if model.text.count > 9000 { Label("Claude sessions will be pointed to this file because it is longer than 9,000 characters.", systemImage: "info.circle").font(Typeface.callout).foregroundStyle(.secondary) }
        }.padding(.horizontal, 28)
    }
    private func changeScope(_ scope: String) {
        guard scope != model.scope else { return }
        if model.text != model.savedText && !confirmDiscard("Discard unsaved instructions?") { return }
        Task { await model.load(scope: scope) }
    }
    private func roleBinding(_ role: String, _ key: WritableKeyPath<RoleAssignment, String>) -> Binding<String> {
        Binding(get: { model.roles[role]?[keyPath: key] ?? "codex" }, set: { value in
            var assignment = model.roles[role] ?? RoleAssignment(agent: "codex")
            assignment[keyPath: key] = value; model.roles[role] = assignment
        })
    }
    private func optionalRoleBinding(_ role: String, _ key: WritableKeyPath<RoleAssignment, String?>) -> Binding<String> {
        Binding(get: { model.roles[role]?[keyPath: key] ?? "" }, set: { value in
            var assignment = model.roles[role] ?? RoleAssignment(agent: "codex")
            assignment[keyPath: key] = value.isEmpty ? nil : value; model.roles[role] = assignment
        })
    }
}

/// A small dot before the words, sized to the text.
private struct UnsavedLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) { configuration.icon.font(.system(size: 6)); configuration.title }
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
