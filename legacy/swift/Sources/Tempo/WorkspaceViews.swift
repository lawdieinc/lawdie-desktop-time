import SwiftUI
import TempoCore
import Charts

struct ActivityView: View {
    @EnvironmentObject var model: AppModel
    @State private var filter = "pending"
    private var activities: [Activity] { model.workspace.activities.filter { filter == "all" || $0.disposition == filter }.sorted { $0.startedAt > $1.startedAt } }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                PageHeading(eyebrow: "Beyond the browser", title: "Review your activity.", subtitle: "Turn captured desktop work into accurate time entries.")
                Spacer()
                Button(model.workspace.preferences.captureEnabled ? "Pause capture" : "Enable capture") { model.setCapture(!model.workspace.preferences.captureEnabled) }.buttonStyle(PrimaryButton()).disabled(model.isDemo)
            }
            Panel {
                HStack(spacing: 15) {
                    Image(systemName: model.workspace.preferences.captureEnabled ? "waveform.path" : "pause.circle").font(Theme.body(24)).foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.workspace.preferences.captureEnabled ? "Desktop capture is active" : "Capture is paused").font(Theme.body(14, weight: .medium))
                        Text(model.workspace.currentActivity.map { "Currently in \($0.app) · \(Format.duration($0.seconds))" } ?? "App names and durations only by default. No screenshots, keystrokes, or page content.").font(Theme.body(12)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Button("Privacy settings") { model.route = .settings }.buttonStyle(QuietButton())
                }
            }
            HStack {
                Picker("Show", selection: $filter) { Text("To review").tag("pending"); Text("Kept").tag("kept"); Text("Dismissed").tag("dismissed"); Text("All activity").tag("all") }.pickerStyle(.segmented).frame(width: 390)
                Spacer()
                Text("\(activities.count) activities · retained \(model.workspace.preferences.retentionDays) days").font(Theme.body(11)).foregroundStyle(Theme.muted)
            }
            Panel {
                if activities.isEmpty {
                    EmptyState(icon: "tray", title: filter == "pending" ? "You’re all caught up." : "No activities here yet.", detail: "Enable capture, then work in another app. Activity appears here when you switch apps, go idle, or pause capture.")
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(activities) { activity in
                            HStack(spacing: 16) {
                                Image(systemName: "macwindow").font(Theme.body(20)).foregroundStyle(Theme.color("espresso")).frame(width: 44, height: 44).background(Theme.raised, in: RoundedRectangle(cornerRadius: 10))
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(activity.title.flatMap { $0.isEmpty ? nil : $0 } ?? activity.app).font(Theme.body(13, weight: .medium)).lineLimit(1)
                                    Text("\(activity.app) · \(activity.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(activity.endedBy)").font(Theme.body(10)).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                Text(Format.duration(activity.seconds)).font(.system(size: 14, design: .monospaced)).padding(.trailing, 10)
                                if activity.disposition == "pending" {
                                    Button("Dismiss") { model.change { state in if let i = state.activities.firstIndex(where: { $0.id == activity.id }) { state.activities[i].disposition = "dismissed" } } }.buttonStyle(QuietButton())
                                    Button("Keep time") { model.reviewingActivity = activity; model.editingEntry = nil; model.showEntry = true }.buttonStyle(PrimaryButton())
                                } else { Text(activity.disposition.capitalized).font(Theme.body(11)).foregroundStyle(activity.disposition == "kept" ? Theme.accent : Theme.muted).frame(width: 80) }
                            }.padding(.vertical, 17).overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
                        }
                    }
                }
            }
        }
    }
}

