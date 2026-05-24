#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OE_DIR = path.join(ROOT, "data", "openelections-data-co");
const CONTESTS_DIR = path.join(ROOT, "data", "contests");
const MANIFEST_PATH = path.join(CONTESTS_DIR, "manifest.json");

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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
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

function normalizeOffice(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeCounty(v) {
  const s = String(v || "")
    .trim()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

function normParty(v) {
  const p = String(v || "").trim().toUpperCase();
  if (["DEM", "D", "DEMOCRAT", "DEMOCRATIC"].includes(p)) return "DEM";
  if (["REP", "R", "REPUBLICAN", "GOP"].includes(p)) return "REP";
  return "OTHER";
}

function listYears() {
  if (!fs.existsSync(OE_DIR)) return [];
  return fs
    .readdirSync(OE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
    .map((d) => Number(d.name))
    .filter((y) => y >= 2000 && y <= 2024)
    .sort((a, b) => a - b);
}

function buildForYear(year) {
  const yearDir = path.join(OE_DIR, String(year));
  if (!fs.existsSync(yearDir)) return null;
  const files = fs
    .readdirSync(yearDir)
    .filter(
      (f) =>
        /__co__general(?:__county)?\.csv$/i.test(f) &&
        !/__precinct\.csv$/i.test(f) &&
        !/__primary/i.test(f)
    );
  if (!files.length) return null;

  const byCounty = new Map();
  for (const file of files) {
    const rows = parseCsv(fs.readFileSync(path.join(yearDir, file), "utf8"));
    for (const r of rows) {
      const office = normalizeOffice(r.office);
      if (office !== "us senate" && office !== "u s senate" && office !== "u s senate class 1" && office !== "u s senate class 3") continue;
      const county = normalizeCounty(r.county);
      if (!county) continue;
      if (["TOTAL", "TOTALS", "STATEWIDE", "COLORADO"].includes(county.toUpperCase())) continue;
      const votes = Number(r.votes || 0);
      if (!Number.isFinite(votes) || votes <= 0) continue;
      const candidate = String(r.candidate || "").trim();
      const party = normParty(r.party);
      const rawParty = String(r.party || "").trim();
      if (!rawParty && !candidate) continue; // skip county total rows

      if (!byCounty.has(county)) {
        byCounty.set(county, {
          county,
          dem_votes: 0,
          rep_votes: 0,
          other_votes: 0,
          total_votes: 0,
          dem_candidate_votes: new Map(),
          rep_candidate_votes: new Map(),
        });
      }
      const acc = byCounty.get(county);
      acc.total_votes += votes;
      if (party === "DEM") {
        acc.dem_votes += votes;
        if (candidate) acc.dem_candidate_votes.set(candidate, (acc.dem_candidate_votes.get(candidate) || 0) + votes);
      } else if (party === "REP") {
        acc.rep_votes += votes;
        if (candidate) acc.rep_candidate_votes.set(candidate, (acc.rep_candidate_votes.get(candidate) || 0) + votes);
      } else {
        acc.other_votes += votes;
      }
    }
  }

  const rowsOut = Array.from(byCounty.values())
    .sort((a, b) => a.county.localeCompare(b.county))
    .map((r) => {
      const demCandidate =
        Array.from(r.dem_candidate_votes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      const repCandidate =
        Array.from(r.rep_candidate_votes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
      const twoParty = r.dem_votes + r.rep_votes;
      const margin = r.rep_votes - r.dem_votes;
      const marginPct = twoParty > 0 ? (margin / twoParty) * 100 : 0;
      const winner = r.rep_votes > r.dem_votes ? "REP" : r.dem_votes > r.rep_votes ? "DEM" : "TIE";
      const color = winner === "REP" ? "R" : winner === "DEM" ? "D" : "T";
      return {
        county: r.county,
        dem_votes: r.dem_votes,
        rep_votes: r.rep_votes,
        other_votes: Math.max(0, r.total_votes - r.dem_votes - r.rep_votes),
        total_votes: r.total_votes,
        dem_candidate: demCandidate,
        rep_candidate: repCandidate,
        margin,
        margin_pct: marginPct,
        winner,
        color,
      };
    });

  if (!rowsOut.length) return null;
  return { rows: rowsOut };
}

function updateManifest(yearsWritten) {
  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : { files: [] };
  const existing = Array.isArray(manifest.files) ? manifest.files : [];
  const kept = existing.filter((e) => String(e.contest_type || "") !== "us_senate" || !yearsWritten.has(Number(e.year)));
  const added = Array.from(yearsWritten).sort((a, b) => a - b).map((year) => ({
    year,
    contest_type: "us_senate",
    file: `us_senate_${year}.json`,
    rows: JSON.parse(fs.readFileSync(path.join(CONTESTS_DIR, `us_senate_${year}.json`), "utf8")).rows.length,
    major_party_contested: true,
  }));
  const merged = [...kept, ...added].sort((a, b) => {
    const ka = `${a.contest_type}|${a.year}`;
    const kb = `${b.contest_type}|${b.year}`;
    return ka.localeCompare(kb);
  });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ files: merged }), "utf8");
}

function main() {
  if (!fs.existsSync(CONTESTS_DIR)) fs.mkdirSync(CONTESTS_DIR, { recursive: true });
  const years = listYears();
  const yearsWritten = new Set();
  for (const year of years) {
    const payload = buildForYear(year);
    if (!payload) continue;
    fs.writeFileSync(
      path.join(CONTESTS_DIR, `us_senate_${year}.json`),
      JSON.stringify(payload),
      "utf8"
    );
    yearsWritten.add(year);
  }
  updateManifest(yearsWritten);
  console.log(`Wrote us_senate contests for ${yearsWritten.size} years.`);
}

main();
