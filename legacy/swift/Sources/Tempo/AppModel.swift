import AppKit
import ApplicationServices
import SwiftUI
import TempoCore
import UniformTypeIdentifiers

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workspace = Workspace()
    @Published var now = Date()
    @Published var error: String?
    @Published var notice: String?
    @Published private(set) var loadFailed = false
    @Published private(set) var accessibilityGranted = AXIsProcessTrusted()
    @Published var route: Route = .today
    @Published var showEntry = false
    @Published var editingEntry: TimeEntry?
    @Published var reviewingActivity: Activity?
    @Published var showProject = false
    @Published var editingProject: Project?
    @Published var timerDescription = ""
    @Published var timerProject: UUID?
    @Published var timerBillable = true
    /// A Kiwi hello or sync is in flight (see KiwiSync.swift).
    @Published var syncing = false
    let file: WorkspaceFile
    let isDemo: Bool
    private var pulse: Timer?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var suspended = false
    private var ticks = 0
    private var workspaceLock: WorkspaceLock?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        isDemo = arguments.contains("--demo") || Bundle.main.bundleIdentifier == "co.lawdie.timecapture.desktop.demo"
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // `--workspace <path>` runs against another real workspace file (verification,
        // a second account) without touching the one in Application Support.
        if let index = arguments.firstIndex(of: "--workspace"), arguments.count > index + 1, !isDemo {
            file = WorkspaceFile(url: URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL)
        } else {
            file = WorkspaceFile(url: support.appendingPathComponent(isDemo ? "Lawdie Time Capture Demo/workspace.json" : "Lawdie Time Capture/workspace.json"))
        }
        // `--route Settings` opens on that screen (verification screenshots).
        if let index = arguments.firstIndex(of: "--route"), arguments.count > index + 1, let start = Route(rawValue: arguments[index + 1]) { route = start }
        do {
            if !isDemo { workspaceLock = try WorkspaceLock(directory: file.url.deletingLastPathComponent()) }
            let legacy = support.appendingPathComponent("Lawdie Tempo/workspace.json")
            if !isDemo, !FileManager.default.fileExists(atPath: file.url.path), FileManager.default.fileExists(atPath: legacy.path) {
                let legacyLock = try WorkspaceLock(directory: legacy.deletingLastPathComponent())
                workspace = try WorkspaceFile(url: legacy).load()
                try file.save(workspace)
                withExtendedLifetime(legacyLock) {}
            } else {
                workspace = isDemo ? Self.demoWorkspace() : try file.load()
            }
            let recovered = workspace.timer != nil
            workspace.recover(now: now)
            if !isDemo { try file.save(workspace) }
            if recovered { notice = "Your previous timer was saved at its last heartbeat. Start a new timer when you’re ready." }
        } catch { loadFailed = true; self.error = "Could not open your workspace. Your file has been left untouched. \(error.localizedDescription)" }
        pulse = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        if let pulse { RunLoop.main.add(pulse, forMode: .common) }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            observe(center, name) { [weak self] in self?.suspend() }
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
            observe(center, name) { [weak self] in self?.suspended = false; self?.sample() }
        }
        observe(center, NSWorkspace.didActivateApplicationNotification) { [weak self] in self?.sample() }
        // Session notifications vary across macOS releases; also cover explicit screen locking.
        let distributed = DistributedNotificationCenter.default()
        observe(distributed, Notification.Name("com.apple.screenIsLocked")) { [weak self] in self?.suspend() }
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked")) { [weak self] in self?.suspended = false; self?.sample() }
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name, action: @escaping @MainActor () -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { _ in Task { @MainActor in action() } }
        observers.append((center, token))
    }

    @discardableResult
    func change(_ mutation: (inout Workspace) throws -> Void) -> Bool {
        guard !loadFailed else { error = "The workspace could not be loaded. Restore a backup or repair the file before making changes."; return false }
        do {
            var next = workspace
            try mutation(&next)
            if !isDemo { try file.save(next) }
            workspace = next
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    private func tick() {
        now = Date(); ticks += 1
        if ticks % 5 == 0 { accessibilityGranted = AXIsProcessTrusted(); sample() }
        if ticks % 3600 == 0 { change { $0.prune(now: now) } }
        syncTick(ticks)
    }

    func sample() {
        guard !isDemo, !loadFailed else { return }
        let date = Date()
        let foreground = NSWorkspace.shared.frontmostApplication
        let bundleID = foreground?.bundleIdentifier
        var title: String?
        // Check exclusions BEFORE reading any accessibility metadata.
        if workspace.preferences.captureEnabled, workspace.preferences.captureTitles, accessibilityGranted,
           let foreground, let bundleID, bundleID != "co.lawdie.timecapture.desktop",
           !workspace.preferences.excludedBundleIDs.contains(bundleID) {
            let app = AXUIElementCreateApplication(foreground.processIdentifier)
            AXUIElementSetMessagingTimeout(app, 0.15)
            var window: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window) == .success,
               let window, CFGetTypeID(window) == AXUIElementGetTypeID() {
                let element = unsafeBitCast(window, to: AXUIElement.self)
                var value: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value) == .success,
                   let text = value as? String { title = String(text.prefix(300)) }
            }
        }
        // kCGAnyInputEventType covers keyboard, mouse and tablet input. `.null`
        // is a specific event type, not a wildcard, and reports spurious idle time.
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        let previousTimer = workspace.timer
        var next = workspace
        next.observe(app: foreground?.localizedName, bundleID: bundleID, title: title, now: date, idleSeconds: idle, suspended: suspended)
        if next != workspace {
            let didSave = change { $0 = next }
            if didSave, previousTimer != nil, next.timer == nil { notice = "Timer stopped at your last active moment. Your time is saved; restart when you’re ready." }
        }
    }

    func suspend() {
        suspended = true
        let date = Date()
        change { $0.closeActivity(at: date, reason: "suspended"); $0.stopTimer(at: date, source: "timer-suspended") }
    }

    func shutdown() {
        pulse?.invalidate()
        let date = Date()
        change { $0.closeActivity(at: date, reason: "quit"); $0.stopTimer(at: date) }
    }

    func toggleTimer() {
        if workspace.timer != nil { change { $0.stopTimer(at: Date()) } }
        else { change { try $0.startTimer(description: timerDescription, projectID: timerProject, billable: timerBillable, now: Date()) } }
    }

    func resume(_ entry: TimeEntry) {
        timerDescription = entry.description; timerProject = entry.projectID; timerBillable = entry.billable
        if workspace.timer == nil { toggleTimer() }
    }

    func setCapture(_ enabled: Bool) {
        change {
            $0.preferences.captureEnabled = enabled
            if !enabled { $0.closeActivity(at: Date(), reason: "paused") }
        }
        sample()
    }

    func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        accessibilityGranted = AXIsProcessTrustedWithOptions(options)
    }

    func exportCSV(entries: [TimeEntry]) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "lawdie-time-\(Date().formatted(.iso8601.year().month().day().dateSeparator(.dash))).csv"
        panel.allowedContentTypes = [.commaSeparatedText]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try Export.csv(workspace, entries: entries).write(to: url, atomically: true, encoding: .utf8); notice = "Time entries exported." }
        catch { self.error = error.localizedDescription }
    }

    func backup() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "lawdie-time-capture-backup.json"; panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            var copy = workspace; copy.recover(now: Date())
            try WorkspaceFile(url: url).save(copy)
            notice = "Backup saved. It includes your entries, projects, settings, and activity history."
        } catch { self.error = error.localizedDescription }
    }

    func restore() {
        guard isDemo || workspaceLock != nil else { error = "Quit the other Time Capture instance before restoring this workspace."; return }
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            var restored = try WorkspaceFile(url: url).load()
            restored.recover(now: Date()); restored.preferences.captureEnabled = false
            let alert = NSAlert()
            alert.messageText = "Replace this workspace with the backup?"
            alert.informativeText = "This backup contains \(restored.entries.count) entries and \(restored.projects.count) projects. A copy of your current workspace will be saved beside workspace.json before replacement. Capture will be paused."
            alert.addButton(withTitle: "Restore backup"); alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            if !isDemo {
                if FileManager.default.fileExists(atPath: file.url.path) {
                    let recovery = file.url.deletingLastPathComponent().appendingPathComponent("before-restore-\(UUID().uuidString).json")
                    try FileManager.default.copyItem(at: file.url, to: recovery)
                }
                try file.save(restored)
            }
            workspace = restored; loadFailed = false; error = nil; notice = "Workspace restored. Activity capture is paused."
        } catch { self.error = error.localizedDescription }
    }

    static func demoWorkspace() -> Workspace {
        var state = Workspace()
        let projects = [Project(name: "Whitfield v. Meridian", client: "Whitfield", color: "gold", hourlyRate: 350), Project(name: "Acme · General counsel", client: "Acme Corporation", color: "espresso", hourlyRate: 300), Project(name: "Practice operations", client: "Internal", color: "brown")]
        state.projects = projects
        let start = Date().addingTimeInterval(-7 * 3600)
        let names = ["Prepare motion for summary judgment", "Review commercial lease amendments", "Client strategy call", "Weekly planning & correspondence"]
        for i in 0..<4 {
            let date = start.addingTimeInterval(Double(i * 4800))
            state.entries.append(TimeEntry(description: names[i], projectID: projects[i % 3].id, startedAt: date, endedAt: date.addingTimeInterval(Double([4200, 3300, 1800, 2400][i])), billable: i != 3, hourlyRate: projects[i % 3].hourlyRate, source: i == 0 ? "desktop" : "timer"))
        }
        for i in 0..<3 {
            let date = start.addingTimeInterval(Double(21000 + i * 1200))
            state.activities.append(Activity(app: ["Microsoft Word", "Preview", "Microsoft Outlook"][i], bundleID: ["com.microsoft.Word", "com.apple.Preview", "com.microsoft.Outlook"][i], title: ["Motion draft · Whitfield", "Lease agreement.pdf", "Client correspondence"][i], startedAt: date, endedAt: date.addingTimeInterval(Double([1080, 780, 540][i]))))
        }
        return state
    }
}

enum Route: String, CaseIterable {
    case today = "Today", activity = "Activity", entries = "Time entries", projects = "Projects", reports = "Reports", settings = "Settings"
    var icon: String {
        switch self {
        case .today: "square.grid.2x2"
        case .activity: "waveform.path"
        case .entries: "clock"
        case .projects: "square.stack.3d.up"
        case .reports: "chart.bar.xaxis"
        case .settings: "slider.horizontal.3"
        }
    }
}
