/* ============================================================
   VideoStream — public streaming site (browse, search, watch), Netflix-style.
   Talks only to /api/public, which returns published videos and nothing else.
   It has no upload, job, queue or log features: those live in the separate admin app.
   Depends on /shared/common.js.
   ============================================================ */
(function () {
  const { esc, timeAgo, formatDuration, toast, copyText, dialog, whenHls } = window.VF;

  const app = document.getElementById('app');
  const hdr = document.getElementById('hdr');
  const searchInput = document.getElementById('q');
  const searchForm = document.getElementById('search-form');

  const state = { videos: {}, series: [], episodes: {}, loaded: false, error: '', seasonPick: {} };
  let currentView = null; // { update?, teardown? }

  // ─── Helpers ───────────────────────────────────────────────
  const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h0"/>',
    share: '<path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v14"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 15h18M8 4v16M16 4v16"/>',
    alert: '<path d="M12 3l10 18H2L12 3zM12 10v5M12 18h0"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
  };
  const svg = (name, size = 18) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ─── Account ───────────────────────────────────────────────
  // My List, the watch history and where each video was left are saved to the viewer's account, so
  // they follow them to any device. Preferences (speed, subtitle and audio language) stay on the device.
  const account = { user: null, list: [], progress: {} };

  function accountApi(url, method, body) {
    return fetch(url, { method, keepalive: true, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      .then((res) => { if (res.status === 401) showSignedOut(); return res; })
      .catch(() => { /* offline: the next change sends the latest state anyway */ });
  }

  // Progress changes every couple of seconds while playing; send them at most every 10 s (and when leaving)
  let pendingProgress = {};
  let progressTimer = null;
  function flushProgress() {
    clearTimeout(progressTimer);
    progressTimer = null;
    const batch = pendingProgress;
    pendingProgress = {};
    Object.keys(batch).forEach((id) => accountApi(`/api/me/progress/${encodeURIComponent(id)}`, 'PUT', batch[id]));
  }
  function queueProgress(id, patch) {
    pendingProgress[id] = { ...(pendingProgress[id] || {}), ...patch };
    if (!progressTimer) progressTimer = setTimeout(flushProgress, 10000);
  }
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });

  const historyEntries = () => Object.entries(account.progress)
    .filter(([, p]) => p.seen).sort((a, b) => b[1].seen - a[1].seen).map(([id, p]) => ({ id, at: p.seen }));
  function forget(id) {
    delete account.progress[id];
    delete pendingProgress[id];
    accountApi(`/api/me/progress/${encodeURIComponent(id)}`, 'DELETE');
  }
  function setProgressField(id, field, value) {
    account.progress[id] = { ...(account.progress[id] || {}), [field]: value };
    queueProgress(id, { [field]: value });
  }

  // Same get/set/del shape as `storage`, for the keys that belong to the account
  const userStore = {
    get(key) {
      if (key === 'vs-list') return JSON.stringify(account.list);
      if (key === 'vs-history') return JSON.stringify(historyEntries());
      const m = /^vs-(pos|seen|watched)-(.+)$/.exec(key);
      if (!m) return null;
      const p = account.progress[m[2]];
      if (!p) return null;
      if (m[1] === 'watched') return p.watched ? '1' : null;
      return p[m[1]] ? String(p[m[1]]) : null;
    },
    set(key, value) {
      if (key === 'vs-list') {
        account.list = JSON.parse(value);
        accountApi('/api/me/list', 'PUT', { items: account.list });
        return;
      }
      if (key === 'vs-history') {
        const next = JSON.parse(value);
        const keep = new Set(next.map((h) => h.id));
        historyEntries().forEach((h) => { if (!keep.has(h.id)) forget(h.id); });
        next.forEach((h) => { if ((account.progress[h.id] || {}).seen !== h.at) setProgressField(h.id, 'seen', h.at); });
        return;
      }
      const m = /^vs-(pos|seen|watched)-(.+)$/.exec(key);
      if (!m) return;
      if (m[1] === 'watched') setProgressField(m[2], 'watched', true);
      else setProgressField(m[2], m[1], Number(value) || 0);
    },
    del(key) {
      if (key === 'vs-history') {
        account.progress = {};
        pendingProgress = {};
        accountApi('/api/me/progress', 'DELETE');
        return;
      }
      const m = /^vs-(pos|watched)-(.+)$/.exec(key);
      if (m) setProgressField(m[2], m[1], m[1] === 'pos' ? 0 : false);
    },
  };

  // The API already returns display-ready fields (title, duration, height, publishedAt)
  const titleOf = (v) => v.title;
  const height = (v) => v.height || 0;
  const seconds = (v) => v.duration || 0;
  const qualityOf = (v) => (height(v) ? `${height(v)}p` : '');
  const ageMs = (v) => Date.now() - new Date(v.publishedAt).getTime();
  const isAnime = (x) => x.category === 'anime';
  const watchHref = (v) => `#/watch/${encodeURIComponent(v.id)}`;

  // ─── Series helpers ────────────────────────────────────────
  // Season 0 is for specials; everything else reads "S1 E3"
  const epLabel = (e) => (e.season === 0 ? `Special ${e.episode}` : `S${e.season} E${e.episode}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const seriesHref = (s) => `#/series/${encodeURIComponent(s.id)}`;
  const allEpisodes = (s) => s.seasons.flatMap((season) => season.episodes);
  const seriesLine = (s) => `${plural(s.seasonCount, 'season')} · ${plural(s.episodeCount, 'episode')}`;
  // My List keeps movies by id and series as "series:<id>"
  const listIdOf = (v) => (v.episode ? `series:${v.episode.seriesId}` : v.id);
  const seriesLibrary = () => [...state.series].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  // Any playable thing the viewer can have in history / lists: a movie or an episode
  const itemById = (id) => state.videos[id] || state.episodes[id] || null;
  const savedPos = (id) => parseFloat(userStore.get(`vs-pos-${id}`));
  const unfinished = (v) => { const pos = savedPos(v.id); return pos > 5 && seconds(v) && pos < seconds(v) - 5 ? pos : 0; };

  // What the Play button of a series should do. `kind` says why: resume an unfinished episode, go
  // back to one that was started, move on after a finished episode, or start from the first.
  function playTarget(s) {
    const eps = allEpisodes(s);
    const seen = eps.map((e) => ({ e, at: parseFloat(userStore.get(`vs-seen-${e.id}`)) || 0 })).filter((x) => x.at).sort((a, b) => b.at - a.at)[0];
    if (seen) {
      const pos = unfinished(seen.e);
      if (pos) return { ep: seen.e, pos, kind: 'resume', label: `Resume ${epLabel(seen.e)}` };
      if (!userStore.get(`vs-watched-${seen.e.id}`)) return { ep: seen.e, pos: 0, kind: 'again', label: `Play ${epLabel(seen.e)}` };
      const next = eps[eps.findIndex((e) => e.id === seen.e.id) + 1];
      if (next) return { ep: next, pos: 0, kind: 'next', label: `Play ${epLabel(next)}` };
    }
    return { ep: eps[0], pos: 0, kind: 'first', label: `Play ${epLabel(eps[0])}` };
  }


  function library() {
    return Object.values(state.videos).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }

  // Saved to the viewer's account
  const readList = () => { try { return JSON.parse(userStore.get('vs-list') || '[]'); } catch { return []; } };
  const inList = (id) => readList().includes(id);
  function toggleList(id) {
    const list = readList();
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.unshift(id);
    userStore.set('vs-list', JSON.stringify(list));
    const v = id.startsWith('series:') ? state.series.find((x) => `series:${x.id}` === id) : state.videos[id];
    toast(i >= 0 ? 'Removed from My List' : `Added to My List${v ? `: ${titleOf(v)}` : ''}`, 'info', 2200);
  }

  // Watch history, saved to the account: [{ id, at }], newest first
  const readHistory = () => { try { return JSON.parse(userStore.get('vs-history') || '[]'); } catch { return []; } };
  function recordHistory(id) {
    const history = readHistory().filter((h) => h.id !== id);
    history.unshift({ id, at: Date.now() });
    userStore.set('vs-history', JSON.stringify(history.slice(0, 100)));
  }
  function removeHistory(id) {
    userStore.set('vs-history', JSON.stringify(readHistory().filter((h) => h.id !== id)));
  }

  // Things the viewer started but did not finish, most recently watched first. A series shows once:
  // its unfinished episode, or the next episode after one they finished.
  function continueWatching() {
    const entries = [];
    for (const v of library()) {
      const pos = unfinished(v);
      if (pos) entries.push({ v, pos, seen: parseFloat(userStore.get(`vs-seen-${v.id}`)) || 0 });
    }
    for (const series of state.series) {
      const t = playTarget(series);
      const lastSeen = Math.max(0, ...allEpisodes(series).map((e) => parseFloat(userStore.get(`vs-seen-${e.id}`)) || 0));
      if (!lastSeen) continue; // never started this series
      entries.push({ v: t.ep, pos: t.pos, seen: lastSeen, upNext: t.kind === 'next' });
    }
    return entries.sort((a, b) => b.seen - a.seen);
  }

  const FILTERS = {
    new: { title: 'New this week', test: (v) => ageMs(v) < 7 * 864e5 },
    hd: { title: 'Watch in HD', test: (v) => height(v) >= 720 },
    short: { title: 'Quick watches · under 5 minutes', test: (v) => seconds(v) > 0 && seconds(v) < 300 },
    long: { title: 'Long watches · 5 minutes and more', test: (v) => seconds(v) >= 300 },
  };

  // ─── Data ──────────────────────────────────────────────────
  async function load() {
    try {
      // 'no-cache' = always ask the server whether the list changed (cheap 304 if not), so a rename shows at once
      const [moviesRes, seriesRes] = await Promise.all([
        fetch('/api/public/videos', { cache: 'no-cache' }),
        fetch('/api/public/series', { cache: 'no-cache' }).catch(() => null),
      ]);
      if (moviesRes.status === 401) return showSignedOut();
      const json = await moviesRes.json();
      if (!json.success) throw new Error(json.error?.message || 'Could not load videos');
      const seriesJson = seriesRes ? await seriesRes.json().catch(() => null) : null;
      const series = seriesJson && seriesJson.success ? seriesJson.data.series : [];

      const next = {};
      json.data.videos.forEach((v) => { next[v.id] = v; });
      const episodes = {};
      series.forEach((sr) => allEpisodes(sr).forEach((e) => { episodes[e.id] = { ...e, seriesId: sr.id, seriesTitle: sr.title }; }));

      // Anything that was not there before the last refresh is newly published
      const freshMovies = state.loaded ? json.data.videos.filter((v) => !state.videos[v.id]) : [];
      const freshEpisodes = state.loaded ? Object.values(episodes).filter((e) => !state.episodes[e.id]) : [];
      state.videos = next;
      state.series = series;
      state.episodes = episodes;
      state.error = '';
      if (freshMovies.length) toast(freshMovies.length === 1 ? `New on VideoStream: ${titleOf(freshMovies[0])}` : `${freshMovies.length} new videos on VideoStream`, 'info');
      else if (freshEpisodes.length) toast(freshEpisodes.length === 1 ? `New episode: ${freshEpisodes[0].seriesTitle} ${epLabel(freshEpisodes[0])}` : `${freshEpisodes.length} new episodes`, 'info');
    } catch (err) {
      if (!state.loaded) state.error = err.message;
    }
    state.loaded = true;
    refreshView();
  }

  // Newly published (or removed) videos show up without a reload
  function startPolling() {
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    // Coming back to the tab refreshes straight away, so renames and new videos show up promptly
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  }

  // ─── Router ────────────────────────────────────────────────
  function parseRoute() {
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [name = '', param = ''] = path.split('/');
    return { name: name || 'home', param: decodeURIComponent(param), q: (new URLSearchParams(query).get('q') || '').trim() };
  }

  let refreshQueued = false;
  function refreshView() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (parseRoute().name === 'watch' && currentView && currentView.update) currentView.update();
      else render();
    });
  }

  function setNav(key) {
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
  }

  function render() {
    if (currentView && currentView.teardown) currentView.teardown();
    currentView = null;
    const route = parseRoute();
    hdr.classList.toggle('solid', route.name !== 'home');
    if (route.name !== 'search' && document.activeElement !== searchInput) searchInput.value = '';
    if (route.name === 'search' && document.activeElement !== searchInput) searchInput.value = route.q;

    if (signedOut) return;
    if (route.name === 'login' || route.name === 'signup') { location.hash = '#/'; return; }
    switch (route.name) {
      case 'watch': setNav(''); currentView = watchView(route.param); break;
      case 'search': setNav(''); currentView = gridView(`Results for “${route.q}”`, 'search', route.q); break;
      case 'browse': setNav(route.param); currentView = gridView(FILTERS[route.param] ? FILTERS[route.param].title : 'Browse', route.param); break;
      case 'movies': setNav('movies'); currentView = gridView('Movies', 'movies'); break;
      case 'anime': setNav('anime'); currentView = gridView('Anime', 'anime'); break;
      case 'mylist': setNav('mylist'); currentView = gridView('My List', 'mylist'); break;
      case 'history': setNav('history'); currentView = gridView('Watch history', 'history'); break;
      case 'series': setNav('series'); currentView = route.param ? seriesView(route.param) : gridView('TV Series', 'series'); break;
      default: setNav('home'); currentView = homeView();
    }
  }

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
  window.addEventListener('scroll', () => hdr.classList.toggle('scrolled', window.scrollY > 10), { passive: true });

  // ─── Search ────────────────────────────────────────────────
  function goSearch(q) {
    const target = q ? `#/search?q=${encodeURIComponent(q)}` : '#/';
    if (parseRoute().name === 'watch') { location.hash = target; return; }
    history.replaceState(null, '', target); // typing shouldn't flood the history
    render();
  }
  let searchTimer;
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => goSearch(searchInput.value.trim()), 250); });
  searchForm.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); goSearch(searchInput.value.trim()); });
  document.getElementById('search-toggle').addEventListener('click', () => { searchForm.classList.add('open'); searchInput.focus(); });
  searchInput.addEventListener('blur', () => { if (!searchInput.value) searchForm.classList.remove('open'); });

  // ─── Shared markup ─────────────────────────────────────────
  const thumbHtml = (v) => (v.thumbnailUrl
    ? `<img src="${esc(v.thumbnailUrl)}" alt="" loading="lazy" />`
    : `<span class="thumb-empty">${svg('film', 28)}</span>`);

  const metaLine = (v) => [height(v) >= 720 ? '<span class="hdtag">HD</span>' : '', seconds(v) ? esc(formatDuration(seconds(v))) : '', esc(timeAgo(v.publishedAt))]
    .filter(Boolean).join(' <span class="dot">·</span> ');

  function tileHtml(v, pos) {
    const listed = inList(v.id);
    const progress = pos && seconds(v) ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(v)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <article class="tile">
        <a class="tile-thumb" href="${watchHref(v)}" aria-label="Play ${esc(titleOf(v))}">${thumbHtml(v)}${progress}</a>
        <div class="tile-info">
          <div class="tile-btns">
            <a class="round round-play" href="${watchHref(v)}" aria-label="Play">${svg('play', 16)}</a>
            <button class="round" data-act="list" data-id="${esc(v.id)}" aria-pressed="${listed}" aria-label="${listed ? 'Remove from' : 'Add to'} My List">${svg(listed ? 'check' : 'plus', 16)}</button>
            <button class="round round-end" data-act="info" data-id="${esc(v.id)}" aria-label="More info">${svg('chevron', 16)}</button>
          </div>
          <h3 class="tile-title">${esc(titleOf(v))}</h3>
          <p class="tile-meta">${metaLine(v)}</p>
        </div>
      </article>`;
  }

  const seriesThumb = (s) => thumbHtml({ thumbnailUrl: s.posterUrl });

  function seriesTileHtml(s) {
    const listed = inList(`series:${s.id}`);
    const t = playTarget(s);
    return `
      <article class="tile">
        <a class="tile-thumb" href="${seriesHref(s)}" aria-label="${esc(s.title)}, a series">${seriesThumb(s)}<span class="tile-badge">${isAnime(s) ? 'Anime' : 'Series'}</span></a>
        <div class="tile-info">
          <div class="tile-btns">
            <a class="round round-play" href="${watchHref(t.ep)}" aria-label="${esc(t.label)}">${svg('play', 16)}</a>
            <button class="round" data-act="list" data-id="series:${esc(s.id)}" aria-pressed="${listed}" aria-label="${listed ? 'Remove from' : 'Add to'} My List">${svg(listed ? 'check' : 'plus', 16)}</button>
            <a class="round round-end" href="${seriesHref(s)}" aria-label="All episodes">${svg('chevron', 16)}</a>
          </div>
          <h3 class="tile-title">${esc(s.title)}</h3>
          <p class="tile-meta">${esc(seriesLine(s))}</p>
        </div>
      </article>`;
  }

  // A continue-watching tile for an episode: the series name, with the episode underneath
  function episodeTileHtml(ep, pos, upNext) {
    const progress = pos && seconds(ep) ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(ep)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <article class="tile">
        <a class="tile-thumb" href="${watchHref(ep)}" aria-label="Play ${esc(ep.seriesTitle || '')} ${esc(epLabel(ep))}">${thumbHtml(ep)}${upNext ? '<span class="tile-badge">Up next</span>' : ''}${progress}</a>
        <div class="tile-info">
          <div class="tile-btns">
            <a class="round round-play" href="${watchHref(ep)}" aria-label="Play">${svg('play', 16)}</a>
            <a class="round round-end" href="#/series/${encodeURIComponent(ep.seriesId)}" aria-label="All episodes">${svg('chevron', 16)}</a>
          </div>
          <h3 class="tile-title">${esc(ep.seriesTitle || '')}</h3>
          <p class="tile-meta">${esc(epLabel(ep))} · ${esc(titleOf(ep))}</p>
        </div>
      </article>`;
  }

  function seriesCardHtml(s) {
    return `
      <a class="gcard" href="${seriesHref(s)}">
        <div class="gthumb">${seriesThumb(s)}<span class="tile-badge">${isAnime(s) ? 'Anime' : 'Series'}</span></div>
        <h3 class="tile-title">${esc(s.title)}</h3>
        <p class="tile-meta">${esc(seriesLine(s))}</p>
      </a>`;
  }

  function episodeCardHtml(ep) {
    return `
      <a class="gcard" href="${watchHref(ep)}">
        <div class="gthumb">${thumbHtml(ep)}${seconds(ep) ? `<span class="gdur">${esc(formatDuration(seconds(ep)))}</span>` : ''}</div>
        <h3 class="tile-title">${esc(ep.seriesTitle || '')}</h3>
        <p class="tile-meta">${esc(epLabel(ep))} · ${esc(titleOf(ep))}</p>
      </a>`;
  }

  // One row of the episode list (series page and the watch page's season list)
  function episodeRowHtml(ep, current) {
    const pos = unfinished(ep);
    const watched = !!userStore.get(`vs-watched-${ep.id}`);
    const progress = pos ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(ep)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <li><a class="ep ${current ? 'current' : ''}" href="${watchHref(ep)}" ${current ? 'aria-current="true"' : ''}>
        <span class="ep-num">${ep.episode}</span>
        <div class="ep-thumb">${thumbHtml(ep)}${progress}${watched && !pos ? `<span class="ep-done" title="Watched">${svg('check', 14)}</span>` : ''}${seconds(ep) ? `<span class="gdur">${esc(formatDuration(seconds(ep)))}</span>` : ''}</div>
        <div class="ep-info"><h3>${esc(titleOf(ep))}</h3>
          <p class="tile-meta">${current ? 'Now playing' : `${height(ep) >= 720 ? '<span class="hdtag">HD</span> ' : ''}${esc(timeAgo(ep.publishedAt))}`}</p></div>
      </a></li>`;
  }

  // Search / list / history cards work for movies, episodes and series alike
  function cardFor(item) {
    if (item.kind === 'series') return seriesCardHtml(item);
    if (item.seriesId) return episodeCardHtml(item);
    return gridCardHtml(item);
  }

  function gridCardHtml(v) {
    return `
      <a class="gcard" href="${watchHref(v)}">
        <div class="gthumb">${thumbHtml(v)}${seconds(v) ? `<span class="gdur">${esc(formatDuration(seconds(v)))}</span>` : ''}</div>
        <h3 class="tile-title">${esc(titleOf(v))}</h3>
        <p class="tile-meta">${metaLine(v)}</p>
      </a>`;
  }

  // A history card: progress bar for unfinished videos, plus a button to remove it
  function historyCardHtml(v) {
    const pos = parseFloat(userStore.get(`vs-pos-${v.id}`));
    const heading = v.seriesId ? esc(v.seriesTitle || '') : esc(titleOf(v));
    const sub = v.seriesId ? `${esc(epLabel(v))} · ${esc(titleOf(v))}` : metaLine(v);
    const progress = pos > 5 && seconds(v) ? `<span class="tile-prog"><i style="width:${Math.min(100, (pos / seconds(v)) * 100).toFixed(1)}%"></i></span>` : '';
    return `
      <div class="gcard hcard">
        <a href="${watchHref(v)}"><div class="gthumb">${thumbHtml(v)}${seconds(v) ? `<span class="gdur">${esc(formatDuration(seconds(v)))}</span>` : ''}${progress}</div>
          <h3 class="tile-title">${heading}</h3></a>
        <p class="tile-meta">${sub}</p>
        <button class="link-small" data-act="remove-history" data-id="${esc(v.id)}">Remove from history</button>
      </div>`;
  }

  function rowHtml(title, tiles, href = '') {
    return `
      <section class="row" aria-label="${esc(title)}">
        <p class="row-label"><span>${title === 'Continue Watching' || title === 'My List' ? 'Yours' : 'Browse'}</span></p>
        <h2 class="row-title">${esc(title)}${href ? ` <a class="row-all" href="${href}">All</a>` : ''}</h2>
        <div class="row-wrap">
          <button class="row-arrow left hide" aria-label="Scroll left">${svg('left', 28)}</button>
          <div class="row-scroll">${tiles}</div>
          <button class="row-arrow right hide" aria-label="Scroll right">${svg('right', 28)}</button>
        </div>
      </section>`;
  }

  function wireRows(root) {
    root.querySelectorAll('.row-wrap').forEach((wrap) => {
      const scroller = wrap.querySelector('.row-scroll');
      const left = wrap.querySelector('.left');
      const right = wrap.querySelector('.right');
      const update = () => {
        left.classList.toggle('hide', scroller.scrollLeft < 8);
        right.classList.toggle('hide', scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 8);
      };
      left.addEventListener('click', () => scroller.scrollBy({ left: -scroller.clientWidth * 0.85, behavior: 'smooth' }));
      right.addEventListener('click', () => scroller.scrollBy({ left: scroller.clientWidth * 0.85, behavior: 'smooth' }));
      scroller.addEventListener('scroll', update, { passive: true });
      update();
    });
  }

  function openInfo(id) {
    const v = state.videos[id];
    if (!v) return;
    const row = (k, val) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`;
    const modal = dialog({
      title: titleOf(v),
      wide: true,
      html: `
        <div class="info-hero">${v.thumbnailUrl ? `<img src="${esc(v.thumbnailUrl)}" alt="" />` : ''}<div class="info-shade"></div>
          <div class="info-hero-body"><h2>${esc(titleOf(v))}</h2>
            <div class="info-actions"><a class="btn btn-light" href="${watchHref(v)}" data-close>${svg('play', 16)} Play</a>
              <button class="round" data-act="list" data-id="${esc(v.id)}" aria-pressed="${inList(v.id)}" aria-label="Toggle My List">${svg(inList(v.id) ? 'check' : 'plus', 16)}</button></div></div></div>
        <div class="info-body"><p class="tile-meta">${metaLine(v)}</p>
          <dl class="info-dl">
            ${row('Resolution', v.width ? `${esc(v.width)} × ${esc(v.height)}` : '—')}
            ${row('Frame rate', v.fps ? `${esc(v.fps)} fps` : '—')}
            ${row('Duration', seconds(v) ? esc(formatDuration(seconds(v))) : '—')}
            ${row('Published', esc(new Date(v.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })))}
          </dl></div>`,
    });
    // The My List button inside the dialog updates itself and the page behind it
    modal.el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act="list"]');
      if (!btn) return;
      toggleList(id);
      btn.setAttribute('aria-pressed', String(inList(id)));
      btn.innerHTML = svg(inList(id) ? 'check' : 'plus', 16);
      refreshView();
    });
  }

  // One delegated handler for tile / banner buttons
  app.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'list') { toggleList(btn.dataset.id); refreshView(); }
    else if (btn.dataset.act === 'info') openInfo(btn.dataset.id);
    else if (btn.dataset.act === 'remove-history') { removeHistory(btn.dataset.id); toast('Removed from history', 'info', 1800); render(); }
    else if (btn.dataset.act === 'clear-history') {
      if (window.confirm('Clear your whole watch history?')) { userStore.del('vs-history'); render(); }
    }
    else if (btn.dataset.act === 'retry') { state.loaded = false; state.error = ''; render(); load(); }
  });

  function notice(icon, title, text, action = '') {
    return `<div class="notice">${svg(icon, 40)}<h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
  }

  // Common states shared by every list page; returns true when it handled the render
  function renderGate() {
    if (!state.loaded) {
      app.innerHTML = '<div class="page-pad"><div class="spinner" role="status" aria-label="Loading"></div></div>';
      return true;
    }
    if (state.error) {
      app.innerHTML = `<div class="page-pad">${notice('alert', 'Couldn\'t load videos', state.error, '<button class="btn btn-light" data-act="retry">Try again</button>')}</div>`;
      return true;
    }
    return false;
  }

  // ═════════════════════════════════════════════════════════
  // Home: banner + rows
  // ═════════════════════════════════════════════════════════
  function homeView() {
    document.title = 'VideoStream — Watch';
    if (renderGate()) return {};

    const all = library();
    const seriesAll = seriesLibrary();
    if (all.length === 0 && seriesAll.length === 0) {
      app.innerHTML = `<div class="page-pad">${notice('film', 'Nothing to watch yet', 'New videos will appear here as soon as they are published. Check back soon.')}</div>`;
      return {};
    }

    // Keep each row's horizontal scroll position across re-renders (e.g. after toggling My List)
    const scrolled = {};
    app.querySelectorAll('.row').forEach((r) => { scrolled[r.getAttribute('aria-label')] = r.querySelector('.row-scroll').scrollLeft; });

    // The banner features whichever is newest: a movie or a series (a new episode bumps its series)

    const listed = readList().map((id) => (id.startsWith('series:') ? state.series.find((x) => `series:${x.id}` === id) : state.videos[id])).filter(Boolean);
    const resume = continueWatching();
    // Anime has its own section; everything else stays under TV Series and Movies
    const tvSeries = seriesAll.filter((x) => !isAnime(x));
    const animeSeries = seriesAll.filter(isAnime);
    const movies = all.filter((x) => !isAnime(x));
    const animeMovies = all.filter(isAnime);
    const rows = [
      resume.length ? rowHtml('Continue Watching', resume.map(({ v, pos, upNext }) => (v.seriesId ? episodeTileHtml(v, pos, upNext) : tileHtml(v, pos))).join('')) : '',
      tvSeries.length ? rowHtml('TV Series', tvSeries.map(seriesTileHtml).join(''), '#/series') : '',
      movies.length ? rowHtml('Movies', movies.map((v) => tileHtml(v)).join(''), '#/movies') : '',
      animeSeries.length || animeMovies.length ? rowHtml('Anime', animeSeries.map(seriesTileHtml).join('') + animeMovies.map((v) => tileHtml(v)).join(''), '#/anime') : '',
      listed.length ? rowHtml('My List', listed.map((v) => (v.seasons ? seriesTileHtml(v) : tileHtml(v))).join(''), '#/mylist') : '',
    ].join('');

    // Rotating banner: the newest few movies and series, newest first
    const featured = [
      ...seriesAll.map((x) => ({ kind: 'series', item: x, at: new Date(x.publishedAt) })),
      ...all.map((x) => ({ kind: 'movie', item: x, at: new Date(x.publishedAt) })),
    ].sort((p, q) => q.at - p.at).slice(0, 5);
    const slideHtml = ({ kind, item }, i) => {
      if (kind === 'series') {
        const t = playTarget(item);
        return `
        <section class="billboard slide${i === 0 ? ' on' : ''}" aria-label="Featured series">
          ${item.posterUrl ? `<img class="bb-img" src="${esc(item.posterUrl)}" alt="" />` : ''}
          <div class="bb-shade"></div>
          <div class="bb-body">
            <p class="bb-info"><span class="chip">Series</span><span>${esc(seriesLine(item))}</span></p>
            <h1>${esc(item.title)}</h1>
            ${item.description ? `<p class="bb-desc">${esc(item.description)}</p>` : ''}
            <div class="bb-actions">
              <a class="btn btn-light btn-lg" href="${watchHref(t.ep)}">${svg('play', 20)} ${esc(t.label)}</a>
              <a class="btn btn-gray btn-lg" href="${seriesHref(item)}">${svg('info', 20)} Episodes</a>
            </div>
          </div>
        </section>`;
      }
      return `
        <section class="billboard slide${i === 0 ? ' on' : ''}" aria-label="Featured video">
          ${item.thumbnailUrl ? `<img class="bb-img" src="${esc(item.thumbnailUrl)}" alt="" />` : ''}
          <div class="bb-shade"></div>
          <div class="bb-body">
            <p class="bb-info"><span class="chip">${ageMs(item) < 864e5 ? 'New' : 'Movie'}</span><span>${metaLine(item)}</span></p>
            <h1>${esc(titleOf(item))}</h1>
            <div class="bb-actions">
              <a class="btn btn-light btn-lg" href="${watchHref(item)}">${svg('play', 20)} Play</a>
              <button class="btn btn-gray btn-lg" data-act="info" data-id="${esc(item.id)}">${svg('info', 20)} More Info</button>
            </div>
          </div>
        </section>`;
    };
    const banner = `<div class="hero" id="hero">${featured.map(slideHtml).join('')}${featured.length > 1 ? `<div class="dots" role="tablist" aria-label="Featured">${featured.map((_, i) => `<button class="${i === 0 ? 'on' : ''}" data-slide="${i}" aria-label="Show featured ${i + 1}"></button>`).join('')}</div>` : ''}</div>`;

    app.innerHTML = `${banner}<div class="rows">${rows}</div>`;
    app.querySelectorAll('.row').forEach((r) => { r.querySelector('.row-scroll').scrollLeft = scrolled[r.getAttribute('aria-label')] || 0; });
    wireRows(app);
    wireHero();
    return {};
  }

  let heroTimer = null;
  function wireHero() {
    clearInterval(heroTimer);
    const hero = document.getElementById('hero');
    if (!hero) return;
    const slides = [...hero.querySelectorAll('.slide')];
    const dots = [...hero.querySelectorAll('.dots button')];
    if (slides.length < 2) return;
    let at = 0;
    const show = (i) => { at = (i + slides.length) % slides.length; slides.forEach((el, k) => el.classList.toggle('on', k === at)); dots.forEach((el, k) => el.classList.toggle('on', k === at)); };
    dots.forEach((d) => d.addEventListener('click', () => { show(+d.dataset.slide); restart(); }));
    const restart = () => { clearInterval(heroTimer); heroTimer = setInterval(() => { if (!hero.isConnected) return clearInterval(heroTimer); if (!document.hidden) show(at + 1); }, 8000); };
    restart();
  }

  // ═════════════════════════════════════════════════════════
  // Grid pages: search, browse filters, My List
  // ═════════════════════════════════════════════════════════
  function gridView(title, kind, q = '') {
    document.title = `${title} — VideoStream`;
    if (renderGate()) return {};

    const tagSeries = (list) => list.map((x) => ({ ...x, kind: 'series' }));
    let items = library();
    if (kind === 'search') {
      const needle = q.toLowerCase();
      const hit = (text) => !needle || (text || '').toLowerCase().includes(needle);
      const movies = items.filter((v) => hit(titleOf(v)) || v.id.toLowerCase().includes(needle));
      // A series matches by its title or description, or by the title of any of its episodes
      const series = tagSeries(seriesLibrary().filter((sr) => hit(sr.title) || hit(sr.description) || allEpisodes(sr).some((e) => hit(e.title))));
      items = [...series, ...movies];
    } else if (kind === 'series') {
      items = tagSeries(seriesLibrary().filter((x) => !isAnime(x)));
    } else if (kind === 'movies') {
      items = items.filter((x) => !isAnime(x));
    } else if (kind === 'anime') {
      items = [...tagSeries(seriesLibrary().filter(isAnime)), ...items.filter(isAnime)];
    } else if (kind === 'mylist') {
      items = readList().map((id) => (id.startsWith('series:') ? tagSeries(state.series.filter((x) => `series:${x.id}` === id))[0] : state.videos[id])).filter(Boolean);
    } else if (kind === 'history') {
      items = readHistory().map((h) => itemById(h.id)).filter(Boolean);
    } else if (FILTERS[kind]) {
      items = items.filter(FILTERS[kind].test);
    }

    const empty = kind === 'mylist'
      ? notice('plus', 'Your list is empty', 'Press + on any video or series to save it here.', '<a class="btn btn-light" href="#/">Browse videos</a>')
      : kind === 'history'
        ? notice('film', 'No watch history yet', 'Videos you watch will appear here, on any device you sign in on.', '<a class="btn btn-light" href="#/">Browse videos</a>')
      : kind === 'series'
        ? notice('film', 'No series yet', 'Series will appear here as soon as they are published.', '<a class="btn btn-light" href="#/">Back to home</a>')
      : kind === 'anime'
        ? notice('film', 'No anime yet', 'Anime will appear here as soon as it is published.', '<a class="btn btn-light" href="#/">Back to home</a>')
      : kind === 'movies'
        ? notice('film', 'No movies yet', 'Movies will appear here as soon as they are published.', '<a class="btn btn-light" href="#/">Back to home</a>')
      : kind === 'search'
        ? notice('film', 'Nothing found', `Nothing matches “${q}”.`, '<a class="btn btn-light" href="#/">Back to home</a>')
        : notice('film', 'Nothing here yet', 'No videos match this category right now.', '<a class="btn btn-light" href="#/">Back to home</a>');

    const clearBtn = kind === 'history' && items.length ? '<button class="btn btn-gray btn-sm" data-act="clear-history">Clear history</button>' : '';
    app.innerHTML = `<div class="page-pad"><div class="page-head-row"><h1 class="page-title">${esc(title)}</h1>${clearBtn}</div>
      ${items.length ? `<div class="ggrid">${items.map((v) => (kind === 'history' ? historyCardHtml(v) : cardFor(v))).join('')}</div>` : empty}</div>`;
    return {};
  }

  // ═════════════════════════════════════════════════════════
  // A series: seasons and episodes
  // ═════════════════════════════════════════════════════════
  function seriesView(id) {
    if (renderGate()) return {};
    const series = state.series.find((x) => x.id === id);
    if (!series) {
      document.title = 'VideoStream';
      app.innerHTML = `<div class="page-pad">${notice('film', 'Series not found', 'It may have been removed or is not available yet.', '<a class="btn btn-light" href="#/series">Browse series</a>')}</div>`;
      return {};
    }
    document.title = `${series.title} — VideoStream`;

    const target = playTarget(series);
    const seasonNumbers = series.seasons.map((x) => x.number);
    const picked = seasonNumbers.includes(state.seasonPick[id]) ? state.seasonPick[id] : target.ep.season;
    const seasonLabel = (n) => (n === 0 ? 'Specials' : `Season ${n}`);
    const listIdKey = `series:${id}`;
    const listed = inList(listIdKey);
    const episodesFor = (n) => (series.seasons.find((x) => x.number === n) || { episodes: [] }).episodes;
    const listHtml = (n) => episodesFor(n).map((e) => episodeRowHtml(e, false)).join('');

    app.innerHTML = `
      <section class="billboard series-hero" aria-label="${esc(series.title)}">
        ${series.posterUrl ? `<img class="bb-img" src="${esc(series.posterUrl)}" alt="" />` : ''}
        <div class="bb-shade"></div>
        <div class="bb-body">
          <span class="bb-tag">Series</span>
          <h1>${esc(series.title)}</h1>
          <p class="bb-meta">${esc(seriesLine(series))}</p>
          ${series.description ? `<p class="bb-desc">${esc(series.description)}</p>` : ''}
          <div class="bb-actions">
            <a class="btn btn-light btn-lg" href="${watchHref(target.ep)}">${svg('play', 22)} ${esc(target.label)}</a>
            <button class="btn btn-gray btn-lg" data-act="list" data-id="${esc(listIdKey)}" aria-pressed="${listed}">${svg(listed ? 'check' : 'plus', 20)} My List</button>
          </div>
        </div>
      </section>
      <div class="series-body">
        <div class="season-bar">
          <h2>Episodes</h2>
          ${seasonNumbers.length > 1
            ? `<label class="sr-only" for="season-select">Season</label>
               <select id="season-select" class="select season-select">${seasonNumbers.map((n) => `<option value="${n}" ${n === picked ? 'selected' : ''}>${esc(seasonLabel(n))} (${plural(episodesFor(n).length, 'episode')})</option>`).join('')}</select>`
            : `<span class="season-name">${esc(seasonLabel(seasonNumbers[0]))}</span>`}
        </div>
        <ol class="ep-list" id="ep-list">${listHtml(picked)}</ol>
      </div>`;

    const select = app.querySelector('#season-select');
    if (select) {
      select.addEventListener('change', () => {
        state.seasonPick[id] = Number(select.value);
        app.querySelector('#ep-list').innerHTML = listHtml(state.seasonPick[id]);
      });
    }
    return {};
  }

  // ═════════════════════════════════════════════════════════
  // Watch
  // ═════════════════════════════════════════════════════════
  function watchView(id) {
    let video = state.videos[id];
    let teardownPlayer = null;
    let destroyed = false;

    const message = (title, text) => {
      document.title = 'VideoStream';
      app.innerHTML = `<div class="page-pad">${notice('alert', title, text, '<a class="btn btn-light" href="#/">Back to home</a>')}</div>`;
    };

    async function resolve() {
      if (!state.loaded) { app.innerHTML = '<div class="page-pad"><div class="spinner" role="status" aria-label="Loading"></div></div>'; return; }
      if (!video) {
        // It may be newer than our list, so ask the server once
        try {
          const res = await fetch(`/api/public/videos/${encodeURIComponent(id)}`, { cache: 'no-cache' });
          const json = await res.json();
          if (json.success) { video = json.data; if (!video.episode) state.videos[id] = video; } // episodes are not movies
        } catch { /* fall through to not found */ }
        if (destroyed) return;
      }
      if (!video) return message('Video not found', 'It may have been removed or is not available.');
      mount();
    }

    function nextVideo() {
      if (video.episode) {
        const n = video.episode.nextId;
        return n ? (state.episodes[n] || { id: n, title: 'Next episode' }) : null;
      }
      const list = library();
      const i = list.findIndex((v) => v.id === id);
      return list[i + 1] || list[i - 1] || null;
    }

    function renderMore() {
      const el = document.getElementById('more-grid');
      if (!el) return;
      if (video.episode) {
        // For an episode, the useful list is the rest of its season
        const series = state.series.find((x) => x.id === video.episode.seriesId);
        const season = series && series.seasons.find((x) => x.number === video.episode.season);
        el.innerHTML = season ? season.episodes.map((e) => episodeRowHtml(e, e.id === id)).join('') : '';
        return;
      }
      const list = library().filter((v) => v.id !== id).slice(0, 12);
      el.innerHTML = list.length ? list.map(gridCardHtml).join('') : '<p class="tile-meta">No other videos yet.</p>';
    }

    const subTracks = () => video.textTracks && video.textTracks.length ? video.textTracks : (video.subtitleUrl ? [{ id: 'legacy', language: 'en', label: 'English', url: video.subtitleUrl }] : []);

    function mount() {
      document.title = `${titleOf(video)} — VideoStream`;
      app.innerHTML = `
        <div class="stage">
          <div class="player" id="player">
            <video id="video" controls playsinline preload="metadata" autoplay
                   ${subTracks().length ? 'crossorigin="anonymous"' : ''}
                   ${video.thumbnailUrl ? `poster="${esc(video.thumbnailUrl)}"` : ''}>
              ${subTracks().map((t) => `<track kind="subtitles" label="${esc(t.label)}" ${/^[a-z]{2,3}$/.test(t.language) ? `srclang="${t.language}"` : ''} src="${esc(t.url)}">`).join('')}
            </video>
            <div class="overlay" id="buffering" aria-hidden="true"><div class="spinner small"></div></div>
            <div class="overlay interactive" id="error" role="alert">${svg('alert', 30)}<p id="error-text"></p>
              <button class="btn btn-light btn-sm" id="retry">Try again</button></div>
            <div class="overlay interactive" id="next-up" role="status"></div>
          </div>
        </div>

        <div class="watch-body">
          <div class="watch-head">
            <div>
              ${video.episode ? `<a class="series-link" href="#/series/${encodeURIComponent(video.episode.seriesId)}">${esc(video.episode.seriesTitle)}</a>` : ''}
              <h1 class="w-title">${video.episode ? `<span class="ep-badge">${esc(epLabel(video.episode))}</span> ` : ''}${esc(titleOf(video))}</h1>
              <p class="tile-meta">${metaLine(video)}${qualityOf(video) ? ` <span class="dot">·</span> ${esc(qualityOf(video))}` : ''}</p>
            </div>
            <div class="w-actions">
              ${video.episode && video.episode.prevId ? `<a class="btn btn-gray btn-sm" href="#/watch/${encodeURIComponent(video.episode.prevId)}">${svg('left', 15)} Previous</a>` : ''}
              ${video.episode && video.episode.nextId ? `<a class="btn btn-gray btn-sm" href="#/watch/${encodeURIComponent(video.episode.nextId)}">Next episode ${svg('right', 15)}</a>` : ''}
              <button class="btn btn-gray btn-sm" id="list-btn" data-act="list" data-id="${esc(listIdOf(video))}" aria-pressed="${inList(listIdOf(video))}">${svg(inList(listIdOf(video)) ? 'check' : 'plus', 15)} My List</button>
              <button class="btn btn-gray btn-sm" id="share">${svg('share', 15)} Share</button>
            </div>
          </div>

          <div class="controls">
            <label class="ctl">Quality <select id="quality" class="select"><option value="-1">Auto</option></select></label>
            <label class="ctl">Speed <select id="speed" class="select">${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('')}</select></label>
            <label class="ctl" id="audio-wrap" hidden>Audio <select id="audio" class="select"></select></label>
            ${subTracks().length ? `<label class="ctl">Subtitles <select id="subs" class="select"><option value="-1">Off</option>${subTracks().map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join('')}</select></label>` : ''}
            <label class="switch-label"><input type="checkbox" id="autonext" class="switch-input" role="switch" /><span>Autoplay next</span></label>
          </div>

          <h2 class="row-title flush">${video.episode ? `${esc(video.episode.seriesTitle)} · ${video.episode.season === 0 ? 'Specials' : `Season ${video.episode.season}`}` : 'More videos'}</h2>
          <${video.episode ? 'ol' : 'div'} class="${video.episode ? 'ep-list' : 'ggrid'}" id="more-grid"></${video.episode ? 'ol' : 'div'}>
        </div>`;
      teardownPlayer = setupPlayer();
      renderMore();
    }

    function setupPlayer() {
      const $ = (sel) => app.querySelector(sel);
      const videoEl = $('#video');
      const qualitySel = $('#quality');
      const speedSel = $('#speed');
      const subsSel = $('#subs');
      const audioSel = $('#audio');
      const auto = $('#autonext');
      const posKey = `vs-pos-${video.id}`;
      let hls = null;
      let stopped = false;
      let netRetries = 0;
      let mediaRetries = 0;
      let countdown = null;

      $('#share').addEventListener('click', () => copyText(location.href, 'Link copied'));

      // ── Overlays ──
      const buffering = $('#buffering');
      const errorBox = $('#error');
      const setBuffering = (on) => buffering.classList.toggle('visible', on);
      function showError(text) { setBuffering(false); $('#error-text').textContent = text; errorBox.classList.add('visible'); }
      videoEl.addEventListener('waiting', () => setBuffering(true));
      ['playing', 'canplay', 'pause', 'seeked'].forEach((evt) => videoEl.addEventListener(evt, () => setBuffering(false)));

      // ── Preferences ──
      const savedSpeed = storage.get('vs-speed');
      if (savedSpeed && [...speedSel.options].some((o) => o.value === savedSpeed)) { speedSel.value = savedSpeed; videoEl.playbackRate = parseFloat(savedSpeed); }
      speedSel.addEventListener('change', () => { videoEl.playbackRate = parseFloat(speedSel.value); storage.set('vs-speed', speedSel.value); });
      auto.checked = storage.get('vs-autonext') !== 'off';
      auto.addEventListener('change', () => storage.set('vs-autonext', auto.checked ? 'on' : 'off'));

      // ── History and resume ──
      let recorded = false;
      videoEl.addEventListener('playing', () => { if (!recorded) { recorded = true; recordHistory(video.id); } });
      let lastSaved = 0;
      videoEl.addEventListener('loadedmetadata', () => {
        const pos = parseFloat(userStore.get(posKey));
        if (pos > 5 && pos < videoEl.duration - 5) { videoEl.currentTime = pos; toast(`Resumed from ${formatDuration(pos)}`, 'info', 2500); }
        applySubtitles(savedSubIndex());
      }, { once: true });
      videoEl.addEventListener('timeupdate', () => {
        if (Date.now() - lastSaved > 2000) {
          lastSaved = Date.now();
          userStore.set(posKey, videoEl.currentTime);
          userStore.set(`vs-seen-${video.id}`, Date.now());
        }
      });

      // ── Subtitles ──
      // The choice is remembered by language ("hi"), so it carries over to other videos
      const tracks = subTracks();
      function applySubtitles(index) {
        for (let i = 0; i < videoEl.textTracks.length; i++) videoEl.textTracks[i].mode = i === index ? 'showing' : 'disabled';
        if (subsSel) subsSel.value = String(index);
      }
      function savedSubIndex() {
        const lang = storage.get('vs-sub');
        return lang && lang !== 'off' ? tracks.findIndex((t) => t.language === lang) : -1;
      }
      if (subsSel) subsSel.addEventListener('change', () => {
        const index = parseInt(subsSel.value, 10);
        applySubtitles(index);
        storage.set('vs-sub', index >= 0 ? tracks[index].language : 'off');
      });
      const toggleSubtitles = () => {
        if (!subsSel) return;
        applySubtitles(parseInt(subsSel.value, 10) >= 0 ? -1 : Math.max(0, savedSubIndex()));
        const index = parseInt(subsSel.value, 10);
        storage.set('vs-sub', index >= 0 ? tracks[index].language : 'off');
      };

      // ── Up next countdown when the video ends ──
      const nextBox = $('#next-up');
      function stopCountdown() { clearInterval(countdown); countdown = null; nextBox.classList.remove('visible'); }
      videoEl.addEventListener('ended', () => {
        userStore.del(posKey);
        userStore.set(`vs-watched-${video.id}`, '1'); // lets a series offer the next episode
        const next = nextVideo();
        if (!auto.checked || !next) return;
        let left = 5;
        nextBox.innerHTML = `<p class="nu-label">Up next</p><p class="nu-title">${esc(titleOf(next))}</p>
          <p class="nu-count">Playing in <strong id="nu-sec">${left}</strong>s</p>
          <div class="nu-actions"><button class="btn btn-gray btn-sm" id="nu-cancel">Cancel</button>
          <a class="btn btn-light btn-sm" href="${watchHref(next)}">Play now</a></div>`;
        nextBox.classList.add('visible');
        nextBox.querySelector('#nu-cancel').addEventListener('click', stopCountdown);
        countdown = setInterval(() => {
          left -= 1;
          const sec = nextBox.querySelector('#nu-sec');
          if (sec) sec.textContent = left;
          if (left <= 0) { stopCountdown(); location.hash = watchHref(next); }
        }, 1000);
      });
      videoEl.addEventListener('play', stopCountdown);

      // ── Audio languages ──
      function setupAudio() {
        const found = hls.audioTracks || [];
        $('#audio-wrap').hidden = found.length < 2;
        if (found.length < 2) return;
        audioSel.innerHTML = found.map((t, i) => `<option value="${i}">${esc((video.audioTracks && video.audioTracks[i] && video.audioTracks[i].label) || t.name || `Audio ${i + 1}`)}</option>`).join('');
        const lang = storage.get('vs-audio');
        const wanted = lang ? found.findIndex((t, i) => ((video.audioTracks && video.audioTracks[i] && video.audioTracks[i].language) || t.lang) === lang) : -1;
        if (wanted >= 0 && wanted !== hls.audioTrack) hls.audioTrack = wanted;
        audioSel.value = String(hls.audioTrack);
      }
      if (audioSel) audioSel.addEventListener('change', () => {
        if (!hls) return;
        const i = parseInt(audioSel.value, 10);
        hls.audioTrack = i;
        const info = video.audioTracks && video.audioTracks[i];
        storage.set('vs-audio', (info && info.language) || (hls.audioTracks[i] && hls.audioTracks[i].lang) || '');
      });

      // ── Hls.js ──
      async function start(resumeAt) {
        errorBox.classList.remove('visible');
        await whenHls();
        if (stopped) return;
        if (window.Hls && Hls.isSupported()) {
          hls = new Hls({ enableWorker: true, capLevelToPlayerSize: true });
          hls.loadSource(video.hlsPlaylistUrl);
          hls.attachMedia(videoEl);
          hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
            qualitySel.length = 1;
            data.levels.map((l, idx) => ({ idx, h: l.height })).sort((a, b) => b.h - a.h).forEach(({ idx, h }) => {
              const opt = document.createElement('option');
              opt.value = idx; opt.textContent = `${h}p`;
              qualitySel.appendChild(opt);
            });
            if (resumeAt) videoEl.currentTime = resumeAt;
            videoEl.play().catch(() => { /* autoplay blocked: the viewer presses play */ });
          });
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, setupAudio);
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
            const level = hls.levels[data.level];
            if (level && qualitySel.value === '-1') qualitySel.options[0].textContent = `Auto (${level.height}p)`;
          });
          hls.on(Hls.Events.FRAG_LOADED, () => { netRetries = 0; mediaRetries = 0; });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            console.error('Hls.js fatal error:', data.type, data.details);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries++ < 3) return hls.startLoad();
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries++ < 3) return hls.recoverMediaError();
            hls.destroy(); hls = null;
            showError(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'The connection was lost while loading the video.' : 'This video could not be played.');
          });
        } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          videoEl.src = video.hlsPlaylistUrl; // Safari: native HLS
          qualitySel.closest('.ctl').hidden = true;
        } else {
          showError('Your browser does not support HLS playback.');
        }
      }
      qualitySel.addEventListener('change', () => {
        if (!hls) return;
        hls.currentLevel = parseInt(qualitySel.value, 10);
        if (qualitySel.value !== '-1') qualitySel.options[0].textContent = 'Auto';
      });
      $('#retry').addEventListener('click', () => {
        const at = videoEl.currentTime;
        if (hls) hls.destroy();
        hls = null; netRetries = mediaRetries = 0;
        start(at);
      });

      // ── Keyboard ──
      function onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest('button, a, select, input, textarea')) return;
        const key = e.key.toLowerCase();
        const native = [' ', 'k', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'm', 'f'];
        if (document.activeElement === videoEl && native.includes(key)) return;
        const toggle = () => (videoEl.paused ? videoEl.play() : videoEl.pause());
        const actions = {
          ' ': toggle, k: toggle,
          arrowleft: () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 5); },
          arrowright: () => { videoEl.currentTime += 5; },
          j: () => { videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); },
          l: () => { videoEl.currentTime += 10; },
          arrowup: () => { videoEl.volume = Math.min(1, videoEl.volume + 0.1); },
          arrowdown: () => { videoEl.volume = Math.max(0, videoEl.volume - 0.1); },
          m: () => { videoEl.muted = !videoEl.muted; },
          f: () => (document.fullscreenElement ? document.exitFullscreen() : $('#player').requestFullscreen()),
          c: toggleSubtitles,
        };
        if (actions[key]) { e.preventDefault(); actions[key](); }
      }
      document.addEventListener('keydown', onKey);

      start(0);

      return () => {
        stopped = true;
        document.removeEventListener('keydown', onKey);
        stopCountdown();
        if (hls) hls.destroy();
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
      };
    }

    resolve();

    return {
      // Live updates only refresh the video list and My List button; the player is never rebuilt mid-playback
      update() {
        if (!teardownPlayer && state.loaded && !destroyed) { video = state.videos[id] || video; resolve(); return; }
        renderMore();
        // Keep the title in step if an admin renamed the video while it is open
        const latest = video.episode ? state.episodes[id] : state.videos[id];
        if (latest && latest.title !== video.title) {
          video = video.episode ? { ...video, title: latest.title } : latest;
          const heading = app.querySelector('.w-title');
          if (heading) heading.innerHTML = `${video.episode ? `<span class="ep-badge">${esc(epLabel(video.episode))}</span> ` : ''}${esc(titleOf(video))}`;
          document.title = `${titleOf(video)} — VideoStream`;
        }
        const btn = document.getElementById('list-btn');
        if (btn) {
          const key = listIdOf(video);
          btn.setAttribute('aria-pressed', String(inList(key)));
          btn.innerHTML = `${svg(inList(key) ? 'check' : 'plus', 15)} My List`;
        }
      },
      teardown() { destroyed = true; if (teardownPlayer) teardownPlayer(); },
    };
  }

  // ─── Sign in / sign up ──────────────────────────────────────
  let signedOut = false;
  function showSignedOut() {
    if (signedOut) return;
    signedOut = true;
    if (currentView && currentView.teardown) currentView.teardown();
    currentView = null;
    document.body.classList.add('signed-out');
    renderAuth(location.hash === '#/signup' ? 'signup' : 'login');
  }

  function renderAuth(mode) {
    const signup = mode === 'signup';
    document.title = `${signup ? 'Create your account' : 'Sign in'} — VideoStream`;
    app.innerHTML = `
      <div class="auth-page">
        <form class="auth-card" id="auth-form" novalidate>
          <h1>${signup ? 'Create your account' : 'Sign in'}</h1>
          <p class="auth-sub">${signup ? 'Watch everything on VideoStream. Your list and progress follow you to any device.' : 'Welcome back. Sign in to keep watching.'}</p>
          ${signup ? '<label class="auth-field"><span>Name</span><input class="auth-input" name="name" autocomplete="name" maxlength="60" required /></label>' : ''}
          <label class="auth-field"><span>Email</span><input class="auth-input" name="email" type="email" autocomplete="email" required /></label>
          <label class="auth-field"><span>Password</span><input class="auth-input" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required />
            ${signup ? '<small>At least 8 characters.</small>' : ''}</label>
          <p class="auth-error" id="auth-error" role="alert" hidden></p>
          <button class="btn btn-red btn-lg auth-submit" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
          <p class="auth-switch">${signup ? 'Already have an account? <a href="#/login" data-auth="login">Sign in</a>' : 'New to VideoStream? <a href="#/signup" data-auth="signup">Create an account</a>'}</p>
        </form>
      </div>`;
    const form = app.querySelector('#auth-form');
    const errBox = app.querySelector('#auth-error');
    (form.name || form.email).focus();
    app.querySelector('[data-auth]').addEventListener('click', (e) => { e.preventDefault(); renderAuth(signup ? 'login' : 'signup'); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('.auth-submit');
      const body = { email: form.email.value, password: form.password.value, ...(signup ? { name: form.name.value } : {}) };
      button.disabled = true;
      errBox.hidden = true;
      try {
        const res = await fetch(`/api/auth/${signup ? 'signup' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json().catch(() => null);
        if (!json || !json.success) throw new Error((json && json.error && json.error.message) || 'Something went wrong. Try again.');
        location.hash = '#/';
        location.reload(); // start the app fresh as the signed-in viewer
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
        button.disabled = false;
      }
    });
  }

  function renderAccountMenu() {
    const slot = document.getElementById('auth-slot');
    if (!slot || !account.user) return;
    const initial = (account.user.name || account.user.email).trim().charAt(0).toUpperCase();
    slot.innerHTML = `
      <div class="acct">
        <button class="avatar" id="acct-btn" aria-haspopup="true" aria-expanded="false" aria-label="Account: ${esc(account.user.name)}">${esc(initial)}</button>
        <div class="acct-menu" id="acct-menu" hidden>
          <p class="acct-name">${esc(account.user.name)}</p>
          <p class="acct-email">${esc(account.user.email)}</p>
          <a href="#/mylist">My List</a>
          <a href="#/history">Watch history</a>
          <button id="logout-btn">Sign out</button>
        </div>
      </div>`;
    const btn = slot.querySelector('#acct-btn');
    const menu = slot.querySelector('#acct-menu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.acct')) close(); });
    slot.querySelector('#logout-btn').addEventListener('click', async () => {
      flushProgress();
      await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.hash = '#/';
      location.reload();
    });
  }

  // ─── Boot ──────────────────────────────────────────────────
  async function boot() {
    try {
      const me = await fetch('/api/auth/me', { cache: 'no-store' });
      if (me.status === 401) return showSignedOut();
      const meJson = await me.json();
      if (!meJson.success) throw new Error(meJson.error?.message || 'Could not check your sign-in');
      account.user = meJson.data;
      const data = await (await fetch('/api/me', { cache: 'no-store' })).json();
      if (data.success) { account.list = data.data.list || []; account.progress = data.data.progress || {}; }
    } catch {
      // Server unreachable: the normal error page shows once loading fails
    }
    renderAccountMenu();
    render();
    load();
    startPolling();
  }
  boot();
})();
