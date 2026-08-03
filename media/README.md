# 把歌放這裡

mp3 和 lrc 用**同一個檔名**，Lyris 就會自動配對：

```
media/
├── 告白氣球.mp3
├── 告白氣球.lrc
└── 告白氣球.jpg     ← 選用，沒有就讀 mp3 內嵌封面
```

子資料夾也會一起掃，可以照專輯分。

放好之後回上層執行：

```bash
python3 server.py --open
```

這個資料夾裡的音樂檔已經被 `.gitignore` 排除，不會被 commit 進去。
