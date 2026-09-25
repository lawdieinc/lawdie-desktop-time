# Lawdie Time Capture

Native macOS time tracker. Work in this repo; do not modify `lawdie`, `kiwi`,
`lawdie-crm`, or `lawdie-time-capture` unless the user explicitly expands scope.

## Required brand direction

Apply the Lawdie brand guidelines from the sibling repository:
`../lawdie/Lawdie Brand Guidelines (1)/Lawdie Brand Guidelines (1).docx`.
See `docs/brand.md` and `Sources/Tempo/Theme.swift` for the implementation.
Use cream/espresso/brown-gold, bundled Playfair Display/Source Sans Pro/Fragment
Mono, and the supplied logo assets. Do not reintroduce the provisional green theme.

## Commands

- `swift build`
- `swift run TempoCoreChecks` (dependency-free checks; Command Line Tools lack XCTest)
- `bash scripts/package.sh` → `dist/Lawdie Time Capture.app`

Capture is opt-in. No networking, automatic matter matching, or live Kiwi/CRM
connections exist. Preserve the capture/review boundary and overlap checks.
Never seed sample entries in the real workspace. `--demo` uses an in-memory sample.

## Current state

Initial native implementation with timer, foreground-app capture, privacy controls,
review inbox, projects, entry editing, reports, CSV, backup/restore and core checks.
Integration and public distribution are later work; see `docs/release-checklist.md`.

2026-09-25: User selected the product name **Lawdie Time Capture**. Swift target
names retain Tempo internally; do not use Tempo in new product copy. User also
flagged the whitespace above Workspace / Today; `.ignoresSafeArea` now removes
that title-bar strip. Final branded screenshot verified. Release build and 20 core
checks passed; see `docs/verification.md` for the exact scope of validation.
