import AppKit
import SwiftUI
import TempoCore

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Theme.line).frame(width: 1)
            VStack(spacing: 0) {
                topbar
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        if model.isDemo { banner("Sample workspace · Demo data only. Desktop capture and disk writes are disabled.", icon: "sparkles") }
                        if model.loadFailed {
                            Panel {
                                EmptyState(icon: "externaldrive.badge.exclamationmark", title: "Your workspace needs attention", detail: "Time Capture could not read the workspace. The original file is preserved. Restore a backup to continue.")
                                Button("Restore backup") { model.restore() }.buttonStyle(PrimaryButton())
                            }
                        } else {
                            if let notice = model.notice { HStack { banner(notice, icon: "checkmark.circle"); Button { model.notice = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain) } }
                            switch model.route {
                            case .today: TodayView()
                            case .activity: ActivityView()
                            case .entries: EntriesView()
                            case .projects: ProjectsView()
                            case .reports: ReportsView()
                            case .settings: SettingsView()
                            }
                        }
                    }.padding(32).frame(maxWidth: 1500, alignment: .leading).frame(maxWidth: .infinity)
                        .id(model.route)
                        .transition(reduceMotion ? .identity : .opacity.combined(with: .offset(y: 8)))
                }
                .animation(reduceMotion ? nil : .timingCurve(0.25, 0.8, 0.25, 1, duration: 0.34), value: model.route)
            }
        }
        .background { BrandBackground() }.foregroundStyle(Theme.text).tint(Theme.accent).font(Theme.body(13))
        .sheet(isPresented: $model.showEntry) { EntryEditor(entry: model.editingEntry, activity: model.reviewingActivity).environmentObject(model) }
        .sheet(isPresented: $model.showProject) { ProjectEditor(project: model.editingProject).environmentObject(model) }
        .alert("Something needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 15) {
                LawdieWordmark().frame(width: 139, height: 26)
                Text("Time capture").font(Theme.display(22)).foregroundStyle(Theme.text)
            }.padding(.horizontal, 23).padding(.top, 48).padding(.bottom, 38)
            Eyebrow(text: "Workspace").padding(.horizontal, 24).padding(.bottom, 15)
            ForEach(Route.allCases.filter { $0 != .settings }, id: \.self) { route in nav(route) }
            Spacer()
            VStack(alignment: .leading, spacing: 12) {
                HStack { Circle().fill(model.workspace.preferences.captureEnabled ? Theme.accent : Theme.muted).frame(width: 6, height: 6); Text(model.workspace.preferences.captureEnabled ? "Capture is on" : "Capture is paused").font(Theme.body(12, weight: .medium)) }
                Text("Your time. On your machine.").font(Theme.body(11)).foregroundStyle(Theme.muted)
                Button(model.workspace.preferences.captureEnabled ? "Pause capture" : "Enable capture") { model.setCapture(!model.workspace.preferences.captureEnabled) }.buttonStyle(QuietButton()).disabled(model.isDemo || model.loadFailed)
            }.padding(17).frame(maxWidth: .infinity, alignment: .leading).background(Theme.raised.opacity(0.5), in: RoundedRectangle(cornerRadius: 12)).padding(16)
            nav(.settings)
            HStack(spacing: 10) {
                Text("L").font(Theme.body(12, weight: .semibold)).frame(width: 29, height: 29).background(Theme.raised, in: Circle())
                VStack(alignment: .leading, spacing: 3) { Text("Personal workspace").font(Theme.body(11, weight: .medium)); Text(model.workspace.sync?.accountEmail ?? (model.kiwiConnected ? "Synced to Kiwi" : "Local • No account needed")).font(Theme.body(10)).foregroundStyle(Theme.muted).lineLimit(1) }
            }.padding(22)
        }.frame(width: 218).background(Theme.sidebar)
    }

    private func nav(_ route: Route) -> some View {
        Button { model.route = route } label: {
            HStack(spacing: 12) {
                Image(systemName: route.icon).font(Theme.body(15)).frame(width: 20)
                Text(route.rawValue).font(Theme.body(13, weight: model.route == route ? .semibold : .regular))
                Spacer()
                if route == .activity {
                    let count = model.workspace.activities.filter { $0.disposition == "pending" }.count
                    if count > 0 { Text("\(count)").font(Theme.body(10, weight: .semibold)).padding(.horizontal, 6).padding(.vertical, 3).background(Theme.accent.opacity(0.12), in: Capsule()) }
                }
            }.foregroundStyle(model.route == route ? Theme.accent : Theme.muted).padding(.horizontal, 14).padding(.vertical, 13)
                .background(model.route == route ? Theme.accent.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain).padding(.horizontal, 12).padding(.bottom, 4)
    }

    private var topbar: some View {
        HStack {
            Text("Workspace").foregroundStyle(Theme.muted); Image(systemName: "chevron.right").font(Theme.body(9)); Text(model.route.rawValue)
            Spacer()
            Image(systemName: model.kiwiConnected ? "arrow.triangle.2.circlepath" : "internaldrive").foregroundStyle(model.workspace.sync?.lastError == nil ? Theme.accent : .red)
            Text(model.syncStatusLine).foregroundStyle(Theme.muted)
            Rectangle().fill(Theme.line).frame(width: 1, height: 16).padding(.horizontal, 12)
            Text(model.now.formatted(.dateTime.month(.abbreviated).day().year())).foregroundStyle(Theme.muted)
        }.font(Theme.body(11)).padding(.horizontal, 32).frame(height: 64).overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
    private func banner(_ text: String, icon: String) -> some View {
        HStack(spacing: 10) { Image(systemName: icon).foregroundStyle(Theme.accent); Text(text).font(Theme.body(12)).foregroundStyle(Theme.muted); Spacer() }.padding(13).background(Theme.raised, in: RoundedRectangle(cornerRadius: 9))
    }
}

struct PageHeading: View {
    var eyebrow: String
    var title: String
    var subtitle: String
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Eyebrow(text: eyebrow)
            Text(title).font(Theme.display(32)).tracking(-0.5)
            Text(subtitle).font(Theme.body(13)).foregroundStyle(Theme.muted)
        }
    }
}

