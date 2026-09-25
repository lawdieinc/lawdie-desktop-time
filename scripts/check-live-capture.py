#!/usr/bin/env python3
"""Check actual output from the running macOS recorder, not seeded core fixtures.

Enable capture, use another app, then pause/resume capture before running this.
Use --since with an ISO timestamp recorded before the test to exclude old records.
This tool only reads the workspace; it never enables capture or creates entries.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", type=Path, default=Path.home() / "Library/Application Support/Lawdie Time Capture/workspace.json")
parser.add_argument("--since", type=datetime.fromisoformat, default=datetime.now(timezone.utc) - timedelta(minutes=10))
args = parser.parse_args()
since = args.since.replace(tzinfo=timezone.utc) if args.since.tzinfo is None else args.since
state = json.loads(args.workspace.read_text())
reference_epoch = 978307200  # Foundation Codable Date reference epoch: 2001-01-01 UTC.
recent = [a for a in state["activities"] if a["startedAt"] + reference_epoch >= since.timestamp()]
assert recent, "FAIL: No completed real activity since test start. Enable capture, use another app, and pause/resume it."
for activity in recent:
    assert activity["endedAt"] > activity["startedAt"], "FAIL: Activity duration must be positive."
    assert activity["endedAt"] + reference_epoch <= datetime.now(timezone.utc).timestamp() + 1, "FAIL: Future activity timestamp."
    assert activity["bundleID"] != "co.lawdie.timecapture.desktop", "FAIL: Recorder captured itself."
    assert activity["app"], "FAIL: Missing foreground app name."
print(json.dumps({"result": "PASS", "completed_segments": len(recent), "seconds": round(sum(a["endedAt"] - a["startedAt"] for a in recent)), "apps": sorted({a["app"] for a in recent}), "capture_enabled_now": state["preferences"]["captureEnabled"]}, indent=2))
