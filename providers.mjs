import { gunzipSync } from 'node:zlib';

export const gallery = 'https://theposterdb.com/user/RedHeadJedi?category=Collections&textless=Non-Textless&language=en&sort=Recent&variation=orig&section=uploads';
const tvdb = 'https://thetvdb.com';
const tmdb = 'https://api.themoviedb.org/3';
const ttl = 6 * 60 * 60 * 1000;
const maxBytes = 15 * 1024 * 1024;

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function request(url, options = {}, service = 'Upstream') {
  let response;
  try {
    response = await fetch(url, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(25_000),
      headers: { 'User-Agent': 'SiloFranchises/1.0', ...options.headers },
    });
  } catch {
    throw new AppError(502, `${service} could not be reached.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(response.status, `${service} returned HTTP ${response.status}.`);
  }
  return response;
}

export async function bytes(response, limit = maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new AppError(413, 'The upstream response exceeded the size limit.');
    parts.push(part);
  }
  return Buffer.concat(parts, size);
}

const html = async (url, service) => (await bytes(await request(url, {}, service))).toString('utf8');
export const normalize = (value) => value.normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

function decode(value) {
  const named = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ', rsquo: '’', ndash: '–' };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (!code.startsWith('#')) return named[code] ?? all;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number <= 0x10ffff ? String.fromCodePoint(number) : all;
  }).replace(/\s+/g, ' ').trim();
}

export function parseGallery(page) {
  const items = [];
  for (const block of page.split(/<div\s+class="hovereffect rounded-poster">/i).slice(1)) {
    const id = block.match(/data-poster-id=['"](\d+)['"]/i)?.[1];
    const title = block.match(/<p class="p-0 mb-1 text-break">([\s\S]*?)<\/p>/i)?.[1];
    const image = block.match(/srcset="(https:\/\/images\.theposterdb\.com\/prod\/public\/images\/posters\/optimized\/collections\/[\w/-]+\.jpg)"/i)?.[1];
    if (id && title && image) items.push({ id, title: decode(title), image, url: `https://theposterdb.com/poster/${id}` });
  }
  return { items, more: /rel=["']next["']/i.test(page) };
}

export function parseTVIndex(page) {
  return [...page.matchAll(/<h3\b[^>]*>\s*<a\b[^>]*href="\/lists\/([\w-]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, id, title]) => ({ id, title: decode(title), provider: 'tvdb', url: `${tvdb}/lists/${id}` }));
}

export function parseTVMembers(page) {
  return [...page.matchAll(/<h3\b[^>]*>\s*<a\b[^>]*href="\/(series|movies)\/([\w-]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(([, section, slug, title]) => ({
      section, slug, title: decode(title), type: section === 'series' ? 'series' : 'movie',
    }));
}

function cached(loader, lifetime = ttl) {
  const entries = new Map();
  return (key) => {
    const current = entries.get(key);
    if (current && current.expires > Date.now()) return current.promise;
    const promise = Promise.resolve().then(() => loader(key));
    entries.set(key, { promise, expires: Date.now() + lifetime });
    promise.catch(() => { if (entries.get(key)?.promise === promise) entries.delete(key); });
    if (entries.size > 2500) entries.delete(entries.keys().next().value);
    return promise;
  };
}

async function walk(first, last, load) {
  const result = [];
  for (let start = first; start <= last; start += 3) {
    const pages = Array.from({ length: Math.min(3, last - start + 1) }, (_, i) => load(start + i));
    result.push(...(await Promise.all(pages)).flat());
  }
  return result;
}

export function providers(token) {
  const seenPosters = new Map();
  const tvIndex = cached(async () => {
    const first = await html(`${tvdb}/lists`, 'TheTVDB');
    const last = Math.max(1, ...[...first.matchAll(/href="\?page=(\d+)"/g)].map((m) => Number(m[1])));
    const read = (page) => {
      const entries = parseTVIndex(page);
      if (!entries.length) throw new AppError(502, 'TheTVDB’s official list format has changed.');
      return entries;
    };
    const result = [...read(first), ...await walk(2, Math.min(last, 100), async (i) =>
      read(await html(`${tvdb}/lists?page=${i}`, 'TheTVDB')))];
    return [...new Map(result.map((item) => [item.id, item])).values()];
  });
  const movieIndex = cached(async () => {
    const now = new Date();
    for (let day = 0; day < 3; day++) {
      const date = new Date(now.getTime() - day * 86_400_000).toISOString().slice(0, 10);
      const [year, month, dateOfMonth] = date.split('-');
      try {
        const buffer = await bytes(await request(`https://files.tmdb.org/p/exports/collection_ids_${month}_${dateOfMonth}_${year}.json.gz`, {}, 'TMDb'));
        const raw = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer, { maxOutputLength: maxBytes }) : buffer;
        return raw.toString('utf8').trim().split('\n').map((line) => {
          const { id, name } = JSON.parse(line);
          return { id: String(id), title: name, provider: 'tmdb', url: `https://www.themoviedb.org/collection/${id}` };
        });
      } catch (error) {
        if (error.status !== 404 || day === 2) throw error;
      }
    }
  });

  const galleryPage = cached(async (number) => {
    const url = new URL(gallery);
    url.searchParams.set('page', number);
    const parsed = parseGallery(await html(url, 'ThePosterDB'));
    if (!parsed.items.length && number === 1) throw new AppError(502, 'ThePosterDB gallery returned no recognizable poster cards.');
    for (const poster of parsed.items) seenPosters.set(poster.id, poster);
    return parsed;
  });
  const posterIndex = cached(async () => {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await galleryPage(page);
      result.push(...batch.items);
      if (!batch.more) return [...new Map(result.map((item) => [item.id, item])).values()];
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new AppError(502, 'ThePosterDB gallery exceeded the index page limit.');
  });
  const tvMember = cached(async (path) => {
    const [section, slug] = path.split('/');
    const page = await html(`${tvdb}/${section}/${slug}`, 'TheTVDB');
    const tvdbId = page.match(/class="[^"]*favorite_button[^"]*"\s+data-type="(?:series|movie)"\s+data-id="(\d+)"/i)?.[1]
      ?? page.match(/TheTVDB\.com (?:Series|Movie) ID<\/strong>\s*<span>(\d+)<\/span>/i)?.[1];
    const imdb = page.match(/href="https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i)?.[1];
    const tmdbId = page.match(/href="https?:\/\/(?:www\.)?themoviedb\.org\/(?:movie|tv)\/(\d+)/i)?.[1];
    return { tvdb: tvdbId, imdb, tmdb: tmdbId };
  });
  const details = cached(async (key) => {
    const [provider, id] = key.split(':');
    if (provider === 'tmdb') {
      if (!token) throw new AppError(503, 'Set TMDB_READ_TOKEN in the stack to load movie collection members.');
      const response = await request(`${tmdb}/collection/${id}?language=en-US`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, 'TMDb');
      const item = await response.json();
      return { provider, id, title: item.name, description: item.overview, url: `https://www.themoviedb.org/collection/${id}`,
        members: item.parts.map((part) => ({ type: 'movie', title: part.title, tmdb: String(part.id), year: part.release_date?.slice(0, 4) })) };
    }
    const official = (await tvIndex()).find((list) => list.id === id);
    if (!official) throw new AppError(404, 'Choose a list from TheTVDB’s official directory.');
    const url = official.url;
    const page = await html(url, 'TheTVDB');
    const title = decode(page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
    const items = parseTVMembers(page);
    if (!title || !items.length) throw new AppError(502, 'TheTVDB returned no recognizable list members.');
    const members = [];
    for (let i = 0; i < items.length; i += 4) {
      members.push(...await Promise.all(items.slice(i, i + 4).map(async (item) =>
        ({ ...item, ...await tvMember(`${item.section}/${item.slug}`) }))));
    }
    return { provider, id, title, url, members };
  });
  const posterById = async (id) => seenPosters.get(id) ?? (await posterIndex()).find((poster) => poster.id === id);
  return { tvIndex, movieIndex, posterIndex, galleryPage, details, posterById };
}