struct TodayView: View {
    @EnvironmentObject var model: AppModel
    var todayEntries: [TimeEntry] {
        let day = Calendar.current.dateInterval(of: .day, for: model.now)!
        return model.workspace.entries.filter { $0.startedAt < day.end && $0.endedAt > day.start }.sorted { $0.startedAt > $1.startedAt }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 25) {
            HStack(alignment: .bottom) {
                PageHeading(eyebrow: model.now.formatted(.dateTime.weekday(.wide)), title: "Your day, accounted for.", subtitle: "Track your work across matters, documents, and desktop apps.")
                Spacer()
                Button { model.editingEntry = nil; model.reviewingActivity = nil; model.showEntry = true } label: { Label("Add time", systemImage: "plus") }.buttonStyle(QuietButton())
            }
            TimerCard()
            HStack(spacing: 14) {
                MetricCard(label: "Tracked today", value: Format.duration(model.workspace.seconds(on: model.now)), detail: "\(todayEntries.count) saved entries", icon: "clock", color: Theme.accent)
                MetricCard(label: "Billable time", value: Format.duration(model.workspace.seconds(on: model.now, billableOnly: true)), detail: "Ready for your next invoice", icon: "creditcard", color: Theme.color("espresso"))
                MetricCard(label: "To review", value: "\(model.workspace.activities.filter { $0.disposition == "pending" }.count)", detail: "Captured desktop activities", icon: "tray", color: Theme.color("brown"))
            }
            HStack(alignment: .top, spacing: 20) {
                Panel {
                    VStack(alignment: .leading, spacing: 19) {
                        HStack { Text("Your day, in focus").font(Theme.body(16, weight: .medium)); Spacer(); Text("TODAY").font(Theme.body(9, weight: .medium)).tracking(1.5).foregroundStyle(Theme.muted) }
                        DayTimeline(entries: todayEntries, workspace: model.workspace)
                        if todayEntries.isEmpty { EmptyState(icon: "sun.max", title: "A fresh start", detail: "Start a timer above, or add time you’ve already worked. Your day will take shape here.") }
                        else { ForEach(todayEntries.prefix(5)) { entry in EntryRow(entry: entry) } }
                        Button("View all time entries →") { model.route = .entries }.font(Theme.body(12)).foregroundStyle(Theme.accent).buttonStyle(.plain)
                    }
                }.frame(maxWidth: .infinity)
                VStack(spacing: 18) {
                    Panel {
                        VStack(alignment: .leading, spacing: 18) {
                            HStack { Image(systemName: "sparkle").foregroundStyle(Theme.accent); Text("Capture unrecorded work").font(Theme.body(14, weight: .medium)) }
                            Text("The document you edited. The brief you reviewed. Work happens beyond your browser.").font(Theme.body(13)).foregroundStyle(Theme.muted).lineSpacing(5)
                            Rectangle().fill(Theme.line).frame(height: 1)
                            HStack { Image(systemName: "lock.shield"); Text("Private by design") }.font(Theme.body(11, weight: .medium)).foregroundStyle(Theme.accent)
                            Text(model.kiwiConnected ? "Kept time syncs to Kiwi. You decide what becomes a time entry." : "Activity stays on this Mac. You decide what becomes a time entry.").font(Theme.body(11)).foregroundStyle(Theme.muted).lineSpacing(4)
                            Button { model.route = .activity } label: { HStack { Text("Review activity"); Spacer(); Image(systemName: "arrow.up.right") } }.buttonStyle(QuietButton())
                        }
                    }
                    HStack(spacing: 9) { Image(systemName: "command"); Text("⇧ T").font(.system(size: 11, design: .monospaced)); Text("to start or stop a timer").font(Theme.body(10)) }.foregroundStyle(Theme.muted)
                }.frame(width: 260)
            }
        }
    }
}

