import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { allowedFranchiseTitle, AppError, galleryUrl, normalize, posterSources, providers } from './providers.mjs';
import { eligibleCollection, imageType, matchMembers, previewKind, siloClient } from './silo.mjs';
import { downloadPublicArtwork, publicArtworkUrl } from './remote-artwork.mjs';
import { posterCache } from './poster-cache.mjs';

const env = process.env;
if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16) throw new Error('Set APP_PASSWORD to at least 16 characters.');
const username = env.APP_USER || 'admin';
const digest = (value) => createHash('sha256').update(value).digest();
const auth = digest(`${username}:${env.APP_PASSWORD}`);
const source = providers(env.TMDB_READ_TOKEN);
const posterIndex = await posterCache(posterSources, source.posterIndex, env.POSTER_INDEX_DIR);
void posterIndex.refresh();
setInterval(() => void posterIndex.refresh(), 30 * 60 * 1000).unref();
const silo = siloClient(env.SILO_URL || 'https://thevault.box74.appboxmanager.xyz', env.SILO_API_KEY);
const publicCollection = (item) => ({
  id: item.id, title: item.title, description: item.description ?? '', sourceUrl: item.source_url,
  libraryIds: item.library_ids?.length ? item.library_ids : [item.library_id].filter(Boolean),
  count: item.item_count, kind: item.collection_type,
  titleSort: item.sort_config?.field === 'title' && item.sort_config?.order === 'asc',
  browseable: allowedFranchiseTitle(item.title),
  hasPoster: Boolean(item.poster_url && !item.poster_is_collage),
  hasBackdrop: Boolean(item.backdrop_url),
  syncStatus: item.last_sync_status,
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

const titles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function filter(items, query, number, size, sort) {
  const normalized = normalize(query);
  const terms = normalized.split(' ').filter(Boolean);
  const hits = items.filter((item) => {
    const title = normalize(item.title);
    return terms.every((term) => title.includes(term));
  });
  if (sort === 'title-asc' || sort === 'title-desc') {
    const direction = sort === 'title-asc' ? 1 : -1;
    hits.sort((a, b) => direction * titles.compare(a.title, b.title));
  } else if (sort === 'popular') {
    hits.sort((a, b) => b.stars - a.stars || titles.compare(a.title, b.title));
  } else if (normalized) hits.sort((a, b) => Number(!normalize(a.title).startsWith(normalized)) -
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
  const libraries = await silo.libraries();
  if (libraryIds.some((id) => !libraries.some((library) => library.id === id && previewKind(library) === data.kind))) {
    throw new AppError(400, 'A selected Silo library is unavailable for this media type.');
  }
  const [detail, catalog] = await Promise.all([source.details(id), silo.catalog(libraryIds, data.kind)]);
  const libraryNames = new Map(libraries.map(({ id, name }) => [id, name]));
  const overrides = data.overrides ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > detail.members.length ||
    Object.keys(overrides).some((index) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= detail.members.length)) {
    throw new AppError(400, 'Invalid manual matches.');
  }
  if (data.sync === true && Object.keys(overrides).length) throw new AppError(400, 'Manual matches require a manual collection.');
  const byId = new Map(catalog.map((item) => [item.content_id, item]));
  const matches = matchMembers(detail.members, catalog).map((item, index) => {
    if (!Object.hasOwn(overrides, index)) return item;
    const match = byId.get(overrides[index]);
    if (!match) throw new AppError(409, 'A manually matched title is no longer in the selected libraries.');
    return { ...item, match, basis: 'Manual match', libraryIds: match.previewLibraryIds };
  });
  return { detail, libraryIds, libraryNames, matches, catalog };
}

function posterUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new AppError(400, 'Enter a direct public HTTPS poster URL.');
  return publicArtworkUrl(value.trim()).href;
}

async function selectedPoster(data, required = false) {
  if (data.posterUrl != null) {
    if (data.posterId != null) throw new AppError(400, 'Choose either a gallery poster or a poster URL.');
    return { image: posterUrl(data.posterUrl), custom: true };
  }
  if (data.posterId != null) {
    if (typeof data.posterId !== 'string' || !/^\d{1,15}$/.test(data.posterId)) throw new AppError(400, 'Invalid poster.');
    if (!posterSources.includes(data.posterCreator)) throw new AppError(400, 'Choose a configured poster source.');
    const poster = posterIndex.get(data.posterCreator)?.find((item) => item.id === data.posterId)
      ?? await source.posterById(data.posterId, data.posterCreator);
    if (!poster) throw new AppError(404, 'That poster is unavailable in the selected ThePosterDB gallery.');
    return poster;
  }
  if (required) throw new AppError(400, 'Choose a poster or enter a poster URL.');
}

async function selectedBackdrop(data) {
  if (data.kind === 'series' && data.backdropUrl != null) {
    if (typeof data.backdropUrl !== 'string' || data.backdropUrl.length > 2048) throw new AppError(400, 'Enter a direct public HTTPS image URL.');
    if (data.backdropUrl.trim()) return { backdrop: publicArtworkUrl(data.backdropUrl.trim()).href, customBackdrop: true };
  }
  if (data.kind === 'movie' && data.backdropPath != null) {
    if (typeof data.backdropPath !== 'string') throw new AppError(400, 'Choose a backdrop from this franchise.');
    const franchise = key(data.provider, data.id, data.kind);
    const option = (await source.backdrops(franchise)).items.find((item) => item.path === data.backdropPath);
    if (!option) throw new AppError(400, 'Choose a backdrop from this franchise.');
    return { backdrop: option.image };
  }
  return {};
}

async function browseTVDb(query, cursor, kind, sort) {
  const candidates = filter((await source.tvIndex()).filter((item) => allowedFranchiseTitle(item.title)),
    query, 1, Number.MAX_SAFE_INTEGER, sort).items;
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: https://images.theposterdb.com https://image.tmdb.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
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
      if (path === '/api/libraries') return send(res, 200, (await silo.libraries())
        .map((library) => ({ id: library.id, name: library.name, type: library.type, previewKind: previewKind(library) })));
      if (path === '/api/collections') return send(res, 200, (await silo.collections()).map(publicCollection));
      if (path === '/api/collection') {
        const { value, etag } = await silo.getCollection(collectionId(input.get('id')));
        return send(res, 200, { ...publicCollection(value), etag });
      }
      if (path === '/api/collection-health') {
        const id = collectionId(input.get('id'));
        const kind = input.get('kind');
        const { value } = await silo.getCollection(id);
        const collection = publicCollection(value);
        const sourceUrl = collection.sourceUrl ?? '';
        const movie = sourceUrl.match(/^(?:tmdb:\/\/collection\/|https:\/\/(?:www\.)?themoviedb\.org\/collection\/)(\d+)(?:-[\w-]+)?\/?$/);
        const tvdb = sourceUrl.match(/^https:\/\/(?:www\.)?thetvdb\.com\/lists\/([a-z0-9-]+)\/?$/);
        const libraryIds = (await silo.libraries()).filter((lib) =>
          collection.libraryIds.includes(lib.id) && previewKind(lib) === kind).map((lib) => lib.id);
        if (collection.kind !== 'manual' || (!movie && !tvdb) || (movie && kind !== 'movie') || !libraryIds.length) {
          return send(res, 200, { checked: false, reason: 'Membership check requires a manual collection with a linked franchise and an eligible library.' });
        }
        const { matches } = await preview({ kind, libraryIds, provider: movie ? 'tmdb' : 'tvdb', id: (movie ?? tvdb)[1] });
        const members = await silo.collectionMemberIds(id);
        const title = (item) => item.title + (item.year ? ' (' + item.year + ')' : '');
        return send(res, 200, { checked: true,
          missing: matches.filter((item) => !item.match && item.basis === 'Missing').map(title),
          ambiguous: matches.filter((item) => !item.match && item.basis !== 'Missing').map(title),
          available: matches.filter((item) => item.match && !members.has(item.match.content_id)).map(title),
        });
      }
      if (path === '/api/franchises') {
        const query = (input.get('q') ?? '').slice(0, 150);
        const provider = input.get('provider');
        const kind = input.get('kind');
        const sort = input.get('sort');
        const number = page(input);
        const cursor = Number(input.get('cursor') || 0);
        if (provider === 'tvdb' && ['movie', 'series'].includes(kind) && Number.isSafeInteger(cursor) && cursor >= 0) {
          return send(res, 200, await browseTVDb(query, cursor, kind, sort));
        }
        if (provider !== 'tmdb' || kind !== 'movie') throw new AppError(400, 'Choose a source for this media type.');
        return send(res, 200, filter((await source.movieIndex()).filter((item) => allowedFranchiseTitle(item.title)),
          query, number, 48, sort === 'popular' ? null : sort));
      }
      if (path === '/api/detail') return send(res, 200, await source.details(key(input.get('provider'), input.get('id'), input.get('kind'))));
      if (path === '/api/metadata') return send(res, 200, await source.metadata(key(input.get('provider'), input.get('id'), input.get('kind'))));
      if (path === '/api/backdrops') {
        if (input.get('kind') !== 'movie') throw new AppError(400, 'TMDb backdrop choices are available for movie franchises.');
        return send(res, 200, await source.backdrops(key(input.get('provider'), input.get('id'), 'movie')));
      }
      if (path === '/api/posters') {
        const number = page(input);
        const query = (input.get('q') ?? '').slice(0, 150).trim();
        const creator = input.get('creator') || 'all';
        if (creator !== 'all' && !posterSources.includes(creator)) throw new AppError(400, 'Choose a configured poster source.');
        const creators = creator === 'all' ? posterSources : [creator];
        const indexed = creators.map((name) => posterIndex.get(name));
        if (input.get('mode') !== 'live' && indexed.every(Boolean)) {
          const items = [...new Map(indexed.flat().map((item) => [item.id, item])).values()];
          res.setHeader('Cache-Control', 'private, max-age=120');
          return send(res, 200, { ...filter(items, query, number, 24), mode: 'index',
            gallery: creator === 'all' ? null : galleryUrl(creator) });
        }
        const full = input.get('full') === '1';
        const results = await Promise.allSettled(creators.map(async (name) =>
          query && full ? { items: await source.posterIndex(name) } : source.galleryPage(name, number)));
        const available = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
        if (!available.length) throw results[0].reason;
        const items = [...new Map(available.flatMap((result) => result.items).map((item) => [item.id, item])).values()];
        const more = available.some((item) => item.more);
        const result = query ? filter(items, query, full ? number : 1, full ? 24 : items.length) : { items, more };
        if (!full) result.more = more;
        const unavailable = creators.filter((_, index) => results[index].status === 'rejected');
        if (!unavailable.length) res.setHeader('Cache-Control', 'private, max-age=120');
        return send(res, 200, { ...result, unavailable, mode: 'live', gallery: creator === 'all' ? null : galleryUrl(creator) });
      }
    }
    if (req.method === 'POST' && path === '/api/preview') {
      const { matches, libraryIds, libraryNames } = await preview(await body(req));
      return send(res, 200, matches.map(({ match, title, type, year, basis, libraryIds: found = [] }, index) => ({
        index, title, type, year, basis, contentId: match?.content_id, localTitle: match?.title,
        libraryIds: libraryIds.filter((id) => found.includes(id)),
        libraries: libraryIds.filter((id) => found.includes(id)).map((id) => libraryNames.get(id)),
      })));
    }
    if (req.method === 'POST' && path === '/api/match-candidates') {
      const data = await body(req);
      const { catalog } = await preview(data);
      const query = normalize(typeof data.query === 'string' ? data.query.slice(0, 150) : '');
      const candidates = query ? filter(catalog, query, 1, 20, 'title-asc').items : [];
      return send(res, 200, candidates.map(({ content_id, title, year, previewLibraryIds }) =>
        ({ id: content_id, title, year, libraryIds: previewLibraryIds })));
    }
    if (req.method === 'POST' && path === '/api/sort-collections') {
      const data = await body(req);
      const library = (await silo.libraries()).find((item) => item.id === data.libraryId && previewKind(item) === data.kind);
      if (!library) throw new AppError(400, 'Choose an eligible Silo library.');
      return send(res, 200, await silo.sortCollections(library.id));
    }
    if (req.method === 'POST' && path === '/api/poster-preview') {
      const data = await body(req);
      const image = await downloadPublicArtwork(posterUrl(data.url));
      const [mime] = imageType(image);
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': image.length });
      return res.end(image);
    }
    if (req.method === 'POST' && path === '/api/edit') {
      const data = await body(req);
      const id = collectionId(data.collectionId);
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (!title || title.length > 150 || typeof data.description !== 'string' || data.description.length > 8000 ||
        typeof data.etag !== 'string' || !data.etag || data.etag === '*') {
        throw new AppError(400, 'Open the collection and enter a valid title and description.');
      }
      const poster = await selectedPoster(data);
      let members = [];
      if (data.contentIds != null) {
        if (!Array.isArray(data.contentIds) || data.contentIds.length > 1000 || data.contentIds.some((id) => typeof id !== 'string')) {
          throw new AppError(400, 'Select valid library titles.');
        }
        if (data.contentIds.length) {
          const { matches } = await preview(data);
          const available = new Map(matches.filter((item) => item.match).map((item) => [item.match.content_id, item.match]));
          members = [...new Set(data.contentIds)].map((itemId) => available.get(itemId));
          if (members.some((item) => !item)) throw new AppError(409, 'Library matches changed. Preview again before saving.');
        }
      }
      if (data.dryRun === true) {
        const { etag } = await silo.getCollection(id);
        if (etag !== data.etag) throw new AppError(409, 'The collection changed. Reopen it before saving.');
        await selectedBackdrop(data);
        return send(res, 200, { action: 'Update', memberCount: members.length });
      }
      const updated = await silo.updateCollection({ id, title, description: data.description, poster, etag: data.etag, members, sort: data.sort,
        ...await selectedBackdrop(data) });
      return send(res, 200, { ...publicCollection(updated), added: updated.added });
    }
    if (req.method === 'POST' && path === '/api/import') {
      const data = await body(req);
      const title = typeof data.title === 'string' ? data.title.trim() : '';
      if (!title || title.length > 150 || !Array.isArray(data.contentIds) || !data.contentIds.length ||
        data.contentIds.length > 1000 || data.contentIds.some((id) => typeof id !== 'string') ||
        (data.description != null && (typeof data.description !== 'string' || data.description.length > 8000))) {
        throw new AppError(400, 'Choose a title, a poster, and at least one matched library item.');
      }
      const { detail, libraryIds, libraryNames, matches } = await preview(data);
      const sync = data.sync === true;
      if (sync && (data.provider !== 'tmdb' || data.kind !== 'movie')) throw new AppError(400, 'TMDb sync is available for TMDb movie collections.');
      const permitted = new Map(matches.filter((m) => m.match).map((m) => [m.match.content_id, m.match]));
      const members = sync ? [...permitted.values()] : [...new Set(data.contentIds)].map((id) => permitted.get(id));
      if (members.some((m) => !m)) throw new AppError(409, 'Library matches changed. Preview again before importing.');
      const eligible = eligibleCollection(libraryIds, members);
      if (!eligible.libraryIds.length) throw new AppError(422, 'Select at least two matched titles in the same library to create a collection.');
      const poster = await selectedPoster(data, true);
      if (data.dryRun === true) {
        await selectedBackdrop(data);
        const resume = await silo.planImport({ detail, title, libraryIds: eligible.libraryIds, sync });
        return send(res, 200, { action: resume ? 'Resume import' : 'Create', memberCount: eligible.members.length,
          libraries: eligible.libraryIds.map((id) => libraryNames.get(id)),
          skippedLibraries: eligible.skipped.map((id) => libraryNames.get(id)) });
      }
      let metadata = detail.metadata;
      let warning;
      if (!metadata && (data.description == null || data.includeBackdrop !== false)) {
        try { metadata = await source.metadata(key(data.provider, data.id, data.kind)); }
        catch { warning = `${data.kind === 'series' ? 'TheTVDB' : 'TMDb'} metadata could not be loaded.`; }
      }
      const chosen = await selectedBackdrop(data);
      const result = await silo.publish({ detail, title, libraryIds: eligible.libraryIds, members: eligible.members, poster,
        description: data.description ?? metadata?.description?.slice(0, 8000), sync, sort: data.sort,
        backdrop: data.kind === 'movie' && data.includeBackdrop !== false ? metadata?.backdrop : '', ...chosen });
      return send(res, 201, { ...result, warning: result.warning ?? warning,
        skippedLibraries: eligible.skipped.map((id) => libraryNames.get(id)) });
    }
    return send(res, 404, { error: 'Page not found.' });
  } catch (error) {
    const handled = error instanceof AppError;
    if (!handled) console.error('Request could not be completed:', error.name);
    if (handled && error.status === 429 && /^\d+$/.test(error.retryAfter ?? '')) res.setHeader('Retry-After', error.retryAfter);
    if (!res.headersSent) send(res, handled ? error.status : 502, { error: handled ? error.message : 'The request could not be completed.' });
  }
}).listen(Number(env.PORT || 8080), '0.0.0.0', () => console.log('Silo Franchises is ready.'));
