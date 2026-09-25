import Foundation

extension Workspace {
    public mutating func startTimer(description: String, projectID: UUID?, billable: Bool, now: Date) throws {
        guard timer == nil else { throw TempoError.invalid("Stop the current timer before starting another.") }
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw TempoError.invalid("Add a description for this time entry.") }
        guard projectID == nil || project(projectID) != nil else { throw TempoError.invalid("Choose an existing project.") }
        timer = RunningTimer(description: text, projectID: projectID, startedAt: now, lastHeartbeat: now, billable: billable, hourlyRate: project(projectID)?.hourlyRate ?? 0)
    }

    public mutating func stopTimer(at date: Date, source: String = "timer") {
        guard let running = timer else { return }
        timer = nil
        let end = max(running.startedAt, date)
        if end.timeIntervalSince(running.startedAt) >= 1 {
            entries.append(TimeEntry(description: running.description, projectID: running.projectID, startedAt: running.startedAt, endedAt: end, billable: running.billable, hourlyRate: running.hourlyRate, source: source))
        }
    }

    public mutating func saveEntry(_ entry: TimeEntry, now: Date) throws {
        guard !entry.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw TempoError.invalid("Add a description.") }
        guard entry.endedAt > entry.startedAt, entry.endedAt <= now.addingTimeInterval(1) else { throw TempoError.invalid("The end must be after the start and cannot be in the future.") }
        guard entry.hourlyRate.isFinite, entry.hourlyRate >= 0 else { throw TempoError.invalid("Enter a valid hourly rate.") }
        guard entry.projectID == nil || project(entry.projectID) != nil else { throw TempoError.invalid("Choose an existing project.") }
        guard !overlaps(start: entry.startedAt, end: entry.endedAt, excluding: entry.id) else { throw TempoError.invalid("This time overlaps another entry or the running timer. Adjust the times to avoid double counting.") }
        if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = entry }
        else { entries.append(entry) }
    }

    public mutating func keepActivity(_ id: UUID, description: String, projectID: UUID?, billable: Bool, now: Date) throws {
        guard let index = activities.firstIndex(where: { $0.id == id }), activities[index].disposition == "pending" else { throw TempoError.invalid("This activity has already been reviewed.") }
        let activity = activities[index]
        let entry = TimeEntry(description: description, projectID: projectID, startedAt: activity.startedAt, endedAt: activity.endedAt, billable: billable, hourlyRate: project(projectID)?.hourlyRate ?? 0, source: "desktop", activityID: id)
        try saveEntry(entry, now: now)
        activities[index].disposition = "kept"
    }

    /// Observation bounds are wall-clock timestamps; no interval spans an unobserved gap.
    public mutating func observe(app: String?, bundleID: String?, title: String?, now: Date, idleSeconds: Double, suspended: Bool = false) {
        let idle = idleSeconds >= Double(preferences.idleMinutes * 60)
        if suspended || idle {
            let cutoff = idle ? now.addingTimeInterval(-idleSeconds) : now
            closeActivity(at: cutoff, reason: suspended ? "suspended" : "idle")
            stopTimer(at: cutoff, source: suspended ? "timer-suspended" : "timer-idle")
            return
        }
        // A stalled process or system sleep must never inflate a timer or an activity.
        if let running = timer, now.timeIntervalSince(running.lastHeartbeat) > 45 {
            stopTimer(at: running.lastHeartbeat, source: "timer-recovered")
        } else if timer != nil { timer?.lastHeartbeat = now }
        guard preferences.captureEnabled, let app, let bundleID,
              !preferences.excludedBundleIDs.contains(bundleID), bundleID != "co.lawdie.timecapture.desktop" else {
            closeActivity(at: now, reason: "excluded")
            return
        }
        let safeTitle = preferences.captureTitles ? title : nil
        if let current = currentActivity {
            if now.timeIntervalSince(current.endedAt) > 45 || now < current.endedAt {
                closeActivity(at: current.endedAt, reason: "gap")
            } else if current.bundleID != bundleID || current.title != safeTitle {
                closeActivity(at: now, reason: "switched")
            }
        }
        if currentActivity == nil {
            currentActivity = Activity(app: app, bundleID: bundleID, title: safeTitle, startedAt: now, endedAt: now)
        } else { currentActivity?.endedAt = now }
    }

    public mutating func closeActivity(at date: Date, reason: String) {
        guard var current = currentActivity else { return }
        currentActivity = nil
        current.endedAt = max(current.startedAt, min(date, current.endedAt.addingTimeInterval(15)))
        current.endedBy = reason
        if current.seconds >= 2 { activities.append(current) }
    }

    public mutating func recover(now: Date) {
        if let running = timer { stopTimer(at: running.lastHeartbeat, source: "timer-recovered") }
        if let current = currentActivity { closeActivity(at: current.endedAt, reason: "crash-recovered") }
        prune(now: now)
    }

    public mutating func prune(now: Date) {
        let cutoff = now.addingTimeInterval(-Double(preferences.retentionDays) * 86_400)
        activities.removeAll { $0.endedAt < cutoff }
    }
}
