/* A background Electron process. Control stays on Playwright's private pipe. */
const { app, BrowserWindow, session } = require("electron");
const { resolve } = require("node:path");
const [profileDirectory, parentPid] = process.argv.slice(-2);
if (!profileDirectory || !/^\d+$/.test(parentPid ?? "")) throw new Error("Companion requires a profile directory and owning swarm PID");
app.setPath("userData", resolve(profileDirectory));
app.setPath("sessionData", resolve(profileDirectory));
app.setPath("crashDumps", resolve(profileDirectory, "crashes"));
app.setName("perf-SWARM Browser");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.on("window-all-closed", () => {}); // Empty means idle, not a request to terminate.
app.whenReady().then(() => { app.dock?.hide(); });
const windows = new Map();
const configuredSessions = new Set();
const options = (partition) => ({
  show: false, focusable: false, width: 1440, height: 900, useContentSize: true,
  webPreferences: { partition, offscreen: true, backgroundThrottling: false,
    disableDialogs: true, sandbox: true, nodeIntegration: false, contextIsolation: true },
});
global.perfSwarmBrowserHost = {
  create(key, partition) {
    const browserSession = session.fromPartition(partition);
    if (!configuredSessions.has(partition)) {
      browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on("will-download", event => event.preventDefault());
      configuredSessions.add(partition);
    }
    const window = new BrowserWindow(options(partition));
    windows.set(key, window);
    window.webContents.setFrameRate(30);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault(); });
    window.on("closed", () => windows.delete(key));
    void window.loadURL("about:blank");
    return window.webContents.id;
  },
  resize(key, width, height) { const w = windows.get(key); if (!w) throw new Error("Unknown browser tab"); w.setContentSize(width, height); },
  close(key) { windows.get(key)?.destroy(); },
  status() { return { windows: [...windows].map(([key, w]) => ({ key, visible: w.isVisible(), focused: w.isFocused(), offscreen: w.webContents.isOffscreen(), backgroundThrottling: w.webContents.getBackgroundThrottling() })), dockVisible: app.dock?.isVisible() ?? false }; },
};
// Quit after the owning swarm dies, including a hard kill that skips cleanup.
const watchdog = setInterval(() => {
  try { process.kill(Number(parentPid), 0); } catch { app.quit(); }
}, 1500);
watchdog.unref();
