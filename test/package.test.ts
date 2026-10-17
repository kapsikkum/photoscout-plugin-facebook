import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
const zipPath = path.join(ROOT, 'dist', `${manifest.id}-${manifest.version}.zip`);

test('buildPlugin bundles server and web halves and emits expected zip', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(zipPath), 'zip file exists');

  const zipBytes = fs.readFileSync(zipPath);
  const entries = Object.keys(unzipSync(zipBytes)).sort();
  assert.deepEqual(entries, ['plugin.json', 'server.js', 'web.js']);
});
