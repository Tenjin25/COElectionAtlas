#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "data", "district_contests");
const MANIFEST = path.join(DIR, "manifest.json");

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validateFile(entry) {
  const problems = [];
  const filePath = path.join(DIR, entry.file);
  if (!fs.existsSync(filePath)) {
    problems.push(`missing file: ${entry.file}`);
    return problems;
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    problems.push(`invalid json: ${entry.file} (${e.message})`);
    return problems;
  }
  const results = payload?.general?.results;
  if (!results || typeof results !== "object") {
    problems.push(`missing general.results: ${entry.file}`);
    return problems;
  }
  const keys = Object.keys(results);
  if (keys.length !== Number(entry.rows)) {
    problems.push(`row mismatch ${entry.file}: manifest=${entry.rows} actual=${keys.length}`);
  }
  for (const k of keys) {
    const r = results[k] || {};
    const dem = num(r.dem_votes);
    const rep = num(r.rep_votes);
    const other = num(r.other_votes);
    const total = num(r.total_votes);
    if (![dem, rep, other, total].every(Number.isFinite)) {
      problems.push(`${entry.file} district ${k}: non-numeric votes`);
      continue;
    }
    const recomputed = dem + rep + other;
    if (Math.abs(recomputed - total) > 0.5) {
      problems.push(
        `${entry.file} district ${k}: totals mismatch dem+rep+other=${recomputed.toFixed(3)} total=${total.toFixed(3)}`
      );
    }
    if (dem < 0 || rep < 0 || other < 0 || total < 0) {
      problems.push(`${entry.file} district ${k}: negative votes`);
    }
    const demCand = String(r.dem_candidate || "").trim();
    const repCand = String(r.rep_candidate || "").trim();
    if (dem > 0 && !demCand) problems.push(`${entry.file} district ${k}: missing dem_candidate with dem_votes>0`);
    if (rep > 0 && !repCand) problems.push(`${entry.file} district ${k}: missing rep_candidate with rep_votes>0`);
  }
  return problems;
}

function main() {
  if (!fs.existsSync(MANIFEST)) {
    fail(`manifest missing: ${MANIFEST}`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    fail(`invalid manifest json: ${e.message}`);
    return;
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) {
    fail("manifest has no files");
    return;
  }
  const seen = new Set();
  const allProblems = [];
  for (const entry of files) {
    const key = `${entry.scope}|${entry.contest_type}|${entry.year}`;
    if (seen.has(key)) allProblems.push(`duplicate manifest key: ${key}`);
    seen.add(key);
    if (!entry.file) {
      allProblems.push(`manifest entry missing file for ${key}`);
      continue;
    }
    allProblems.push(...validateFile(entry));
  }
  if (allProblems.length) {
    for (const p of allProblems) fail(`- ${p}`);
    fail(`validation failed: ${allProblems.length} issue(s)`);
  } else {
    console.log(`OK: validated ${files.length} district contest files`);
  }
}

main();