struct TimerCard: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            HStack { Circle().fill(Theme.accent).frame(width: 6, height: 6); Eyebrow(text: model.workspace.timer == nil ? "Make room for focused work" : "Focus in progress"); Spacer(); Image(systemName: "waveform.path").foregroundStyle(Theme.accent.opacity(0.5)) }
            HStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 15) {
                    if let timer = model.workspace.timer { Text(timer.description).font(Theme.body(22, weight: .medium)).lineLimit(2) }
                    else { TextField("What are you working on?", text: $model.timerDescription).font(Theme.body(22, weight: .regular)).textFieldStyle(.plain).onSubmit { if !model.timerDescription.isEmpty { model.toggleTimer() } } }
                    HStack(spacing: 15) {
                        Image(systemName: "folder").foregroundStyle(Theme.muted)
                        Picker("Project", selection: $model.timerProject) {
                            Text("No project").tag(nil as UUID?)
                            ForEach(model.workspace.projects.filter { !$0.archived }) { Text($0.name).tag(Optional($0.id)) }
                        }.labelsHidden().frame(maxWidth: 230).disabled(model.workspace.timer != nil)
                        Toggle("Billable", isOn: $model.timerBillable).toggleStyle(.checkbox).font(Theme.body(11)).disabled(model.workspace.timer != nil)
                    }
                }
                Spacer(minLength: 10)
                Text(Format.duration(model.workspace.timer.map { model.now.timeIntervalSince($0.startedAt) } ?? 0, clock: true)).font(.system(size: 38, weight: .light, design: .monospaced)).tracking(-2).contentTransition(.numericText()).foregroundStyle(model.workspace.timer == nil ? Theme.muted : Theme.accent)
                Button { model.toggleTimer() } label: { Image(systemName: model.workspace.timer == nil ? "play.fill" : "stop.fill").font(Theme.body(19)).frame(width: 28, height: 30) }.buttonStyle(PrimaryButton()).disabled(model.workspace.timer == nil && model.timerDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).help(model.workspace.timer == nil ? "Start timer (⌘⇧T)" : "Stop and save timer (⌘⇧T)")
            }
        }.padding(26).background(LinearGradient(colors: [Color(hex: 0xE9E4DC), Theme.panel], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 15)).overlay(RoundedRectangle(cornerRadius: 15).stroke(Theme.accent.opacity(0.18)))
    }
}

