# Local release verification

Automated: `npm test`, `npm run typecheck`, `npm run package:mac` / `package:win` / `package:linux` (or the Build workflow).

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
- Kiwi: pair from the Time page, paste the token, confirm the hello names the account;
  keep an activity, wait a minute, see it on Kiwi's "On your desktop" and as a draft after
  rollup; delete it here and see the draft dismissed; disconnect from Kiwi and confirm
  the next sync reports the Mac as disconnected; disconnect here and confirm the Keychain
  item is gone (`security find-generic-password -s co.lawdie.timecapture.kiwi`).
- Confirm packaging and permission behavior on a clean Intel and Apple Silicon Mac, a Windows 11 PC (SmartScreen → Run anyway; capture of Word and Outlook; lock/unlock), and an X11 Linux desktop.

Distribution gates: a hosted download and a link from Kiwi's Time page; later,
Developer ID signing + notarization and Authenticode, and an updater.
