import AppKit
import Foundation
import Testing
@testable import Crew

struct ProjectIconsTests {
    @Test func theTableHasSixGroupsOfTenDrawableIcons() {
        #expect(ProjectIcons.groups.count == 6)
        #expect(ProjectIcons.groups.allSatisfy { $0.icons.count == 10 })
        let keys = ProjectIcons.groups.flatMap(\.icons).map(\.key)
        #expect(Set(keys).count == 60)
        #expect(keys.first == ProjectIcons.folder)
        for key in keys {
            #expect(NSImage(systemSymbolName: key, accessibilityDescription: nil) != nil, "No symbol named \(key)")
            #expect(ProjectIcons.key(key) == key)
            #expect(NSImage(systemSymbolName: ProjectIcons.symbol(key), accessibilityDescription: nil) != nil)
        }
    }
    @Test func anUnsetOrUnknownIconIsTheFolder() {
        #expect(ProjectIcons.symbol(nil) == "folder")
        #expect(ProjectIcons.symbol("rocket.ship.unknown") == "folder")
        // A real symbol the table does not offer is another app's choice, so it also reads as the folder.
        #expect(ProjectIcons.symbol("trash") == "folder")
        #expect(ProjectIcons.filledSymbol(nil) == "folder.fill")
        #expect(ProjectIcons.filledSymbol("function") == "function")
    }
    @Test func aProjectsIconDecodesAndIsOptional() throws {
        let decoded = try JSONDecoder().decode([String: ProjectSettings].self, from: Data(#"{"/work/app":{"icon":"star","autonomy":true},"/work/other":{}}"#.utf8))
        #expect(decoded["/work/app"] == ProjectSettings(autonomy: true, icon: "star"))
        #expect(decoded["/work/other"]?.icon == nil)
    }
}
