const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const { initMain } = require('electron-audio-loopback');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT } = require('./src/stt');
const { createLLM } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { VAD } = require('./src/vad');
const { buildContext, buildSystem, buildUserTurn } = require('./src/context');
const { createMeetingStore } = require('./src/meetings');
const { resolveShortcuts, findConflicts, isValid } = require('./src/shortcuts');
const { buildNotesPrompt, parseNotes } = require('./src/notes');

const isMac = process.platform === 'darwin';

let win = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
let passthrough = false; // Ctrl+Shift+I toggle for Windows click-through
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts }
const FLUSH_MS = 1200;       // low floor: VAD should fire way before this
const MIN_BYTES = Math.floor(16000 * 2 * 0.4); // ~0.4s
const RMS_GATE = 240;
const vads = { you: new VAD(), them: new VAD() };
let flushTimer = null;

// -------- meeting history --------
const MEETINGS_FILE = path.join(app.getPath('userData'), 'cue-meetings.json');
const meetingsStore = createMeetingStore({ file: MEETINGS_FILE });
let activeMeeting = null; // id while capturing

function send(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }

// -------- window --------
function createWindow() {
  const saved = store.getSettings().windowState;
  const { workArea } = screen.getPrimaryDisplay();
  const W = 700, H = 600;
  const bounds = sanitizeBounds(saved, workArea, W, H);

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // Invisibility + overlay behavior. Set CUE_NO_PROTECT=1 to disable for debugging.
  if (isMac) win.setContentProtection(!process.env.CUE_NO_PROTECT); // excluded from screen capture (best-effort, macOS only)
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => win.showInactive());
  win.webContents.on('render-process-gone', (_e, d) => console.log('[cue] renderer gone', JSON.stringify(d)));

  const savePos = () => {
    try {
      if (!win || win.isDestroyed()) return;
      store.setSettings({ windowState: win.getBounds() });
    } catch (e) { /* ignore */ }
  };
  win.on('moved', savePos);
  win.on('resized', savePos);
}

// Keep a restored window inside a display's work area (handles unplugged monitors).
function sanitizeBounds(saved, workArea, defW, defH) {
  const w = saved ? saved.width : defW;
  const h = saved ? saved.height : defH;
  if (!saved) {
    return { width: w, height: h, x: Math.round(workArea.x + (workArea.width - w) / 2), y: workArea.y + 6 };
  }
  // Clamp so at least ~80px of the window stays on a work area.
  const x = clamp(saved.x, workArea.x - w + 80, workArea.x + workArea.width - 80);
  const y = clamp(saved.y, workArea.y, workArea.y + workArea.height - 40);
  return { width: w, height: h, x, y };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// -------- STT flushing --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim()) {
      const text = res.text.trim();
      if (text.length < 2 && /^[.!?., ]+$/.test(text)) return; // junk fragment
      const turn = { channel, text, ts: Date.now() };
      transcript.push(turn);
      recordTurn(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found';
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

// VAD-triggered immediate flush: when VAD reports a finished utterance, send it now.
function feedPcm(channel, buf) {
  if (!state.capturing || !buf || !buf.length) return;
  buffers[channel].push(buf);
  const evs = vads[channel].push(buf);
  for (const ev of evs) flushChannel(channel);
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushChannel('you'); flushChannel('them'); }, FLUSH_MS);
}
function stopFlushLoop() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  for (const ch of ['you', 'them']) { const evs = vads[ch].flush(); for (const e of evs) flushChannel(ch); }
}

// -------- capture toggle --------
function setCapturing(active) {
  state.capturing = active;
  if (active) {
    if (!activeMeeting) activeMeeting = startMeeting();
    startFlushLoop();
  } else {
    stopFlushLoop();
    buffers.you = []; buffers.them = [];
    finishMeeting();
    activeMeeting = null;
  }
  send('capture:state', { active });
  return active;
}

// -------- meeting lifecycle (history/memory) --------
function startMeeting() {
  const m = meetingsStore.add();
  // Dry-run title guess is filled at finish; nothing else needed.
  return m.id;
}

function recordTurn(turn) {
  if (!activeMeeting) return;
  meetingsStore.addTurn(activeMeeting, turn);
}

function finishMeeting() {
  if (!activeMeeting) return;
  const m = meetingsStore.get(activeMeeting);
  if (m) {
    const when = new Date(m.startedAt).toLocaleString();
    meetingsStore.update(activeMeeting, { endedAt: Date.now(), title: m.title || 'Meeting ' + when });
  }
  const id = activeMeeting;
  activeMeeting = null;
  generateMeetingNotes(id); // async best-effort; caller doesn't wait
}

// Best-effort auto-notes at meeting end (per the product spec: a finished
// meeting gets a Summary / Key Points / Decisions / Action Items / Follow-Up).
// Never throws; failures are just logged.
async function generateMeetingNotes(id) {
  try {
    const meeting = meetingsStore.get(id);
    if (!meeting || !(meeting.transcript || []).length) return;
    const settings = store.getSettings();
    const llm = createLLM(settings);
    if (!llm.ready) return;
    let full = '';
    await llm.stream({
      system: 'You are a precise meeting-note assistant. Write the five headings requested, no extra prose.',
      turns: [{ role: 'user', text: buildNotesPrompt(meeting.transcript) }],
      maxTokens: 800,
      onToken: (t) => { full += t; }
    });
    const notes = parseNotes(full);
    meetingsStore.update(id, { summary: notes.summary, actionItems: notes.actionItems, followUp: notes.followUp, keyPoints: notes.keyPoints, decisions: notes.decisions });
  } catch (e) {
    console.log('[notes] generation failed', e && e.message);
  }
}

