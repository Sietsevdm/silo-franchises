const el = (id) => document.getElementById(id);
const status = (id, text) => { el(id).textContent = text; };
const create = (tag, text) => Object.assign(document.createElement(tag), { textContent: text ?? '' });
const checked = (container) => [...el(container).querySelectorAll('input:checked')].map((input) => input.value);
const route = location.pathname;
const bulkPage = route === '/bulk' || route.startsWith('/bulk/');
const settingsPage = route === '/settings';
const browsePage = !bulkPage && !settingsPage;
const kind = route.endsWith('/tv') ? 'series' : 'movie';
const browsePath = kind === 'series' ? '/tv' : '/movies';
const queuePath = '/bulk' + browsePath;
const state = { provider: kind === 'series' ? 'tvdb' : 'tmdb', selected: new Map(), drafts: new Map(), edits: new Map(), hidden: new Map(), existing: [], libraries: [], rows: [] };
const titleKey = (title) => title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\b(?:franchise|collection|universe)\s*$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const sourceKey = (url) => (url ?? '').replace(/^tmdb:\/\/collection\//, 'themoviedb.org/collection/')
  .replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '');
function franchiseFromCollection(collection) {
  const source = sourceKey(collection.sourceUrl);
  const movie = source.match(/^themoviedb\.org\/collection\/(\d+)(?:-[\w-]+)?$/);
  const tvdb = source.match(/^thetvdb\.com\/lists\/([\w-]+)$/);
  if (movie && kind === 'movie') return { provider: 'tmdb', id: movie[1] };
  if (tvdb) return { provider: 'tvdb', id: tvdb[1] };
  return null;
}
const itemKey = ({ provider, id }) => `${provider}:${id}`;
const inputCheck = (value, selected, action) => Object.assign(create('input'), { type: 'checkbox', value, checked: selected, onchange: action });
const sortedTitles = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
const presetKey = 'silo-library-presets-' + kind;
const historyKey = 'silo-bulk-history-' + kind;
const presets = new Map(stored(presetKey, []));
const history = stored(historyKey, []);
try { el('hide-existing').checked = localStorage.getItem('silo-hide-existing') === 'true'; } catch {}
el('title-language').value = stored('silo-title-language-' + kind, 'en-nl');
if (!el('title-language').value) el('title-language').value = 'en-nl';

async function api(route, options = {}) {
  const response = await fetch('/api/' + route, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The request failed.');
  return value;
}
const params = (object) => new URLSearchParams(object).toString();
const post = (route, body) => api(route, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Franchise-App': '1' }, body: JSON.stringify(body),
});
const requestFor = (item, libraryIds) => ({ provider: item.provider, id: item.id, kind, libraryIds });
const matchesFor = (item) => state.existing.filter((collection) => {
  if (!isCurrentKind(collection) && !collection.libraryIds.some((id) => state.libraries.some((lib) => lib.id === id && lib.type === 'mixed'))) return false;
  const keys = [item.title, item.originalTitle].filter(Boolean).map(titleKey).filter(Boolean);
  return sourceKey(collection.sourceUrl) === sourceKey(item.url) || keys.includes(titleKey(collection.title));
});
function isCurrentKind(collection) {
  if (Array.isArray(state.libraryPreference) && !collection.libraryIds.some((id) => state.libraryPreference.includes(id))) return false;
  if (collection.sourceUrl?.includes('themoviedb.org/collection/')) return kind === 'movie';
  return collection.libraryIds.some((id) => {
    const type = state.libraries.find((lib) => lib.id === id)?.type;
    return (kind === 'movie' ? /^(movie|movies|film|films)$/i : /^(tv|series|shows|tvshows|tv_shows)$/i).test(type ?? '');
  });
}

function action(text, run, className = '') {
  const button = create('button', text);
  Object.assign(button, { type: 'button', onclick: run, className });
  return button;
}

function drawRows() {
  const target = el('franchises');
  target.replaceChildren();
  const visible = visibleRows();
  for (const item of visible) {
    const row = create('div');
    row.className = 'franchise-row';
    if (item.provider === 'silo') {
      row.append(action(item.title, () => openExisting(item), 'row-title'), action('Edit', () => openExisting(item), 'edit'));
    } else {
      const existing = matchesFor(item);
      const key = itemKey(item);
      const box = inputCheck(key, state.selected.has(key), () => {
        if (box.checked) state.selected.set(key, item);
        else { state.selected.delete(key); state.drafts.delete(key); }
        drawQueue();
      });
      box.setAttribute('aria-label', 'Select ' + item.title);
      box.disabled = Boolean(existing.length) || state.busy;
      row.append(box, action(item.title, () => openFranchise(item), 'row-title'));
      row.classList.toggle('active', !!state.current && itemKey(state.current) === key);
      for (const collection of existing) {
        const edit = action('In Silo · Edit', () => openExisting(collection, item), 'edit');
        edit.title = collection.title;
        row.append(edit);
      }
      const hide = action('Hide', () => changeHidden(item, true, hide), 'hide-franchise');
      hide.setAttribute('aria-label', 'Hide ' + item.title);
      hide.disabled = !state.hiddenReady;
      row.append(hide);
    }
    target.append(row);
  }
  if (state.rows.length && !visible.length) target.append(create('p', 'No visible results on these pages.'));
  drawQueue();
}
function visibleRows() {
  if (state.provider === 'silo') return state.rows;
  return state.rows.filter((item) => !state.hidden.has(itemKey(item)) &&
    (!el('hide-existing').checked || !matchesFor(item).length));
}

async function loadHidden() {
  try {
    state.hidden = new Map((await api('hidden-franchises?' + params({ kind }))).map((item) => [itemKey(item), item]));
    state.hiddenReady = true;
    drawHidden();
    drawRows();
  } catch (error) { status('hidden-status', error.message); }
}

function drawHidden() {
  el('hidden-franchises').hidden = state.provider === 'silo' || !state.hidden.size;
  status('hidden-summary', 'Hidden franchises (' + state.hidden.size + ')');
  const rows = [...state.hidden.values()].sort((a, b) => sortedTitles.compare(a.title, b.title));
  el('hidden-rows').replaceChildren(...rows.map((item) => {
    const row = create('div');
    row.className = 'queue-row';
    const restore = action('Restore', () => changeHidden(item, false, restore));
    restore.setAttribute('aria-label', 'Restore ' + item.title);
    row.append(create('span', item.title), create('small', item.provider === 'tmdb' ? 'TMDb' : 'TheTVDB'), restore);
    return row;
  }));
}

async function changeHidden(item, hidden, button) {
  button.disabled = true;
  try {
    await post('hidden-franchises', { kind, provider: item.provider, id: item.id, title: item.title, hidden });
    if (hidden) state.hidden.set(itemKey(item), item);
    else state.hidden.delete(itemKey(item));
    drawHidden();
    drawRows();
    status('hidden-status', item.title + (hidden ? ' hidden.' : ' restored.'));
  } catch (error) { status('hidden-status', error.message); }
  finally { button.disabled = false; }
}

function drawPagination(result) {
  const navigation = el('franchise-pages');
  const active = state.page;
  if (result.more && result.next != null) state.pageCursors.set(active + 1, result.next);
  const count = result.total == null ? Math.max(...state.pageCursors.keys())
    : Math.ceil(result.total / (state.provider === 'silo' ? 24 : 48));
  const button = (text, page, disabled = false) => {
    const element = action(text, () => listFranchises(false, page));
    element.disabled = disabled;
    return element;
  };
  const numbers = [];
  for (let page = Math.max(1, active - 3); page <= Math.min(count, active + 3); page++) {
    const element = button(String(page), page, page === active);
    element.setAttribute('aria-label', 'Page ' + page);
    if (page === active) element.setAttribute('aria-current', 'page');
    numbers.push(element);
  }
  navigation.replaceChildren();
  if (count > 1) navigation.append(button('Previous', active - 1, active === 1),
    ...numbers, button('Next', active + 1, active >= count));
}

