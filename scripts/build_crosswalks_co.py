#!/usr/bin/env python3
"""
Build Colorado precinct crosswalks with block-assisted weighting.

Recommended inputs:
- 2008 precincts: tl_2008_08_vtd00.zip
- 2008 blocks:    tl_2008_08_tabblock00.zip
- Targets:        tl_2008_08_cd110.zip, tl_2008_08_sldl.zip, tl_2008_08_sldu.zip

Outputs:
- precinct_to_cd110.csv
- precinct_to_sldl.csv
- precinct_to_sldu.csv
- crosswalk_diagnostics.csv
"""

from __future__ import annotations

import argparse
import io
import re
import zipfile
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import pandas as pd


EQUAL_AREA_CRS = "EPSG:5070"


def zip_uri(path: Path) -> str:
    return f"zip://{path.resolve()}"


def first_existing(cols: Iterable[str], candidates: list[str]) -> str:
    lowered = {c.lower(): c for c in cols}
    for c in candidates:
        if c.lower() in lowered:
            return lowered[c.lower()]
    raise ValueError(f"Missing expected column. Tried: {candidates}")


def load_layer(path: Path, label: str) -> gpd.GeoDataFrame:
    if not path.exists():
        raise FileNotFoundError(f"{label} not found: {path}")
    gdf = gpd.read_file(zip_uri(path))
    if gdf.empty:
        raise ValueError(f"{label} loaded empty: {path}")
    if gdf.crs is None:
        raise ValueError(f"{label} has no CRS: {path}")
    return gdf.to_crs(EQUAL_AREA_CRS)


def load_precincts(
    precincts_zip: Path | None,
    precincts_dir: Path | None,
    fallback_vtd20_zip: Path | None = None,
    fallback_blocks_gdf: gpd.GeoDataFrame | None = None,
) -> gpd.GeoDataFrame:
    if precincts_zip:
        return load_layer(precincts_zip, "precincts")
    if not precincts_dir:
        raise ValueError("Provide either --precincts-zip or --precincts-dir")
    if not precincts_dir.exists():
        raise FileNotFoundError(f"precincts dir not found: {precincts_dir}")

    patterns = [
        "**/tl_2008_*_vtd00.zip",
        "**/tl_2010_*_vtd10.zip",
        "**/tl_2020_*_vtd20.zip",
    ]
    files: list[Path] = []
    for pat in patterns:
        files.extend(sorted(precincts_dir.glob(pat)))
    files = sorted(set(files))
    if not files:
        raise FileNotFoundError(
            f"No precinct zip files found in {precincts_dir}. "
            "Expected names like tl_2008_08001_vtd00.zip."
        )

    fallback_vtd20 = None
    fallback_county_col = None
    if fallback_vtd20_zip and fallback_vtd20_zip.exists():
        fallback_vtd20 = gpd.read_file(zip_uri(fallback_vtd20_zip))
        fallback_county_col = first_existing(fallback_vtd20.columns, ["COUNTYFP20", "COUNTYFP", "COUNTYFP00"])

    frames: list[gpd.GeoDataFrame] = []
    fallback_used = 0
    block_fallback_used = 0
    for fp in files:
        try:
            g = gpd.read_file(zip_uri(fp))
            g["__fallback_mode"] = "native_vtd"
            g["__fallback_county"] = None
            frames.append(g)
        except Exception as exc:
            m = re.search(r"tl_2008_(\d{5})_vtd00\.zip$", str(fp).replace("\\", "/"))
            county_fips = m.group(1)[-3:] if m else None
            if fallback_vtd20 is not None and fallback_county_col and county_fips:
                try:
                    sub = fallback_vtd20[fallback_vtd20[fallback_county_col].astype(str).str.zfill(3) == county_fips].copy()
                    if not sub.empty:
                        sub["__fallback_mode"] = "vtd20_county_slice"
                        sub["__fallback_county"] = county_fips
                        frames.append(sub)
                        fallback_used += 1
                        print(f"Fallback used for county {county_fips}: {fp.name} -> tl_2020_08_vtd20.zip slice")
                        continue
                except Exception:
                    pass
            if fallback_blocks_gdf is not None and county_fips:
                try:
                    b_county_col = first_existing(fallback_blocks_gdf.columns, ["COUNTYFP20", "COUNTYFP00", "COUNTYFP"])
                    bsub = fallback_blocks_gdf[
                        fallback_blocks_gdf[b_county_col].astype(str).str.zfill(3) == county_fips
                    ].copy()
                    if not bsub.empty:
                        synth = bsub[["geometry"]].copy()
                        synth["VTDIDFP00"] = synth.index.map(lambda i: f"FB{county_fips}{int(i):09d}")
                        synth["__fallback_mode"] = "blocks_county_slice"
                        synth["__fallback_county"] = county_fips
                        frames.append(synth)
                        block_fallback_used += 1
                        print(f"Block fallback used for county {county_fips}: {fp.name} -> county block geometries")
                        continue
                except Exception:
                    pass
            print(f"Skipping unreadable precinct zip: {fp} ({exc})")
    if not frames:
        raise ValueError("No readable precinct zip files were found.")
    merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)
    if fallback_used:
        print(f"Fallback county slices used: {fallback_used}")
    if block_fallback_used:
        print(f"Block fallback counties used: {block_fallback_used}")
    return merged.to_crs(EQUAL_AREA_CRS)


