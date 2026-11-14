import SwiftUI

struct DispatchView: View {
    @Bindable var store: CrewStore
    @Environment(\.dismiss) private var dismiss
    @State private var directory: String
    @State private var intent = "command"
    @State private var destination = "project"
    @State private var role = "delegate"
    @State private var targets = ""
    @State private var task = ""
    @State private var sending = false
    @State private var error = ""
    @State private var confirmingDiscard = false
    private let initialDirectory: String
    init(store: CrewStore) { self.store = store; initialDirectory = store.project; _directory = State(initialValue: store.project) }
    private var dirty: Bool { intent != "command" || destination != "project" || !task.isEmpty || !targets.isEmpty || role != "delegate" || directory != initialDirectory }
    private var worker: Worker? { store.state.roles[intent == "question" ? "delegate" : role].flatMap { store.state.agents[$0.agent] } }
    private var missions: [Mission] { store.state.missions.filter { $0.state == "active" && $0.root == directory.trimmingCharacters(in: .whitespacesAndNewlines) } }
    private var canSend: Bool {
        guard !sending, store.connected, !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if intent == "information" && destination == "shared" { return true }
        guard !directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if intent == "information" {
            return destination == "project" || missions.contains { "mission:\($0.id)" == destination }
        }
        return worker?.enabled == true
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
                        Button("Choose…", systemImage: "folder") { chooseFolder() }.accessibilityLabel("Choose project directory")
                    }
                }
                if intent == "command" {
                    HStack(alignment: .top, spacing: Space.x3l) {
                        field("Role") {
                            Picker("Role", selection: $role) { ForEach(roleOrder, id: \.self) { Text(roleNames[$0]!).tag($0) } }
                                .labelsHidden().fixedSize()
                        }
                        field("Assigned to") {
                            Text(worker.map { "\($0.name)\($0.enabled ? "" : " (disabled)")" } ?? "No agent assigned")
                                .font(Typeface.body).frame(minHeight: 22)
                        }
                    }
                    if role == "polish" {
                        field("Allowed files or directories") {
                            TextField("One path per line", text: $targets, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(3...6)
                        }
                    }
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
                field(intent == "question" ? "What would you like to know?" : intent == "information" ? "What should be remembered?" : role == "review" ? "What should be checked?" : "What needs to be done?") {
                    MessageEditor(title: "New job instructions", text: $task)
                    Text(intent == "information" ? "Adds information only. This starts no work." : intent == "question" ? "Answers the question in read-only mode." : role == "review" ? "Reviews uncommitted changes in read-only mode." : "Changes stay on an isolated worktree branch until reviewed and merged.")
                        .font(Typeface.caption).foregroundStyle(.secondary)
                }
            }
            if !error.isEmpty { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(Palette.danger).textSelection(.enabled) }
            HStack(spacing: Space.m) {
                Spacer()
                Button("Cancel") { if dirty { confirmingDiscard = true } else { dismiss() } }.pillButton().keyboardShortcut(.cancelAction).disabled(sending)
                Button(sending ? "Sending…" : intent == "information" ? "Save Information" : intent == "question" ? "Ask Question" : "Send Job", systemImage: "arrow.up") { Task { await send() } }
                    .glassPillButton().disabled(!canSend)
            }
        }.padding(WorkspaceStyle.panelPadding).frame(width: 560).disabled(sending).interactiveDismissDisabled(sending || dirty)
        .onChange(of: directory) { if destination.hasPrefix("mission:") { destination = "project" } }
        .alert("Discard this job draft?", isPresented: $confirmingDiscard) {
            Button("Keep Editing", role: .cancel) {}
            Button("Discard Draft", role: .destructive) { dismiss() }
        } message: { Text("Your instructions and job options have not been sent.") }
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
        guard !sending else { return }
        let allowed = targets.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if intent == "command" && role == "polish" && allowed.isEmpty { error = "List the files or directories the editor may change."; return }
        sending = true; error = ""
        let cwd = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if intent == "information" {
                try await store.addInformation(task, mission: destination.hasPrefix("mission:") ? String(destination.dropFirst(8)) : nil, project: destination == "shared" ? nil : cwd)
                dismiss()
            } else if intent == "question" {
                let job = try await store.submitQuestion(task, project: cwd)
                store.openJob(job.id, navigate: true); dismiss()
            } else {
                let job: Job = try await store.api.post("/api/jobs", JobSubmission(kind: role, cwd: cwd, project: cwd, task: task, targets: role == "polish" ? allowed : nil, review: role == "review" ? .init() : nil))
                store.applyJob(job, since: 0); store.openJob(job.id, navigate: true); dismiss()
            }
        } catch { self.error = error.localizedDescription }
        sending = false
    }
}
