#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

CORE_STATEWIDE = {
    "president",
    "us_senate",
    "governor",
    "lt_governor",
    "secretary_of_state",
    "attorney_general",
    "treasurer",
}
STATEWIDE_CONTESTS = CORE_STATEWIDE | {"us_senate"}
STATEWIDE_YEAR_MIN = 2002
STATEWIDE_YEAR_MAX = 2022
DISTRICT_YEAR_MIN = 2022
DISTRICT_YEAR_MAX = 2024


def norm_party(p: str) -> str:
    s = str(p or "").strip().upper()
    if "DEMOCRAT" in s:
        return "DEM"
    if "REPUBLIC" in s or "GOP" in s:
        return "REP"
    if s in {"DEMOCRAT", "DEMOCRATIC", "D", "DEM"}:
        return "DEM"
    if s in {"REPUBLICAN", "R", "REP", "GOP"}:
        return "REP"
    return "OTHER"


def slug(s: str) -> str:
    t = re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")
    return t or "unknown"


def parse_year_from_name(path: Path) -> int | None:
    m = re.search(r"(\d{8})__co__", path.name.lower())
    if not m:
        return None
    return int(m.group(1)[:4])


def is_general_election_file(path: Path) -> bool:
    n = path.name.lower()
    return "__general__" in n or "__general-" in n or "-general__" in n or "__special_general__" in n


def parse_district_num(district: str) -> str:
    d = str(district or "").strip().lower()
    if not d or d == "nan":
        return ""
    m = re.search(r"(\d+)", d)
    return str(int(m.group(1))) if m else ""


def normalize_county_name(county: str) -> str:
    c = str(county or "").strip()
    if not c or c.lower() == "nan":
        return ""
    c = re.sub(r"\s+county$", "", c, flags=re.IGNORECASE).strip()
    return c.title()


def canonical_contest(office: str, district: str) -> str:
    o = str(office or "").strip().lower()
    dnum = parse_district_num(district)

    if "president" in o:
        return "president"
    if "u.s. senate" in o or "us senate" in o or "u_s_senate" in o:
        return "us_senate"
    if "u.s. house" in o or "us house" in o or "congress" in o:
        if dnum and 1 <= int(dnum) <= 8:
            return f"us_house_{dnum}"
        return slug(f"{office} {district}")
    if "governor" in o and "lieutenant" not in o:
        return "governor"
    if "lieutenant governor" in o:
        return "lt_governor"
    if "secretary of state" in o:
        return "secretary_of_state"
    if "attorney general" in o:
        return "attorney_general"
    if "treasurer" in o:
        return "treasurer"
    if "state senate" in o:
        if dnum and 1 <= int(dnum) <= 35:
            return f"state_senate_{dnum}"
        return "state_senate"
    if "state representative" in o or "state house" in o:
        if dnum and 1 <= int(dnum) <= 65:
            return f"state_house_{dnum}"
        return "state_house"
    if "regent" in o and "university" in o:
        return f"university_regent_{dnum}" if dnum else "university_regent"
    return slug(f"{office} {district}")


def is_core_contest(contest: str) -> bool:
    c = str(contest or "").strip().lower()
    if c in CORE_STATEWIDE:
        return True
    if re.fullmatch(r"us_house_[1-8]", c):
        return True
    if re.fullmatch(r"state_senate_([1-9]|[12][0-9]|3[0-5])", c):
        return True
    if re.fullmatch(r"state_house_([1-9]|[1-5][0-9]|6[0-5])", c):
        return True
    return False


def is_in_scope_year(contest: str, year: int) -> bool:
    c = str(contest or "").strip().lower()
    y = int(year)
    if c == "president":
        return 2000 <= y <= 2024
    if c in CORE_STATEWIDE or c == "us_senate":
        return STATEWIDE_YEAR_MIN <= y <= STATEWIDE_YEAR_MAX
    if re.fullmatch(r"us_house_[1-8]", c):
        return DISTRICT_YEAR_MIN <= y <= DISTRICT_YEAR_MAX
    if re.fullmatch(r"state_senate_([1-9]|[12][0-9]|3[0-5])", c):
        return DISTRICT_YEAR_MIN <= y <= DISTRICT_YEAR_MAX
    if re.fullmatch(r"state_house_([1-9]|[1-5][0-9]|6[0-5])", c):
        return DISTRICT_YEAR_MIN <= y <= DISTRICT_YEAR_MAX
    return False


