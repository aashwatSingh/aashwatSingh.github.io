import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32, zip } from '../js/zip.js';
import { EXT_VERSION, EXT_FILES, extensionZip, olderThan } from '../js/bridge.js';

const HQ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diskFetch = async (url) => {
  const file = path.join(HQ, new URL(url).pathname.replace(/^\/hq\//, ''));
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('missing', { status: 404 });
};

test('crc32 matches zlib', () => {
  const bytes = new TextEncoder().encode('Comet HQ ✓ '.repeat(100));
  assert.equal(crc32(bytes), zlib.crc32(bytes));
  assert.equal(crc32(new Uint8Array()), 0);
});

test('the manifest version is the one HQ expects, and every packaged file exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HQ, 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.version, EXT_VERSION);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.content_scripts[0].matches.includes('https://aashwatsingh.github.io/hq/*'));
  for (const [, src] of EXT_FILES) assert.ok(fs.existsSync(path.join(HQ, src)), src);
});

test('the background worker imports functions canvas.js really exports', async () => {
  const src = fs.readFileSync(path.join(HQ, 'extension/background.js'), 'utf8');
  const names = /import \{([^}]+)\} from '\.\/canvas\.js'/.exec(src)[1].split(',').map((s) => s.trim());
  const canvas = await import('../js/canvas.js');
  for (const n of names) assert.equal(typeof canvas[n], 'function', n);
});

test('the download is a valid zip with one folder', async () => {
  const bytes = await extensionZip('https://aashwatsingh.github.io/hq/', diskFetch);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hqzip-'));
  const file = path.join(tmp, 'ext.zip');
  fs.writeFileSync(file, bytes);
  let listed;
  try {
    listed = execFileSync('python3', ['-I', '-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', file], { encoding: 'utf8' });
  } catch (e) {
    if (e.code === 'ENOENT') return; // no Python here; the browser smoke test unpacks it too
    throw e;
  }
  assert.deepEqual(listed.trim().split('\n'), EXT_FILES.map(([name]) => `comet-hq-sync/${name}`));
});

test('zip of nothing is just the end record', () => {
  assert.equal(zip([]).length, 22);
});

test('olderThan compares dotted versions', () => {
  assert.equal(olderThan('1.0.0', '1.0.1'), true);
  assert.equal(olderThan('1.2', '1.10'), true);
  assert.equal(olderThan('2.0.0', '1.9.9'), false);
  assert.equal(olderThan('1.0.0', '1.0.0'), false);
});
