import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'leonida-psn-test-'));
const mode = process.argv[2] || 'success';
const requests = [];
let output;
const stdout = process.stdout.write;
process.argv[2] = root;
process.stdout.write = chunk => { output = JSON.parse(chunk); };
const json = value => Response.json(value);
const rows = [{trophyId: 13, progress: '17'}];

await writeFile(join(root, 'psn-bootstrap'), 'test-fixture-'.repeat(4), {mode: 0o600});
if (mode === 'refresh') {
  await rm(join(root, 'psn-bootstrap'));
  await writeFile(join(root, 'psn-tokens.json'), JSON.stringify({
    accessToken: 'expired-fixture', accessExpires: 0, refreshToken: 'refresh-fixture',
  }), {mode: 0o600});
}
globalThis.fetch = async (address, options) => {
  const url = new URL(address);
  requests.push(url.pathname);
  if (url.pathname.endsWith('/authorize')) {
    if (mode === 'auth') return new Response(null, {status: 401});
    if (mode === 'limit') return new Response(null, {status: 429, headers: {'Retry-After': '2400'}});
    return new Response(null, {status: 302,
      headers: {Location: 'com.scee.psxandroid.scecompcall://redirect/?code=fixture'}});
  }
  if (url.pathname.endsWith('/token')) {
    assert.equal(new URLSearchParams(options.body).get('grant_type'),
      mode === 'refresh' ? 'refresh_token' : 'authorization_code');
    return json({access_token: 'access-fixture', refresh_token: 'refresh-fixture',
      expires_in: 3600, refresh_token_expires_in: 86400});
  }
  assert.equal(options.headers.Authorization, 'Bearer access-fixture');
  if (url.pathname.endsWith('/titles/trophyTitles')) {
    return json({titles: [{npTitleId: 'PPSA01547_00', trophyTitles: [{
      npCommunicationId: 'NPWR21085_00', npServiceName: 'trophy2',
      definedTrophies: {bronze: 1, silver: 0, gold: 0, platinum: 0},
      earnedTrophies: {bronze: 0, silver: 0, gold: 0, platinum: 0},
    }]}]});
  }
  if (url.pathname.endsWith('/trophyGroups/all/trophies')) {
    assert.equal(url.searchParams.get('npServiceName'), 'trophy2');
    return json({trophies: rows, totalItemCount: 1});
  }
  if (url.pathname.endsWith('/me/titles')) {
    if (mode === 'partial') return new Response(null, {status: 503});
    return json({titles: [{titleId: 'PPSA01547_00', playDuration: 'PT19H5M3S', storyProgress: 0}]});
  }
  throw new Error('Unexpected request path');
};
try {
  await import('./psn_worker.mjs');
  if (mode === 'limit') {
    assert.equal(output.error, 'rate_limited');
    assert.equal(output.retryAfter, 2400);
    assert.equal(requests.length, 1);
  } else if (mode === 'auth') {
    assert.equal(output.error, 'auth_expired');
  } else {
    assert.equal(output.titleId, 'PPSA01547_00');
    assert.equal(output.communicationId, 'NPWR21085_00');
    assert.equal(output.playSeconds, mode === 'partial' ? null : 68703);
    assert.deepEqual(output.earnedRows, rows);
    assert.equal(requests.length, mode === 'refresh' ? 5 : 6);
    await assert.rejects(stat(join(root, 'psn-bootstrap')), {code: 'ENOENT'});
    assert.equal(JSON.parse(await readFile(join(root, 'psn-tokens.json'), 'utf8')).refreshToken, 'refresh-fixture');
  }
} finally {
  process.stdout.write = stdout;
  await rm(root, {recursive: true, force: true});
}
console.log('PSN worker fixture passed: ' + mode);
