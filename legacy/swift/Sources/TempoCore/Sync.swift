import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Kiwi sync. The wire contract lives here once and in kiwi/backend/src/lib/desktopTime.ts
// once: snake_case keys (spelled out in CodingKeys), UTC ISO-8601 instants, the app's own
// UUIDs as the idempotency keys. Change one and change the other. The device token is never in the workspace
// file; the macOS layer keeps it in the Keychain and hands it to KiwiClient per call.

/// That this workspace syncs to Kiwi, and how it went last time.
public struct SyncState: Codable, Equatable {
    public static let defaultServerURL = "https://lawdie.co/kiwi-api"
    public var serverURL: String
    /// Kiwi's id and name for this Mac, as returned by the pairing hello.
    public var deviceID: String
    public var deviceName: String
    public var accountEmail: String?
    public var autoSync: Bool
    public var lastSyncedAt: Date?
    public var lastError: String?
    /// Entries deleted here since the last acknowledged sync. Kiwi tombstones them and
    /// dismisses any draft it made from them; the ids are cleared once acknowledged.
    public var deletedEntryIDs: [UUID]
    public init(serverURL: String, deviceID: String, deviceName: String, accountEmail: String? = nil, autoSync: Bool = true, lastSyncedAt: Date? = nil, lastError: String? = nil, deletedEntryIDs: [UUID] = []) {
        self.serverURL = serverURL; self.deviceID = deviceID; self.deviceName = deviceName; self.accountEmail = accountEmail
        self.autoSync = autoSync; self.lastSyncedAt = lastSyncedAt; self.lastError = lastError; self.deletedEntryIDs = deletedEntryIDs
    }
}

public struct SyncActivityPayload: Codable, Equatable {
    public var id: UUID
    public var app: String
    public var bundleID: String
    public var title: String?
    public var startedAt: Date
    public var endedAt: Date
    public var seconds: Int
    public var endedBy: String
    public var disposition: String
    // Explicit keys: Foundation's snake-case strategy turns "IDs" into "i_ds".
    enum CodingKeys: String, CodingKey { case id, app, bundleID = "bundle_id", title, startedAt = "started_at", endedAt = "ended_at", seconds, endedBy = "ended_by", disposition }
    public init(id: UUID, app: String, bundleID: String, title: String?, startedAt: Date, endedAt: Date, seconds: Int, endedBy: String, disposition: String) {
        self.id = id; self.app = app; self.bundleID = bundleID; self.title = title; self.startedAt = startedAt
        self.endedAt = endedAt; self.seconds = seconds; self.endedBy = endedBy; self.disposition = disposition
    }
}

public struct SyncEntryPayload: Codable, Equatable {
    public var id: UUID
    public var description: String
    public var projectName: String?
    public var clientName: String?
    public var startedAt: Date
    public var endedAt: Date
    public var seconds: Int
    public var billable: Bool
    public var hourlyRate: Double
    public var source: String
    public var activityID: UUID?
    enum CodingKeys: String, CodingKey { case id, description, projectName = "project_name", clientName = "client_name", startedAt = "started_at", endedAt = "ended_at", seconds, billable, hourlyRate = "hourly_rate", source, activityID = "activity_id" }
    public init(id: UUID, description: String, projectName: String?, clientName: String?, startedAt: Date, endedAt: Date, seconds: Int, billable: Bool, hourlyRate: Double, source: String, activityID: UUID?) {
        self.id = id; self.description = description; self.projectName = projectName; self.clientName = clientName
        self.startedAt = startedAt; self.endedAt = endedAt; self.seconds = seconds; self.billable = billable
        self.hourlyRate = hourlyRate; self.source = source; self.activityID = activityID
    }
}

public struct SyncRequest: Codable, Equatable {
    /// Kiwi refuses more than this many activities or entries in one call.
    public static let maxItems = 500
    public var appVersion: String
    public var activities: [SyncActivityPayload]
    public var entries: [SyncEntryPayload]
    public var deletedEntryIDs: [UUID]
    enum CodingKeys: String, CodingKey { case appVersion = "app_version", activities, entries, deletedEntryIDs = "deleted_entry_ids" }
    public init(appVersion: String, activities: [SyncActivityPayload], entries: [SyncEntryPayload], deletedEntryIDs: [UUID]) {
        self.appVersion = appVersion; self.activities = activities; self.entries = entries; self.deletedEntryIDs = deletedEntryIDs
    }
    public var isEmpty: Bool { activities.isEmpty && entries.isEmpty && deletedEntryIDs.isEmpty }

    /// Requests Kiwi will accept, in order. Deletions travel with the first so a
    /// re-created draft cannot outlive its entry; every batch is a full upsert.
    public func batches(maxItems: Int = SyncRequest.maxItems) -> [SyncRequest] {
        let count = max(1, Int((Double(max(activities.count, entries.count, deletedEntryIDs.count)) / Double(maxItems)).rounded(.up)))
        return (0..<count).map { index in
            let slice = { (n: Int) in (index * maxItems)..<min(n, (index + 1) * maxItems) }
            return SyncRequest(
                appVersion: appVersion,
                activities: index * maxItems < activities.count ? Array(activities[slice(activities.count)]) : [],
                entries: index * maxItems < entries.count ? Array(entries[slice(entries.count)]) : [],
                deletedEntryIDs: index * maxItems < deletedEntryIDs.count ? Array(deletedEntryIDs[slice(deletedEntryIDs.count)]) : []
            )
        }
    }
}