def normalize_id(s: pd.Series) -> pd.Series:
    return s.astype(str).str.strip()


def load_nhgis_source_weights(path: Path, source_block_ids: pd.Series) -> pd.DataFrame:
    with zipfile.ZipFile(path) as zf:
        csv_name = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if not csv_name:
            raise ValueError(f"No CSV found inside {path}")
        df = pd.read_csv(io.BytesIO(zf.read(csv_name)), dtype=str)
    cols = list(df.columns)
    src_candidates = [c for c in cols if c.lower().startswith("blk") and c.lower().endswith(("ge", "gj"))]
    if not src_candidates:
        raise ValueError(f"Could not infer NHGIS source block column from {path.name}")
    wt_col = "weight" if "weight" in df.columns else ("parea" if "parea" in df.columns else None)
    if wt_col is None:
        raise ValueError(f"Could not find NHGIS weight column (weight or parea) in {path.name}")

    source_ids = set(normalize_id(source_block_ids).unique().tolist())
    best_col = None
    best_hits = -1
    for c in src_candidates:
        hits = int(df[c].astype(str).str.strip().isin(source_ids).sum())
        if hits > best_hits:
            best_hits = hits
            best_col = c
    if not best_col:
        raise ValueError(f"Could not pick NHGIS source block column from {path.name}")

    out = df[[best_col, wt_col]].copy()
    out = out.rename(columns={best_col: "block_id", wt_col: "nhgis_weight"})
    out["block_id"] = normalize_id(out["block_id"])
    out["nhgis_weight"] = pd.to_numeric(out["nhgis_weight"], errors="coerce").fillna(0.0)
    out = out.groupby("block_id", as_index=False)["nhgis_weight"].sum()
    out = out[out["block_id"].isin(source_ids)].copy()
    return out


