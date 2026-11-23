const libraries = document.querySelector('#libraries');
const search = document.querySelector('#search');
const publish = document.querySelector('#publish');
const results = document.querySelector('#results');
const selected = document.querySelector('#selected');
const searchStatus = document.querySelector('#search-status');
const publishStatus = document.querySelector('#publish-status');
const createButton = document.querySelector('#create-custom');
const posterSearch = document.querySelector('#custom-poster-search');
const posterSource = document.querySelector('#custom-poster-source');
const posterResults = document.querySelector('#custom-posters');
const posterStatus = document.querySelector('#custom-poster-status');
const posterChoice = document.querySelector('#custom-poster-choice');
const morePosters = document.querySelector('#more-custom-posters');
const posterUrl = publish.elements.posterUrl;
const names = new Map();
const picks = new Map();
let searchVersion = 0;
let publishing = false;
let selectedPoster;
let posterRun;

async function api(path, options) {
  const response = await fetch('/api/' + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
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
  let removed = 0;
  for (const [id, item] of picks) {
    if (item.libraryIds.some((library) => ids.includes(library))) continue;
    picks.delete(id);
    removed++;
  }
  searchStatus.textContent = removed ? removed + ' selected title(s) removed because their libraries were deselected.' : '';
  renderSelection();
});

search.addEventListener('submit', async (event) => {
  event.preventDefault();
  const version = ++searchVersion;
  const params = new URLSearchParams({ q: search.elements.query.value });
  for (const id of libraryIds()) params.append('library', id);
  results.replaceChildren();
  searchStatus.textContent = 'Searching Silo…';
  try {
    const data = await api('custom-titles?' + params);
    if (version !== searchVersion) return;
    for (const item of data.items) {
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
    searchStatus.textContent = data.total > data.items.length
      ? 'Showing the first 50 matches. Narrow your search to see other titles.'
      : data.total ? data.total + ' matching title(s).' : 'No matching titles.';
    renderSelection();
  } catch (error) {
    if (version === searchVersion) searchStatus.textContent = error.message;
  }
});

publish.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (publishing || !picks.size) return;
  const fields = Object.fromEntries(new FormData(publish));
  if (!fields.posterUrl.trim()) delete fields.posterUrl;
  if (selectedPoster) {
    fields.posterId = selectedPoster.id;
    fields.posterCreator = selectedPoster.creator;
  }
  publishing = true;
  libraries.disabled = true;
  renderSelection();
  publishStatus.textContent = 'Creating collection in Silo…';
  try {
    const result = await api('custom-collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, libraryIds: libraryIds(), contentIds: [...picks.keys()] }),
    });
    publish.reset();
    choosePoster();
    picks.clear();
    publishStatus.textContent = 'Created “' + result.title + '” with ' + result.added + ' titles. Open Collections in a selected Silo library to find it.';
  } catch (error) {
    publishStatus.textContent = error.message;
  } finally {
    publishing = false;
    libraries.disabled = false;
    renderSelection();
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
