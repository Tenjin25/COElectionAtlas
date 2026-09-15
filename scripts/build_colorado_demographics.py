"""Populate Colorado demographics from Census P2/P3 and RDH block CVAP.

County shares are 2020 resident population; voting-district and legislative
shares are 2020-2024 citizen voting-age population assigned by Census block
interior point to the atlas' current (2022) line geometry.
"""

from __future__ import annotations

import argparse
import csv
import json
import zipfile
from collections import defaultdict
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree


ROOT = Path(__file__).resolve().parents[1]
FIELDS = (
    "CVAP_TOT24", "CVAP_WHT24", "CVAP_BLA24", "CVAP_HSP24",
    "CVAP_AMI24", "CVAP_ASI24", "CVAP_NHP24", "CVAP_2OM24",
    "CVAP_AIW24", "CVAP_ASW24", "CVAP_BLW24", "CVAP_AIB24",
)
RACES = ("white", "black", "hispanic", "native", "asian", "pacific", "multiracial")
TARGETS = (
    ("precinct", "data/census/tl_2020_08_vtd20/tl_2020_08_vtd20.geojson", "VTDST20"),
    ("congressional", "data/tileset/co_cd118_tileset.geojson", "CD118FP"),
    ("state_house", "data/tileset/co_state_house_2022_lines_tileset.geojson", "SLDLST"),
    ("state_senate", "data/tileset/co_state_senate_2022_lines_tileset.geojson", "SLDUST"),
)


def pct(value: int, total: int) -> float:
    return round(value * 100 / total, 2) if total else 0.0


