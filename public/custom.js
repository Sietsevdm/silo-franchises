const libraries = document.querySelector('#libraries');
const search = document.querySelector('#search');
const publish = document.querySelector('#publish');
const results = document.querySelector('#results');
const selected = document.querySelector('#selected');
const searchStatus = document.querySelector('#search-status');
const publishStatus = document.querySelector('#publish-status');
const names = new Map();
const picks = new Map();
let searchVersion = 0;
let publishing = false;

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
  const kind = item.type === 'series' ? 'TV' : 'Movie';
  const year = item.year ? ' (' + item.year + ')' : '';
  return [item.title + year, kind, item.libraryIds.map((id) => names.get(id)).join(', ')].join(' · ');
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
    row.append(itemLabel(item) + ' ', remove);
    selected.append(row);
  }
  for (const checkbox of results.querySelectorAll('input')) {
    checkbox.checked = picks.has(checkbox.value);
    checkbox.disabled = publishing || (!checkbox.checked && picks.size >= 200);
  }
  publish.querySelector('button').disabled = publishing || !picks.size;
}

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
