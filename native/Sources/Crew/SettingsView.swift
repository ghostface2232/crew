import SwiftUI

/// One page of the settings window, listed in the sidebar: the app itself with its own settings, the roles by kind of
/// work, what every agent shares, then each project's own instructions.
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
        case .review: .green
        case .edit: .orange
        case .presets, .about, .project: .gray
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
    private static let aboutIconSize: CGFloat = 40
    @Bindable var model: SettingsModel
    var store: CrewStore
    @Environment(AppUpdater.self) private var updater
    @State private var selection: SettingsPane? = .build
    /// Open at Login as macOS last reported it; read whenever the Crew page shows, as the user can change it in System Settings.
    @State private var login: LoginItem.State?
    @State private var loginError: String?
    /// The model or effort being typed by hand, stored when it is left as when Return is pressed.
    @FocusState private var typing: SettingsModel.TypedField?
    /// Moving to another set of instructions loads it in place of the one being edited, so unsaved edits are asked about first.
    private var pages: Binding<SettingsPane?> {
        Binding(get: { selection }, set: { next in
            if let scope = next?.scope, scope != model.scope {
                // Text being saved is not unsaved; the next set loads once the save is done.
                if model.savingText { return }
                if model.text != model.savedText && !confirmDiscard(String(localized: "Discard unsaved instructions?")) { return }
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
        .onChange(of: store.state.editableRoleSettings) { _, table in model.adopt(roleSettings: table) }
        .onChange(of: store.state.preset) { _, preset in model.adopt(preset: preset, presets: store.state.presets) }
        .onChange(of: store.state.presets) { _, presets in model.adopt(preset: store.state.preset, presets: presets) }
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
        case .about: "Crew"
        case .presets: String(localized: "Model Presets")
        case .models: String(localized: "Model Scores")
        case .instructions: String(localized: "Instructions")
        case .project(let path): projectName(path, among: store.projects)
        default: pane.group.map(localizedCrewLabel) ?? ""
        }
    }
    private func paneRow(_ pane: SettingsPane) -> some View {
        Label {
            Text(title(pane))
        } icon: {
            if case .project(let path) = pane {
                SettingsPaneIcon(pane: pane, symbol: ProjectIcons.filledSymbol(store.state.projects?[path]?.icon))
            } else {
                SettingsPaneIcon(pane: pane)
            }
        }.tag(pane)
    }
    @ViewBuilder private func content(_ pane: SettingsPane) -> some View {
        if let group = pane.group {
            ForEach(model.roleInfo.filter { $0.group == group }) { roleSection($0) }
        } else if pane == .about {
            // The app's own page: its updates, then the settings that are the app's rather than the agents'.
            about
            general
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
                Toggle("Same as \(model.roleInfo.first { $0.role == parent }?.localizedLabel ?? parent)", isOn: Binding(
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
                        )).toggleStyle(.checkbox).accessibilityLabel("\(role.localizedLabel): \(holderLabel(holder))")
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
                    Text(role.localizedLabel).font(.headline).foregroundStyle(.primary)
                    Text(role.localizedSummary).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.textCase(nil)
        } footer: {
            // A change that could not be stored was undone; its role says why.
            if !model.roleError.isEmpty && model.changedRole == role.role {
                ErrorLabel(message: String(localized: "Not saved: \(model.roleError)")).settingsFootnote()
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
                    Text(localizedCrewLabel(name.rawValue.capitalized)).tag(Optional(name))
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
                if !model.presetError.isEmpty { ErrorLabel(message: String(localized: "Not saved: \(model.presetError)")) }
                Text(model.preset?.summary ?? String(localized: "Uses each agent's own model and effort settings."))
            }.settingsFootnote()
        }
        // Stored as it is picked, as in the board.
        if let budget = store.state.turnTokenBudget {
            Section {
                Picker("Tokens per Turn", selection: Binding(get: { budget }, set: { next in Task { await store.setTurnTokenBudget(next) } })) {
                    ForEach([TurnTokenBudget.byDifficulty] + TurnTokenBudget.choices + [.unlimited], id: \.self) { choice in
                        Text(verbatim: choice.label).tag(choice)
                    }
                }
                // Its save drops a pick made while another is being stored, as the project switches' does.
                .disabled(!store.connected || store.actions[CrewStore.turnTokenBudgetKey]?.pending == true)
            } header: {
                Text("Turn Budget")
            } footer: {
                VStack(alignment: .leading, spacing: Space.s) {
                    if let error = store.actions[CrewStore.turnTokenBudgetKey]?.error { ErrorLabel(message: String(localized: "Not saved: \(error)")) }
                    Text(verbatim: budget.footnote)
                }.settingsFootnote()
            }
        }
        Section {
            LabeledContent(String(localized: "Role settings"), value: String(localized: "Override any preset"))
            LabeledContent(String(localized: "Mission preset"), value: String(localized: "Overrides default for new jobs"))
        } header: {
            Text("Priority")
        }
    }
    /// Laid out like Software Update: the state and the installed version beside the app's icon, with the check on
    /// that row; an update under way shows its progress there and adds its notes, and its action goes under the list,
    /// as Save does under the instructions.
    @ViewBuilder private var about: some View {
        Section {
            HStack(spacing: Space.l) {
                Image(nsImage: NSApp.applicationIconImage).resizable().interpolation(.high).scaledToFit()
                    .frame(width: Self.aboutIconSize, height: Self.aboutIconSize).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.xxs) {
                    Text(updater.summary)
                    if updater.phase == .downloading {
                        ProgressView(value: updater.progress).accessibilityLabel("Download progress").padding(.vertical, Space.xs)
                    }
                    Text("Crew \(updater.current)").font(Typeface.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: Space.l)
                if updater.phase == .idle || updater.phase == .checking {
                    Button("Check for Updates") { Task { await updater.checkNow() } }.disabled(updater.phase != .idle)
                }
            }.padding(.vertical, Space.xs)
            if let page = updater.page, let latest = updater.latest {
                LabeledContent("Release notes") { Link(String(localized: "What’s new in \(latest)"), destination: page) }
            }
        } footer: {
            // The note and the action share one line, so the action is not left between the list and a note.
            // Said only where it explains what the user sees: no updates at all, or one waiting on jobs. With nothing to
            // say, the footer is left out, as its empty space would part the card from the settings under it.
            let error = updater.error ?? updater.installError
            let note = updater.phase == .unsupported ? String(localized: "This copy of Crew is not running from an app bundle, so it cannot update itself.")
                : updater.phase == .ready ? String(localized: "Updates install after running jobs finish.") : nil
            let action = note != nil || [.ready, .installing, .available].contains(updater.phase)
            if error != nil || action {
                VStack(alignment: .leading, spacing: Space.ml) {
                    if let error { ErrorLabel(message: error).settingsFootnote() }
                    if action {
                        HStack(spacing: Space.l) {
                            if let note { Text(note).settingsFootnote().frame(maxWidth: .infinity, alignment: .leading) } else { Spacer(minLength: 0) }
                            updateAction
                        }
                    }
                }
            }
        }
    }
    /// Language, the progress cards and Open at Login as one group, each note under its own name; only a failure, or
    /// Open at Login waiting on approval, says more under the group. A daemon that predates a setting sends none.
    @ViewBuilder private var general: some View {
        let language = store.state.hasLanguageSetting == true, cards = store.state.progressCards, login = LoginItem.supported()
        if language || cards != nil || login {
            Section {
                // Stored as it is picked, as in the board. Each language is named in itself, so it can be found whatever the app reads in.
                if language {
                    Picker(selection: Binding(get: { store.state.language ?? "" }, set: { next in Task { await store.setLanguage(next.isEmpty ? nil : next) } })) {
                        Text("Match System").tag("")
                        Text(verbatim: "English").tag("en")
                        Text(verbatim: "한국어").tag("ko")
                    } label: {
                        Text("Language")
                        Text("Applies the next time the app opens.")
                    }
                }
                // The progress card in a lead's chat, on hosts that draw one.
                if let cards {
                    Toggle(isOn: Binding(get: { cards }, set: { enabled in Task { await store.setProgressCards(enabled) } })) {
                        Text("Progress cards in chat")
                        Text("Shows each mission step as a card in the Claude and Codex desktop apps.")
                    }
                }
                // macOS holds Open at Login's state, so the switch shows what it reads back after each change.
                if login {
                    Toggle(isOn: Binding(get: { self.login == .on }, set: { open in
                        do { try LoginItem.set(open); loginError = nil } catch { loginError = error.localizedDescription }
                        self.login = LoginItem.state
                    })) {
                        Text("Open at Login")
                        Text("Crew starts in the menu bar when you log in.")
                    }
                    .onAppear(perform: readLogin)
                    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in readLogin() }
                }
            } footer: {
                let errors = [store.actions[CrewStore.languageKey]?.error, store.actions[CrewStore.progressCardsKey]?.error, loginError].compactMap { $0 }
                if !errors.isEmpty || (login && self.login == .needsApproval) {
                    VStack(alignment: .leading, spacing: Space.ml) {
                        ForEach(errors, id: \.self) { ErrorLabel(message: $0).settingsFootnote() }
                        if login && self.login == .needsApproval {
                            HStack(spacing: Space.l) {
                                Text("Crew is turned off in Login Items. Turn it on there to open at login.").settingsFootnote()
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Button("Open Login Items") { LoginItem.openSystemSettings() }.pillButton()
                            }
                        }
                    }
                }
            }
        }
    }
    /// A fresh reading replaces an earlier failure, which may have been settled in System Settings since.
    private func readLogin() {
        login = LoginItem.state
        loginError = nil
    }
    @ViewBuilder private var updateAction: some View {
        switch updater.phase {
        case .installing where updater.waiting != nil:
            Button("Cancel Update") { updater.failed() }.pillButton()
        case .ready, .installing:
            Button("Update Now") { updater.onInstall() }.glassPillButton().disabled(updater.phase == .installing)
        case .available:
            Button("Download Now") { Task { await updater.checkNow() } }.glassPillButton()
        case .unsupported, .downloading, .idle, .checking: EmptyView()
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
        if let peerRatings = store.state.peerRatings {
            Section {
                Toggle("Peer ratings", isOn: Binding(get: { peerRatings }, set: { enabled in Task { await store.setPeerRatings(enabled) } }))
            } footer: {
                if let error = store.actions[CrewStore.peerRatingsKey]?.error { ErrorLabel(message: error).settingsFootnote() }
            }
        }
    }
    /// What each of a project's switches lets Crew do there without asking, as in the board.
    private static let projectSwitches: [(key: String, label: LocalizedStringKey, note: LocalizedStringKey, value: KeyPath<ProjectSettings, Bool?>)] = [
        ("autonomy", "Push and open pull requests", "Work is pushed only after it is reviewed and its checks pass. Crew never merges or deploys.", \.autonomy),
        ("watchAway", "Watch pull requests while away", "Crew checks pull requests every 10 minutes while the lead session is closed.", \.watchAway),
        ("autoResume", "Resume after a usage limit", "A job stopped by the limit continues once usage resets, but only for a mission still in progress.", \.autoResume),
    ]
    @ViewBuilder private func instructions(_ pane: SettingsPane) -> some View {
        if case .project(let path) = pane, let projects = store.state.projects {
            Section {
                ForEach(Self.projectSwitches, id: \.key) { item in
                    Toggle(isOn: Binding(
                        get: { projects[path]?[keyPath: item.value] == true },
                        set: { on in Task { await store.setProjectSwitch(path, item.key, on: on) } }
                    )) {
                        Text(item.label)
                        Text(item.note)
                    }
                    // The switches share one save, which drops a change made while another is being stored.
                    .disabled(!store.connected || store.actions[CrewStore.projectSwitchKey(path)]?.pending == true)
                }
            } footer: {
                if let error = store.actions[CrewStore.projectSwitchKey(path)]?.error { ErrorLabel(message: error).settingsFootnote() }
            }
        }
        Section {
            TextEditor(text: $model.text).font(Typeface.code)
                .scrollContentBackground(.hidden)
                .background(OverlayScrollers())
                .frame(minHeight: Self.editorHeight)
                .accessibilityLabel("Shared instructions").disabled(!model.loaded || model.scope != pane.scope)
        } header: {
            Text(pane == .instructions ? String(localized: "Shared with every agent in every project.")
                 : String(localized: "Shared with every agent in this project."))
                .settingsFootnote().textCase(nil)
        } footer: {
            VStack(alignment: .leading, spacing: Space.s) {
                saveRow
                if model.text.count > 9000 {
                    Label("Too long to give lead sessions in full.", systemImage: "info.circle").settingsFootnote()
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
            Button(model.savingText ? String(localized: "Saving…") : String(localized: "Save")) { Task { await model.saveInstructions() } }
                .glassPillButton().morphs(on: model.savingText).keyboardShortcut("s")
                .disabled(!store.connected || model.savingText || !model.loaded)
        }
    }
    private func holderLabel(_ holder: String) -> String {
        let name = agentName(holder)
        return holder != "claude" && store.state.agents[holder]?.enabled == false ? String(localized: "\(name) (disabled)") : name
    }
    private func roleBinding(_ role: RoleInfo, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>) -> Binding<String> {
        Binding(get: { model.roleSettings[role.role]?[agent]?[keyPath: key] ?? "" },
                set: { model.setRole(role.role, agent: agent, key, to: $0, offered: store.state.agents[agent]?.models ?? []) })
    }
    @ViewBuilder private func roleField(_ role: RoleInfo, agent: String, _ key: WritableKeyPath<RoleAgentSettings, String?>) -> some View {
        let title = key == \.model ? String(localized: "\(agentName(agent)) model") : String(localized: "\(agentName(agent)) reasoning effort")
        let offered = agent == "claude" ? claudeModels : store.state.agents[agent]?.models ?? []
        let blank = model.blankTitle(role.role, agent: agent, key, models: offered)
        let binding = roleBinding(role, agent: agent, key)
        if offered.isEmpty {
            // Typed by hand into a draft, which goes into the table on Return or when the field is left; until then it
            // is an unsaved change, which closing the window asks about.
            let field = SettingsModel.TypedField(role: role.role, agent: agent, model: key == \.model)
            TextField(title, text: Binding(get: { model.typed(field) }, set: { model.type(field, $0) }), prompt: Text(blank))
                .focused($typing, equals: field)
                .onSubmit { commit(field) }
                .accessibilityLabel("\(role.localizedLabel) \(title)")
        } else {
            Picker(title, selection: Binding(get: { binding.wrappedValue }, set: { binding.wrappedValue = $0; storeRoles() })) {
                Text(blank).tag("")
                ForEach(model.fieldChoices(role.role, agent: agent, key, models: offered)) { choice in
                    Text(choice.name).tag(choice.id)
                }
            }.accessibilityLabel("\(role.localizedLabel) \(title)")
        }
    }
}

/// The colored rounded-square icon System Settings puts beside each page.
private struct SettingsPaneIcon: View {
    let pane: SettingsPane
    /// A project's own icon in place of the page's.
    var symbol: String?
    var size: CGFloat = 20
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * 0.26, style: .continuous)
        shape.fill(pane.tint.gradient).frame(width: size, height: size)
            .overlay { Image(systemName: symbol ?? pane.systemImage).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white) }
            // A light rim keeps a blue tile apart from the blue selection behind it.
            .overlay { shape.strokeBorder(.white.opacity(0.25), lineWidth: 0.5) }
            .shadow(color: .black.opacity(0.2), radius: 0.75, y: 0.5)
            .accessibilityHidden(true)
    }
}

/// The app's icon and name at the top of the sidebar, where System Settings shows the account.
/// The app's own row, which opens the Crew page; a dot marks an update ready to install.
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
                Text(verbatim: "Crew").font(.body.weight(.semibold))
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
    alert.informativeText = String(localized: "Your changes have not been saved.")
    alert.addButton(withTitle: String(localized: "Keep Editing"))
    alert.addButton(withTitle: String(localized: "Discard Changes"))
    return alert.runModal() == .alertSecondButtonReturn
}