def read_census(census_zip: Path) -> tuple[dict[str, str], dict[str, tuple[str, float, float]]]:
    with zipfile.ZipFile(census_zip) as archive:
        counties = {}
        points = {}
        for line in archive.open("cogeo2020.pl"):
            row = line.decode("latin-1").rstrip("\r\n").split("|")
            if row[2] == "050":
                counties[row[7]] = (row[9], row[86])
            elif row[2] == "750":
                # 2020 block GEOID and its official interior coordinate.
                points[row[9]] = (row[9][2:5], float(row[-4]), float(row[-5]))
        profiles = {}
        for line in archive.open("co000012020.pl"):
            row = line.decode("latin-1").rstrip("\r\n").split("|")
            if row[4] not in counties:
                continue
            geoid, name = counties[row[4]]
            # Segment 1 has five controls, P1 (71 fields), then P2.
            p2 = [int(value or 0) for value in row[76:149]]
            total = p2[0]
            counts = {
                "white": p2[4], "black": p2[5], "hispanic": p2[1],
                "native": p2[6], "asian": p2[7], "pacific": p2[8],
                "multiracial": p2[10],
            }
            profiles[name.upper()] = {
                "county": name, "geoid20": geoid, "total_pop": total,
                **{f"{race}_pop": counts[race] for race in RACES},
                **{f"{race}_pop_pct": pct(counts[race], total) for race in RACES},
            }
        for line in archive.open("co000022020.pl"):
            row = line.decode("latin-1").rstrip("\r\n").split("|")
            if row[4] in counties:
                name = counties[row[4]][1].upper()
                profiles[name]["vap_18plus"] = int(row[5] or 0)
    if len(profiles) != 64:
        raise RuntimeError(f"Expected 64 Colorado counties, got {len(profiles)}")
    if sum(row["total_pop"] for row in profiles.values()) != 5773714:
        raise RuntimeError("Colorado county population does not reconcile to the 2020 Census state total")
    payload = {
        "source": "2020 Census P.L. 94-171 P2/P3, Colorado State Summary File",
        "notes": [
            "Race shares use total 2020 population, not CVAP.",
            "Categories are non-Hispanic race alone, Hispanic of any race, and non-Hispanic two or more races.",
            "vap_18plus is total voting-age population from P3.",
        ],
        "counties": profiles,
    }
    (ROOT / "data/county_demographics_2020_pl.json").write_text(
        json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    return {geoid[-3:]: name for geoid, name in counties.values()}, points


def load_target(relpath: str, field: str, county_names: dict[str, str]):
    obj = json.loads((ROOT / relpath).read_text(encoding="utf-8"))
    geometries, keys = [], []
    for feature in obj["features"]:
        props = feature["properties"]
        raw = str(props.get(field) or "").strip()
        if not raw:
            continue
        key = (
            f"{county_names[str(props['COUNTYFP20'])]} - {raw}".upper()
            if field == "VTDST20" else str(int(raw))
        )
        geometries.append(shape(feature["geometry"]))
        keys.append(key)
    return geometries, keys, STRtree(geometries)


def target_key(point: Point, target) -> str | None:
    geometries, keys, tree = target
    for raw_idx in tree.query(point):
        idx = int(raw_idx)
        if geometries[idx].covers(point):
            return keys[idx]
    nearest = tree.nearest(point)
    return keys[int(nearest)] if nearest is not None else None


def race_counts(values: list[int]) -> list[int]:
    (_, white, black, hispanic, native, asian, pacific, other,
     aiw, asw, blw, aib) = values
    return [white, black, hispanic, native, asian, pacific, other + aiw + asw + blw + aib]


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(header)
        writer.writerows(rows)


def build_cvap(cvap_zip: Path, county_names: dict[str, str], points: dict) -> None:
    targets = [load_target(relpath, field, county_names) for _, relpath, field in TARGETS]
    grouped = [defaultdict(lambda: [0] * len(FIELDS)) for _ in targets]
    with zipfile.ZipFile(cvap_zip) as archive:
        filename = next(name for name in archive.namelist() if name.lower().endswith(".csv"))
        lines = (line.decode("utf-8-sig") for line in archive.open(filename))
        reader = csv.DictReader(lines)
        matched = 0
        source_total = 0
        for row in reader:
            geoid = str(row["GEOID20"])
            values = [int(float(row.get(field) or 0)) for field in FIELDS]
            source_total += values[0]
            info = points.get(geoid)
            if not info:
                continue
            matched += 1
            _, lon, lat = info
            point = Point(lon, lat)
            for target, sums in zip(targets, grouped):
                key = target_key(point, target)
                if key is None:
                    continue
                accum = sums[key]
                for idx, value in enumerate(values):
                    accum[idx] += value
    if matched < 100000:
        raise RuntimeError(f"Only {matched} Colorado blocks matched the CVAP source")
    for label, sums in zip((item[0] for item in TARGETS), grouped):
        if sum(values[0] for values in sums.values()) != source_total:
            raise RuntimeError(f"{label} CVAP does not reconcile to the block source")

    precinct_rows = []
    for key, values in sorted(grouped[0].items()):
        total = values[0]
        races = race_counts(values)
        precinct_rows.append([key, total, *races, *[pct(value, total) for value in races]])
    write_csv(
        ROOT / "data/precinct_demographics_2020_vap.csv",
        ["precinct_id", "vap_18plus", *[f"{race}_vap" for race in RACES],
         *[f"{race}_vap_pct" for race in RACES]],
        precinct_rows,
    )
    write_csv(
        ROOT / "data/cvap_aggregates/precinct_2020__cvap24.csv",
        ["precinct_id", "CVAP_TOT24"],
        [[row[0], row[1]] for row in precinct_rows],
    )
    files = ("co_congressional_districts.csv", "co_state_house_districts.csv", "co_state_senate_districts.csv")
    for filename, sums in zip(files, grouped[1:]):
        rows = []
        for key, values in sorted(sums.items(), key=lambda item: int(item[0])):
            total = values[0]
            races = race_counts(values)
            rows.append([key, f"District {int(key):02d}", "", total, *[pct(value, total) for value in races]])
        write_csv(
            ROOT / "data" / filename,
            ["district", "name", "total_population", "cvap_total",
             *[f"{race}_vap_pct" for race in RACES]],
            rows,
        )
    print(f"Matched {matched:,} blocks; precincts={len(precinct_rows):,}; districts=" +
          ",".join(str(len(sums)) for sums in grouped[1:]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cvap-zip", type=Path, required=True)
    parser.add_argument("--census-zip", type=Path, default=ROOT / "data/co2020.pl.zip")
    args = parser.parse_args()
    county_names, points = read_census(args.census_zip)
    build_cvap(args.cvap_zip, county_names, points)


if __name__ == "__main__":
    main()
