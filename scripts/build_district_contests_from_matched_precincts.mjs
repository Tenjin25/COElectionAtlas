#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OE_DIR = path.join(ROOT, "data", "openelections-data-co");
const DISTRICT_DIR = path.join(ROOT, "data", "district_contests");
const DISTRICT_MANIFEST = path.join(DISTRICT_DIR, "manifest.json");
const COUNTY_GEOJSON = path.join(ROOT, "data", "tl_2020_08_county20.geojson");

const MIN_COVERAGE_PCT = 60;
const MIN_EXACT_COVERAGE_WITH_FALLBACK_PCT = 45;
const MIN_ALLOCATED_COVERAGE_PCT = 95;
const PROTECTED_SOURCES = new Set(["dra_vtd_data_crosswalk"]);

const CROSSWALKS = {
  congressional: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_cd110.csv"),
  state_house: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_sldl.csv"),
  state_senate: path.join(ROOT, "data", "crosswalks_2020_2022", "precinct_to_sldu.csv"),
};

function parseCsv(text) {
  text = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

  const headers = (rows.shift() || []).map((h) => String(h || "").trim().toLowerCase());
  return rows
    .filter((r) => r.some((x) => String(x || "").trim()))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] || "").trim()])));
}

function normalizeCounty(value) {
  return String(value || "").trim().replace(/\s+county$/i, "").replace(/\s+/g, " ").toUpperCase();
}