struct EntriesView: View {
    @EnvironmentObject var model: AppModel
    @State private var search = ""
    @State private var period = "week"
    private var entries: [TimeEntry] {
        let start = period == "today" ? Calendar.current.startOfDay(for: model.now) : period == "week" ? Calendar.current.dateInterval(of: .weekOfYear, for: model.now)!.start : .distantPast
        return model.workspace.entries.filter { $0.endedAt > start && (search.isEmpty || ($0.description + " " + (model.workspace.project($0.projectID)?.name ?? "") + " " + (model.workspace.project($0.projectID)?.client ?? "")).localizedCaseInsensitiveContains(search)) }.sorted { $0.startedAt > $1.startedAt }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                PageHeading(eyebrow: "Your work, recorded", title: "Time well spent.", subtitle: "Every entry has a story. Keep yours accurate.")
                Spacer()
                Button("Export CSV") { model.exportCSV(entries: entries) }.buttonStyle(QuietButton())
                Button { model.editingEntry = nil; model.reviewingActivity = nil; model.showEntry = true } label: { Label("Add time", systemImage: "plus") }.buttonStyle(PrimaryButton())
            }
            HStack {
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted); TextField("Search descriptions, projects, clients…", text: $search).textFieldStyle(.plain) }.padding(12).background(Theme.panel, in: RoundedRectangle(cornerRadius: 8)).frame(maxWidth: 360)
                Spacer()
                Picker("Period", selection: $period) { Text("Today").tag("today"); Text("This week").tag("week"); Text("All time").tag("all") }.pickerStyle(.segmented).frame(width: 260)
            }
            Panel {
                VStack(alignment: .leading, spacing: 12) {
                    HStack { Eyebrow(text: "\(entries.count) entries"); Spacer(); Text(Format.duration(entries.reduce(0) { $0 + $1.seconds })).font(.system(size: 20, weight: .medium, design: .monospaced)) }
                    if entries.isEmpty { EmptyState(icon: "clock", title: "No time entries yet.", detail: "Start a timer, add time manually, or keep an activity from your review inbox.") }
                    else {
                        let days = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: $0.startedAt) }
                        ForEach(days.keys.sorted(by: >), id: \.self) { day in
                            Text(day.formatted(date: .complete, time: .omitted)).font(Theme.body(11, weight: .medium)).foregroundStyle(Theme.muted).padding(.top, 18)
                            ForEach(days[day] ?? []) { entry in EntryRow(entry: entry) }
                        }
                    }
                }
            }
        }
    }
}

