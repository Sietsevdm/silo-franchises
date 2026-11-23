const libraries = document.querySelector('#libraries');
const search = document.querySelector('#search');
const publish = document.querySelector('#publish');
const results = document.querySelector('#results');
const selected = document.querySelector('#selected');
const searchStatus = document.querySelector('#search-status');
const publishStatus = document.querySelector('#publish-status');
const createButton = document.querySelector('#create-custom');
const queueButton = document.querySelector('#queue-custom');
const bulkPanel = document.querySelector('#custom-queue');
const bulkItems = document.querySelector('#custom-queue-items');
const bulkStatus = document.querySelector('#custom-queue-status');
const bulkPublish = document.querySelector('#publish-custom-queue');
const selectResults = document.querySelector('#select-custom-results');
const mdbSearch = document.querySelector('#mdblist-search');
const mdbResults = document.querySelector('#mdblist-results');
const mdbStatus = document.querySelector('#mdblist-status');
const posterSearch = document.querySelector('#custom-poster-search');
const posterSource = document.querySelector('#custom-poster-source');
const posterResults = document.querySelector('#custom-posters');
const posterStatus = document.querySelector('#custom-poster-status');
const posterChoice = document.querySelector('#custom-poster-choice');
const morePosters = document.querySelector('#more-custom-posters');
const posterUrl = publish.elements.posterUrl;
const names = new Map();
const picks = new Map();
const queueKey = 'silo-custom-collection-queue';
let searchVersion = 0;
let publishing = false;
let selectedPoster;
let posterRun;
let titleResults = [];
let queue = readQueue();
let editing;
let librariesReady = false;
let mdbVersion = 0;

async function api(path, options) {
  const response = await fetch('/api/' + path, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'The request failed.'), { status: response.status });
  return data;
}

const createCollection = (payload) => api('custom-collection', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Franchise-App': '1' },
  body: JSON.stringify(payload),
});

function readQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(queueKey));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function updateQueue(change) {
  const next = change(readQueue());
  localStorage.setItem(queueKey, JSON.stringify(next));
  queue = next;
  renderQueue();
}

function libraryIds() {
  return Array.from(libraries.querySelectorAll(':checked'), (input) => input.value);
}

function itemLabel(item) {
  const label = document.createElement('span');
  label.className = 'custom-selected-label';
  const kind = item.type === 'series' ? 'TV' : 'Movie';
  const year = item.year ? ' (' + item.year + ')' : '';
  const meta = document.createElement('small');
  meta.className = 'custom-title-meta';
  meta.textContent = kind + ' · ' + item.libraryIds.map((id) => names.get(id)).join(', ');
  label.append(item.title + year, meta);
  return label;
}

function renderSelection() {
  selected.replaceChildren();
  for (const item of picks.values()) {
    const row = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + item.title);
    remove.disabled = publishing;
    remove.onclick = () => {
      picks.delete(item.id);
      renderSelection();
    };
    const content = document.createElement('div');
    content.className = 'custom-selected-row';
    content.append(itemLabel(item), remove);
    row.append(content);
    selected.append(row);
  }
  for (const checkbox of results.querySelectorAll('input')) {
    checkbox.checked = picks.has(checkbox.value);
    checkbox.disabled = publishing || (!checkbox.checked && picks.size >= 200);
  }
  createButton.disabled = publishing || !picks.size;
  queueButton.disabled = createButton.disabled;
  queueButton.textContent = editing ? 'Update queued collection' : 'Add to bulk queue';
  selectResults.hidden = !titleResults.length;
  selectResults.disabled = publishing || picks.size >= 200 || titleResults.every((item) => picks.has(item.id));
}

function choosePoster(poster) {
  selectedPoster = poster;
  posterChoice.hidden = !poster;
  const image = document.querySelector('#custom-poster-image');
  if (poster) {
    posterUrl.value = '';
    image.src = poster.image;
    document.querySelector('#custom-poster-label').textContent = poster.title + ' · ' + poster.creator;
  } else image.removeAttribute('src');
  for (const button of posterResults.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === poster?.id));
  }
}

