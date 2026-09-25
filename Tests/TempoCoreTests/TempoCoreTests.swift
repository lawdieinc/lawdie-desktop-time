import Foundation
import TempoCore

final class TempoCoreTests {
    let epoch = Date(timeIntervalSince1970: 1_780_000_000)
    func at(_ seconds: Double) -> Date { epoch.addingTimeInterval(seconds) }
    func observe(_ state: inout Workspace, _ seconds: Double, app: String = "Word", id: String = "com.microsoft.Word", title: String? = nil, idle: Double = 0, suspended: Bool = false) {
        state.observe(app: app, bundleID: id, title: title, now: at(seconds), idleSeconds: idle, suspended: suspended)
    }

    func testCaptureRequiresOptInAndTitlesRequireSeparateOptIn() {
        var state = Workspace()
        observe(&state, 0, title: "Secret")
        checkNil(state.currentActivity)
        state.preferences.captureEnabled = true
        observe(&state, 5, title: "Secret")
        checkNil(state.currentActivity?.title)
        state.preferences.captureTitles = true
        observe(&state, 10, title: "Document")
        checkEqual(state.currentActivity?.title, "Document")
        checkNil(state.activities.first?.title)
    }

    func testSwitchProducesBoundedNeutralSegment() {
        var state = Workspace(); state.preferences.captureEnabled = true
        observe(&state, 0); observe(&state, 5); observe(&state, 10, app: "Preview", id: "com.apple.Preview")
        checkEqual(state.activities.count, 1)
        checkEqual(state.activities[0].seconds, 10)
        checkEqual(state.activities[0].endedBy, "switched")
        checkEqual(state.currentActivity?.app, "Preview")
        checkTrue(state.entries.isEmpty)
    }

    func testExclusionAndOwnAppClosePreviousWithoutCapturing() {
        var state = Workspace(); state.preferences.captureEnabled = true
        observe(&state, 0); observe(&state, 5, id: "com.apple.Passwords")
        checkNil(state.currentActivity)
        checkEqual(state.activities.count, 1)
        observe(&state, 10, id: "co.lawdie.timecapture.desktop")
        checkNil(state.currentActivity)
    }

    func testIdleTrimsActivityAndTimerToLastInput() throws {
        var state = Workspace(); state.preferences.captureEnabled = true; state.preferences.idleMinutes = 1
        try state.startTimer(description: "Draft", projectID: nil, billable: true, now: at(0))
        for seconds in stride(from: 0.0, through: 85.0, by: 5) { observe(&state, seconds, idle: max(0, seconds - 30)) }
        observe(&state, 90, idle: 60)
        checkNil(state.timer); checkNil(state.currentActivity)
        checkEqual(state.entries.first?.seconds, 30)
        checkEqual(state.activities.first?.seconds, 30)
        observe(&state, 95)
        checkNil(state.timer, "Returning from idle must not silently restart billing")
        checkNotNil(state.currentActivity)
    }

    func testSleepStopsTimerAndCapture() throws {
        var state = Workspace(); state.preferences.captureEnabled = true
        try state.startTimer(description: "Work", projectID: nil, billable: false, now: at(0))
        observe(&state, 0); observe(&state, 5); observe(&state, 9, suspended: true)
        checkNil(state.timer); checkNil(state.currentActivity)
        checkEqual(state.entries.first?.seconds, 9)
        checkEqual(state.activities.first?.endedBy, "suspended")
    }

    func testCrashRecoveryNeverCountsDowntime() throws {
        var state = Workspace(); state.preferences.captureEnabled = true
        try state.startTimer(description: "Work", projectID: nil, billable: false, now: at(0))
        observe(&state, 0); observe(&state, 5)
        state.recover(now: at(8 * 3600))
        checkEqual(state.entries.first?.seconds, 5)
        checkEqual(state.activities.first?.seconds, 5)
        checkNil(state.timer); checkNil(state.currentActivity)
    }

    func testUnobservedGapIsNotTimeWorked() throws {
        var state = Workspace(); state.preferences.captureEnabled = true
        try state.startTimer(description: "Work", projectID: nil, billable: false, now: at(0))
        observe(&state, 0); observe(&state, 5); observe(&state, 600)
        checkEqual(state.entries.first?.seconds, 5)
        checkEqual(state.activities.first?.seconds, 5)
        checkEqual(state.currentActivity?.startedAt, at(600))
    }

