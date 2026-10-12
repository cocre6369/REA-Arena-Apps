// Chroma Studio — Electron main process.
// Serves the renderer from a loopback HTTP server so that ES modules load
// normally (file:// blocks module scripts), and provides real file dialogs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(root) {
  return http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(root, url === '/' ? 'index.html' : url);
    if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

let mainWindow = null;
let port = 0;

/** The file the user double-clicked (Windows passes it as argv[1]). */
function openedFile() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const f = args.find((a) => !a.startsWith('-') && /\.(csp|psd|png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(a));
  return f && fs.existsSync(f) ? f : null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#14171c',
    icon: path.join(HERE, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    title: 'Chroma Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(HERE, 'preload.cjs'),
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    const f = openedFile();
    if (f) mainWindow.webContents.send('open-file', f);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const tpl = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => pickAndOpen() },
        { type: 'separator' },
        { role: 'close' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Chroma Studio',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About Chroma Studio',
            message: 'Chroma Studio',
            detail: 'An independent image editor. Original code, original interface.\nNot affiliated with any other image editing product.',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

async function pickAndOpen() {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'All supported', extensions: ['csp', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'] },
      { name: 'Chroma Studio project', extensions: ['csp'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'] },
    ],
  });
  if (!r.canceled && r.filePaths[0]) mainWindow?.webContents.send('open-file', r.filePaths[0]);
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('save-buffer', async (_e, { data, defaultPath, filters }) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath, filters });
  if (r.canceled || !r.filePath) return null;
  const buf = Buffer.from(data);
  await fs.promises.writeFile(r.filePath, buf);
  return r.filePath;
});

ipcMain.handle('read-file', async (_e, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  return buf.toString('base64');
});

ipcMain.handle('pick-open', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------- lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const f = argv.find((a) => !a.startsWith('-') && /\.(csp|psd|png|jpe?g|webp|gif|bmp)$/i.test(a));
      if (f && fs.existsSync(f)) mainWindow.webContents.send('open-file', f);
    }
  });

  app.whenReady().then(async () => {
    const server = serveStatic(ROOT);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
