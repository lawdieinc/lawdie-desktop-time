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

    // MARK: Kiwi sync

    func testSyncRequestWireFormatIsSnakeCaseUTC() throws {
        var state = Workspace()
        let project = Project(name: "Whitfield v. Meridian", client: "Whitfield", hourlyRate: 350)
        state.projects = [project]
        let activity = Activity(app: "Microsoft Word", bundleID: "com.microsoft.Word", title: "Motion.docx", startedAt: at(0), endedAt: at(1200), endedBy: "switched", disposition: "kept")
        state.activities = [activity]
        state.currentActivity = Activity(app: "Preview", bundleID: "com.apple.Preview", startedAt: at(1200), endedAt: at(1300))
        state.entries = [TimeEntry(id: UUID(uuidString: "4FD1C8A2-3B7E-4C1D-9A2F-1B3C4D5E6F70")!, description: "Prepare motion", projectID: project.id, startedAt: at(0), endedAt: at(1200), billable: true, hourlyRate: 350, source: "desktop", activityID: activity.id)]
        let deleted = UUID()
        state.sync = SyncState(serverURL: "https://lawdie.co/kiwi-api", deviceID: "dev-1", deviceName: "Studio Mac", deletedEntryIDs: [deleted])

        let request = state.syncRequest(appVersion: "0.2.0")
        let data = try SyncWire.encoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        checkEqual(Set(json.keys), ["app_version", "activities", "entries", "deleted_entry_ids"])
        let activities = json["activities"] as! [[String: Any]]
        checkEqual(activities.count, 1) // the in-progress segment is not sent
        checkEqual(Set(activities[0].keys), ["id", "app", "bundle_id", "title", "started_at", "ended_at", "seconds", "ended_by", "disposition"])
        checkEqual(activities[0]["started_at"] as? String, "2026-05-28T20:26:40Z")
        checkEqual(activities[0]["seconds"] as? Int, 1200)
        checkEqual(activities[0]["disposition"] as? String, "kept")
        let entries = json["entries"] as! [[String: Any]]
        checkEqual(entries[0]["id"] as? String, "4FD1C8A2-3B7E-4C1D-9A2F-1B3C4D5E6F70")
        checkEqual(entries[0]["project_name"] as? String, "Whitfield v. Meridian")
        checkEqual(entries[0]["client_name"] as? String, "Whitfield")
        checkEqual(entries[0]["billable"] as? Bool, true)
        checkEqual(entries[0]["hourly_rate"] as? Double, 350)
        checkEqual(entries[0]["activity_id"] as? String, activity.id.uuidString)
        checkEqual(json["deleted_entry_ids"] as? [String], [deleted.uuidString])
        // The token is not part of the workspace, so it cannot be in the payload or a backup.
        checkTrue(!String(decoding: data, as: UTF8.self).contains("ldt_"))
        try checkEqual(try SyncWire.decoder().decode(SyncRequest.self, from: data), request)
    }

    func testDeleteEntryRecordsTombstoneOnlyWhenConnected() throws {
        var state = Workspace()
        let activity = Activity(app: "Word", bundleID: "Word", startedAt: at(0), endedAt: at(600)); state.activities = [activity]
        try state.keepActivity(activity.id, description: "Draft", projectID: nil, billable: true, now: at(700))
        let id = state.entries[0].id
        state.deleteEntry(id)
        checkTrue(state.entries.isEmpty); checkEqual(state.activities[0].disposition, "pending")
        checkNil(state.sync, "No connection, nothing to tombstone")

        state.sync = SyncState(serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac")
        try state.saveEntry(TimeEntry(id: id, description: "Again", startedAt: at(0), endedAt: at(600)), now: at(700))
        state.deleteEntry(id); state.deleteEntry(id)
        checkEqual(state.sync?.deletedEntryIDs, [id]) // recorded once, however many times it is deleted
        state.deleteEntry(UUID())
        checkEqual(state.sync?.deletedEntryIDs.count, 1) // deleting nothing records nothing
    }

    func testMarkSyncedClearsOnlyAcknowledgedDeletions() {
        var state = Workspace()
        let seen = UUID(), later = UUID()
        state.sync = SyncState(serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", lastError: "boom", deletedEntryIDs: [seen, later])
        state.markSynced(at: at(10), acknowledgedDeletions: [seen])
        checkEqual(state.sync?.deletedEntryIDs, [later])
        checkEqual(state.sync?.lastSyncedAt, at(10))
        checkNil(state.sync?.lastError)
    }

    func testWorkspaceWrittenBeforeSyncStillLoads() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = WorkspaceFile(url: dir.appendingPathComponent("workspace.json"))
        try file.save(Workspace())
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: file.url)) as! [String: Any]
        checkNil(json["sync"], "An unconnected workspace has no sync key, exactly like one from 0.1.0")
        try checkEqual(try file.load().sync, nil)
        var connected = Workspace(); connected.sync = SyncState(serverURL: "https://lawdie.co/kiwi-api", deviceID: "d", deviceName: "Mac", lastSyncedAt: at(0))
        try file.save(connected); try checkEqual(try file.load(), connected)
        connected.sync?.serverURL = "not a url"
        try file.save(connected); checkThrows(try file.load())
    }

    func testSyncBatchesStayUnderKiwiLimitWithDeletionsFirst() {
        let activity = SyncActivityPayload(id: UUID(), app: "A", bundleID: "a", title: nil, startedAt: at(0), endedAt: at(1), seconds: 1, endedBy: "switched", disposition: "pending")
        let entry = SyncEntryPayload(id: UUID(), description: "E", projectName: nil, clientName: nil, startedAt: at(0), endedAt: at(1), seconds: 1, billable: false, hourlyRate: 0, source: "manual", activityID: nil)
        let request = SyncRequest(appVersion: "t", activities: Array(repeating: activity, count: 1201), entries: Array(repeating: entry, count: 7), deletedEntryIDs: [UUID(), UUID()])
        let batches = request.batches()
        checkEqual(batches.count, 3)
        checkEqual(batches.map(\.activities.count), [500, 500, 201])
        checkEqual(batches.map(\.entries.count), [7, 0, 0])
        checkEqual(batches.map(\.deletedEntryIDs.count), [2, 0, 0])
        checkEqual(SyncRequest(appVersion: "t", activities: [], entries: [], deletedEntryIDs: []).batches().count, 1)
    }

    func testClientNormalizesServerURLAndRejectsJunk() {
        checkEqual(KiwiClient.normalizedServerURL(" https://lawdie.co/kiwi-api/ ")?.absoluteString, "https://lawdie.co/kiwi-api")
        checkEqual(KiwiClient.normalizedServerURL("http://localhost:4100")?.absoluteString, "http://localhost:4100")
        for junk in ["", "lawdie.co", "ftp://x", "file:///tmp", "https://"] { checkNil(KiwiClient.normalizedServerURL(junk), "\(junk) is not a server") }
        checkThrows(try KiwiClient(serverURL: "nope", token: "ldt_x"))
    }

    /// Against a real Kiwi (or a stub of its two endpoints) when TEMPO_KIWI_STUB_URL and
    /// TEMPO_KIWI_TOKEN are set: the actual URLSession path, headers and JSON.
    func testLiveSyncAgainstServer() async throws -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["TEMPO_KIWI_STUB_URL"], let token = env["TEMPO_KIWI_TOKEN"] else { return false }
        let client = try KiwiClient(serverURL: server, token: token)
        let hello = try await client.hello()
        checkTrue(hello.ok); checkTrue(!hello.device.id.isEmpty)
        var state = Workspace()
        let project = Project(name: "Whitfield v. Meridian", client: "Whitfield", hourlyRate: 350); state.projects = [project]
        let activity = Activity(app: "Microsoft Word", bundleID: "com.microsoft.Word", title: "Motion.docx", startedAt: at(0), endedAt: at(1200), endedBy: "switched", disposition: "kept")
        state.activities = [activity, Activity(app: "Preview", bundleID: "com.apple.Preview", startedAt: at(1300), endedAt: at(1600), endedBy: "idle")]
        state.entries = [TimeEntry(description: "Prepare motion", projectID: project.id, startedAt: at(0), endedAt: at(1200), billable: true, hourlyRate: 350, source: "desktop", activityID: activity.id)]
        state.sync = SyncState(serverURL: server, deviceID: hello.device.id, deviceName: hello.device.name, deletedEntryIDs: [UUID()])
        let response = try await client.sync(state.syncRequest(appVersion: "checks"))
        checkTrue(response.ok)
        checkEqual(response.activities, 2); checkEqual(response.entries, 1); checkEqual(response.deleted, 1)
        // A wrong token is refused as such, not as a transport failure.
        do { _ = try await KiwiClient(serverURL: server, token: "ldt_" + String(repeating: "x", count: 43)).hello(); fatalError("Expected a refusal") }
        catch let failure as KiwiClient.Failure { checkEqual(failure, .invalidToken) }
        return true
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
    static func main() async throws {
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
        try suite.testSyncRequestWireFormatIsSnakeCaseUTC(); print("PASS testSyncRequestWireFormatIsSnakeCaseUTC")
        try suite.testDeleteEntryRecordsTombstoneOnlyWhenConnected(); print("PASS testDeleteEntryRecordsTombstoneOnlyWhenConnected")
        suite.testMarkSyncedClearsOnlyAcknowledgedDeletions(); print("PASS testMarkSyncedClearsOnlyAcknowledgedDeletions")
        try suite.testWorkspaceWrittenBeforeSyncStillLoads(); print("PASS testWorkspaceWrittenBeforeSyncStillLoads")
        suite.testSyncBatchesStayUnderKiwiLimitWithDeletionsFirst(); print("PASS testSyncBatchesStayUnderKiwiLimitWithDeletionsFirst")
        suite.testClientNormalizesServerURLAndRejectsJunk(); print("PASS testClientNormalizesServerURLAndRejectsJunk")
        let live = try await suite.testLiveSyncAgainstServer()
        print(live ? "PASS testLiveSyncAgainstServer" : "SKIP testLiveSyncAgainstServer (set TEMPO_KIWI_STUB_URL and TEMPO_KIWI_TOKEN)")
        print("\n\(live ? 27 : 26) core checks passed.")
    }
}
