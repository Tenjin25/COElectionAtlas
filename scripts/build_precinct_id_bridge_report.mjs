#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "data", "openelections-data-co");
const COUNTY_GEOJSON_PATH = path.join(ROOT, "data", "tl_2020_08_county20.geojson");
const CROSSWALK_PATH = path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_cd118.csv");
const OUT_DIR = path.join(ROOT, "data", "mappings");
const REPORT_DIR = path.join(ROOT, "data", "reports");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  row.push(field);
  rows.push(row);

  const headers = (rows.shift() || []).map((h) => String(h || "").trim().toLowerCase());
  return rows
    .filter((r) => r.some((v) => String(v || "").trim()))
    .map((r) => {
      const out = {};
      headers.forEach((h, i) => {
        out[h] = String(r[i] || "").trim();
      });
      return out;
    });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(file, rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function normalizeCountyName(value) {
  return String(value || "").trim().replace(/\s+county$/i, "").replace(/\s+/g, " ").toUpperCase();
}

function countyFipsByName() {
  const geo = JSON.parse(fs.readFileSync(COUNTY_GEOJSON_PATH, "utf8"));
  const map = new Map();
  for (const f of geo.features || []) {
    const p = f.properties || {};
    const name = normalizeCountyName(p.NAME20 || p.NAME || p.name || "");
    const geoid = String(p.GEOID20 || p.GEOID || p.geoid || "").trim();
    if (name && geoid) map.set(name, geoid);
  }
  return map;
}

function loadElectionPrecincts() {
  const files = walkFiles(SRC_DIR).filter((f) => f.toLowerCase().endsWith("__co__general__precinct.csv"));
  const out = new Map();
  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    for (const r of rows) {
      const county = normalizeCountyName(r.county);
      const precinct = String(r.precinct || "").trim();
      if (!county || !precinct) continue;
      const key = `${county}|${precinct}`;
      if (!out.has(key)) out.set(key, { county, election_precinct_id: precinct, files: new Set() });
      out.get(key).files.add(path.basename(file));
    }
  }
  return out;
}

function loadCrosswalkPrecincts() {
  const rows = parseCsv(fs.readFileSync(CROSSWALK_PATH, "utf8"));
  const byCounty = new Map();
  for (const r of rows) {
    const precinctId = String(r.precinct_id || "").replace(/[^0-9]/g, "");
    if (!precinctId || precinctId.length < 5) continue;
    const countyFips = precinctId.slice(0, 5);
    if (!byCounty.has(countyFips)) byCounty.set(countyFips, new Set());
    byCounty.get(countyFips).add(precinctId);
  }
  return byCounty;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const countyToFips = countyFipsByName();
  const election = loadElectionPrecincts();
  const crosswalkByCountyFips = loadCrosswalkPrecincts();

  const bridgeTemplate = [];
  const matchCandidates = [];
  const unmatchedElection = [];

  for (const rec of election.values()) {
    const countyFips = countyToFips.get(rec.county) || "";
    const electionId = rec.election_precinct_id;
    const suffix4 = electionId.replace(/[^0-9]/g, "").slice(-4);
    const countyCrosswalk = countyFips ? Array.from(crosswalkByCountyFips.get(countyFips) || []) : [];
    const suffixMatches = suffix4
      ? countyCrosswalk.filter((cid) => cid.endsWith(suffix4)).slice(0, 10)
      : [];

    bridgeTemplate.push({
      county: rec.county,
      county_fips: countyFips,
      election_precinct_id: electionId,
      suggested_crosswalk_precinct_id: suffixMatches.length === 1 ? suffixMatches[0] : "",
      needs_manual_review: suffixMatches.length === 1 ? "no" : "yes",
      source_files_count: rec.files.size,
    });

    if (suffixMatches.length) {
      for (const m of suffixMatches) {
        matchCandidates.push({
          county: rec.county,
          county_fips: countyFips,
          election_precinct_id: electionId,
          election_suffix4: suffix4,
          candidate_crosswalk_precinct_id: m,
          crosswalk_suffix4: m.slice(-4),
        });
      }
    } else {
      unmatchedElection.push({
        county: rec.county,
        county_fips: countyFips,
        election_precinct_id: electionId,
        election_suffix4: suffix4,
      });
    }
  }

  const usedCrosswalk = new Set(matchCandidates.map((r) => r.candidate_crosswalk_precinct_id));
  const unmatchedCrosswalk = [];
  for (const [countyFips, ids] of crosswalkByCountyFips.entries()) {
    for (const id of ids) {
      if (!usedCrosswalk.has(id)) unmatchedCrosswalk.push({ county_fips: countyFips, crosswalk_precinct_id: id });
    }
  }

  writeCsv(
    path.join(OUT_DIR, "precinct_id_bridge_template.csv"),
    bridgeTemplate.sort((a, b) => `${a.county}|${a.election_precinct_id}`.localeCompare(`${b.county}|${b.election_precinct_id}`)),
    ["county", "county_fips", "election_precinct_id", "suggested_crosswalk_precinct_id", "needs_manual_review", "source_files_count"]
  );
  writeCsv(
    path.join(REPORT_DIR, "precinct_id_bridge_match_candidates.csv"),
    matchCandidates.sort((a, b) => `${a.county}|${a.election_precinct_id}|${a.candidate_crosswalk_precinct_id}`.localeCompare(`${b.county}|${b.election_precinct_id}|${b.candidate_crosswalk_precinct_id}`)),
    ["county", "county_fips", "election_precinct_id", "election_suffix4", "candidate_crosswalk_precinct_id", "crosswalk_suffix4"]
  );
  writeCsv(
    path.join(REPORT_DIR, "unmatched_election_precinct_ids.csv"),
    unmatchedElection.sort((a, b) => `${a.county}|${a.election_precinct_id}`.localeCompare(`${b.county}|${b.election_precinct_id}`)),
    ["county", "county_fips", "election_precinct_id", "election_suffix4"]
  );
  writeCsv(
    path.join(REPORT_DIR, "unmatched_crosswalk_precinct_ids.csv"),
    unmatchedCrosswalk.sort((a, b) => `${a.county_fips}|${a.crosswalk_precinct_id}`.localeCompare(`${b.county_fips}|${b.crosswalk_precinct_id}`)),
    ["county_fips", "crosswalk_precinct_id"]
  );

  const autoMatched = bridgeTemplate.filter((r) => r.needs_manual_review === "no").length;
  console.log(
    `Wrote bridge template + reports. election precincts=${bridgeTemplate.length}, auto_matched=${autoMatched}, unmatched_election=${unmatchedElection.length}`
  );
}

main();
