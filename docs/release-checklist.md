# Local release verification

Automated: `swift run TempoCoreChecks`, `swift build -c release`, `bash scripts/package.sh`.

Manual checks before distributing:

- Fresh launch has zero sample entries and capture disabled.
- Create a project, start/stop a timer, edit a saved entry, relaunch, confirm persistence.
- Close the main window, use the menu-bar timer, reopen the window.
- Enable capture, switch between native apps and a browser, verify app names/durations.
- Enable titles, grant Accessibility, and verify title availability in supported apps.
- Excluded apps do not create segments; pausing capture stops recording.
- Leave the machine idle past the configured timeout; only actual active time remains.
- Lock/unlock, sleep/wake, and switch user sessions; neither timer nor capture bridges gaps.
- Force-quit during a timer, relaunch, confirm recovery ends at last persisted heartbeat.
- Keep an activity once; overlapping or repeated review never duplicates time.
- Export CSV, save a backup, restore it, verify exact entries and paused capture.
- Test corrupt workspace recovery without losing the original file.
- Check reports across midnight and daylight-saving transitions.
- Confirm packaging and permission behavior on a clean Intel and Apple Silicon Mac.

Distribution gates: product naming/license decision, Developer ID signing,
notarization, accessibility permission stability, clean-machine testing, and a
reviewed update mechanism. Windows requires a separate foreground-app provider and
desktop UI implementation; it is not supported by the current SwiftUI target.