struct ProjectsView: View {
    @EnvironmentObject var model: AppModel
    @State private var showArchived = false
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                PageHeading(eyebrow: "Projects and clients", title: "Your matters and projects.", subtitle: "Organize your work by client and set a billable rate for each project.")
                Spacer()
                Button { model.editingProject = nil; model.showProject = true } label: { Label("New project", systemImage: "plus") }.buttonStyle(PrimaryButton())
            }
            Toggle("Show archived projects", isOn: $showArchived).toggleStyle(.checkbox).font(Theme.body(12)).foregroundStyle(Theme.muted)
            let projects = model.workspace.projects.filter { showArchived || !$0.archived }
            if projects.isEmpty { Panel { EmptyState(icon: "square.stack.3d.up", title: "Space for your next project.", detail: "Create a project to group time, connect it to a client, and set a billable rate.") } }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 18)], spacing: 18) {
                ForEach(projects) { project in
                    Panel {
                        VStack(alignment: .leading, spacing: 20) {
                            HStack { Image(systemName: "folder.fill").foregroundStyle(Theme.color(project.color)).font(Theme.body(24)); Spacer(); Menu { Button("Edit project") { model.editingProject = project; model.showProject = true }; Button(project.archived ? "Unarchive project" : "Archive project") { model.change { state in if let i = state.projects.firstIndex(where: { $0.id == project.id }) { state.projects[i].archived.toggle() } } } } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 22) }
                            VStack(alignment: .leading, spacing: 7) { Text(project.name).font(Theme.body(16, weight: .medium)); Text(project.client.isEmpty ? "No client" : project.client).font(Theme.body(12)).foregroundStyle(Theme.muted) }
                            Rectangle().fill(Theme.line).frame(height: 1)
                            HStack(alignment: .bottom) {
                                VStack(alignment: .leading, spacing: 6) { Eyebrow(text: "Total tracked"); Text(Format.duration(model.workspace.entries.filter { $0.projectID == project.id }.reduce(0) { $0 + $1.seconds })).font(Theme.body(22, weight: .medium)) }
                                Spacer()
                                Text(project.archived ? "Archived" : "$\(project.hourlyRate, specifier: "%.0f") / hr").font(Theme.body(11)).foregroundStyle(Theme.muted)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

struct ReportsView: View {
    @EnvironmentObject var model: AppModel
    @State private var weeksAgo = 0
    private var week: DateInterval {
        Calendar.current.dateInterval(of: .weekOfYear, for: Calendar.current.date(byAdding: .weekOfYear, value: -weeksAgo, to: model.now)!)!
    }
    private var entries: [TimeEntry] {
        model.workspace.entries.filter { $0.startedAt < week.end && $0.endedAt > week.start }.map { entry in
            var clipped = entry; clipped.startedAt = max(entry.startedAt, week.start); clipped.endedAt = min(entry.endedAt, week.end); return clipped
        }
    }
    private var days: [Date] { (0..<7).compactMap { Calendar.current.date(byAdding: .day, value: $0, to: week.start) } }
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack { PageHeading(eyebrow: "Find your rhythm", title: "See where time goes.", subtitle: "Understand your week, protect your focus, and account for your work."); Spacer(); Button("Export week") { model.exportCSV(entries: entries) }.buttonStyle(QuietButton()) }
            HStack {
                Button { weeksAgo += 1 } label: { Image(systemName: "chevron.left") }.buttonStyle(QuietButton())
                Text("\(week.start.formatted(.dateTime.month(.abbreviated).day())) – \(week.end.addingTimeInterval(-1).formatted(.dateTime.month(.abbreviated).day().year()))").font(Theme.body(13, weight: .medium)).frame(width: 220)
                Button { weeksAgo = max(0, weeksAgo - 1) } label: { Image(systemName: "chevron.right") }.buttonStyle(QuietButton()).disabled(weeksAgo == 0)
                Spacer(); Text("USD · Rates saved with each entry").font(Theme.body(10)).foregroundStyle(Theme.muted)
            }
            HStack(spacing: 14) {
                MetricCard(label: "Total tracked", value: Format.duration(entries.reduce(0) { $0 + $1.seconds }), detail: "This week", icon: "clock", color: Theme.accent)
                MetricCard(label: "Billable", value: Format.duration(entries.filter(\.billable).reduce(0) { $0 + $1.seconds }), detail: "Approved time entries", icon: "checkmark.seal", color: Theme.color("espresso"))
                MetricCard(label: "Billable value", value: entries.filter(\.billable).reduce(0) { $0 + $1.seconds / 3600 * $1.hourlyRate }.formatted(.currency(code: "USD")), detail: "Before taxes or rounding", icon: "dollarsign.circle", color: Theme.color("brown"))
            }
            Panel {
                VStack(alignment: .leading, spacing: 25) {
                    Text("A week at a glance").font(Theme.body(16, weight: .medium))
                    Chart(days, id: \.self) { day in
                        BarMark(x: .value("Day", day, unit: .day), y: .value("Hours", model.workspace.seconds(on: day) / 3600), width: .ratio(0.45)).foregroundStyle(Theme.accent).cornerRadius(5)
                    }.chartXAxis { AxisMarks(values: .stride(by: .day)) { _ in AxisValueLabel(format: .dateTime.weekday(.abbreviated)); AxisTick() } }.chartYAxis { AxisMarks(position: .leading) { value in AxisGridLine().foregroundStyle(Theme.line); AxisValueLabel { if let hours = value.as(Double.self) { Text("\(hours, specifier: "%.0f")h").foregroundStyle(Theme.muted) } } } }.frame(height: 225)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: 20) {
                    Text("By project").font(Theme.body(16, weight: .medium))
                    if entries.isEmpty { Text("Your project breakdown will appear as you track time.").font(Theme.body(12)).foregroundStyle(Theme.muted).padding(.vertical, 20) }
                    let grouped = Dictionary(grouping: entries, by: { $0.projectID?.uuidString ?? "unassigned" })
                    ForEach(grouped.keys.sorted(), id: \.self) { key in
                        let group = grouped[key] ?? []
                        let project = model.workspace.project(group.first?.projectID)
                        HStack {
                            Circle().fill(Theme.color(project?.color ?? "gold")).frame(width: 8, height: 8)
                            Text(project?.name ?? "No project").font(Theme.body(13)).frame(width: 230, alignment: .leading)
                            GeometryReader { geo in Capsule().fill(Theme.raised).overlay(alignment: .leading) { Capsule().fill(Theme.color(project?.color ?? "gold")).frame(width: geo.size.width * group.reduce(0) { $0 + $1.seconds } / max(1, entries.reduce(0) { $0 + $1.seconds })) } }.frame(height: 6)
                            Text(Format.duration(group.reduce(0) { $0 + $1.seconds })).font(.system(size: 12, design: .monospaced)).frame(width: 100, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }
}
