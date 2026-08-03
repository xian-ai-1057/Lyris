/* ==========================================================================
   Lyris — 歌詞打軸器
   1) 選一首歌 + 貼上歌詞（一行一句）
   2) 邊聽邊按空白鍵，把每一句釘在時間軸上
   3) 輸出 .lrc（也可以直接套用到播放器聽聽看對不對）
   ========================================================================== */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const RE_META_LINE = /^\[(ti|ar|al|by|offset|length|re|ve|tool):/i;
  const RE_LEAD_TIME = /^(\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
  const RE_WORD_TIME = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

  let deps = {
    getTracks: () => [],
    toast: () => {},
    onApply: () => {},
    onClose: () => {},
  };

  let els = null;
  let opened = false;

  const state = {
    stage: 'setup',
    lines: [],        // [{ text, time|null }]
    rows: [],         // 對應的 DOM
    cursor: 0,        // 下一句要打的位置
    source: null,     // { kind:'track'|'file', id, url, name }
    objectUrls: [],
  };

  // ── 小工具 ─────────────────────────────────────────────────────────────

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const clock = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const total = Math.floor(s);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  /** LRC 的時間格式 [mm:ss.xx]，超過一小時就讓分鐘數繼續往上加 */
  const stamp = (s) => {
    const safe = Math.max(s, 0);
    const min = Math.floor(safe / 60);
    const sec = safe - min * 60;
    return `${String(min).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  };

  const isTyping = () => {
    const tag = document.activeElement && document.activeElement.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const safeFileName = (name) => (name || 'lyrics').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);

  /** 把貼進來的東西洗成一行一句：拔掉 meta 標籤與舊的時間軸 */
  function toPlainLines(text) {
    const raw = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (RE_META_LINE.test(trimmed)) continue;
      raw.push(trimmed.replace(RE_LEAD_TIME, '').replace(RE_WORD_TIME, '').trim());
    }
    const out = [];
    for (const line of raw) {
      // 連續空行併成一個間奏，開頭的空行直接丟掉
      if (!line && (!out.length || !out[out.length - 1])) continue;
      out.push(line);
    }
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  }

  // ── 準備階段 ───────────────────────────────────────────────────────────

  function fillSourceOptions() {
    const tracks = deps.getTracks();
    const current = state.source && state.source.kind === 'track' ? state.source.id : '';
    els.source.textContent = '';

    const head = document.createElement('option');
    head.value = '';
    head.textContent = tracks.length ? '從曲庫挑一首…' : '曲庫是空的，請選本機檔案';
    els.source.appendChild(head);

    tracks.forEach((track, i) => {
      const option = document.createElement('option');
      option.value = track.id;
      option.textContent = `${String(i + 1).padStart(2, '0')} · ${track.title}`;
      els.source.appendChild(option);
    });
    els.source.value = current;
    els.source.disabled = !tracks.length;
  }

  async function chooseTrack(id) {
    const track = deps.getTracks().find((t) => t.id === id);
    if (!track) return;

    setSource({ kind: 'track', id: track.id, url: track.audio, name: track.title });
    if (!els.title.value) els.title.value = track.title || '';
    if (!els.artist.value) els.artist.value = track.artist === '未知演出者' ? '' : track.artist || '';
    if (!els.album.value) els.album.value = track.album || '';

    // 這首本來就有歌詞的話直接載進來（會自動去掉舊的時間軸），重打一份很方便
    if (els.text.value.trim()) return;
    let text = track.lrcText || '';
    if (!text && track.lyrics) {
      try {
        const res = await fetch(track.lyrics);
        if (res.ok) text = await res.text();
      } catch { /* 讀不到就算了，使用者自己貼 */ }
    }
    if (text) {
      els.text.value = toPlainLines(text).join('\n');
      deps.toast('已載入這首的歌詞，時間軸會重新打');
    }
  }

  function chooseFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    state.objectUrls.push(url);
    const stem = file.name.replace(/\.[^.]+$/, '');
    setSource({ kind: 'file', id: '', url, name: stem });
    els.source.value = '';
    if (!els.title.value) {
      const [left, right] = stem.includes(' - ') ? stem.split(' - ') : ['', stem];
      els.title.value = right.trim();
      if (!els.artist.value) els.artist.value = left.trim();
    }
  }

  function setSource(source) {
    state.source = source;
    els.audio.src = source.url;
    els.audio.load();
    els.audio.playbackRate = Number(els.rate.value) || 1;
    els.sourceName.textContent = `音檔：${source.name}`;
    els.sourceName.classList.add('is-set');
  }

  function start() {
    if (!state.source) {
      deps.toast('先挑一首歌或選一個音檔');
      els.source.focus();
      return;
    }
    const lines = toPlainLines(els.text.value);
    if (!lines.length) {
      deps.toast('把歌詞貼進來，一行一句');
      els.text.focus();
      return;
    }

    // 內容沒變就保留原本打好的時間軸，只是回去改個錯字不用重打
    const same =
      state.lines.length === lines.length && state.lines.every((l, i) => l.text === lines[i]);
    if (!same) {
      state.lines = lines.map((text) => ({ text, time: null }));
      state.cursor = 0;
    }

    setStage('work');
    renderLines();
    setCursor(firstUnstamped());
  }

  // ── 打軸階段 ───────────────────────────────────────────────────────────

  function renderLines() {
    els.list.textContent = '';
    state.rows = [];

    const frag = document.createDocumentFragment();
    state.lines.forEach((line, i) => {
      const li = document.createElement('li');
      li.className = 'mline';
      li.dataset.i = String(i);

      const time = document.createElement('button');
      time.type = 'button';
      time.className = 'mline__time';
      time.dataset.act = 'seek';
      time.title = '跳到這一句';

      const text = document.createElement('span');
      text.className = line.text ? 'mline__text' : 'mline__text is-gap';
      text.textContent = line.text || '（間奏）';

      const tools = document.createElement('span');
      tools.className = 'mline__tools';
      tools.innerHTML =
        '<button type="button" data-act="minus" title="提早 0.1 秒">−</button>' +
        '<button type="button" data-act="plus" title="延後 0.1 秒">＋</button>' +
        '<button type="button" data-act="clear" title="清掉這一句的時間">✕</button>';

      li.append(time, text, tools);
      frag.appendChild(li);
      state.rows.push({ li, time });
    });

    els.list.appendChild(frag);
    state.lines.forEach((_, i) => updateRow(i));
  }

  function updateRow(index) {
    const row = state.rows[index];
    const line = state.lines[index];
    if (!row || !line) return;
    const set = line.time !== null;
    row.time.textContent = set ? stamp(line.time) : '--:--';
    row.li.classList.toggle('is-set', set);
  }

  function setCursor(index) {
    state.cursor = clamp(index, 0, state.lines.length);
    state.rows.forEach((row, i) => row.li.classList.toggle('is-current', i === state.cursor));
    const done = state.lines.filter((l) => l.time !== null).length;
    els.stat.textContent = `已標記 ${done} / ${state.lines.length}`;
    els.stat.classList.toggle('is-done', done === state.lines.length && done > 0);

    const row = state.rows[state.cursor];
    if (row) {
      const top = row.li.offsetTop - els.list.clientHeight / 2 + row.li.offsetHeight / 2;
      els.list.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }
  }

  const firstUnstamped = () => {
    const i = state.lines.findIndex((l) => l.time === null);
    return i < 0 ? state.lines.length : i;
  };

  /** 空白鍵：把目前這句釘在現在的播放時間，然後跳到下一句 */
  function mark() {
    if (state.cursor >= state.lines.length) {
      deps.toast('已經是最後一句了，可以下載 .lrc 了');
      return;
    }
    state.lines[state.cursor].time = Math.max(els.audio.currentTime, 0);
    updateRow(state.cursor);
    flash(state.rows[state.cursor].li);
    setCursor(state.cursor + 1);
    if (state.cursor >= state.lines.length) deps.toast('打完了！可以下載 .lrc 了');
  }

  /** Backspace：退回上一句、清掉它的時間，並把音樂倒回那個位置重來 */
  function undo() {
    const index = clamp(state.cursor - 1, 0, state.lines.length - 1);
    if (!state.lines.length) return;
    state.lines[index].time = null;
    updateRow(index);
    setCursor(index);

    for (let i = index - 1; i >= 0; i -= 1) {
      if (state.lines[i].time !== null) {
        seek(state.lines[i].time);
        return;
      }
    }
    seek(0);
  }

  function nudge(index, delta) {
    const line = state.lines[index];
    if (!line || line.time === null) return;
    line.time = Math.max(line.time + delta, 0);
    updateRow(index);
  }

  function flash(node) {
    node.classList.remove('is-hit');
    void node.offsetWidth;   // 強制重排，讓動畫可以連續觸發
    node.classList.add('is-hit');
  }

  // ── 播放控制 ───────────────────────────────────────────────────────────

  const play = () => els.audio.play().catch(() => deps.toast('這個音檔播不動，換一個試試'));
  const togglePlay = () => (els.audio.paused ? play() : els.audio.pause());

  function seek(seconds) {
    const duration = els.audio.duration;
    els.audio.currentTime = Number.isFinite(duration)
      ? clamp(seconds, 0, Math.max(duration - 0.05, 0))
      : Math.max(seconds, 0);
  }

  function tick() {
    if (!opened) return;
    const duration = els.audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      els.seekFill.style.width = `${(els.audio.currentTime / duration) * 100}%`;
      els.time.textContent = `${clock(els.audio.currentTime)} / ${clock(duration)}`;
    } else {
      els.seekFill.style.width = '0%';
      els.time.textContent = '0:00 / 0:00';
    }
    requestAnimationFrame(tick);
  }

  // ── 輸出 ───────────────────────────────────────────────────────────────

  function buildLRC() {
    const shift = (Number(els.offset.value) || 0) / 1000;
    const out = [];
    const meta = [['ti', els.title.value], ['ar', els.artist.value], ['al', els.album.value]];
    for (const [key, value] of meta) {
      if (value.trim()) out.push(`[${key}:${value.trim()}]`);
    }
    out.push('[by:Lyris]', '');

    const timed = state.lines
      .filter((line) => line.time !== null)
      .map((line) => ({ text: line.text, time: Math.max(line.time + shift, 0) }))
      .sort((a, b) => a.time - b.time);

    for (const line of timed) out.push(`[${stamp(line.time)}]${line.text}`);
    return { text: `${out.join('\n')}\n`, count: timed.length };
  }

  function download() {
    const { text, count } = buildLRC();
    if (!count) {
      deps.toast('還沒有任何時間軸，先按空白鍵打幾句');
      return;
    }
    const missing = state.lines.length - count;
    const name = safeFileName(els.title.value.trim() || (state.source && state.source.name));

    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.lrc`;
    document.body.appendChild(link);   // 要掛進文件裡，download 檔名才會被採用
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    deps.toast(missing ? `已下載（有 ${missing} 句沒時間軸，沒寫進去）` : '已下載 .lrc');
  }

  function apply() {
    const { text, count } = buildLRC();
    if (!count) {
      deps.toast('還沒有任何時間軸，先按空白鍵打幾句');
      return;
    }
    els.audio.pause();
    deps.onApply({
      lrc: text,
      trackId: state.source && state.source.kind === 'track' ? state.source.id : '',
      audioUrl: state.source ? state.source.url : '',
      title: els.title.value.trim() || (state.source ? state.source.name : '未命名'),
      artist: els.artist.value.trim(),
      album: els.album.value.trim(),
    });
    close();
  }

  // ── 開關 ───────────────────────────────────────────────────────────────

  function setStage(stage) {
    state.stage = stage;
    const setup = stage === 'setup';
    els.setup.hidden = !setup;
    els.work.hidden = setup;
    els.step.textContent = setup ? '1 / 2 · 準備素材' : '2 / 2 · 打時間軸';
  }

  function open() {
    if (opened) return;
    opened = true;
    els.root.hidden = false;
    requestAnimationFrame(() => els.root.classList.add('is-open'));
    fillSourceOptions();
    setStage(state.lines.length ? state.stage : 'setup');
    if (state.stage === 'work') {
      renderLines();
      setCursor(state.cursor);
    }
    requestAnimationFrame(tick);
  }

  function close() {
    if (!opened) return;
    opened = false;
    els.audio.pause();
    els.root.classList.remove('is-open');
    setTimeout(() => { if (!opened) els.root.hidden = true; }, 260);
    deps.onClose();
  }

  // ── 綁事件 ─────────────────────────────────────────────────────────────

  function bind() {
    els.close.addEventListener('click', close);

    els.source.addEventListener('change', () => {
      if (els.source.value) chooseTrack(els.source.value);
    });
    els.pick.addEventListener('click', () => els.file.click());
    els.file.addEventListener('change', () => {
      chooseFile(els.file.files[0]);
      els.file.value = '';
    });
    els.start.addEventListener('click', start);

    els.play.addEventListener('click', togglePlay);
    els.back.addEventListener('click', () => seek(els.audio.currentTime - 3));
    els.fwd.addEventListener('click', () => seek(els.audio.currentTime + 3));
    // 手機沒有空白鍵，還是要有辦法打軸
    els.mark.addEventListener('click', () => (els.audio.paused ? play() : mark()));
    els.rate.addEventListener('change', () => {
      els.audio.playbackRate = Number(els.rate.value) || 1;
    });

    els.audio.addEventListener('play', () => els.root.classList.add('is-playing'));
    els.audio.addEventListener('pause', () => els.root.classList.remove('is-playing'));
    els.audio.addEventListener('ended', () => els.root.classList.remove('is-playing'));
    els.audio.addEventListener('error', () => {
      if (els.audio.src) deps.toast('這個音檔讀不到');
    });

    bindSeekBar();
    bindList();

    els.edit.addEventListener('click', () => setStage('setup'));
    els.reset.addEventListener('click', () => {
      state.lines.forEach((line, i) => { line.time = null; updateRow(i); });
      setCursor(0);
      seek(0);
      deps.toast('時間軸清掉了，重新開始');
    });
    els.apply.addEventListener('click', apply);
    els.download.addEventListener('click', download);

    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', () => {
      state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    });
  }

  function bindSeekBar() {
    let dragging = false;

    const seekTo = (clientX) => {
      const rect = els.seek.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      if (Number.isFinite(els.audio.duration)) seek(ratio * els.audio.duration);
    };

    els.seek.addEventListener('pointerdown', (e) => {
      if (!Number.isFinite(els.audio.duration)) return;
      dragging = true;
      els.seek.setPointerCapture(e.pointerId);
      seekTo(e.clientX);
    });
    els.seek.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX); });
    els.seek.addEventListener('pointerup', () => { dragging = false; });
    els.seek.addEventListener('pointercancel', () => { dragging = false; });
  }

  function bindList() {
    els.list.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-act]');
      const li = e.target.closest('.mline');
      if (!li) return;
      const index = Number(li.dataset.i);

      if (!button) {          // 點空白處＝把游標移到這一句，準備從這裡重打
        setCursor(index);
        return;
      }
      const line = state.lines[index];
      switch (button.dataset.act) {
        case 'seek':
          if (line.time !== null) { seek(line.time); setCursor(index); }
          else setCursor(index);
          break;
        case 'minus': nudge(index, -0.1); break;
        case 'plus': nudge(index, 0.1); break;
        case 'clear':
          line.time = null;
          updateRow(index);
          setCursor(Math.min(index, firstUnstamped()));
          break;
        default: break;
      }
    });
  }

  function onKey(e) {
    if (!opened) return;

    if (e.key === 'Escape') {
      if (isTyping()) return;
      close();
      return;
    }
    if (state.stage !== 'work' || isTyping()) return;

    switch (e.key) {
      case ' ':
        // 停著的時候空白鍵＝開始播，播著的時候才是打點，不然一開頭就會誤打
        e.preventDefault();
        if (els.audio.paused) play(); else mark();
        break;
      case 'Enter':
        e.preventDefault();
        togglePlay();
        break;
      case 'Backspace':
        e.preventDefault();
        undo();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seek(els.audio.currentTime - 3);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seek(els.audio.currentTime + 3);
        break;
      default:
        break;
    }
  }

  // ── 對外 ───────────────────────────────────────────────────────────────

  function mount(options) {
    deps = { ...deps, ...options };
    els = {
      root: $('maker'),
      close: $('makerClose'),
      step: $('makerStep'),
      setup: $('makerSetup'),
      work: $('makerWork'),
      source: $('makerSource'),
      pick: $('makerPick'),
      file: $('makerFile'),
      sourceName: $('makerSourceName'),
      title: $('makerTitle'),
      artist: $('makerArtist'),
      album: $('makerAlbum'),
      text: $('makerText'),
      start: $('makerStart'),
      audio: $('makerAudio'),
      play: $('makerPlay'),
      back: $('makerBack'),
      fwd: $('makerFwd'),
      mark: $('makerMark'),
      seek: $('makerSeek'),
      seekFill: $('makerSeekFill'),
      time: $('makerTime'),
      rate: $('makerRate'),
      offset: $('makerOffset'),
      list: $('makerLines'),
      stat: $('makerStat'),
      edit: $('makerEdit'),
      reset: $('makerReset'),
      apply: $('makerApply'),
      download: $('makerDownload'),
    };
    bind();
  }

  window.LyrisMaker = { mount, open, close, isOpen: () => opened };
})();