async function listFranchises(reset, page = 1) {
  const run = state.franchiseRun = Symbol();
  for (const button of el('franchise-pages').querySelectorAll('button')) button.disabled = true;
  if (reset) {
    state.pageCursors = new Map([[1, 0]]);
    state.query = el('franchise-query').value.trim();
    state.sort = el('franchise-sort').value;
    state.language = el('title-language').value;
    state.rows = [];
    drawRows();
  }
  state.page = page;
  status('franchise-status', 'Loading…');
  try {
    if (state.provider === 'silo' && state.existingError) throw new Error(state.existingError);
    let result;
    if (state.provider === 'silo') {
      const items = state.existing.filter((item) => item.browseable !== false && isCurrentKind(item) && item.title.toLowerCase().includes(state.query.toLowerCase()))
        .map((item) => ({ ...item, provider: 'silo' }));
      if (state.sort === 'title-asc' || state.sort === 'title-desc') {
        const direction = state.sort === 'title-asc' ? 1 : -1;
        items.sort((a, b) => direction * sortedTitles.compare(a.title, b.title));
      }
      result = { items: items.slice((page - 1) * 24, page * 24), total: items.length };
    } else {
      result = await api('franchises?' + params({ provider: state.provider, kind, q: state.query, page: state.page,
        cursor: state.pageCursors.get(page) ?? 0, sort: state.sort, language: state.language }));
    }
    if (state.franchiseRun !== run) return;
    state.rows = result.items;
    drawRows();
    drawPagination(result);
    status('franchise-status', state.rows.length ? '' : result.more ? 'No matches on this page. Choose the next page to continue.' : 'No collections found.');
    if (!reset) {
      el('browse-panel').scrollTop = 0;
      if (matchMedia('(max-width: 1100px)').matches) el('page-title').scrollIntoView({ block: 'start' });
    }
  } catch (error) {
    if (state.franchiseRun === run) {
      status('franchise-status', error.message);
      for (const button of el('franchise-pages').querySelectorAll('button')) {
        if (!button.hasAttribute('aria-current')) button.disabled = false;
      }
    }
  }
}

async function refreshExisting() {
  try { state.existing = await api('collections'); state.existingError = ''; }
  catch (error) { state.existingError = error.message; }
  drawCollectionHealth();
  if (state.provider === 'silo') await listFranchises(true);
  else drawRows();
}

function drawCollectionHealth() {
  if (!el('collection-health').open) return;
  const collections = state.existing.filter(isCurrentKind).sort((a, b) => sortedTitles.compare(a.title, b.title));
  const missing = collections.filter((item) => !item.hasPoster || !item.hasBackdrop);
  status('health-summary', state.existingError || (missing.length + ' of ' + collections.length + ' collections are missing artwork.'));
  const rows = el('health-artwork').checked ? missing : collections;
  el('health-rows').replaceChildren(...rows.map((item) => {
    const row = create('article');
    const artwork = [!item.hasPoster && 'No custom poster', !item.hasBackdrop && 'No backdrop',
      ['failed', 'error'].includes(item.syncStatus) && 'Sync failed'].filter(Boolean);
    const result = create('div');
    const button = action('Check titles', async () => {
      button.disabled = true;
      result.textContent = 'Checking linked franchise…';
      try {
        const value = await api('collection-health?' + params({ id: item.id, kind }));
        result.replaceChildren();
        if (value.requests.length) {
          const requests = create('details');
          requests.open = true;
          const list = create('ul');
          for (const item of value.requests) {
            const label = item.added ? 'In this collection' : item.status === 'pending' ? 'Awaiting approval' : item.status.replaceAll('_', ' ');
            const row = create('li');
            const title = create('a', item.title);
            Object.assign(title, { href: item.url, target: '_blank', rel: 'noopener' });
            row.append(title, document.createTextNode(' · ' + label + (item.statusError ? ' · ' + item.statusError : '') +
              (item.requestId ? ' · Request #' + item.requestId : '')));
            list.append(row);
          }
          const link = create('a', 'Open Silo Requests');
          Object.assign(link, { href: value.requestQueueUrl, target: '_blank', rel: 'noopener' });
          requests.append(create('summary', value.autoAdd ? 'Requests · auto-add enabled' : 'Requests'), list, link);
          if (value.autoAddError) requests.append(create('p', value.autoAddError));
          if (value.canAutoAdd) {
            const toggle = action(value.autoAdd ? 'Turn off auto-add' : 'Turn on auto-add', async () => {
              toggle.disabled = true;
              try {
                await post('auto-add', { collectionId: item.id, enabled: !value.autoAdd });
                await button.onclick();
              } catch (error) {
                requests.append(create('p', error.message));
                toggle.disabled = false;
              }
            });
            requests.append(document.createTextNode(' '), toggle);
          }
          result.append(requests);
        }
        if (!value.checked) { result.append(create('p', value.reason)); return; }
        let issues = 0;
        for (const [label, entries] of [
          ['Missing from eligible libraries', value.missing], ['Needs a manual match', value.ambiguous],
          ['Available to add', value.available],
        ]) {
          if (!entries.length) continue;
          issues++;
          const list = create('ul');
          for (const title of entries) list.append(create('li', title));
          const details = create('details');
          details.append(create('summary', label + ' (' + entries.length + ')'), list);
          result.append(details);
        }
        if (!issues) result.append(create('p', 'All linked titles are in this collection.'));
      } catch (error) { result.textContent = error.message; }
      finally { button.disabled = false; }
    });
    row.append(action(item.title, () => openExisting(item), 'row-title'),
      create('p', artwork.join(' · ') || 'Artwork complete'), button, result);
    return row;
  }));
}
el('collection-health').ontoggle = drawCollectionHealth;
el('health-artwork').onchange = drawCollectionHealth;

function openPanel(title, editing) {
  document.body.classList.add('editor-open');
  el('work-panel').hidden = false;
  el('artwork-panel').hidden = false;
  el('close-editor').hidden = false;
  state.comparison = new Map();
  drawPosterComparison();
  el('selection-empty').hidden = true;
  el('selection').hidden = false;
  el('poster-tools').hidden = false;
  el('membership').hidden = editing;
  for (const check of el('libraries').querySelectorAll('input')) {
    check.disabled = false;
    check.closest('label').hidden = false;
  }
  status('library-eligibility', '');
  el('description-field').hidden = false;
  el('description').value = '';
  state.descriptionDirty = false;
  state.metadataLoaded = false;
  state.metadataRun = null;
  el('tmdb-backdrop').hidden = true;
  el('tmdb-backdrop').removeAttribute('src');
  state.defaultBackdrop = '';
  state.selectedBackdrop = null;
  state.backdropRun = null;
  state.backdropOptions = [];
  el('backdrop-options').replaceChildren();
  el('more-backdrops').hidden = true;
  el('tv-backdrop-tools').hidden = kind !== 'series';
  el('tv-backdrop-url').value = '';
  el('movie-backdrop-tools').hidden = true;
  status('backdrop-status', '');
  el('sync-field').hidden = true;
  el('request-missing-field').hidden = editing;
  el('request-missing').checked = false;
  el('auto-add-requested').checked = false;
  el('automation-options').open = false;
  el('automation-options').hidden = editing;
  updateAutoAdd();
  el('undo-edit').hidden = true;
  el('sync-tmdb').checked = false;
  el('sync-note').hidden = true;
  state.customPosterRun = null;
  el('custom-poster-url').value = '';
  el('custom-poster-preview').disabled = false;
  status('custom-poster-status', '');
  el('metadata-source').hidden = true;
  el('backdrop-field').hidden = true;
  el('include-backdrop').checked = kind === 'movie';
  status('metadata-status', '');
  status('selection-title', title);
  el('queue-current').textContent = editing ? 'Queue changes' : 'Save to bulk queue';
  el('publish').textContent = editing ? 'Save changes' : 'Add to Silo';
  el('collection-title').value = title;
  el('source-link').hidden = true;
  status('publish-status', '');
  invalidateMatches();
  showPoster(null);
  el('poster-query').value = title.replace(/\s+(?:collection|franchise|universe)$/i, '');
  void listPosters(true);
  if (matchMedia('(max-width: 1100px)').matches) el('work-panel').scrollIntoView({ block: 'start' });
}

