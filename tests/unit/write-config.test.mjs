// Unit tests of scripts/write-config.mjs (config.js of the published site from GitHub Actions repository variables).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeConfig, configFromEnv, renderConfig, VARIABLES, REPO_CONFIG } from '../../scripts/write-config.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/write-config.mjs', import.meta.url));
const CLIENT = '1234567890-abcdef.apps.googleusercontent.com';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs a config.js in a sandbox like the page does; returns window.SLIDESHOW_CONFIG and what else it touched. */
function runConfig(code) {
  const calls = [];
  const sandbox = { window: {}, alert: (...a) => calls.push(a), document: { write: (...a) => calls.push(a) } };
  vm.runInNewContext(code, sandbox);
  // (plain copy: objects from another vm realm have other prototypes)
  return { config: JSON.parse(JSON.stringify(sandbox.window.SLIDESHOW_CONFIG)), calls, keys: Object.keys(sandbox.window) };
}

const noVars = Object.fromEntries(Object.values(VARIABLES).map((n) => [n, '']));

test('write-config: no repository variables → the repository config.js is copied unchanged', (t) => {
  const out = path.join(tmpDir(t), 'site', 'config.js');
  assert.equal(writeConfig(out, { env: {} }), 'copied');
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(REPO_CONFIG));
  // unset variables arrive as empty strings from ${{ vars.X }}; whitespace counts as unset
  assert.equal(writeConfig(out, { env: { ...noVars, SLIDESHOW_TITLE: '   ' } }), 'copied');
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(REPO_CONFIG));
  // the repository config.js itself stays generic (no deployment values in the public repository)
  const repo = runConfig(fs.readFileSync(REPO_CONFIG, 'utf8')).config;
  assert.deepEqual(repo, { clientId: '', apiKey: '', folder: '', title: '', timeZone: '' });
});

test('write-config: variables are written as JSON data (no script injection) and read back exactly', (t) => {
  const out = path.join(tmpDir(t), 'config.js');
  const title = `旅行 "2025" '; alert(1); //</script><script>alert(2)</script>\\ \${x} end`;
  const folder = 'https://drive.google.com/drive/folders/1AbC_d-E?resourcekey=0-XyZ';
  const env = { SLIDESHOW_CLIENT_ID: ` ${CLIENT} `, SLIDESHOW_API_KEY: '', SLIDESHOW_FOLDER: folder, SLIDESHOW_TITLE: title, SLIDESHOW_TIME_ZONE: 'Europe/Paris' };
  assert.equal(writeConfig(out, { env }), 'generated');
  const code = fs.readFileSync(out, 'utf8');
  const { config, calls, keys } = runConfig(code);
  assert.deepEqual(config, { clientId: CLIENT, apiKey: '', folder, title, timeZone: 'Europe/Paris' });
  assert.deepEqual(calls, [], 'nothing in the values ran as code');
  assert.deepEqual(keys, ['SLIDESHOW_CONFIG']);
  assert.equal(code, renderConfig(config));
});

test('write-config: invalid values fail the build and write nothing', (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, 'config.js');
  const bad = [
    { SLIDESHOW_TIME_ZONE: 'Mars/Olympus' },
    { SLIDESHOW_TIME_ZONE: 'Europe/Paris"; alert(1); "' },
    { SLIDESHOW_CLIENT_ID: 'GOCSPX-this-is-a-client-secret' },
    { SLIDESHOW_CLIENT_ID: `${CLIENT}\nalert(1)` },
    { SLIDESHOW_API_KEY: 'AIza key with spaces' },
    { SLIDESHOW_TITLE: 'line1\nline2' },
    { SLIDESHOW_TITLE: 'line1\u2028line2' },
    { SLIDESHOW_TITLE: 'x'.repeat(121) },
    { SLIDESHOW_FOLDER: 'abc\u0000def' },
  ];
  for (const env of bad) {
    const { errors } = configFromEnv(env);
    assert.equal(errors.length, 1, JSON.stringify(env));
    assert.match(errors[0], new RegExp(`^${Object.keys(env)[0]}: `));
    assert.throws(() => writeConfig(out, { env }), /config\.js を作れません/);
    assert.equal(fs.existsSync(out), false);
  }
  // valid ones
  assert.deepEqual(configFromEnv({ SLIDESHOW_TIME_ZONE: 'Asia/Tokyo', SLIDESHOW_API_KEY: 'AIzaSyA-valid_key_123' }).errors, []);
});

test('write-config: command line (as run by .github/workflows/pages.yml)', (t) => {
  const dir = tmpDir(t);
  const out = path.join(dir, '_site', 'config.js');
  const run = (env) => spawnSync(process.execPath, [SCRIPT, out], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  let r = run({ SLIDESHOW_CLIENT_ID: CLIENT, SLIDESHOW_FOLDER: 'FOLDERID' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SLIDESHOW_CLIENT_ID, SLIDESHOW_FOLDER/);
  assert.doesNotMatch(r.stdout, /FOLDERID|apps\.googleusercontent/, 'values are not printed');
  assert.equal(runConfig(fs.readFileSync(out, 'utf8')).config.clientId, CLIENT);
  r = run({});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(REPO_CONFIG));
  fs.rmSync(out);
  r = run({ SLIDESHOW_TIME_ZONE: 'Nowhere/Land' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLIDESHOW_TIME_ZONE/);
  assert.equal(fs.existsSync(out), false);
  r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'the output path is required');
});
