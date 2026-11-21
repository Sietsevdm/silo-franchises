import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedFranchiseTitle, galleryUrl, parseGallery, parseTVIndex, parseTVMembers, providers } from './providers.mjs';
import { eligibleCollection, matchMembers, previewKind, siloClient } from './silo.mjs';
import { publicArtworkUrl } from './remote-artwork.mjs';

test('extracts official lists, franchise members and attributed gallery cards', () => {
  assert.equal(parseTVIndex('<h3><a href="/lists/power">Power Franchise</a></h3>')[0].id, 'power');
  assert.equal(parseTVIndex('<h3><a href="/lists/power">Power Franchise</a></h3><i class="fa fa-star" aria-hidden="true"></i> 1,250')[0].stars, 1250);
  assert.equal(parseTVMembers('<h3 class="mt-0"><a href="/series/power">Power</a></h3>')[0].type, 'series');
  const gallery = parseGallery(`<div class="hovereffect rounded-poster">
  <source srcset="https://images.theposterdb.com/prod/public/images/posters/optimized/collections/1/poster.jpg">
  <div data-poster-id='22'><p class="p-0 mb-1 text-break">Rock &amp; Roll</p>
  <a rel="next">Next</a>`);
  assert.equal(gallery.items[0].title, 'Rock & Roll');
  assert.equal(gallery.items[0].url, 'https://theposterdb.com/poster/22');
  assert.equal(gallery.more, true);
});

test('provider ID matching respects media type and rejects conflicting fallback IDs', () => {
  const catalog = [
    { content_id: 'm1', type: 'movie', title: 'Example', year: 2001, tmdb_id: '10' },
    { content_id: 's1', type: 'series', title: 'Example', year: 2001, tmdb_id: '10' },
  ];
  const [correct, incorrect] = matchMembers([
    { type: 'movie', title: 'Example', tmdb: '10' },
    { type: 'movie', title: 'Example', year: '2001', tmdb: '11' },
  ], catalog);
  assert.equal(correct.match.content_id, 'm1');
  assert.equal(incorrect.match, undefined);
});

test('creates a manual collection and resumes after an interrupted artwork upload', async (t) => {
  let collection;
  let uploads = 0;
  let creates = 0;
  const members = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https://images.theposterdb.com/')) {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(Uint8Array.from([255, 216, 255, 224]));
    }
    assert.equal(options.headers.Authorization, 'Bearer fake-silo-key');
    const path = new URL(url).pathname;
    if (path === '/api/v2/admin/collections' && options.method === 'GET') return Response.json({ items: collection ? [collection] : [] });
    if (path === '/api/v2/admin/collections' && options.method === 'POST') {
      creates++;
      collection = { id: 'test', ...JSON.parse(options.body) };
      assert.equal(collection.collection_type, 'manual');
      assert.deepEqual(collection.library_ids, ['1']);
      return Response.json(collection, { status: 201 });
    }
    if (path === '/api/v2/admin/collections/test/items/m1') {
      assert.equal(options.method, 'PUT');
      members.push(JSON.parse(options.body).position);
      return new Response(null, { status: 204 });
    }
    if (path === '/api/v2/admin/collections/test/poster') {
      assert.equal(options.method, 'PUT');
      assert.equal(options.body.get('image').type, 'image/jpeg');
      if (++uploads === 1) return new Response(null, { status: 503 });
      return Response.json(collection);
    }
    throw new Error(`Unexpected route: ${path}`);
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const data = { detail: { provider: 'tmdb', id: '10', url: 'https://www.themoviedb.org/collection/10' },
    title: 'Example', libraryIds: ['1'], members: [{ content_id: 'm1' }],
    poster: { image: 'https://images.theposterdb.com/example.jpg' } };
  await assert.rejects(silo.publish(data), /collection test exists.*Retry/i);
  assert.deepEqual(await silo.publish(data), { id: 'test', title: 'Example', added: 1 });
  assert.equal(creates, 1);
  assert.deepEqual(members, [0, 0]);
});

