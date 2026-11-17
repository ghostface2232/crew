import Foundation
import Testing
@testable import Crew

@Suite struct UpdaterTests {
    private func release(_ version: String, url: String? = nil, digest: String = String(repeating: "a", count: 64), extra: [String: Any] = [:]) throws -> Data {
        let link = url ?? "https://github.com/ghostface2232/crew/releases/download/v\(version)/\(Releases.assetName(version))"
        var body: [String: Any] = [
            "tag_name": "v\(version)", "draft": false, "prerelease": false,
            "html_url": "https://github.com/ghostface2232/crew/releases/tag/v\(version)",
            "assets": [["name": Releases.assetName(version), "browser_download_url": link, "digest": "sha256:\(digest)"]],
        ]
        body.merge(extra) { $1 }
        return try JSONSerialization.data(withJSONObject: body)
    }

    @Test func takesOnlyAPublishedReleaseWithThisMacsArchiveAndADigest() throws {
        let found = try #require(Releases.parse(try release("0.3.0")))
        #expect(found.version == "0.3.0")
        #expect(found.sha256 == String(repeating: "a", count: 64))
        #expect(found.url.lastPathComponent == "Crew-macOS-\(Releases.arch)-0.3.0.zip")
        #expect(found.page?.absoluteString == "https://github.com/ghostface2232/crew/releases/tag/v0.3.0")
        #expect(Releases.parse(try release("0.3.0", extra: ["draft": true])) == nil)
        #expect(Releases.parse(try release("0.3.0", extra: ["prerelease": true])) == nil)
        #expect(Releases.parse(try release("0.3.0", digest: "short")) == nil)
        #expect(Releases.parse(try release("0.3.0", extra: ["tag_name": "v0.3.0-beta"])) == nil)
        // Only HTTPS, or a loopback server for testing.
        #expect(Releases.parse(try release("0.3.0", url: "http://example.com/Crew.zip")) == nil)
        #expect(Releases.parse(try release("0.3.0", url: "http://127.0.0.1:9/Crew.zip")) != nil)
        #expect(Releases.parse(Data("not json".utf8)) == nil)
    }

    @Test func comparesDottedVersions() {
        #expect(Releases.isNewer("0.10.0", than: "0.9.9"))
        #expect(Releases.isNewer("1.0", than: "0.99.99"))
        #expect(!Releases.isNewer("0.2.0", than: "0.2"))
        #expect(!Releases.isNewer("0.1.9", than: "0.2.0"))
        #expect(Releases.isVersion("1.2.3") && !Releases.isVersion("1.2.") && !Releases.isVersion("v1") && !Releases.isVersion("1.٣"))
    }

