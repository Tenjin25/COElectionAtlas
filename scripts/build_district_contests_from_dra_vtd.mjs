#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DISTRICT_DIR = path.join(ROOT, "data", "district_contests");
const DISTRICT_MANIFEST = path.join(DISTRICT_DIR, "manifest.json");
const CONTESTS_DIR = path.join(ROOT, "data", "contests");
const DRA_ELECTION_CSV = path.join(ROOT, "data", "dra_election_co_v07", "election_data_CO.v07.csv");
const DRA_SOURCE_URL = "https://github.com/dra2020/vtd_data/tree/master/2020_VTD/CO";

const CROSSWALKS = {
  congressional: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_cd110.csv"),
  state_house: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_sldl.csv"),
  state_senate: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_sldu.csv"),
};

const DRA_CONTESTS = [
  { year: 2008, contestType: "president", prefix: "E_08_PRES", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2012, contestType: "president", prefix: "E_12_PRES", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2016, contestType: "president", prefix: "E_16_PRES", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2016, contestType: "us_senate", prefix: "E_16_SEN", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2018, contestType: "governor", prefix: "E_18_GOV", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2018, contestType: "attorney_general", prefix: "E_18_AG", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2020, contestType: "president", prefix: "E_20_PRES", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2020, contestType: "us_senate", prefix: "E_20_SEN", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2024, contestType: "president", prefix: "E_24_PRES", scopes: ["congressional", "state_house", "state_senate"] },
  { year: 2024, contestType: "us_house", prefix: "E_24_CONG", scopes: ["congressional"] },
];

function parseCsv(text) {
  text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
    } else field += ch;
  }
  row.push(field);
  rows.push(row);

  const headers = (rows.shift() || []).map((h) => String(h || "").trim());
  return rows
    .filter((r) => r.some((x) => String(x || "").trim()))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = String(r[i] || "").trim();
      });
      return obj;
    });
}

function loadDraRows() {
  if (!fs.existsSync(DRA_ELECTION_CSV)) {
    throw new Error(`Missing DRA election CSV: ${DRA_ELECTION_CSV}`);
  }
  return parseCsv(fs.readFileSync(DRA_ELECTION_CSV, "utf8"));
}

function loadCrosswalk(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const byVtd = new Map();
  for (const row of rows) {
    const geoid = String(row.precinct_id || "").replace(/[^0-9]/g, "");
    const district = String(row.target_id || "").replace(/[^0-9]/g, "").replace(/^0+/, "") || "0";
    const weight = Number(row.weight || 0);
    if (!geoid || !district || !Number.isFinite(weight) || weight <= 0) continue;
    if (!byVtd.has(geoid)) byVtd.set(geoid, []);
    byVtd.get(geoid).push({ district, weight });
  }
  return byVtd;
}

