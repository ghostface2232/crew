import Foundation
import Testing

struct LocalizationTests {
    @Test func koreanStringsPreserveFormatArguments() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "Resources/ko.lproj/Localizable.strings")
        let data = try Data(contentsOf: url)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        let strings = try #require(plist as? [String: String])
        #expect(!strings.isEmpty)

        let format = try NSRegularExpression(pattern: #"%%|%(?:[0-9]+\$)?([-+ #0]*[0-9]*(?:\.[0-9]+)?(?:hh|ll|h|l|j|z|t|L)?[@diouxXfFeEgGaAcCsSp])"#)
        func specifiers(in text: String) -> Set<String> {
            let range = NSRange(location: 0, length: text.utf16.count)
            return Set(format.matches(in: text, range: range).compactMap { match in
                let capture = match.range(at: 1)
                guard capture.location != NSNotFound, let specifier = Range(capture, in: text) else { return nil }
                return String(text[specifier])
            })
        }

        for (key, value) in strings {
            #expect(!value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Empty translation for \(key)")
            #expect(specifiers(in: key) == specifiers(in: value), "Format arguments differ for \(key)")
        }
    }
}
