import SwiftUI
import AppKit
import TempoCore

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var excluded = ""
    @State private var clearActivity = false
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            PageHeading(eyebrow: "On your terms", title: "Your time. Your boundaries.", subtitle: "Control what Time Capture sees, what it keeps, and what leaves your machine.")
            Panel {
                VStack(alignment: .leading, spacing: 23) {
                    Text("Desktop capture").font(Theme.body(17, weight: .medium))
                    setting("Capture app activity", detail: "Records the foreground app and duration across your Mac. Start and stop at any time.") {
                        Toggle("Capture app activity", isOn: Binding(get: { model.workspace.preferences.captureEnabled }, set: model.setCapture)).labelsHidden().toggleStyle(.switch).disabled(model.isDemo)
                    }
                    Divider()
                    setting("Include window titles", detail: "Optional context such as document names. Titles may contain sensitive information. Requires Accessibility permission.") {
                        Toggle("Include window titles", isOn: Binding(get: { model.workspace.preferences.captureTitles }, set: { value in model.change { $0.closeActivity(at: Date(), reason: "privacy-change"); $0.preferences.captureTitles = value } })).labelsHidden().toggleStyle(.switch)
                    }
                    if model.workspace.preferences.captureTitles {
                        HStack { Image(systemName: model.accessibilityGranted ? "checkmark.shield" : "lock.shield"); Text(model.accessibilityGranted ? "Accessibility permission granted" : "App-only capture works without this permission.").font(Theme.body(12)); Spacer(); if !model.accessibilityGranted { Button("Grant Accessibility access") { model.requestAccessibility() }.buttonStyle(QuietButton()) } }.foregroundStyle(Theme.accent)
                    }
                    Divider()
                    setting("Idle timeout", detail: "Stops capture and your timer at the last input after this much inactivity. Timers resume only when you start them.") {
                        Picker("Idle timeout", selection: Binding(get: { model.workspace.preferences.idleMinutes }, set: { value in model.change { $0.preferences.idleMinutes = value } })) { ForEach([1, 3, 5, 10, 15], id: \.self) { Text("\($0) minutes").tag($0) } }.labelsHidden().frame(width: 130)
                    }
                    setting("Activity retention", detail: "Older raw activity is removed automatically. Saved time entries and projects are kept.") {
                        Picker("Activity retention", selection: Binding(get: { model.workspace.preferences.retentionDays }, set: { value in model.change { $0.preferences.retentionDays = value; $0.prune(now: Date()) } })) { ForEach([7, 14, 30, 90], id: \.self) { Text("\($0) days").tag($0) } }.labelsHidden().frame(width: 130)
                    }
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Apps that stay private").font(Theme.body(17, weight: .medium))
                    Text("Excluded apps are skipped before any window title is read. Add an app from your Mac, or enter its bundle identifier.").font(Theme.body(12)).foregroundStyle(Theme.muted)
                    FlowExclusions()
                    HStack {
                        TextField("com.example.private-app", text: $excluded).textFieldStyle(.roundedBorder).frame(maxWidth: 350)
                        Button("Exclude") {
                            let value = excluded.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard value.contains("."), !value.contains(" ") else { model.error = "Enter an app bundle identifier, such as com.apple.Safari."; return }
                            addExclusion(value); excluded = ""
                        }.buttonStyle(QuietButton())
                        Button("Choose app…") {
                            let panel = NSOpenPanel(); panel.allowedContentTypes = [.application]; panel.directoryURL = URL(fileURLWithPath: "/Applications"); panel.canChooseDirectories = false
                            guard panel.runModal() == .OK, let url = panel.url, let id = Bundle(url: url)?.bundleIdentifier else { return }
                            addExclusion(id)
                        }.buttonStyle(QuietButton())
                    }
                    Text("Browser capture sees the browser as an app. It cannot distinguish private browsing windows; exclude a browser if you don’t want it captured.").font(Theme.body(11)).foregroundStyle(Theme.muted)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Your data belongs here").font(Theme.body(17, weight: .medium))
                    Text("No account, telemetry, cloud sync, screenshots, keystroke recording, or network service. Data is stored as a local file protected by your macOS account permissions; it is not separately encrypted.").font(Theme.body(12)).foregroundStyle(Theme.muted).lineSpacing(4)
                    Text(model.file.url.path).font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.muted).textSelection(.enabled)
                    HStack(spacing: 10) {
                        Button("Export all time") { model.exportCSV(entries: model.workspace.entries) }.buttonStyle(QuietButton())
                        Button("Save backup") { model.backup() }.buttonStyle(QuietButton())
                        Button("Restore backup") { model.restore() }.buttonStyle(QuietButton())
                        Button("Show data folder") { NSWorkspace.shared.activateFileViewerSelecting([model.file.url]) }.buttonStyle(QuietButton())
                        Spacer()
                        Button("Clear activity…", role: .destructive) { clearActivity = true }.buttonStyle(QuietButton())
                    }
                }
            }
            Panel {
                HStack(spacing: 20) {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(Theme.body(27)).foregroundStyle(Theme.muted)
                    VStack(alignment: .leading, spacing: 7) { Text("Room to connect.").font(Theme.body(16, weight: .medium)); Text("Kiwi and Lawdie CRM integrations are planned. This version works independently, and no data is sent to either app.").font(Theme.body(12)).foregroundStyle(Theme.muted) }
                    Spacer(); Text("COMING LATER").font(Theme.body(9, weight: .semibold)).tracking(1.5).foregroundStyle(Theme.muted)
                }
            }
        }
        .confirmationDialog("Clear all captured desktop activity?", isPresented: $clearActivity) {
            Button("Clear activity", role: .destructive) { model.change { $0.activities = []; $0.currentActivity = nil; $0.preferences.captureEnabled = false }; model.notice = "Activity cleared and capture paused. Saved time entries are unchanged." }
        } message: { Text("This removes raw activity and pauses capture. Saved time entries and projects are kept.") }
    }
    private func setting<Content: View>(_ title: String, detail: String, @ViewBuilder control: () -> Content) -> some View {
        HStack(spacing: 30) { VStack(alignment: .leading, spacing: 7) { Text(title).font(Theme.body(13, weight: .medium)); Text(detail).font(Theme.body(11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }; Spacer(); control() }
    }
    private func addExclusion(_ id: String) {
        model.change { state in if !state.preferences.excludedBundleIDs.contains(id) { state.preferences.excludedBundleIDs.append(id) }; if state.currentActivity?.bundleID == id { state.currentActivity = nil } }
    }
}

struct FlowExclusions: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 270), alignment: .leading)], alignment: .leading, spacing: 9) {
            ForEach(model.workspace.preferences.excludedBundleIDs, id: \.self) { id in
                HStack { Text(id).font(.system(size: 10, design: .monospaced)).lineLimit(1); Spacer(); Button { model.change { $0.preferences.excludedBundleIDs.removeAll { $0 == id } } } label: { Image(systemName: "xmark").font(Theme.body(9)) }.buttonStyle(.plain).help("Stop excluding \(id)") }.foregroundStyle(Theme.muted).padding(10).background(Theme.raised, in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }
}
