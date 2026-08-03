/* ==========================================================================
   Lyris — 極簡 ZIP 讀取器
   只做一件事：把 zip 讀成一堆 { name, data }。
   deflate 交給瀏覽器內建的 DecompressionStream，所以不需要任何函式庫。

   有 server 的時候 zip 會直接上傳給後端處理；這支是給「直接開 index.html」
   的離線模式用的。
   ========================================================================== */

(() => {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const KEEP = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|lrc|txt|jpe?g|png|webp)$/i;

  const supported = () => typeof DecompressionStream !== 'undefined';

  /** 中央目錄結尾在檔案最後面，最多再往前 64KB（註解長度上限） */
  function findEOCD(view) {
    const max = Math.min(view.byteLength, 0xffff + 22);
    for (let back = 22; back <= max; back += 1) {
      const pos = view.byteLength - back;
      if (view.getUint32(pos, true) === SIG_EOCD) return pos;
    }
    return -1;
  }

  /** zip 沒標 UTF-8 時，中文檔名常常是 Big5 / GBK，試著救回來 */
  function decodeName(bytes, flags) {
    if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
    for (const encoding of ['utf-8', 'big5', 'gbk']) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch { /* 換下一個編碼試試 */ }
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function inflateRaw(chunk) {
    const stream = new Blob([chunk]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readCentralDirectory(view, bytes, eocd) {
    const entries = [];
    const total = view.getUint16(eocd + 10, true);
    const start = view.getUint32(eocd + 16, true);
    if (start === 0xffffffff) throw new Error('這包是 zip64，請改用 server 上傳');

    let pos = start;
    for (let i = 0; i < total; i += 1) {
      if (pos + 46 > view.byteLength || view.getUint32(pos, true) !== SIG_CENTRAL) break;
      const flags = view.getUint16(pos + 8, true);
      const method = view.getUint16(pos + 10, true);
      const compressed = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const local = view.getUint32(pos + 42, true);
      const name = decodeName(bytes.subarray(pos + 46, pos + 46 + nameLen), flags);
      pos += 46 + nameLen + extraLen + commentLen;

      if (name.endsWith('/')) continue;
      const base = name.split('/').pop();
      // macOS 壓縮時附的 __MACOSX/._foo 不是使用者要的東西
      if (name.startsWith('__MACOSX/') || base.startsWith('.') || !KEEP.test(base)) continue;
      entries.push({ name, base, method, compressed, local });
    }
    return entries;
  }

  /** 讀出 zip 裡的音檔 / 歌詞 / 圖片，回傳 [{ name, base, data }] */
  async function unzip(blob) {
    if (!supported()) throw new Error('這個瀏覽器不支援解壓縮，請改用 server 上傳');

    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    const eocd = findEOCD(view);
    if (eocd < 0) throw new Error('這不是有效的 zip 檔');

    const out = [];
    for (const entry of readCentralDirectory(view, bytes, eocd)) {
      const nameLen = view.getUint16(entry.local + 26, true);
      const extraLen = view.getUint16(entry.local + 28, true);
      const from = entry.local + 30 + nameLen + extraLen;
      const raw = bytes.subarray(from, from + entry.compressed);

      let data;
      if (entry.method === 0) data = raw;              // 沒壓縮，直接切
      else if (entry.method === 8) data = await inflateRaw(raw);
      else continue;                                    // 其它壓縮法（很罕見）跳過

      out.push({ name: entry.name, base: entry.base, data });
    }
    return out;
  }

  window.LyrisUnzip = { unzip, supported };
})();
