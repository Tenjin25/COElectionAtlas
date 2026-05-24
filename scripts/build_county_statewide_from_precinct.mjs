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

function normCounty(v) {
  return String(v || "")
    .trim()
    .replace(/\s+county$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normParty(v) {
  const p = String(v || "").trim().toUpperCase();
  if (p.includes("DEMOCRAT") || p === "DEM" || p === "D") return "DEM";
  if (p.includes("REPUBLIC") || p === "REP" || p === "R" || p === "GOP") return "REP";
  return "OTHER";
}

function contestTypeFromOffice(v) {
  const o = String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (o.includes("president")) return "president";
  if (o === "us senate" || o === "u s senate" || o.includes("u s senate class")) return "us_senate";
  if (o.includes("governor")) return "governor"; // includes governor/lt governor combined ballots
  if (o.includes("attorney general")) return "attorney_general";
  if (o.includes("secretary of state")) return "secretary_of_state";
  if (o.includes("treasurer")) return "treasurer";
  return "";
}

function parseYear(filePath) {
  const m = filePath.replace(/\\/g, "/").match(/\/(\d{4})\//);
  return m ? Number(m[1]) : NaN;
}

function listPrecinctFiles() {
  const out = [];
  if (!fs.existsSync(OE_DIR)) return out;
  for (const y of fs.readdirSync(OE_DIR, { withFileTypes: true })) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const dir = path.join(OE_DIR, y.name);
    for (const f of fs.readdirSync(dir)) {
      if (/__co__general__precinct\.csv$/i.test(f)) out.push(path.join(dir, f));
    }
  }
  return out.sort();
}

function build() {
  const files = listPrecinctFiles();
  const acc = new Map(); // contest|year|county -> totals
  for (const file of files) {
    const year = parseYear(file);
    if (!Number.isFinite(year)) continue;
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    for (const r of rows) {
      const contestType = contestTypeFromOffice(r.office);
      if (!contestType) continue;
      const county = normCounty(r.county);
      const votes = Number(r.votes || 0);
      if (!county || !Number.isFinite(votes) || votes <= 0) continue;
      const key = `${contestType}|${year}|${county}`;
      if (!acc.has(key)) {
        acc.set(key, {
          contestType,
          year,
          county,
          dem_votes: 0,
          rep_votes: 0,
          other_votes: 0,
          dem_names: new Map(),
          rep_names: new Map(),
        });
      }
      const rec = acc.get(key);
      const party = normParty(r.party);
      const cand = String(r.candidate || "").trim();
      if (party === "DEM") {
        rec.dem_votes += votes;
        if (cand) rec.dem_names.set(cand, (rec.dem_names.get(cand) || 0) + votes);
      } else if (party === "REP") {
        rec.rep_votes += votes;
        if (cand) rec.rep_names.set(cand, (rec.rep_names.get(cand) || 0) + votes);
      } else {
        rec.other_votes += votes;
      }
    }
  }
  return acc;
}

function topName(map) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function emit(acc) {
  const grouped = new Map(); // contest|year -> rows
  for (const rec of acc.values()) {
    const k = `${rec.contestType}|${rec.year}`;
    if (!grouped.has(k)) grouped.set(k, []);
    const total = rec.dem_votes + rec.rep_votes + rec.other_votes;
    const two = rec.dem_votes + rec.rep_votes;
    const margin = rec.rep_votes - rec.dem_votes;
    const margin_pct = two > 0 ? (margin / two) * 100 : 0;
    const winner = rec.rep_votes > rec.dem_votes ? "REP" : rec.dem_votes > rec.rep_votes ? "DEM" : "TIE";
    const color = winner === "REP" ? "R" : winner === "DEM" ? "D" : "T";
    grouped.get(k).push({
      county: rec.county,
      dem_votes: rec.dem_votes,
      rep_votes: rec.rep_votes,
      other_votes: rec.other_votes,
      total_votes: total,
      dem_candidate: topName(rec.dem_names),
      rep_candidate: topName(rec.rep_names),
      margin,
      margin_pct,
      winner,
      color,
    });
  }

  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : { files: [] };
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const replaceTypes = new Set([
    "president",
    "us_senate",
    "governor",
    "attorney_general",
    "secretary_of_state",
    "treasurer",
  ]);
  const producedKeys = new Set(grouped.keys());
  const keep = files.filter((e) => {
    const ct = String(e.contest_type || "");
    const y = Number(e.year);
    const k = `${ct}|${y}`;
    return !(replaceTypes.has(ct) && producedKeys.has(k));
  });

  const add = [];
  for (const [k, rows] of grouped.entries()) {
    const [contestType, yearStr] = k.split("|");
    const year = Number(yearStr);
    rows.sort((a, b) => a.county.localeCompare(b.county));
    const outFile = `${contestType}_${year}.json`;
    fs.writeFileSync(path.join(CONTESTS_DIR, outFile), JSON.stringify({ rows }), "utf8");
    add.push({
      year,
      contest_type: contestType,
      file: outFile,
      rows: rows.length,
      major_party_contested: true,
    });
  }

  const mergedMap = new Map();
  for (const e of [...keep, ...add]) {
    const k = `${e.contest_type}|${e.year}`;
    mergedMap.set(k, e);
  }
  const merged = Array.from(mergedMap.values()).sort((a, b) => {
    const ka = `${a.contest_type}|${a.year}`;
    const kb = `${b.contest_type}|${b.year}`;
    return ka.localeCompare(kb);
  });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ files: merged }), "utf8");
  console.log(`Wrote ${add.length} county contest files from precinct source.`);
}

function main() {
  const acc = build();
  emit(acc);
}

main();

