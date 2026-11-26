import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exchangeNpssoForAccessCode, exchangeAccessCodeForAuthTokens, exchangeRefreshTokenForAuthTokens,
  getUserTrophiesForSpecificTitle, getUserTrophiesEarnedForTitle, getTitleTrophies, getUserPlayedGames,
} from 'psn-api';

const titleId = 'PPSA01547_00';
const communicationId = 'NPWR21085_00';
const npServiceName = 'trophy2';
const state = process.argv[2];
const nativeFetch = globalThis.fetch;

function fail(kind, retryAfter = 0) {
  return Object.assign(new Error(kind), {kind, retryAfter});
}

function cooldown(headers) {
  const retry = headers.get('retry-after');
  const next = Number(headers.get('x-ratelimit-next-available'));
  const timestamp = Date.now() / 1000;
  const retrySeconds = retry && /^\d+$/.test(retry) ? Number(retry) : Date.parse(retry) / 1000 - timestamp;
  return Math.ceil(Math.max(0, retrySeconds || 0, next - timestamp));
}

globalThis.fetch = async (url, init) => {
  const response = await nativeFetch(url, {...init, signal: AbortSignal.timeout(10000)});
  if (response.ok || (init?.redirect === 'manual' && response.status === 302)) return response;
  if (response.status === 429) throw fail('rate_limited', cooldown(response.headers));
  if ([401, 403].includes(response.status) || (response.status === 400 && String(url).endsWith('/token'))) {
    throw fail('auth_expired');
  }
  throw fail('temporary_error');
};

async function secret(path) {
  try {
    const details = await stat(path);
    if (!details.isFile() || (details.mode & 0o077) !== 0) throw fail('temporary_error');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function authorize(forceRefresh = false) {
  const cache = join(state, 'psn-tokens.json');
  const bootstrap = join(state, 'psn-bootstrap');
  const npsso = await secret(bootstrap);
  const prior = JSON.parse(await secret(cache) || 'null');
  if (!npsso && !forceRefresh && prior?.accessToken && prior.accessExpires > Date.now() + 60_000) {
    return {accessToken: prior.accessToken};
  }
  let pair;
  if (npsso) {
    if (!/^[a-zA-Z0-9._~-]{32,256}$/.test(npsso.trim())) throw fail('auth_expired');
    let code;
    try {
      code = await exchangeNpssoForAccessCode(npsso.trim());
    } catch (error) {
      if (error.kind || !error.message.includes('retrieving your PSN access code')) throw error;
      throw fail('auth_expired');
    }
    if (!code) throw fail('auth_expired');
    pair = await exchangeAccessCodeForAuthTokens(code);
  } else {
    if (!prior?.refreshToken || (prior.refreshExpires && prior.refreshExpires <= Date.now())) throw fail('auth_expired');
    pair = await exchangeRefreshTokenForAuthTokens(prior.refreshToken);
  }
  const refreshToken = pair.refreshToken || (!npsso && prior?.refreshToken);
  if (!pair.accessToken || !refreshToken || !Number.isFinite(pair.expiresIn)) throw fail('auth_expired');
  const tokens = {
    accessToken: pair.accessToken, refreshToken,
    accessExpires: Date.now() + pair.expiresIn * 1000,
    refreshExpires: Number.isFinite(pair.refreshTokenExpiresIn)
      ? Date.now() + pair.refreshTokenExpiresIn * 1000 : prior?.refreshExpires,
  };
  const temporary = cache + '.pending';
  await writeFile(temporary, JSON.stringify(tokens), {mode: 0o600, flag: 'w'});
  await rename(temporary, cache);
  if (npsso && await secret(bootstrap) === npsso) await unlink(bootstrap);
  return {accessToken: tokens.accessToken};
}

function count(summary) {
  const values = ['bronze', 'silver', 'gold', 'platinum'].map(type => summary?.[type]);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) throw fail('temporary_error');
  return values.reduce((sum, value) => sum + value, 0);
}

function duration(value) {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) return null;
  return [86400, 3600, 60, 1].reduce((sum, scale, i) => sum + scale * Number(match[i + 1] || 0), 0);
}

async function collection(call) {
  const rows = [];
  let offset = 0;
  for (let page = 0; page < 3; page++) {
    const result = await call({npServiceName, limit: 100, offset});
    if (!Array.isArray(result.trophies)) throw fail('temporary_error');
    rows.push(...result.trophies);
    if (result.nextOffset == null) {
      if (rows.length !== result.totalItemCount) throw fail('temporary_error');
      return rows;
    }
    if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset) throw fail('temporary_error');
    offset = result.nextOffset;
  }
  throw fail('temporary_error');
}

async function fetchProgress(auth) {
  const summary = await getUserTrophiesForSpecificTitle(auth, 'me', {npTitleIds: titleId});
  const title = summary.titles?.find(item => item.npTitleId === titleId)?.trophyTitles?.find(
    item => item.npCommunicationId === communicationId && item.npServiceName === npServiceName,
  );
  if (!title) throw fail('temporary_error');
  const earnedRows = await collection(options => getUserTrophiesEarnedForTitle(auth, 'me', communicationId, 'all', options));
  const definitions = await collection(options => getTitleTrophies(auth, communicationId, 'all', options));
  let playSeconds = null;
  let retryAfter = 0;
  try {
    const played = await getUserPlayedGames(auth, 'me', {limit: 25, categories: 'ps5_native_game'});
    playSeconds = duration(played.titles?.find(item => item.titleId === titleId)?.playDuration);
  } catch (error) {
    // Playtime is independent. Keep the last value if this optional request fails.
    if (error.kind === 'rate_limited') retryAfter = Math.max(error.retryAfter, 1800);
  }
  return {titleId, communicationId, earnedRows, definitions, playSeconds, retryAfter,
    earnedCount: count(title.earnedTrophies), total: count(title.definedTrophies)};
}

try {
  const auth = await authorize();
  let response;
  try {
    response = await fetchProgress(auth);
  } catch (error) {
    if (error.kind !== 'auth_expired') throw error;
    response = await fetchProgress(await authorize(true));
  }
  process.stdout.write(JSON.stringify(response));
} catch (error) {
  process.stdout.write(JSON.stringify({error: error.kind || 'temporary_error', retryAfter: error.retryAfter}));
}
