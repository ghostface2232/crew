// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Crew",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "Crew", targets: ["Crew"])],
    targets: [
        .executableTarget(name: "Crew"),
        .testTarget(name: "CrewTests", dependencies: ["Crew"], resources: [.copy("Fixtures")]),
    ],
    swiftLanguageModes: [.v6]
)
