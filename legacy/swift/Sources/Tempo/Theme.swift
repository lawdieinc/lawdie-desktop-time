import SwiftUI
import AppKit
import CoreText

enum BrandResources {
    static let bundle: Bundle = {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("LawdieTempo_Tempo.bundle"), let bundle = Bundle(url: url) { return bundle }
        return Bundle.module
    }()
}

struct LawdieWordmark: View {
    var body: some View {
        if let url = BrandResources.bundle.url(forResource: "lawdie-wordmark", withExtension: "png"), let image = NSImage(contentsOf: url) {
            Image(nsImage: image).resizable().scaledToFit().accessibilityLabel("Lawdie")
        } else {
            Text("Lawdie").font(Theme.display(26))
        }
    }
}

enum Theme {
    static let background = Color(hex: 0xF9F6F2)
    static let sidebar = Color(hex: 0xF3F0E8)
    static let panel = Color.white.opacity(0.72)
    static let raised = Color(hex: 0xF5F1EB)
    static let line = Color(hex: 0xD8D1C7).opacity(0.65)
    static let text = Color(hex: 0x3D3731)
    static let muted = Color(hex: 0x7C7366)
    static let accent = Color(hex: 0x8B5C2A)
    static func color(_ name: String) -> Color {
        switch name { case "espresso": Color(hex: 0x3D3731); case "brown": Color(hex: 0x8B7355); case "taupe": Color(hex: 0xA39B8F); case "stone": Color(hex: 0xC5BEB2); default: accent }
    }
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(weight == .semibold || weight == .bold || weight == .medium ? "SourceSansPro-Semibold" : "SourceSansPro-Regular", size: size)
    }
    static func display(_ size: CGFloat) -> Font { .custom("PlayfairDisplay-Regular", size: size).weight(.semibold) }
    static func label(_ size: CGFloat) -> Font { .custom("FragmentMono-Regular", size: size) }
    static func registerFonts() {
        for ext in ["ttf", "otf"] {
            for url in BrandResources.bundle.urls(forResourcesWithExtension: ext, subdirectory: nil) ?? [] {
                CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
            }
        }
    }
}

extension Color {
    init(hex: UInt32) { self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255) }
}

struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.body(13, weight: .semibold)).padding(.horizontal, 17).padding(.vertical, 12)
            .foregroundStyle(.white).background(Theme.accent.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 9)).opacity(enabled ? 1 : 0.45)
    }
}
struct QuietButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(Theme.body(12, weight: .medium)).padding(.horizontal, 13).padding(.vertical, 10)
            .background(configuration.isPressed ? Theme.raised : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
    }
}
struct Panel<Content: View>: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @ViewBuilder var content: Content
    var body: some View {
        content.padding(22)
            .background(reduceTransparency ? Color.white : Theme.panel, in: RoundedRectangle(cornerRadius: 14))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(LinearGradient(colors: [.white.opacity(0.95), Theme.line], startPoint: .topLeading, endPoint: .bottomTrailing)))
            .shadow(color: Theme.text.opacity(0.035), radius: 14, y: 6)
    }
}
struct Eyebrow: View {
    var text: String
    var body: some View { Text(text.uppercased()).font(Theme.label(9)).tracking(1.5).foregroundStyle(Theme.muted) }
}

struct BrandBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false
    var body: some View {
        Theme.background.overlay {
            GeometryReader { geometry in
                Ellipse().fill(Color(hex: 0xD8D1C7).opacity(0.38))
                    .frame(width: geometry.size.width * 0.8, height: geometry.size.height * 0.7)
                    .blur(radius: 100).offset(x: drift ? geometry.size.width * 0.4 : geometry.size.width * 0.15, y: drift ? -160 : -80)
            }.clipped()
        }.onAppear { if !reduceMotion { withAnimation(.easeInOut(duration: 15).repeatForever(autoreverses: true)) { drift = true } } }
    }
}
struct EmptyState: View {
    var icon: String
    var title: String
    var detail: String
    var body: some View {
        VStack(spacing: 13) {
            Image(systemName: icon).font(Theme.body(28, weight: .light)).foregroundStyle(Theme.accent).frame(width: 60, height: 60).background(Theme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            Text(title).font(Theme.body(17, weight: .medium))
            Text(detail).font(Theme.body(12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center).frame(maxWidth: 340)
        }.frame(maxWidth: .infinity).padding(.vertical, 42)
    }
}
