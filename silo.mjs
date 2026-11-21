import { createHash } from 'node:crypto';
import { AppError, bytes, normalize, request } from './providers.mjs';

export function matchMembers(members, catalog) {
  const byId = new Map();
  const byTitle = new Map();
  const fields = { tvdb: 'tvdb_id', tmdb: 'tmdb_id', imdb: 'imdb_id' };
  const add = (index, key, item) => {
    const group = index.get(key) ?? [];
    if (!group.some((existing) => existing.content_id === item.content_id)) group.push(item);
    index.set(key, group);
  };
  for (const item of catalog) {
    for (const [provider, field] of Object.entries(fields)) {
      if (item[field]) add(byId, `${item.type}:${provider}:${item[field]}`, item);
    }
    add(byTitle, `${item.type}:${normalize(item.title)}`, item);
  }
  return members.map((member) => {
    const exact = new Map();
    for (const provider of Object.keys(fields)) {
      if (!member[provider]) continue;
      for (const local of byId.get(`${member.type}:${provider}:${member[provider]}`) ?? []) exact.set(local.content_id, local);
    }
    if (exact.size === 1) return { ...member, match: [...exact.values()][0], basis: 'Provider ID' };
    if (exact.size > 1) return { ...member, basis: 'Ambiguous provider IDs' };
    const names = (byTitle.get(`${member.type}:${normalize(member.title)}`) ?? [])
      .filter((item) => member.year && Number(item.year) === Number(member.year) &&
        Object.entries(fields).every(([provider, field]) => !member[provider] || !item[field] || String(member[provider]) === String(item[field])));
    if (names.length === 1) return { ...member, match: names[0], basis: 'Title and year' };
    return { ...member, basis: names.length ? 'Ambiguous title' : 'Missing' };
  });
}

function imageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return ['image/jpeg', 'jpg'];
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  throw new AppError(502, 'ThePosterDB returned a file that is not a supported image.');
}

export function siloClient(base, token) {
  const root = new URL(base);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
    throw new Error('SILO_URL must be an HTTP(S) server URL.');
  }
  const prefix = root.href.replace(/\/$/, '') + '/api/v2';
  const call = async (path, { method = 'GET', body, etag, withTag = false } = {}) => {
    if (!token) throw new AppError(503, 'Set SILO_API_KEY in the stack to connect to Silo.');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (etag) headers['If-Match'] = etag;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await request(prefix + path, { method, headers, body }, 'Silo');
    if (response.status === 204) return null;
    const value = await response.json();
    return withTag ? { value, etag: response.headers.get('etag') } : value;
  };
  const libraries = async () => (await call('/libraries')).items.filter((library) => library.enabled);
  const catalog = async (ids) => {
    const all = new Map();
    for (const library of ids) {
      const cursors = new Set();
      let cursor;
      do {
        const query = new URLSearchParams({ library_id: library, limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await call('/admin/catalog/items?' + query);
        for (const item of page.items) if (['movie', 'series'].includes(item.type)) all.set(item.content_id, item);
        cursor = page.page?.next_cursor;
        if (page.page?.has_more && (!cursor || cursors.has(cursor))) throw new AppError(502, 'Silo returned an invalid catalog cursor.');
        cursors.add(cursor);
      } while (cursor);
    }
    return [...all.values()];
  };

  const collectionsPath = '/admin/collections';
  const collections = async () => (await call(collectionsPath)).items;
  const collectionPath = (id) => `${collectionsPath}/${encodeURIComponent(id)}`;
  const getCollection = (id) => call(collectionPath(id), { withTag: true });

  async function preparePoster(poster) {
    const image = await bytes(await request(poster.image, {}, 'ThePosterDB artwork'));
    const [mime, extension] = imageType(image);
    const form = new FormData();
    form.append('image', new Blob([image], { type: mime }), `poster.${extension}`);
    return form;
  }

  async function updateCollection({ id, title, description, poster, etag }) {
    const form = poster ? await preparePoster(poster) : null;
    const current = await getCollection(id);
    if (!current.etag || current.etag !== etag) {
      throw new AppError(412, 'This collection changed in Silo. Reopen it before saving.');
    }
    const path = collectionPath(id);
    const updated = await call(path, { method: 'PATCH', etag, body: { title, description } });
    if (form) {
      try { await call(path + '/poster', { method: 'PUT', body: form }); }
      catch (error) { throw new AppError(error.status ?? 502, 'Title and description were saved, but the poster upload failed. Reopen the collection and retry the poster.'); }
    }
    return updated;
  }
  const active = new Set();
  async function publish({ detail, title, libraryIds, members, poster }) {
    const identity = JSON.stringify([detail.provider, detail.id, normalize(title), [...libraryIds].sort()]);
    const slug = 'franchise-' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
    if (active.has(slug)) throw new AppError(409, 'This collection is already being imported.');
    active.add(slug);
    let collection;
    try {
      const form = await preparePoster(poster);
      const existing = await collections();
      collection = existing.find((item) => item.slug === slug && normalize(item.title) === normalize(title));
      if (!collection) {
        if (existing.some((item) => normalize(item.title) === normalize(title) &&
          (item.library_ids?.length ? item.library_ids : [item.library_id]).some((id) => libraryIds.includes(id)))) {
          throw new AppError(409, 'A collection with this name already exists in a selected library. Choose a different title.');
        }
        collection = await call(collectionsPath, { method: 'POST', body: {
          title, slug, library_ids: libraryIds, collection_type: 'manual', source_url: detail.url,
        } });
      }
      if (!collection?.id) throw new AppError(502, 'Silo did not return the new collection ID.');
      const path = collectionPath(collection.id);
      for (const [position, item] of members.entries()) {
        await call(`${path}/items/${encodeURIComponent(item.content_id)}`, { method: 'PUT', body: { position } });
      }
      await call(path + '/poster', { method: 'PUT', body: form });
      return { id: collection.id, title: collection.title, added: members.length };
    } catch (error) {
      if (collection?.id) {
        throw new AppError(error.status ?? 502, `Silo collection ${collection.id} exists. ${error instanceof AppError ? error.message : 'Import was interrupted.'} Retry with the same title and libraries to resume.`);
      }
      throw error;
    } finally {
      active.delete(slug);
    }
  }
  return { libraries, catalog, publish, collections, getCollection, updateCollection };
}