el('close-editor').onclick = () => {
  state.current = null;
  state.editing = null;
  state.editFranchise = null;
  state.artworkFranchise = null;
  for (const run of ['editRun', 'metadataRun', 'backdropRun', 'posterRun', 'customPosterRun']) state[run] = null;
  invalidateMatches();
  if (bulkPage) document.body.classList.remove('editor-open');
  el('work-panel').hidden = bulkPage;
  el('artwork-panel').hidden = bulkPage;
  el('close-editor').hidden = true;
  el('selection').hidden = true;
  el('selection-empty').hidden = false;
  el('poster-tools').hidden = true;
  el('gallery-link').hidden = true;
  el('tmdb-backdrop').hidden = true;
  status('selection-title', 'Your collection');
  showPoster(null);
  drawRows();
  const heading = el(bulkPage ? 'batch-title' : 'page-title');
  heading.tabIndex = -1;
  heading.focus();
};

async function openFranchise(item) {
  state.editing = null;
  state.editFranchise = null;
  state.current = item;
  state.artworkFranchise = item;
  const draft = state.drafts.get(itemKey(item));
  openPanel(draft?.title ?? item.title, false);
  el('movie-backdrop-tools').hidden = kind !== 'movie';
  el('sync-field').hidden = kind !== 'movie' || item.provider !== 'tmdb';
  el('sync-tmdb').checked = draft?.sync === true;
  el('request-missing').checked = draft?.requestMissing === true;
  el('auto-add-requested').checked = draft?.autoAdd === true;
  updateAutoAdd();
  el('sync-note').hidden = !el('sync-tmdb').checked;
  if (draft) {
    for (const check of el('libraries').querySelectorAll('input')) check.checked = draft.libraryIds.includes(check.value);
    state.overrides = draft.overrides ?? {};
    renderMatches(draft.matches, draft.contentIds);
    showPoster(draft.poster);
    el('custom-poster-url').value = draft.poster?.customUrl ?? '';
    if (draft.description != null) {
      el('description').value = draft.description;
      state.descriptionDirty = true;
    }
    el('include-backdrop').checked = draft.includeBackdrop !== false;
    el('tv-backdrop-url').value = draft.backdropUrl ?? '';
    if (draft.selectedBackdrop) chooseBackdrop(draft.selectedBackdrop);
  }
  el('source-link').href = item.url;
  el('source-link').hidden = false;
  const existing = matchesFor(item);
  status('detail-status', existing.length ? 'A matching collection already exists. Use its Edit button in the list.' : 'Choose libraries, then preview the matching titles.');
  drawRows();
  void loadMetadata(item);
  updateActions();
}

async function loadMetadata(item) {
  const run = state.metadataRun = Symbol();
  status('metadata-status', kind === 'series' ? 'Loading TheTVDB description…' : 'Loading TMDb description and backdrop…');
  try {
    const metadata = await api('metadata?' + params({ provider: item.provider, id: item.id, kind }));
    if (state.metadataRun !== run) return;
    if (!metadata) { status('metadata-status', 'No matching description or artwork found.'); return; }
    state.metadataLoaded = true;
    if (!state.descriptionDirty) el('description').value = metadata.description.slice(0, 8000);
    if (metadata.backdrop) {
      state.defaultBackdrop = metadata.backdrop;
      if (!state.selectedBackdrop) showBackdrop(state.defaultBackdrop);
      el('backdrop-field').hidden = false;
    }
    const link = el('metadata-source');
    link.href = metadata.url;
    link.textContent = metadata.kind === 'tvdb' ? 'Description from TheTVDB'
      : metadata.kind === 'related' ? `TMDb metadata from ${metadata.title}` : 'Description and backdrop from TMDb';
    link.hidden = false;
    status('metadata-status', '');
  } catch (error) {
    if (state.metadataRun === run) status('metadata-status', error.message);
  }
}

function showBackdrop(url) {
  const image = el('tmdb-backdrop');
  image.hidden = !url;
  if (url) image.src = url;
  else image.removeAttribute('src');
}

function chooseBackdrop(option) {
  state.selectedBackdrop = option;
  if (option) {
    el('include-backdrop').checked = true;
    el('backdrop-field').hidden = !!state.editing;
  }
  showBackdrop(option?.image ?? state.defaultBackdrop);
  for (const element of el('backdrop-options').querySelectorAll('button')) {
    element.setAttribute('aria-pressed', String(element.dataset.path === option?.path));
  }
}

function appendBackdrops() {
  const container = el('backdrop-options');
  const offset = state.backdropShown ?? 0;
  for (const item of state.backdropOptions.slice(offset, offset + 18)) {
    const button = action('', () => chooseBackdrop(item));
    button.dataset.path = item.path;
    button.setAttribute('aria-pressed', String(state.selectedBackdrop?.path === item.path));
    const image = Object.assign(create('img'), { src: item.thumbnail, alt: '', loading: 'lazy', decoding: 'async' });
    button.append(image, create('span', item.film));
    container.append(button);
  }
  state.backdropShown = offset + 18;
  el('more-backdrops').hidden = state.backdropShown >= state.backdropOptions.length;
}

el('load-backdrops').onclick = async () => {
  const item = state.artworkFranchise;
  if (!item) return;
  const run = state.backdropRun = Symbol();
  el('backdrop-options').replaceChildren();
  el('more-backdrops').hidden = true;
  status('backdrop-status', 'Loading backdrops from the franchise’s movies…');
  try {
    const result = await api('backdrops?' + params({ provider: item.provider, id: item.id, kind }));
    if (state.backdropRun !== run) return;
    state.backdropOptions = result.items;
    state.backdropShown = 0;
    if (state.defaultBackdrop || state.editing) el('backdrop-options').append(
      action(state.editing ? 'Keep existing backdrop' : 'Use collection backdrop', () => chooseBackdrop(null), 'backdrop-reset'));
    appendBackdrops();
    status('backdrop-status', [result.items.length ? '' : 'No movie backdrops found.',
      result.unavailable.length ? `Could not load artwork for ${result.unavailable.length} movies.` : ''].filter(Boolean).join(' '));
  } catch (error) {
    if (state.backdropRun === run) status('backdrop-status', error.message);
  }
};
el('more-backdrops').onclick = appendBackdrops;

async function openExisting(item, franchise = null) {
  state.current = null;
  state.editing = null;
  state.editFranchise = null;
  state.artworkFranchise = null;
  openPanel(item.title, true);
  el('description').value = '';
  status('detail-status', 'Loading Silo collection…');
  const run = state.editRun = Symbol();
  try {
    const result = await api('collection?' + params({ id: item.id }));
    if (state.editRun !== run || state.current) return;
    state.editing = result;
    el('undo-edit').hidden = !result.canUndo;
    state.artworkFranchise = franchise ?? franchiseFromCollection(result);
    el('movie-backdrop-tools').hidden = kind !== 'movie' || !state.artworkFranchise;
    state.editFranchise = result.kind === 'manual' ? franchise ?? franchiseFromCollection(result) : null;
    if (state.editFranchise) {
      let available = 0;
      for (const check of el('libraries').querySelectorAll('input')) {
        check.checked = result.libraryIds.includes(check.value);
        check.disabled = true;
        check.closest('label').hidden = !check.checked;
        if (check.checked) available++;
      }
      el('membership').hidden = !available;
    }
    el('collection-title').value = result.title;
    el('description').value = result.description;
    const queued = state.edits.get(result.id);
    if (queued) {
      el('collection-title').value = queued.payload.title;
      status('selection-title', queued.payload.title);
      el('description').value = queued.payload.description;
      el('tv-backdrop-url').value = queued.payload.backdropUrl ?? '';
      showPoster(queued.poster);
      el('custom-poster-url').value = queued.poster?.customUrl ?? '';
      if (queued.backdrop) chooseBackdrop(queued.backdrop);
      if (state.editFranchise && queued.payload.contentIds?.length) {
        state.overrides = queued.payload.overrides ?? {};
        renderMatches(queued.matches, queued.payload.contentIds);
      }
    }
    status('detail-status', `Editing Silo collection · ${result.count ?? 0} titles${el('membership').hidden ? '' : ' · Preview library matches to add titles'}`);
    if (!state.poster) status('poster-label', 'Current artwork will be kept unless you select a replacement.');
    updateActions();
  } catch (error) {
    if (state.editRun === run && !state.current) status('detail-status', error.message);
  }
}

