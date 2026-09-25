# Verification — September 25, 2026

- Optimized native arm64 release build: passed on this Mac.
- Standalone core checks: 20 passed, covering capture opt-in, separate title opt-in,
  exclusions, app switching, idle trimming, sleep, crash recovery, unobserved gaps,
  single-timer enforcement, frozen rates, explicit/idempotent review, overlap and
  invalid-entry rejection, retention, midnight/DST, persistence roundtrip, corrupt
  file preservation, unknown schemas, CSV safety, writer locking, write failures,
  and invalid settings/rates.
- Packaged app signature: `codesign --verify --deep --strict` passed (ad-hoc local signing).
- Native app launched successfully. Inspected the Today view and time-entry editor.
- Final screenshot verified the official wordmark, cream/espresso/brown-gold theme,
  font hierarchy, Lawdie Time Capture name, and removal of the blank title-bar strip.
- Real workspace remained empty with desktop capture paused during UI inspection.

Not manually verified yet: Accessibility-granted window-title capture, sustained
real-app tracking, physical lock/sleep transitions, menu-bar background use, and the
full backup/restore interaction. Their state-machine/storage behavior is covered by
core checks, but OS integration still needs the manual release checks.

The app is a local macOS build, not notarized for external distribution. The repo
is initialized locally; no GitHub remote has been created or pushed.

## Follow-up — real capture failure and fix

The user enabled capture but no activity was recorded. Inspection found the native
idle query used `.null`, a specific event type, instead of `kCGAnyInputEventType`
(`UInt32.max`). That could report continuous idle time and discard all activity.
The pure state-machine tests did not exercise this macOS API boundary.

Corrected the native query and rebuilt/re-signed the app. Verified against the real
running app: a Cursor foreground segment accumulated live, pausing capture completed
it, and the Activity inbox showed that real segment with Keep time / Dismiss actions.
Resumed capture afterward; window-title capture stayed off. Core checks still pass.
`scripts/check-live-capture.py` checks recent persisted output from the actual recorder
and fails when no real segments have appeared, unlike seeded unit fixtures.

Basic foreground capture plus pause/resume is now manually verified. Physical
lock/sleep, Accessibility titles, and extended continuous tracking remain unverified.
