import { gunzipSync } from 'node:zlib';

export const posterSources = [
  'RedHeadJedi', 'ishalioh', 'ashlyfxxk', 'XDM', 'mikenobbs',
  'DarkMatte', 'DIIIVOY', 'cmanuelg1989', 'KyleKahotek', 'j.zapattack', 'Lafferlaffer',
];
export function galleryUrl(creator) {
  if (!posterSources.includes(creator)) throw new AppError(400, 'Choose a configured ThePosterDB source.');
  return `https://theposterdb.com/user/${creator}?category=Collections&textless=Non-Textless&language=en&sort=Recent&variation=orig&section=uploads`;
}
const tvdb = 'https://thetvdb.com';
const tmdb = 'https://api.themoviedb.org/3';
const tmdbArtwork = (path) => typeof path === 'string' && /^\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)$/i.test(path)
  ? 'https://image.tmdb.org/t/p/w1280' + path : '';
const ttl = 6 * 60 * 60 * 1000;
const maxBytes = 15 * 1024 * 1024;

export class AppError extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
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
    const retryAfter = response.headers.get('retry-after');
    await response.body?.cancel();
    throw new AppError(response.status, `${service} returned HTTP ${response.status}.`, retryAfter);
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
const excludedTitleScripts = [
  'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo', 'Cyrillic', 'Thai', 'Lao', 'Khmer', 'Myanmar',
  'Tibetan', 'Mongolian', 'Devanagari', 'Bengali', 'Tamil', 'Telugu',
];
const excludedTitleCharacters = new RegExp(`[${excludedTitleScripts.map((script) => `\\p{Script=${script}}`).join('')}]`, 'u');
export const allowedFranchiseTitle = (title) => !excludedTitleCharacters.test(title);

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
    .map((match) => {
      const [, id, title] = match;
      const after = page.slice(match.index + match[0].length, match.index + match[0].length + 400);
      const stars = after.split(/<h3\b/i)[0].match(/class="fa fa-star"[^>]*><\/i>\s*([\d,]+)/i)?.[1];
      return { id, title: decode(title), provider: 'tvdb', url: `${tvdb}/lists/${id}`, stars: stars ? Number(stars.replaceAll(',', '')) : 0 };
    });
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
  const tmdbJson = async (path) => {
    if (!token) throw new AppError(503, 'Set TMDB_READ_TOKEN in Portainer to load TMDb details.');
    try {
      return await (await request(tmdb + path, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }, 'TMDb API')).json();
    } catch (error) {
      if ([401, 403].includes(error.status)) {
        throw new AppError(error.status, 'TMDb rejected the API credential. Check that TMDB_READ_TOKEN contains the API Read Access Token from your TMDb account.');
      }
      throw error;
    }
  };
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
    for (let day = 0; day < 4; day++) {
      const date = new Date(now.getTime() - day * 86_400_000).toISOString().slice(0, 10);
      const [year, month, dateOfMonth] = date.split('-');
      try {
        const buffer = await bytes(await request(`https://files.tmdb.org/p/exports/collection_ids_${month}_${dateOfMonth}_${year}.json.gz`, {}, 'TMDb collection index'));
        const raw = buffer[0] === 31 && buffer[1] === 139 ? gunzipSync(buffer, { maxOutputLength: maxBytes }) : buffer;
        return raw.toString('utf8').trim().split('\n').map((line) => {
          const { id, name } = JSON.parse(line);
          return { id: String(id), title: name, provider: 'tmdb', url: `https://www.themoviedb.org/collection/${id}` };
        });
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        if (day === 3) throw new AppError(502, 'TMDb’s recent public collection indexes are unavailable. Try again later or browse TheTVDB.');
      }
    }
  });

  let galleryQueue = Promise.resolve();
  const lastGalleryPage = new Map();
  function loadGallery(url) {
    const load = galleryQueue.then(() => html(url, 'ThePosterDB'));
    galleryQueue = load.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 275)));
    return load;
  }
  const readGalleryPage = cached(async (key) => {
    const [creator, number] = key.split(':');
    const url = new URL(galleryUrl(creator));
    url.searchParams.set('page', number);
    const parsed = parseGallery(await loadGallery(url));
    if (!parsed.items.length && number === '1') throw new AppError(502, 'ThePosterDB gallery returned no recognizable poster cards.');
    parsed.items = parsed.items.map((poster) => ({ ...poster, creator }));
    for (const poster of parsed.items) seenPosters.set(poster.id, poster);
    if (!parsed.more) lastGalleryPage.set(creator, { page: Number(number), expires: Date.now() + ttl });
    return parsed;
  });
  const galleryPage = (creator, number) => {
    const last = lastGalleryPage.get(creator);
    if (last && last.expires > Date.now() && number > last.page) return Promise.resolve({ items: [], more: false });
    return readGalleryPage(`${creator}:${number}`);
  };
  const posterIndex = cached(async (creator) => {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await galleryPage(creator, page);
      result.push(...batch.items);
      if (!batch.more) return [...new Map(result.map((item) => [item.id, item])).values()];
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
  const tvList = cached(async (id) => {
    const official = (await tvIndex()).find((list) => list.id === id);
    if (!official) throw new AppError(404, 'Choose a list from TheTVDB’s official directory.');
    const page = await html(official.url, 'TheTVDB');
    const items = parseTVMembers(page);
    if (!items.length) throw new AppError(502, 'TheTVDB returned no recognizable list members.');
    const description = page.match(/<div\b[^>]*class="change_translation_text"[^>]*data-language="eng"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    return { ...official, items, description: decode(description ?? '') };
  });
  const details = cached(async (key) => {
    const [provider, id, kind] = key.split(':');
    if (provider === 'tmdb') {
      const item = await tmdbJson(`/collection/${id}?language=en-US`);
      const url = `https://www.themoviedb.org/collection/${id}`;
      return { provider, id, title: item.name, url, metadata: {
        title: item.name, description: item.overview ?? '', backdrop: tmdbArtwork(item.backdrop_path), url, kind: 'collection',
      },
        members: item.parts.map((part) => ({ type: 'movie', title: part.title, tmdb: String(part.id), year: part.release_date?.slice(0, 4) })) };
    }
    const list = await tvList(id);
    const items = list.items.filter((item) => item.type === kind);
    if (!items.length) throw new AppError(404, 'This list has no titles of the selected media type.');
    const members = [];
    for (let i = 0; i < items.length; i += 4) {
      members.push(...await Promise.all(items.slice(i, i + 4).map(async (item) =>
        ({ ...item, ...await tvMember(`${item.section}/${item.slug}`) }))));
    }
    return { provider, id, title: list.title, url: list.url, members };
  });
  const metadata = cached(async (key) => {
    const [provider, id, kind] = key.split(':');
    if (provider === 'tmdb') return (await details(key)).metadata;
    const list = await tvList(id);
    if (kind === 'series') {
      return { title: list.title, description: list.description, backdrop: '', url: list.url, kind: 'tvdb' };
    }
    const candidates = list.items.filter((item) => item.type === kind).slice(0, 4);
    const route = kind === 'movie' ? 'movie' : 'tv';
    for (const candidate of candidates) {
      const refs = await tvMember(`${candidate.section}/${candidate.slug}`);
      try {
        let item;
        if (refs.tmdb) item = await tmdbJson(`/${route}/${refs.tmdb}?language=en-US`);
        else if (refs.imdb || refs.tvdb) {
          const id = refs.imdb || refs.tvdb;
          const external = refs.imdb ? 'imdb_id' : 'tvdb_id';
          const result = await tmdbJson(`/find/${id}?external_source=${external}&language=en-US`);
          const hits = kind === 'movie' ? result.movie_results : result.tv_results;
          if (hits?.length === 1) item = hits[0];
        }
        if (item && (item.overview || tmdbArtwork(item.backdrop_path))) {
          return { title: item.title ?? item.name, description: item.overview ?? '', backdrop: tmdbArtwork(item.backdrop_path),
            url: `https://www.themoviedb.org/${route}/${item.id}`, kind: 'related' };
        }
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return null;
  });
  const movieImages = cached(async (id) => {
    const item = await tmdbJson(`/movie/${id}?language=en-US&append_to_response=images&include_image_language=en,null`);
    const paths = new Set([item.backdrop_path, ...(item.images?.backdrops ?? []).map((image) => image.file_path)]);
    return [...paths].filter((path) => tmdbArtwork(path)).map((path) => ({
      path, film: item.title, image: tmdbArtwork(path), thumbnail: tmdbArtwork(path).replace('/w1280/', '/w300/'),
    }));
  });
  const resolveMovieId = cached(async (external) => {
    const result = await tmdbJson(`/find/${external}?external_source=imdb_id&language=en-US`);
    return result.movie_results?.length === 1 ? String(result.movie_results[0].id) : null;
  });
  const backdrops = cached(async (key) => {
    const detail = await details(key);
    const seen = new Set();
    const items = [];
    const unavailable = [];
    for (let i = 0; i < detail.members.length; i += 4) {
      const batch = detail.members.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map(async (member) => {
        const id = member.tmdb || (member.imdb && await resolveMovieId(member.imdb));
        if (!id) throw new AppError(404, 'No matching TMDb film.');
        return movieImages(id);
      }));
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          if ([401, 403, 503].includes(result.reason.status)) throw result.reason;
          unavailable.push(batch[index].title);
          continue;
        }
        for (const image of result.value) {
          if (seen.has(image.path)) continue;
          seen.add(image.path);
          items.push(image);
        }
      }
    }
    return { items, unavailable };
  });
  const posterById = async (id, creator) => {
    if (!posterSources.includes(creator)) throw new AppError(400, 'Choose a configured poster source.');
    const seen = seenPosters.get(id);
    if (seen?.creator === creator) return seen;
    return (await posterIndex(creator)).find((poster) => poster.id === id);
  };
  return { tvIndex, tvList, movieIndex, posterIndex, galleryPage, details, metadata, posterById, backdrops };
}