function invalidateMatches() {
  state.previewRun = null;
  state.overrides = {};
  closeManualMatch();
  el('missing-report').hidden = true;
  state.matches = [];
  el('matches').replaceChildren();
  status('match-status', '');
  status('library-eligibility', '');
  updateActions();
}

function renderMatches(result, chosen) {
  state.matches = result;
  el('matches').replaceChildren();
  const used = new Set();
  const missing = result.filter((item) => !item.contentId);
  el('missing-report').hidden = !missing.length;
  status('missing-summary', `Missing or ambiguous titles (${missing.length})`);
  el('missing-titles').replaceChildren(...missing.map((item) => create('li', item.title + (item.year ? ` (${item.year})` : ''))));
  for (const item of result) {
    const row = create(item.contentId ? 'label' : 'div');
    row.className = 'match';
    if (item.contentId && !used.has(item.contentId)) {
      const sync = el('sync-tmdb').checked;
      const checkbox = inputCheck(item.contentId, sync || !chosen || chosen.includes(item.contentId), updateActions);
      checkbox.disabled = sync;
      row.append(checkbox);
      used.add(item.contentId);
    } else row.classList.add('missing');
    const details = create('div');
    details.className = 'match-details';
    details.append(create('span', item.title + (item.year ? ` (${item.year})` : '')));
    if (item.libraries?.length) {
      const libraries = create('span');
      libraries.className = 'match-libraries';
      libraries.setAttribute('aria-label', 'Found in libraries');
      for (const name of item.libraries) libraries.append(create('span', name));
      details.append(libraries);
    }
    row.append(details, create('small', item.basis));
    if (!item.contentId && !el('sync-tmdb').checked) row.append(action('Match manually', () => startManualMatch(item)));
    el('matches').append(row);
  }
  status('match-status', `${used.size} of ${result.length} titles matched.`);
  updateActions();
}

function canImport() {
  return state.current && !matchesFor(state.current).length && state.poster &&
    [...libraryCounts(state.matches, checked('matches'), checked('libraries')).values()].some((count) => count >= 2);
}
function libraryCounts(matches, contentIds, libraryIds) {
  const selected = new Set(contentIds);
  const perLibrary = new Map(libraryIds.map((id) => [id, new Set()]));
  for (const match of matches ?? []) {
    if (!selected.has(match.contentId)) continue;
    for (const id of match.libraryIds ?? []) perLibrary.get(id)?.add(match.contentId);
  }
  return new Map([...perLibrary].map(([id, items]) => [id, items.size]));
}
function updateActions() {
  const valid = Boolean(el('collection-title').value.trim());
  el('publish').disabled = !!state.busy || !valid || !(state.editing || canImport());
  el('queue-current').disabled = !!state.busy || !valid || !(state.editing?.etag || canImport());
  el('undo-edit').disabled = !!state.busy;
  if (state.current && state.matches?.length) {
    const counts = libraryCounts(state.matches, checked('matches'), checked('libraries'));
    const summary = [...counts].map(([id, count]) => {
      const name = state.libraries.find((library) => library.id === id)?.name ?? id;
      return `${name}: ${count} selected${count < 2 ? ' (needs 2)' : ''}`;
    });
    status('library-eligibility', summary.join(' · '));
  } else status('library-eligibility', '');
}

async function loadLibraries() {
  status('library-status', 'Connecting to Silo…');
  try {
    const [libraries, preferences] = await Promise.all([api('libraries'), api('settings')]);
    state.libraries = libraries;
    state.libraryPreference = preferences.libraryIds;
    if (settingsPage) {
      for (const [type, target] of [['movie', 'settings-movies'], ['series', 'settings-tv']]) {
        const group = libraries.filter((lib) => lib.mediaKind === type);
        for (const lib of group) {
          const label = create('label');
          label.append(inputCheck(lib.id, preferences.libraryIds ? preferences.libraryIds.includes(lib.id) : lib.previewKind === type),
            document.createTextNode(lib.name));
          el(target).append(label);
        }
        if (!group.length) el(target).append(create('p', 'No eligible libraries found.'));
      }
      el('save-settings').disabled = false;
      return;
    }
    const eligible = libraries.filter((lib) => preferences.libraryIds
      ? lib.mediaKind === kind && preferences.libraryIds.includes(lib.id)
      : lib.previewKind === kind);
    if (bulkPage) {
      const previous = stored('silo-bulk-libraries-' + kind, []);
      for (const lib of eligible) {
        const label = create('label');
        label.append(inputCheck(lib.id, previous.includes(lib.id), () => {
          store('silo-bulk-libraries-' + kind, checked('bulk-libraries'));
          drawQueue();
        }), document.createTextNode(lib.name));
        el('bulk-libraries').append(label);
      }
      status('bulk-library-status', eligible.length ? '' : 'No enabled Silo libraries for this media type.');
    }
    el('order-library').replaceChildren(...eligible.map((lib) => new Option(lib.name, lib.id)));
    el('sort-collections').disabled = !eligible.length;
    drawPresets();
    for (const lib of eligible) {
      const label = create('label');
      label.append(inputCheck(lib.id, false, invalidateMatches), document.createTextNode(lib.name));
      el('libraries').append(label);
    }
    status('library-status', eligible.length ? '' : 'No enabled Silo libraries for this media type.');
  } catch (error) { status(settingsPage ? 'settings-status' : bulkPage ? 'bulk-library-status' : 'library-status', error.message); }
}
el('settings-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = el('save-settings');
  button.disabled = true;
  try {
    await post('settings', { libraryIds: [...checked('settings-movies'), ...checked('settings-tv')] });
    status('settings-status', 'Library visibility saved.');
  } catch (error) { status('settings-status', error.message); }
  finally { button.disabled = false; }
};

function drawPresets(selected = '') {
  el('library-preset').replaceChildren(new Option('Choose a preset', ''),
    ...[...presets.keys()].sort(sortedTitles.compare).map((name) => new Option(name, name)));
  el('library-preset').value = selected;
  el('delete-preset').disabled = !selected;
}
el('library-preset').onchange = ({ target }) => {
  const ids = presets.get(target.value);
  el('delete-preset').disabled = !ids;
  if (!ids) return;
  el('preset-name').value = target.value;
  const available = [...el('libraries').querySelectorAll('input')].filter((check) => !check.closest('label').hidden);
  if (state.editing) return status('preset-status', 'Silo controls the libraries for this existing collection.');
  for (const check of available) check.checked = ids.includes(check.value);
  invalidateMatches();
  const omitted = ids.filter((id) => !available.some((check) => check.value === id));
  status('preset-status', omitted.length ? 'Preset applied. Some saved libraries are unavailable here.' : 'Preset applied.');
};
el('save-preset').onclick = () => {
  const name = el('preset-name').value.trim();
  const ids = checked('libraries');
  if (!name || !ids.length) return status('preset-status', 'Enter a name and select libraries.');
  presets.set(name, ids);
  drawPresets(name);
  status('preset-status', store(presetKey, [...presets]) ? 'Preset saved in this browser.' : 'Preset saved for this session.');
};
el('delete-preset').onclick = () => {
  presets.delete(el('library-preset').value);
  drawPresets();
  el('preset-name').value = '';
  status('preset-status', store(presetKey, [...presets]) ? 'Preset removed.' : 'Preset removed for this session.');
};
el('sort-collections').onclick = async () => {
  const libraryId = el('order-library').value;
  const button = el('sort-collections');
  button.disabled = true;
  status('order-status', 'Sorting collections in Silo…');
  try {
    const result = await post('sort-collections', { libraryId, kind });
    const updated = result.changed ? result.changed + ' groups reordered.' : 'No groups needed reordering.';
    status('order-status', updated + (result.skipped.length ? ' Groups skipped: ' + result.skipped.join(', ') + '.' : ''));
  } catch (error) { status('order-status', error.message); }
  finally { button.disabled = false; }
};

