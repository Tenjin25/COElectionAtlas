#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd


SRC_DIR = Path("data/openelections-data-co")
DISTRICT_CONTESTS_DIR = Path("data/district_contests")
DISTRICT_MANIFEST_PATH = DISTRICT_CONTESTS_DIR / "manifest.json"

CROSSWALKS = {
    "congressional": Path("data/crosswalks_cd118_from_2008/precinct_to_cd118.csv"),
    "state_house": Path("data/crosswalks_cd118_from_2008/precinct_to_sldl.csv"),
    "state_senate": Path("data/crosswalks_cd118_from_2008/precinct_to_sldu.csv"),
}

CONTEST_MAP = {
    "president": "president",
    "u.s. senate": "us_senate",
    "us senate": "us_senate",
    "u_s_senate": "us_senate",
}


def norm_party(party: str) -> str:
    p = str(party or "").strip().upper()
    if "DEMOCRAT" in p or p in {"D", "DEM"}:
        return "DEM"
    if "REPUBLIC" in p or "GOP" in p or p in {"R", "REP"}:
        return "REP"
    return "OTHER"


def normalize_precinct_id(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    digits = re.sub(r"[^0-9]", "", raw)
    return digits if digits else raw.upper()


def parse_year_from_name(path: Path) -> int | None:
    m = re.search(r"(\d{8})__co__", path.name.lower())
    if not m:
        return None
    return int(m.group(1)[:4])


def canonical_contest(office: str) -> str:
    o = str(office or "").strip().lower()
    if "president" in o:
        return "president"
    for key, val in CONTEST_MAP.items():
        if key in o:
            return val
    return ""


def load_statewide_precinct_rows() -> pd.DataFrame:
    files = sorted(SRC_DIR.rglob("*__co__general__precinct.csv"))
    frames: list[pd.DataFrame] = []

    for fp in files:
        year = parse_year_from_name(fp)
        if year is None:
            continue
        df = pd.read_csv(
            fp,
            dtype=str,
            usecols=lambda c: c.lower() in {"precinct", "office", "candidate", "party", "votes"},
            low_memory=False,
        )
        if df.empty:
            continue
        df.columns = [c.lower() for c in df.columns]
        for col in ["precinct", "office", "candidate", "party", "votes"]:
            if col not in df.columns:
                df[col] = ""
        df["year"] = year
        df["contest_type"] = df["office"].map(canonical_contest)
        df = df[df["contest_type"].isin({"president", "us_senate"})].copy()
        if df.empty:
            continue
        df["votes"] = pd.to_numeric(df["votes"], errors="coerce").fillna(0.0).astype(float)
        df = df[df["votes"] > 0].copy()
        df["party_norm"] = df["party"].map(norm_party)
        df["precinct_id"] = df["precinct"].map(normalize_precinct_id)
        df["candidate"] = df["candidate"].fillna("").astype(str).str.strip()
        df = df[df["precinct_id"].ne("")].copy()
        frames.append(df[["year", "precinct_id", "contest_type", "party_norm", "candidate", "votes"]])

    if not frames:
        raise RuntimeError("No statewide precinct contest rows found.")
    return pd.concat(frames, ignore_index=True)


def load_crosswalk(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, dtype=str)
    df.columns = [c.lower() for c in df.columns]
    for col in ["precinct_id", "target_id", "weight"]:
        if col not in df.columns:
            raise RuntimeError(f"Crosswalk missing required column '{col}': {path}")
    df["precinct_id"] = df["precinct_id"].map(normalize_precinct_id)
    df["target_id"] = (
        df["target_id"]
        .fillna("")
        .astype(str)
        .str.replace(r"[^0-9]", "", regex=True)
        .str.lstrip("0")
    )
    df["target_id"] = df["target_id"].replace("", "0")
    df["weight"] = pd.to_numeric(df["weight"], errors="coerce").fillna(0.0)
    df = df[(df["precinct_id"].ne("")) & (df["weight"] > 0)].copy()
    return df[["precinct_id", "target_id", "weight"]]


def render_payload(scope: str, contest_type: str, year: int, frame: pd.DataFrame) -> dict:
    agg = (
        frame.groupby(["target_id", "party_norm"], as_index=False)["weighted_votes"]
        .sum()
        .pivot_table(index=["target_id"], columns="party_norm", values="weighted_votes", fill_value=0.0)
        .reset_index()
    )
    for col in ["DEM", "REP", "OTHER"]:
        if col not in agg.columns:
            agg[col] = 0.0

    cand = (
        frame.groupby(["target_id", "party_norm", "candidate"], as_index=False)["weighted_votes"]
        .sum()
        .sort_values(["target_id", "party_norm", "weighted_votes"], ascending=[True, True, False])
    )
    top = cand.drop_duplicates(subset=["target_id", "party_norm"], keep="first")
    top_dem = top[top["party_norm"] == "DEM"][["target_id", "candidate"]].rename(columns={"candidate": "dem_candidate"})
    top_rep = top[top["party_norm"] == "REP"][["target_id", "candidate"]].rename(columns={"candidate": "rep_candidate"})
    agg = agg.merge(top_dem, on="target_id", how="left").merge(top_rep, on="target_id", how="left")
    agg["dem_candidate"] = agg["dem_candidate"].fillna("")
    agg["rep_candidate"] = agg["rep_candidate"].fillna("")

    results: dict[str, dict] = {}
    for _, row in agg.sort_values("target_id").iterrows():
        district_key = str(int(float(row["target_id"])))
        dem_votes = float(row["DEM"])
        rep_votes = float(row["REP"])
        other_votes = float(row["OTHER"])
        total_votes = dem_votes + rep_votes + other_votes
        two_party = dem_votes + rep_votes
        margin = rep_votes - dem_votes
        margin_pct = (margin / two_party * 100.0) if two_party > 0 else 0.0
        winner = "REP" if rep_votes > dem_votes else ("DEM" if dem_votes > rep_votes else "TIE")
        color = "R" if winner == "REP" else ("D" if winner == "DEM" else "T")
        results[district_key] = {
            "dem_votes": dem_votes,
            "rep_votes": rep_votes,
            "other_votes": other_votes,
            "total_votes": total_votes,
            "dem_candidate": str(row["dem_candidate"]),
            "rep_candidate": str(row["rep_candidate"]),
            "margin": margin,
            "margin_pct": margin_pct,
            "winner": winner,
            "color": color,
        }

    return {
        "year": int(year),
        "scope": scope,
        "contest_type": contest_type,
        "meta": {"source": "co_openelections_general_precinct_crosswalk", "match_coverage_pct": 100.0},
        "general": {"results": results},
    }


def main() -> None:
    DISTRICT_CONTESTS_DIR.mkdir(parents=True, exist_ok=True)
    precinct_rows = load_statewide_precinct_rows()
    manifest_entries: list[dict] = []

    for scope, crosswalk_path in CROSSWALKS.items():
        xw = load_crosswalk(crosswalk_path)
        merged = precinct_rows.merge(xw, on="precinct_id", how="inner")
        if merged.empty:
            continue
        merged["weighted_votes"] = merged["votes"] * merged["weight"]

        grouped = merged.groupby(["contest_type", "year"], sort=True)
        for (contest_type, year), chunk in grouped:
            payload = render_payload(scope, str(contest_type), int(year), chunk)
            filename = f"{scope}_{contest_type}_{int(year)}.json"
            with (DISTRICT_CONTESTS_DIR / filename).open("w", encoding="utf-8") as f:
                json.dump(payload, f)

            manifest_entries.append(
                {
                    "year": int(year),
                    "scope": scope,
                    "contest_type": str(contest_type),
                    "file": filename,
                    "rows": int(len(payload["general"]["results"])),
                    "major_party_contested": True,
                }
            )

    existing_files: list[dict] = []
    if DISTRICT_MANIFEST_PATH.exists():
        try:
            with DISTRICT_MANIFEST_PATH.open("r", encoding="utf-8") as f:
                existing_files = list(json.load(f).get("files", []))
        except Exception:
            existing_files = []

    # Keep existing chamber contests; replace only president/us_senate scope entries.
    filtered_existing = [
        e
        for e in existing_files
        if str(e.get("contest_type", "")).strip() not in {"president", "us_senate"}
    ]
    merged_manifest = sorted(
        filtered_existing + manifest_entries,
        key=lambda e: (str(e.get("scope", "")), str(e.get("contest_type", "")), int(e.get("year", 0))),
    )
    with DISTRICT_MANIFEST_PATH.open("w", encoding="utf-8") as f:
        json.dump({"files": merged_manifest}, f)

    print(f"Wrote {len(manifest_entries)} district statewide files and updated {DISTRICT_MANIFEST_PATH}")


if __name__ == "__main__":
    main()
