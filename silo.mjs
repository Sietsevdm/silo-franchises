import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError, bytes, normalize, request } from './providers.mjs';
import { downloadPublicArtwork } from './remote-artwork.mjs';

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
    const libraryIds = (items) => [...new Set(items.flatMap((item) => item.previewLibraryIds ?? []))];
    const exact = new Map();
    for (const provider of Object.keys(fields)) {
      if (!member[provider]) continue;
      for (const local of byId.get(`${member.type}:${provider}:${member[provider]}`) ?? []) exact.set(local.content_id, local);
    }
    if (exact.size === 1) return { ...member, match: [...exact.values()][0], basis: 'Provider ID', libraryIds: libraryIds([...exact.values()]) };
    if (exact.size > 1) return { ...member, basis: 'Ambiguous provider IDs', libraryIds: libraryIds([...exact.values()]) };
    const names = (byTitle.get(`${member.type}:${normalize(member.title)}`) ?? [])
      .filter((item) => member.year && Number(item.year) === Number(member.year) &&
        Object.entries(fields).every(([provider, field]) => !member[provider] || !item[field] || String(member[provider]) === String(item[field])));
    if (names.length === 1) return { ...member, match: names[0], basis: 'Title and year', libraryIds: libraryIds(names) };
    return { ...member, basis: names.length ? 'Ambiguous title' : 'Missing' };
  });
}

