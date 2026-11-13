import SwiftUI

struct DispatchView: View {
    @Bindable var store: CrewStore
    @Environment(\.dismiss) private var dismiss
    @State private var directory: String
    @State private var role = "delegate"
    @State private var targets = ""
    @State private var task = ""
    @State private var sending = false
    @State private var error = ""
    @State private var confirmingDiscard = false
    private let initialDirectory: String
    init(store: CrewStore) { self.store = store; initialDirectory = store.project; _directory = State(initialValue: store.project) }
    private var dirty: Bool { !task.isEmpty || !targets.isEmpty || role != "delegate" || directory != initialDirectory }
    private var worker: Worker? { store.state.roles[role].flatMap { store.state.agents[$0.agent] } }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label("New Job", systemImage: "paperplane").font(Typeface.title)
                .labelStyle(.titleAndIcon).symbolRenderingMode(.hierarchical)
            VStack(alignment: .leading, spacing: 16) {
                field("Project") {
                    HStack(spacing: 8) {
                        TextField("Project directory", text: $directory, prompt: Text("/path/to/repository"))
                            .textFieldStyle(.roundedBorder).labelsHidden().accessibilityLabel("Project directory")
                        Button("Choose…", systemImage: "folder") { chooseFolder() }.accessibilityLabel("Choose project directory")
                    }
                }
                HStack(alignment: .top, spacing: 24) {
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
                field(role == "review" ? "What should be checked?" : "What needs to be done?") {
                    MessageEditor(title: "New job instructions", text: $task)
                    Text(role == "review" ? "Reviews uncommitted changes in read-only mode." : "Changes stay on an isolated worktree branch until reviewed and merged.")
                        .font(Typeface.caption).foregroundStyle(.secondary)
                }
            }
            if !error.isEmpty { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).textSelection(.enabled) }
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { if dirty { confirmingDiscard = true } else { dismiss() } }.keyboardShortcut(.cancelAction).disabled(sending)
                Button(sending ? "Sending…" : "Send Job", systemImage: "arrow.up") { Task { await send() } }
                    .buttonStyle(.glassProminent).disabled(sending || !store.connected || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || directory.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || worker?.enabled != true)
            }
        }.padding(24).frame(width: 560).disabled(sending).interactiveDismissDisabled(sending || dirty)
        .alert("Discard this job draft?", isPresented: $confirmingDiscard) {
            Button("Keep Editing", role: .cancel) {}
            Button("Discard Draft", role: .destructive) { dismiss() }
        } message: { Text("Your instructions and job options have not been sent.") }
    }
    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
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
        if role == "polish" && allowed.isEmpty { error = "List the files or directories the editor may change."; return }
        sending = true; error = ""
        let cwd = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let job: Job = try await store.api.post("/api/jobs", JobSubmission(kind: role, cwd: cwd, project: cwd, task: task, targets: role == "polish" ? allowed : nil, review: role == "review" ? .init() : nil))
            store.applyJob(job, since: 0); store.openJob(job.id, navigate: true); dismiss()
        } catch { self.error = error.localizedDescription }
        sending = false
    }
}
