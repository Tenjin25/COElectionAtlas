#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "data", "contests");
const MANIFEST = path.join(DIR, "manifest.json");

function issue(list, msg) {
  list.push(msg);
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validateContestFile(entry) {
  const errs = [];
  const filePath = path.join(DIR, entry.file);
  if (!fs.existsSync(filePath)) {
    issue(errs, `missing file: ${entry.file}`);
    return errs;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    issue(errs, `invalid json: ${entry.file} (${e.message})`);
    return errs;
  }
  const rows = Array.isArray(payload?.rows) ? payload.rows : null;
  if (!rows) {
    issue(errs, `missing rows array: ${entry.file}`);
    return errs;
  }
  if (rows.length !== Number(entry.rows)) {
    issue(errs, `row mismatch ${entry.file}: manifest=${entry.rows} actual=${rows.length}`);
  }

  const seenCounty = new Set();
  for (const r of rows) {
    const county = String(r.county || "").trim();
    if (!county) {
      issue(errs, `${entry.file}: blank county`);
      continue;
    }
    const key = county.toUpperCase();
    if (seenCounty.has(key)) issue(errs, `${entry.file}: duplicate county ${county}`);
    seenCounty.add(key);

    const dem = asNum(r.dem_votes);
    const rep = asNum(r.rep_votes);
    const other = asNum(r.other_votes);
    const total = asNum(r.total_votes);
    if (![dem, rep, other, total].every(Number.isFinite)) {
      issue(errs, `${entry.file} ${county}: non-numeric vote field`);
      continue;
    }
    if (dem < 0 || rep < 0 || other < 0 || total < 0) {
      issue(errs, `${entry.file} ${county}: negative votes`);
    }
    const recomputed = dem + rep + other;
    if (Math.abs(recomputed - total) > 0.5) {
      issue(
        errs,
        `${entry.file} ${county}: totals mismatch dem+rep+other=${recomputed.toFixed(3)} total=${total.toFixed(3)}`
      );
    }
    const demCand = String(r.dem_candidate || "").trim();
    const repCand = String(r.rep_candidate || "").trim();
    if (dem > 0 && !demCand) issue(errs, `${entry.file} ${county}: missing dem_candidate with dem_votes>0`);
    if (rep > 0 && !repCand) issue(errs, `${entry.file} ${county}: missing rep_candidate with rep_votes>0`);
  }
  return errs;
}

function main() {
  const allErrs = [];
  if (!fs.existsSync(MANIFEST)) {
    console.error(`manifest missing: ${MANIFEST}`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`invalid manifest json: ${e.message}`);
    process.exit(1);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) {
    console.error("manifest has no files");
    process.exit(1);
  }
  const seen = new Set();
  for (const e of files) {
    const key = `${e.contest_type}|${e.year}`;
    if (seen.has(key)) issue(allErrs, `duplicate manifest key: ${key}`);
    seen.add(key);
    if (!e.file) {
      issue(allErrs, `manifest entry missing file for ${key}`);
      continue;
    }
    allErrs.push(...validateContestFile(e));
  }

  if (allErrs.length) {
    for (const e of allErrs) console.error(`- ${e}`);
    console.error(`validation failed: ${allErrs.length} issue(s)`);
    process.exit(1);
  }
  console.log(`OK: validated ${files.length} county contest files`);
}

main();