const exclusionPanel = el('collection-sort-exclusions');
const exclusionList = el('collection-sort-exclusion-list');
const saveExclusions = el('save-collection-sort-exclusions');
const sortMedia = el('sort-collection-media');
let loadingExclusions = false;
exclusionPanel.ontoggle = async () => {
  if (!exclusionPanel.open || !exclusionList.hidden || loadingExclusions) return;
  loadingExclusions = true;
  status('collection-sort-exclusion-status', 'Loading Silo collections…');
  try {
    const [collections, excludedIds] = await Promise.all([api('collections'), api('collection-sort-exclusions')]);
    const excluded = new Set(excludedIds);
    for (const { id, title } of collections.sort((a, b) => sortedTitles.compare(a.title, b.title))) {
      const label = create('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = id;
      checkbox.checked = excluded.has(id);
      label.append(checkbox, document.createTextNode(title));
      exclusionList.append(label);
    }
    exclusionList.hidden = !collections.length;
    saveExclusions.disabled = sortMedia.disabled || !collections.length;
    status('collection-sort-exclusion-status', collections.length ? '' : 'No Silo collections found.');
  } catch (error) { status('collection-sort-exclusion-status', error.message); }
  finally { loadingExclusions = false; }
};
saveExclusions.onclick = async () => {
  saveExclusions.disabled = sortMedia.disabled = exclusionList.disabled = true;
  try {
    await post('collection-sort-exclusions', { excludedIds: checked(exclusionList.id) });
    status('collection-sort-exclusion-status', 'Exclusions saved.');
  } catch (error) { status('collection-sort-exclusion-status', error.message); }
  finally { saveExclusions.disabled = sortMedia.disabled = exclusionList.disabled = false; }
};

sortMedia.onclick = async () => {
  sortMedia.disabled = saveExclusions.disabled = true;
  status('media-order-status', 'Sorting movies and shows inside Silo collections…');
  try {
    const { changed, unchanged, excluded, failed } = await post('sort-collection-media', {});
    const summary = `Updated ${changed} collections. Already sorted: ${unchanged}. Excluded: ${excluded}.`;
    const problems = failed.map(({ title, reason }) => `${title} (${reason})`).join(', ');
    status('media-order-status', failed.length ? `${summary} Failed: ${problems}` : summary);
  } catch (error) { status('media-order-status', error.message); }
  finally {
    sortMedia.disabled = false;
    saveExclusions.disabled = exclusionList.hidden;
  }
};

function closeManualMatch() {
  state.manualMatch = null;
  el('manual-match').hidden = true;
  el('match-candidates').replaceChildren();
  status('manual-status', '');
}
function startManualMatch(item) {
  closeManualMatch();
  state.manualMatch = item;
  el('manual-match').hidden = false;
  el('match-query').value = item.title;
  el('match-query').focus();
  el('match-search').requestSubmit();
}
el('cancel-match').onclick = closeManualMatch;
el('match-search').onsubmit = async (event) => {
  event.preventDefault();
  const item = state.manualMatch;
  if (!item) return;
  const run = state.manualRun = Symbol();
  const data = requestFor(state.current ?? state.editFranchise, checked('libraries'));
  el('match-candidates').replaceChildren();
  status('manual-status', 'Searching for ' + item.title + '…');
  try {
    const results = await post('match-candidates', { ...data, query: el('match-query').value.trim() });
    if (state.manualMatch !== item || state.manualRun !== run) return;
    status('manual-status', results.length ? 'Choose a library title for ' + item.title + '.' : 'No titles found. Try a shorter search.');
    for (const result of results) {
      const names = result.libraryIds.map((id) => state.libraries.find((library) => library.id === id)?.name);
      const label = [result.title + (result.year ? ' (' + result.year + ')' : ''), ...names].join(' · ');
      el('match-candidates').append(action(label, async () => {
        if (state.manualMatch !== item || state.manualRun !== run) return;
        const chosen = [...checked('matches'), result.id];
        const overrides = { ...state.overrides, [item.index]: result.id };
        closeManualMatch();
        const previewRun = state.previewRun = Symbol();
        try {
          const matches = await post('preview', { ...data, overrides });
          if (state.previewRun !== previewRun) return;
          state.overrides = overrides;
          renderMatches(matches, chosen);
        } catch (error) {
          if (state.previewRun === previewRun) status('match-status', error.message);
        }
      }));
    }
  } catch (error) {
    if (state.manualMatch === item && state.manualRun === run) status('manual-status', error.message);
  }
};

el('preview').onclick = async () => {
  invalidateMatches();
  if (!checked('libraries').length) { status('match-status', 'Select at least one library.'); return; }
  const run = state.previewRun = Symbol();
  status('match-status', 'Matching your library…');
  try {
    const result = await post('preview', requestFor(state.current ?? state.editFranchise, checked('libraries')));
    if (state.previewRun === run) renderMatches(result);
  } catch (error) { if (state.previewRun === run) status('match-status', error.message); }
};

function posterImage(poster) {
  return Object.assign(create('img'), { src: poster.image, alt: poster.title, loading: 'lazy', decoding: 'async' });
}
function drawPosterComparison() {
  const posters = [...state.comparison.values()];
  el('poster-comparison').hidden = posters.length === 0;
  status('compare-status', posters.length ? posters.length + ' of 3 posters shortlisted.' : '');
  el('compare-posters').replaceChildren(...posters.map((poster) => {
    const card = create('figure');
    const controls = create('div');
    controls.className = 'compare-actions';
    controls.append(
      action('Use poster', () => showPoster(poster)),
      action('Remove', () => {
        state.comparison.delete(poster.id);
        drawPosterComparison();
      }));
    card.append(posterImage(poster), create('figcaption', poster.title + ' · ' + poster.creator), controls);
    return card;
  }));
}
function showPoster(poster) {
  if (!poster?.customUrl) {
    state.customPosterRun = null;
    el('custom-poster-preview').disabled = false;
    status('custom-poster-status', '');
  }
  state.poster = poster;
  el('chosen-poster').replaceChildren(...(poster?.image ? [Object.assign(posterImage(poster), { loading: 'eager', fetchPriority: 'high' })] : []));
  if (poster?.customUrl && !poster.image) void restorePosterPreview(poster);
  status('poster-label', poster ? `${poster.title} · ${poster.creator}` : (state.editing ? 'Keeping current artwork' : 'No poster selected'));
  for (const element of el('posters').querySelectorAll('button[data-id]')) element.setAttribute('aria-pressed', String(element.dataset.id === poster?.id));
  updateActions();
}

async function restorePosterPreview(poster) {
  try {
    const response = await fetch('/api/poster-preview', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Franchise-App': '1' }, body: JSON.stringify({ url: poster.customUrl }) });
    if (!response.ok) throw new Error('Saved custom poster could not be previewed.');
    const image = await response.blob();
    if (state.poster === poster) showPoster({ ...poster, image: URL.createObjectURL(image) });
  } catch (error) {
    if (state.poster === poster) status('custom-poster-status', error.message);
  }
}

el('custom-poster-form').onsubmit = async (event) => {
  event.preventDefault();
  const url = el('custom-poster-url').value.trim();
  if (!url) { status('custom-poster-status', 'Enter a direct public HTTPS poster URL.'); return; }
  const run = state.customPosterRun = Symbol();
  el('custom-poster-preview').disabled = true;
  status('custom-poster-status', 'Loading poster…');
  try {
    const response = await fetch('/api/poster-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Franchise-App': '1' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'The poster could not be loaded.');
    const image = await response.blob();
    if (state.customPosterRun !== run) return;
    showPoster({ id: '', title: 'Custom poster', creator: 'Image URL', image: URL.createObjectURL(image), customUrl: url });
    status('custom-poster-status', 'Custom poster selected.');
  } catch (error) {
    if (state.customPosterRun === run) status('custom-poster-status', error.message);
  } finally {
    if (state.customPosterRun === run) el('custom-poster-preview').disabled = false;
  }
};

async function listPosters(reset) {
  const run = state.posterRun = Symbol();
  el('more-posters').hidden = true;
  if (reset) {
    state.posterPage = 1;
    state.posterMode = '';
    state.posterSeen = new Set();
    state.posterQuery = el('poster-query').value.trim();
    state.posterCreator = el('poster-source').value;
    el('posters').replaceChildren();
    el('gallery-link').hidden = true;
  }
  status('poster-status', 'Loading artwork…');
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await api('posters?' + params({ q: state.posterQuery, page: state.posterPage, creator: state.posterCreator, mode: state.posterMode }));
      if (state.posterRun !== run) return;
      state.posterMode = result.mode;
      if (result.items.length || !result.more || !state.posterQuery || attempt === 2) break;
      state.posterPage++;
    }
    if (state.posterRun !== run) return;
    if (result.gallery) {
      el('gallery-link').href = result.gallery;
      el('gallery-link').hidden = false;
    }
    for (const poster of result.items) {
      if (state.posterSeen.has(poster.id)) continue;
      state.posterSeen.add(poster.id);
      const button = action('', () => showPoster(poster));
      button.dataset.id = poster.id;
      button.setAttribute('aria-pressed', String(state.poster?.id === poster.id));
      button.append(posterImage(poster), create('span', poster.title), create('small', poster.creator));
      const card = create('div');
      card.className = 'poster-card';
      const compare = action('Compare', () => {
        if (state.comparison.has(poster.id)) return;
        if (state.comparison.size >= 3) return status('compare-status', 'Remove a poster to compare another.');
        state.comparison.set(poster.id, poster);
        drawPosterComparison();
      });
      compare.setAttribute('aria-label', 'Compare ' + poster.title + ' by ' + poster.creator);
      card.append(button, compare);
      el('posters').append(card);
    }
    el('more-posters').hidden = !result.more;
    const unavailable = result.unavailable?.length ? `Could not load: ${result.unavailable.join(', ')}.` : '';
    status('poster-status', [result.items.length ? '' : result.more ? 'No matches on these pages. Load more to keep searching.' : 'No more poster matches. Try a shorter title or browse all.', unavailable].filter(Boolean).join(' '));
  } catch (error) { if (state.posterRun === run) status('poster-status', error.message); }
}