test('editing uses the selected collection and rejects stale data before patching', async (t) => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/v2/admin/collections/42');
    if (options.method === 'GET') return Response.json({ id: '42', title: 'Old' }, { headers: { ETag: '"v2"' } });
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers['If-Match'], '"v2"');
    assert.deepEqual(JSON.parse(options.body), { title: 'New', description: 'Edited' });
    writes++;
    return Response.json({ id: '42', title: 'New' });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const input = { id: '42', title: 'New', description: 'Edited' };
  await assert.rejects(silo.updateCollection({ ...input, etag: '"v1"' }), { status: 412 });
  assert.deepEqual(await silo.updateCollection({ ...input, etag: '"v2"' }), { id: '42', title: 'New' });
  assert.equal(writes, 1);
});

test('catalog previews retry rate limits and share a media-filtered per-library cache', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const request = new URL(url);
    assert.equal(request.pathname, '/api/v2/admin/catalog/items');
    assert.equal(request.searchParams.get('type'), 'series');
    const cursor = request.searchParams.get('cursor');
    calls.push(cursor);
    if (calls.length === 2) return new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
    return Response.json({
      items: [{ content_id: cursor ? 'second' : 'first', type: 'series' }],
      page: cursor ? { has_more: false } : { has_more: true, next_cursor: 'next' },
    });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const expected = [{ content_id: 'first', type: 'series' }, { content_id: 'second', type: 'series' }]
    .map((item) => ({ ...item, previewLibraryIds: ['1'] }));
  const results = await Promise.all([silo.catalog(['1'], 'series'), silo.catalog(['1'], 'series')]);
  assert.deepEqual(results, [expected, expected]);
  assert.deepEqual(await silo.catalog(['1'], 'series'), expected);
  assert.deepEqual(calls, [null, 'next', 'next']);
});

test('preview attribution shows both libraries for shared items and flags distinct matching copies', async (t) => {
  const item = (id, providerId) => ({ content_id: id, type: 'series', title: id, tvdb_id: providerId });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const library = new URL(url).searchParams.get('library_id');
    return Response.json({ items: [item('shared', '10'), item(`copy-${library}`, '20'),
      ...(library === 'standard' ? [item('standard-only', '30')] : [])] });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const catalog = await silo.catalog(['standard', '4k'], 'series');
  const results = matchMembers(['10', '20', '30', '40'].map((tvdb) => ({ tvdb, title: tvdb, type: 'series' })), catalog);
  assert.deepEqual(results.map((result) => result.libraryIds ?? []), [
    ['standard', '4k'], ['standard', '4k'], ['standard'], [],
  ]);
  assert.equal(results[0].match.content_id, 'shared');
  assert.equal(results[1].basis, 'Ambiguous provider IDs');
  assert.equal(results[1].match, undefined);
  assert.equal(results[3].basis, 'Missing');
});

test('new collections require two distinct selected titles per library for movies and series', () => {
  for (const type of ['movie', 'series']) {
    const members = [
      { content_id: 'a', type, previewLibraryIds: ['regular', '4k'] },
      { content_id: 'b', type, previewLibraryIds: ['regular'] },
      { content_id: 'c', type, previewLibraryIds: ['other'] },
    ];
    assert.deepEqual(eligibleCollection(['regular', '4k', 'other'], members), {
      libraryIds: ['regular'], skipped: ['4k', 'other'], members: members.slice(0, 2),
    });
    assert.deepEqual(eligibleCollection(['regular', '4k'], [members[0], members[0]]).libraryIds, []);
  }
});

test('editing a manual collection appends only new items from its libraries', async (t) => {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'GET' && path.endsWith('/items')) {
      return Response.json({ items: [{ media_item_id: 'old', position: 4 }] });
    }
    if (options.method === 'GET') {
      return Response.json({ id: '42', collection_type: 'manual', library_ids: ['regular'] }, { headers: { ETag: '"v2"' } });
    }
    writes.push([options.method, path, JSON.parse(options.body)]);
    return options.method === 'PUT' ? new Response(null, { status: 204 }) : Response.json({ id: '42' });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const input = { id: '42', etag: '"v2"', title: 'Example', description: '' };
  await assert.rejects(silo.updateCollection({ ...input, members: [{ content_id: 'foreign', previewLibraryIds: ['4k'] }] }), { status: 422 });
  const result = await silo.updateCollection({ ...input, members: [
    { content_id: 'old', previewLibraryIds: ['regular'] },
    { content_id: 'new', previewLibraryIds: ['regular'] },
  ] });
  assert.equal(result.added, 1);
  assert.deepEqual(writes.map(([method, path]) => [method, path]), [
    ['PATCH', '/api/v2/admin/collections/42'], ['PUT', '/api/v2/admin/collections/42/items/new'],
  ]);
  assert.equal(writes[1][2].position, 5);
});

