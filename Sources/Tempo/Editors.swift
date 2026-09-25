import SwiftUI
import TempoCore

struct EntryEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let entry: TimeEntry?
    let activity: Activity?
    @State private var description = ""
    @State private var projectID: UUID?
    @State private var billable = true
    @State private var start = Date().addingTimeInterval(-1800)
    @State private var end = Date()
    @State private var rate = 0.0
    @State private var validation: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            PageHeading(eyebrow: activity != nil ? "From desktop activity" : "Make it count", title: entry == nil ? "Add time" : "Edit time", subtitle: activity != nil ? "Review this activity and choose where it belongs." : "Accurate records start with a little context.")
            VStack(alignment: .leading, spacing: 18) {
                field("Description") { TextField("What did you work on?", text: $description).textFieldStyle(.roundedBorder) }
                field("Project") {
                    Picker("Project", selection: Binding(get: { projectID }, set: { value in projectID = value; rate = model.workspace.project(value)?.hourlyRate ?? 0 })) {
                        Text("No project").tag(nil as UUID?)
                        ForEach(model.workspace.projects.filter { !$0.archived || $0.id == projectID }) { Text($0.name).tag(Optional($0.id)) }
                    }.labelsHidden()
                }
                HStack(spacing: 25) {
                    field("Start") { DatePicker("Start", selection: $start, displayedComponents: [.date, .hourAndMinute]).labelsHidden().disabled(activity != nil) }
                    field("End") { DatePicker("End", selection: $end, displayedComponents: [.date, .hourAndMinute]).labelsHidden().disabled(activity != nil) }
                }
                HStack { Toggle("Billable", isOn: $billable).toggleStyle(.checkbox); Spacer(); Text("USD / hour").font(.caption).foregroundStyle(Theme.muted); TextField("Rate", value: $rate, format: .number.precision(.fractionLength(0...2))).textFieldStyle(.roundedBorder).frame(width: 95).disabled(!billable) }
                if activity != nil { Text("Captured times are preserved. If this overlaps tracked time, dismiss the activity or add a manual entry for the untracked portion.").font(Theme.body(11)).foregroundStyle(Theme.muted) }
            }.padding(22).background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
            if let validation { Text(validation).font(Theme.body(12)).foregroundStyle(.red) }
            HStack {
                Text(Format.duration(end.timeIntervalSince(start))).font(.system(size: 22, weight: .light, design: .monospaced)).foregroundStyle(Theme.accent)
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(QuietButton()).keyboardShortcut(.cancelAction)
                Button(activity != nil ? "Keep time" : "Save entry") { save() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction)
            }
        }.padding(32).frame(width: 600).background(Theme.background).foregroundStyle(Theme.text).preferredColorScheme(.light)
            .onAppear {
                if let entry { description = entry.description; projectID = entry.projectID; billable = entry.billable; start = entry.startedAt; end = entry.endedAt; rate = entry.hourlyRate }
                if let activity { description = activity.title ?? "Work in \(activity.app)"; start = activity.startedAt; end = activity.endedAt }
            }
    }
    private func field<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 9) { Eyebrow(text: title); content() }
    }
    private func save() {
        var next = model.workspace
        do {
            if let activity {
                try next.keepActivity(activity.id, description: description, projectID: projectID, billable: billable, now: Date())
                if let index = next.entries.firstIndex(where: { $0.activityID == activity.id }) {
                    guard rate.isFinite, rate >= 0 else { throw TempoError.invalid("Enter a valid hourly rate.") }
                    next.entries[index].hourlyRate = rate
                }
            } else {
                let updated = TimeEntry(id: entry?.id ?? UUID(), description: description.trimmingCharacters(in: .whitespacesAndNewlines), projectID: projectID, startedAt: start, endedAt: end, billable: billable, hourlyRate: rate, source: entry?.source ?? "manual", activityID: entry?.activityID)
                try next.saveEntry(updated, now: Date())
            }
            if model.change({ $0 = next }) { dismiss() }
        } catch { validation = error.localizedDescription }
    }
}

struct ProjectEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var project: Project?
    @State private var name = ""
    @State private var client = ""
    @State private var rate = 0.0
    @State private var color = "gold"
    @State private var validation: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 23) {
            PageHeading(eyebrow: "A place for your work", title: project == nil ? "New project" : "Edit project", subtitle: "A client matter, a big idea, or the everyday essentials.")
            Form {
                TextField("Project / matter", text: $name)
                TextField("Client", text: $client)
                TextField("Hourly rate (USD)", value: $rate, format: .number.precision(.fractionLength(0...2)))
                HStack(spacing: 12) {
                    Text("Color"); Spacer()
                    ForEach(["gold", "espresso", "brown", "taupe", "stone"], id: \.self) { item in
                        Button { color = item } label: { Circle().fill(Theme.color(item)).frame(width: 25, height: 25).overlay { if color == item { Image(systemName: "checkmark").font(Theme.body(10, weight: .bold)).foregroundStyle(Theme.background) } } }.buttonStyle(.plain).accessibilityLabel(item)
                    }
                }
            }.formStyle(.grouped).frame(height: 225)
            Text("Rate changes apply to new entries. Existing entries keep their saved rate.").font(Theme.body(11)).foregroundStyle(Theme.muted)
            if let validation { Text(validation).foregroundStyle(.red).font(.caption) }
            HStack { Spacer(); Button("Cancel") { dismiss() }.buttonStyle(QuietButton()).keyboardShortcut(.cancelAction); Button("Save project") { save() }.buttonStyle(PrimaryButton()).keyboardShortcut(.defaultAction) }
        }.padding(30).frame(width: 530).background(Theme.background).foregroundStyle(Theme.text).preferredColorScheme(.light)
            .onAppear { if let project { name = project.name; client = project.client; rate = project.hourlyRate; color = project.color } }
    }
    private func save() {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { validation = "Give this project a name."; return }
        guard rate.isFinite, rate >= 0 else { validation = "Enter a valid hourly rate."; return }
        let updated = Project(id: project?.id ?? UUID(), name: name.trimmingCharacters(in: .whitespacesAndNewlines), client: client.trimmingCharacters(in: .whitespacesAndNewlines), color: color, hourlyRate: rate, archived: project?.archived ?? false)
        if model.change({ state in if let index = state.projects.firstIndex(where: { $0.id == updated.id }) { state.projects[index] = updated } else { state.projects.append(updated) } }) { dismiss() }
    }
}
