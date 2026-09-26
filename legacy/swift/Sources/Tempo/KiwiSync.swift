import Foundation
import Security
import TempoCore

/// The device token Kiwi issued for this Mac, in the login Keychain. It is the one
/// credential the app holds and it never enters workspace.json or a backup.
enum KiwiKeychain {
    static let service = "co.lawdie.timecapture.kiwi"
    static let account = "device-token"

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func save(_ token: String) throws {
        delete()
        var query = base
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw TempoError.invalid("Could not store the Kiwi token in your Keychain (error \(status)).") }
    }

    static func load() -> String? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() { SecItemDelete(base as CFDictionary) }
}

extension AppModel {
    static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    var kiwiConnected: Bool { workspace.sync != nil }

    /// Pair with the token Kiwi showed once. Hello confirms it before anything is stored.
    @discardableResult
    func connectKiwi(serverURL: String, token: String) async -> Bool {
        guard !isDemo else { error = "The sample workspace cannot connect to Kiwi."; return false }
        guard !loadFailed else { error = "Restore or repair the workspace before connecting to Kiwi."; return false }
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("ldt_") else { error = "Paste the token Kiwi showed when you connected this Mac. It starts with ldt_."; return false }
        syncing = true
        defer { syncing = false }
        do {
            let client = try KiwiClient(serverURL: serverURL, token: trimmed)
            let hello = try await client.hello()
            guard hello.ok else { throw KiwiClient.Failure.badResponse }
            try KiwiKeychain.save(trimmed)
            let state = SyncState(serverURL: client.baseURL.absoluteString, deviceID: hello.device.id, deviceName: hello.device.name, accountEmail: hello.user.email)
            guard change({ $0.sync = state }) else { KiwiKeychain.delete(); return false }
            notice = "Connected to Kiwi as \(hello.user.email ?? "your account"). This Mac is “\(hello.device.name)” there."
            syncing = false
            await syncNow()
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    func disconnectKiwi() {
        KiwiKeychain.delete()
        if change({ $0.sync = nil }) { notice = "Disconnected from Kiwi. Nothing more leaves this Mac; what was already synced stays in Kiwi." }
    }

    /// Push everything Kiwi should know. Safe to repeat: Kiwi upserts on the app's ids.
    func syncNow() async {
        guard !isDemo, !loadFailed, !syncing, let state = workspace.sync else { return }
        guard let token = KiwiKeychain.load() else {
            change { $0.sync?.lastError = "The Kiwi token is missing from your Keychain. Disconnect and connect again." }
            return
        }
        syncing = true
        defer { syncing = false }
        do {
            let client = try KiwiClient(serverURL: state.serverURL, token: token)
            var acknowledged: [UUID] = []
            for batch in workspace.syncRequest(appVersion: Self.appVersion).batches() {
                _ = try await client.sync(batch)
                acknowledged += batch.deletedEntryIDs
            }
            let date = Date()
            change { $0.markSynced(at: date, acknowledgedDeletions: acknowledged) }
        } catch {
            let message = error.localizedDescription
            change { $0.sync?.lastError = message }
        }
    }

    /// Called once a second from the pulse; syncs a minute apart while auto-sync is on.
    func syncTick(_ ticks: Int) {
        guard workspace.sync?.autoSync == true, ticks % 60 == 5 else { return }
        Task { @MainActor in await self.syncNow() }
    }
}
