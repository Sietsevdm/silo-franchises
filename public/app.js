const el = (id) => document.getElementById(id);
const status = (id, text) => { el(id).textContent = text; };
const create = (tag, text) => Object.assign(document.createElement(tag), { textContent: text ?? '' });
const checked = (container) => [...el(container).querySelectorAll('input:checked')].map((input) => input.value);
const kind = location.pathname === '/tv' ? 'series' : 'movie';
const state = { provider: kind === 'series' ? 'tvdb' : 'tmdb', selected: new Map(), drafts: new Map(), existing: [], libraries: [], rows: [] };
const titleKey = (title) => title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\b(?:franchise|collection|universe)\s*$/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
const sourceKey = (url) => (url ?? '').replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '');
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
  const key = titleKey(item.title);
  return sourceKey(collection.sourceUrl) === sourceKey(item.url) || (key && titleKey(collection.title) === key);
});
function isCurrentKind(collection) {
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
  for (const item of state.rows) {
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
    }
    target.append(row);
  }
  drawQueue();
}

async function listFranchises(reset) {
  const run = state.franchiseRun = Symbol();
  el('more-franchises').hidden = true;
  if (reset) {
    state.page = 1;
    state.cursor = 0;
    state.query = el('franchise-query').value.trim();
    state.sort = el('franchise-sort').value;
    state.rows = [];
    drawRows();
  }
  status('franchise-status', 'Loading…');
  try {
    if (state.provider === 'silo' && state.existingError) throw new Error(state.existingError);
    let result;
    if (state.provider === 'silo') {
      const items = state.existing.filter((item) => isCurrentKind(item) && item.title.toLowerCase().includes(state.query.toLowerCase()))
        .map((item) => ({ ...item, provider: 'silo' }));
      if (state.sort === 'title-asc' || state.sort === 'title-desc') {
        const direction = state.sort === 'title-asc' ? 1 : -1;
        items.sort((a, b) => direction * sortedTitles.compare(a.title, b.title));
      }
      result = { items };
    } else {
      result = await api('franchises?' + params({ provider: state.provider, kind, q: state.query, page: state.page, cursor: state.cursor, sort: state.sort }));
    }
    if (state.franchiseRun !== run) return;
    state.rows.push(...result.items);
    state.cursor = result.next ?? 0;
    drawRows();
    el('more-franchises').hidden = !result.more;
    status('franchise-status', state.rows.length ? '' : result.more ? 'No matches among the lists checked so far.' : 'No collections found.');
  } catch (error) {
    if (state.franchiseRun === run) status('franchise-status', error.message);
  }
}

async function refreshExisting() {
  try { state.existing = await api('collections'); state.existingError = ''; }
  catch (error) { state.existingError = error.message; }
  if (state.provider === 'silo') await listFranchises(true);
  else drawRows();
}

function openPanel(title, editing) {
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
  el('metadata-source').hidden = true;
  el('backdrop-field').hidden = true;
  el('include-backdrop').checked = true;
  status('metadata-status', '');
  status('selection-title', title);
  el('queue-current').hidden = editing;
  el('publish').textContent = editing ? 'Save changes' : 'Add to Silo';
  el('collection-title').value = title;
  el('source-link').hidden = true;
  status('publish-status', '');
  invalidateMatches();
  showPoster(null);
  el('poster-query').value = title.replace(/\s+(?:collection|franchise|universe)$/i, '');
  void listPosters(true);
}

