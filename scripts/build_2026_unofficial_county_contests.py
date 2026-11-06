#!/usr/bin/env python3
"""Build 2026 unofficial county contest slices from Colorado's ENR detail TXT."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data" / "detailtxt.zip"
CONTESTS_DIR = ROOT / "data" / "contests"
MANIFEST_PATH = CONTESTS_DIR / "manifest.json"

FIELD_WIDTH = 30
CHOICE_WIDTH = 60
YEAR = 2026

CONTESTS = (
    {
        "contest_type": "us_senate",
        "title": "United States Senator (Vote For 1)",
        "dem_candidate": "John Hickenlooper",
        "rep_candidate": "Mark Baisley",
    },
    {
        "contest_type": "governor",
        "title": "Governor / Lieutenant Governor (Vote For 1)",
        "dem_candidate": "Phil Weiser / Lesley Dahlkemper",
        "rep_candidate": "Victor Marx / George Washington Markert",
    },
    {
        "contest_type": "secretary_of_state",
        "title": "Secretary of State (Vote For 1)",
        "dem_candidate": "Amanda Gonzalez",
        "rep_candidate": "James Wiley",
    },
    {
        "contest_type": "treasurer",
        "title": "State Treasurer (Vote For 1)",
        "dem_candidate": "Jeff Bridges",
        "rep_candidate": "Kevin Grantham",
    },
    {
        "contest_type": "attorney_general",
        "title": "Attorney General (Vote For 1)",
        "dem_candidate": "Jena Griswold",
        "rep_candidate": "Michael J. Allen",
    },
)


def read_detail_text(zip_path: Path) -> list[str]:
    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        detail_name = next((name for name in names if name.lower().endswith("detail.txt")), None)
        if not detail_name:
            raise ValueError(f"{zip_path} does not contain detail.txt")
        raw = archive.read(detail_name)
    return raw.decode("utf-8-sig", errors="replace").splitlines()


def integer_field(value: str, label: str) -> int:
    cleaned = value.strip().replace(",", "")
    if not cleaned.isdigit():
        raise ValueError(f"Expected an integer for {label}, got {value!r}")
    return int(cleaned)


def find_contest_start(lines: list[str], title: str) -> int:
    try:
        title_index = next(i for i, line in enumerate(lines) if title in line)
    except StopIteration as exc:
        raise ValueError(f"Contest not found: {title}") from exc

    for i in range(title_index + 1, min(len(lines), title_index + 8)):
        if lines[i].startswith("County") and "Registered Voters" in lines[i]:
            return i
    raise ValueError(f"County header not found for: {title}")


def parse_contest(lines: list[str], config: dict[str, str]) -> list[dict[str, object]]:
    header_index = find_contest_start(lines, config["title"])
    candidate_line = lines[header_index - 1]
    candidates: list[str] = []
    offset = FIELD_WIDTH * 2
    while offset < len(candidate_line):
        name = candidate_line[offset : offset + CHOICE_WIDTH].strip()
        if name:
            candidates.append(name)
        offset += CHOICE_WIDTH

    if config["dem_candidate"] not in candidates or config["rep_candidate"] not in candidates:
        raise ValueError(
            f"Could not identify major-party candidates for {config['title']}: {candidates}"
        )

    rows: list[dict[str, object]] = []
    for line in lines[header_index + 1 :]:
        if not line.strip():
            if rows:
                break
            continue

        county = line[:FIELD_WIDTH].strip()
        registered_text = line[FIELD_WIDTH : FIELD_WIDTH * 2].strip()
        if county.lower().startswith("total"):
            break
        if not county or not registered_text.replace(",", "").isdigit():
            if rows:
                break
            continue

        votes: dict[str, int] = {}
        for index, candidate in enumerate(candidates):
            start = FIELD_WIDTH * 2 + index * CHOICE_WIDTH
            votes[candidate] = integer_field(
                line[start : start + FIELD_WIDTH], f"{config['title']} / {county} / {candidate}"
            )

        dem_votes = votes[config["dem_candidate"]]
        rep_votes = votes[config["rep_candidate"]]
        total_votes = sum(votes.values())
        other_votes = total_votes - dem_votes - rep_votes
        major_party_total = dem_votes + rep_votes
        margin = rep_votes - dem_votes
        margin_pct = (margin / major_party_total * 100) if major_party_total else 0.0
        winner = "REP" if margin > 0 else ("DEM" if margin < 0 else "TIE")

        rows.append(
            {
                "county": county,
                "dem_votes": dem_votes,
                "rep_votes": rep_votes,
                "other_votes": other_votes,
                "total_votes": total_votes,
                "dem_candidate": config["dem_candidate"],
                "rep_candidate": config["rep_candidate"],
                "margin": margin,
                "margin_pct": margin_pct,
                "winner": winner,
                "color": "D" if winner == "DEM" else ("R" if winner == "REP" else "T"),
            }
        )

    if len(rows) != 64:
        raise ValueError(f"Expected 64 counties for {config['title']}, found {len(rows)}")
    return rows


def update_manifest(generated_entries: list[dict[str, object]]) -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    files = manifest.get("files", [])
    generated_types = {entry["contest_type"] for entry in generated_entries}
    files = [
        entry
        for entry in files
        if not (int(entry.get("year", 0)) == YEAR and entry.get("contest_type") in generated_types)
    ]
    files.extend(generated_entries)
    files.sort(key=lambda entry: (str(entry.get("contest_type", "")), int(entry.get("year", 0))))
    MANIFEST_PATH.write_text(
        json.dumps({"files": files}, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", type=Path, default=DEFAULT_INPUT)
    args = parser.parse_args()

    lines = read_detail_text(args.input)
    generated_entries: list[dict[str, object]] = []
    for config in CONTESTS:
        rows = parse_contest(lines, config)
        filename = f"{config['contest_type']}_{YEAR}.json"
        payload = {
            "meta": {
                "year": YEAR,
                "contest_type": config["contest_type"],
                "geography": "county",
                "status": "unofficial",
                "snapshot_date": "2026-11-05",
                "source": "Colorado Election Night Reporting detail TXT",
                "source_file": args.input.name,
            },
            "rows": rows,
        }
        (CONTESTS_DIR / filename).write_text(
            json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        generated_entries.append(
            {
                "year": YEAR,
                "contest_type": config["contest_type"],
                "file": filename,
                "rows": len(rows),
                "major_party_contested": True,
                "geography": "county",
                "status": "unofficial",
                "snapshot_date": "2026-11-05",
            }
        )

    update_manifest(generated_entries)
    print(f"Wrote {len(generated_entries)} unofficial 2026 county contest files")


if __name__ == "__main__":
    main()
