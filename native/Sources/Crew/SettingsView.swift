import SwiftUI

/// One page of the settings window, listed in the sidebar: the app itself, the roles by kind of work, what every agent
/// shares, then each project's own instructions.
enum SettingsPane: Hashable, Identifiable {
    case about, build, review, edit, presets, models, instructions
    case project(String)
    var id: Self { self }
    static let roles: [SettingsPane] = [.build, .review, .edit]
    static let shared: [SettingsPane] = [.presets, .models, .instructions]
    /// The role group (`RoleInfo.group`) a roles page shows; nil for the other pages.
    var group: String? { switch self { case .build: "Build"; case .review: "Review"; case .edit: "Edit"; default: nil } }
    /// The instructions a page edits: "" for every project, a project's path for its own; nil for the other pages.
    var scope: String? { switch self { case .instructions: ""; case .project(let path): path; default: nil } }
    var systemImage: String {
        switch self {
        case .about: "info.circle.fill"
        case .build: "hammer.fill"
        case .review: "checkmark.shield.fill"
        case .edit: "textformat"
        case .presets: "slider.horizontal.3"
        case .models: "gauge.with.dots.needle.67percent"
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
        case .presets, .about: .gray
        case .models: .purple
        case .instructions: .indigo
        }
    }
}

/// Laid out like System Settings: a sidebar of pages, and a grouped form whose page title sits in the unified
/// toolbar, where the system's soft scroll edge takes over from a hard cut. As there, roles and the preset are stored
/// as they are changed; only the instructions, being prose, have a save, on the line under their editor.
struct CrewSettingsView: View {
    /// Fixed, as in System Settings; the window pins it (CrewApp.openSettings).
    static let sidebarWidth: CGFloat = 180
    private static let editorHeight: CGFloat = 260
    private static let aboutIconSize: CGFloat = 56
    @Bindable var model: SettingsModel
    var store: CrewStore
    @Environment(AppUpdater.self) private var updater
    @State private var selection: SettingsPane? = .build
    /// The model or effort being typed by hand, stored when it is left as when Return is pressed.
    @FocusState private var typing: SettingsModel.TypedField?
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
                SettingsAppRow(ready: updater.phase == .ready).tag(SettingsPane.about)
                Section("Roles") { ForEach(SettingsPane.roles) { paneRow($0) } }
                Section("Shared") { ForEach(SettingsPane.shared.filter(available)) { paneRow($0) } }
                if !store.projects.isEmpty {
                    Section("Projects") { ForEach(store.projects.map(SettingsPane.project)) { paneRow($0) } }
                }
            }
            .listStyle(.sidebar)
            .background(OverlayScrollers())
            // A split view hosted in an NSWindow ignores the column width alone; the sidebar's own frame holds it.
            .frame(width: Self.sidebarWidth)
            .navigationSplitViewColumnWidth(Self.sidebarWidth)
            .toolbar(removing: .sidebarToggle)
        } detail: {
            // A page the daemon no longer offers (after reconnecting to an older one) falls back to the first.
            let pane = selection.flatMap { available($0) ? $0 : nil } ?? .build
            Form { content(pane) }
                .formStyle(.grouped)
                .background(OverlayScrollers())
                .scrollEdgeEffectStyle(.soft, for: .top)
                .navigationTitle(title(pane))
                // NSHostingController does not carry navigationTitle into the window, so the toolbar would be blank.
                .background(WindowTitleSetter(title: title(pane)))
                .onChange(of: typing) { left, _ in if let left { commit(left) } }
        }
        .frame(minWidth: WorkspaceStyle.settingsMinSize.width, idealWidth: WorkspaceStyle.settingsSize.width, minHeight: WorkspaceStyle.settingsMinSize.height, idealHeight: WorkspaceStyle.settingsSize.height)
        .task { if !model.loaded && !model.loading { await model.load(scope: model.scope) } }
    }
    /// A daemon without presets or model notes has no page for them.
    private func available(_ pane: SettingsPane) -> Bool {
        switch pane {
        case .presets: model.presets != nil
        case .models: store.state.modelScores != nil
        default: true
        }
    }
    private func title(_ pane: SettingsPane) -> String {
        switch pane {
        case .about: "About Crew"
        case .presets: "Model Presets"
        case .models: "Model Scores"
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
                Text("The lead picks the holder; by default, Antigravity takes wording and Codex the rest, among holders that can. Claude means the lead does it itself.").settingsFootnote()
            }
        } else if pane == .about {
            about
        } else if pane == .presets {
            presets
        } else if pane == .models {
            modelScores
        } else {
            instructions(pane)
        }
    }
    private func roleSection(_ role: RoleInfo) -> some View {
        Section {
            if let parent = role.parent {
                Toggle("Same as \(model.roleInfo.first { $0.role == parent }?.label ?? parent)", isOn: Binding(
                    get: { model.followsParent(role.role) },
                    set: { model.setFollowParent(role.role, enabled: $0); storeRoles() }
                )).toggleStyle(.checkbox)
            }
            LabeledContent("Agents") {
                HStack(spacing: Space.l) {
                    ForEach(RoleAssignment.holderOrder, id: \.self) { holder in
                        Toggle(holderLabel(holder), isOn: Binding(
                            get: { model.assignment(for: role.role)?.holders.contains(holder) == true },
                            set: { model.setHolder(role.role, holder: holder, enabled: $0); storeRoles() }
                        )).toggleStyle(.checkbox).accessibilityLabel("\(role.label): \(holderLabel(holder))")
                            .disabled(!model.canToggleHolder(role.role, holder: holder))
                    }
                }.disabled(model.followsParent(role.role))
            }
            ForEach(model.assignment(for: role.role)?.workerHolders ?? [], id: \.self) { agent in
                roleField(role, agent: agent, \.model)
                roleField(role, agent: agent, \.effort)
            }
        } header: {
            HStack(spacing: Space.ml) {
                AgentMark(agent: model.assignment(for: role.role)?.holders.first ?? "codex", size: MarkSize.card)
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text(role.label).font(.headline).foregroundStyle(.primary)
                    Text(role.summary).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.textCase(nil)
        } footer: {
            // A change that could not be stored was undone; its role says why.
            if !model.roleError.isEmpty && model.changedRole == role.role {
                ErrorLabel(message: "Not saved: \(model.roleError)").settingsFootnote()
            }
        }
    }
    /// Stores the table after a change, as the change is made.
    private func storeRoles() {
        Task { await model.applyRoles() }
    }
    private func commit(_ field: SettingsModel.TypedField) {
        model.commit(field)
        storeRoles()
    }
    @ViewBuilder private var presets: some View {
        let selected = model.preset.flatMap { model.presets?[$0.rawValue] }
        Section {
            Picker("Default", selection: $model.preset) {
                Text("None").tag(nil as PresetName?)
                ForEach(PresetName.allCases, id: \.self) { name in
                    Text(name.rawValue.capitalized).tag(Optional(name))
                }
            }
            // Stored as it is picked. Undoing a pick that could not be stored comes through here too, with nothing left to store.
            .onChange(of: model.preset) { Task { await model.applyPreset() } }
            if let selected {
                ForEach(selected.details, id: \.label) { row in
                    LabeledContent(row.label, value: row.value)
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: Space.s) {
                if !model.presetError.isEmpty { ErrorLabel(message: "Not saved: \(model.presetError)") }
                Text(model.preset?.summary ?? "Uses each agent's own model and effort settings.")
            }.settingsFootnote()
        }
        Section {
            LabeledContent("Role settings", value: "Override any preset")
            LabeledContent("Mission preset", value: "Overrides default for new jobs")
        } header: {
            Text("Priority")
        } footer: {
            Text("Change a mission's preset from its menu, or name one in your prompt.").settingsFootnote()
        }
    }
    @ViewBuilder private var about: some View {
        Section {
            HStack(spacing: Space.l) {
                Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).scaledToFit()
                    .frame(width: Self.aboutIconSize, height: Self.aboutIconSize).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text("Crew").font(.title3.weight(.semibold))
                    Text("Version \(updater.current)").foregroundStyle(.secondary)
                }
            }.padding(.vertical, Space.xs)
        }
        Section {
            // Centered rather than a LabeledContent: a form row pins its label's baseline at the height of a text row,
            // so a button taller than the text would run into the row's top padding and leave more room below it.
            // The small button is kept out of the row's height, so this row is as tall as the text rows around it.
            HStack {
                Text(updater.summary)
                Spacer()
                Group {
                    switch updater.phase {
                    case .unsupported: EmptyView()
                    case .installing where updater.waiting != nil:
                        Button("Cancel Update") { updater.failed() }
                    case .ready, .installing:
                        Button("Restart to Update") { updater.onInstall() }
                            .buttonStyle(.borderedProminent).disabled(updater.phase == .installing)
                    case .available:
                        Button("Download Now") { Task { await updater.checkNow() } }
                    // The progress bar below says what a download is doing; a disabled button beside it adds nothing.
                    case .downloading: EmptyView()
                    case .idle, .checking:
                        Button("Check for Updates") { Task { await updater.checkNow() } }
                            .disabled(updater.phase != .idle)
                    }
                }.controlSize(.small).frame(height: 0)
            }
            if updater.phase == .downloading {
                ProgressView(value: updater.progress).accessibilityLabel("Download progress")
            }
            if let page = updater.page, let latest = updater.latest {
                LabeledContent("Release notes") { Link("What’s new in \(latest)", destination: page) }
            }
        } footer: {
            VStack(alignment: .leading, spacing: Space.s) {
                if let error = updater.error { ErrorLabel(message: error) }
                Text(updater.phase == .unsupported
                    ? "This copy of Crew is not running from an app bundle, so it cannot update itself."
                    : "Updates download in the background and install only on Restart to Update, after running jobs finish.")
            }.settingsFootnote()
        }
    }
    @ViewBuilder private var modelScores: some View {
        let scores = store.state.modelScores ?? []
        // Only models with enough reviews are ranked, so a few clean reviews never put one ahead of a model with a record.
        let ranked = scores.filter { $0.score != nil && $0.status != "too few samples" }
        // A model that only reviewed has no build to rank by, so it stands apart, by how its findings held up.
        let reviewers = scores.filter { $0.score == nil && $0.items?.findings != nil }.sorted { ($0.items?.findings ?? 0) > ($1.items?.findings ?? 0) }
        let early = scores.filter { score in !ranked.contains { $0.id == score.id } && !reviewers.contains { $0.id == score.id } }
        if ranked.count >= 2 {
            Section { ModelPodium(top: Array(ranked.prefix(3))) }
        }
        if scores.isEmpty {
            Section { Text("No reviews noted yet.").foregroundStyle(.secondary) }
        }
        if !ranked.isEmpty {
            Section {
                ForEach(Array(ranked.enumerated()), id: \.element.id) { index, score in ModelScoreRow(rank: index + 1, score: score) }
            }
        }
        if !early.isEmpty {
            Section("Too early to rank") {
                ForEach(early) { ModelScoreRow(rank: nil, score: $0) }
            }
        }
        if !reviewers.isEmpty {
            Section("Reviewers") {
                ForEach(reviewers) { ModelScoreRow(rank: nil, score: $0) }
            }
        }
        Section {} footer: {
            Text("Scored from review findings per build size, with fixes scored apart. A model is ranked after three build reviews; a review by its own agent counts half.")
                .settingsFootnote()
        }
        if let peerRatings = store.state.peerRatings {
            Section {
                Toggle("Peer ratings", isOn: Binding(get: { peerRatings }, set: { enabled in Task { await store.setPeerRatings(enabled) } }))
            } footer: {
                VStack(alignment: .leading, spacing: Space.s) {
                    if let error = store.actions[CrewStore.peerRatingsKey]?.error { ErrorLabel(message: error) }
                    Text("The lead and the workers rate each other's work as they see it, in turns they already have, and the ratings move half of a score from where the review findings put it. Off, nobody is asked to rate and the scores come from the review findings alone; ratings already given are kept.")
                }.settingsFootnote()
            }
        }
    }
    @ViewBuilder private func instructions(_ pane: SettingsPane) -> some View {
        Section {
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden)
                .background(OverlayScrollers())
                .frame(minHeight: Self.editorHeight)
                .accessibilityLabel("Shared instructions").disabled(!model.loaded || model.scope != pane.scope)
        } header: {
            Text(pane == .instructions ? "Given to every agent with its next job, in every project, and to Claude sessions when they start."
                 : "Given to every agent working in this project, after the instructions for every project.")
                .settingsFootnote().textCase(nil)
        } footer: {
            VStack(alignment: .leading, spacing: Space.s) {
                saveRow
                if model.text.count > 9000 {
                    Label("Claude sessions will be pointed to this file because it is longer than 9,000 characters.", systemImage: "info.circle").settingsFootnote()
                }
            }
        }
    }
    /// The instructions' status and their save, on the line under the editor: no other page has anything to save.
    private var saveRow: some View {
        HStack(spacing: Space.l) {
            if model.loading { ProgressView().controlSize(.small) }
            Text(model.textStatus).font(Typeface.callout).foregroundStyle(.secondary).textSelection(.enabled)
            if model.text != model.savedText {
                Label("Unsaved changes", systemImage: "circle.fill").font(Typeface.calloutStrong).foregroundStyle(Palette.warning)
                    .labelStyle(UnsavedLabelStyle())
            }
            Spacer()
            if !model.loaded && !model.loading {
                Button("Retry Loading") { Task { await model.load(scope: model.scope) } }.pillButton()
            }
            Button(model.savingText ? "Saving…" : "Save") { Task { await model.saveInstructions() } }
                .glassPillButton().morphs(on: model.savingText).keyboardShortcut("s")
                .disabled(!store.connected || model.savingText || !model.loaded)
        }
    }
    private func holderLabel(_ holder: String) -> String {
        holder == "claude" ? "Claude" : "\(agentName(holder))\(store.state.agents[holder]?.enabled == false ? " (disabled)" : "")"
    }
    private func roleBinding(_ role: RoleInfo, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>) -> Binding<String> {
        Binding(get: { model.roleSettings[role.role]?[agent]?[keyPath: key] ?? "" },
                set: { model.setRole(role.role, agent: agent, key, to: $0, offered: store.state.agents[agent]?.models ?? []) })
    }
    @ViewBuilder private func roleField(_ role: RoleInfo, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>) -> some View {
        let title = "\(agentName(agent)) \(key == \.model ? "model" : "reasoning effort")"
        let offered = store.state.agents[agent]?.models ?? []
        let blank = model.blankTitle(role.role, agent: agent, key, models: offered)
        let binding = roleBinding(role, agent: agent, key)
        if offered.isEmpty {
            // Typed by hand into a draft, which goes into the table on Return or when the field is left; until then it
            // is an unsaved change, which closing the window asks about.
            let field = SettingsModel.TypedField(role: role.role, agent: agent, model: key == \.model)
            TextField(title, text: Binding(get: { model.typed(field) }, set: { model.type(field, $0) }), prompt: Text(blank))
                .focused($typing, equals: field)
                .onSubmit { commit(field) }
                .accessibilityLabel("\(role.label) \(title)")
        } else {
            Picker(title, selection: Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; storeRoles() })) {
                Text(blank).tag("")
                ForEach(model.fieldChoices(role.role, agent: agent, key, models: offered)) { choice in
                    Text(choice.name).tag(choice.id)
                }
            }.accessibilityLabel("\(role.label) \(title)")
        }
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
/// The app's own row, which opens About Crew; a dot marks an update ready to install.
private struct SettingsAppRow: View {
    let ready: Bool
    private static let iconSize: CGFloat = 36
    /// White on the accent of a selected row, where the accent dot would vanish.
    @Environment(\.backgroundProminence) private var prominence
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    var body: some View {
        HStack(spacing: Space.ml) {
            Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).scaledToFit()
                .frame(width: Self.iconSize, height: Self.iconSize).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text("Crew").font(.body.weight(.semibold))
                if let version { Text("v\(version)").font(.subheadline).foregroundStyle(.secondary) }
            }
            if ready {
                Spacer(minLength: 0)
                Circle().fill(prominence == .increased ? AnyShapeStyle(.white) : AnyShapeStyle(.tint))
                    .frame(width: Symbol.indicator, height: Symbol.indicator).accessibilityLabel("Update ready")
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
