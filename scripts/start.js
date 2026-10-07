#!/usr/bin/env node
/**
 * Cross-platform launcher for OpenCluely.
 *
 * Replaces `env -u ELECTRON_RUN_AS_NODE electron .`, which only works in a
 * POSIX shell (PowerShell / cmd have no `env`). ELECTRON_RUN_AS_NODE is
 * stripped here instead: some terminals (VS Code, Electron-based shells)
 * export it, and it makes Electron start as plain Node and show nothing.
 *
 * Usage:
 *   node scripts/start.js [--detach] [electron args...]
 *
 *   --detach   start the app as an independent process and return at once,
 *              so the terminal can be closed without killing the app.
 *
 * Any other arguments are passed to Electron (e.g. --no-sandbox --disable-gpu).
 */
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const electron = require('electron'); // resolves to the binary path
const args = process.argv.slice(2);
const detach = args.includes('--detach');
const electronArgs = ['.', ...args.filter((a) => a !== '--detach')];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, electronArgs, {
  cwd: root,
  env,
  detached: detach,
  stdio: detach ? 'ignore' : 'inherit',
  windowsHide: false
});

if (detach) {
  child.unref();
  console.log(`OpenCluely started (pid ${child.pid}). You can close this terminal.`);
  process.exit(0);
}

child.on('exit', (code) => process.exit(code === null ? 1 : code));
child.on('error', (err) => {
  console.error('Failed to start Electron:', err.message);
  process.exit(1);
});