test('poster selections stay bound to their allowlisted creator', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    const creator = url.pathname.split('/').at(-1);
    requested.push(creator);
    assert.equal(url.searchParams.get('category'), 'Collections');
    const id = creator === 'XDM' ? '11' : '22';
    return new Response(`<div class="hovereffect rounded-poster">
      <source srcset="https://images.theposterdb.com/prod/public/images/posters/optimized/collections/1/poster.jpg">
      <div data-poster-id='${id}'><p class="p-0 mb-1 text-break">Example</p>`);
  });
  const source = providers();
  assert.throws(() => galleryUrl('unknown'), { status: 400 });
  const page = await source.galleryPage('XDM', 1);
  assert.equal(page.items[0].creator, 'XDM');
  assert.equal((await source.posterById('11', 'XDM')).id, '11');
  assert.equal(await source.posterById('11', 'mikenobbs'), undefined);
  assert.deepEqual(requested, ['XDM', 'mikenobbs']);
  assert.deepEqual(await source.galleryPage('mikenobbs', 2), { items: [], more: false });
});

test('TMDb falls back to the previous public export and resolves collection artwork separately', async (t) => {
  const exports = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'files.tmdb.org') {
      assert.equal(options.headers.Authorization, undefined);
      exports.push(target.pathname);
      if (exports.length === 1) return new Response(null, { status: 403 });
      return new Response('{"id":10,"name":"Star Wars Collection"}\n');
    }
    assert.equal(target.pathname, '/3/collection/10');
    assert.equal(options.headers.Authorization, 'Bearer fake-tmdb-token');
    return Response.json({ name: 'Star Wars Collection', overview: 'Franchise description', backdrop_path: '/star-wars.jpg',
      parts: [{ id: 11, title: 'Star Wars', release_date: '1977-05-25' }] });
  });
  const p = providers('fake-tmdb-token');
  assert.equal((await p.movieIndex())[0].title, 'Star Wars Collection');
  assert.equal(exports.length, 2);
  assert.notEqual(exports[0], exports[1]);
  const metadata = await p.metadata('tmdb:10:movie');
  assert.equal(metadata.description, 'Franchise description');
  assert.equal(metadata.backdrop, 'https://image.tmdb.org/t/p/w1280/star-wars.jpg');
});

test('new Silo collections get the selected description and TMDb backdrop', async (t) => {
  const routes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname !== 'example.test') {
      assert.equal(options.headers.Authorization, undefined);
      return new Response(Uint8Array.from([255, 216, 255, 224]));
    }
    routes.push([options.method, target.pathname]);
    if (options.method === 'GET') return Response.json({ items: [] });
    if (options.method === 'POST') {
      assert.equal(JSON.parse(options.body).description, 'A TMDb description');
      return Response.json({ id: 'example', title: 'Example' }, { status: 201 });
    }
    if (target.pathname.includes('/items/')) return new Response(null, { status: 204 });
    assert.equal(options.body.get('image').type, 'image/jpeg');
    return Response.json({ id: 'example' });
  });
  const silo = siloClient('https://example.test', 'fake-silo-key');
  await silo.publish({ detail: { provider: 'tmdb', id: '10' }, title: 'Example', libraryIds: ['1'],
    members: [{ content_id: 'm1' }], poster: { image: 'https://images.theposterdb.com/poster.jpg' },
    description: 'A TMDb description', backdrop: 'https://image.tmdb.org/t/p/w1280/art.jpg' });
  assert.deepEqual(routes.at(-1), ['PUT', '/api/v2/admin/collections/example/backdrop']);
});

test('TV franchise metadata comes from TheTVDB and leaves the backdrop blank', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = new URL(url);
    assert.equal(target.hostname, 'thetvdb.com');
    if (target.pathname === '/lists') return new Response('<h3><a href="/lists/power">Power Franchise</a></h3>');
    return new Response('<div class="change_translation_text" data-language="eng"><p>Power &amp; its spin-offs.</p></div>' +
      '<h3><a href="/series/power">Power</a></h3>');
  });
  assert.deepEqual(await providers().metadata('tvdb:power:series'), {
    kind: 'tvdb', title: 'Power Franchise', description: 'Power & its spin-offs.', backdrop: '', url: 'https://thetvdb.com/lists/power',
  });
});

