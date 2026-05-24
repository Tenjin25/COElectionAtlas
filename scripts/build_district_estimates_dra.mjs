#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OE_DIR = path.join(ROOT, "data", "openelections-data-co");
const DISTRICT_DIR = path.join(ROOT, "data", "district_contests");
const DISTRICT_MANIFEST = path.join(DISTRICT_DIR, "manifest.json");
const BRIDGE_PATH = path.join(ROOT, "data", "mappings", "precinct_id_bridge_template.csv");
const COUNTY_GEOJSON = path.join(ROOT, "data", "tl_2020_08_county20.geojson");
const CONTESTS_DIR = path.join(ROOT, "data", "contests");

const CROSSWALKS = {
  congressional: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_cd118.csv"),
  state_house: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_sldl.csv"),
  state_senate: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_sldu.csv"),
};

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

  const headers = (rows.shift() || []).map((h) => String(h || "").trim().toLowerCase());
  return rows
    .filter((r) => r.some((x) => String(x || "").trim().length > 0))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = String(r[i] || "").trim();
      });
      return obj;
    });
}

function normalizeCounty(v) {
  return String(v || "").trim().replace(/\s+county$/i, "").replace(/\s+/g, " ").toUpperCase();
}

function normalizeOffice(v) {
  return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normParty(v) {
  const p = String(v || "").trim().toUpperCase();
  if (["DEM", "D", "DEMOCRAT", "DEMOCRATIC"].includes(p)) return "DEM";
  if (["REP", "R", "REPUBLICAN", "GOP"].includes(p)) return "REP";
  return "OTHER";
}

function contestTypeFromOffice(v) {
  const o = normalizeOffice(v);
  if (o.includes("president")) return "president";
  if (o === "u s senate" || o === "us senate" || o.includes("u s senate class")) return "us_senate";
  return "";
}

function loadBridge() {
  if (!fs.existsSync(BRIDGE_PATH)) return new Map();
  const rows = parseCsv(fs.readFileSync(BRIDGE_PATH, "utf8"));
  const out = new Map();
  for (const r of rows) {
    const county = normalizeCounty(r.county);
    const electionPrecinct = String(r.election_precinct_id || "").trim();
    const crosswalkPrecinct = String(r.suggested_crosswalk_precinct_id || "").replace(/[^0-9]/g, "").trim();
    const needsReview = String(r.needs_manual_review || "").toLowerCase().trim();
    if (!county || !electionPrecinct || !crosswalkPrecinct) continue;
    if (needsReview === "yes" || needsReview === "true" || needsReview === "1") continue;
    out.set(`${county}|${electionPrecinct}`, crosswalkPrecinct);
  }
  return out;
}

function loadCrosswalkWeights(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const byPrecinct = new Map();
  const totals = new Map();
  const rawRows = [];
  for (const r of rows) {
    const precinctId = String(r.precinct_id || "").replace(/[^0-9]/g, "");
    const district = String(r.target_id || "").replace(/[^0-9]/g, "").replace(/^0+/, "") || "0";
    const w = Number(r.weight || 0);
    const pieceArea = Number(r.piece_area || 0);
    rawRows.push({ precinctId, district, weight: w, pieceArea });
    if (!precinctId || !district || !Number.isFinite(w) || w <= 0) continue;
    if (!byPrecinct.has(precinctId)) byPrecinct.set(precinctId, []);
    byPrecinct.get(precinctId).push({ district, weight: w });
    totals.set(precinctId, (totals.get(precinctId) || 0) + w);
  }
  for (const [precinctId, arr] of byPrecinct.entries()) {
    const total = totals.get(precinctId) || 0;
    if (!(total > 0)) continue;
    for (const x of arr) x.weight = x.weight / total;
  }
  return { byPrecinct, rawRows };
}

function listPrecinctFiles() {
  const files = [];
  if (!fs.existsSync(OE_DIR)) return files;
  for (const yearDir of fs.readdirSync(OE_DIR, { withFileTypes: true })) {
    if (!yearDir.isDirectory() || !/^\d{4}$/.test(yearDir.name)) continue;
    const dir = path.join(OE_DIR, yearDir.name);
    for (const f of fs.readdirSync(dir)) {
      if (/__co__general__precinct\.csv$/i.test(f)) files.push(path.join(dir, f));
    }
  }
  return files.sort();
}

function parseYearFromFile(filePath) {
  const m = filePath.replace(/\\/g, "/").match(/\/(\d{4})\//);
  return m ? Number(m[1]) : NaN;
}

function aggregatePrecinctVotes() {
  const files = listPrecinctFiles();
  const out = [];
  for (const file of files) {
    const year = parseYearFromFile(file);
    if (!Number.isFinite(year)) continue;
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    for (const r of rows) {
      const contestType = contestTypeFromOffice(r.office);
      if (!contestType) continue;
      const county = normalizeCounty(r.county);
      const precinct = String(r.precinct || "").trim();
      const candidate = String(r.candidate || "").trim();
      const votes = Number(r.votes || 0);
      if (!county || !precinct || !Number.isFinite(votes) || votes <= 0) continue;
      out.push({
        year,
        contestType,
        county,
        precinct,
        party: normParty(r.party),
        candidate,
        votes,
      });
    }
  }
  return out;
}

function allocateToDistricts(rows, bridge, weightsByPrecinct) {
  const bucket = new Map(); // year|contest|district -> totals
  let inputVotes = 0;
  let matchedVotes = 0;
  for (const row of rows) {
    inputVotes += row.votes;
    const bridgeKey = `${row.county}|${row.precinct}`;
    const crosswalkPrecinctId = bridge.get(bridgeKey);
    if (!crosswalkPrecinctId) continue;
    const distWeights = weightsByPrecinct.get(crosswalkPrecinctId);
    if (!distWeights || !distWeights.length) continue;
    matchedVotes += row.votes;

    for (const d of distWeights) {
      const key = `${row.year}|${row.contestType}|${d.district}`;
      if (!bucket.has(key)) {
        bucket.set(key, {
          year: row.year,
          contestType: row.contestType,
          district: d.district,
          dem_votes: 0,
          rep_votes: 0,
          other_votes: 0,
          dem_candidates: new Map(),
          rep_candidates: new Map(),
        });
      }
      const rec = bucket.get(key);
      const wv = row.votes * d.weight;
      if (row.party === "DEM") {
        rec.dem_votes += wv;
        if (row.candidate) rec.dem_candidates.set(row.candidate, (rec.dem_candidates.get(row.candidate) || 0) + wv);
      } else if (row.party === "REP") {
        rec.rep_votes += wv;
        if (row.candidate) rec.rep_candidates.set(row.candidate, (rec.rep_candidates.get(row.candidate) || 0) + wv);
      } else {
        rec.other_votes += wv;
      }
    }
  }
  return { bucket, inputVotes, matchedVotes };
}

function loadCountyFipsMaps() {
  const geo = JSON.parse(fs.readFileSync(COUNTY_GEOJSON, "utf8"));
  const nameToFips = new Map();
  const fipsToName = new Map();
  for (const ft of geo.features || []) {
    const p = ft.properties || {};
    const name = normalizeCounty(p.NAME20 || p.NAME || "");
    const fips = String(p.GEOID20 || p.GEOID || "").trim();
    if (name && fips) {
      nameToFips.set(name, fips);
      fipsToName.set(fips, name);
    }
  }
  return { nameToFips, fipsToName };
}

function buildCountyToDistrictShares(rawRows) {
  const countyDistrict = new Map();
  const countyTotals = new Map();
  for (const r of rawRows) {
    const countyFips = String(r.precinctId || "").slice(0, 5);
    const district = String(r.district || "");
    if (!countyFips || countyFips.length < 5 || !district) continue;
    const amt =
      Number.isFinite(r.pieceArea) && r.pieceArea > 0
        ? r.pieceArea
        : Number.isFinite(r.weight) && r.weight > 0
          ? r.weight
          : 0;
    if (!(amt > 0)) continue;
    const key = `${countyFips}|${district}`;
    countyDistrict.set(key, (countyDistrict.get(key) || 0) + amt);
    countyTotals.set(countyFips, (countyTotals.get(countyFips) || 0) + amt);
  }
  const out = new Map();
  for (const [key, v] of countyDistrict.entries()) {
    const [countyFips] = key.split("|");
    const total = countyTotals.get(countyFips) || 0;
    if (total > 0) out.set(key, v / total);
  }
  return out;
}

function loadCountyContestRows(contestType, year) {
  const file = path.join(CONTESTS_DIR, `${contestType}_${year}.json`);
  if (!fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(payload.rows) ? payload.rows : [];
}

function allocateCountyFallback(contestType, year, countyRows, countyShares, nameToFips) {
  const records = new Map();
  let inputVotes = 0;
  let matchedVotes = 0;
  for (const row of countyRows) {
    const countyName = normalizeCounty(row.county);
    const countyFips = nameToFips.get(countyName);
    const demVotes = Number(row.dem_votes || 0);
    const repVotes = Number(row.rep_votes || 0);
    const otherVotes = Number(row.other_votes || 0);
    const totalVotes = Number(row.total_votes || demVotes + repVotes + otherVotes);
    if (!(totalVotes > 0)) continue;
    inputVotes += totalVotes;
    if (!countyFips) continue;
    let touched = false;
    for (const [k, share] of countyShares.entries()) {
      const [fips, district] = k.split("|");
      if (fips !== countyFips) continue;
      touched = true;
      const key = `${year}|${contestType}|${district}`;
      if (!records.has(key)) {
        records.set(key, {
          year,
          contestType,
          district,
          dem_votes: 0,
          rep_votes: 0,
          other_votes: 0,
          dem_candidates: new Map(),
          rep_candidates: new Map(),
        });
      }
      const rec = records.get(key);
      rec.dem_votes += demVotes * share;
      rec.rep_votes += repVotes * share;
      rec.other_votes += otherVotes * share;
      const demCand = String(row.dem_candidate || "").trim();
      const repCand = String(row.rep_candidate || "").trim();
      if (demCand && demVotes > 0) rec.dem_candidates.set(demCand, (rec.dem_candidates.get(demCand) || 0) + demVotes * share);
      if (repCand && repVotes > 0) rec.rep_candidates.set(repCand, (rec.rep_candidates.get(repCand) || 0) + repVotes * share);
    }
    if (touched) matchedVotes += totalVotes;
  }
  return { records: Array.from(records.values()), inputVotes, matchedVotes };
}

function makePayload(scope, contestType, year, records, coveragePct) {
  const results = {};
  for (const rec of records.sort((a, b) => Number(a.district) - Number(b.district))) {
    const demCandidate = Array.from(rec.dem_candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const repCandidate = Array.from(rec.rep_candidates.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const total = rec.dem_votes + rec.rep_votes + rec.other_votes;
    const twoParty = rec.dem_votes + rec.rep_votes;
    const margin = rec.rep_votes - rec.dem_votes;
    const marginPct = twoParty > 0 ? (margin / twoParty) * 100 : 0;
    const winner = rec.rep_votes > rec.dem_votes ? "REP" : rec.dem_votes > rec.rep_votes ? "DEM" : "TIE";
    const color = winner === "REP" ? "R" : winner === "DEM" ? "D" : "T";
    results[String(Number(rec.district))] = {
      dem_votes: rec.dem_votes,
      rep_votes: rec.rep_votes,
      other_votes: rec.other_votes,
      total_votes: total,
      dem_candidate: demCandidate,
      rep_candidate: repCandidate,
      margin,
      margin_pct: marginPct,
      winner,
      color,
    };
  }
  return {
    year,
    scope,
    contest_type: contestType,
    meta: {
      source: "dra_style_precinct_bridge_crosswalk_weighted",
      match_coverage_pct: coveragePct,
    },
    general: { results },
  };
}

function main() {
  if (!fs.existsSync(DISTRICT_DIR)) fs.mkdirSync(DISTRICT_DIR, { recursive: true });
  const bridge = loadBridge();
  const { nameToFips } = loadCountyFipsMaps();
  const precinctRows = aggregatePrecinctVotes();
  const contestManifestPath = path.join(CONTESTS_DIR, "manifest.json");
  const contestManifest = fs.existsSync(contestManifestPath)
    ? JSON.parse(fs.readFileSync(contestManifestPath, "utf8"))
    : { files: [] };
  const contestFiles = Array.isArray(contestManifest.files) ? contestManifest.files : [];
  const statewideContestYearPairs = contestFiles
    .map((e) => ({ contestType: String(e.contest_type || ""), year: Number(e.year) }))
    .filter(
      (x) =>
        x.contestType &&
        x.contestType !== "lt_governor" &&
        !["us_house", "state_house", "state_senate"].includes(x.contestType) &&
        Number.isFinite(x.year)
    );
  const manifestEntries = [];

  let existingManifest = [];
  if (fs.existsSync(DISTRICT_MANIFEST)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(DISTRICT_MANIFEST, "utf8")).files || [];
    } catch {
      existingManifest = [];
    }
  }

  for (const [scope, crosswalkPath] of Object.entries(CROSSWALKS)) {
    const { byPrecinct: weightsByPrecinct, rawRows } = loadCrosswalkWeights(crosswalkPath);
    const countyShares = buildCountyToDistrictShares(rawRows);
    const { bucket, inputVotes, matchedVotes } = allocateToDistricts(precinctRows, bridge, weightsByPrecinct);
    const grouped = new Map(); // contest|year -> { records,inputVotes,matchedVotes,source }
    for (const rec of bucket.values()) {
      const k = `${rec.contestType}|${rec.year}`;
      if (!grouped.has(k)) grouped.set(k, { records: [], inputVotes: 0, matchedVotes: 0, source: "precinct_bridge_crosswalk" });
      grouped.get(k).records.push(rec);
    }
    const desiredPairs = new Map();
    for (const r of precinctRows) {
      if (!r.contestType || !Number.isFinite(r.year)) continue;
      desiredPairs.set(`${r.contestType}|${r.year}`, { contestType: r.contestType, year: r.year });
    }
    for (const p of statewideContestYearPairs) {
      desiredPairs.set(`${p.contestType}|${p.year}`, p);
    }
    for (const pair of desiredPairs.values()) {
      const contestType = pair.contestType;
      const year = pair.year;
      const k = `${contestType}|${year}`;
      const hasPrecinct = grouped.has(k) && grouped.get(k).records.length > 0;
      if (hasPrecinct) continue;
      const countyRows = loadCountyContestRows(contestType, year);
      if (!countyRows.length) continue;
      const fallback = allocateCountyFallback(contestType, year, countyRows, countyShares, nameToFips);
      if (!fallback.records.length) continue;
      grouped.set(k, { ...fallback, source: "county_to_district_crosswalk_fallback" });
    }
    // Carry scope-level coverage for the pure precinct path when present.
    for (const v of grouped.values()) {
      if (v.source === "precinct_bridge_crosswalk") {
        v.inputVotes = inputVotes;
        v.matchedVotes = matchedVotes;
      }
    }

    for (const [k, records] of grouped.entries()) {
      const [contestType, yearStr] = k.split("|");
      const year = Number(yearStr);
      if (!Number.isFinite(year)) continue;
      if (!contestType || ["us_house", "state_house", "state_senate"].includes(contestType)) continue;
      const groupObj = records;
      const coveragePct =
        groupObj.inputVotes > 0 ? (groupObj.matchedVotes / groupObj.inputVotes) * 100 : 0;
      const payload = makePayload(scope, contestType, year, groupObj.records, coveragePct);
      payload.meta.source = groupObj.source;
      if (!Object.keys(payload.general.results || {}).length) continue;
      const file = `${scope}_${contestType}_${year}.json`;
      fs.writeFileSync(path.join(DISTRICT_DIR, file), JSON.stringify(payload), "utf8");
      manifestEntries.push({
        year,
        scope,
        contest_type: contestType,
        file,
        rows: Object.keys(payload.general.results).length,
        major_party_contested: true,
      });
    }
  }

  const producedKeys = new Set(
    manifestEntries.map((e) => `${e.scope}|${e.contest_type}|${e.year}`)
  );
  const keep = existingManifest.filter((e) => {
    const k = `${e.scope}|${e.contest_type}|${e.year}`;
    return !producedKeys.has(k);
  });
  const mergedMap = new Map();
  for (const e of [...keep, ...manifestEntries]) {
    const k = `${e.scope}|${e.contest_type}|${e.year}`;
    mergedMap.set(k, e);
  }
  const merged = Array.from(mergedMap.values()).sort((a, b) => {
    const ka = `${a.scope}|${a.contest_type}|${a.year}`;
    const kb = `${b.scope}|${b.contest_type}|${b.year}`;
    return ka.localeCompare(kb);
  });
  fs.writeFileSync(DISTRICT_MANIFEST, JSON.stringify({ files: merged }), "utf8");
  console.log(`Wrote ${manifestEntries.length} files and updated ${DISTRICT_MANIFEST}`);
}

main();
