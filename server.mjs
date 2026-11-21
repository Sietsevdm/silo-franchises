import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, gallery, normalize, providers } from './providers.mjs';
import { matchMembers, siloClient } from './silo.mjs';

const env = process.env;
if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16) throw new Error('Set APP_PASSWORD to at least 16 characters.');
const username = env.APP_USER || 'admin';
const digest = (value) => createHash('sha256').update(value).digest();
const auth = digest(`${username}:${env.APP_PASSWORD}`);
const source = providers(env.TMDB_READ_TOKEN);
const silo = siloClient(env.SILO_URL || 'https://thevault.box74.appboxmanager.xyz', env.SILO_API_KEY);
const publicCollection = (item) => ({
  id: item.id, title: item.title, description: item.description ?? '', sourceUrl: item.source_url,
  libraryIds: item.library_ids?.length ? item.library_ids : [item.library_id].filter(Boolean),
  count: item.item_count, kind: item.collection_type,
});
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'], ['/movies', 'index.html', 'text/html'], ['/tv', 'index.html', 'text/html'], ['/style.css', 'style.css', 'text/css'], ['/app.js', 'app.js', 'text/javascript'],
].map(async ([path, name, mime]) => [path, { body: await readFile(new URL('./public/' + name, import.meta.url)), mime }])));

function send(res, status, value, mime = 'application/json') {
  res.writeHead(status, { 'Content-Type': mime + '; charset=utf-8' });
  res.end(mime === 'application/json' ? JSON.stringify(value) : value);
}

function key(provider, id, kind) {
  if (typeof id === 'string' && ((provider === 'tmdb' && kind === 'movie' && /^\d{1,12}$/.test(id)) ||
    (provider === 'tvdb' && ['movie', 'series'].includes(kind) && /^[a-z0-9-]{1,140}$/.test(id)))) {
    return `${provider}:${id}:${kind}`;
  }
  throw new AppError(400, 'Choose a valid franchise.');
}

function page(query) {
  const number = Number(query.get('page') || 1);
  if (!Number.isInteger(number) || number < 1 || number > 500) throw new AppError(400, 'Invalid page.');
  return number;
}

function collectionId(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,120}$/.test(id)) throw new AppError(400, 'Invalid Silo collection ID.');
  return id;
}

function filter(items, query, number, size) {
  const normalized = normalize(query);
  const terms = normalized.split(' ').filter(Boolean);
  const hits = items.filter((item) => {
    const title = normalize(item.title);
    return terms.every((term) => title.includes(term));
  });
  if (normalized) hits.sort((a, b) => Number(!normalize(a.title).startsWith(normalized)) -
    Number(!normalize(b.title).startsWith(normalized)));
  return { items: hits.slice((number - 1) * size, number * size), more: hits.length > number * size, total: hits.length };
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['x-franchise-app'] !== '1' ||
    req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(415, 'Use the app to submit JSON requests.');
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 32_768) throw new AppError(413, 'Request too large.');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(400, 'Invalid request body.');
  }
}

async function preview(data) {
  const id = key(data.provider, data.id, data.kind);
  const libraryIds = [...new Set(Array.isArray(data.libraryIds) ? data.libraryIds : [])];
  if (!libraryIds.length || libraryIds.length > 20 || libraryIds.some((id) => typeof id !== 'string' || !id || id.length > 100)) {
    throw new AppError(400, 'Select one or more Silo libraries.');
  }
  const [detail, libraries] = await Promise.all([source.details(id), silo.libraries()]);
  const libraryType = data.kind === 'movie' ? 'movies' : 'series';
  if (libraryIds.some((id) => !libraries.some((library) => library.id === id && [libraryType, 'mixed'].includes(library.type)))) {
    throw new AppError(400, 'A selected Silo library is unavailable for this media type.');
  }
  return { detail, libraryIds, matches: matchMembers(detail.members, await silo.catalog(libraryIds, data.kind)) };
}

