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

export function imageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return ['image/jpeg', 'jpg'];
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  throw new AppError(422, 'Artwork must be a JPEG, PNG, or WebP image.');
}

const excludedMovieLibraries = new Set([
  'movies anime', 'movies ppv sports', 'movies foreign', 'movies 4k special editions', 'movies special editions',
]);
export function libraryKind(library) {
  if (library.type === 'series') return 'series';
  if (library.type === 'movies') return 'movie';
  return null;
}
export function previewKind(library) {
  const kind = libraryKind(library);
  return kind === 'movie' && excludedMovieLibraries.has(normalize(library.name)) ? null : kind;
}
export function selectedLibraryKind(library, libraryIds) {
  return libraryIds == null ? previewKind(library) : libraryIds.includes(library.id) ? libraryKind(library) : null;
}

const sortConfig = (sort) => sort === 'title' ? { field: 'title', order: 'asc' } : sort === 'source' ? {} : undefined;

export function siloClient(base, token, { requestKey, requestProfileId } = {}) {
  const root = new URL(base);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash) {
    throw new Error('SILO_URL must be an HTTP(S) server URL.');
  }
  const prefix = root.href.replace(/\/$/, '') + '/api/v2';
  let readQueue = Promise.resolve();
  let nextRead = 0;
  const pacedRequest = async (send) => {
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
    return new AppError(429, `Silo is limiting requests. Wait about ${seconds} second${seconds === 1 ? '' : 's'} before retrying.`, String(seconds));
  }
  const call = async (path, { method = 'GET', body, etag, withTag = false, mediaRequest = false, paced = false } = {}) => {
    const credential = mediaRequest ? requestKey || token : token;
    if (!credential) throw new AppError(503, 'Set SILO_API_KEY in the stack to connect to Silo.');
    const headers = { Authorization: `Bearer ${credential}`, Accept: 'application/json' };
    if (mediaRequest && requestProfileId) headers['X-Profile-Id'] = requestProfileId;
    if (etag) headers['If-Match'] = etag;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const send = () => request(prefix + path, { method, headers, body }, 'Silo');
    const response = method === 'GET' || paced ? await pacedRequest(send) : await send();
    if (response.status === 204) return null;
    const value = await response.json();
    return withTag ? { value, etag: response.headers.get('etag') } : value;
  };
  async function requestMissingMedia(candidates) {
    const report = { requested: [], skipped: [], failed: [], tracking: [] };
    for (const [index, { title, type, tmdb, year }] of candidates.entries()) {
      try {
        const value = await call('/requests', { method: 'POST', mediaRequest: true, body: {
          title, media_type: type, tmdb_id: Number(tmdb), year: Number(year) || undefined,
        } });
        report.requested.push(title);
        report.tracking.push({ title, type, tmdb, requestId: value?.id, status: value?.state ?? 'submitted' });
      } catch (error) {
        if (error.status === 409) report.skipped.push(title);
        else {
          report.failed.push(title);
          if ([401, 403, 429, 503].includes(error.status)) {
            report.failed.push(...candidates.slice(index + 1).map((item) => item.title));
            report.reason = error.status === 429 ? 'Silo is limiting requests or the profile reached its quota.'
              : error.status === 503 ? 'Silo Requests is unavailable.'
                : 'Silo rejected the request credential or profile. Check its Requests permission.';
            break;
          }
        }
        report.tracking.push({ title, type, tmdb, status: error.status === 409 ? 'already requested or available' : 'submission failed' });
      }
    }
    return report;
  }
  const mediaRequestStatus = (id) => call('/requests/' + encodeURIComponent(id), { mediaRequest: true });
  let libraryCache;
  function libraries() {
    if (libraryCache?.expires > Date.now()) return libraryCache.pending;
    const pending = call('/libraries').then(({ items }) => items.filter((library) => library.enabled));
    libraryCache = { pending, expires: Date.now() + 30_000 };
    pending.catch(() => { if (libraryCache?.pending === pending) libraryCache = null; });
    return pending;
  }
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
      entry.expires = Date.now() + 600_000;
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
    const libraries = [...new Set(ids)];
    const inventories = await Promise.all(libraries.map((id) => loadLibrary(id, type)));
    for (const [index, library] of libraries.entries()) {
      for (const [id, item] of inventories[index]) {
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
  async function collectionMembership(id) {
    const members = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const result = await call(collectionPath(id) + '/items?' + query);
      for (const item of result.items) members.set(item.media_item_id, item.position);
      cursor = result.page?.has_more ? result.page.next_cursor : null;
      if (result.page?.has_more && (!cursor || cursors.has(cursor))) {
        throw new AppError(502, 'Silo returned an invalid collection cursor.');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return members;
  }
  const collectionMemberIds = async (id) => new Set((await collectionMembership(id)).keys());

  async function appendAvailable(id, contentIds) {
    const members = await collectionMembership(id);
    let position = [...members.values()].reduce((next, current) => Math.max(next, current + 1), 0);
    for (const contentId of new Set(contentIds)) {
      if (members.has(contentId)) continue;
      await call(collectionPath(id) + '/items/' + encodeURIComponent(contentId), { method: 'PUT', body: { position: position++ } });
    }
  }
  async function sortCollections(libraryId) {
    const query = new URLSearchParams({ library_id: libraryId });
    const scoped = (await call(collectionsPath + '?' + query)).items;
    const titles = new Map(scoped.map(({ id, title }) => [id, title]));
    const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    const groups = new Set([null, ...scoped.map((item) => item.group_id).filter(Boolean)]);
    let changed = 0;
    const skipped = [];
    for (const group of groups) {
      const order = new URLSearchParams(query);
      if (group) order.set('group_id', group);
      const { value, etag } = await call(collectionsPath + '/order?' + order, { withTag: true });
      if (!etag || value.has_more || value.ordered_ids.some((id) => !titles.has(id))) {
        skipped.push(group ?? 'Ungrouped');
        continue;
      }
      const sorted = [...value.ordered_ids].sort((a, b) => compare.compare(titles.get(a), titles.get(b)));
      if (sorted.every((id, index) => id === value.ordered_ids[index])) continue;
      try {
        await call(collectionsPath + '/order', { method: 'PUT', etag,
          body: { library_id: libraryId, group_id: group, ordered_ids: sorted } });
        changed++;
      } catch {
        skipped.push(group ?? 'Ungrouped');
      }
    }
    return { changed, skipped };
  }

  async function prepareArtwork(url, label, custom = false) {
    const image = custom ? await downloadPublicArtwork(url) : await bytes(await request(url, {}, label));
    return artworkForm(image);
  }
  function artworkForm(image) {
    const [mime, extension] = imageType(image);
    const form = new FormData();
    form.append('image', new Blob([image], { type: mime }), `artwork.${extension}`);
    return form;
  }

  async function snapshotArtwork(value) {
    if (!value) return null;
    const url = new URL(value, root);
    const image = url.origin === root.origin
      ? await bytes(await request(url, { headers: { Authorization: `Bearer ${token}` } }, 'Silo artwork'))
      : await downloadPublicArtwork(url.href);
    imageType(image);
    return image.toString('base64');
  }
  async function restoreCollection(id, snapshot, expected, onPatched) {
    const { etag } = await getCollection(id);
    if (!etag || etag !== expected) throw new AppError(412, 'This collection changed in Silo after the edit.');
    const path = collectionPath(id);
    const { artwork, ...fields } = snapshot;
    await call(path, { method: 'PATCH', etag, body: fields });
    onPatched();
    for (const [type, image] of Object.entries(artwork)) {
      if (image) await call(path + '/' + type, { method: 'PUT', body: artworkForm(Buffer.from(image, 'base64')) });
      else await call(path + '/image?' + new URLSearchParams({ type }), { method: 'DELETE' });
    }
  }
  async function updateCollection({ id, title, description, poster, etag, members = [], backdrop, customBackdrop = false, sort, beforeChange, onPatched }) {
    const form = poster ? await prepareArtwork(poster.image, 'Poster artwork', poster.custom) : null;
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
    if (beforeChange) {
      const artwork = {};
      if (form) artwork.poster = await snapshotArtwork(current.value.poster_is_collage ? null : current.value.poster_url);
      if (backdropForm) artwork.backdrop = await snapshotArtwork(current.value.backdrop_url);
      await beforeChange({ title: current.value.title, description: current.value.description ?? '', artwork });
    }
    const updated = await call(path, { method: 'PATCH', etag, body: { title, description, sort_config: sortConfig(sort) } });
    onPatched?.();
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
  function importSlug({ detail, title, libraryIds, sync }) {
    const identity = JSON.stringify([detail.provider, detail.id, normalize(title), [...libraryIds].sort(), ...(sync ? ['sync'] : [])]);
    return 'franchise-' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
  }
  async function existingImport(title, libraryIds, slug) {
    const existing = await collections();
    const resumable = existing.find((item) => item.slug === slug && normalize(item.title) === normalize(title));
    if (!resumable && existing.some((item) => normalize(item.title) === normalize(title) &&
      (item.library_ids?.length ? item.library_ids : [item.library_id]).some((id) => libraryIds.includes(id)))) {
      throw new AppError(409, 'A collection with this name already exists in a selected library. Choose a different title.');
    }
    return resumable;
  }
  const planImport = async (options) => Boolean(await existingImport(options.title, options.libraryIds, importSlug(options)));
  async function publish({ detail, title, libraryIds, members, poster, description, backdrop, customBackdrop = false, sync = false, sort }) {
    const slug = importSlug({ detail, title, libraryIds, sync });
    if (active.has(slug)) throw new AppError(409, 'This collection is already being imported.');
    active.add(slug);
    let collection;
    try {
      const form = poster ? await prepareArtwork(poster.image, 'Poster artwork', poster.custom) : null;
      const customForm = customBackdrop ? await prepareArtwork(backdrop, 'Backdrop', true) : null;
      collection = await existingImport(title, libraryIds, slug);
      const resuming = Boolean(collection);
      if (!collection) {
        const syncedSource = sync ? { collection_type: 'tmdb', source_url: `tmdb://collection/${detail.id}`,
          source_config: { mode: 'tmdb_collection', collection_id: Number(detail.id) }, sync_schedule: '0 4 * * *' } : null;
        collection = await call(collectionsPath, { method: 'POST', paced: true, body: {
          title, slug, library_ids: libraryIds, collection_type: 'manual', source_url: detail.url, description, sort_config: sortConfig(sort),
          ...syncedSource,
        } });
      }
      if (!collection?.id) throw new AppError(502, 'Silo did not return the new collection ID.');
      const path = collectionPath(collection.id);
      if (!sync) {
        const existing = resuming ? await collectionMemberIds(collection.id) : new Set();
        for (const [position, item] of members.entries()) {
          if (existing.has(item.content_id)) continue;
          await call(`${path}/items/${encodeURIComponent(item.content_id)}`, { method: 'PUT', paced: true, body: { position } });
        }
      }
      if (form) await call(path + '/poster', { method: 'PUT', paced: true, body: form });
      let warning;
      if (backdrop) {
        try {
          const wideArtwork = customForm ?? await prepareArtwork(backdrop, 'TMDb backdrop');
          await call(path + '/backdrop', { method: 'PUT', paced: true, body: wideArtwork });
        } catch { warning = 'The collection was saved, but its backdrop could not be uploaded.'; }
      }
      if (sync) {
        try {
          const status = await call(path + '/sync', { method: 'POST', paced: true });
          const syncState = status?.sync_run?.status ?? status?.status;
          if (['failed', 'error'].includes(syncState)) throw new Error('Sync failed');
        } catch { warning = [warning, 'The TMDb-synced collection was saved, but its first sync failed. Check the TMDb setup in Silo.'].filter(Boolean).join(' '); }
      }
      const result = { id: collection.id, title: collection.title, added: members.length };
      if (sync) result.synced = true;
      return warning ? { ...result, warning } : result;
    } catch (error) {
      if (collection?.id) {
        throw new AppError(error.status ?? 502, `Silo saved collection ${collection.id}, but the import did not finish. ${error instanceof AppError ? error.message : ''} Retry with the same title, libraries, and selected titles to resume.`, error.retryAfter);
      }
      throw error;
    } finally {
      active.delete(slug);
    }
  }
  return { libraries, catalog, publish, planImport, collections, getCollection, collectionMemberIds, appendAvailable,
    updateCollection, restoreCollection, sortCollections, requestMissingMedia, mediaRequestStatus };
}