test('movie backdrop choices cover each film and deduplicate shared images', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    if (path === '/3/collection/10') return Response.json({ name: 'Example', parts: [{ id: 11, title: 'First' }, { id: 12, title: 'Second' }] });
    const second = path === '/3/movie/12';
    return Response.json({ title: second ? 'Second' : 'First', backdrop_path: '/shared.jpg',
      images: { backdrops: [{ file_path: second ? '/second.jpg' : '/first.jpg' }] } });
  });
  const result = await providers('fake-token').backdrops('tmdb:10:movie');
  assert.deepEqual(result.items.map(({ path, film }) => [path, film]), [
    ['/shared.jpg', 'First'], ['/first.jpg', 'First'], ['/second.jpg', 'Second'],
  ]);
});

test('custom backdrop inputs require a direct HTTPS URL without a local host or credentials', () => {
  assert.equal(publicArtworkUrl('https://images.example.com/backdrop.jpg').hostname, 'images.example.com');
  for (const url of ['http://images.example.com/backdrop.jpg', 'https://127.0.0.1/image',
    'https://storage.internal/image', 'https://user:password@images.example.com/image', 'https://images.example.com:4433/image']) {
    assert.throws(() => publicArtworkUrl(url), { status: 400 });
  }
});

test('opt-in TMDb sync creates a native Silo collection and lets Silo populate it', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'images.theposterdb.com') return new Response(Uint8Array.from([255, 216, 255, 224]));
    calls.push([options.method, target.pathname]);
    if (options.method === 'GET') return Response.json({ items: [] });
    if (target.pathname === '/api/v2/admin/collections') {
      const data = JSON.parse(options.body);
      assert.equal(data.collection_type, 'tmdb');
      assert.equal(data.source_url, 'tmdb://collection/10');
      assert.deepEqual(data.source_config, { mode: 'tmdb_collection', collection_id: 10 });
      assert.equal(data.sync_schedule, '0 4 * * *');
      return Response.json({ id: 'new', title: 'Example' }, { status: 201 });
    }
    return Response.json({ status: 'success' });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  const result = await silo.publish({ detail: { provider: 'tmdb', id: '10' }, title: 'Example', libraryIds: ['1'],
    members: [{ content_id: 'm1' }, { content_id: 'm2' }], poster: { image: 'https://images.theposterdb.com/poster.jpg' }, sync: true });
  assert.equal(result.synced, true);
  assert.deepEqual(calls.slice(-2), [['PUT', '/api/v2/admin/collections/new/poster'], ['POST', '/api/v2/admin/collections/new/sync']]);
  assert.equal(calls.some(([, path]) => path.includes('/items/')), false);
});

test('browsing excludes configured writing systems and preview limits libraries by type and name', () => {
  assert.equal(allowedFranchiseTitle('Amélie Collection'), true);
  for (const title of ['Example 東京', 'スター・ウォーズ', '영화', 'Коллекция']) {
    assert.equal(allowedFranchiseTitle(title), false);
  }
  assert.equal(previewKind({ type: 'movies', name: 'Movies 4K' }), 'movie');
  assert.equal(previewKind({ type: 'series', name: 'TV Shows - Anime' }), 'series');
  for (const name of ['Movies - Anime', 'Movies - PPV/Sports', 'Movies - Foreign',
    'Movies - 4K (Special Editions)', 'Movies - Special Editions']) {
    assert.equal(previewKind({ type: 'movies', name }), null);
  }
  assert.equal(previewKind({ type: 'mixed', name: 'Mixed' }), null);
});

test('saving A–Z writes Silo’s collection default sort configuration', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'GET') return Response.json({ id: '42' }, { headers: { ETag: '"v2"' } });
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body).sort_config, { field: 'title', order: 'asc' });
    return Response.json({ id: '42' });
  });
  const silo = siloClient('https://example.test/', 'fake-silo-key');
  await silo.updateCollection({ id: '42', title: 'Example', description: '', etag: '"v2"', sort: 'title' });
});
