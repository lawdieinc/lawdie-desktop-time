import AppKit
import SwiftUI
import TempoCore

@main
struct TempoApp: App {
    init() { Theme.registerFonts() }
    @NSApplicationDelegateAdaptor(TempoDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    var body: some Scene {
        Window("Lawdie Time Capture", id: "main") {
            RootView().environmentObject(model)
                .onAppear { delegate.model = model }
                .frame(minWidth: 1080, minHeight: 720)
                .ignoresSafeArea(.container, edges: .top)
                .preferredColorScheme(.light)
        }
        .defaultSize(width: 1360, height: 900)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("New time entry") { model.editingEntry = nil; model.reviewingActivity = nil; model.showEntry = true }.keyboardShortcut("n", modifiers: [.command])
                Button("Start / stop timer") { model.toggleTimer() }.keyboardShortcut("t", modifiers: [.command, .shift])
                Button("Pause / resume activity capture") { model.setCapture(!model.workspace.preferences.captureEnabled) }.keyboardShortcut("p", modifiers: [.command, .shift])
            }
        }
        MenuBarExtra {
            MenuBarView().environmentObject(model)
        } label: {
            if let timer = model.workspace.timer {
                Label(Format.duration(model.now.timeIntervalSince(timer.startedAt), clock: true), systemImage: "timer")
            } else { Label("Lawdie Time Capture", systemImage: "waveform.path") }
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class TempoDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    func applicationWillTerminate(_ notification: Notification) { model?.shutdown() }
}

struct MenuBarView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text("LAWDIE TIME CAPTURE").font(.system(size: 12, weight: .bold, design: .rounded)).tracking(3); Spacer(); Text("LOCAL").font(.caption2).foregroundStyle(.secondary) }
            if let timer = model.workspace.timer {
                Text(timer.description).font(.headline)
                Text(Format.duration(model.now.timeIntervalSince(timer.startedAt), clock: true)).font(.system(size: 36, weight: .light, design: .monospaced))
                Button("Stop & save") { model.toggleTimer() }.buttonStyle(.borderedProminent).tint(Theme.accent)
            } else {
                Text("Make time count.").font(.title2)
                TextField("What are you working on?", text: $model.timerDescription).textFieldStyle(.roundedBorder)
                Button("Start timer") { model.toggleTimer() }.disabled(model.timerDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).buttonStyle(.borderedProminent).tint(Theme.accent)
            }
            Divider()
            Toggle("Capture desktop activity", isOn: Binding(get: { model.workspace.preferences.captureEnabled }, set: model.setCapture))
            if let error = model.error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Open Time Capture") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
                Spacer()
                Button("Quit") { model.shutdown(); NSApp.terminate(nil) }
            }
        }.padding(22).frame(width: 320).preferredColorScheme(.light)
    }
}