export function eligibleCollection(libraryIds, members) {
  const counts = new Map(libraryIds.map((id) => [id, new Set()]));
  for (const member of members) {
    for (const id of member.previewLibraryIds) counts.get(id)?.add(member.content_id);
  }
  const eligible = libraryIds.filter((id) => counts.get(id).size >= 2);
  return {
    libraryIds: eligible,
    skipped: libraryIds.filter((id) => !eligible.includes(id)),
    members: members.filter((member) => member.previewLibraryIds.some((id) => eligible.includes(id))),
  };
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
  let readQueue = Promise.resolve();
  let nextRead = 0;
  const read = async (send) => {
    const deadline = Date.now() + 20_000;
    for (let attempt = 0; ; attempt++) {
      const scheduled = readQueue.then(async () => {
        if (nextRead > deadline) throw limited(nextRead);
        const wait = nextRead - Date.now();
        if (wait > 0) await sleep(wait);
        nextRead = Date.now() + 150;
        try { return await send(); }
        catch (error) {
          if (error.status !== 429) throw error;
          const hint = error.retryAfter;
          const retry = !hint ? NaN : /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - Date.now();
          nextRead = Math.max(nextRead, Date.now() + (Number.isFinite(retry) ? Math.max(0, retry) : 1000 * 2 ** attempt));
          throw limited(nextRead);
        }
      });
      readQueue = scheduled.catch(() => {});
      try { return await scheduled; }
      catch (error) {
        if (error.status !== 429 || attempt >= 3 || nextRead > deadline) throw error;
      }
    }
  };
  function limited(until) {
    const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return new AppError(429, `Silo is limiting catalog requests. Wait about ${seconds} second${seconds === 1 ? '' : 's'}, then try the preview again.`, String(seconds));
  }
  const call = async (path, { method = 'GET', body, etag, withTag = false } = {}) => {
    if (!token) throw new AppError(503, 'Set SILO_API_KEY in the stack to connect to Silo.');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (etag) headers['If-Match'] = etag;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const send = () => request(prefix + path, { method, headers, body }, 'Silo');
    const response = method === 'GET' ? await read(send) : await send();
    if (response.status === 204) return null;
    const value = await response.json();
    return withTag ? { value, etag: response.headers.get('etag') } : value;
  };
  const libraries = async () => (await call('/libraries')).items.filter((library) => library.enabled);
  const inventories = new Map();
  function loadLibrary(library, type) {
    const key = JSON.stringify([library, type]);
    let entry = inventories.get(key);
    if (!entry || (!entry.pending && entry.expires < Date.now())) {
      entry = { items: new Map(), seen: new Set(), cursor: null, complete: false, expires: Infinity };
      inventories.set(key, entry);
    }
    if (entry.complete) return Promise.resolve(entry.items);
    if (entry.pending) return entry.pending;
    entry.pending = (async () => {
      do {
        const query = new URLSearchParams({ library_id: library, type, limit: '200' });
        if (entry.cursor) query.set('cursor', entry.cursor);
        const page = await call('/admin/catalog/items?' + query);
        const cursor = page.page?.next_cursor;
        if (page.page?.has_more && (!cursor || entry.seen.has(cursor))) throw new AppError(502, 'Silo returned an invalid catalog cursor.');
        for (const item of page.items) if (item.type === type) entry.items.set(item.content_id, item);
        entry.cursor = page.page?.has_more ? cursor : null;
        if (entry.cursor) entry.seen.add(entry.cursor);
      } while (entry.cursor);
      entry.complete = true;
      entry.expires = Date.now() + 120_000;
      return entry.items;
    })().catch((error) => {
      if (error.status === 429) entry.expires = Date.now() + Math.max(120_000, Number(error.retryAfter) * 1000 + 30_000);
      else inventories.delete(key);
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }
  const catalog = async (ids, type) => {
    const all = new Map();
    for (const library of new Set(ids)) {
      for (const [id, item] of await loadLibrary(library, type)) {
        const previous = all.get(id);
        all.set(id, { ...item, previewLibraryIds: [...(previous?.previewLibraryIds ?? []), library] });
      }
    }
    return [...all.values()];
  };

  const collectionsPath = '/admin/collections';
  const collections = async () => (await call(collectionsPath)).items;
  const collectionPath = (id) => `${collectionsPath}/${encodeURIComponent(id)}`;
  const getCollection = (id) => call(collectionPath(id), { withTag: true });

  async function prepareArtwork(url, label, custom = false) {
    const image = custom ? await downloadPublicArtwork(url) : await bytes(await request(url, {}, label));
    const [mime, extension] = imageType(image);
    const form = new FormData();
    form.append('image', new Blob([image], { type: mime }), `artwork.${extension}`);
    return form;
  }

  async function updateCollection({ id, title, description, poster, etag, members = [], backdrop, customBackdrop = false }) {
    const form = poster ? await prepareArtwork(poster.image, 'ThePosterDB artwork') : null;
    const backdropForm = backdrop ? await prepareArtwork(backdrop, 'Backdrop', customBackdrop) : null;
    const current = await getCollection(id);
    if (!current.etag || current.etag !== etag) {
      throw new AppError(412, 'This collection changed in Silo. Reopen it before saving.');
    }
    const path = collectionPath(id);
    let additions = [];
    let position = 0;
    if (members.length) {
      if (current.value.collection_type !== 'manual') throw new AppError(422, 'Only manual Silo collections accept individual titles.');
      const allowed = current.value.library_ids?.length ? current.value.library_ids : [current.value.library_id];
      if (members.some((item) => !item.previewLibraryIds.some((library) => allowed.includes(library)))) {
        throw new AppError(422, 'Only titles from this collection’s libraries can be added.');
      }
      const existing = new Set();
      const cursors = new Set();
      let cursor;
      do {
        const query = new URLSearchParams({ limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const page = await call(path + '/items?' + query);
        for (const item of page.items) {
          existing.add(item.media_item_id);
          position = Math.max(position, item.position + 1);
        }
        cursor = page.page?.has_more ? page.page.next_cursor : null;
        if (page.page?.has_more && (!cursor || cursors.has(cursor))) throw new AppError(502, 'Silo returned an invalid collection cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      additions = members.filter((item) => !existing.has(item.content_id));
    }
    const updated = await call(path, { method: 'PATCH', etag, body: { title, description } });
    for (const item of additions) {
      try { await call(`${path}/items/${encodeURIComponent(item.content_id)}`, { method: 'PUT', body: { position: position++ } }); }
      catch (error) { throw new AppError(error.status ?? 502, 'Collection details were saved, but adding titles was interrupted. Reopen the collection and retry.'); }
    }
    if (form) {
      try { await call(path + '/poster', { method: 'PUT', body: form }); }
      catch (error) { throw new AppError(error.status ?? 502, 'Title and description were saved, but the poster upload failed. Reopen the collection and retry the poster.'); }
    }
    if (backdropForm) {
      try { await call(path + '/backdrop', { method: 'PUT', body: backdropForm }); }
      catch (error) { throw new AppError(error.status ?? 502, 'Collection details were saved, but the backdrop upload failed. Reopen the collection and retry.'); }
    }
    return members.length ? { ...updated, added: additions.length } : updated;
  }
  const active = new Set();
  async function publish({ detail, title, libraryIds, members, poster, description, backdrop, customBackdrop = false, sync = false }) {
    const identity = JSON.stringify([detail.provider, detail.id, normalize(title), [...libraryIds].sort(), ...(sync ? ['sync'] : [])]);
    const slug = 'franchise-' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
    if (active.has(slug)) throw new AppError(409, 'This collection is already being imported.');
    active.add(slug);
    let collection;
    try {
      const form = await prepareArtwork(poster.image, 'ThePosterDB artwork');
      const customForm = customBackdrop ? await prepareArtwork(backdrop, 'Backdrop', true) : null;
      const existing = await collections();
      collection = existing.find((item) => item.slug === slug && normalize(item.title) === normalize(title));
      if (!collection) {
        if (existing.some((item) => normalize(item.title) === normalize(title) &&
          (item.library_ids?.length ? item.library_ids : [item.library_id]).some((id) => libraryIds.includes(id)))) {
          throw new AppError(409, 'A collection with this name already exists in a selected library. Choose a different title.');
        }
        const syncedSource = sync ? { collection_type: 'tmdb', source_url: `tmdb://collection/${detail.id}`,
          source_config: { mode: 'tmdb_collection', collection_id: Number(detail.id) }, sync_schedule: '0 4 * * *' } : null;
        collection = await call(collectionsPath, { method: 'POST', body: {
          title, slug, library_ids: libraryIds, collection_type: 'manual', source_url: detail.url, description,
          ...syncedSource,
        } });
      }
      if (!collection?.id) throw new AppError(502, 'Silo did not return the new collection ID.');
      const path = collectionPath(collection.id);
      if (!sync) {
        for (const [position, item] of members.entries()) {
          await call(`${path}/items/${encodeURIComponent(item.content_id)}`, { method: 'PUT', body: { position } });
        }
      }
      await call(path + '/poster', { method: 'PUT', body: form });
      let warning;
      if (backdrop) {
        try {
          const wideArtwork = customForm ?? await prepareArtwork(backdrop, 'TMDb backdrop');
          await call(path + '/backdrop', { method: 'PUT', body: wideArtwork });
        } catch { warning = 'The collection was saved, but its backdrop could not be uploaded.'; }
      }
      if (sync) {
        try {
          const status = await call(path + '/sync', { method: 'POST' });
          const syncState = status?.sync_run?.status ?? status?.status;
          if (['failed', 'error'].includes(syncState)) throw new Error('Sync failed');
        } catch { warning = [warning, 'The TMDb-synced collection was saved, but its first sync failed. Check the TMDb setup in Silo.'].filter(Boolean).join(' '); }
      }
      const result = { id: collection.id, title: collection.title, added: members.length };
      if (sync) result.synced = true;
      return warning ? { ...result, warning } : result;
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
