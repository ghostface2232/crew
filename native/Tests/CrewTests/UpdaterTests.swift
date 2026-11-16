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
}
