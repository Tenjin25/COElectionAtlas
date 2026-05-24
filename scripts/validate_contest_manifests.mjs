import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifests = [
  path.join(root, 'data', 'contests', 'manifest.json'),
  path.join(root, 'data', 'district_contests', 'manifest.json')
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateManifest(manifestPath) {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  const files = Array.isArray(parsed?.files) ? parsed.files : [];
  const baseDir = path.dirname(manifestPath);
  const missing = [];

  for (const entry of files) {
    const rel = String(entry?.file || '').trim();
    if (!rel) {
      missing.push({ file: '(empty file field)', contest: entry?.contest_type || 'unknown', year: entry?.year || 'unknown' });
      continue;
    }
    const full = path.join(baseDir, rel);
    if (!(await exists(full))) {
      missing.push({ file: rel, contest: entry?.contest_type || 'unknown', year: entry?.year || 'unknown' });
    }
  }

  return {
    manifestPath,
    total: files.length,
    missing
  };
}

async function main() {
  const results = [];
  for (const m of manifests) {
    if (await exists(m)) {
      results.push(await validateManifest(m));
    }
  }

  if (!results.length) {
    console.error('No manifest files found to validate.');
    process.exit(2);
  }

  let totalMissing = 0;
  for (const r of results) {
    totalMissing += r.missing.length;
    console.log(`Manifest: ${path.relative(root, r.manifestPath)} | entries=${r.total} | missing=${r.missing.length}`);
    for (const miss of r.missing.slice(0, 25)) {
      console.log(`  - ${miss.file} (${miss.contest}, ${miss.year})`);
    }
    if (r.missing.length > 25) {
      console.log(`  ... ${r.missing.length - 25} more`);
    }
  }

  if (totalMissing > 0) {
    console.error(`\nValidation failed: ${totalMissing} missing file(s).`);
    process.exit(1);
  }

  console.log('\nValidation passed: all manifest files resolved.');
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
