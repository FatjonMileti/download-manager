const { app, BrowserWindow, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function sanitizeName(name) {
  return name
    .split('\n')[0]
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .substring(0, 100)
    .trim() || 'download';
}

function findFfmpeg() {
  const { execSync } = require('child_process');
  try {
    const result = execSync('which ffmpeg', { encoding: 'utf8' });
    return result.trim();
  } catch {}
  const commonPaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findYtdlp() {
  const { execSync } = require('child_process');
  try {
    const result = execSync('which yt-dlp', { encoding: 'utf8' });
    return result.trim();
  } catch {}
  return null;
}

const ffmpegPath = findFfmpeg();
if (ffmpegPath) {
  require('fluent-ffmpeg').setFfmpegPath(ffmpegPath);
}

const ytdlpPath = findYtdlp();

function findVlc() {
  const { execSync } = require('child_process');
  try {
    const result = execSync('which vlc', { encoding: 'utf8' });
    return result.trim();
  } catch {}
  const commonPaths = ['/usr/bin/vlc', '/snap/bin/vlc', '/usr/local/bin/vlc'];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const vlcPath = findVlc();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let downloadIdCounter = 0;

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /youtube\.com|youtu\.be/.test(u.hostname);
  } catch {
    return false;
  }
}

function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has('list');
  } catch {
    return false;
  }
}

function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', data);
  }
}

function spawnYtdlp(args) {
  const { spawn } = require('child_process');
  return spawn(ytdlpPath, args);
}

async function getYtdlpOutput(args) {
  return new Promise((resolve, reject) => {
    const p = spawnYtdlp(args);
    let out = '';
    let errOut = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { errOut += d; });
    p.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(errOut.trim() || `yt-dlp exited with code ${code}`));
    });
    p.on('error', reject);
  });
}

function runYtdlpDownload(id, args, isPlaylist, filePath) {
  const proc = spawnYtdlp(args);
  let lastPercent = 0;
  let currentVideo = 0;
  let totalVideos = 0;
  let errorOutput = '';

  const handleOutput = (data) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      const playlistMatch = line.match(/\[download\] Downloading video (\d+) of (\d+)/);
      if (playlistMatch) {
        currentVideo = parseInt(playlistMatch[1]);
        totalVideos = parseInt(playlistMatch[2]);
        sendProgress({
          id, percent: 0, status: 'downloading',
          currentVideo, totalVideos,
        });
        continue;
      }

      const m = line.match(/(\d+\.?\d*)%/);
      if (m) {
        const pct = Math.min(Math.round(parseFloat(m[1])), 100);
        if (pct !== lastPercent) {
          lastPercent = pct;
          const data = { id, percent: pct, status: 'downloading' };
          if (isPlaylist && totalVideos > 0) {
            data.currentVideo = currentVideo;
            data.totalVideos = totalVideos;
          }
          sendProgress(data);
        }
      }
    }
  };

  proc.stdout.on('data', handleOutput);
  proc.stderr.on('data', (data) => {
    errorOutput += data.toString();
    handleOutput(data);
  });

  proc.on('error', (err) => {
    sendProgress({ id, status: 'failed', error: err.message });
  });

  proc.on('close', (code) => {
    if (code === 0) {
      const data = { id, percent: 100, status: 'completed' };
      if (filePath) data.filePath = filePath;
      sendProgress(data);
    } else {
      const errMsg = errorOutput
        .split('\n')
        .filter(l => /ERROR:/i.test(l))
        .map(l => l.replace(/^.*?(ERROR:\s*)/i, ''))
        .join('; ')
        .trim() || `yt-dlp failed (exit code ${code})`;
      sendProgress({ id, status: 'failed', error: errMsg });
    }
  });
}

async function handleYouTubeSingle(id, url, folder) {
  try {
    const title = await getYtdlpOutput(['--print', 'title', '--no-warnings', url]);
    const safeName = sanitizeName(title);
    const outputPath = path.join(folder, `${safeName}.mp4`);
    sendProgress({ id, fileName: `${safeName}.mp4`, status: 'starting' });

    runYtdlpDownload(id, [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--newline', '--no-warnings',
      '--ignore-errors',
      '-o', outputPath, url,
    ], false, outputPath);
  } catch (err) {
    sendProgress({ id, status: 'failed', error: err.message });
  }
}

async function handleYouTubePlaylist(id, url, folder) {
  try {
    const playlistTitle = await getYtdlpOutput([
      '--print', 'playlist_title', '--no-warnings', url,
    ]);
    const safeName = sanitizeName(playlistTitle);
    sendProgress({ id, fileName: safeName, status: 'starting', isPlaylist: true });

    runYtdlpDownload(id, [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--newline', '--no-warnings',
      '--ignore-errors',
      '-o', path.join(folder, `${safeName}/%(title)s.%(ext)s`),
      url,
    ], true);
  } catch (err) {
    sendProgress({ id, status: 'failed', error: err.message });
  }
}

function handleDirectDownload(id, url) {
  const handler = async (event, item) => {
    session.defaultSession.removeListener('will-download', handler);

    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: item.getFilename(),
      title: 'Save file as',
    });

    if (result.canceled) {
      item.cancel();
      sendProgress({ id, status: 'failed', error: 'Download cancelled' });
      return;
    }

    item.setSavePath(result.filePath);
    const fileName = path.basename(result.filePath);
    sendProgress({ id, fileName, status: 'starting' });

    item.on('updated', (_event, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const percent = total > 0 ? Math.min(Math.round((received / total) * 100), 100) : 0;
        sendProgress({ id, percent, status: 'downloading' });
      }
    });

    item.on('done', (_event, state) => {
      if (state === 'completed') {
        sendProgress({ id, percent: 100, status: 'completed', filePath: result.filePath });
      } else {
        sendProgress({ id, status: 'failed', error: `Download failed: ${state}` });
      }
    });
  };

  session.defaultSession.on('will-download', handler);
  session.defaultSession.downloadURL(url);
}

ipcMain.handle('start-download', async (_event, url) => {
  const id = ++downloadIdCounter;

  if (isYouTubeUrl(url)) {
    if (!ytdlpPath) {
      sendProgress({ id, status: 'failed', error: 'yt-dlp not found. Install it: pip install yt-dlp' });
      return id;
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select destination folder',
    });

    if (result.canceled) {
      sendProgress({ id, status: 'failed', error: 'Cancelled — no folder selected' });
      return id;
    }

    if (isPlaylistUrl(url)) {
      handleYouTubePlaylist(id, url, result.filePaths[0]);
    } else {
      handleYouTubeSingle(id, url, result.filePaths[0]);
    }
  } else {
    handleDirectDownload(id, url);
  }

  return id;
});

ipcMain.handle('open-with-vlc', async (_event, filePath) => {
  if (!vlcPath) return { error: 'VLC not found. Install it: sudo apt install vlc' };
  try {
    const { spawn } = require('child_process');
    spawn(vlcPath, [filePath], { detached: true, stdio: 'ignore' }).unref();
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});