async function openFranchise(item) {
  state.editing = null;
  state.editFranchise = null;
  state.current = item;
  const draft = state.drafts.get(itemKey(item));
  openPanel(draft?.title ?? item.title, false);
  if (draft) {
    for (const check of el('libraries').querySelectorAll('input')) check.checked = draft.libraryIds.includes(check.value);
    renderMatches(draft.matches, draft.contentIds);
    showPoster(draft.poster);
    if (draft.description != null) {
      el('description').value = draft.description;
      state.descriptionDirty = true;
    }
    el('include-backdrop').checked = draft.includeBackdrop !== false;
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
  status('metadata-status', 'Loading TMDb description and backdrop…');
  try {
    const metadata = await api('metadata?' + params({ provider: item.provider, id: item.id, kind }));
    if (state.metadataRun !== run) return;
    if (!metadata) { status('metadata-status', 'No matching TMDb artwork or description found.'); return; }
    state.metadataLoaded = true;
    if (!state.descriptionDirty) el('description').value = metadata.description.slice(0, 8000);
    if (metadata.backdrop) {
      el('tmdb-backdrop').src = metadata.backdrop;
      el('tmdb-backdrop').hidden = false;
      el('backdrop-field').hidden = false;
    }
    const link = el('metadata-source');
    link.href = metadata.url;
    link.textContent = metadata.kind === 'related' ? `TMDb metadata from ${metadata.title}` : 'Description and backdrop from TMDb';
    link.hidden = false;
    status('metadata-status', '');
  } catch (error) {
    if (state.metadataRun === run) status('metadata-status', error.message);
  }
}

async function openExisting(item, franchise = null) {
  state.current = null;
  state.editing = null;
  state.editFranchise = null;
  openPanel(item.title, true);
  el('description').value = '';
  status('detail-status', 'Loading Silo collection…');
  const run = state.editRun = Symbol();
  try {
    const result = await api('collection?' + params({ id: item.id }));
    if (state.editRun !== run || state.current) return;
    state.editing = result;
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
    status('detail-status', `Editing Silo collection · ${result.count ?? 0} titles${el('membership').hidden ? '' : ' · Preview library matches to add titles'}`);
    if (!state.poster) status('poster-label', 'Current artwork will be kept unless you select a replacement.');
    updateActions();
  } catch (error) {
    if (state.editRun === run && !state.current) status('detail-status', error.message);
  }
}

function invalidateMatches() {
  state.previewRun = null;
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
  for (const item of result) {
    const row = create(item.contentId ? 'label' : 'div');
    row.className = 'match';
    if (item.contentId && !used.has(item.contentId)) {
      row.append(inputCheck(item.contentId, !chosen || chosen.includes(item.contentId), updateActions));
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
  el('queue-current').disabled = !!state.busy || !valid || !canImport();
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
    state.libraries = await api('libraries');
    const eligible = state.libraries.filter((lib) => lib.type === 'mixed' || lib.type === (kind === 'movie' ? 'movies' : 'series'));
    for (const lib of eligible) {
      const label = create('label');
      label.append(inputCheck(lib.id, false, invalidateMatches), document.createTextNode(lib.name));
      el('libraries').append(label);
    }
    status('library-status', eligible.length ? '' : 'No enabled Silo libraries for this media type.');
  } catch (error) { status('library-status', error.message); }
}

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
  return Object.assign(create('img'), { src: poster.image, alt: poster.title, loading: 'lazy' });
}
function showPoster(poster) {
  state.poster = poster;
  el('chosen-poster').replaceChildren(...(poster ? [posterImage(poster)] : []));
  status('poster-label', poster ? `${poster.title} · ${poster.creator}` : (state.editing ? 'Keeping current artwork' : 'No poster selected'));
  for (const element of el('posters').querySelectorAll('button')) element.setAttribute('aria-pressed', String(element.dataset.id === poster?.id));
  updateActions();
}

async function listPosters(reset) {
  const run = state.posterRun = Symbol();
  el('more-posters').hidden = true;
  if (reset) {
    state.posterPage = 1;
    state.posterQuery = el('poster-query').value.trim();
    state.posterCreator = el('poster-source').value;
    el('posters').replaceChildren();
    el('gallery-link').hidden = true;
  }
  status('poster-status', 'Loading artwork…');
  try {
    const result = await api('posters?' + params({ q: state.posterQuery, page: state.posterPage, creator: state.posterCreator }));
    if (state.posterRun !== run) return;
    if (result.gallery) {
      el('gallery-link').href = result.gallery;
      el('gallery-link').hidden = false;
    }
    for (const poster of result.items) {
      const button = action('', () => showPoster(poster));
      button.dataset.id = poster.id;
      button.setAttribute('aria-pressed', String(state.poster?.id === poster.id));
      button.append(posterImage(poster), create('span', poster.title), create('small', poster.creator));
      el('posters').append(button);
    }
    el('more-posters').hidden = !result.more;
    const unavailable = result.unavailable?.length ? `Could not load: ${result.unavailable.join(', ')}.` : '';
    status('poster-status', [result.items.length ? '' : 'No posters found. Try a shorter title or browse all.', unavailable].filter(Boolean).join(' '));
  } catch (error) { if (state.posterRun === run) status('poster-status', error.message); }
}

function draftFor(item) {
  return { ...requestFor(item, checked('libraries')), title: el('collection-title').value, poster: state.poster,
    contentIds: checked('matches'), matches: state.matches,
    description: state.descriptionDirty || state.metadataLoaded ? el('description').value : undefined,
    includeBackdrop: el('include-backdrop').checked };
}
const ready = (draft) => !!draft?.poster &&
  [...libraryCounts(draft.matches, draft.contentIds, draft.libraryIds).values()].some((count) => count >= 2);
const importDraft = (draft) => post('import', { provider: draft.provider, id: draft.id, kind: draft.kind,
  libraryIds: draft.libraryIds, title: draft.title, contentIds: draft.contentIds, posterId: draft.poster.id,
  posterCreator: draft.poster.creator, description: draft.description, includeBackdrop: draft.includeBackdrop });

function drawQueue() {
  const available = state.rows.filter((item) => item.provider !== 'silo' && !matchesFor(item).length);
  const all = el('select-visible');
  const visibleSelected = available.filter((item) => state.selected.has(itemKey(item))).length;
  all.checked = available.length > 0 && visibleSelected === available.length;
  all.indeterminate = visibleSelected > 0 && visibleSelected < available.length;
  all.disabled = !available.length || !!state.busy;
  status('selection-count', `${state.selected.size} selected`);
  const queue = el('queue');
  queue.replaceChildren();
  let readyCount = 0;
  for (const [key, item] of state.selected) {
    const draft = state.drafts.get(key);
    if (ready(draft)) readyCount++;
    const row = create('div');
    row.className = 'queue-row';
    row.append(action(item.title, () => openFranchise(item), 'row-title'),
      create('small', draft?.error ?? (ready(draft) ? 'Ready' : draft ? 'Needs a poster and 2 titles in one library' : 'Needs preparation')));
    queue.append(row);
  }
  el('prepare-bulk').disabled = !state.selected.size || !!state.busy;
  el('import-bulk').disabled = !readyCount || !!state.busy;
  el('import-bulk').textContent = `Import ${readyCount} ready`;
}

el('select-visible').onchange = (event) => {
  for (const item of state.rows.filter((item) => item.provider !== 'silo' && !matchesFor(item).length)) {
    const key = itemKey(item);
    if (event.target.checked) state.selected.set(key, item);
    else { state.selected.delete(key); state.drafts.delete(key); }
  }
  drawRows();
};
el('queue-current').onclick = () => {
  const item = state.current;
  state.selected.set(itemKey(item), item);
  state.drafts.set(itemKey(item), draftFor(item));
  status('publish-status', 'Saved to the bulk queue.');
  drawRows();
};

el('prepare-bulk').onclick = async () => {
  const libraryIds = checked('libraries');
  if (!libraryIds.length) {
    if (!state.current) await openFranchise(state.selected.values().next().value);
    status('bulk-status', 'Select the libraries to use for the bulk queue, then prepare again.');
    return;
  }
  state.busy = true;
  const creator = el('poster-source').value;
  drawRows();
  updateActions();
  try {
    for (const [key, item] of state.selected) {
      if (ready(state.drafts.get(key))) continue;
      status('bulk-status', `Preparing ${item.title}…`);
      const draft = { ...requestFor(item, libraryIds), title: item.title, matches: [], contentIds: [], poster: null };
      try {
        draft.matches = await post('preview', requestFor(item, libraryIds));
        draft.contentIds = [...new Set(draft.matches.map((match) => match.contentId).filter(Boolean))];
        const query = item.title.replace(/^the\s+|\s+(?:franchise|collection|universe)$/gi, '').trim();
        if (query) {
          const result = await api('posters?' + params({ q: query, page: 1, creator }));
          const exact = result.items.filter((poster) => titleKey(poster.title) === titleKey(item.title));
          if (exact.length === 1 && !result.more && !result.unavailable?.length) draft.poster = exact[0];
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

el('import-bulk').onclick = async () => {
  state.busy = true;
  drawRows();
  updateActions();
  let imported = 0;
  let failed = 0;
  let warnings = 0;
  let skipped = 0;
  for (const [key] of state.selected) {
    const draft = state.drafts.get(key);
    if (!ready(draft)) continue;
    status('bulk-status', `Importing ${draft.title}…`);
    try {
      const result = await importDraft(draft);
      if (result.warning) warnings++;
      skipped += result.skippedLibraries?.length ?? 0;
      state.selected.delete(key);
      state.drafts.delete(key);
      imported++;
    } catch (error) { draft.error = error.message; failed++; }
  }
  await refreshExisting();
  state.busy = false;
  drawRows();
  updateActions();
  status('bulk-status', [
    `${imported} imported.`, failed ? `${failed} failed. See the queue for details.` : '',
    skipped ? `${skipped} library selections had fewer than two titles and were skipped.` : '',
    warnings ? `${warnings} imported with incomplete TMDb metadata.` : '',
  ].filter(Boolean).join(' '));
};

el('publish').onclick = async () => {
  state.busy = true;
  updateActions();
  drawRows();
  const item = state.current;
  const editing = state.editing;
  status('publish-status', 'Saving to Silo…');
  try {
    const result = editing
      ? await post('edit', { collectionId: editing.id, etag: editing.etag, title: el('collection-title').value,
        description: el('description').value, posterId: state.poster?.id, posterCreator: state.poster?.creator,
        ...(state.editFranchise && checked('matches').length
          ? { ...requestFor(state.editFranchise, checked('libraries')), contentIds: checked('matches') } : {}) })
      : await importDraft(draftFor(item));
    if (item) { state.selected.delete(itemKey(item)); state.drafts.delete(itemKey(item)); }
    await refreshExisting();
    if (editing && state.editing === editing) {
      state.editing = await api('collection?' + params({ id: editing.id }));
      showPoster(null);
      invalidateMatches();
    }
    if ((item && item === state.current) || (editing && editing.id === state.editing?.id)) {
      status('publish-status', [`Saved “${result.title}” in Silo.`,
        editing && result.added != null ? `${result.added} new titles added.` : '',
        result.skippedLibraries?.length ? `Skipped libraries with fewer than two titles: ${result.skippedLibraries.join(', ')}.` : '',
        result.warning].filter(Boolean).join(' '));
    }
  } catch (error) { status('publish-status', error.message); }
  finally { state.busy = false; drawRows(); updateActions(); }
};

el('all-posters').onclick = () => { el('poster-query').value = ''; listPosters(true); };
el('poster-source').onchange = () => listPosters(true);
el('more-posters').onclick = () => { state.posterPage++; listPosters(false); };
el('more-franchises').onclick = () => { state.page++; listFranchises(false); };
el('poster-form').onsubmit = (event) => { event.preventDefault(); listPosters(true); };
el('franchise-form').onsubmit = (event) => { event.preventDefault(); listFranchises(true); };
el('franchise-sort').onchange = () => listFranchises(true);
el('collection-title').oninput = () => { status('selection-title', el('collection-title').value || 'Your collection'); updateActions(); };
el('description').oninput = () => { state.descriptionDirty = true; };
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
}
updateSortOptions();
el(kind === 'series' ? 'tv-page' : 'movies-page').setAttribute('aria-current', 'page');
status('page-title', kind === 'series' ? 'TV Franchises' : 'Movie Franchises');
void listFranchises(true);
void loadLibraries().then(refreshExisting);