function draftFor(item) {
  return { ...requestFor(item, checked('libraries')), title: el('collection-title').value, poster: state.poster,
    contentIds: checked('matches'), matches: state.matches,
    description: state.descriptionDirty || state.metadataLoaded ? el('description').value : undefined,
    includeBackdrop: el('include-backdrop').checked, selectedBackdrop: state.selectedBackdrop,
    backdropUrl: kind === 'series' ? el('tv-backdrop-url').value.trim() : undefined,
    sync: el('sync-tmdb').checked, requestMissing: el('request-missing').checked,
    autoAdd: !el('auto-add-field').hidden && el('auto-add-requested').checked, overrides: state.overrides };
}
const ready = (draft) => !!draft?.poster &&
  [...libraryCounts(draft.matches, draft.contentIds, draft.libraryIds).values()].some((count) => count >= 2);
const importPayload = (draft) => ({ provider: draft.provider, id: draft.id, kind: draft.kind,
  libraryIds: draft.libraryIds, title: draft.title, contentIds: draft.contentIds, ...posterFields(draft.poster),
  description: draft.description, includeBackdrop: draft.includeBackdrop, overrides: draft.overrides,
  backdropUrl: draft.backdropUrl, backdropPath: draft.includeBackdrop ? draft.selectedBackdrop?.path : undefined,
  sync: draft.sync, requestMissing: draft.requestMissing, autoAdd: draft.autoAdd });

const importDraft = (draft) => post('import', importPayload(draft));
function requestSummary(report) {
  if (!report) return '';
  return [
    report.requested.length ? 'Requested ' + report.requested.join(', ') + '.' : '',
    report.skipped.length ? 'Already available or requested: ' + report.skipped.join(', ') + '.' : '',
    report.unresolved.length ? 'Missing TMDb IDs: ' + report.unresolved.join(', ') + '.' : '',
    report.failed.length ? 'Could not confirm requests for ' + report.failed.join(', ') + '.' : '',
    report.reason,
  ].filter(Boolean).join(' ') || 'No missing titles to request.';
}

function editDraft(editing) {
  const libraryIds = checked('libraries');
  const contentIds = checked('matches');
  return {
    collection: editing, franchise: state.artworkFranchise, poster: state.poster,
    backdrop: state.selectedBackdrop, matches: state.matches,
    payload: {
      collectionId: editing.id, etag: editing.etag, title: el('collection-title').value,
      description: el('description').value, ...posterFields(state.poster),
      kind, backdropUrl: kind === 'series' ? el('tv-backdrop-url').value.trim() : undefined,
      ...(state.selectedBackdrop && state.artworkFranchise
        ? { ...requestFor(state.artworkFranchise, libraryIds), backdropPath: state.selectedBackdrop.path } : {}),
      ...(state.editFranchise && contentIds.length
        ? { ...requestFor(state.editFranchise, libraryIds), contentIds, overrides: state.overrides } : {}),
    },
  };
}
function posterFields(poster) {
  if (poster?.customUrl) return { posterUrl: poster.customUrl };
  return poster ? { posterId: poster.id, posterCreator: poster.creator } : {};
}

let queueRevision;
let lastSavedQueue;
let queueSaving = false;
let queueWrite;
let queueConflict = false;
const queueSnapshot = () => JSON.stringify({
  selected: [...state.selected], drafts: [...state.drafts], edits: [...state.edits],
}, (key, value) => key === 'image' && typeof value === 'string' && value.startsWith('blob:') ? undefined : value);

async function loadServerQueue() {
  if (queueSaving || state.busy) return;
  const button = el('load-server-queue');
  button.disabled = true;
  try {
    const result = await api('drafts?' + params({ kind }));
    if (result.queue) {
      state.selected = new Map(result.queue.selected);
      state.drafts = new Map(result.queue.drafts);
      state.edits = new Map(result.queue.edits);
    }
    queueRevision = result.revision;
    queueConflict = false;
    lastSavedQueue = queueSnapshot();
    status('server-queue-status', result.queue ? 'Saved queue loaded.' : 'Queue changes will save here automatically.');
    drawRows();
  } catch (error) { status('server-queue-status', error.message); }
  finally { button.disabled = false; }
}
el('load-server-queue').onclick = loadServerQueue;

async function syncServerQueue() {
  if (queueRevision == null || queueSaving || queueConflict || state.busy) return;
  const snapshot = queueSnapshot();
  if (snapshot === lastSavedQueue) return;
  queueSaving = true;
  try {
    queueWrite = post('drafts', { kind, revision: queueRevision, queue: JSON.parse(snapshot) });
    const value = await queueWrite;
    queueRevision = value.revision;
    lastSavedQueue = snapshot;
    status('server-queue-status', 'Queue saved on the server.');
  } catch (error) {
    queueConflict = /another device/.test(error.message);
    status('server-queue-status', error.message);
    return;
  } finally { queueSaving = false; queueWrite = null; }
  if (queueSnapshot() !== lastSavedQueue) void syncServerQueue();
}

