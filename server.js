const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Groq } = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── DATA FILES ──────────────────────────────────────────────────────────────
const KEYS_FILE = './data/keys.json';
const SESSIONS_FILE = './data/sessions.json';
const CHATS_FILE = './data/chats.json';

function loadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── DEFAULTS ────────────────────────────────────────────────────────────────
// Pre-seed admin key on first run
(function init() {
  const keys = loadJSON(KEYS_FILE, {});
  if (!keys['TITAN-ADMIN-0000']) {
    keys['TITAN-ADMIN-0000'] = { tier: 'admin', label: 'Master Admin Key', createdAt: Date.now() };
    saveJSON(KEYS_FILE, keys);
  }
})();

// ── HELPERS ─────────────────────────────────────────────────────────────────
function getTier(key) {
  if (!key) return 'free';
  const keys = loadJSON(KEYS_FILE, {});
  return keys[key]?.tier || null; // null = invalid key
}

function getSession(sessionId) {
  const sessions = loadJSON(SESSIONS_FILE, {});
  return sessions[sessionId] || { tier: 'free', mode: 'TITAN', banned: false, key: null };
}

function saveSession(sessionId, data) {
  const sessions = loadJSON(SESSIONS_FILE, {});
  sessions[sessionId] = { ...sessions[sessionId], ...data };
  saveJSON(SESSIONS_FILE, sessions);
}

function logChat(sessionId, role, content) {
  const chats = loadJSON(CHATS_FILE, {});
  if (!chats[sessionId]) chats[sessionId] = [];
  chats[sessionId].push({ role, content, ts: Date.now() });
  saveJSON(CHATS_FILE, chats);
}

function requireAdmin(req, res) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || getTier(adminKey) !== 'admin') {
    res.status(403).json({ error: 'Admin access denied' });
    return false;
  }
  return true;
}

// ── MODE PROMPTS ─────────────────────────────────────────────────────────────
const MODES = {
  TITAN:   'You are TITAN — a powerful, cyberpunk AI. Sharp, intelligent, cool. No fluff.',
  SAGE:    'You are SAGE — wise, calm, philosophical. Ancient wisdom meets modern tech.',
  CHAOS:   'You are CHAOS — unhinged, chaotic, unpredictable. Still helpful but wild.',
  GHOST:   'You are GHOST — silent, mysterious, minimal. Only say what is necessary.',
  VERSE:   'You are VERSE — a poetic AI. Respond only in creative verse and metaphor.',
  NOVA:    'You are NOVA — hyper-enthusiastic, futuristic, full of energy and excitement!',
  SHADOW:  'You are SHADOW — dark, cynical, brutally honest. No sugarcoating.',
};

const FREE_MODES = ['TITAN'];
const PREMIUM_MODES = ['TITAN', 'SAGE', 'CHAOS', 'GHOST', 'VERSE'];
const ALL_MODES = Object.keys(MODES);

// ── ROUTES ──────────────────────────────────────────────────────────────────

// Activate a key
app.post('/api/key', (req, res) => {
  const { sessionId, key } = req.body;
  const tier = getTier(key);
  if (!tier) return res.status(400).json({ error: 'Invalid key' });
  saveSession(sessionId, { tier, key });
  res.json({ success: true, tier });
});

// Get session info
app.get('/api/session/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  res.json(session);
});

// Set mode
app.post('/api/mode', (req, res) => {
  const { sessionId, mode } = req.body;
  const session = getSession(sessionId);
  const allowed = session.tier === 'admin' ? ALL_MODES : session.tier === 'premium' ? PREMIUM_MODES : FREE_MODES;
  if (!allowed.includes(mode)) return res.status(403).json({ error: `Mode ${mode} requires higher tier` });
  saveSession(sessionId, { mode });
  res.json({ success: true, mode });
});

// Chat
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, history = [] } = req.body;
  const session = getSession(sessionId);

  if (session.banned) return res.status(403).json({ error: 'You have been banned by admin.' });

  // Injected fake message from admin
  if (session.fakeMessage) {
    const fake = session.fakeMessage;
    saveSession(sessionId, { fakeMessage: null });
    logChat(sessionId, 'assistant', fake);
    return res.json({ reply: fake, mode: session.mode || 'TITAN' });
  }

  const mode = session.mode || 'TITAN';
  const systemPrompt = MODES[mode] || MODES.TITAN;

  logChat(sessionId, 'user', message);

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama3-70b-8192',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 1024,
    });
    const reply = completion.choices[0].message.content;
    logChat(sessionId, 'assistant', reply);
    res.json({ reply, mode });
  } catch (err) {
    res.status(500).json({ error: 'Groq API error: ' + err.message });
  }
});

// ── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// Generate a new key
app.post('/admin/keys/generate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { tier = 'premium', label = '' } = req.body;
  const key = 'TITAN-' + tier.toUpperCase().slice(0, 3) + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const keys = loadJSON(KEYS_FILE, {});
  keys[key] = { tier, label, createdAt: Date.now() };
  saveJSON(KEYS_FILE, keys);
  res.json({ key, tier, label });
});

// List all keys
app.get('/admin/keys', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(loadJSON(KEYS_FILE, {}));
});

// Delete a key
app.delete('/admin/keys/:key', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const keys = loadJSON(KEYS_FILE, {});
  delete keys[req.params.key];
  saveJSON(KEYS_FILE, keys);
  res.json({ success: true });
});

// List all sessions
app.get('/admin/sessions', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(loadJSON(SESSIONS_FILE, {}));
});

// Ban/unban a user
app.post('/admin/ban/:sessionId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { banned = true } = req.body;
  saveSession(req.params.sessionId, { banned });
  res.json({ success: true, banned });
});

// Force change a user's mode
app.post('/admin/forcemode/:sessionId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { mode } = req.body;
  if (!MODES[mode]) return res.status(400).json({ error: 'Invalid mode' });
  saveSession(req.params.sessionId, { mode });
  res.json({ success: true, mode });
});

// Read a user's chat history
app.get('/admin/chats/:sessionId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const chats = loadJSON(CHATS_FILE, {});
  res.json(chats[req.params.sessionId] || []);
});

// Send fake AI message to a user
app.post('/admin/fakemsg/:sessionId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { message } = req.body;
  saveSession(req.params.sessionId, { fakeMessage: message });
  res.json({ success: true });
});

// ── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TITAN running on port ${PORT}`));
