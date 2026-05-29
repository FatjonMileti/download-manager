# Download Manager

Cross-platform Electron desktop app for direct file downloads and YouTube video/playlist extraction.

---

## File Structure

```
package.json    — Dependencies + start script
main.js         — Main (Node) process: windows, IPC, downloads
preload.js      — Bridge: exposes safe APIs to the renderer
index.html      — Renderer: UI + Vanilla JS logic
```

---

## Architecture

```
  Renderer (index.html)            Main Process (main.js)
  ┌──────────────────────┐         ┌──────────────────────────────┐
  │                      │  IPC    │                              │
  │  electronAPI.        │ invoke  │  ipcMain.handle(             │
  │  startDownload(url)  │───────► │    'start-download', ...)    │
  │                      │         │                              │
  │  electronAPI.        │  send   │  sendProgress({ id,          │
  │  onDownloadProgress  │◄─────── │    percent, status, ...})    │
  │                      │         │                              │
  └──────────────────────┘         └──────────────────────────────┘
```

Security: `contextIsolation: true`, `nodeIntegration: false`. The renderer has zero access to Node.js APIs — all communication goes through the preload bridge.

---

## `package.json`

```json
{
  "main": "main.js",
  "scripts": { "start": "electron ." },
  "dependencies": {
    "@distube/ytdl-core": "^4.16.6",
    "fluent-ffmpeg": "^2.1.3"
  },
  "devDependencies": {
    "electron": "^34.3.0"
  }
}
```

`@distube/ytdl-core` and `fluent-ffmpeg` are declared as the YouTube/download pipeline per spec. However, YouTube's player script cipher changes broke `ytdl-core`'s decipher regex (see [issue #144](https://github.com/distubejs/ytdl-core/issues/144)). The actual YouTube pipeline uses **`yt-dlp`** (must be installed separately via `pip install yt-dlp`), which is actively maintained and handles YouTube's evolving API.

---

## `main.js` — Main Process

### Module imports & helpers

```js
const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
```

- `findFfmpeg()` — searches `$PATH` + common install paths for the ffmpeg binary; if found sets `fluent-ffmpeg`'s path via `setFfmpegPath()`.
- `findYtdlp()` — searches `$PATH` for `yt-dlp`; stores result in `ytdlpPath` for later use.

### Window creation (`createWindow`)

Standard Electron window with security-conscious `webPreferences`:

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
}
```

### URL classification

```js
isYouTubeUrl(url)   — checks hostname for youtube.com / youtu.be
isPlaylistUrl(url)  — checks for ?list= in query params
```

### Progress IPC (`sendProgress`)

All download progress is pushed from main → renderer via:

```js
mainWindow.webContents.send('download-progress', { id, percent, status, ... })
```

### Direct file downloads (`handleDirectDownload`)

1. Calls `session.defaultSession.downloadURL(url)` — Electron's native download initiation.
2. The `will-download` session event fires with a `DownloadItem`.
3. Inside the handler, a native **Save As…** dialog (`dialog.showSaveDialog`) lets the user pick the destination with the server-provided filename as default.
4. Tracks progress via `item.on('updated')` → reads `item.getReceivedBytes()` / `item.getTotalBytes()` → sends `{ percent, status: 'downloading' }`.
5. On completion: `item.on('done')` → sends `{ status: 'completed' }` or `{ status: 'failed', error }`.

```js
session.defaultSession.on('will-download', async (event, item) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: item.getFilename(),
    title: 'Save file as',
  });
  if (result.canceled) { item.cancel(); sendProgress(...); return; }
  item.setSavePath(result.filePath);
  // ... attach updated/done listeners
});
session.defaultSession.downloadURL(url);
```

### YouTube downloads (`handleYouTubeSingle`)

1. Opens a native folder picker (`dialog.showOpenDialog` with `openDirectory`).
2. Gets video title via `yt-dlp --print title <url>`.
3. Spawns `yt-dlp` with format selection and output path:
   ```
   yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best"
          --merge-output-format mp4 --newline
          -o "<folder>/<title>.mp4" <url>
   ```
4. The `--newline` flag makes yt-dlp print one progress line per update.
5. The `handleOutput` callback parses each line with `/(\d+\.?\d*)%/` to extract the percentage and sends it to the renderer.

### YouTube playlist downloads (`handleYouTubePlaylist`)

1. Same folder picker as single video.
2. Gets playlist title via `yt-dlp --print playlist_title --flat-playlist <url>`.
3. Output template: `folder/PlaylistName/%(title)s.%(ext)s`.
4. Progress parsing also looks for `[download] Downloading video X of Y` lines to display playlist tracking:
   ```js
   sendProgress({ id, percent, currentVideo, totalVideos, isPlaylist: true });
   ```
5. The renderer displays `Video 2 of 5 — 45%`.

### Central IPC handler

```js
ipcMain.handle('start-download', async (_event, url) => {
  const id = ++downloadIdCounter;
  if (isYouTubeUrl(url)) {
    // Folder picker → dispatch to handleYouTubeSingle / handleYouTubePlaylist
  } else {
    // handleDirectDownload (save dialog fires inside will-download)
  }
  return id;
});
```

---

## `preload.js` — Bridge

Uses `contextBridge` to safely expose two methods:

```js
contextBridge.exposeInMainWorld('electronAPI', {
  startDownload: (url) => ipcRenderer.invoke('start-download', url),
  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
});
```

- `startDownload(url)` — invokes the main process handler, returns a download `id`.
- `onDownloadProgress(callback)` — subscribes to progress events; returns a cleanup function.

Neither method gives the renderer access to Node.js modules, filesystem, or `child_process`.

---

## `index.html` — Renderer UI

### Structure

```
┌─ Header ──────────────────────────────────┐
│  Download Manager                          │
│  [ URL input                   ] [Download] │
├─ Dashboard ───────────────────────────────┤
│  ┌─ Card ──────────────────────────────┐  │
│  │  video_title.mp4                    │  │
│  │  Downloading: 45%                   │  │
│  │  ███████████░░░░░░░░░░  (progress)  │  │
│  └─────────────────────────────────────┘  │
│  ┌─ Card (playlist) ───────────────────┐  │
│  │  My Playlist                        │  │
│  │  Video 2 of 5 — 45%                │  │
│  │  ███████████░░░░░░░░░░  (progress)  │  │
│  └─────────────────────────────────────┘  │
│            Empty state (no downloads)     │
└──────────────────────────────────────────┘
```

### CSS

- Dark theme: `#1a1a2e` background, `#e94560` accent.
- Cards animate in with `slideIn` keyframes.
- Progress bar: custom `-webkit-appearance` styling; green on completion, red on failure.