    @Test func hashesAFileInChunks() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "crew-updater-\(UUID().uuidString)")
        try Data("abc".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        #expect(try AppUpdater.sha256(of: file) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @MainActor @Test func aCopyOutsideAnAppBundleCannotUpdateAndLeavesStagedFilesAlone() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "crew-updater-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let updates = home.appending(path: "desktop/updates")
        try FileManager.default.createDirectory(at: updates, withIntermediateDirectories: true)
        let archive = Data("archive".utf8)
        try archive.write(to: updates.appending(path: Releases.assetName("9.9.9")))
        let sha = try AppUpdater.sha256(of: updates.appending(path: Releases.assetName("9.9.9")))
        try JSONSerialization.data(withJSONObject: ["version": "9.9.9", "sha256": sha]).write(to: updates.appending(path: "staged.json"))
        let environment = ["CREW_HOME": home.path]
        // The test runner is no app bundle, so this updater is unsupported and leaves the folder alone.
        let unsupported = AppUpdater(environment: environment)
        await unsupported.load()
        #expect(unsupported.phase == .unsupported)
        #expect(FileManager.default.fileExists(atPath: updates.appending(path: "staged.json").path))
        #expect(unsupported.summary == "Updates come with the Crew app bundle")
    }

    private func appBundle(in home: URL) throws -> Bundle {
        let app = home.appending(path: "Crew.app")
        let contents = app.appending(path: "Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "dev.crew.native", "CFBundleShortVersionString": "0.2.3"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appending(path: "Info.plist"))
        return try #require(Bundle(url: app))
    }

    @MainActor @Test(arguments: [false, true]) func loadsHelperFailureBeforeCleaning(keepArchive: Bool) async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "crew-updater-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let bundle = try appBundle(in: home)
        let updates = home.appending(path: "desktop/updates")
        try FileManager.default.createDirectory(at: updates, withIntermediateDirectories: true)
        let updater = AppUpdater(environment: ["CREW_HOME": home.path], bundle: bundle)
        try "The updated Crew app could not open.\n".write(to: updater.failureReport, atomically: true, encoding: .utf8)
        if keepArchive {
            let archive = updates.appending(path: Releases.assetName("0.3.0"))
            try Data("archive".utf8).write(to: archive)
            try JSONSerialization.data(withJSONObject: ["version": "0.3.0", "sha256": AppUpdater.sha256(of: archive)])
                .write(to: updates.appending(path: "staged.json"))
        } else {
            // Cleanup from another operation must not consume the helper's report.
            updater.discard("Earlier failure")
            #expect(FileManager.default.fileExists(atPath: updater.failureReport.path))
        }
        await updater.load()
        #expect(updater.phase == (keepArchive ? .ready : .idle))
        #expect(updater.error == "Could not install the update: The updated Crew app could not open.")
        #expect(!FileManager.default.fileExists(atPath: updater.failureReport.path))
        let next = AppUpdater(environment: ["CREW_HOME": home.path], bundle: bundle)
        await next.load()
        #expect(next.error == nil)
    }

    @MainActor @Test func invalidArchiveIsDiscardedInsteadOfRetried() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "crew-updater-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let bundle = try appBundle(in: home)
        let updates = home.appending(path: "desktop/updates")
        try FileManager.default.createDirectory(at: updates, withIntermediateDirectories: true)
        let archive = updates.appending(path: Releases.assetName("0.3.0"))
        try Data("not a zip archive".utf8).write(to: archive)
        try JSONSerialization.data(withJSONObject: ["version": "0.3.0", "sha256": AppUpdater.sha256(of: archive)])
            .write(to: updates.appending(path: "staged.json"))
        let updater = AppUpdater(environment: ["CREW_HOME": home.path], bundle: bundle)
        await updater.load()
        #expect(updater.phase == .ready)
        #expect(updater.installing())
        do {
            _ = try AppUpdater.handOver(archive: archive, version: "0.3.0", installed: bundle.bundleURL, processID: 0, result: updater.failureReport)
            Issue.record("An invalid archive must not start the helper")
        } catch let error as AppUpdater.InvalidArchive {
            updater.discard(error.localizedDescription)
        }
        #expect(updater.phase == .idle)
        #expect(updater.latest == nil && updater.archive == nil)
        #expect(updater.error == "The downloaded update is not a valid Crew 0.3.0.")
        #expect(try FileManager.default.contentsOfDirectory(atPath: updates.path).isEmpty)
    }

    @Test func replacementRequiresAWritableBundleAndParent() throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "crew-updater-\(UUID().uuidString)")
        let bundle = try appBundle(in: home)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: home.path)
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundle.bundleURL.path)
            try? FileManager.default.removeItem(at: home)
        }
        #expect(AppUpdater.canReplace(installed: bundle.bundleURL) == nil)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: bundle.bundleURL.path)
        #expect(AppUpdater.canReplace(installed: bundle.bundleURL) != nil)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundle.bundleURL.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: home.path)
        #expect(AppUpdater.canReplace(installed: bundle.bundleURL) != nil)
    }

    @Test(arguments: ["success", "open-failure", "leftover-backup", "quit-timeout"]) func swapKeepsTheOriginalOnFailure(scenario: String) throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "crew-swap-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let target = home.appending(path: "Crew.app"), staged = home.appending(path: "staged.app")
        let work = home.appending(path: "work"), commands = home.appending(path: "bin")
        let backup = URL(fileURLWithPath: target.path + ".previous")
        let result = home.appending(path: "failed.txt")
        for directory in [target, staged, work, commands] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try "old".write(to: target.appending(path: "version"), atomically: true, encoding: .utf8)
        try "new".write(to: staged.appending(path: "version"), atomically: true, encoding: .utf8)
        if scenario == "leftover-backup" { try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true) }
        let scripts = [
            "open": """
            #!/bin/sh
            printf '%s\\n' "$*" >> "$OPEN_LOG"
            if [ "$SCENARIO" = open-failure ] && [ "$3" = --updated ]; then exit 1; fi
            exit 0
            """,
            // Fault injection leaves the backup in place even when its parent is writable.
            "rm": """
            #!/bin/sh
            if [ "$SCENARIO" = leftover-backup ]; then
                for arg in "$@"; do [ "$arg" = "$BACKUP" ] && exit 1; done
            fi
            exec /bin/rm "$@"
            """,
            "sleep": "#!/bin/sh\nexit 0\n",
        ]
        for (name, text) in scripts {
            let file = commands.appending(path: name)
            try text.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        let script = work.appending(path: "swap.sh")
        try AppUpdater.swapScript.write(to: script, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        let pid = scenario == "quit-timeout" ? String(ProcessInfo.processInfo.processIdentifier) : "2147483647"
        process.arguments = [script.path, pid, target.path, staged.path, work.path, result.path]
        process.environment = ["PATH": "\(commands.path):/usr/bin:/bin", "SCENARIO": scenario, "BACKUP": backup.path, "OPEN_LOG": home.appending(path: "open.log").path]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == (scenario == "success" ? 0 : 1))
        #expect(try String(contentsOf: target.appending(path: "version"), encoding: .utf8) == (scenario == "success" ? "new" : "old"))
        #expect(!FileManager.default.fileExists(atPath: backup.appending(path: "Crew.app").path))
        #expect(!FileManager.default.fileExists(atPath: staged.path) && !FileManager.default.fileExists(atPath: work.path))
        if scenario == "success" {
            #expect(!FileManager.default.fileExists(atPath: backup.path) && !FileManager.default.fileExists(atPath: result.path))
        } else {
            let reason = try String(contentsOf: result, encoding: .utf8)
            #expect(reason.split(separator: "\n").count == 1)
            if scenario == "quit-timeout" { #expect(reason.contains("did not quit")) }
        }
        if scenario != "quit-timeout" {
            let opened = try String(contentsOf: home.appending(path: "open.log"), encoding: .utf8)
            #expect(opened.split(separator: "\n").count == (scenario == "open-failure" ? 2 : 1))
        }
    }
}