// -------- passthrough toggle (Windows click-through workaround) --------
function togglePassthrough() {
  passthrough = !passthrough;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(passthrough, { forward: true });
    send('passthrough:state', { active: passthrough });
    send('status', { message: passthrough ? 'Passthrough ON — clicks pass through cue' : 'Passthrough OFF — cue captures clicks' });
  }
  return passthrough;
}

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const mem = meetingsStore.recentSummaries(3);
    const ctx = buildContext({ transcript, userText: userText || '', settings, memory: mem });
    const system = buildSystem({ ...def, key: mode }, ctx);
    const built = buildUserTurn({ ...def, key: mode }, ctx);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    send('llm:start', { userBubble, small: !!def.small });

    if (!llm.ready) {
      send('llm:error', { message: 'Add your OpenCode Zen API key in Settings to start. Free models at opencode.ai/zen.' });
      return;
    }

    let imageDataUrl = null;
    if (def.needsScreen) {
      try { imageDataUrl = await captureScreenshot(); }
      catch (e) {
        const msg = isMac
          ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
          : 'Screen capture failed — check that cue has screen capture permission.';
        send('status', { message: msg });
      }
    }

    await llm.stream({
      system,
      turns: [{ role: 'user', text: built }],
      imageDataUrl,
      maxTokens: settings.smart ? 1400 : 700,
      onToken: (t) => send('llm:token', { text: t })
    });
    send('llm:done', {});
  } catch (e) {
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) });
  } finally {
    state.busy = false;
  }
}

// -------- IPC --------
ipcMain.handle('platform', () => process.platform);
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { sttDisabled = false; return store.setSettings(patch); });
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing));
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('passthrough:toggle', togglePassthrough);
ipcMain.handle('passthrough:state', () => ({ active: passthrough }));

// Meeting history IPC
ipcMain.handle('meetings:list', () => meetingsStore.all().reverse());
ipcMain.handle('meetings:get', (_e, id) => meetingsStore.get(id));
ipcMain.handle('meetings:search', (_e, q) => meetingsStore.search(String(q || '')));
ipcMain.handle('meetings:update', (_e, id, patch) => meetingsStore.update(id, patch));
ipcMain.handle('meetings:remove', (_e, id) => meetingsStore.remove(id));

// Generate structured notes (summary / key points / decisions / action items /
// follow-up) for a finished meeting and persist them into its record.
ipcMain.handle('meetings:notes', async (_e, id) => {
  const meeting = meetingsStore.get(id);
  if (!meeting) return { ok: false, error: 'Meeting not found.' };
  const turns = meeting.transcript || [];
  if (!turns.length) return { ok: false, error: 'No transcript to summarize for this meeting.' };

  const settings = store.getSettings();
  const llm = createLLM(settings);
  if (!llm.ready) return { ok: false, error: 'Add your OpenCode Zen API key in Settings to generate notes.' };

  try {
    let full = '';
    await llm.stream({
      system: 'You are a precise meeting-notes assistant. Output exactly the five headings requested, no extra prose.',
      turns: [{ role: 'user', text: buildNotesPrompt(turns) }],
      maxTokens: 800,
      onToken: (t) => { full += t; }
    });
    const notes = parseNotes(full);
    meetingsStore.update(id, { summary: notes.summary, actionItems: notes.actionItems, followUp: notes.followUp, keyPoints: notes.keyPoints, decisions: notes.decisions });
    return { ok: true, meeting: meetingsStore.get(id) };
  } catch (e) {
    return { ok: false, error: 'Notes generation failed: ' + ((e && e.message) || String(e)) };
  }
});

ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
ipcMain.on('mic:pcm', (_e, arrayBuffer) => feedPcm('you', Buffer.from(arrayBuffer)));
ipcMain.on('system:pcm', (_e, arrayBuffer) => feedPcm('them', Buffer.from(arrayBuffer)));
ipcMain.on('mouse:ignore', (_e, v) => { if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); });
ipcMain.on('open-pane', (_e, url) => {
  if (url.startsWith('x-apple:') && !isMac) return; // skip macOS-only URLs on Windows
  shell.openExternal(url).catch(() => {});
});
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));

// -------- shortcuts --------
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const settings = store.getSettings();
  const map = resolveShortcuts(settings.shortcutOverrides || {});

  const conflicts = findConflicts(map);
  for (const [a, b, accel] of conflicts) {
    send('status', { message: 'Shortcut conflict: ' + a + ' and ' + b + ' both use ' + accel + '. Open Settings → Shortcuts to fix.' });
  }

  const actions = {
    assist: () => runFeature('assist', ''),
    leetcode: () => runFeature('leetcode', ''),
    quit: () => app.quit(),
    hide: () => send('hide:toggle'),
    listening: () => setCapturing(!state.capturing),
    passthrough: () => togglePassthrough(),
    screen: () => runFeature('ask', '')
  };
  for (const [action, accel] of Object.entries(map)) {
    const fn = actions[action];
    if (!fn || !isValid(accel)) continue;
    if (!isMac && (accel.startsWith('Cmd') || accel.startsWith('Command'))) continue; // Cmd-only on Windows
    try { globalShortcut.register(accel, fn); }
    catch (e) { console.log('[shortcut] failed to register', action, accel, e.message); }
  }
}

// -------- lifecycle --------
initMain();
app.whenReady().then(() => {
  if (isMac && app.dock) app.dock.hide();

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: macOS uses the built-in loopback API.
  // Windows uses electron-audio-loopback (initMain above) which patches the handler.
  if (isMac) {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources.length) callback({ video: sources[0], audio: 'loopback' });
        else callback();
      }).catch(() => callback());
    }, { useSystemPicker: false });
  }

  createWindow();
  registerShortcuts();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Re-register shortcuts after shortcut settings change (see preload/renderer).
ipcMain.on('settings:changed', () => registerShortcuts());

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());