async function listPosters(run) {
  morePosters.hidden = true;
  posterStatus.textContent = 'Loading artwork…';
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      const params = new URLSearchParams({ q: run.query, creator: run.creator, page: run.page, mode: run.mode });
      result = await api('posters?' + params);
      if (run !== posterRun) return;
      run.mode = result.mode;
      if (result.items.length || !result.more || !run.query || attempt === 2) break;
      run.page++;
    }
    for (const poster of result.items) {
      if (run.seen.has(poster.id)) continue;
      run.seen.add(poster.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = poster.id;
      button.setAttribute('aria-pressed', String(selectedPoster?.id === poster.id));
      button.onclick = () => choosePoster(poster);
      const image = document.createElement('img');
      image.src = poster.image;
      image.alt = '';
      image.loading = 'lazy';
      const creator = document.createElement('small');
      creator.textContent = poster.creator;
      button.append(image, poster.title, creator);
      posterResults.append(button);
    }
    morePosters.hidden = !result.more;
    const empty = !result.items.length && (result.more ? 'No matches on these pages. Load more to keep searching.' : 'No more poster matches.');
    const unavailable = result.unavailable?.length && ('Could not load: ' + result.unavailable.join(', ') + '.');
    posterStatus.textContent = [empty, unavailable].filter(Boolean).join(' ');
  } catch (error) {
    if (run === posterRun) {
      posterStatus.textContent = error.message;
      if (run.page > 1) {
        run.page--;
        morePosters.hidden = false;
      }
    }
  }
}

function searchPosters() {
  posterResults.replaceChildren();
  posterRun = { query: posterSearch.elements.query.value.trim(), creator: posterSource.value, page: 1, mode: '', seen: new Set() };
  void listPosters(posterRun);
}

posterSearch.addEventListener('submit', (event) => {
  event.preventDefault();
  searchPosters();
});
posterSource.addEventListener('change', searchPosters);
document.querySelector('#browse-custom-posters').onclick = () => {
  posterSearch.reset();
  searchPosters();
};
morePosters.onclick = () => {
  posterRun.page++;
  void listPosters(posterRun);
};
document.querySelector('#clear-custom-poster').onclick = () => choosePoster();
posterUrl.addEventListener('input', () => {
  if (posterUrl.value.trim() && selectedPoster) choosePoster();
});

libraries.addEventListener('change', () => {
  searchVersion++;
  const ids = libraryIds();
  search.querySelector('button').disabled = !ids.length;
  results.replaceChildren();
  titleResults = [];
  let removed = 0;
  for (const [id, item] of picks) {
    if (item.libraryIds.some((library) => ids.includes(library))) continue;
    picks.delete(id);
    removed++;
  }
  searchStatus.textContent = removed ? removed + ' selected title(s) removed because their libraries were deselected.' : '';
  renderSelection();
});

selectResults.onclick = () => {
  for (const item of titleResults) {
    if (picks.size >= 200) break;
    picks.set(item.id, item);
  }
  renderSelection();
};

function showTitleResults(items) {
  titleResults = items;
  results.replaceChildren();
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'check-line';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.id;
    checkbox.onchange = () => {
      if (checkbox.checked) picks.set(item.id, item);
      else picks.delete(item.id);
      renderSelection();
    };
    label.append(checkbox, itemLabel(item));
    results.append(label);
  }
  renderSelection();
}

async function useMdbList(list) {
  if (publishing || !librariesReady) return;
  const version = ++mdbVersion;
  const editorVersion = searchVersion;
  mdbStatus.textContent = 'Matching “' + list.name + '” across your libraries…';
  try {
    const data = await api('mdblist-matches?' + new URLSearchParams({ id: list.id }));
    if (version !== mdbVersion) return;
    if (editorVersion !== searchVersion || publishing) {
      mdbStatus.textContent = 'The editor changed during matching. Choose the list again to apply it.';
      return;
    }
    if (!data.items.length) {
      mdbStatus.textContent = 'No unambiguous matches found for “' + list.name + '”.';
      return;
    }
    const librarySet = new Set(data.libraryIds);
    for (const checkbox of libraries.querySelectorAll('input')) checkbox.checked = librarySet.has(checkbox.value);
    libraries.dispatchEvent(new Event('change'));
    picks.clear();
    for (const item of data.items.slice(0, 200)) picks.set(item.id, item);
    showTitleResults(data.items);
    if (!publish.elements.title.value.trim()) publish.elements.title.value = list.name.slice(0, 150);
    posterSearch.elements.query.value = list.name.slice(0, 150);
    searchPosters();
    mdbStatus.textContent = 'Matched ' + data.matched + ' of ' + data.total + ' list entries in ' + data.libraryIds.length + ' libraries.';
    searchStatus.textContent = data.items.length > 200
      ? 'Selected the first 200 matching titles. Deselect titles to choose others from the results below.'
      : 'Selected ' + data.items.length + ' matching titles.';
  } catch (error) {
    if (version === mdbVersion) mdbStatus.textContent = error.message;
  }
}

