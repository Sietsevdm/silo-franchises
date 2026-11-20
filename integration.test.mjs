import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGallery, parseTVIndex, parseTVMembers } from './providers.mjs';
import { matchMembers, siloClient } from './silo.mjs';

test('extracts official lists, franchise members and attributed gallery cards', () => {
  assert.equal(parseTVIndex('<h3><a href="/lists/power">Power Franchise</a></h3>')[0].id, 'power');
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