    func testSingleTimerAndFrozenRate() throws {
        var state = Workspace(); let project = Project(name: "Matter", hourlyRate: 350); state.projects = [project]
        try state.startTimer(description: "Work", projectID: project.id, billable: true, now: at(0))
        checkThrows(try state.startTimer(description: "Other", projectID: nil, billable: false, now: at(1)))
        state.projects[0].hourlyRate = 500
        state.stopTimer(at: at(3600))
        checkEqual(state.entries.first?.hourlyRate, 350)
    }

    func testReviewIsExplicitAndIdempotent() throws {
        var state = Workspace(); let activity = Activity(app: "Word", bundleID: "Word", startedAt: at(0), endedAt: at(600)); state.activities = [activity]
        checkTrue(state.entries.isEmpty)
        try state.keepActivity(activity.id, description: "Draft", projectID: nil, billable: true, now: at(700))
        checkEqual(state.entries.count, 1); checkEqual(state.activities[0].disposition, "kept")
        checkEqual(state.entries[0].activityID, activity.id)
        checkThrows(try state.keepActivity(activity.id, description: "Draft", projectID: nil, billable: true, now: at(700)))
    }

    func testOverlapsRejectedButAdjacentAndSelfEditsAllowed() throws {
        var state = Workspace()
        let entry = TimeEntry(description: "One", startedAt: at(0), endedAt: at(600))
        try state.saveEntry(entry, now: at(3600))
        try state.saveEntry(entry, now: at(3600))
        checkEqual(state.entries.count, 1)
        checkThrows(try state.saveEntry(TimeEntry(description: "Overlap", startedAt: at(599), endedAt: at(800)), now: at(3600)))
        try state.saveEntry(TimeEntry(description: "Adjacent", startedAt: at(600), endedAt: at(800)), now: at(3600))
        try state.startTimer(description: "Running", projectID: nil, billable: false, now: at(900))
        checkThrows(try state.saveEntry(TimeEntry(description: "Overlap", startedAt: at(850), endedAt: at(950)), now: at(3600)))
    }

    func testInvalidAndFutureEntriesRejected() {
        var state = Workspace()
        for entry in [TimeEntry(description: " ", startedAt: at(0), endedAt: at(100)), TimeEntry(description: "Backwards", startedAt: at(100), endedAt: at(0)), TimeEntry(description: "Future", startedAt: at(0), endedAt: at(1000)), TimeEntry(description: "Rate", startedAt: at(0), endedAt: at(100), hourlyRate: -10)] {
            checkThrows(try state.saveEntry(entry, now: at(600)))
        }
    }

    func testFailedReviewDoesNotMarkActivityKept() throws {
        var state = Workspace()
        state.entries = [TimeEntry(description: "Existing", startedAt: at(0), endedAt: at(600))]
        let activity = Activity(app: "Word", bundleID: "Word", startedAt: at(0), endedAt: at(600)); state.activities = [activity]
        checkThrows(try state.keepActivity(activity.id, description: "Draft", projectID: nil, billable: true, now: at(700)))
        checkEqual(state.activities[0].disposition, "pending")
        checkEqual(state.entries.count, 1)
    }

    func testRetentionDoesNotDeleteTimeEntries() {
        var state = Workspace(); state.preferences.retentionDays = 7
        state.activities = [Activity(app: "Word", bundleID: "Word", startedAt: at(0), endedAt: at(60))]
        state.entries = [TimeEntry(description: "Work", startedAt: at(0), endedAt: at(60))]
        state.prune(now: at(8 * 86400))
        checkTrue(state.activities.isEmpty); checkEqual(state.entries.count, 1)
    }

