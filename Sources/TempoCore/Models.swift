import Foundation

public struct Project: Codable, Identifiable, Equatable {
    public var id: UUID
    public var name: String
    public var client: String
    public var color: String
    public var hourlyRate: Double
    public var archived: Bool
    public init(id: UUID = UUID(), name: String, client: String = "", color: String = "gold", hourlyRate: Double = 0, archived: Bool = false) {
        self.id = id; self.name = name; self.client = client; self.color = color
        self.hourlyRate = hourlyRate; self.archived = archived
    }
}

public struct TimeEntry: Codable, Identifiable, Equatable {
    public var id: UUID
    public var description: String
    public var projectID: UUID?
    public var startedAt: Date
    public var endedAt: Date
    public var billable: Bool
    public var hourlyRate: Double
    public var source: String
    public var activityID: UUID?
    public var seconds: TimeInterval { max(0, endedAt.timeIntervalSince(startedAt)) }
    public init(id: UUID = UUID(), description: String, projectID: UUID? = nil, startedAt: Date, endedAt: Date, billable: Bool = false, hourlyRate: Double = 0, source: String = "manual", activityID: UUID? = nil) {
        self.id = id; self.description = description; self.projectID = projectID
        self.startedAt = startedAt; self.endedAt = endedAt; self.billable = billable
        self.hourlyRate = hourlyRate; self.source = source; self.activityID = activityID
    }
}

public struct RunningTimer: Codable, Equatable {
    public var description: String
    public var projectID: UUID?
    public var startedAt: Date
    public var lastHeartbeat: Date
    public var billable: Bool
    public var hourlyRate: Double
}

public struct Activity: Codable, Identifiable, Equatable {
    public var id: UUID
    public var app: String
    public var bundleID: String
    public var title: String?
    public var startedAt: Date
    public var endedAt: Date
    public var endedBy: String
    public var disposition: String // pending | kept | dismissed
    public var seconds: TimeInterval { max(0, endedAt.timeIntervalSince(startedAt)) }
    public init(id: UUID = UUID(), app: String, bundleID: String, title: String? = nil, startedAt: Date, endedAt: Date, endedBy: String = "switched", disposition: String = "pending") {
        self.id = id; self.app = app; self.bundleID = bundleID; self.title = title
        self.startedAt = startedAt; self.endedAt = endedAt; self.endedBy = endedBy; self.disposition = disposition
    }
}

public struct Preferences: Codable, Equatable {
    public var captureEnabled = false
    public var captureTitles = false
    public var idleMinutes = 3
    public var retentionDays = 14
    public var excludedBundleIDs = ["com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords", "com.agilebits.onepassword7", "com.1password.1password"]
    public init() {}
}

public struct Workspace: Codable, Equatable {
    public var schemaVersion = 1
    public var projects: [Project] = []
    public var entries: [TimeEntry] = []
    public var activities: [Activity] = []
    public var timer: RunningTimer?
    public var currentActivity: Activity?
    public var preferences = Preferences()
    public init() {}

    public func project(_ id: UUID?) -> Project? { projects.first { $0.id == id } }
    public func overlaps(start: Date, end: Date, excluding id: UUID? = nil) -> Bool {
        entries.contains { $0.id != id && $0.startedAt < end && $0.endedAt > start }
            || (timer.map { $0.startedAt < end } ?? false)
    }
    public func seconds(on date: Date, billableOnly: Bool = false, calendar: Calendar = .current) -> Double {
        guard let interval = calendar.dateInterval(of: .day, for: date) else { return 0 }
        return entries.filter { !billableOnly || $0.billable }.reduce(0) { sum, entry in
            sum + max(0, min(entry.endedAt, interval.end).timeIntervalSince(max(entry.startedAt, interval.start)))
        }
    }
}

public enum TempoError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? { if case let .invalid(message) = self { return message }; return nil }
}

public enum Format {
    public static func duration(_ seconds: Double, clock: Bool = false) -> String {
        let total = max(0, Int(seconds))
        if clock { return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60) }
        if total < 60 { return "\(total)s" }
        return total >= 3600 ? "\(total / 3600)h \((total % 3600) / 60)m" : "\(total / 60)m"
    }
}
