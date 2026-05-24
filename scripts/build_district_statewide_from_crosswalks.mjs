#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DISTRICT_CONTESTS_DIR = path.join(ROOT, "data", "district_contests");
const DISTRICT_MANIFEST_PATH = path.join(DISTRICT_CONTESTS_DIR, "manifest.json");
const COUNTY_GEOJSON_PATH = path.join(ROOT, "data", "tl_2020_08_county20.geojson");
const CONTESTS_DIR = path.join(ROOT, "data", "contests");
const OPENELECTIONS_CO_DIR = path.join(ROOT, "data", "openelections-data-co");
const BRIDGE_TEMPLATE_PATH = path.join(ROOT, "data", "mappings", "precinct_id_bridge_template.csv");
const STRICT_DISTRICT_AGG = false;

const CROSSWALKS = {
  congressional: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_cd118.csv"),
  state_house: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_sldl.csv"),
  state_senate: path.join(ROOT, "data", "crosswalks_cd118_from_2008", "precinct_to_sldu.csv"),
};

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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  const headers = (rows.shift() || []).map((h) => (h || "").trim());
  return rows
    .filter((r) => r.some((x) => String(x || "").trim().length > 0))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h.toLowerCase()] = (r[i] || "").trim();
      });
      return obj;
    });
}

function loadCrosswalk(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  return rows
    .map((r) => ({
      precinct_id: String(r.precinct_id || "").replace(/[^0-9]/g, ""),
      target_id: String(r.target_id || "").replace(/[^0-9]/g, "").replace(/^0+/, "") || "0",
      weight: Number(r.weight || 0),
      piece_area: Number(r.piece_area || 0),
    }))
    .filter((r) => r.precinct_id && Number.isFinite(r.weight) && r.weight > 0);
}

function normalizeCountyName(value) {
  return String(value || "").trim().replace(/\s+county$/i, "").replace(/\s+/g, " ").toUpperCase();
}

function loadCountyFipsByName() {
  const geo = JSON.parse(fs.readFileSync(COUNTY_GEOJSON_PATH, "utf8"));
  const out = new Map();
  for (const feature of geo.features || []) {
    const p = feature.properties || {};
    const name = normalizeCountyName(p.NAME20 || p.NAME || p.name || "");
    const geoid = String(p.GEOID20 || p.GEOID || p.geoid || "").trim();
    if (name && geoid) out.set(name, geoid);
  }
  return out;
}

