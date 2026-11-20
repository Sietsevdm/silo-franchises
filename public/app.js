const el = (id) => document.getElementById(id);
const status = (id, text) => { el(id).textContent = text; };
const create = (tag, text) => Object.assign(document.createElement(tag), { textContent: text ?? '' });
const checked = (container) => [...el(container).querySelectorAll('input:checked')].map((input) => input.value);
const state = { provider: 'tmdb', franchisePage: 1, posterPage: 1 };

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

async function listFranchises(reset) {
  const run = state.franchiseRun = Symbol();
  const more = el('more-franchises');
  more.hidden = true;
  if (reset) {
    state.franchisePage = 1;
    state.franchiseQuery = el('franchise-query').value;
    el('franchises').replaceChildren();
  }
  status('franchise-status', 'Loading franchises…');
  try {
    const result = await api('franchises?' + params({ provider: state.provider, q: state.franchiseQuery, page: state.franchisePage }));
    if (state.franchiseRun !== run) return;
    for (const franchise of result.items) {
      const button = create('button', franchise.title);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.selected?.provider === franchise.provider && state.selected.id === franchise.id));
      button.onclick = () => selectFranchise(franchise, button);
      el('franchises').append(button);
    }
    more.hidden = !result.more;
    status('franchise-status', result.total ? `${result.total.toLocaleString()} franchises` : 'No franchises found.');
  } catch (error) {
    if (state.franchiseRun === run) status('franchise-status', error.message);
  }
}

async function selectFranchise(franchise, button) {
  state.selected = franchise;
  for (const item of el('franchises').children) item.setAttribute('aria-pressed', String(item === button));
  el('selection-empty').hidden = true;
  el('selection').hidden = false;
  el('collection-title').value = franchise.title;
  el('source-link').href = franchise.url;
  state.poster = null;
  el('chosen-poster').replaceChildren();
  status('poster-label', 'No poster selected');
  status('publish-status', '');
  invalidateMatches();
  const run = state.selected;
  status('detail-status', 'Loading franchise members…');
  try {
    const result = await api('detail?' + params({ provider: franchise.provider, id: franchise.id }));
    if (state.selected === run) status('detail-status', `${result.members.length} franchise titles`);
  } catch (error) {
    if (state.selected === run) status('detail-status', error.message);
  }
}

function selection() {
  return { provider: state.selected.provider, id: state.selected.id, libraryIds: checked('libraries') };
}
function updatePublish() {
  el('publish').disabled = state.publishing || !state.poster || !checked('matches').length || !el('collection-title').value.trim();
}
function invalidateMatches() {
  state.previewRun = null;
  el('matches').replaceChildren();
  status('match-status', '');
  updatePublish();
}

async function loadLibraries() {
  status('library-status', 'Connecting to Silo…');
  try {
    const libraries = await api('libraries');
    for (const library of libraries) {
      const label = create('label');
      const input = create('input');
      Object.assign(input, { type: 'checkbox', value: library.id });
      input.onchange = invalidateMatches;
      label.append(input, document.createTextNode(library.name));
      el('libraries').append(label);
    }
    status('library-status', libraries.length ? '' : 'No enabled Silo libraries found.');
  } catch (error) {
    status('library-status', error.message);
  }
}

el('preview').onclick = async () => {
  invalidateMatches();
  const run = state.previewRun = Symbol();
  status('match-status', 'Matching your library…');
  try {
    const result = await post('preview', selection());
    if (state.previewRun !== run) return;
    const used = new Set();
    for (const item of result) {
      const row = create(item.contentId ? 'label' : 'div');
      row.className = 'match';
      if (item.contentId && !used.has(item.contentId)) {
        const input = create('input');
        Object.assign(input, { type: 'checkbox', value: item.contentId, checked: true });
        input.onchange = updatePublish;
        row.append(input);
        used.add(item.contentId);
      } else row.classList.add('missing');
      row.append(create('span', item.title + (item.year ? ` (${item.year})` : '')), create('small', item.basis));
      el('matches').append(row);
    }
    status('match-status', `${used.size} of ${result.length} titles matched. Select the titles you want to add.`);
    updatePublish();
  } catch (error) {
    if (state.previewRun === run) status('match-status', error.message);
  }
};

function posterImage(poster) {
  const image = create('img');
  image.src = poster.image;
  image.alt = poster.title;
  image.loading = 'lazy';
  return image;
}
async function listPosters(reset) {
  const run = state.posterRun = Symbol();
  const more = el('more-posters');
  more.hidden = true;
  if (reset) {
    state.posterPage = 1;
    state.posterQuery = el('poster-query').value;
    el('posters').replaceChildren();
  }
  status('poster-status', state.posterQuery ? 'Searching RedHeadJedi’s collection posters…' : 'Loading posters…');
  try {
    const result = await api('posters?' + params({ q: state.posterQuery, page: state.posterPage }));
    if (state.posterRun !== run) return;
    el('gallery-link').href = result.gallery;
    for (const poster of result.items) {
      const button = create('button');
      button.type = 'button';
      button.append(posterImage(poster), create('span', poster.title));
      button.onclick = () => {
        state.poster = poster;
        status('poster-label', poster.title);
        el('chosen-poster').replaceChildren(posterImage(poster));
        el('poster-dialog').close();
        updatePublish();
      };
      el('posters').append(button);
    }
    more.hidden = !result.more;
    status('poster-status', result.items.length ? '' : 'No matching posters. Try a shorter title or browse all posters.');
  } catch (error) {
    if (state.posterRun === run) status('poster-status', error.message);
  }
}

el('choose-poster').onclick = () => {
  el('poster-query').value = state.selected.title.replace(/\s+(?:collection|franchise|universe)$/i, '');
  el('poster-dialog').showModal();
  listPosters(true);
};
el('close-posters').onclick = () => el('poster-dialog').close();
el('all-posters').onclick = () => { el('poster-query').value = ''; listPosters(true); };
el('more-posters').onclick = () => { state.posterPage++; listPosters(false); };
el('more-franchises').onclick = () => { state.franchisePage++; listFranchises(false); };
el('poster-form').onsubmit = (event) => { event.preventDefault(); listPosters(true); };
el('franchise-form').onsubmit = (event) => { event.preventDefault(); listFranchises(true); };
el('collection-title').oninput = updatePublish;
for (const button of document.querySelectorAll('[data-provider]')) {
  button.onclick = () => {
    state.provider = button.dataset.provider;
    for (const other of document.querySelectorAll('[data-provider]')) other.setAttribute('aria-pressed', String(button === other));
    listFranchises(true);
  };
}
el('publish').onclick = async () => {
  state.publishing = true;
  updatePublish();
  status('publish-status', 'Adding the collection to Silo…');
  try {
    const result = await post('import', {
      ...selection(), title: el('collection-title').value, posterId: state.poster.id, contentIds: checked('matches'),
    });
    status('publish-status', `“${result.title}” is in Silo with ${result.added} titles and your selected poster.`);
  } catch (error) {
    status('publish-status', error.message);
  } finally {
    state.publishing = false;
    updatePublish();
  }
};

listFranchises(true);
loadLibraries();