def contest_bucket(contest: str) -> str:
    c = str(contest or "").strip().lower()
    if re.fullmatch(r"us_house_[1-8]", c):
        return "us_house"
    if re.fullmatch(r"state_senate_([1-9]|[12][0-9]|3[0-5])", c):
        return "state_senate"
    if re.fullmatch(r"state_house_([1-9]|[1-5][0-9]|6[0-5])", c):
        return "state_house"
    return c


def district_scope_and_type(contest: str) -> tuple[str, str, str] | None:
    c = str(contest or "").strip().lower()
    if re.fullmatch(r"us_house_[1-8]", c):
        return ("congressional", "us_house", c.rsplit("_", 1)[-1])
    if re.fullmatch(r"state_house_([1-9]|[1-5][0-9]|6[0-5])", c):
        return ("state_house", "state_house", c.rsplit("_", 1)[-1])
    if re.fullmatch(r"state_senate_([1-9]|[12][0-9]|3[0-5])", c):
        return ("state_senate", "state_senate", c.rsplit("_", 1)[-1])
    return None


def main() -> None:
    src = Path("data/openelections-data-co")
    out_dir = Path("data")
    contests_dir = out_dir / "contests"
    district_contests_dir = out_dir / "district_contests"
    out_dir.mkdir(parents=True, exist_ok=True)
    contests_dir.mkdir(parents=True, exist_ok=True)
    district_contests_dir.mkdir(parents=True, exist_ok=True)

    files = sorted(src.rglob("*__co__*__*.csv"))
    rows = []
    for fp in files:
        if not is_general_election_file(fp):
            continue
        year = parse_year_from_name(fp)
        if year is None:
            continue
        try:
            df = pd.read_csv(
                fp,
                usecols=lambda c: c.lower() in {"county", "office", "district", "party", "candidate", "votes"},
                dtype=str,
                low_memory=False,
            )
        except Exception:
            continue
        if df.empty:
            continue
        df.columns = [c.lower() for c in df.columns]
        df["year"] = year
        for c in ["county", "office", "district", "party", "candidate"]:
            if c not in df.columns:
                df[c] = ""
        if "votes" not in df.columns:
            df["votes"] = "0"
        df["votes"] = pd.to_numeric(df["votes"], errors="coerce").fillna(0).astype(float)
        rows.append(df[["year", "county", "office", "district", "party", "candidate", "votes"]])

    if not rows:
        raise SystemExit("No rows found to aggregate.")

    raw = pd.concat(rows, ignore_index=True)
    raw["county"] = raw["county"].map(normalize_county_name)
    raw = raw[raw["county"].astype(str).str.strip().ne("")].copy()
    raw["office"] = raw["office"].astype(str).str.strip()
    raw["district"] = raw["district"].astype(str).str.strip()
    raw["candidate"] = raw["candidate"].astype(str).str.strip()
    raw["contest"] = raw.apply(lambda r: canonical_contest(r["office"], r["district"]), axis=1)
    raw["contest_raw"] = raw["contest"]
    raw["party_norm"] = raw["party"].astype(str).map(norm_party)
    raw = raw[raw["contest"].map(is_core_contest)].copy()
    raw = raw[raw.apply(lambda r: is_in_scope_year(r["contest"], r["year"]), axis=1)].copy()
    raw["contest"] = raw["contest"].map(contest_bucket)

    agg = (
        raw.groupby(["year", "county", "contest", "party_norm"], as_index=False)["votes"]
        .sum()
        .pivot_table(index=["year", "county", "contest"], columns="party_norm", values="votes", fill_value=0)
        .reset_index()
    )
    for col in ["DEM", "REP", "OTHER"]:
        if col not in agg.columns:
            agg[col] = 0.0
    agg["total"] = agg["DEM"] + agg["REP"] + agg["OTHER"]

    agg_csv = out_dir / "co_county_contests_aggregated.csv"
    agg.rename(columns={"DEM": "dem", "REP": "rep", "OTHER": "other"}).to_csv(agg_csv, index=False)

    records = []
    for r in agg.to_dict(orient="records"):
        records.append(
            {
                "year": int(r["year"]),
                "county": r["county"],
                "contest": r["contest"],
                "dem": float(r["DEM"]),
                "rep": float(r["REP"]),
                "other": float(r["OTHER"]),
                "total": float(r["total"]),
            }
        )
    with (out_dir / "co_elections_aggregated.json").open("w", encoding="utf-8") as f:
        json.dump({"state": "CO", "records": records}, f)

    statewide = (
        agg.groupby(["year", "contest"], as_index=False)[["DEM", "REP", "OTHER", "total"]]
        .sum()
        .rename(columns={"DEM": "dem", "REP": "rep", "OTHER": "other"})
    )
    statewide.to_csv(out_dir / "co_statewide_contests_aggregated.csv", index=False)

    # Build county contest-slice payloads the atlas expects under data/contests.
    cand = (
        raw.groupby(["year", "county", "contest", "party_norm", "candidate"], as_index=False)["votes"]
        .sum()
        .sort_values(["year", "county", "contest", "party_norm", "votes"], ascending=[True, True, True, True, False])
    )
    top_cand = cand.drop_duplicates(subset=["year", "county", "contest", "party_norm"], keep="first")
    top_dem = top_cand[top_cand["party_norm"] == "DEM"][["year", "county", "contest", "candidate"]].rename(columns={"candidate": "dem_candidate"})
    top_rep = top_cand[top_cand["party_norm"] == "REP"][["year", "county", "contest", "candidate"]].rename(columns={"candidate": "rep_candidate"})

    # Stabilize candidate labels for county/statewide slices:
    # use the strongest statewide DEM/REP name for a contest-year and apply where local rows are blank/noisy.
    statewide_top = (
        cand.groupby(["year", "contest", "party_norm", "candidate"], as_index=False)["votes"]
        .sum()
        .sort_values(["year", "contest", "party_norm", "votes"], ascending=[True, True, True, False])
        .drop_duplicates(subset=["year", "contest", "party_norm"], keep="first")
    )
    statewide_dem = statewide_top[statewide_top["party_norm"] == "DEM"][["year", "contest", "candidate"]].rename(
        columns={"candidate": "dem_candidate_statewide"}
    )
    statewide_rep = statewide_top[statewide_top["party_norm"] == "REP"][["year", "contest", "candidate"]].rename(
        columns={"candidate": "rep_candidate_statewide"}
    )

    wide = agg.merge(top_dem, on=["year", "county", "contest"], how="left").merge(
        top_rep, on=["year", "county", "contest"], how="left"
    )
    wide = wide.merge(statewide_dem, on=["year", "contest"], how="left").merge(
        statewide_rep, on=["year", "contest"], how="left"
    )
    wide["dem_candidate"] = wide["dem_candidate"].fillna("").astype(str).str.strip()
    wide["rep_candidate"] = wide["rep_candidate"].fillna("").astype(str).str.strip()
    wide["dem_candidate_statewide"] = wide["dem_candidate_statewide"].fillna("").astype(str).str.strip()
    wide["rep_candidate_statewide"] = wide["rep_candidate_statewide"].fillna("").astype(str).str.strip()
    wide["dem_candidate"] = wide.apply(
        lambda r: (
            r["dem_candidate_statewide"]
            if str(r["contest"]) in STATEWIDE_CONTESTS and r["dem_candidate_statewide"]
            else (r["dem_candidate"] if r["dem_candidate"] else r["dem_candidate_statewide"])
        ),
        axis=1,
    )
    wide["rep_candidate"] = wide.apply(
        lambda r: (
            r["rep_candidate_statewide"]
            if str(r["contest"]) in STATEWIDE_CONTESTS and r["rep_candidate_statewide"]
            else (r["rep_candidate"] if r["rep_candidate"] else r["rep_candidate_statewide"])
        ),
        axis=1,
    )
    wide = wide.drop(columns=["dem_candidate_statewide", "rep_candidate_statewide"], errors="ignore")
    wide["dem_candidate"] = wide["dem_candidate"].fillna("")
    wide["rep_candidate"] = wide["rep_candidate"].fillna("")
    wide = wide.rename(columns={"DEM": "dem_votes", "REP": "rep_votes", "OTHER": "other_votes", "total": "total_votes"})
    tp = (wide["dem_votes"] + wide["rep_votes"]).replace(0, 1)
    wide["margin"] = wide["rep_votes"] - wide["dem_votes"]
    wide["margin_pct"] = ((wide["rep_votes"] - wide["dem_votes"]) / tp) * 100.0
    wide["winner"] = wide.apply(lambda r: "REP" if r["rep_votes"] > r["dem_votes"] else ("DEM" if r["dem_votes"] > r["rep_votes"] else "TIE"), axis=1)
    wide["color"] = wide.apply(lambda r: "R" if r["winner"] == "REP" else ("D" if r["winner"] == "DEM" else "T"), axis=1)

    # Remove stale slice files so manifest and directory stay in sync.
    for old in contests_dir.glob("*.json"):
        old.unlink(missing_ok=True)
    for old in district_contests_dir.glob("*.json"):
        old.unlink(missing_ok=True)

    manifest_files = []
    for (contest, year), g in wide.groupby(["contest", "year"], sort=True):
        county_coverage = int(g["county"].astype(str).str.strip().ne("").sum())
        # Guardrail: drop clearly partial statewide slices (e.g., single-county artifacts)
        # so dropdown/results don't show misleading candidate+margin outputs.
        if str(contest) in STATEWIDE_CONTESTS and county_coverage < 10:
            continue
        file_name = f"{contest}_{int(year)}.json"
        rows_out = []
        major_party_contested = False
        for _, r in g.sort_values("county").iterrows():
            dem_votes = float(r["dem_votes"])
            rep_votes = float(r["rep_votes"])
            total_votes = float(r["total_votes"])
            # Guard against inflated OTHER from upstream artifacts.
            other_votes = max(0.0, total_votes - dem_votes - rep_votes)
            if dem_votes > 0 and rep_votes > 0:
                major_party_contested = True
            rows_out.append(
                {
                    "county": str(r["county"]),
                    "dem_votes": dem_votes,
                    "rep_votes": rep_votes,
                    "other_votes": other_votes,
                    "total_votes": total_votes,
                    "dem_candidate": str(r["dem_candidate"]),
                    "rep_candidate": str(r["rep_candidate"]),
                    "margin": float(r["margin"]),
                    "margin_pct": float(r["margin_pct"]),
                    "winner": str(r["winner"]),
                    "color": str(r["color"]),
                }
            )
        with (contests_dir / file_name).open("w", encoding="utf-8") as f:
            json.dump({"rows": rows_out}, f)
        manifest_files.append(
            {
                "year": int(year),
                "contest_type": str(contest),
                "file": file_name,
                "rows": len(rows_out),
                "major_party_contested": major_party_contested,
            }
        )

    # Build district-scope slice payloads for chamber contests.
    # These are used by district/state-house/state-senate map views.
    district_manifest_files = []
    district_source = raw.copy()
    district_source["district_meta"] = district_source["contest_raw"].map(district_scope_and_type)
    district_source = district_source[district_source["district_meta"].notna()].copy()
    if not district_source.empty:
        district_source["scope"] = district_source["district_meta"].map(lambda t: t[0])
        district_source["contest_type"] = district_source["district_meta"].map(lambda t: t[1])
        district_source["district_num"] = district_source["district_meta"].map(lambda t: t[2])

        district_agg = (
            district_source.groupby(
                ["year", "scope", "contest_type", "district_num", "party_norm"], as_index=False
            )["votes"]
            .sum()
            .pivot_table(
                index=["year", "scope", "contest_type", "district_num"],
                columns="party_norm",
                values="votes",
                fill_value=0,
            )
            .reset_index()
        )
        for col in ["DEM", "REP", "OTHER"]:
            if col not in district_agg.columns:
                district_agg[col] = 0.0
        district_agg["total"] = district_agg["DEM"] + district_agg["REP"] + district_agg["OTHER"]

        district_cand = (
            district_source.groupby(
                ["year", "scope", "contest_type", "district_num", "party_norm", "candidate"], as_index=False
            )["votes"]
            .sum()
            .sort_values(
                ["year", "scope", "contest_type", "district_num", "party_norm", "votes"],
                ascending=[True, True, True, True, True, False],
            )
        )
        district_top = district_cand.drop_duplicates(
            subset=["year", "scope", "contest_type", "district_num", "party_norm"], keep="first"
        )
        district_dem = district_top[district_top["party_norm"] == "DEM"][
            ["year", "scope", "contest_type", "district_num", "candidate"]
        ].rename(columns={"candidate": "dem_candidate"})
        district_rep = district_top[district_top["party_norm"] == "REP"][
            ["year", "scope", "contest_type", "district_num", "candidate"]
        ].rename(columns={"candidate": "rep_candidate"})

        district_wide = district_agg.merge(
            district_dem, on=["year", "scope", "contest_type", "district_num"], how="left"
        ).merge(district_rep, on=["year", "scope", "contest_type", "district_num"], how="left")
        district_wide["dem_candidate"] = district_wide["dem_candidate"].fillna("")
        district_wide["rep_candidate"] = district_wide["rep_candidate"].fillna("")
        district_wide = district_wide.rename(
            columns={"DEM": "dem_votes", "REP": "rep_votes", "OTHER": "other_votes", "total": "total_votes"}
        )
        tp = (district_wide["dem_votes"] + district_wide["rep_votes"]).replace(0, 1)
        district_wide["margin"] = district_wide["rep_votes"] - district_wide["dem_votes"]
        district_wide["margin_pct"] = ((district_wide["rep_votes"] - district_wide["dem_votes"]) / tp) * 100.0
        district_wide["winner"] = district_wide.apply(
            lambda r: "REP"
            if r["rep_votes"] > r["dem_votes"]
            else ("DEM" if r["dem_votes"] > r["rep_votes"] else "TIE"),
            axis=1,
        )
        district_wide["color"] = district_wide.apply(
            lambda r: "R" if r["winner"] == "REP" else ("D" if r["winner"] == "DEM" else "T"), axis=1
        )

        for (scope, contest_type, year), g in district_wide.groupby(
            ["scope", "contest_type", "year"], sort=True
        ):
            file_name = f"{scope}_{contest_type}_{int(year)}.json"
            results = {}
            for _, r in g.sort_values("district_num").iterrows():
                district_key = str(int(float(r["district_num"])))
                total_votes = float(r["total_votes"])
                dem_votes = float(r["dem_votes"])
                rep_votes = float(r["rep_votes"])
                other_votes = max(0.0, total_votes - dem_votes - rep_votes)
                results[district_key] = {
                    "dem_votes": dem_votes,
                    "rep_votes": rep_votes,
                    "other_votes": other_votes,
                    "total_votes": total_votes,
                    "dem_candidate": str(r["dem_candidate"]),
                    "rep_candidate": str(r["rep_candidate"]),
                    "margin": float(r["margin"]),
                    "margin_pct": float(r["margin_pct"]),
                    "winner": str(r["winner"]),
                    "color": str(r["color"]),
                }

            payload = {
                "year": int(year),
                "scope": str(scope),
                "contest_type": str(contest_type),
                "meta": {"source": "co_openelections_general_county", "match_coverage_pct": 100.0},
                "general": {"results": results},
            }
            with (district_contests_dir / file_name).open("w", encoding="utf-8") as f:
                json.dump(payload, f)

            district_manifest_files.append(
                {
                    "year": int(year),
                    "scope": str(scope),
                    "contest_type": str(contest_type),
                    "file": file_name,
                    "rows": int(len(results)),
                    "major_party_contested": True,
                }
            )

    with (contests_dir / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump({"files": manifest_files}, f)
    with (district_contests_dir / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump({"files": district_manifest_files}, f)

    print(
        f"Wrote {agg_csv}, data/co_elections_aggregated.json, "
        "data/co_statewide_contests_aggregated.csv, data/contests/manifest.json, "
        "and data/district_contests/manifest.json"
    )


if __name__ == "__main__":
    main()
