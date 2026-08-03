// 把 web/ 和 media/ 組成一份可以靜態發佈的 dist/。
//
// 靜態主機沒有「列出資料夾」這種能力，所以 server.py 的 /api/tracks 要在這裡先算好，
// 變成一份 dist/api/tracks.json（vercel.json 再把 /api/tracks 導過去）。
// 掃描規則刻意跟 server.py 對齊，這樣本機看到的曲庫跟線上那份會是同一份。

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WEB = path.join(ROOT, 'web');
const MEDIA = path.join(ROOT, 'media');
const DIST = path.join(ROOT, 'dist');

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac']);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const LYRIC_EXTS = ['.lrc', '.txt'];
const FOLDER_COVER_NAMES = ['cover', 'folder', 'front', 'album'];
const META_RE = /^\[(ti|ar|al):(.*)]$/i;

/** 遞迴列出資料夾裡的檔案，跳過隱藏檔與 macOS 的 zip 殘渣 */
async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];                                  // 沒有 media/ 也要能建置
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 只掃開頭幾十行就夠了，跟 server.py 的 read_lrc_meta 一樣 */
async function readLrcMeta(file) {
  const meta = {};
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/).slice(0, 41)) {
      const m = META_RE.exec(line.trim());
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
    }
  } catch {
    // 讀不到就當作沒有標籤
  }
  return meta;
}

/** 同名的 .lrc 優先，只有 .txt 的話當成沒有時間軸的純文字歌詞 */
function findLyrics(audioFile, byDir) {
  const stem = path.basename(audioFile, path.extname(audioFile));
  const siblings = byDir.get(path.dirname(audioFile)) || [];
  for (const ext of LYRIC_EXTS) {
    const hit = siblings.find(
      (f) => path.extname(f).toLowerCase() === ext &&
             path.basename(f, path.extname(f)) === stem
    );
    if (hit) return hit;
  }
  return null;
}

/** 同名圖檔優先，其次是同資料夾的 cover / folder / front / album */
function findCover(audioFile, byDir) {
  const stem = path.basename(audioFile, path.extname(audioFile));
  const dir = path.dirname(audioFile);
  const siblings = byDir.get(dir) || [];
  const imageOf = (name) =>
    siblings.find((f) => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTS.includes(ext) && path.basename(f, path.extname(f)).toLowerCase() === name;
    });

  return imageOf(stem.toLowerCase()) || FOLDER_COVER_NAMES.map(imageOf).find(Boolean) || null;
}

/** 中文與空白都要編碼，不然 URL 會壞掉 */
function toUrl(relPath) {
  return '/media/' + relPath.split(path.sep).map(encodeURIComponent).join('/');
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(WEB, DIST, { recursive: true });

  const files = await walk(MEDIA);
  const byDir = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(file);
  }

  const audioFiles = files
    .filter((f) => AUDIO_EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));

  const tracks = [];
  const toCopy = new Set();

  for (const audioFile of audioFiles) {
    const rel = path.relative(MEDIA, audioFile);
    const lyricsFile = findLyrics(audioFile, byDir);
    const coverFile = findCover(audioFile, byDir);
    const meta = lyricsFile ? await readLrcMeta(lyricsFile) : {};

    const stem = path.basename(audioFile, path.extname(audioFile));
    let title = meta.ti || stem;
    let artist = meta.ar || '';
    if (!artist && stem.includes(' - ')) {
      // 常見的「歌手 - 歌名.mp3」命名
      const [left, ...rest] = stem.split(' - ');
      artist = left.trim();
      title = meta.ti || rest.join(' - ').trim();
    }

    toCopy.add(rel);
    if (lyricsFile) toCopy.add(path.relative(MEDIA, lyricsFile));
    if (coverFile) toCopy.add(path.relative(MEDIA, coverFile));

    tracks.push({
      id: createHash('sha1').update(rel.split(path.sep).join('/'), 'utf8').digest('hex').slice(0, 12),
      title: title.trim(),
      artist: artist.trim() || '未知演出者',
      album: (meta.al || '').trim(),
      hasLyrics: Boolean(lyricsFile),
      audio: toUrl(rel),
      lyrics: lyricsFile ? toUrl(path.relative(MEDIA, lyricsFile)) : null,
      // 靜態版沒辦法在瀏覽器端挖 ID3 內嵌封面，沒有同名圖檔就交給前端生漸層
      cover: coverFile ? toUrl(path.relative(MEDIA, coverFile)) : null,
    });
  }

  for (const rel of toCopy) {
    const dest = path.join(DIST, 'media', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(MEDIA, rel), dest);
  }

  await mkdir(path.join(DIST, 'api'), { recursive: true });
  await writeFile(path.join(DIST, 'api', 'tracks.json'), JSON.stringify({ tracks }, null, 2), 'utf8');

  console.log(`Lyris build：${tracks.length} 首歌，${toCopy.size} 個檔案 → dist/`);
  for (const t of tracks) console.log(`  · ${t.artist} — ${t.title}${t.hasLyrics ? '' : '（沒有歌詞）'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