function loadCandidateDefaults(contestType, year, scope) {
  const out = { dem: "Democratic nominee", rep: "Republican nominee", byDistrict: new Map() };
  const districtFile = path.join(DISTRICT_DIR, `${scope}_${contestType}_${year}.json`);
  if (fs.existsSync(districtFile)) {
    try {
      const payload = JSON.parse(fs.readFileSync(districtFile, "utf8"));
      for (const [district, row] of Object.entries(payload?.general?.results || {})) {
        out.byDistrict.set(String(Number(district)), {
          dem: String(row?.dem_candidate || "").trim(),
          rep: String(row?.rep_candidate || "").trim(),
        });
      }
    } catch {
      // Fall through to statewide candidate names.
    }
  }

  const statewideFile = path.join(CONTESTS_DIR, `${contestType}_${year}.json`);
  if (!fs.existsSync(statewideFile)) return out;
  try {
    const payload = JSON.parse(fs.readFileSync(statewideFile, "utf8"));
    const dem = new Map();
    const rep = new Map();
    for (const row of payload.rows || []) {
      const demName = String(row.dem_candidate || "").trim();
      const repName = String(row.rep_candidate || "").trim();
      const demVotes = Number(row.dem_votes || 0);
      const repVotes = Number(row.rep_votes || 0);
      if (demName && demVotes > 0) dem.set(demName, (dem.get(demName) || 0) + demVotes);
      if (repName && repVotes > 0) rep.set(repName, (rep.get(repName) || 0) + repVotes);
    }
    out.dem = Array.from(dem.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || out.dem;
    out.rep = Array.from(rep.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || out.rep;
  } catch {
    // Keep generic defaults if the county contest slice is unreadable.
  }
  return out;
}

function aggregateContest(draRows, crosswalk, contest, scope) {
  const totals = new Map();
  let inputTotal = 0;
  let matchedTotal = 0;
  const totalCol = `${contest.prefix}_Total`;
  const demCol = `${contest.prefix}_Dem`;
  const repCol = `${contest.prefix}_Rep`;

  for (const row of draRows) {
    const geoid = String(row.GEOID20 || "").replace(/[^0-9]/g, "");
    const vtdTotal = Number(row[totalCol] || 0);
    const dem = Number(row[demCol] || 0);
    const rep = Number(row[repCol] || 0);
    if (!geoid || !Number.isFinite(vtdTotal) || vtdTotal <= 0) continue;
    inputTotal += vtdTotal;
    const weights = crosswalk.get(geoid) || [];
    if (!weights.length) continue;
    matchedTotal += vtdTotal;
    const other = Math.max(0, vtdTotal - (Number.isFinite(dem) ? dem : 0) - (Number.isFinite(rep) ? rep : 0));
    for (const { district, weight } of weights) {
      if (!totals.has(district)) totals.set(district, { dem: 0, rep: 0, other: 0 });
      const rec = totals.get(district);
      rec.dem += (Number.isFinite(dem) ? dem : 0) * weight;
      rec.rep += (Number.isFinite(rep) ? rep : 0) * weight;
      rec.other += other * weight;
    }
  }

  const candidates = loadCandidateDefaults(contest.contestType, contest.year, scope);
  const results = {};
  for (const district of Array.from(totals.keys()).sort((a, b) => Number(a) - Number(b))) {
    const rec = totals.get(district);
    const dem = rec.dem || 0;
    const rep = rec.rep || 0;
    const other = rec.other || 0;
    const total = dem + rep + other;
    const margin = rep - dem;
    const marginPct = total > 0 ? (margin / total) * 100 : 0;
    const winner = margin > 0 ? "REP" : margin < 0 ? "DEM" : "TIE";
    const districtCandidates = candidates.byDistrict.get(String(Number(district))) || {};
    results[String(Number(district))] = {
      dem_votes: dem,
      rep_votes: rep,
      other_votes: other,
      total_votes: total,
      dem_candidate: districtCandidates.dem || candidates.dem,
      rep_candidate: districtCandidates.rep || candidates.rep,
      margin,
      margin_pct: marginPct,
      winner,
      color: winner === "REP" ? "R" : winner === "DEM" ? "D" : "T",
    };
  }

  return {
    year: contest.year,
    scope,
    contest_type: contest.contestType,
    meta: {
      source: "dra_vtd_data_crosswalk",
      data_source: DRA_SOURCE_URL,
      dra_file: path.relative(ROOT, DRA_ELECTION_CSV).replace(/\\/g, "/"),
      crosswalk_dir: "crosswalks_2020_2022",
      method: "DRA VTD election data, which DRA disaggregates to 2020 blocks using the VEST/Amos method, allocated from 2020 VTDs to target districts with local VTD-to-district weights.",
      match_coverage_pct: inputTotal > 0 ? (matchedTotal / inputTotal) * 100 : 0,
    },
    general: { results },
  };
}

function main() {
  if (!fs.existsSync(DISTRICT_DIR)) fs.mkdirSync(DISTRICT_DIR, { recursive: true });
  const draRows = loadDraRows();
  const crosswalks = new Map(Object.entries(CROSSWALKS).map(([scope, file]) => [scope, loadCrosswalk(file)]));
  const newEntries = [];

  for (const contest of DRA_CONTESTS) {
    for (const scope of contest.scopes) {
      const payload = aggregateContest(draRows, crosswalks.get(scope), contest, scope);
      if (!Object.keys(payload.general.results).length) continue;
      const file = `${scope}_${contest.contestType}_${contest.year}.json`;
      fs.writeFileSync(path.join(DISTRICT_DIR, file), JSON.stringify(payload), "utf8");
      newEntries.push({
        year: contest.year,
        scope,
        contest_type: contest.contestType,
        file,
        rows: Object.keys(payload.general.results).length,
        major_party_contested: true,
      });
    }
  }

  let existing = [];
  if (fs.existsSync(DISTRICT_MANIFEST)) {
    try {
      existing = JSON.parse(fs.readFileSync(DISTRICT_MANIFEST, "utf8")).files || [];
    } catch {
      existing = [];
    }
  }
  const produced = new Set(newEntries.map((e) => `${e.scope}|${e.contest_type}|${e.year}`));
  const merged = [...existing.filter((e) => !produced.has(`${e.scope}|${e.contest_type}|${e.year}`)), ...newEntries]
    .sort((a, b) => `${a.scope}|${a.contest_type}|${a.year}`.localeCompare(`${b.scope}|${b.contest_type}|${b.year}`));
  fs.writeFileSync(DISTRICT_MANIFEST, JSON.stringify({ files: merged }), "utf8");
  console.log(`Wrote ${newEntries.length} DRA VTD-backed district contest files and updated ${DISTRICT_MANIFEST}`);
}

main();