async function browseTVDb(query, cursor, kind) {
  const candidates = filter(await source.tvIndex(), query, 1, Number.MAX_SAFE_INTEGER).items;
  const size = 12;
  const matches = [];
  let next = cursor;
  const end = Math.min(candidates.length, cursor + 50);
  while (next < end && matches.length < size) {
    const batch = await Promise.all(candidates.slice(next, Math.min(end, next + 5)).map(async (item) => {
      try {
        const list = await source.tvList(item.id);
        return list.items.some((member) => member.type === kind) ? item : null;
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }));
    for (const item of batch) {
      next++;
      if (item) matches.push(item);
      if (matches.length === size) break;
    }
  }
  return { items: matches, more: next < candidates.length, next };
}

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://images.theposterdb.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
    const provided = req.headers.authorization?.match(/^Basic (\S+)$/i)?.[1] ?? '';
    if (!timingSafeEqual(digest(Buffer.from(provided, 'base64')), auth)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Silo Franchises", charset="UTF-8"');
      return send(res, 401, { error: 'Sign in with the app credentials.' });
    }
    const input = url.searchParams;
    const path = url.pathname;
    if (req.method === 'GET') {
      if (assets.has(path)) {
        const asset = assets.get(path);
        return send(res, 200, asset.body, asset.mime);
      }
      if (path === '/api/libraries') return send(res, 200, (await silo.libraries()).map(({ id, name, type }) => ({ id, name, type })));
      if (path === '/api/collections') return send(res, 200, (await silo.collections()).map(publicCollection));
      if (path === '/api/collection') {
        const { value, etag } = await silo.getCollection(collectionId(input.get('id')));
        return send(res, 200, { ...publicCollection(value), etag });
      }
      if (path === '/api/franchises') {
        const query = (input.get('q') ?? '').slice(0, 150);
        const provider = input.get('provider');
        const kind = input.get('kind');
        const number = page(input);
        const cursor = Number(input.get('cursor') || 0);
        if (provider === 'tvdb' && ['movie', 'series'].includes(kind) && Number.isSafeInteger(cursor) && cursor >= 0) {
          return send(res, 200, await browseTVDb(query, cursor, kind));
        }
        if (provider !== 'tmdb' || kind !== 'movie') throw new AppError(400, 'Choose a source for this media type.');
        return send(res, 200, filter(await source.movieIndex(), query, number, 48));
      }
      if (path === '/api/detail') return send(res, 200, await source.details(key(input.get('provider'), input.get('id'), input.get('kind'))));
      if (path === '/api/posters') {
        const number = page(input);
        const query = (input.get('q') ?? '').slice(0, 150).trim();
        const result = query ? filter(await source.posterIndex(), query, number, 24) : await source.galleryPage(number);
        return send(res, 200, { ...result, gallery });
      }
    }
    if (req.method === 'POST' && path === '/api/preview') {
      const { matches } = await preview(await body(req));
      return send(res, 200, matches.map(({ match, title, type, year, basis }) => ({
        title, type, year, basis, contentId: match?.content_id, localTitle: match?.title,
      })));
    }
    if (req.method === 'POST' && path === '/api/edit') {
      const data = await body(req);
      const id = collectionId(data.id);
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (!title || title.length > 150 || typeof data.description !== 'string' || data.description.length > 8000 ||
        typeof data.etag !== 'string' || !data.etag || data.etag === '*') {
        throw new AppError(400, 'Open the collection and enter a valid title and description.');
      }
      let poster;
      if (data.posterId != null) {
        if (typeof data.posterId !== 'string' || !/^\d{1,15}$/.test(data.posterId)) throw new AppError(400, 'Invalid poster.');
        poster = await source.posterById(data.posterId);
        if (!poster) throw new AppError(404, 'That poster is unavailable in the RedHeadJedi gallery.');
      }
      const updated = await silo.updateCollection({ id, title, description: data.description, poster, etag: data.etag });
      return send(res, 200, publicCollection(updated));
    }
    if (req.method === 'POST' && path === '/api/import') {
      const data = await body(req);
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (!title || title.length > 150 || !Array.isArray(data.contentIds) || !data.contentIds.length ||
        data.contentIds.length > 1000 || data.contentIds.some((id) => typeof id !== 'string') ||
        typeof data.posterId !== 'string' || !/^\d{1,15}$/.test(data.posterId)) {
        throw new AppError(400, 'Choose a title, a poster, and at least one matched library item.');
      }
      const { detail, libraryIds, matches } = await preview(data);
      const permitted = new Map(matches.filter((m) => m.match).map((m) => [m.match.content_id, m.match]));
      const members = [...new Set(data.contentIds)].map((id) => permitted.get(id));
      if (members.some((m) => !m)) throw new AppError(409, 'Library matches changed. Preview again before importing.');
      const poster = await source.posterById(data.posterId);
      if (!poster) throw new AppError(404, 'That poster is unavailable in the RedHeadJedi gallery.');
      return send(res, 201, await silo.publish({ detail, title, libraryIds, members, poster }));
    }
    return send(res, 404, { error: 'Page not found.' });
  } catch (error) {
    const handled = error instanceof AppError;
    if (!handled) console.error('Request could not be completed:', error.name);
    if (handled && error.status === 429 && /^\d+$/.test(error.retryAfter ?? '')) res.setHeader('Retry-After', error.retryAfter);
    if (!res.headersSent) send(res, handled ? error.status : 502, { error: handled ? error.message : 'The request could not be completed.' });
  }
}).listen(Number(env.PORT || 8080), '0.0.0.0', () => console.log('Silo Franchises is ready.'));