### JavaScript

- `getCardEl(id)` — creates or retrieves a download card DOM node (title, status, progress). Uses a `Map` keyed by download ID.
- `updateCard(data)` — handles all status types:
  - `starting` → "Starting..." / "Preparing playlist..."
  - `downloading` → "Downloading: 45%" or "Video 2 of 5 — 45%"
  - `completed` → "Completed" / "Playlist downloaded"
  - `failed` → "Failed: <error message>"
- `startDownload(url)` — calls `electronAPI.startDownload()`, disables the button during the call.
- Keyboard: Enter key submits.

---

## Data Flow (end-to-end)

```
User pastes URL + clicks Download
  │
  ▼
index.html: startDownload(url)
  │
  ▼  (IPC invoke)
preload.js: ipcRenderer.invoke('start-download', url)
  │
  ▼
main.js: ipcMain.handle('start-download')
  │
  ├── YouTube URL?
  │   ├── Show folder picker dialog
  │   ├── Playlist? → handleYouTubePlaylist(id, url, folder)
  │   │               └── yt-dlp <args> --newline
  │   └── Single?   → handleYouTubeSingle(id, url, folder)
  │                   └── yt-dlp <args> --newline
  │
  └── Direct URL?
      └── handleDirectDownload(id, url)
          ├── session.downloadURL(url)
          └── will-download event
              ├── Show save dialog
              └── item.updated → sendProgress({percent})
                  item.done → sendProgress({status})
  │
  ▼  (IPC send, multiple times)
main.js: sendProgress({ id, percent, status, ... })
  │
  ▼
preload.js: ipcRenderer.on('download-progress')
  │
  ▼
index.html: updateCard(data)
  │
  ▼
DOM: card title, status text, <progress> value updated in real time
```

---

## Error Handling

| Scenario | Where | Behavior |
|---|---|---|
| `yt-dlp` not installed | `handleYouTubeSingle/Playlist` | `sendProgress({ status: 'failed', error: 'yt-dlp not found...' })` |
| `ffmpeg` not found | `findFfmpeg()` | Logged, but ffmpeg is not required (yt-dlp handles merging) |
| User cancels folder picker | `start-download` IPC handler | `sendProgress({ status: 'failed', error: 'Cancelled' })` |
| User cancels save dialog | `handleDirectDownload` | `item.cancel()`, `sendProgress({ status: 'failed', error: 'Download cancelled' })` |
| yt-dlp download fails | `runYtdlpDownload` | `sendProgress({ status: 'failed', error: 'yt-dlp failed (exit code X)' })` |
| Server returns error | `handleDirectDownload` `item.on('done')` | `sendProgress({ status: 'failed', error: 'Download failed: ...' })` |

---

## Prerequisites

- **Node.js** 18+
- **yt-dlp** — `pip install yt-dlp` (required for YouTube downloads)
- **ffmpeg** — optional, `yt-dlp` handles merging internally

## Running

```bash
npm install
npm start
```

If the SUID sandbox error appears (Linux), append `--no-sandbox`:

```bash
npx electron . --no-sandbox
```
