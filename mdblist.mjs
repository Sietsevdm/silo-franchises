import { AppError } from './providers.mjs';

export function mdblistClient(apiKey) {
  async function get(path, params = {}) {
    if (!apiKey) throw new AppError(503, 'Set MDBLIST_API_KEY on the Silo Franchises server to search MDBList.');
    const url = new URL(path, 'https://api.mdblist.com');
    url.search = new URLSearchParams({ ...params, apikey: apiKey });
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (response.status === 401 || response.status === 403) throw new AppError(502, 'MDBList rejected the configured API key or denied access to the list.');
      if (response.status === 404) throw new AppError(404, 'That MDBList list is no longer available.');
      if (response.status === 429) throw new AppError(429, 'MDBList rate limit reached. Try again later.');
      if (!response.ok) throw new Error();
      return { data: await response.json(), more: response.headers.get('X-Has-More') === 'true' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'Could not read MDBList. Try again shortly.');
    }
  }

  async function search(query) {
    let listPath;
    if (/^https?:\/\//i.test(query)) {
      const link = URL.parse(query);
      const match = link?.pathname.match(/^\/lists\/([\w-]+)\/([\w-]+)\/?$/);
      if (!match || !['mdblist.com', 'www.mdblist.com'].includes(link.hostname) ||
        link.username || link.password || link.port) {
        throw new AppError(400, 'Paste an MDBList list link or enter a list name.');
      }
      listPath = '/lists/' + match[1] + '/' + match[2];
    }
    const { data } = await (listPath ? get(listPath) : get('/lists/search', { query }));
    if (!Array.isArray(data)) throw new AppError(502, 'MDBList returned an unexpected search response.');
    const lists = data.filter((list) => Number.isSafeInteger(list?.id) && list.id > 0 && typeof list.name === 'string')
      .slice(0, 40).map((list) => ({ id: list.id, name: list.name, owner: list.user_name, count: list.items }));
    if (!listPath || lists.length < 2) return lists;
    return [{ ...lists[0], ids: lists.map(({ id }) => id), count: lists.reduce((sum, list) => sum + (Number(list.count) || 0), 0) }];
  }

  async function members(id) {
    const entries = [];
    const limit = 1000;
    for (let offset = 0; offset < 10_000; offset += limit) {
      const { data, more } = await get('/lists/' + id + '/items', { limit, offset, unified: 'true' });
      if (!Array.isArray(data)) throw new AppError(502, 'MDBList returned an unexpected list response.');
      for (const item of data) {
        const type = item.mediatype === 'show' ? 'series' : item.mediatype === 'movie' ? 'movie' : null;
        if (!type || typeof item.title !== 'string') continue;
        entries.push({
          title: item.title, type, year: item.release_year,
          tmdb: item.ids?.tmdb ?? item.tmdb_id ?? item.id,
          imdb: item.ids?.imdb ?? item.imdb_id,
          tvdb: item.ids?.tvdb ?? item.tvdb_id,
        });
      }
      if (!more) return entries;
    }
    throw new AppError(422, 'This MDBList list exceeds 10,000 entries. Choose a smaller list.');
  }

  return { search, members };
}
