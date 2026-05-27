const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SLCRICK_DESKTOP', true);
contextBridge.exposeInMainWorld('BACKEND_BASE_URL', '');

contextBridge.exposeInMainWorld('desktopAPI', {
  publishMatch(match) {
    ipcRenderer.send('desktop:match-update', match);
  },
  publishTournament(tournament) {
    ipcRenderer.send('desktop:tournament-update', tournament);
  },
  broadcastCommand(payload) {
    ipcRenderer.send('desktop:broadcast-command', payload);
  },
  onMatchUpdate(callback) {
    ipcRenderer.on('desktop:match-update', (_e, match) => callback(match));
  },
  onBroadcastCommand(callback) {
    ipcRenderer.on('desktop:broadcast-command', (_e, payload) => callback(payload));
  },
  onStorageRestored(callback) {
    ipcRenderer.on('desktop:storage-restored', (_e, data) => callback(data));
  },
  requestPersist() {
    ipcRenderer.send('desktop:persist-request');
  },
  getDataPath() {
    return ipcRenderer.invoke('desktop:get-data-path');
  },
  getBaseUrl() {
    return ipcRenderer.invoke('desktop:get-base-url');
  },
  openObsOverlay(opts) {
    return ipcRenderer.invoke('desktop:open-overlay', opts || {});
  },
  showObsGuide(opts) {
    return ipcRenderer.invoke('desktop:show-obs-guide', opts || {});
  },
  getObsOverlayUrl(opts) {
    return ipcRenderer.invoke('desktop:get-obs-url', opts || {});
  },
  getObsBrowserUrls(opts) {
    return ipcRenderer.invoke('desktop:get-obs-browser-urls', opts || {});
  },
  closeObsOverlay() {
    ipcRenderer.send('desktop:close-overlay');
  },
  openPopupScorecard(opts) {
    return ipcRenderer.invoke('desktop:open-popup-scorecard', opts || {});
  },
  openObsPopup(opts) {
    return ipcRenderer.invoke('desktop:open-obs-popup', opts || {});
  },
  closePopupScorecard() {
    return ipcRenderer.invoke('desktop:close-popup-scorecard');
  },
  closeObsPopup() {
    return ipcRenderer.invoke('desktop:close-obs-popup');
  },
  scoringCommand(payload) {
    return ipcRenderer.invoke('desktop:scoring-command', payload || {});
  },
  getLiveMatchId() {
    return ipcRenderer.invoke('desktop:get-live-match-id');
  },
  notifySyncSettings(cfg) {
    ipcRenderer.send('desktop:sync-settings', cfg || {});
  },
  wakeBackend(backendUrl) {
    return ipcRenderer.invoke('desktop:wake-backend', backendUrl);
  },
  getStorageFolder() {
    return ipcRenderer.invoke('desktop:get-storage-folder');
  },
  saveMatchFile(match) {
    return ipcRenderer.invoke('desktop:save-match-file', match);
  },
  saveTournamentFile(tourn) {
    return ipcRenderer.invoke('desktop:save-tournament-file', tourn);
  },
  deleteMatchFile(id) {
    return ipcRenderer.invoke('desktop:delete-match-file', id);
  },
  purgeAllMatchFiles() {
    return ipcRenderer.invoke('desktop:purge-all-match-files');
  },
  scheduleTournament(cfg) {
    return ipcRenderer.invoke('desktop:schedule-tournament', cfg);
  },
  reloadStorage() {
    return ipcRenderer.invoke('desktop:reload-storage');
  },
  toggleDevTools() {
    return ipcRenderer.invoke('desktop:toggle-devtools');
  },
  openDevTools() {
    return ipcRenderer.invoke('desktop:open-devtools');
  },
});
