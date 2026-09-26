import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// A second process must never overwrite the active process's workspace.
public final class WorkspaceLock {
    private var descriptor: Int32 = -1
    public init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        descriptor = open(directory.appendingPathComponent("workspace.lock").path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw TempoError.invalid("Could not open the workspace lock.") }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor); descriptor = -1
            throw TempoError.invalid("This workspace is already open in another Time Capture process. Quit that instance before continuing.")
        }
    }
    deinit { if descriptor >= 0 { flock(descriptor, LOCK_UN); close(descriptor) } }
}

public final class WorkspaceFile {
    public let url: URL
    public init(url: URL) { self.url = url }

    public func load() throws -> Workspace {
        guard FileManager.default.fileExists(atPath: url.path) else { return Workspace() }
        let state = try JSONDecoder().decode(Workspace.self, from: Data(contentsOf: url))
        guard state.schemaVersion == 1 else { throw TempoError.invalid("This workspace was created by a newer Time Capture version. Update Time Capture before opening it.") }
        guard state.preferences.idleMinutes >= 1, state.preferences.idleMinutes <= 60,
              state.preferences.retentionDays >= 1, state.preferences.retentionDays <= 365,
              Set(state.entries.map(\.id)).count == state.entries.count,
              Set(state.projects.map(\.id)).count == state.projects.count,
              Set(state.activities.map(\.id)).count == state.activities.count,
              state.projects.allSatisfy({ $0.hourlyRate.isFinite && $0.hourlyRate >= 0 }),
              state.entries.allSatisfy({ $0.endedAt > $0.startedAt && $0.hourlyRate.isFinite && $0.hourlyRate >= 0 }),
              state.activities.allSatisfy({ $0.endedAt >= $0.startedAt && ["pending", "kept", "dismissed"].contains($0.disposition) }),
              state.timer.map({ $0.lastHeartbeat >= $0.startedAt && $0.hourlyRate.isFinite && $0.hourlyRate >= 0 }) ?? true,
              state.sync.map({ KiwiClient.normalizedServerURL($0.serverURL) != nil && !$0.deviceID.isEmpty }) ?? true else {
            throw TempoError.invalid("The workspace contains invalid data. Restore a known-good backup.")
        }
        return state
    }

    public func save(_ state: Workspace) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

public enum Export {
    public static func csv(_ workspace: Workspace, entries: [TimeEntry]) -> String {
        let iso = ISO8601DateFormatter()
        func field(_ text: String) -> String {
            // Neutralize spreadsheet formula injection, including whitespace-prefixed formulas.
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let safe = trimmed.first.map { "=+-@".contains($0) } == true ? "'" + text : text
            return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        let header = "id,description,project,client,started_at,ended_at,seconds,billable,hourly_rate,amount,source"
        let rows = entries.sorted { $0.startedAt < $1.startedAt }.map { entry in
            let project = workspace.project(entry.projectID)
            return [entry.id.uuidString, entry.description, project?.name ?? "", project?.client ?? "", iso.string(from: entry.startedAt), iso.string(from: entry.endedAt), String(Int(entry.seconds)), entry.billable ? "true" : "false", String(entry.hourlyRate), String(entry.billable ? entry.seconds / 3600 * entry.hourlyRate : 0), entry.source].map(field).joined(separator: ",")
        }
        return ([header] + rows).joined(separator: "\r\n") + "\r\n"
    }
}