mdbSearch.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = mdbSearch.elements.query.value.trim();
  if (!query) return;
  const version = ++mdbVersion;
  mdbResults.replaceChildren();
  mdbStatus.textContent = 'Searching MDBList…';
  try {
    const lists = await api('mdblist-search?' + new URLSearchParams({ q: query }));
    if (version !== mdbVersion) return;
    for (const list of lists) {
      const row = document.createElement('div');
      row.className = 'custom-selected-row';
      const label = document.createElement('span');
      label.className = 'custom-selected-label';
      label.textContent = list.name;
      const meta = document.createElement('small');
      meta.className = 'custom-title-meta';
      meta.textContent = [list.owner, Number.isFinite(list.count) ? list.count + ' entries' : ''].filter(Boolean).join(' · ');
      label.append(meta);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Use list';
      button.setAttribute('aria-label', 'Use list ' + list.name);
      button.onclick = () => void useMdbList(list);
      row.append(label, button);
      mdbResults.append(row);
    }
    mdbStatus.textContent = lists.length ? 'Choose a list to replace the selected libraries and titles with its matches.' : 'No public lists found.';
  } catch (error) {
    if (version === mdbVersion) mdbStatus.textContent = error.message;
  }
});

search.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = search.elements.query.value.trim();
  if (!query || !libraryIds().length) return;
  const version = ++searchVersion;
  const params = new URLSearchParams({ q: query });
  for (const id of libraryIds()) params.append('library', id);
  posterSearch.elements.query.value = query;
  searchPosters();
  results.replaceChildren();
  titleResults = [];
  renderSelection();
  searchStatus.textContent = 'Searching Silo…';
  try {
    const data = await api('custom-titles?' + params);
    if (version !== searchVersion) return;
    showTitleResults(data.items);
    searchStatus.textContent = data.total > data.items.length
      ? 'Showing the first 50 matches. Narrow your search to see other titles.'
      : data.total ? data.total + ' matching title(s).' : 'No matching titles.';
  } catch (error) {
    if (version === searchVersion) searchStatus.textContent = error.message;
  }
});

function collectionPayload() {
  const fields = Object.fromEntries(new FormData(publish));
  fields.title = fields.title.trim();
  if (!fields.title) throw new Error('Enter a collection name.');
  const ids = libraryIds();
  if (!ids.length) throw new Error('Select at least one library.');
  if (!fields.posterUrl.trim()) delete fields.posterUrl;
  if (selectedPoster) {
    fields.posterId = selectedPoster.id;
    fields.posterCreator = selectedPoster.creator;
  }
  return { ...fields, libraryIds: ids, contentIds: [...picks.keys()] };
}

function clearEditor() {
  searchVersion++;
  editing = undefined;
  publish.reset();
  choosePoster();
  picks.clear();
  renderSelection();
}

function setPublishing(value) {
  publishing = value;
  libraries.disabled = value;
  renderSelection();
  renderQueue();
}

function openDraft(draft) {
  const { payload } = draft;
  editing = draft.id;
  for (const checkbox of libraries.querySelectorAll('input')) {
    checkbox.checked = payload.libraryIds.includes(checkbox.value);
  }
  libraries.dispatchEvent(new Event('change'));
  picks.clear();
  const ids = libraryIds();
  for (const item of draft.items) {
    if (item.libraryIds.some((id) => ids.includes(id))) picks.set(item.id, item);
  }
  publish.elements.title.value = payload.title;
  publish.elements.description.value = payload.description;
  choosePoster(draft.poster);
  posterUrl.value = payload.posterUrl ?? '';
  publishStatus.textContent = 'Editing “' + payload.title + '”.';
  if (picks.size < draft.items.length) publishStatus.textContent += ' Some titles belong to libraries that are no longer available.';
  renderSelection();
  publish.elements.title.focus();
}