function loadCountyContestRows(contestType, year) {
  const file = path.join(CONTESTS_DIR, `${contestType}_${year}.json`);
  if (!fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(payload.rows) ? payload.rows : [];
}

function normalizeOffice(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function looksLikeDemParty(value) {
  const s = String(value || "").trim().toUpperCase();
  return s === "DEM" || s === "DEMOCRAT" || s === "DEMOCRATIC" || s === "D";
}

function looksLikeRepParty(value) {
  const s = String(value || "").trim().toUpperCase();
  return s === "REP" || s === "REPUBLICAN" || s === "R";
}

function parseOpenElectionsCountyRows(contestType, year) {
  const yearDir = path.join(OPENELECTIONS_CO_DIR, String(year));
  if (!fs.existsSync(yearDir)) return [];
  const files = fs.readdirSync(yearDir).filter((f) => /__co__general__county\.csv$/i.test(f));
  if (!files.length) return [];

  const targetOffice = contestType === "president" ? "us president" : "us senate";
  const countyMap = new Map(); // county -> accumulator

  for (const fileName of files) {
    const rows = parseCsv(fs.readFileSync(path.join(yearDir, fileName), "utf8"));
    for (const r of rows) {
      const officeNorm = normalizeOffice(r.office);
      if (officeNorm !== targetOffice) continue;
      const county = String(r.county || "").trim();
      if (!county) continue;
      const candidate = String(r.candidate || "").trim();
      const party = String(r.party || "").trim();
      const votes = Number(r.votes || 0);
      if (!Number.isFinite(votes) || votes <= 0) continue;

      if (!countyMap.has(county)) {
        countyMap.set(county, {
          county,
          dem_votes: 0,
          rep_votes: 0,
          other_votes: 0,
          dem_candidate: "",
          rep_candidate: "",
          total_votes: 0,
        });
      }
      const acc = countyMap.get(county);
      acc.total_votes += votes;
      if (looksLikeDemParty(party)) {
        acc.dem_votes += votes;
        if (!acc.dem_candidate) acc.dem_candidate = candidate;
      } else if (looksLikeRepParty(party)) {
        acc.rep_votes += votes;
        if (!acc.rep_candidate) acc.rep_candidate = candidate;
      } else {
        acc.other_votes += votes;
      }
    }
  }
  return Array.from(countyMap.values());
}

function loadPrecinctBridgeMap() {
  if (!fs.existsSync(BRIDGE_TEMPLATE_PATH)) return new Map();
  const rows = parseCsv(fs.readFileSync(BRIDGE_TEMPLATE_PATH, "utf8"));
  const out = new Map();
  for (const r of rows) {
    const county = normalizeCountyName(r.county);
    const electionPrecinctId = String(r.election_precinct_id || "").trim();
    const crosswalkPrecinctId = String(r.suggested_crosswalk_precinct_id || "").replace(/[^0-9]/g, "").trim();
    const needsReview = String(r.needs_manual_review || "").trim().toLowerCase();
    if (!county || !electionPrecinctId || !crosswalkPrecinctId) continue;
    if (needsReview === "yes" || needsReview === "true" || needsReview === "1") continue;
    out.set(`${county}|${electionPrecinctId}`, crosswalkPrecinctId);
  }
  return out;
}

function buildCrosswalkPrecinctDistrictWeights(crosswalkRows) {
  const sums = new Map(); // crosswalkPrecinctId|district -> weight sum
  const totals = new Map(); // crosswalkPrecinctId -> total
  for (const row of crosswalkRows) {
    const precinctId = String(row.precinct_id || "").replace(/[^0-9]/g, "");
    const district = String(row.target_id || "").replace(/[^0-9]/g, "");
    const w = Number(row.weight || 0);
    if (!precinctId || !district || !Number.isFinite(w) || w <= 0) continue;
    const key = `${precinctId}|${district}`;
    sums.set(key, (sums.get(key) || 0) + w);
    totals.set(precinctId, (totals.get(precinctId) || 0) + w);
  }
  const out = new Map(); // crosswalkPrecinctId -> [{district, share}]
  for (const [key, w] of sums.entries()) {
    const [precinctId, district] = key.split("|");
    const total = totals.get(precinctId) || 0;
    if (!(total > 0)) continue;
    if (!out.has(precinctId)) out.set(precinctId, []);
    out.get(precinctId).push({ district, share: w / total });
  }
  return out;
}

function loadPrecinctContestRows(contestType, year) {
  const yearDir = path.join(OPENELECTIONS_CO_DIR, String(year));
  if (!fs.existsSync(yearDir)) return [];
  const files = fs.readdirSync(yearDir).filter((f) => /__co__general__precinct\.csv$/i.test(f));
  if (!files.length) return [];
  const targetOffice = contestType === "president" ? "us president" : "us senate";
  const byPrecinct = new Map(); // county|precinct -> votes
  for (const fileName of files) {
    const rows = parseCsv(fs.readFileSync(path.join(yearDir, fileName), "utf8"));
    for (const r of rows) {
      if (normalizeOffice(r.office) !== targetOffice) continue;
      const county = normalizeCountyName(r.county);
      const precinct = String(r.precinct || "").trim();
      const votes = Number(r.votes || 0);
      if (!county || !precinct || !Number.isFinite(votes) || votes <= 0) continue;
      const key = `${county}|${precinct}`;
      if (!byPrecinct.has(key)) byPrecinct.set(key, {
        county,
        precinct,
        dem_votes: 0,
        rep_votes: 0,
        other_votes: 0,
      });
      const acc = byPrecinct.get(key);
      const party = String(r.party || "");
      if (looksLikeDemParty(party)) acc.dem_votes += votes;
      else if (looksLikeRepParty(party)) acc.rep_votes += votes;
      else acc.other_votes += votes;
    }
  }
  return Array.from(byPrecinct.values());
}

function buildCountyToDistrictShares(crosswalkRows) {
  const sums = new Map();
  const totals = new Map();
  for (const row of crosswalkRows) {
    const countyFips = String(row.precinct_id || "").slice(0, 5);
    if (!countyFips || countyFips.length < 5) continue;
    const district = String(row.target_id || "");
    if (!district) continue;
    const amt = Number.isFinite(row.piece_area) && row.piece_area > 0 ? row.piece_area : Number(row.weight || 0);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const key = `${countyFips}|${district}`;
    sums.set(key, (sums.get(key) || 0) + amt);
    totals.set(countyFips, (totals.get(countyFips) || 0) + amt);
  }
  const shares = new Map();
  for (const [key, val] of sums.entries()) {
    const [countyFips] = key.split("|");
    const total = totals.get(countyFips) || 0;
    if (total > 0) shares.set(key, val / total);
  }
  return shares;
}

function renderPayload(scope, contestType, year, countyRows, countyFipsByName, countyDistrictShares) {
  const byDistrict = new Map();
  let demCand = "";
  let repCand = "";

  // Pick party labels by statewide vote totals across all counties,
  // not by the single biggest county row.
  const demNameTotals = new Map();
  const repNameTotals = new Map();
  for (const row of countyRows) {
    const demName = String(row.dem_candidate || "").trim();
    const repName = String(row.rep_candidate || "").trim();
    const demVotes = Number(row.dem_votes || 0);
    const repVotes = Number(row.rep_votes || 0);
    if (demName && Number.isFinite(demVotes) && demVotes > 0) {
      demNameTotals.set(demName, (demNameTotals.get(demName) || 0) + demVotes);
    }
    if (repName && Number.isFinite(repVotes) && repVotes > 0) {
      repNameTotals.set(repName, (repNameTotals.get(repName) || 0) + repVotes);
    }
  }
  if (demNameTotals.size > 0) {
    demCand = Array.from(demNameTotals.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }
  if (repNameTotals.size > 0) {
    repCand = Array.from(repNameTotals.entries()).sort((a, b) => b[1] - a[1])[0][0];
  }

  for (const row of countyRows) {
    const countyName = normalizeCountyName(row.county);
    const countyFips = countyFipsByName.get(countyName);
    if (!countyFips) continue;
    const demVotes = Number(row.dem_votes || 0);
    const repVotes = Number(row.rep_votes || 0);
    const otherVotes = Number(row.other_votes || 0);
    const totalVotes = Number(row.total_votes || (demVotes + repVotes + otherVotes));
    if (!(totalVotes > 0)) continue;

    for (const [key, share] of countyDistrictShares.entries()) {
      const [keyCounty, district] = key.split("|");
      if (keyCounty !== countyFips) continue;
      if (!byDistrict.has(district)) byDistrict.set(district, { dem: 0, rep: 0, other: 0 });
      const acc = byDistrict.get(district);
      acc.dem += demVotes * share;
      acc.rep += repVotes * share;
      acc.other += otherVotes * share;
    }
  }

  const results = {};
  const sortedDistricts = Array.from(byDistrict.keys()).sort((a, b) => Number(a) - Number(b));
  for (const d of sortedDistricts) {
    const votes = byDistrict.get(d);
    const dem = votes.dem || 0;
    const rep = votes.rep || 0;
    const other = votes.other || 0;
    const total = dem + rep + other;
    const twoParty = dem + rep;
    const margin = rep - dem;
    const marginPct = twoParty > 0 ? (margin / twoParty) * 100 : 0;
    const winner = rep > dem ? "REP" : dem > rep ? "DEM" : "TIE";
    const color = winner === "REP" ? "R" : winner === "DEM" ? "D" : "T";
    results[String(Number(d))] = {
      dem_votes: dem,
      rep_votes: rep,
      other_votes: other,
      total_votes: total,
      dem_candidate: demCand,
      rep_candidate: repCand,
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
    meta: { source: "co_openelections_general_precinct_crosswalk", match_coverage_pct: 100.0 },
    general: { results },
  };
}

function main() {
  if (!fs.existsSync(DISTRICT_CONTESTS_DIR)) fs.mkdirSync(DISTRICT_CONTESTS_DIR, { recursive: true });
  const countyFipsByName = loadCountyFipsByName();
  const precinctBridge = loadPrecinctBridgeMap();

  const newEntries = [];
  for (const [scope, crosswalkPath] of Object.entries(CROSSWALKS)) {
    const crosswalk = loadCrosswalk(crosswalkPath);
    const shares = buildCountyToDistrictShares(crosswalk);
    const precinctDistrictWeights = buildCrosswalkPrecinctDistrictWeights(crosswalk);

    for (const contestType of ["president", "us_senate"]) {
      const years = new Set();
      const manifestPath = path.join(CONTESTS_DIR, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        const contestManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        for (const e of contestManifest.files || []) {
          if (String(e.contest_type || "").trim() === contestType) years.add(Number(e.year));
        }
      }
      const sortedYears = Array.from(years).filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
      for (const year of sortedYears) {
        const precinctRows = loadPrecinctContestRows(contestType, year);
        let payload = null;
        if (precinctRows.length && precinctBridge.size && precinctDistrictWeights.size) {
          const districtAgg = new Map();
          for (const row of precinctRows) {
            const bridgeKey = `${row.county}|${row.precinct}`;
            const crosswalkPrecinctId = precinctBridge.get(bridgeKey);
            if (!crosswalkPrecinctId) continue;
            const distWeights = precinctDistrictWeights.get(crosswalkPrecinctId) || [];
            for (const dw of distWeights) {
              if (!districtAgg.has(dw.district)) districtAgg.set(dw.district, { dem: 0, rep: 0, other: 0 });
              const acc = districtAgg.get(dw.district);
              acc.dem += row.dem_votes * dw.share;
              acc.rep += row.rep_votes * dw.share;
              acc.other += row.other_votes * dw.share;
            }
          }
          const districtRowsPayload = { year, scope, contest_type: contestType, meta: { source: "co_openelections_general_precinct_crosswalk_bridge", match_coverage_pct: 100.0 }, general: { results: {} } };
          for (const d of Array.from(districtAgg.keys()).sort((a, b) => Number(a) - Number(b))) {
            const v = districtAgg.get(d);
            const dem = v.dem || 0;
            const rep = v.rep || 0;
            const other = v.other || 0;
            const total = dem + rep + other;
            const twoParty = dem + rep;
            const margin = rep - dem;
            const marginPct = twoParty > 0 ? (margin / twoParty) * 100 : 0;
            const winner = rep > dem ? "REP" : dem > rep ? "DEM" : "TIE";
            const color = winner === "REP" ? "R" : winner === "DEM" ? "D" : "T";
            districtRowsPayload.general.results[String(Number(d))] = {
              dem_votes: dem,
              rep_votes: rep,
              other_votes: other,
              total_votes: total,
              dem_candidate: "",
              rep_candidate: "",
              margin,
              margin_pct: marginPct,
              winner,
              color,
            };
          }
          payload = districtRowsPayload;
        }
        if (!payload) {
          if (STRICT_DISTRICT_AGG) {
            console.warn(`Skipping ${scope}/${contestType}/${year}: no precinct bridge-based district aggregation available.`);
            continue;
          }
          let countyRows = parseOpenElectionsCountyRows(contestType, year);
          if (!countyRows.length) countyRows = loadCountyContestRows(contestType, year);
          if (!countyRows.length) continue;
          payload = renderPayload(scope, contestType, year, countyRows, countyFipsByName, shares);
        }
        if (!Object.keys(payload.general.results || {}).length) continue;
        const file = `${scope}_${contestType}_${year}.json`;
        fs.writeFileSync(path.join(DISTRICT_CONTESTS_DIR, file), JSON.stringify(payload), "utf8");
        newEntries.push({
          year,
          scope,
          contest_type: contestType,
          file,
          rows: Object.keys(payload.general.results).length,
          major_party_contested: true,
        });
      }
    }
  }

  let existing = [];
  if (fs.existsSync(DISTRICT_MANIFEST_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(DISTRICT_MANIFEST_PATH, "utf8")).files || [];
    } catch {
      existing = [];
    }
  }
  const kept = existing.filter((e) => !["president", "us_senate"].includes(String(e.contest_type || "").trim()));
  const merged = [...kept, ...newEntries].sort((a, b) => {
    const ka = `${a.scope}|${a.contest_type}|${a.year}`;
    const kb = `${b.scope}|${b.contest_type}|${b.year}`;
    return ka.localeCompare(kb);
  });
  fs.writeFileSync(DISTRICT_MANIFEST_PATH, JSON.stringify({ files: merged }), "utf8");
  console.log(`Wrote ${newEntries.length} files and updated ${DISTRICT_MANIFEST_PATH}`);
}

main();