    func testMidnightAndDaylightSavingTotals() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let iso = ISO8601DateFormatter()
        let start = iso.date(from: "2026-03-08T04:30:00Z")! // 23:30 EST
        let end = iso.date(from: "2026-03-08T08:30:00Z")! // 04:30 EDT
        var state = Workspace(); state.entries = [TimeEntry(description: "Overnight", startedAt: start, endedAt: end)]
        checkEqual(state.seconds(on: start, calendar: calendar), 1800)
        checkEqual(state.seconds(on: end, calendar: calendar), 12600)
    }

    func testPersistenceRoundTripAndCorruptFilePreservation() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = WorkspaceFile(url: dir.appendingPathComponent("workspace.json"))
        try checkEqual(try file.load(), Workspace())
        var state = Workspace(); state.projects = [Project(name: "Test")]
        try file.save(state); try checkEqual(try file.load(), state)
        let corrupted = Data("not json".utf8); try corrupted.write(to: file.url)
        checkThrows(try file.load()); try checkEqual(try Data(contentsOf: file.url), corrupted)
    }

    func testUnknownSchemaRejected() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = WorkspaceFile(url: dir.appendingPathComponent("workspace.json"))
        var state = Workspace(); state.schemaVersion = 99; try file.save(state)
        checkThrows(try file.load())
    }

    func testCSVQuotesAndNeutralizesFormulas() {
        let entry = TimeEntry(description: "  =HYPERLINK(\"bad\")\nnext", startedAt: at(0), endedAt: at(60))
        let csv = Export.csv(Workspace(), entries: [entry])
        checkTrue(csv.contains("\"'  =HYPERLINK(\"\"bad\"\")\nnext\""))
        checkTrue(csv.hasSuffix("\r\n"))
    }

    func testWorkspaceLockRejectsSecondWriterAndReleases() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        var first: WorkspaceLock? = try WorkspaceLock(directory: dir)
        checkNotNil(first)
        checkThrows(try WorkspaceLock(directory: dir))
        first = nil
        let second = try WorkspaceLock(directory: dir)
        withExtendedLifetime(second) { checkNotNil(second) }
    }

    func testFailedWritePreservesExistingFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let blocker = dir.appendingPathComponent("blocker")
        let bytes = Data("preserve me".utf8)
        try bytes.write(to: blocker)
        checkThrows(try WorkspaceFile(url: blocker.appendingPathComponent("workspace.json")).save(Workspace()))
        try checkEqual(try Data(contentsOf: blocker), bytes)
    }

    func testInvalidPreferencesAndRatesRejectedOnLoad() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = WorkspaceFile(url: dir.appendingPathComponent("workspace.json"))
        var state = Workspace(); state.preferences.idleMinutes = 0
        try file.save(state); checkThrows(try file.load())
        state.preferences.idleMinutes = 3; state.projects = [Project(name: "Invalid", hourlyRate: -5)]
        try file.save(state); checkThrows(try file.load())
    }
}

@main
struct CoreChecks {
    static func main() throws {
        let suite = TempoCoreTests()
        suite.testCaptureRequiresOptInAndTitlesRequireSeparateOptIn(); print("PASS testCaptureRequiresOptInAndTitlesRequireSeparateOptIn")
        suite.testSwitchProducesBoundedNeutralSegment(); print("PASS testSwitchProducesBoundedNeutralSegment")
        suite.testExclusionAndOwnAppClosePreviousWithoutCapturing(); print("PASS testExclusionAndOwnAppClosePreviousWithoutCapturing")
        try suite.testIdleTrimsActivityAndTimerToLastInput(); print("PASS testIdleTrimsActivityAndTimerToLastInput")
        try suite.testSleepStopsTimerAndCapture(); print("PASS testSleepStopsTimerAndCapture")
        try suite.testCrashRecoveryNeverCountsDowntime(); print("PASS testCrashRecoveryNeverCountsDowntime")
        try suite.testUnobservedGapIsNotTimeWorked(); print("PASS testUnobservedGapIsNotTimeWorked")
        try suite.testSingleTimerAndFrozenRate(); print("PASS testSingleTimerAndFrozenRate")
        try suite.testReviewIsExplicitAndIdempotent(); print("PASS testReviewIsExplicitAndIdempotent")
        try suite.testOverlapsRejectedButAdjacentAndSelfEditsAllowed(); print("PASS testOverlapsRejectedButAdjacentAndSelfEditsAllowed")
        suite.testInvalidAndFutureEntriesRejected(); print("PASS testInvalidAndFutureEntriesRejected")
        try suite.testFailedReviewDoesNotMarkActivityKept(); print("PASS testFailedReviewDoesNotMarkActivityKept")
        suite.testRetentionDoesNotDeleteTimeEntries(); print("PASS testRetentionDoesNotDeleteTimeEntries")
        try suite.testMidnightAndDaylightSavingTotals(); print("PASS testMidnightAndDaylightSavingTotals")
        try suite.testPersistenceRoundTripAndCorruptFilePreservation(); print("PASS testPersistenceRoundTripAndCorruptFilePreservation")
        try suite.testUnknownSchemaRejected(); print("PASS testUnknownSchemaRejected")
        suite.testCSVQuotesAndNeutralizesFormulas(); print("PASS testCSVQuotesAndNeutralizesFormulas")
        try suite.testWorkspaceLockRejectsSecondWriterAndReleases(); print("PASS testWorkspaceLockRejectsSecondWriterAndReleases")
        try suite.testFailedWritePreservesExistingFile(); print("PASS testFailedWritePreservesExistingFile")
        try suite.testInvalidPreferencesAndRatesRejectedOnLoad(); print("PASS testInvalidPreferencesAndRatesRejectedOnLoad")
        print("\n20 core checks passed.")
    }
}
