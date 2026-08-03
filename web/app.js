/* ==========================================================================
   Lyris — 前端播放邏輯
   1) LRC 解析（含逐字 <mm:ss.xx> 增強格式、同時間軸的翻譯行）
   2) 依 audio.currentTime 每幀同步高亮 + 逐字填色 + 平滑捲動
   3) 從封面取主色，即時換掉整頁的 accent
   ========================================================================== */

(() => {
  'use strict';

  // ── DOM ────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const audio = $('audio');
  const els = {
    ambientArt: $('ambientArt'),
    cover: $('cover'),
    coverImg: $('coverImg'),
    coverFallback: $('coverFallback'),
    title: $('trackTitle'),
    artist: $('trackArtist'),
    scrub: $('scrub'),
    scrubFill: $('scrubFill'),
    scrubBuffer: $('scrubBuffer'),
    timeNow: $('timeNow'),
    timeTotal: $('timeTotal'),
    btnPlay: $('btnPlay'),
    btnPrev: $('btnPrev'),
    btnNext: $('btnNext'),
    btnVolume: $('btnVolume'),
    volume: $('volume'),
    lyrics: $('lyrics'),
    viewport: $('lyricsViewport'),
    track: $('lyricsTrack'),
    resumePill: $('resumePill'),
    drawer: $('drawer'),
    drawerScrim: $('drawerScrim'),
    tracklist: $('tracklist'),
    trackCount: $('trackCount'),
    btnLibrary: $('btnLibrary'),
    btnCloseDrawer: $('btnCloseDrawer'),
    dropzone: $('dropzone'),
    toast: $('toast'),
  };

  // ── 狀態 ───────────────────────────────────────────────────────────────
  const state = {
    tracks: [],
    current: -1,
    lines: [],        // 解析後的歌詞行
    nodes: [],        // 對應的 DOM
    activeLine: -1,
    activeWord: -1,
    autoScroll: true,
    resumeTimer: 0,
    scrollTarget: 0,
    lastFrame: 0,
    objectUrls: [],
  };

  const DEFAULT_ACCENTS = ['#8a9bff', '#ff8ed0'];

  // ==========================================================================
  // LRC 解析
  // ==========================================================================

  const RE_META = /^\[(ti|ar|al|by|offset|length):(.*)]$/i;
  const RE_TIME = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)]/;
  const RE_WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;

  const toSeconds = (min, sec) => Number(min) * 60 + Number(String(sec).replace(':', '.'));

  function parseLRC(text) {
    const meta = {};
    const entries = [];
    let offset = 0;

    for (const raw of text.split(/\r?\n/)) {
      let rest = raw.trim();
      if (!rest) continue;

      const metaMatch = rest.match(RE_META);
      if (metaMatch) {
        const key = metaMatch[1].toLowerCase();
        const value = metaMatch[2].trim();
        if (key === 'offset') offset = (parseInt(value, 10) || 0) / 1000;
        else meta[key] = value;
        continue;
      }

      // 一行可能有多個時間標籤：[00:12.00][01:20.00]同一句歌詞
      const times = [];
      let m;
      while ((m = rest.match(RE_TIME))) {
        times.push(toSeconds(m[1], m[2]));
        rest = rest.slice(m[0].length);
      }
      if (!times.length) {
        // 沒有時間軸的純文字，先收著（整份都沒時間軸時會當靜態歌詞顯示）
        entries.push({ time: null, text: rest.trim(), words: null });
        continue;
      }

      const words = parseWords(rest);
      const clean = rest.replace(RE_WORD, '').trim();
      for (const t of times) {
        entries.push({ time: t, text: clean, words: words && shiftWords(words, t) });
      }
    }

    const timed = entries.filter((e) => e.time !== null);
    if (!timed.length) {
      return {
        meta,
        synced: false,
        lines: entries
          .filter((e) => e.text)
          .map((e) => ({ type: 'text', time: 0, text: e.text, subs: [], tokens: null })),
      };
    }

    timed.sort((a, b) => a.time - b.time);
    const lines = groupLines(timed, offset);
    return { meta, synced: true, lines: withGaps(lines) };
  }

  /** 增強型 LRC：<00:12.34>字 <00:12.90>字 */
  function parseWords(text) {
    RE_WORD.lastIndex = 0;
    if (!RE_WORD.test(text)) return null;
    RE_WORD.lastIndex = 0;

    const words = [];
    let match;
    let cursor = 0;
    let pending = null;

    while ((match = RE_WORD.exec(text))) {
      if (pending) {
        pending.text = text.slice(cursor, match.index);
        if (pending.text) words.push(pending);
      }
      pending = { time: toSeconds(match[1], match[2]), text: '' };
      cursor = match.index + match[0].length;
    }
    if (pending) {
      pending.text = text.slice(cursor);
      if (pending.text) words.push(pending);
    }
    return words.length ? words : null;
  }

  const shiftWords = (words, lineTime) =>
    words.map((w) => ({ ...w, time: w.time < lineTime - 1 ? lineTime : w.time }));

  /** 同一個時間點的第 2、3 行視為翻譯 */
  function groupLines(timed, offset) {
    const lines = [];
    for (const entry of timed) {
      const time = Math.max(entry.time - offset, 0);
      const prev = lines[lines.length - 1];
      if (prev && Math.abs(prev.time - time) < 0.02 && entry.text) {
        if (prev.text) {
          prev.subs.push(entry.text);
        } else {
          prev.text = entry.text;
          prev.type = 'text';
          prev.words = entry.words;
        }
        continue;
      }
      lines.push({
        type: entry.text ? 'text' : 'gap',
        time,
        text: entry.text,
        subs: [],
        words: entry.words,
        tokens: null,
      });
    }
    return lines;
  }

  /** 前奏與長間奏補上呼吸點 */
  function withGaps(lines) {
    const MIN_GAP = 6;
    const out = [];
    if (lines.length && lines[0].time > 4) {
      out.push({ type: 'gap', time: 0, text: '', subs: [], tokens: null });
    }
    lines.forEach((line, i) => {
      out.push(line);
      const next = lines[i + 1];
      if (!next || line.type === 'gap' || next.type === 'gap') return;
      const gap = next.time - line.time;
      if (gap < MIN_GAP) return;
      out.push({
        type: 'gap',
        time: line.time + Math.min(Math.max(gap * 0.32, 2), 5),
        text: '',
        subs: [],
        tokens: null,
      });
    });
    return out;
  }

  /** 把一行切成可以逐字上色的 token，並算出各自佔的時間比例 */
  function buildTokens(line, endTime) {
    if (line.type !== 'text') return [];

    if (line.words && line.words.length) {
      return line.words.map((w, i, arr) => ({
        text: w.text,
        start: w.time,
        end: i + 1 < arr.length ? arr[i + 1].time : endTime,
      }));
    }

    const pieces = tokenize(line.text);
    const weights = pieces.map((p) => Math.max(p.trim().length, 0.35));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(endTime - line.time, 0.6);

    let acc = 0;
    return pieces.map((text, i) => {
      const start = line.time + (acc / total) * span;
      acc += weights[i];
      return { text, start, end: line.time + (acc / total) * span };
    });
  }

  /** 英文以單字為單位，中日韓以單字元為單位；空白併入前一個 token */
  function tokenize(text) {
    const tokens = [];
    let buf = '';
    for (const ch of text) {
      if (/[A-Za-z0-9'’À-ɏ-]/.test(ch)) {
        buf += ch;
        continue;
      }
      if (buf) { tokens.push(buf); buf = ''; }
      if (ch === ' ') {
        if (tokens.length) tokens[tokens.length - 1] += ' ';
        else tokens.push(' ');
      } else {
        tokens.push(ch);
      }
    }
    if (buf) tokens.push(buf);
    return tokens.length ? tokens : [text];
  }

  // ==========================================================================
  // 歌詞渲染
  // ==========================================================================

  function renderLyrics(parsed) {
    state.lines = parsed && parsed.lines ? parsed.lines : [];
    state.synced = !parsed || parsed.synced !== false;
    state.activeLine = -1;
    state.activeWord = -1;
    state.nodes = [];
    els.track.textContent = '';

    if (!state.lines.length) {
      els.lyrics.classList.add('is-empty');
      return;
    }
    els.lyrics.classList.remove('is-empty');

    const frag = document.createDocumentFragment();
    state.lines.forEach((line, i) => {
      const end = state.lines[i + 1] ? state.lines[i + 1].time : line.time + 6;
      line.tokens = buildTokens(line, end);
      line.end = end;

      const node = document.createElement('button');
      node.type = 'button';
      node.className = line.type === 'gap' ? 'line line--gap is-far' : 'line is-far';
      node.dataset.i = String(i);
      node.style.setProperty('--d', '6');

      if (line.type === 'gap') {
        node.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      } else {
        const body = document.createElement('span');
        body.className = 'line__text';
        for (const token of line.tokens) {
          const span = document.createElement('span');
          span.className = 'w';
          span.textContent = token.text;
          body.appendChild(span);
        }
        node.appendChild(body);
        for (const sub of line.subs) {
          const subEl = document.createElement('span');
          subEl.className = 'line__sub';
          subEl.textContent = sub;
          node.appendChild(subEl);
        }
      }

      frag.appendChild(node);
      state.nodes.push(node);
    });

    els.track.appendChild(frag);
    els.viewport.scrollTop = 0;
    state.scrollTarget = 0;

    if (parsed && parsed.synced === false) {
      // 沒有時間軸就靜靜地列出來，不做同步
      state.nodes.forEach((n) => n.classList.remove('is-far'));
    }
  }

  function setActiveLine(index) {
    if (index === state.activeLine) return;
    state.activeLine = index;
    state.activeWord = -1;

    state.nodes.forEach((node, i) => {
      const dist = Math.abs(i - index);
      const active = i === index;
      node.classList.toggle('is-active', active);
      node.classList.toggle('is-done', i < index);
      node.classList.toggle('is-far', dist > 7);
      if (dist <= 7) node.style.setProperty('--d', String(dist));
      if (!active) {
        node.querySelectorAll('.w.is-sung').forEach((w) => w.classList.remove('is-sung'));
        const cur = node.querySelector('.w[style]');
        if (cur) cur.style.removeProperty('--p');
      }
    });

    const node = state.nodes[index];
    if (node) {
      state.scrollTarget = Math.max(
        node.offsetTop - els.viewport.clientHeight * 0.4 + node.offsetHeight / 2,
        0
      );
    }
  }

  function paintActive(time) {
    const line = state.lines[state.activeLine];
    const node = state.nodes[state.activeLine];
    if (!line || !node) return;

    if (line.type === 'gap') {
      const span = Math.max(line.end - line.time, 0.5);
      const lit = Math.min(Math.floor(((time - line.time) / span) * 3) + 1, 3);
      node.querySelectorAll('.dots i').forEach((dot, i) => dot.classList.toggle('on', i < lit));
      return;
    }

    const tokens = line.tokens;
    if (!tokens || !tokens.length) return;

    let idx = state.activeWord;
    while (idx + 1 < tokens.length && time >= tokens[idx + 1].start) idx += 1;
    while (idx >= 0 && time < tokens[idx].start) idx -= 1;

    const spans = node.querySelectorAll('.w');
    if (idx !== state.activeWord) {
      spans.forEach((span, i) => {
        span.classList.toggle('is-sung', i < idx);
        if (i !== idx) span.style.removeProperty('--p');
      });
      state.activeWord = idx;
    }

    if (idx >= 0 && spans[idx]) {
      const token = tokens[idx];
      const p = (time - token.start) / Math.max(token.end - token.start, 0.12);
      spans[idx].style.setProperty('--p', String(Math.min(Math.max(p, 0), 1)));
    }
  }

  function findLine(time) {
    const lines = state.lines;
    if (!lines.length) return -1;
    // 還沒唱到第一句時就先聚焦第一句，畫面不會空一片
    if (time < lines[0].time) return 0;
    let lo = 0;
    let hi = lines.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= time) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  }

  // ==========================================================================
  // 主迴圈
  // ==========================================================================

  function frame(now) {
    const dt = Math.min((now - (state.lastFrame || now)) / 1000, 0.1);
    state.lastFrame = now;

    const time = audio.currentTime || 0;

    if (state.lines.length && state.synced) {
      const index = findLine(time);
      if (index >= 0) {
        setActiveLine(index);
        paintActive(time);
      }
    }

    if (state.autoScroll && state.synced && state.nodes.length) {
      const delta = state.scrollTarget - els.viewport.scrollTop;
      if (Math.abs(delta) > 0.4) {
        els.viewport.scrollTop += delta * (1 - Math.pow(0.004, dt));
      }
    }

    updateProgress(time);
    requestAnimationFrame(frame);
  }

  function updateProgress(time) {
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      if (!state.dragging) {
        els.scrubFill.style.width = `${(time / duration) * 100}%`;
      }
      els.timeNow.textContent = formatTime(time);
      els.timeTotal.textContent = formatTime(duration);
      els.scrub.setAttribute('aria-valuenow', String(Math.round((time / duration) * 100)));
      try {
        const buffered = audio.buffered;
        if (buffered.length) {
          els.scrubBuffer.style.width = `${(buffered.end(buffered.length - 1) / duration) * 100}%`;
        }
      } catch { /* 還沒有 buffer 資訊，忽略 */ }
    } else {
      els.scrubFill.style.width = '0%';
      els.timeNow.textContent = '0:00';
      els.timeTotal.textContent = '0:00';
    }
  }

  const formatTime = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const total = Math.floor(s);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  // ==========================================================================
  // 捲動：使用者一動就暫停自動置中
  // ==========================================================================

  function suspendAuto() {
    if (!state.nodes.length) return;
    state.autoScroll = false;
    els.resumePill.hidden = false;
    requestAnimationFrame(() => els.resumePill.classList.add('is-shown'));
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(resumeAuto, 4200);
  }

  function resumeAuto() {
    clearTimeout(state.resumeTimer);
    state.autoScroll = true;
    els.resumePill.classList.remove('is-shown');
    setTimeout(() => { if (state.autoScroll) els.resumePill.hidden = true; }, 300);
  }

  ['wheel', 'touchstart', 'pointerdown'].forEach((evt) =>
    els.viewport.addEventListener(evt, suspendAuto, { passive: true })
  );
  els.resumePill.addEventListener('click', resumeAuto);

  els.track.addEventListener('click', (e) => {
    const node = e.target.closest('.line');
    if (!node) return;
    const line = state.lines[Number(node.dataset.i)];
    if (!line || line.type === 'gap') return;
    audio.currentTime = line.time + 0.02;
    resumeAuto();
    if (audio.paused) play();
  });

  // ==========================================================================
  // 播放控制
  // ==========================================================================

  function play() {
    audio.play().catch(() => toast('瀏覽器擋住了自動播放，再按一次播放鍵'));
  }

  function togglePlay() {
    if (!state.tracks.length) return toast('曲庫是空的，把 mp3 丟進 media 資料夾');
    if (state.current < 0) return selectTrack(0, true);
    if (audio.paused) play(); else audio.pause();
  }

  function step(delta) {
    if (!state.tracks.length) return;
    const next = (state.current + delta + state.tracks.length) % state.tracks.length;
    selectTrack(next, !audio.paused || state.current >= 0);
  }

  async function selectTrack(index, autoplay = true) {
    const track = state.tracks[index];
    if (!track) return;
    state.current = index;

    audio.src = track.audio;
    audio.load();

    els.title.textContent = track.title;
    els.artist.textContent = [track.artist, track.album].filter(Boolean).join(' · ') || '—';
    document.title = `${track.title} · Lyris`;

    renderCover(track);
    renderTracklist();
    renderLyrics(null);
    els.lyrics.classList.add('is-empty');

    if (track.lyrics) {
      try {
        const res = await fetch(track.lyrics);
        if (!res.ok) throw new Error(String(res.status));
        if (state.current !== index) return;   // 中途又切歌了
        renderLyrics(parseLRC(await res.text()));
      } catch {
        renderLyrics(null);
      }
    } else if (track.lrcText) {
      renderLyrics(parseLRC(track.lrcText));
    }

    updateMediaSession(track);
    if (autoplay) play();
  }

  function renderCover(track) {
    if (!track.cover) {
      els.coverImg.hidden = true;
      els.coverImg.classList.remove('is-loaded');
      els.coverFallback.hidden = false;
      els.ambientArt.classList.remove('is-visible');
      applyAccents(accentsFromString(track.title + track.artist));
      return;
    }

    const img = new Image();
    img.onload = () => {
      els.coverImg.src = img.src;
      els.coverImg.hidden = false;
      els.coverFallback.hidden = true;
      requestAnimationFrame(() => els.coverImg.classList.add('is-loaded'));
      els.ambientArt.style.backgroundImage = `url("${img.src}")`;
      els.ambientArt.classList.add('is-visible');
      applyAccents(accentsFromImage(img));
    };
    img.onerror = () => {
      els.coverImg.hidden = true;
      els.coverFallback.hidden = false;
      els.ambientArt.classList.remove('is-visible');
      applyAccents(accentsFromString(track.title));
    };
    img.src = track.cover;
  }

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      artwork: track.cover ? [{ src: track.cover, sizes: '512x512' }] : [],
    });
    navigator.mediaSession.setActionHandler('play', play);
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  }

  // ==========================================================================
  // 主色抽取
  // ==========================================================================

  function accentsFromImage(img) {
    try {
      const size = 44;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);

      const buckets = Array.from({ length: 18 }, () => ({ weight: 0, sat: 0, light: 0, hue: 0 }));
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (s < 0.12 || l < 0.12 || l > 0.94) continue;
        const weight = s * (1 - Math.abs(l - 0.55) * 1.1);
        if (weight <= 0) continue;
        const b = buckets[Math.min(Math.floor(h / 20), 17)];
        b.weight += weight;
        b.sat += s * weight;
        b.light += l * weight;
        b.hue += h * weight;
      }

      const ranked = buckets
        .map((b, i) => ({ ...b, index: i }))
        .filter((b) => b.weight > 0)
        .sort((a, b) => b.weight - a.weight);

      if (!ranked.length) return DEFAULT_ACCENTS;

      const primary = ranked[0];
      const secondary =
        ranked.find((b) => {
          const gap = Math.abs(b.index - primary.index);
          return Math.min(gap, 18 - gap) >= 3;
        }) || primary;

      return [toAccent(primary), toAccent(secondary, 22)];
    } catch {
      return DEFAULT_ACCENTS;
    }
  }

  function toAccent(bucket, hueShift = 0) {
    const hue = (bucket.hue / bucket.weight + hueShift + 360) % 360;
    const sat = Math.min(Math.max((bucket.sat / bucket.weight) * 1.25, 0.55), 0.92);
    return `hsl(${hue.toFixed(1)} ${(sat * 100).toFixed(0)}% 66%)`;
  }

  /** 沒有封面時，用歌名雜湊出一組穩定的顏色 */
  function accentsFromString(seed) {
    let hash = 0;
    for (const ch of String(seed || 'lyris')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const hue = hash % 360;
    return [`hsl(${hue} 72% 66%)`, `hsl(${(hue + 58) % 360} 76% 68%)`];
  }

  function applyAccents([a, b]) {
    document.documentElement.style.setProperty('--accent', a);
    document.documentElement.style.setProperty('--accent-2', b);
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return [0, 0, l];
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  // ==========================================================================
  // 曲目清單
  // ==========================================================================

  function renderTracklist() {
    els.trackCount.textContent = String(state.tracks.length);
    els.tracklist.textContent = '';

    if (!state.tracks.length) {
      const li = document.createElement('li');
      li.className = 'tracklist__empty';
      li.innerHTML =
        '曲庫是空的。<br>把 <code>song.mp3</code> 和 <code>song.lrc</code> 放進 ' +
        '<code>media/</code> 後重新整理，或直接把檔案拖進這個視窗。';
      els.tracklist.appendChild(li);
      return;
    }

    const frag = document.createDocumentFragment();
    state.tracks.forEach((track, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `trk${i === state.current ? ' is-current' : ''}`;
      btn.onclick = () => { selectTrack(i, true); closeDrawer(); };

      const idx = document.createElement('span');
      idx.className = 'trk__idx';
      if (i === state.current) {
        idx.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>';
      } else {
        idx.textContent = String(i + 1).padStart(2, '0');
      }

      const body = document.createElement('span');
      body.className = 'trk__body';
      body.innerHTML =
        `<span class="trk__title"></span><span class="trk__sub"></span>`;
      body.querySelector('.trk__title').textContent = track.title;
      body.querySelector('.trk__sub').textContent =
        [track.artist, track.album].filter(Boolean).join(' · ') || '—';

      btn.append(idx, body);

      if (track.local) {
        const tag = document.createElement('span');
        tag.className = 'trk__tag trk__tag--local';
        tag.textContent = '本機';
        btn.appendChild(tag);
      } else if (!track.lyrics) {
        const tag = document.createElement('span');
        tag.className = 'trk__tag';
        tag.textContent = '無歌詞';
        btn.appendChild(tag);
      }

      li.appendChild(btn);
      frag.appendChild(li);
    });
    els.tracklist.appendChild(frag);
  }

  let drawerTimer = 0;

  function openDrawer() {
    clearTimeout(drawerTimer);          // 免得上一次關閉的收尾把它又藏起來
    els.drawer.hidden = false;
    els.drawerScrim.hidden = false;
    requestAnimationFrame(() => {
      els.drawer.classList.add('is-open');
      els.drawerScrim.classList.add('is-open');
    });
  }

  function closeDrawer() {
    clearTimeout(drawerTimer);
    els.drawer.classList.remove('is-open');
    els.drawerScrim.classList.remove('is-open');
    drawerTimer = setTimeout(() => {
      els.drawer.hidden = true;
      els.drawerScrim.hidden = true;
    }, 380);
  }

  const drawerOpen = () => els.drawer.classList.contains('is-open');

  // ==========================================================================
  // 拖放本機檔案
  // ==========================================================================

  function setupDropzone() {
    let depth = 0;

    window.addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      depth += 1;
      els.dropzone.hidden = false;
    });

    window.addEventListener('dragover', (e) => e.preventDefault());

    window.addEventListener('dragleave', () => {
      depth = Math.max(depth - 1, 0);
      if (!depth) els.dropzone.hidden = true;
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      els.dropzone.hidden = true;
      await addLocalFiles([...(e.dataTransfer?.files || [])]);
    });
  }

  async function addLocalFiles(files) {
    const audios = new Map();
    const lyrics = new Map();

    for (const file of files) {
      const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
      if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(file.name)) audios.set(stem, file);
      else if (/\.lrc$/i.test(file.name)) lyrics.set(stem, file);
    }

    if (!audios.size) {
      toast(lyrics.size ? '只有歌詞，還缺 mp3 檔' : '請拖入 mp3（可以連同 lrc 一起）');
      return;
    }

    const added = [];
    for (const [stem, file] of audios) {
      const url = URL.createObjectURL(file);
      state.objectUrls.push(url);
      const lrcFile = lyrics.get(stem);
      const lrcText = lrcFile ? await lrcFile.text() : '';
      const meta = lrcText.match(/^\[ti:(.*)]$/im);
      const artistMeta = lrcText.match(/^\[ar:(.*)]$/im);

      let title = (meta && meta[1].trim()) || file.name.replace(/\.[^.]+$/, '');
      let artist = (artistMeta && artistMeta[1].trim()) || '';
      if (!artist && title.includes(' - ')) {
        const [left, right] = title.split(' - ');
        artist = left.trim();
        title = right.trim();
      }

      added.push({
        id: `local-${stem}-${Date.now()}`,
        title,
        artist: artist || '本機檔案',
        album: '',
        audio: url,
        lyrics: null,
        lrcText,
        cover: null,
        local: true,
      });
    }

    const start = state.tracks.length;
    state.tracks.push(...added);
    renderTracklist();
    toast(`已加入 ${added.length} 首`);
    selectTrack(start, true);
  }

  // ==========================================================================
  // 進度條拖曳
  // ==========================================================================

  function setupScrub() {
    const seekTo = (clientX) => {
      const rect = els.scrub.getBoundingClientRect();
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      els.scrubFill.style.width = `${ratio * 100}%`;
      return ratio;
    };

    els.scrub.addEventListener('pointerdown', (e) => {
      if (!Number.isFinite(audio.duration)) return;
      state.dragging = true;
      els.scrub.classList.add('is-dragging');
      els.scrub.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });

    els.scrub.addEventListener('pointermove', (e) => {
      if (state.dragging) seekTo(e.clientX);
    });

    const finish = (e) => {
      if (!state.dragging) return;
      state.dragging = false;
      els.scrub.classList.remove('is-dragging');
      audio.currentTime = seekTo(e.clientX) * audio.duration;
      resumeAuto();
    };

    els.scrub.addEventListener('pointerup', finish);
    els.scrub.addEventListener('pointercancel', () => {
      state.dragging = false;
      els.scrub.classList.remove('is-dragging');
    });

    els.scrub.addEventListener('keydown', (e) => {
      const nudge = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
      if (!nudge || !Number.isFinite(audio.duration)) return;
      e.preventDefault();
      audio.currentTime = Math.min(Math.max(audio.currentTime + nudge, 0), audio.duration);
    });
  }

  // ==========================================================================
  // 其它 UI
  // ==========================================================================

  let toastTimer = 0;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add('is-shown'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('is-shown');
      setTimeout(() => { els.toast.hidden = true; }, 320);
    }, 2600);
  }

  function setupControls() {
    els.btnPlay.addEventListener('click', togglePlay);
    els.btnPrev.addEventListener('click', () => {
      if (audio.currentTime > 3) { audio.currentTime = 0; return; }
      step(-1);
    });
    els.btnNext.addEventListener('click', () => step(1));

    els.btnLibrary.addEventListener('click', () => (drawerOpen() ? closeDrawer() : openDrawer()));
    els.btnCloseDrawer.addEventListener('click', closeDrawer);
    els.drawerScrim.addEventListener('click', closeDrawer);

    els.volume.addEventListener('input', () => {
      audio.volume = Number(els.volume.value);
      audio.muted = audio.volume === 0;
      els.btnVolume.classList.toggle('is-muted', audio.muted);
    });

    els.btnVolume.addEventListener('click', () => {
      audio.muted = !audio.muted;
      els.btnVolume.classList.toggle('is-muted', audio.muted);
      if (!audio.muted && audio.volume === 0) {
        audio.volume = 0.8;
        els.volume.value = '0.8';
      }
    });

    // 圖示切換交給 CSS（body.is-playing），SVG 元素沒有 hidden 這個屬性可以設
    audio.addEventListener('play', () => {
      document.body.classList.add('is-playing');
      els.btnPlay.setAttribute('aria-label', '暫停');
    });

    audio.addEventListener('pause', () => {
      document.body.classList.remove('is-playing');
      els.btnPlay.setAttribute('aria-label', '播放');
    });

    audio.addEventListener('ended', () => step(1));
    audio.addEventListener('error', () => {
      if (audio.src) toast('這個音檔讀不到，換一首試試');
    });
    audio.addEventListener('seeked', () => { state.activeWord = -1; });

    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault(); togglePlay(); break;
        case 'ArrowRight':
          audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0); break;
        case 'ArrowLeft':
          audio.currentTime = Math.max(audio.currentTime - 5, 0); break;
        case 'ArrowUp':
          e.preventDefault();
          audio.volume = Math.min(audio.volume + 0.05, 1);
          els.volume.value = String(audio.volume);
          break;
        case 'ArrowDown':
          e.preventDefault();
          audio.volume = Math.max(audio.volume - 0.05, 0);
          els.volume.value = String(audio.volume);
          break;
        case 'n': step(1); break;
        case 'p': step(-1); break;
        case 'm': els.btnVolume.click(); break;
        case 'l': drawerOpen() ? closeDrawer() : openDrawer(); break;
        case 'Escape': if (drawerOpen()) closeDrawer(); break;
        default: break;
      }
    });

    window.addEventListener('resize', () => {
      const node = state.nodes[state.activeLine];
      if (!node) return;
      state.scrollTarget = Math.max(
        node.offsetTop - els.viewport.clientHeight * 0.4 + node.offsetHeight / 2,
        0
      );
    });

    window.addEventListener('beforeunload', () => {
      state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    });
  }

  // ==========================================================================
  // 啟動
  // ==========================================================================

  async function boot() {
    setupControls();
    setupScrub();
    setupDropzone();
    applyAccents(DEFAULT_ACCENTS);
    requestAnimationFrame(frame);

    try {
      const res = await fetch('/api/tracks');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      state.tracks = data.tracks || [];
    } catch {
      state.tracks = [];
    }

    renderTracklist();
    els.lyrics.classList.add('is-empty');

    if (state.tracks.length) {
      selectTrack(0, false);
    } else {
      els.title.textContent = '曲庫是空的';
      els.artist.textContent = '把 mp3 / lrc 拖進來，或放進 media 資料夾';
      openDrawer();
    }
  }

  boot();
})();
