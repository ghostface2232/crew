import SwiftUI

struct JobDispatch {
    var assignment: RoleAssignment?
    var workers: [String: Worker]
    var info: RoleInfo?
    var picked: String?
    var holders: [String] {
        let order = info?.kind == "polish" ? ["antigravity", "codex"] : ["codex", "antigravity"]
        return order.filter { assignment?.agents.contains($0) == true && workers[$0] != nil }
    }
    /// With no worker able, a role Claude holds is the lead's, as the daemon would decide.
    private var claudeHolds: Bool { assignment?.agents.contains("claude") == true }
    var agent: String? {
        picked.flatMap { holders.contains($0) ? $0 : nil }
            ?? holders.first { workers[$0]?.enabled == true && info?.unable?.contains($0) != true }
            ?? (claudeHolds ? nil : holders.first)
    }
    var submissionAgent: String? { agent }
    var worker: Worker? { agent.flatMap { workers[$0] } }
    var canSend: Bool { worker?.enabled == true }
    var requiresClaude: Bool { assignment != nil && agent == nil && claudeHolds }
}

struct DispatchView: View {
    /// A read-only value lines up with the pickers beside it.
    private static let fieldHeight: CGFloat = 22
    @Bindable var store: CrewStore
    @Environment(\.dismiss) private var dismiss
    @State private var directory: String
    @State private var intent = "command"
    @State private var destination = "project"
    @State private var role = "delegate"
    @State private var pickedAgent: String?
    @State private var targets = ""
    @State private var task = ""
    @State private var sending = false
    @State private var error = ""
    @State private var confirmingDiscard = false
    private let initialDirectory: String
    init(store: CrewStore) { self.store = store; initialDirectory = store.project; _directory = State(initialValue: store.project) }
    private var dirty: Bool { intent != "command" || destination != "project" || !task.isEmpty || !targets.isEmpty || role != "delegate" || directory != initialDirectory || pickedAgent != nil }
    private var dispatch: JobDispatch {
        let role = intent == "question" ? "delegate" : role
        return JobDispatch(assignment: store.state.roles[role], workers: store.state.agents,
                           info: store.state.availableRoles.first { $0.role == role }, picked: pickedAgent)
    }
    private var selectedRole: RoleInfo? { store.state.availableRoles.first { $0.role == role } }
    private var missions: [Mission] { store.state.missions.filter { $0.state == "active" && $0.root == directory.trimmingCharacters(in: .whitespacesAndNewlines) } }
    private var canSend: Bool {
        guard !sending, store.connected, !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if intent == "information" && destination == "shared" { return true }
        guard !directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if intent == "information" {
            return destination == "project" || missions.contains { "mission:\($0.id)" == destination }
        }
        return dispatch.canSend
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xxl) {
            Label("New Job", systemImage: "paperplane").font(Typeface.title)
                .labelStyle(.titleAndIcon).symbolRenderingMode(.hierarchical)
            Picker("Intent", selection: $intent) {
                Text("Command").tag("command")
                Text("Question").tag("question")
                Text("Information").tag("information")
            }.pickerStyle(.segmented)
            VStack(alignment: .leading, spacing: Space.xl) {
                field("Project") {
                    HStack(spacing: Space.m) {
                        TextField("Project directory", text: $directory, prompt: Text("/path/to/repository"))
                            .textFieldStyle(.roundedBorder).labelsHidden().accessibilityLabel("Project directory")
                        Button("Choose…", systemImage: "folder") { chooseFolder() }.pillButton().accessibilityLabel("Choose project directory")
                    }
                }
                if intent == "command" {
                    HStack(alignment: .top, spacing: Space.x3l) {
                        field("Role") {
                            Picker("Role", selection: $role) {
                                ForEach(store.state.availableRoles.filter { $0.role != "debate" }) { Text($0.label).tag($0.role) }
                            }
                                .labelsHidden().fixedSize()
                        }
                        assignedTo
                    }
                    if role == "polish" {
                        field("Allowed files or directories") {
                            TextField("One path per line", text: $targets, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(3...6)
                        }
                    }
                }
                if intent == "question" { assignedTo }
                if intent != "information" && dispatch.requiresClaude {
                    Text("Start this job from a Claude session. Claude does the work itself or in a subagent.")
                        .font(Typeface.caption).foregroundStyle(.secondary)
                }
                if intent == "information" {
                    field("Add to") {
                        Picker("Information destination", selection: $destination) {
                            Text("This project's shared instructions").tag("project")
                            Text("Every project's shared instructions").tag("shared")
                            ForEach(missions) { mission in Text(mission.title).tag("mission:\(mission.id)") }
                        }.labelsHidden()
                    }
                }
                field(intent == "question" ? "What would you like to know?" : intent == "information" ? "What should be remembered?" : selectedRole?.kind == "review" ? "What should be checked?" : "What needs to be done?") {
                    MessageEditor(title: "New job instructions", text: $task)
                    Text(intent == "information" ? "Adds information only. This starts no work." : intent == "question" ? "Answers the question in read-only mode." : role == "verify" ? "Reviews uncommitted changes by running the app in a snapshot." : selectedRole?.kind == "review" ? "Reviews uncommitted changes in read-only mode." : "Changes stay on an isolated worktree branch until reviewed and merged.")
                        .font(Typeface.caption).foregroundStyle(.secondary)
                }
            }
            if !error.isEmpty { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Palette.danger).textSelection(.enabled) }
            HStack(spacing: Space.m) {
                Spacer()
                Button("Cancel") { if dirty { confirmingDiscard = true } else { dismiss() } }.pillButton().keyboardShortcut(.cancelAction).disabled(sending)
                Button(sending ? "Sending…" : intent == "information" ? "Save Information" : intent == "question" ? "Ask Question" : "Send Job", systemImage: "arrow.up") { Task { await send() } }
                    .glassPillButton().morphs(on: sending).disabled(!canSend)
            }
        }.padding(WorkspaceStyle.panelPadding).frame(width: WorkspaceStyle.sheetWidth).disabled(sending).interactiveDismissDisabled(sending || dirty)
        .onChange(of: role) { pickedAgent = nil }
        .onChange(of: intent) { pickedAgent = nil }
        .onChange(of: directory) { if destination.hasPrefix("mission:") { destination = "project" } }
        .alert("Discard this job draft?", isPresented: $confirmingDiscard) {
            Button("Keep Editing", role: .cancel) {}
            Button("Discard Draft", role: .destructive) { dismiss() }
        } message: { Text("Your instructions and job options have not been sent.") }
    }
    private var assignedTo: some View {
        field("Assigned to") {
            if dispatch.holders.count > 1 {
                Picker("Assigned to", selection: Binding(get: { dispatch.agent ?? "" }, set: { pickedAgent = $0.isEmpty ? nil : $0 })) {
                    if dispatch.agent == nil { Text("Claude (lead)").tag("") }
                    ForEach(dispatch.holders, id: \.self) { holder in Text(workerLabel(holder)).tag(holder) }
                }.labelsHidden().fixedSize()
            } else {
                Text(dispatch.agent.map(workerLabel) ?? (dispatch.requiresClaude ? "Claude (lead)" : "No agent assigned"))
                    .font(Typeface.body).frame(minHeight: Self.fieldHeight)
            }
        }
    }
    private func workerLabel(_ agent: String) -> String {
        "\(store.state.agents[agent]?.name ?? agentName(agent))\(store.state.agents[agent]?.enabled == false ? " (disabled)" : "")"
    }
    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(title).font(Typeface.captionStrong).foregroundStyle(.secondary)
            content()
        }
    }
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.prompt = "Choose Project"
        if panel.runModal() == .OK, let url = panel.url { directory = url.path }
    }
    private func send() async {
        guard canSend else { return }
        let allowed = targets.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if intent == "command" && role == "polish" && allowed.isEmpty { error = "List the files or directories the editor may change."; return }
        sending = true; error = ""
        let cwd = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if intent == "information" {
                try await store.addInformation(task, mission: destination.hasPrefix("mission:") ? String(destination.dropFirst(8)) : nil, project: destination == "shared" ? nil : cwd)
                dismiss()
            } else if intent == "question" {
                let job = try await store.submitQuestion(task, project: cwd, agent: dispatch.submissionAgent)
                store.openJob(job.id, navigate: true); dismiss()
            } else {
                guard let selectedRole else { throw CrewFailure("Choose a role for this job.") }
                let job: Job = try await store.api.post("/api/jobs", JobSubmission(role: selectedRole, cwd: cwd, project: cwd, task: task, targets: role == "polish" ? allowed : nil, agent: dispatch.submissionAgent))
                store.applyJob(job, since: 0); store.openJob(job.id, navigate: true); dismiss()
            }
        } catch { self.error = error.localizedDescription }
        sending = false
    }
}