for (const id of ['bulk-page', 'movies-page', 'tv-page', 'movie-queue-page', 'tv-queue-page', 'queue-browse-link', 'settings-page']) {
  el(id).addEventListener('click', async (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
      (lastSavedQueue === queueSnapshot() && !queueWrite)) return;
    if (!queueWrite && queueRevision == null) return;
    event.preventDefault();
    const destination = event.currentTarget.href;
    try {
      while (queueWrite) await queueWrite;
      await syncServerQueue();
      while (queueWrite) await queueWrite;
      if (lastSavedQueue === queueSnapshot()) location.assign(destination);
      else status(bulkPage ? 'bulk-status' : 'queue-nav-status', 'The queue could not be saved. Reload the saved queue or retry before leaving.');
    } catch (error) { status(bulkPage ? 'bulk-status' : 'queue-nav-status', error.message); }
  });
}

function drawQueue() {
  syncServerQueue();
  const available = visibleRows().filter((item) => item.provider !== 'silo' && !matchesFor(item).length);
  const all = el('select-visible');
  const visibleSelected = available.filter((item) => state.selected.has(itemKey(item))).length;
  all.checked = available.length > 0 && visibleSelected === available.length;
  all.indeterminate = visibleSelected > 0 && visibleSelected < available.length;
  all.disabled = !available.length || !!state.busy;
  status('selection-count', `${state.selected.size} selected`);
  const total = state.selected.size + state.edits.size;
  const count = el('nav-queue-count');
  count.textContent = total;
  count.hidden = !total;
  if (!bulkPage) return;
  const queue = el('queue');
  queue.replaceChildren();
  let readyCount = 0;
  for (const [key, item] of state.selected) {
    const draft = state.drafts.get(key);
    if (ready(draft)) readyCount++;
    const row = create('div');
    row.className = 'queue-row';
    const remove = action('Remove', () => { state.selected.delete(key); state.drafts.delete(key); drawQueue(); });
    remove.setAttribute('aria-label', 'Remove queued franchise ' + item.title);
    remove.disabled = !!state.busy;
    row.append(action(draft?.title ?? item.title, () => openFranchise(item), 'row-title'),
      create('small', draft?.error ?? (ready(draft) ? 'Ready' : draft ? 'Needs a poster and 2 titles in one library' : 'Needs preparation')), remove);
    queue.append(row);
  }
  for (const [id, draft] of state.edits) {
    const row = create('div');
    row.className = 'queue-row';
    const remove = action('Remove', () => { state.edits.delete(id); drawQueue(); });
    remove.setAttribute('aria-label', 'Remove queued edit for ' + draft.payload.title);
    remove.disabled = !!state.busy;
    row.append(action(draft.payload.title, () => openExisting(draft.collection, draft.franchise), 'row-title'),
      create('small', draft.error ?? 'Edit ready'), remove);
    queue.append(row);
  }
  readyCount += state.edits.size;
  el('queue-empty').hidden = total > 0;
  status('queue-summary', total ? total + ' queued · ' + readyCount + ' ready' : '');
  el('prepare-bulk').disabled = !state.selected.size || !!state.busy;
  el('dry-bulk').disabled = !(state.selected.size || state.edits.size) || !!state.busy;
  el('import-bulk').disabled = !readyCount || !!state.busy;
  drawHistory();
  el('import-bulk').textContent = readyCount ? `Apply ${readyCount} ready` : 'Apply ready';
}

el('select-visible').onchange = (event) => {
  for (const item of visibleRows().filter((item) => item.provider !== 'silo' && !matchesFor(item).length)) {
    const key = itemKey(item);
    if (event.target.checked) state.selected.set(key, item);
    else { state.selected.delete(key); state.drafts.delete(key); }
  }
  drawRows();
};
el('queue-current').onclick = () => {
  if (state.editing) {
    state.edits.set(state.editing.id, editDraft(state.editing));
    status('publish-status', 'Changes queued. Open Bulk queue to apply them.');
    drawQueue();
    return;
  }
  const item = state.current;
  state.selected.set(itemKey(item), item);
  state.drafts.set(itemKey(item), draftFor(item));
  status('publish-status', 'Saved to the bulk queue.');
  drawRows();
};

el('prepare-bulk').onclick = async () => {
  const libraryIds = checked('bulk-libraries');
  if (!libraryIds.length) {
    status('bulk-status', 'Select at least one library under Preparation settings.');
    return;
  }
  state.busy = true;
  const creator = el('bulk-poster-source').value;
  drawRows();
  updateActions();
  try {
    for (const [key, item] of state.selected) {
      if (ready(state.drafts.get(key))) continue;
      status('bulk-status', `Preparing ${item.title}…`);
      const draft = { ...requestFor(item, libraryIds), title: item.title, matches: [], contentIds: [], poster: null };
      try {
        const preview = post('preview', requestFor(item, libraryIds));
        const query = item.title.replace(/^the\s+|\s+(?:franchise|collection|universe)$/gi, '').trim();
        const posterSearch = query ? api('posters?' + params({ q: query, page: 1, creator })).catch(() => null) : null;
        draft.matches = await preview;
        draft.contentIds = [...new Set(draft.matches.map((match) => match.contentId).filter(Boolean))];
        const result = await posterSearch;
        if (result) {
          const exact = result.items.filter((poster) => titleKey(poster.title) === titleKey(item.title));
          if (exact.length === 1 && !result.unavailable?.length) draft.poster = exact[0];
        }
      } catch (error) { draft.error = error.message; }
      state.drafts.set(key, draft);
      drawQueue();
    }
    status('bulk-status', 'Review the ready entries. Open any unfinished entry to choose its poster or library titles.');
  } finally {
    state.busy = false;
    drawRows();
    updateActions();
  }
};

function bulkEntries() {
  return [
    ...[...state.selected].map(([key, item]) => {
      const draft = state.drafts.get(key);
      return { key, title: draft?.title ?? item.title, route: 'import', payload: ready(draft) ? importPayload(draft) : null };
    }),
    ...[...state.edits].map(([key, draft]) => ({ key, title: draft.payload.title, route: 'edit', payload: draft.payload })),
  ];
}

function recordBulk(entry, result, note) {
  const { route, key, title, payload } = entry;
  history.unshift({ route, key, title, result, note, date: new Date().toISOString(),
    payload: result === 'Failed' ? payload : undefined });
  history.splice(30);
  store(historyKey, history);
}
function drawHistory() {
  const entries = history.map((entry, index) => {
    const row = create('div');
    row.className = 'queue-row';
    row.append(create('span', entry.title + ' · ' + entry.result),
      create('small', [new Date(entry.date).toLocaleString(), entry.note].filter(Boolean).join(' · ')));
    if (entry.result === 'Failed' && entry.payload && !history.slice(0, index).some((next) =>
      next.route === entry.route && next.key === entry.key)) {
      const retry = action('Retry', () => applyBulk([entry]));
      retry.disabled = !!state.busy;
      row.append(retry);
    }
    return row;
  });
  el('bulk-history').replaceChildren(...(entries.length ? entries : [create('p', 'No bulk runs yet.')]));
}

el('dry-bulk').onclick = async () => {
  const entries = bulkEntries();
  const plan = el('bulk-plan');
  plan.replaceChildren();
  plan.hidden = false;
  state.busy = true;
  drawQueue();
  updateActions();
  status('bulk-status', 'Checking queued changes in Silo…');
  try {
    for (const entry of entries) {
      let summary;
      try {
        if (!entry.payload) throw new Error('Needs a poster and at least two matches in one library.');
        const result = await post(entry.route, { ...entry.payload, dryRun: true });
        summary = result.action + ' · ' + entry.title;
        if (result.libraries?.length) summary += ' · ' + result.libraries.join(', ');
        if (result.memberCount) summary += ' · ' + result.memberCount + ' selected titles';
        if (result.requestCandidates?.length) summary += ' · Request candidates: ' + result.requestCandidates.join(', ');
        if (result.unresolvedRequests?.length) summary += ' · Missing TMDb IDs: ' + result.unresolvedRequests.join(', ');
        if (result.skippedLibraries?.length) summary += ' · Skip ' + result.skippedLibraries.join(', ') + ' (fewer than two titles)';
      } catch (error) { summary = 'Skip · ' + entry.title + ' · ' + error.message; }
      plan.append(create('li', summary));
    }
    status('bulk-status', 'Preview complete. Apply ready to submit the changes.');
  } finally {
    state.busy = false;
    drawQueue();
    updateActions();
  }
};

