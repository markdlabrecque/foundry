#!/usr/bin/env python3
"""Normalize a completed sibling probe, without altering observations or argv order.
Usage: python3 normalize-artifacts.py INPUT_DIR OUTPUT_DIR
Prefixes are lexical evidence labels, not executable reproduction paths.
"""
import json
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
summary = json.loads((source / "summary.json").read_text())
before = next(entry for entry in summary["log"] if entry["event"] == "before kill")
hold = before["holds"][0]
fixture = hold["cwd"].split("/home/slots/", 1)[0]
repo = str(Path(__file__).resolve().parents[3])
validation_root = str(source.parent)
replacements = [(fixture, "<fixture-root>"), (repo, "<repo>"),
                (hold["execPath"], "<node>"),
                (validation_root, "<fixture-root>/validation-temp")]
target.mkdir(parents=True, exist_ok=True)
for name in ["summary.json", "alpha.yaml", "daemon.log", "host.log", "group-cleanup.json"]:
    content = (source / name).read_text()
    for prefix, label in replacements:
        content = content.replace(prefix, label)
    content = content.rstrip() + "\n"
    if name.endswith(".json"):
        json.loads(content)
    (target / name).write_text(content)
