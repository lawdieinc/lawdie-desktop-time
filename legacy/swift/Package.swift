// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "LawdieTempo",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Tempo", targets: ["Tempo"])],
    targets: [
        .target(name: "TempoCore"),
        .executableTarget(name: "Tempo", dependencies: ["TempoCore"], resources: [.process("Resources")]),
        .executableTarget(name: "TempoCoreChecks", dependencies: ["TempoCore"], path: "Tests/TempoCoreTests")
    ]
)