async function applyBulk(entries) {
  if (state.busy) return;
  state.busy = true;
  el('bulk-plan').hidden = true;
  drawRows();
  updateActions();
  let imported = 0;
  let edited = 0;
  let failed = 0;
  try {
    for (const entry of entries) {
      if (!entry.payload) continue;
      status('bulk-status', 'Saving ' + entry.title + '…');
      try {
        const result = await post(entry.route, entry.payload);
        const note = [result.warning, requestSummary(result.mediaRequests),
          result.skippedLibraries?.length ? 'Skipped: ' + result.skippedLibraries.join(', ') : ''].filter(Boolean).join(' · ');
        if (entry.route === 'edit') {
          state.edits.delete(entry.key);
          edited++;
        } else {
          state.selected.delete(entry.key);
          state.drafts.delete(entry.key);
          imported++;
        }
        recordBulk(entry, entry.route === 'edit' ? 'Updated' : 'Imported', note);
        if (entry.route === 'edit' && state.editing?.id === entry.key) {
          await openExisting(state.editing, state.artworkFranchise);
        }
      } catch (error) {
        const draft = (entry.route === 'edit' ? state.edits : state.drafts).get(entry.key);
        if (draft) draft.error = error.message;
        recordBulk(entry, 'Failed', error.message);
        failed++;
      }
    }
    await refreshExisting();
    status('bulk-status', imported + ' imported · ' + edited + ' updated.' + (failed ? ' ' + failed + ' failed. See bulk history for details.' : ''));
  } finally {
    state.busy = false;
    drawRows();
    updateActions();
  }
}
el('import-bulk').onclick = () => applyBulk(bulkEntries());

el('publish').onclick = async () => {
  state.busy = true;
  updateActions();
  drawRows();
  const item = state.current;
  const editing = state.editing;
  status('publish-status', 'Saving to Silo…');
  try {
    const result = editing
      ? await post('edit', editDraft(editing).payload)
      : await importDraft(draftFor(item));
    if (editing) state.edits.delete(editing.id);
    if (item) { state.selected.delete(itemKey(item)); state.drafts.delete(itemKey(item)); }
    await refreshExisting();
    if (editing && state.editing === editing) {
      state.editing = await api('collection?' + params({ id: editing.id }));
      el('undo-edit').hidden = !state.editing.canUndo;
          showPoster(null);
      chooseBackdrop(null);
      el('tv-backdrop-url').value = '';
      invalidateMatches();
    }
    if ((item && item === state.current) || (editing && editing.id === state.editing?.id)) {
      status('publish-status', [`Saved “${result.title}” in Silo.`,
        result.synced ? 'Silo will sync it with TMDb daily.' : '',
        editing && result.added != null ? `${result.added} new titles added.` : '',
        result.skippedLibraries?.length ? `Skipped libraries with fewer than two titles: ${result.skippedLibraries.join(', ')}.` : '',
        result.warning, requestSummary(result.mediaRequests)].filter(Boolean).join(' '));
    }
  } catch (error) { status('publish-status', error.message); }
  finally { state.busy = false; drawRows(); updateActions(); }
};

el('undo-edit').onclick = async () => {
  const editing = state.editing;
  if (!editing?.canUndo || state.busy) return;
  state.busy = true;
  updateActions();
  try {
    await post('undo-edit', { collectionId: editing.id, etag: editing.etag });
    state.edits.delete(editing.id);
    await refreshExisting();
    if (state.editing === editing) {
      await openExisting(editing, state.artworkFranchise);
      status('publish-status', 'Previous collection details and artwork restored.');
    }
  } catch (error) { status('publish-status', error.message); }
  finally { state.busy = false; drawRows(); updateActions(); }
};

el('all-posters').onclick = () => { el('poster-query').value = ''; listPosters(true); };
el('poster-source').onchange = () => listPosters(true);
el('more-posters').onclick = () => { state.posterPage++; listPosters(false); };
el('poster-form').onsubmit = (event) => { event.preventDefault(); listPosters(true); };
el('franchise-form').onsubmit = (event) => { event.preventDefault(); listFranchises(true); };
el('franchise-sort').onchange = () => listFranchises(true);
el('title-language').onchange = () => {
  store('silo-title-language-' + kind, el('title-language').value);
  listFranchises(true);
};
el('hide-existing').onchange = () => {
  try { localStorage.setItem('silo-hide-existing', String(el('hide-existing').checked)); } catch {}
  drawRows();
};
el('collection-title').oninput = () => { status('selection-title', el('collection-title').value || 'Your collection'); updateActions(); };
el('description').oninput = () => { state.descriptionDirty = true; };
function updateAutoAdd() {
  el('auto-add-field').hidden = !el('request-missing').checked || el('sync-tmdb').checked;
}
el('request-missing').onchange = updateAutoAdd;
el('sync-tmdb').onchange = (event) => {
  updateAutoAdd();
  el('sync-note').hidden = !event.target.checked;
  if (event.target.checked && Object.keys(state.overrides).length) {
    invalidateMatches();
    status('match-status', 'Preview again to use TMDb sync.');
    return;
  }
  closeManualMatch();
  if (state.matches.length) renderMatches(state.matches, checked('matches'));
  else updateActions();
};
for (const button of document.querySelectorAll('[data-provider]')) {
  button.hidden = kind === 'series' && button.dataset.provider === 'tmdb';
  button.setAttribute('aria-pressed', String(button.dataset.provider === state.provider));
  button.onclick = () => {
    state.provider = button.dataset.provider;
    updateSortOptions();
    for (const other of document.querySelectorAll('[data-provider]')) other.setAttribute('aria-pressed', String(button === other));
    listFranchises(true);
  };
}
function updateSortOptions() {
  const available = state.provider === 'tvdb';
  el('sort-popular').hidden = !available;
  el('sort-popular').disabled = !available;
  if (!available && el('franchise-sort').value === 'popular') el('franchise-sort').value = 'default';
  el('hide-existing-field').hidden = state.provider === 'silo';
  el('title-language-field').hidden = state.provider === 'silo';
  drawHidden();
  el('silo-order').hidden = state.provider !== 'silo';
  el('collection-health').hidden = state.provider !== 'silo';
  if (state.provider === 'silo') drawCollectionHealth();
}
updateSortOptions();
document.body.classList.toggle('bulk-page', bulkPage);
document.body.classList.toggle('editor-open', browsePage);
el('bulk-page').href = queuePath;
el('browse-panel').hidden = !browsePage;
el('bulk-panel').hidden = !bulkPage;
el('settings-panel').hidden = !settingsPage;
el('work-panel').hidden = !browsePage;
el('artwork-panel').hidden = !browsePage;
el(settingsPage ? 'settings-page' : bulkPage ? 'bulk-page' : kind === 'series' ? 'tv-page' : 'movies-page').setAttribute('aria-current', 'page');
status('page-title', kind === 'series' ? 'TV Franchises' : 'Movie Franchises');
if (bulkPage) {
  el('queue-browse-link').href = browsePath;
  el(kind === 'series' ? 'tv-queue-page' : 'movie-queue-page').setAttribute('aria-current', 'page');
  status('batch-title', kind === 'series' ? 'TV bulk queue' : 'Movie bulk queue');
  document.title = el('batch-title').textContent + ' · Silo Franchises';
  el('bulk-poster-source').replaceChildren(...[...el('poster-source').options].map((option) => option.cloneNode(true)));
  el('bulk-poster-source').value = stored('silo-bulk-creator-' + kind, 'all');
  if (!el('bulk-poster-source').value) el('bulk-poster-source').value = 'all';
  el('bulk-poster-source').onchange = () => store('silo-bulk-creator-' + kind, el('bulk-poster-source').value);
  drawQueue();
} else if (browsePage) {
  void listFranchises(true);
  void loadHidden();
}
void loadLibraries().then(() => { if (!settingsPage) return refreshExisting(); });
if (!settingsPage) void loadServerQueue();