function renderQueue() {
  bulkPanel.hidden = !queue.length && !bulkStatus.textContent;
  bulkPublish.disabled = publishing || !queue.length;
  bulkItems.replaceChildren();
  for (const draft of queue) {
    const row = document.createElement('li');
    const content = document.createElement('div');
    content.className = 'custom-selected-row';
    const label = document.createElement('span');
    label.className = 'custom-selected-label';
    label.textContent = draft.payload.title;
    const detail = document.createElement('small');
    detail.className = 'custom-title-meta';
    detail.textContent = draft.payload.contentIds.length + ' titles' + (draft.error ? ' · ' + draft.error : '');
    label.append(detail);
    const actions = document.createElement('div');
    actions.className = 'line';
    for (const [name, action] of [
      ['Edit', () => openDraft(draft)],
      ['Remove', () => {
        try {
          updateQueue((items) => items.filter((item) => item.id !== draft.id));
          if (editing === draft.id) {
            editing = undefined;
            renderSelection();
          }
        } catch (error) { bulkStatus.textContent = error.message; }
      }],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.setAttribute('aria-label', name + ' ' + draft.payload.title);
      button.disabled = publishing || (name === 'Edit' && !librariesReady);
      button.onclick = action;
      actions.append(button);
    }
    content.append(label, actions);
    row.append(content);
    bulkItems.append(row);
  }
}

bulkPublish.onclick = async () => {
  if (publishing) return;
  const pending = [...queue];
  let completed = 0;
  setPublishing(true);
  try {
    for (const [index, draft] of pending.entries()) {
      bulkStatus.textContent = 'Publishing ' + (index + 1) + ' of ' + pending.length + ' · ' + draft.payload.title;
      try {
        await createCollection(draft.payload);
      } catch (error) {
        updateQueue((items) => items.map((item) => item.id === draft.id ? { ...item, error: error.message } : item));
        if (error.status === 429) break;
        continue;
      }
      updateQueue((items) => items.filter((item) => item.id !== draft.id));
      if (editing === draft.id) {
        editing = undefined;
        renderSelection();
      }
      completed++;
    }
    bulkStatus.textContent = 'Published ' + completed + ' of ' + pending.length + ' collections.'
      + (queue.length ? ' Remaining collections are still queued.' : '');
  } catch (error) {
    bulkStatus.textContent = error.message;
  } finally {
    setPublishing(false);
  }
};

window.addEventListener('storage', (event) => {
  if (event.key !== queueKey) return;
  queue = readQueue();
  renderQueue();
});

publish.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (publishing || !picks.size) return;
  let payload;
  try {
    payload = collectionPayload();
    if (event.submitter === queueButton) {
      const draft = { id: editing ?? crypto.randomUUID(), payload, items: [...picks.values()], poster: selectedPoster };
      updateQueue((items) => {
        const index = items.findIndex((item) => item.id === draft.id);
        if (index >= 0) return items.map((item) => item.id === draft.id ? draft : item);
        return [...items, draft];
      });
      clearEditor();
      publishStatus.textContent = 'Queued “' + payload.title + '”.';
      return;
    }
  } catch (error) {
    publishStatus.textContent = error.message;
    return;
  }
  setPublishing(true);
  publishStatus.textContent = 'Creating collection in Silo…';
  try {
    const result = await createCollection(payload);
    if (editing) updateQueue((items) => items.filter((item) => item.id !== editing));
    clearEditor();
    publishStatus.textContent = 'Created “' + result.title + '” with ' + result.added + ' titles. Open Collections in a selected Silo library to find it.';
  } catch (error) {
    publishStatus.textContent = error.message;
  } finally {
    setPublishing(false);
  }
});

async function loadLibraries() {
  try {
    const available = (await api('libraries')).filter((library) => library.mediaKind);
    for (const library of available) {
      names.set(library.id, library.name);
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = library.id;
      label.append(checkbox, library.name);
      libraries.append(label);
    }
    if (!available.length) searchStatus.textContent = 'No enabled movie or TV libraries were found.';
    librariesReady = true;
    renderQueue();
  } catch (error) {
    searchStatus.textContent = error.message;
  }
}

async function loadPosterSources() {
  try {
    for (const creator of await api('poster-sources')) posterSource.add(new Option(creator, creator));
  } catch (error) {
    posterStatus.textContent = error.message;
  }
}

void loadLibraries();
void loadPosterSources();
renderQueue();