public struct HelloResponse: Codable, Equatable {
    public struct Device: Codable, Equatable { public var id: String; public var name: String }
    public struct User: Codable, Equatable { public var email: String? }
    public var ok: Bool
    public var device: Device
    public var user: User
}

public struct SyncResponse: Codable, Equatable {
    public var ok: Bool
    public var activities: Int
    public var entries: Int
    public var deleted: Int
}

public enum SyncWire {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

extension Workspace {
    /// Everything Kiwi should know: closed activity segments within retention, every kept
    /// entry with its local project labels, and the deletions not yet acknowledged. The
    /// in-progress segment and the running timer stay here until they end.
    public func syncRequest(appVersion: String) -> SyncRequest {
        SyncRequest(
            appVersion: appVersion,
            activities: activities.map { activity in
                SyncActivityPayload(id: activity.id, app: activity.app, bundleID: activity.bundleID, title: activity.title, startedAt: activity.startedAt, endedAt: activity.endedAt, seconds: Int(activity.seconds), endedBy: activity.endedBy, disposition: activity.disposition)
            },
            entries: entries.map { entry in
                let project = self.project(entry.projectID)
                return SyncEntryPayload(id: entry.id, description: entry.description, projectName: project?.name, clientName: project.flatMap { $0.client.isEmpty ? nil : $0.client }, startedAt: entry.startedAt, endedAt: entry.endedAt, seconds: Int(entry.seconds), billable: entry.billable, hourlyRate: entry.hourlyRate, source: entry.source, activityID: entry.activityID)
            },
            deletedEntryIDs: sync?.deletedEntryIDs ?? []
        )
    }

    /// Removes an entry, reopens the activity it came from, and remembers the deletion
    /// for Kiwi when connected.
    public mutating func deleteEntry(_ id: UUID) {
        guard let entry = entries.first(where: { $0.id == id }) else { return }
        entries.removeAll { $0.id == id }
        if let index = activities.firstIndex(where: { $0.id == entry.activityID }) { activities[index].disposition = "pending" }
        if sync != nil, sync?.deletedEntryIDs.contains(id) == false { sync?.deletedEntryIDs.append(id) }
    }

    /// A sync Kiwi accepted: clear only the deletions it saw, so one made mid-flight
    /// goes out next time.
    public mutating func markSynced(at date: Date, acknowledgedDeletions: [UUID]) {
        sync?.deletedEntryIDs.removeAll { acknowledgedDeletions.contains($0) }
        sync?.lastSyncedAt = date
        sync?.lastError = nil
    }
}

/// The two calls the app makes: hello to confirm a pairing, sync to push.
public struct KiwiClient {
    public enum Failure: LocalizedError, Equatable {
        case invalidServerURL
        case invalidToken
        case deviceRevoked
        case migrationPending
        case tooLarge
        case http(Int)
        case transport(String)
        case badResponse
        public var errorDescription: String? {
            switch self {
            case .invalidServerURL: "Enter the Kiwi server address, such as https://lawdie.co/kiwi-api."
            case .invalidToken: "Kiwi did not accept this token. Connect the Mac again from Kiwi's Time page and paste the new token."
            case .deviceRevoked: "This Mac was disconnected in Kiwi. Connect it again from Kiwi's Time page to resume syncing."
            case .migrationPending: "Kiwi is not ready for desktop sync yet (its database migration is pending)."
            case .tooLarge: "Kiwi refused the sync as too large. Try again; the app sends it in smaller pieces."
            case let .http(status): "Kiwi answered with an unexpected status (\(status))."
            case let .transport(message): "Could not reach Kiwi: \(message)"
            case .badResponse: "Kiwi answered in a way this app does not understand."
            }
        }
    }

    public let baseURL: URL
    public let token: String
    public var session: URLSession
    public var timeout: TimeInterval = 30

    public init(serverURL: String, token: String, session: URLSession = .shared) throws {
        guard let url = KiwiClient.normalizedServerURL(serverURL) else { throw Failure.invalidServerURL }
        baseURL = url; self.token = token; self.session = session
    }

    /// An http(s) URL with a host, without a trailing slash, or nil.
    public static func normalizedServerURL(_ text: String) -> URL? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    public func hello() async throws -> HelloResponse { try await send("GET", "desktop-time/hello", body: nil) }

    public func sync(_ request: SyncRequest) async throws -> SyncResponse {
        try await send("POST", "desktop-time/sync", body: try SyncWire.encoder().encode(request))
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: Data?) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) } catch { throw Failure.transport(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
        switch http.statusCode {
        case 200..<300:
            do { return try SyncWire.decoder().decode(T.self, from: data) } catch { throw Failure.badResponse }
        case 401:
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
            throw code == "device_revoked" ? Failure.deviceRevoked : Failure.invalidToken
        case 413: throw Failure.tooLarge
        case 503: throw Failure.migrationPending
        default: throw Failure.http(http.statusCode)
        }
    }
}
