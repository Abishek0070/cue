/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const $ = (s) => document.querySelector(s);

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#history-btn').innerHTML = icon('history', { size: 15 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
  let isMac = true;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function scrollBottom() { messages.scrollTop = messages.scrollHeight; }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
    scrollBottom();
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
    scrollBottom();
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
    scrollBottom();
  }

  function finalizeAi() {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && !e.shiftKey && !mod) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && mod) { e.preventDefault(); runMode('assist', ''); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await cue.settingsSet({ smart: settings.smart });
  });

  // Hide / collapse
  function toggleHide() {
    const collapsed = $('#panel').classList.toggle('collapsed');
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) startSystemAudio();
    cue.captureToggle();
  });

  // ---- capture: mic + system audio (shared plumbing) --------------------
  // Prefer AudioWorklet (off-main-thread, no UI jank); fall back to the
  // deprecated ScriptProcessor where AudioWorklet isn't available.
  const F32_TO = (f) => {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out.buffer;
  };

  // Starts capture for one input source. callbacks.send(buffer) forwards PCM.
  async function attachCapture(ctx, sourceNode, sendPcm) {
    let disp = null;
    try {
      if (ctx.audioWorklet) {
        await ctx.audioWorklet.addModule('pcm-worklet.js');
        const node = new AudioWorkletNode(ctx, 'cue-pcm-processor');
        node.port.onmessage = (e) => { if (e.data && e.data.byteLength) sendPcm(e.data); };
        sourceNode.connect(node);
        node.connect(ctx.destination);
        disp = { kind: 'worklet', node, stop: () => { try { node.disconnect(); } catch (e) {} } };
      }
    } catch (e) { disp = null; }
    if (!disp) {
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      const sink = ctx.createGain(); sink.gain.value = 0;
      sp.onaudioprocess = (e) => {
        sendPcm(F32_TO(e.inputBuffer.getChannelData(0)));
      };
      sourceNode.connect(sp); sp.connect(sink); sink.connect(ctx.destination);
      disp = { kind: 'script', node: sp, stop: () => { try { sp.disconnect(); sink.disconnect(); } catch (e) {} } };
    }
    return disp;
  }

  let micCtx = null, micStream = null, micCapture = null;
  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      micCtx = new AudioContext({ sampleRate: 16000 });
      micCapture = await attachCapture(micCtx, micCtx.createMediaStreamSource(micStream), (buf) => cue.micPcm(buf));
    } catch (err) {
      cue.log('mic error: ' + (err && err.message));
    }
  }
  function stopMic() {
    if (micCapture) { micCapture.stop(); micCapture = null; }
    if (micCtx) { micCtx.close(); micCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  let sysStream = null, sysCtx = null, sysCapture = null;
  async function startSystemAudio() {
    if (sysStream) return;
    try {
      if (!isMac) await cue.enableLoopbackAudio();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) { cue.log('system audio: no loopback track (unsupported here)'); stream.getTracks().forEach((t) => t.stop()); return; }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });
      sysCapture = await attachCapture(sysCtx, sysCtx.createMediaStreamSource(new MediaStream(tracks)), (buf) => cue.systemPcm(buf));
      cue.log('system audio: capturing loopback');
    } catch (err) {
      cue.log('system audio error: ' + (err && err.message));
    } finally {
      if (!isMac) cue.disableLoopbackAudio();
    }
  }
  function stopSystemAudio() {
    if (sysCapture) { sysCapture.stop(); sysCapture = null; }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- passthrough:state -------------------------------------------------
  cue.on('passthrough:state', ({ active }) => {
    document.getElementById('toolbar').classList.toggle('passthrough', active);
    $('#stop-btn').classList.toggle('passthrough', active);
  });

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active }) => {
    $('#live-dot').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    if (active) { startMic(); startSystemAudio(); } else { stopMic(); stopSystemAudio(); }
  });
  cue.on('llm:start', ({ userBubble, small }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => { cue.log('[status] ' + message); showStatus(message); });
  cue.on('transcript', (turn) => appendTranscript(turn));

  // Grow a running transcript strip above the action row so the user sees
  // what the assistant is hearing (and so "what's been said" makes sense).
  function appendTranscript(turn) {
    let strip = document.getElementById('live-transcript');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'live-transcript';
      const panel = document.getElementById('panel');
      panel.insertBefore(strip, document.getElementById('action-row'));
    }
    const who = turn.channel === 'them' ? 'Them' : 'You';
    const line = document.createElement('div');
    line.className = 'lt-line';
    line.innerHTML = '<span class="lt-who">' + who + '</span> ' + esc(turn.text);
    strip.appendChild(line);
    while (strip.children.length > 6) strip.removeChild(strip.firstChild);
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); }
  function closeSettings() { saveSettings(); scrim.classList.add('hidden'); }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    $('#key-zen').value = settings.apiKeys.zen || '';
    $('#s-context').value = settings.context || '';
    const sc = settings.shortcutOverrides || {};
    $('#sc-assist').value = sc.assist || 'CommandOrControl+Return';
    $('#sc-leetcode').value = sc.leetcode || 'CommandOrControl+H';
    $('#sc-listening').value = sc.listening || 'CommandOrControl+Shift+L';
    $('#sc-passthrough').value = sc.passthrough || 'CommandOrControl+Shift+I';
    $('#s-status').textContent = statusText();
  }
  function statusText() {
    const k = settings.apiKeys;
    const stt = k.openai ? 'Whisper' : (k.gemini ? 'Gemini' : 'none');
    return (k.zen ? 'Zen key set' : 'No API key') + ' · 6-model fallback chain · transcription: ' + stt;
  }
  async function saveSettings() {
    settings.apiKeys.zen = $('#key-zen').value.trim();
    settings.context = $('#s-context').value.trim();
    const sc = {
      assist: $('#sc-assist').value.trim() || 'CommandOrControl+Return',
      leetcode: $('#sc-leetcode').value.trim() || 'CommandOrControl+H',
      listening: $('#sc-listening').value.trim() || 'CommandOrControl+Shift+L',
      passthrough: $('#sc-passthrough').value.trim() || 'CommandOrControl+Shift+I'
    };
    settings.shortcutOverrides = sc;
    await cue.settingsSet(settings);
    cue.shortcutsChanged();
  }

  $('#s-ctx-import').addEventListener('click', () => $('#s-ctx-file').click());
  $('#s-ctx-file').addEventListener('change', () => {
    const file = $('#s-ctx-file').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#s-context').value = reader.result; };
    reader.readAsText(file);
    $('#s-ctx-file').value = ''; // allow re-import of the same file
  });
  $('#s-ctx-clear').addEventListener('click', () => { $('#s-context').value = ''; });

  // ---- meeting history panel ---------------------------------------------
  const hScrim = $('#history-scrim');
  function openHistory() { renderHistoryList(); hScrim.classList.remove('hidden'); }
  function closeHistory() { hScrim.classList.add('hidden'); }
  $('#history-btn').addEventListener('click', openHistory);
  $('#h-close').addEventListener('click', closeHistory);
  hScrim.addEventListener('click', (e) => { if (e.target === hScrim) closeHistory(); });

  let hDetailId = null;
  async function renderHistoryList() {
    const q = $('#h-search').value.trim();
    const list = q ? await cue.meetingsSearch(q) : await cue.meetingsList();
    $('#h-detail').classList.add('hidden');
    hDetailId = null;
    const el = $('#h-list');
    el.innerHTML = '';
    if (!list.length) {
      el.innerHTML = '<div class="h-empty">No meetings yet. Start listening (▢) and cue records them here.</div>';
      return;
    }
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'h-row' + (hDetailId === m.id ? ' on' : '');
      row.innerHTML = '<div class="h-row-title"></div><div class="h-row-sub"></div>';
      row.querySelector('.h-row-title').textContent = m.title || 'Meeting';
      const when = m.endedAt || m.startedAt;
      const tCount = m.transcript ? m.transcript.length : 0;
      row.querySelector('.h-row-sub').textContent = new Date(when).toLocaleString() + ' · ' + tCount + ' lines';
      row.addEventListener('click', () => { hDetailId = m.id; renderHistoryList(); showDetail(m); });
      el.appendChild(row);
    }
  }

  function showDetail(m) {
    $('#h-detail').classList.remove('hidden');
    $('#h-title').textContent = m.title || 'Untitled meeting';
    $('#h-sub').textContent = new Date(m.startedAt).toLocaleString();
    const fmt = (label, arr) => {
      if (!arr || !arr.length) return '';
      const items = arr.map((t) => (t.channel === 'them' ? '<b>Them:</b> ' : '<b>You:</b> ') + esc(t.text)).join('<br>');
      return '<div class="h-sec-label">' + label + '</div>' + items;
    };
    const bullets = (label, arr) => {
      if (!arr || !arr.length) return '';
      return '<div class="h-sec-label">' + label + '</div>' + '<div class="h-bullets">' + arr.map(esc).join('<br>') + '</div>';
    };
    $('#h-summary').innerHTML = m.summary ? '<div class="h-sec-label">Summary</div>' + esc(m.summary) : '';
    $('#h-keypoints').innerHTML = bullets('Key points', m.keyPoints);
    $('#h-decisions').innerHTML = bullets('Decisions', m.decisions);
    $('#h-actions').innerHTML = bullets('Action items', m.actionItems);
    $('#h-followup').innerHTML = m.followUp ? '<div class="h-sec-label">Follow-up</div>' + esc(m.followUp) : '';
    $('#h-transcript').innerHTML = fmt('Transcript', m.transcript);
    $('#h-copy').disabled = !(m.summary || (m.actionItems && m.actionItems.length));
    lastShownMeeting = m;
  }

  async function generateShownNotes() {
    if (!hDetailId) return;
    const btn = $('#h-notes');
    btn.disabled = true;
    try {
      const res = await cue.meetingsNotes(hDetailId);
      if (res.ok) showDetail(res.meeting);
      else showStatus([res.error, 'Open Settings and add your Zen key to generate notes.'].join(' '));
    } finally {
      btn.disabled = false;
    }
  }
  $('#h-notes').addEventListener('click', generateShownNotes);
  $('#h-copy').addEventListener('click', () => {
    const m = lastShownMeeting;
    if (!m) return;
    const parts = [
      m.summary ? 'Summary:\n' + m.summary : '',
      m.keyPoints && m.keyPoints.length ? '\nKey points:\n' + m.keyPoints.map((x) => '- ' + x).join('\n') : '',
      m.decisions && m.decisions.length ? '\nDecisions:\n' + m.decisions.map((x) => '- ' + x).join('\n') : '',
      m.actionItems && m.actionItems.length ? '\nAction items:\n' + m.actionItems.map((x) => '- ' + x).join('\n') : '',
      m.followUp ? '\nFollow-up:\n' + m.followUp : ''
    ].filter(Boolean).join('\n\n');
    if (!parts) return;
    navigator.clipboard.writeText(parts).then(() => showStatus('Notes copied to clipboard.'));
  });
  let lastShownMeeting = null;

  $('#h-search').addEventListener('input', () => renderHistoryList());
  $('#h-delete').addEventListener('click', async () => {
    if (!hDetailId) return;
    await cue.meetingsRemove(hDetailId);
    hDetailId = null;
    renderHistoryList();
  });

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  // macOS: setIgnoreMouseEvents with forward lets clicks pass through the transparent window.
  // Windows: the API doesn't dynamically toggle from ignore state, so we start with events enabled
  // and rely on CSS pointer-events: none for transparent areas.
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const OB_STEPS = [
    {
      icon: '👋',
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    {
      icon: '🔐',
      title: 'Allow cue to see & hear',
      body: function () {
        if (isMac) return 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen Recording</strong> — to see your screen and hear meeting audio</li></ul>';
        return 'cue needs two permissions. The browser will prompt you when you use each feature.<ul><li><strong>Microphone</strong> — to hear you (prompted when you start listening)</li><li><strong>Screen Capture</strong> — to see your screen (prompted when you use Assist or LeetCode)</li></ul>';
      },
      buttons: function () {
        if (isMac) return [
          { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
          { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
        ];
        return [];
      }
    },
    {
      icon: '🔑',
      title: 'Connect an AI provider',
      body: 'cue uses your <strong>OpenCode Zen</strong> API key to access free models. Get a key at <span class="hl">opencode.ai/zen</span>, then paste it into Settings. A 6-model fallback chain auto-picks the best available model — no manual config needed.<br><br><strong>Tip:</strong> the listening features need speech-to-text access (an OpenAI key with Whisper, or a Gemini key). A chat-only key still powers screen &amp; coding help.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: '🫥',
      title: 'Stay hidden in Zoom',
      body: 'cue is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals cue.'
    },
    {
      icon: '✨',
      title: 'You\'re all set',
      body: function () {
        const mod = isMac ? '⌘' : 'Ctrl';
        const quit = isMac ? '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>';
        const passthrough = isMac ? '' : '<li><span class="kbd">⇧</span><span class="kbd">Q</span> — toggle <strong>hide</strong> panel</li>';
        return 'How to use cue:<ul><li><span class="kbd">' + mod + '</span> <span class="kbd">↵</span> — <strong>Assist</strong> with whatever\'s on screen or being said</li><li><span class="kbd">' + mod + '</span> <span class="kbd">H</span> — solve a coding problem on screen</li>' + passthrough + '<li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>cue logo</strong>. Quit with ' + quit + '.';
      }
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').textContent = step.icon;
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    const buttons = typeof step.buttons === 'function' ? step.buttons() : (step.buttons || []);
    buttons.forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    const platform = await cue.getPlatform();
    isMac = platform === 'darwin';
    $('#key-mod').textContent = isMac ? '⌘' : 'Ctrl';
    settings = await cue.settingsGet();
    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    if (!settings.onboarded) showOnboard();
    if (isMac) setIgnore(true); // macOS: start click-through until the mouse actually reaches the UI
  })();
})();