function normalizeOffice(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normParty(value) {
  const p = String(value || "").trim().toUpperCase();
  if (["DEM", "D", "DEMOCRAT", "DEMOCRATIC", "DEMOCRATIC PARTY"].includes(p)) return "DEM";
  if (["REP", "R", "REPUBLICAN", "GOP", "REPUBLICAN PARTY"].includes(p)) return "REP";
  return "OTHER";
}

function contestTypeFromOffice(value) {
  const o = normalizeOffice(value);
  if (o.includes("president")) return "president";
  if (o === "u s senate" || o === "us senate" || o.includes("u s senate class")) return "us_senate";
  if (o.includes("governor")) return "governor";
  if (o.includes("attorney general")) return "attorney_general";
  if (o.includes("secretary of state")) return "secretary_of_state";
  if (o.includes("treasurer")) return "treasurer";
  return "";
}

function loadCountyFipsByName() {
  const geo = JSON.parse(fs.readFileSync(COUNTY_GEOJSON, "utf8"));
  const out = new Map();
  for (const feature of geo.features || []) {
    const props = feature.properties || {};
    const name = normalizeCounty(props.NAME20 || props.NAME || props.name || "");
    const fips = String(props.GEOID20 || props.GEOID || props.geoid || "").trim();
    if (name && fips) out.set(name, fips);
  }
  return out;
}

function loadVtdIdsFromCrosswalks() {
  const out = new Map();
  const rows = parseCsv(fs.readFileSync(CROSSWALKS.congressional, "utf8"));
  for (const row of rows) {
    const id = String(row.precinct_id || "").replace(/[^0-9]/g, "");
    if (!id || id.length < 5) continue;
    const countyFips = id.slice(0, 5);
    if (!out.has(countyFips)) out.set(countyFips, new Set());
    out.get(countyFips).add(id);
  }
  return out;
}

function candidateVtdIds(countyFips, rawPrecinct) {
  const digits = String(rawPrecinct || "").replace(/[^0-9]/g, "");
  if (!countyFips || !digits) return [];
  const countyPart = countyFips.slice(2);
  const out = [
    countyFips + countyPart + digits.slice(-3).padStart(3, "0"),
    countyFips + countyPart + digits.slice(-4).padStart(4, "0"),
    countyFips + digits.slice(-6).padStart(6, "0"),
    countyFips + digits.slice(-5).padStart(5, "0"),
    countyFips + digits.slice(-4).padStart(6, "0"),
    countyFips + digits.slice(-4).padStart(5, "0"),
  ];
  return [...new Set(out)];
}

function makeVtdMatcher() {
  const countyFipsByName = loadCountyFipsByName();
  const vtdIdsByCounty = loadVtdIdsFromCrosswalks();
  return (county, precinct) => {
    const countyName = normalizeCounty(county);
    const countyFips = countyFipsByName.get(countyName);
    const validIds = vtdIdsByCounty.get(countyFips) || new Set();
    for (const id of candidateVtdIds(countyFips, precinct)) {
      if (validIds.has(id)) return { countyFips, vtd: id };
    }
    return { countyFips: countyFips || "", vtd: "" };
  };
}

function loadCrosswalk(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const out = new Map();
  for (const row of rows) {
    const vtd = String(row.precinct_id || "").replace(/[^0-9]/g, "");
    const district = String(row.target_id || "").replace(/[^0-9]/g, "").replace(/^0+/, "") || "0";
    const weight = Number(row.weight || 0);
    if (!vtd || !district || !Number.isFinite(weight) || weight <= 0) continue;
    if (!out.has(vtd)) out.set(vtd, []);
    out.get(vtd).push({ district, weight });
  }
  return out;
}

function loadCountyFallbackWeights(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const byCounty = new Map();
  for (const row of rows) {
    const vtd = String(row.precinct_id || "").replace(/[^0-9]/g, "");
    const countyFips = vtd.slice(0, 5);
    const district = String(row.target_id || "").replace(/[^0-9]/g, "").replace(/^0+/, "") || "0";
    const pieceArea = Number(row.piece_area || 0);
    if (!countyFips || !district || !Number.isFinite(pieceArea) || pieceArea <= 0) continue;
    if (!byCounty.has(countyFips)) byCounty.set(countyFips, new Map());
    const districtArea = byCounty.get(countyFips);
    districtArea.set(district, (districtArea.get(district) || 0) + pieceArea);
  }

  const out = new Map();
  for (const [countyFips, districtArea] of byCounty.entries()) {
    const total = Array.from(districtArea.values()).reduce((sum, value) => sum + value, 0);
    if (total <= 0) continue;
    out.set(
      countyFips,
      Array.from(districtArea.entries())
        .map(([district, area]) => ({ district, weight: area / total }))
        .filter((row) => row.weight > 0)
    );
  }
  return out;
}

function listPrecinctFiles() {
  const out = [];
  for (const entry of fs.readdirSync(OE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;
    const dir = path.join(OE_DIR, entry.name);
    for (const file of fs.readdirSync(dir)) {
      if (/__co__general__precinct\.csv$/i.test(file)) out.push(path.join(dir, file));
    }
  }
  return out.sort();
}

function yearFromPath(file) {
  const m = file.replace(/\\/g, "/").match(/\/(\d{4})\//);
  return m ? Number(m[1]) : NaN;
}

function loadPrecinctRows(matchVtd) {
  const rows = [];
  for (const file of listPrecinctFiles()) {
    const year = yearFromPath(file);
    if (!Number.isFinite(year)) continue;
    for (const row of parseCsv(fs.readFileSync(file, "utf8"))) {
      const contestType = contestTypeFromOffice(row.office);
      if (!contestType) continue;
      const county = normalizeCounty(row.county);
      const precinct = String(row.precinct || "").trim();
      const votes = Number(row.votes || 0);
      if (!county || !precinct || !Number.isFinite(votes) || votes <= 0) continue;
      const match = matchVtd(county, precinct);
      rows.push({
        year,
        contestType,
        county,
        countyFips: match.countyFips,
        precinct,
        vtd: match.vtd,
        party: normParty(row.party),
        candidate: String(row.candidate || "").trim(),
        votes,
      });
    }
  }
  return rows;
}

function existingPayloadSource(scope, contestType, year) {
  const file = path.join(DISTRICT_DIR, `${scope}_${contestType}_${year}.json`);
  if (!fs.existsSync(file)) return "";
  try {
    return String(JSON.parse(fs.readFileSync(file, "utf8"))?.meta?.source || "");
  } catch {
    return "";
  }
}

function makePayload(scope, contestType, year, records, inputVotes, matchedVotes, allocatedVotes, usedFallback) {
  const results = {};
  for (const rec of records.sort((a, b) => Number(a.district) - Number(b.district))) {
    const demCandidate = Array.from(rec.demCandidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "Democratic nominee";
    const repCandidate = Array.from(rec.repCandidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "Republican nominee";
    const total = rec.dem + rec.rep + rec.other;
    const margin = rec.rep - rec.dem;
    const marginPct = total > 0 ? (margin / total) * 100 : 0;
    const winner = margin > 0 ? "REP" : margin < 0 ? "DEM" : "TIE";
    results[String(Number(rec.district))] = {
      dem_votes: rec.dem,
      rep_votes: rec.rep,
      other_votes: rec.other,
      total_votes: total,
      dem_candidate: demCandidate,
      rep_candidate: repCandidate,
      margin,
      margin_pct: marginPct,
      winner,
      color: winner === "REP" ? "R" : winner === "DEM" ? "D" : "T",
    };
  }
  return {
    year,
    scope,
    contest_type: contestType,
    meta: {
      source: usedFallback ? "openelections_precinct_vtd_hybrid_crosswalk" : "openelections_precinct_vtd_crosswalk",
      crosswalk_dir: "crosswalks_2020_2022",
      method: usedFallback
        ? "OpenElections precinct rows matched to 2020 VTD GEOIDs where possible, then unmatched precinct votes allocated by county-level district area shares derived from the local VTD-to-district crosswalks. Existing DRA VTD outputs are preserved."
        : "OpenElections precinct rows matched to 2020 VTD GEOIDs, then allocated to target districts with local VTD-to-district weights. Existing DRA VTD outputs are preserved.",
      match_coverage_pct: inputVotes > 0 ? (matchedVotes / inputVotes) * 100 : 0,
      allocated_coverage_pct: inputVotes > 0 ? (allocatedVotes / inputVotes) * 100 : 0,
      fallback_votes: usedFallback ? allocatedVotes - matchedVotes : 0,
    },
    general: { results },
  };
}

function main() {
  if (!fs.existsSync(DISTRICT_DIR)) fs.mkdirSync(DISTRICT_DIR, { recursive: true });
  const matchVtd = makeVtdMatcher();
  const rows = loadPrecinctRows(matchVtd);
  const crosswalks = new Map(Object.entries(CROSSWALKS).map(([scope, file]) => [scope, loadCrosswalk(file)]));
  const fallbackWeights = new Map(Object.entries(CROSSWALKS).map(([scope, file]) => [scope, loadCountyFallbackWeights(file)]));
  const aggregates = new Map();
  const coverage = new Map();

  for (const row of rows) {
    const covKey = `${row.year}|${row.contestType}`;
    if (!coverage.has(covKey)) coverage.set(covKey, { input: 0, matched: 0 });
    coverage.get(covKey).input += row.votes;
    if (row.vtd) coverage.get(covKey).matched += row.votes;

    for (const [scope, crosswalk] of crosswalks.entries()) {
      const weights = row.vtd ? crosswalk.get(row.vtd) || [] : fallbackWeights.get(scope)?.get(row.countyFips) || [];
      if (!weights.length) continue;
      coverage.get(covKey)[`allocated:${scope}`] = (coverage.get(covKey)[`allocated:${scope}`] || 0) + row.votes;
      for (const { district, weight } of weights) {
        const key = `${scope}|${row.contestType}|${row.year}|${district}`;
        if (!aggregates.has(key)) {
          aggregates.set(key, {
            scope,
            contestType: row.contestType,
            year: row.year,
            district,
            dem: 0,
            rep: 0,
            other: 0,
            demCandidates: new Map(),
            repCandidates: new Map(),
          });
        }
        const rec = aggregates.get(key);
        const weightedVotes = row.votes * weight;
        if (row.party === "DEM") {
          rec.dem += weightedVotes;
          if (row.candidate) rec.demCandidates.set(row.candidate, (rec.demCandidates.get(row.candidate) || 0) + weightedVotes);
        } else if (row.party === "REP") {
          rec.rep += weightedVotes;
          if (row.candidate) rec.repCandidates.set(row.candidate, (rec.repCandidates.get(row.candidate) || 0) + weightedVotes);
        } else {
          rec.other += weightedVotes;
        }
      }
    }
  }

  const grouped = new Map();
  for (const rec of aggregates.values()) {
    const key = `${rec.scope}|${rec.contestType}|${rec.year}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(rec);
  }

  const newEntries = [];
  for (const [key, records] of grouped.entries()) {
    const [scope, contestType, yearStr] = key.split("|");
    const year = Number(yearStr);
    const source = existingPayloadSource(scope, contestType, year);
    if (PROTECTED_SOURCES.has(source)) continue;
    const cov = coverage.get(`${year}|${contestType}`) || { input: 0, matched: 0 };
    const pct = cov.input > 0 ? (cov.matched / cov.input) * 100 : 0;
    const allocatedVotes = cov[`allocated:${scope}`] || 0;
    const allocatedPct = cov.input > 0 ? (allocatedVotes / cov.input) * 100 : 0;
    const usedFallback = pct < MIN_COVERAGE_PCT;
    if (usedFallback && (pct < MIN_EXACT_COVERAGE_WITH_FALLBACK_PCT || allocatedPct < MIN_ALLOCATED_COVERAGE_PCT)) continue;
    if (!usedFallback && pct < MIN_COVERAGE_PCT) continue;
    const payload = makePayload(scope, contestType, year, records, cov.input, cov.matched, allocatedVotes, usedFallback);
    const file = `${scope}_${contestType}_${year}.json`;
    fs.writeFileSync(path.join(DISTRICT_DIR, file), JSON.stringify(payload), "utf8");
    newEntries.push({
      year,
      scope,
      contest_type: contestType,
      file,
      rows: Object.keys(payload.general.results).length,
      major_party_contested: true,
    });
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
  console.log(
    `Wrote ${newEntries.length} OpenElections precinct/VTD district files using exact VTD matches or ` +
      `>=${MIN_EXACT_COVERAGE_WITH_FALLBACK_PCT}% exact coverage with >=${MIN_ALLOCATED_COVERAGE_PCT}% hybrid allocation`
  );
}

main();
