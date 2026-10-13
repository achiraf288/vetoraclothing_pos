import { app, BrowserWindow, dialog, net, protocol, session, shell } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDatabase, DatabaseIntegrityError } from '../db/database-service';
import { MigrationError } from '../db/migrator';
import { ImageStore } from '../services/image-store';
import { Runtime } from '../services/runtime';
import { registerAllIpc } from './handlers';
import { createLogger, type Logger } from './logger';

const isDev = !app.isPackaged && process.env['MAISON_DEV'] === '1';
const DEV_URL = 'http://localhost:4200';
const APP_SCHEME = 'maison';
const RENDERER_DIR = path.join(__dirname, '..', '..', 'renderer', 'dist', 'maison-pos-ui', 'browser');

// Keep the existing database, backups and images in the original app-data
// folder across the Vetora POS rebrand.
app.setPath('userData', path.join(app.getPath('appData'), 'Maison POS'));

// Fully offline: stop Chromium from making background network requests
// (component updates, field trials, etc.). The app never loads remote content.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${APP_SCHEME}:`,
  "font-src 'self' data:",
  "connect-src 'self'" + (isDev ? ' ws://localhost:4200 http://localhost:4200' : ''),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function appOrigin(): string {
  return isDev ? DEV_URL : `${APP_SCHEME}://app`;
}

// Platform-appropriate locations, resolved at runtime (never hard-coded).
function dataPaths() {
  const userData = app.getPath('userData');
  return {
    dataDir: path.join(userData, 'data'),
    backupDir: path.join(userData, 'backups'),
    logDir: path.join(userData, 'logs'),
  };
}

let runtime: Runtime | null = null;
let backupTimer: NodeJS.Timeout | null = null;
let logger: Logger;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#F7F4EE',
    show: false,
    title: 'Vetora POS',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Restrict navigation and new-window creation.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appOrigin())) event.preventDefault();
  });

  void win.loadURL(`${appOrigin()}/`);
  return win;
}

function registerAppProtocol(images: ImageStore): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);

    // Product images live in app data, outside the bundle. Only names we generated are served.
    if (rel.startsWith('/product-images/')) {
      const file = images.resolve(rel.slice('/product-images/'.length));
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 });
    }
    if (isDev) return new Response('Not found', { status: 404 });

    if (rel === '/' || rel === '') rel = '/index.html';
    const resolved = path.normalize(path.join(RENDERER_DIR, rel));
    // Prevent path traversal out of the renderer bundle.
    if (!resolved.startsWith(RENDERER_DIR + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString()).catch(() =>
      // SPA fallback for client-side routes.
      net.fetch(pathToFileURL(path.join(RENDERER_DIR, 'index.html')).toString()),
    );
  });
}

function explainStartupFailure(err: unknown): string {
  if (err instanceof DatabaseIntegrityError) {
    return (
      'The database file failed its integrity check, so Vetora POS did not open it. ' +
      'Nothing was changed. Restore a recent backup from the backups folder, or contact support.\n\n' +
      `File: ${err.file}`
    );
  }
  if (err instanceof MigrationError) {
    return `${err.message}\n\nYour data has not been deleted.`;
  }
  return 'Vetora POS could not open its database. Your data has not been deleted. See the log file for details.';
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const { dataDir, backupDir, logDir } = dataPaths();
    logger = createLogger(logDir);
    logger.info('Starting Vetora POS', { version: app.getVersion(), platform: process.platform, arch: process.arch });

    try {
      const database = initDatabase(dataDir, backupDir);
      if (database.migration.applied.length) {
        logger.info('Database migrated', database.migration);
      }
      runtime = new Runtime(database, { dataDir, backupDir });
    } catch (err) {
      logger.error('Database startup failed', err instanceof Error ? err : String(err));
      dialog.showErrorBox('Vetora POS cannot start', explainStartupFailure(err));
      app.quit();
      return;
    }

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] },
      });
    });
    const images = new ImageStore(path.join(app.getPath('userData'), 'product-images'));
    registerAppProtocol(images);

    registerAllIpc({
      ctx: { logger, allowedOrigin: appOrigin },
      runtime,
      images,
      paths: { logDir, backupDir },
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Optional scheduled backups: checked at start and every 15 minutes.
    const tick = () => {
      try {
        const made = runtime?.backup.runScheduledIfDue();
        if (made) logger.info('Scheduled backup created', { name: made.name });
      } catch (err) {
        logger.error('Scheduled backup failed', err instanceof Error ? err : String(err));
      }
    };
    tick();
    backupTimer = setInterval(tick, 15 * 60_000);
  });

  app.on('before-quit', () => {
    if (backupTimer) clearInterval(backupTimer);
    runtime?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