def build_crosswalk(
    precincts: gpd.GeoDataFrame,
    blocks: gpd.GeoDataFrame,
    targets: gpd.GeoDataFrame,
    target_col: str,
    target_name: str,
    nhgis_weights: pd.DataFrame | None = None,
    min_weight_keep: float = 0.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    precinct_id_candidates = ["GEOID00", "GEOID20", "GEOID10", "VTDIDFP00", "VTDST00", "VTDST", "VTDST20", "VTD", "NAME00", "NAME20", "NAME"]
    present_prec_cols = [c for c in precinct_id_candidates if c in precincts.columns]
    if not present_prec_cols:
        raise ValueError("No precinct id columns found in precinct layer.")
    block_id_col = first_existing(blocks.columns, ["BLKIDFP00", "GEOID00", "GEOID20", "GEOID10", "GEOID"])

    extra_cols = [c for c in ["__fallback_mode", "__fallback_county"] if c in precincts.columns]
    p = precincts[[*present_prec_cols, "geometry", *extra_cols]].copy()
    # Row-wise coalesce across possible precinct id fields so mixed-vintage fallback rows
    # (for example VTD20 slices) still keep stable unique ids.
    id_frame = p[present_prec_cols].copy()
    for col in present_prec_cols:
        id_frame[col] = id_frame[col].astype("string").str.strip()
        id_frame[col] = id_frame[col].replace({"": pd.NA, "nan": pd.NA, "NaN": pd.NA, "<NA>": pd.NA})
    p["precinct_id"] = id_frame.bfill(axis=1).iloc[:, 0].astype("string").fillna("")
    p["precinct_id"] = normalize_id(p["precinct_id"])
    p = p[p["precinct_id"].astype(str).str.strip().ne("")].copy()

    b = blocks[[block_id_col, "geometry"]].copy()
    b = b.rename(columns={block_id_col: "block_id"})
    b["block_id"] = normalize_id(b["block_id"])

    t = targets[[target_col, "geometry"]].copy()
    t = t.rename(columns={target_col: "target_id"})
    t["target_id"] = normalize_id(t["target_id"])

    # Assign each block to target by centroid (stable against micro-slivers).
    b_cent = b.copy()
    b_cent["geometry"] = b_cent.centroid
    b_to_t = gpd.sjoin(
        b_cent[["block_id", "geometry"]],
        t[["target_id", "geometry"]],
        how="left",
        predicate="within",
    )[["block_id", "target_id"]].drop_duplicates(subset=["block_id"])

    b = b.merge(b_to_t, on="block_id", how="left")

    # Precinct-block overlap area as weight basis.
    pb = gpd.overlay(
        p[["precinct_id", "geometry"]],
        b[["block_id", "target_id", "geometry"]],
        how="intersection",
        keep_geom_type=False,
    )
    if pb.empty:
        raise ValueError(f"No overlaps found for target {target_name}. Check vintages/geometries.")

    pb["piece_area"] = pb.geometry.area
    pb = pb[pb["piece_area"] > 0].copy()
    nhgis_match_rate = None
    if nhgis_weights is not None and not nhgis_weights.empty:
        pb = pb.merge(nhgis_weights, on="block_id", how="left")
        pb["nhgis_weight"] = pd.to_numeric(pb["nhgis_weight"], errors="coerce").fillna(1.0)
        nhgis_match_rate = float((pb["nhgis_weight"] != 1.0).mean())
        pb["piece_area"] = pb["piece_area"] * pb["nhgis_weight"]

    # Coverage denominator per precinct.
    precinct_area = pb.groupby("precinct_id", as_index=False)["piece_area"].sum().rename(
        columns={"piece_area": "covered_area"}
    )

    # Crosswalk weights precinct -> target.
    grouped = pb.dropna(subset=["target_id"]).groupby(["precinct_id", "target_id"], as_index=False)
    if "__fallback_mode" in pb.columns and "__fallback_county" in pb.columns:
        xw = grouped.agg(
            piece_area=("piece_area", "sum"),
            fallback_mode=("__fallback_mode", "first"),
            fallback_county=("__fallback_county", "first"),
        )
    else:
        xw = grouped.agg(piece_area=("piece_area", "sum"))
        xw["fallback_mode"] = "native_vtd"
        xw["fallback_county"] = None
    xw = xw.merge(precinct_area, on="precinct_id", how="left")
    xw["weight"] = xw["piece_area"] / xw["covered_area"]
    xw["target_type"] = target_name
    keep_thresh = float(min_weight_keep or 0.0)
    if keep_thresh > 0:
        xw = xw[xw["weight"] >= keep_thresh].copy()
        denom = xw.groupby("precinct_id", as_index=False)["weight"].sum().rename(columns={"weight": "w_sum"})
        xw = xw.merge(denom, on="precinct_id", how="left")
        xw["weight"] = xw["weight"] / xw["w_sum"].where(xw["w_sum"] > 0, 1.0)
        xw = xw.drop(columns=["w_sum"])
    xw = xw[["precinct_id", "target_id", "target_type", "weight", "piece_area", "covered_area", "fallback_mode", "fallback_county"]]

    # Diagnostics by precinct.
    d = (
        xw.groupby("precinct_id", as_index=False)
        .agg(
            top_weight=("weight", "max"),
            targets_touched=("target_id", "nunique"),
            weight_sum=("weight", "sum"),
        )
        .assign(
            ambiguous=lambda df: (df["top_weight"] < 0.60) | (df["targets_touched"] > 3),
            target_type=target_name,
        )
    )
    if "__fallback_mode" in pb.columns:
        fallback_info = (
            pb.groupby("precinct_id", as_index=False)
            .agg(
                fallback_mode=("__fallback_mode", "first"),
                fallback_county=("__fallback_county", "first"),
            )
        )
        d = d.merge(fallback_info, on="precinct_id", how="left")
    if nhgis_match_rate is not None:
        d["nhgis_adjustment_rate"] = nhgis_match_rate
    return xw.sort_values(["precinct_id", "weight"], ascending=[True, False]), d


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Colorado block-assisted crosswalks.")
    parser.add_argument("--precincts-zip", type=Path)
    parser.add_argument("--precincts-dir", type=Path, help="Directory containing county-level precinct zips.")
    parser.add_argument("--blocks-zip", required=True, type=Path)
    parser.add_argument("--fallback-vtd20-zip", type=Path, help="Optional fallback VTD20 zip for unreadable county VTD00 files.")
    parser.add_argument("--cd-zip", required=True, type=Path)
    parser.add_argument("--sldl-zip", required=True, type=Path)
    parser.add_argument("--sldu-zip", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--nhgis-block-crosswalk-zip", type=Path, help="Optional NHGIS block crosswalk ZIP (uses weight/parea).")
    parser.add_argument("--min-weight-keep", type=float, default=0.0, help="Drop tiny allocations below this weight then renormalize per precinct (e.g. 0.01).")
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    if not args.precincts_zip and not args.precincts_dir:
        parser.error("Provide one of --precincts-zip or --precincts-dir")
    blocks = load_layer(args.blocks_zip, "blocks")
    precincts = load_precincts(
        args.precincts_zip,
        args.precincts_dir,
        args.fallback_vtd20_zip,
        fallback_blocks_gdf=blocks,
    )
    cd = load_layer(args.cd_zip, "congressional districts")
    sldl = load_layer(args.sldl_zip, "state house districts")
    sldu = load_layer(args.sldu_zip, "state senate districts")

    block_id_col = first_existing(blocks.columns, ["BLKIDFP00", "GEOID00", "GEOID20", "GEOID10", "GEOID"])
    nhgis_weights = None
    if args.nhgis_block_crosswalk_zip:
        nhgis_weights = load_nhgis_source_weights(args.nhgis_block_crosswalk_zip, blocks[block_id_col])

    cd_col = first_existing(cd.columns, ["CD118FP", "CD119FP", "CD110FP", "CD", "DISTRICT", "DISTRICTFP", "GEOID20", "GEOID"])
    sldl_col = first_existing(sldl.columns, ["SLDLST", "DISTRICT", "DISTRICTFP"])
    sldu_col = first_existing(sldu.columns, ["SLDUST", "DISTRICT", "DISTRICTFP"])

    cd_xw, cd_diag = build_crosswalk(precincts, blocks, cd, cd_col, "congressional", nhgis_weights=nhgis_weights, min_weight_keep=args.min_weight_keep)
    sldl_xw, sldl_diag = build_crosswalk(precincts, blocks, sldl, sldl_col, "state_house", nhgis_weights=nhgis_weights, min_weight_keep=args.min_weight_keep)
    sldu_xw, sldu_diag = build_crosswalk(precincts, blocks, sldu, sldu_col, "state_senate", nhgis_weights=nhgis_weights, min_weight_keep=args.min_weight_keep)

    cd_suffix = "cd"
    cd_col_l = cd_col.lower()
    if "118" in cd_col_l:
        cd_suffix = "cd118"
    elif "119" in cd_col_l:
        cd_suffix = "cd119"
    elif "110" in cd_col_l:
        cd_suffix = "cd110"
    cd_file = f"precinct_to_{cd_suffix}.csv"
    cd_xw.to_csv(args.out_dir / cd_file, index=False)
    sldl_xw.to_csv(args.out_dir / "precinct_to_sldl.csv", index=False)
    sldu_xw.to_csv(args.out_dir / "precinct_to_sldu.csv", index=False)

    diagnostics = pd.concat([cd_diag, sldl_diag, sldu_diag], ignore_index=True)
    diagnostics.to_csv(args.out_dir / "crosswalk_diagnostics.csv", index=False)
    summary = (
        diagnostics.groupby("target_type", as_index=False)
        .agg(
            precincts=("precinct_id", "nunique"),
            avg_top_weight=("top_weight", "mean"),
            median_top_weight=("top_weight", "median"),
            ambiguous_count=("ambiguous", "sum"),
            avg_targets_touched=("targets_touched", "mean"),
        )
    )
    summary["ambiguous_pct"] = (summary["ambiguous_count"] / summary["precincts"]).fillna(0.0) * 100.0
    summary["min_weight_keep"] = float(args.min_weight_keep or 0.0)
    summary.to_csv(args.out_dir / "crosswalk_summary.csv", index=False)

    print(f"Wrote crosswalks to: {args.out_dir.resolve()}")
    print(f"Files: {cd_file}, precinct_to_sldl.csv, precinct_to_sldu.csv, crosswalk_diagnostics.csv, crosswalk_summary.csv")


if __name__ == "__main__":
    main()
