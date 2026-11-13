import SwiftUI

struct CrewSettingsView: View {
    @Bindable var model: SettingsModel
    var store: CrewStore
    @State private var tab = "roles"
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Make Crew yours.").font(.system(size: 28, weight: .semibold, design: .rounded))
                    Text("Your agents. Your way of working.").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("Settings section", selection: $tab) {
                    Text("Roles").tag("roles")
                    Text("Instructions").tag("instructions")
                }.pickerStyle(.segmented).labelsHidden().frame(width: 210)
            }.padding(26)
            Group {
                if tab == "roles" { roles } else { instructions }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 12) {
                if model.loading && tab == "instructions" { ProgressView().controlSize(.small) }
                Text(tab == "roles" ? model.roleStatus : model.textStatus).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                if tab == "roles" ? model.roles != model.savedRoles : model.text != model.savedText {
                    Text("Unsaved changes").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if tab == "instructions" && !model.loaded && !model.loading {
                    Button("Retry Loading") { Task { await model.load(scope: model.scope) } }
                }
                Button(tab == "roles" ? (model.savingRoles ? "Saving…" : "Save Roles") : (model.savingText ? "Saving…" : "Save Instructions")) {
                    Task { if tab == "roles" { await model.saveRoles() } else { await model.saveInstructions() } }
                }
                .buttonStyle(.glassProminent).controlSize(.large).keyboardShortcut("s")
                .disabled(!store.connected || (tab == "roles" ? model.savingRoles : !model.loaded || model.savingText))
            }.padding(.horizontal, 26).padding(.vertical, 18)
        }
        .background(WorkspaceStyle.canvas)
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
                            Text(roleNames[role]!).font(.system(size: 16, weight: .semibold, design: .rounded))
                            Spacer()
                            Picker("Agent for \(roleNames[role]!)", selection: roleBinding(role, \.agent)) {
                                ForEach(store.state.agents.keys.sorted(), id: \.self) { id in
                                    Text("\(agentName(id))\(store.state.agents[id]?.enabled == false ? " (disabled)" : "")").tag(id)
                                }
                            }.labelsHidden().frame(width: 180)
                        }
                        HStack(spacing: 20) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Model").font(.caption).foregroundStyle(.secondary)
                                TextField("Agent default", text: optionalRoleBinding(role, \.model)).accessibilityLabel("\(roleNames[role]!) model")
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Reasoning effort").font(.caption).foregroundStyle(.secondary)
                                TextField("Agent default", text: optionalRoleBinding(role, \.effort)).accessibilityLabel("\(roleNames[role]!) reasoning effort")
                            }
                        }.textFieldStyle(.roundedBorder)
                    }.padding(18).background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 18))
                }
                Text("Changes apply to the next job. Empty fields use the agent’s defaults.")
                    .font(.caption).foregroundStyle(.secondary).padding(.top, 4)
            }.padding(.horizontal, 26)
        }
    }
    private var instructions: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Shared instructions").font(WorkspaceStyle.section)
                Spacer()
                Picker("Applies to", selection: Binding(get: { model.scope }, set: changeScope)) {
                    Text("Every project").tag("")
                    ForEach(store.projects, id: \.self) { Text(projectName($0, among: store.projects)).tag($0) }
                }.frame(maxWidth: 250).disabled(model.savingText)
            }
            Text("Given to every agent with its next job and to Claude sessions when they start.")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: $model.text).font(.system(.body, design: .monospaced))
                .scrollContentBackground(.hidden).padding(14)
                .background(WorkspaceStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.primary.opacity(0.08)))
                .accessibilityLabel("Shared instructions").disabled(!model.loaded)
            Text(model.file).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            if model.text.count > 9000 { Label("Claude sessions will be pointed to this file because it is longer than 9,000 characters.", systemImage: "info.circle").font(.callout).foregroundStyle(.secondary) }
        }.padding(.horizontal, 26)
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

@MainActor func confirmDiscard(_ title: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = "Your changes have not been saved."
    alert.addButton(withTitle: "Keep Editing")
    alert.addButton(withTitle: "Discard Changes")
    return alert.runModal() == .alertSecondButtonReturn
}