struct MetricCard: View {
    var label: String; var value: String; var detail: String; var icon: String; var color: Color
    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 14) {
                HStack { Text(label).font(Theme.body(12)).foregroundStyle(Theme.muted); Spacer(); Image(systemName: icon).foregroundStyle(color).font(Theme.body(14)) }
                Text(value).font(Theme.body(29, weight: .medium)).tracking(-0.8)
                Text(detail).font(Theme.body(10)).foregroundStyle(Theme.muted)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct DayTimeline: View {
    var entries: [TimeEntry]; var workspace: Workspace
    var body: some View {
        VStack(spacing: 9) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 6).fill(Theme.raised)
                    ForEach(entries) { entry in
                        let day = Calendar.current.dateInterval(of: .day, for: Date())!
                        let start = max(day.start, entry.startedAt)
                        let end = min(day.end, entry.endedAt)
                        let offset = max(0, start.timeIntervalSince(day.start) / day.duration)
                        let width = max(0, min(1 - offset, end.timeIntervalSince(start) / day.duration))
                        RoundedRectangle(cornerRadius: 4).fill(Theme.color(workspace.project(entry.projectID)?.color ?? "gold")).frame(width: max(2, geo.size.width * width)).offset(x: geo.size.width * offset).help("\(entry.description) · \(Format.duration(entry.seconds))")
                    }
                }
            }.frame(height: 26)
            HStack { ForEach(["00:00", "06:00", "12:00", "18:00", "24:00"], id: \.self) { label in Text(label); if label != "24:00" { Spacer() } } }.font(.system(size: 9, design: .monospaced)).foregroundStyle(Theme.muted)
        }.padding(.vertical, 10)
    }
}

struct EntryRow: View {
    @EnvironmentObject var model: AppModel
    var entry: TimeEntry
    @State private var delete = false
    var body: some View {
        HStack(spacing: 13) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.color(model.workspace.project(entry.projectID)?.color ?? "gold")).frame(width: 3, height: 35)
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.description).font(Theme.body(12, weight: .medium)).lineLimit(1)
                HStack(spacing: 6) { Text(model.workspace.project(entry.projectID)?.name ?? "No project"); Text("·"); Text(entry.startedAt.formatted(date: .omitted, time: .shortened)); if entry.billable { Image(systemName: "dollarsign.circle") } }.font(Theme.body(10)).foregroundStyle(Theme.muted)
            }
            Spacer()
            Text(Format.duration(entry.seconds)).font(.system(size: 13, weight: .medium, design: .monospaced))
            Button { model.resume(entry) } label: { Image(systemName: "play").font(Theme.body(11)) }.buttonStyle(.plain).disabled(model.workspace.timer != nil).help("Resume this work")
            Menu {
                Button("Edit entry") { model.editingEntry = entry; model.reviewingActivity = nil; model.showEntry = true }
                Button("Delete entry", role: .destructive) { delete = true }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 18)
        }.padding(.vertical, 12).overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
            .confirmationDialog("Delete this time entry?", isPresented: $delete) {
                Button("Delete entry", role: .destructive) { model.change { $0.deleteEntry(entry.id) } }
            } message: { Text("\(entry.description) · \(Format.duration(entry.seconds))") }
    }
}

extension AppModel {
    /// The top bar's one line about where the data is.
    var syncStatusLine: String {
        guard let sync = workspace.sync else { return "Saved on this Mac" }
        if syncing { return "Syncing to Kiwi…" }
        if let error = sync.lastError { return "Kiwi sync failed · \(error.prefix(60))" }
        guard let date = sync.lastSyncedAt else { return "Connected to Kiwi · not synced yet" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        let ago = seconds < 60 ? "just now" : seconds < 3600 ? "\(seconds / 60)m ago" : seconds < 86_400 ? "\(seconds / 3600)h ago" : date.formatted(date: .abbreviated, time: .shortened)
        return "Synced to Kiwi · \(ago)"
    }
}
