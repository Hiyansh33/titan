require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const Groq = require('groq-sdk');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

// ─── DATABASE ───────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'snapexplain.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
    name TEXT, tier TEXT DEFAULT 'free', razorpay_subscription_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT DEFAULT 'New Chat',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    image_base64 TEXT, image_type TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );
  CREATE TABLE IF NOT EXISTS screenshot_usage (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, count INTEGER DEFAULT 0,
    UNIQUE(user_id, date), FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS chat_usage (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, month TEXT NOT NULL, count INTEGER DEFAULT 0,
    UNIQUE(user_id, month), FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, discount_type TEXT NOT NULL,
    discount_value REAL NOT NULL, tier_override TEXT, max_uses INTEGER DEFAULT -1,
    uses_count INTEGER DEFAULT 0, expiry_date TEXT, active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id TEXT PRIMARY KEY, coupon_id TEXT NOT NULL, user_id TEXT NOT NULL,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (coupon_id) REFERENCES coupons(id), FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ─── TIER LIMITS ────────────────────────────────────────────
const TIER_LIMITS = {
  free:    { screenshots_per_day: 5,        chats_per_month: 3 },
  pro:     { screenshots_per_day: 25,       chats_per_month: 9 },
  premium: { screenshots_per_day: Infinity, chats_per_month: Infinity }
};

// ─── MIDDLEWARE ──────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'No token.' });
  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Invalid token.' }); }
}

function adminMiddleware(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden.' });
  next();
}

function checkScreenshotLimit(req, res, next) {
  const limit = TIER_LIMITS[req.user.tier];
  if (limit.screenshots_per_day === Infinity) return next();
  const today = new Date().toISOString().split('T')[0];
  let usage = db.prepare('SELECT * FROM screenshot_usage WHERE user_id = ? AND date = ?').get(req.user.id, today);
  if (!usage) { db.prepare('INSERT INTO screenshot_usage (id, user_id, date, count) VALUES (?, ?, ?, 0)').run(uuidv4(), req.user.id, today); usage = { count: 0 }; }
  if (usage.count >= limit.screenshots_per_day) return res.status(429).json({ error: `Daily limit reached (${limit.screenshots_per_day}). Upgrade!`, limit_reached: true });
  req.incrementScreenshot = () => db.prepare('UPDATE screenshot_usage SET count = count + 1 WHERE user_id = ? AND date = ?').run(req.user.id, today);
  next();
}

function checkChatLimit(req, res, next) {
  const limit = TIER_LIMITS[req.user.tier];
  if (limit.chats_per_month === Infinity) return next();
  const month = new Date().toISOString().slice(0, 7);
  let usage = db.prepare('SELECT * FROM chat_usage WHERE user_id = ? AND month = ?').get(req.user.id, month);
  if (!usage) { db.prepare('INSERT INTO chat_usage (id, user_id, month, count) VALUES (?, ?, ?, 0)').run(uuidv4(), req.user.id, month); usage = { count: 0 }; }
  if (usage.count >= limit.chats_per_month) return res.status(429).json({ error: `Monthly chat limit reached (${limit.chats_per_month}). Upgrade!`, limit_reached: true });
  req.incrementChat = () => db.prepare('UPDATE chat_usage SET count = count + 1 WHERE user_id = ? AND month = ?').run(req.user.id, month);
  next();
}

// ─── AUTH ROUTES ─────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return res.status(400).json({ error: 'Email already registered.' });
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)').run(id, email, await bcrypt.hash(password, 10), name || '');
  const token = jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, email, name, tier: 'free' } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, tier: user.tier } });
});

// ─── CHAT ROUTES ─────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.get('/api/chats', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id));
});

app.post('/api/chats', authMiddleware, checkChatLimit, (req, res) => {
  const id = uuidv4();
  db.prepare('INSERT INTO chats (id, user_id, title) VALUES (?, ?, ?)').run(id, req.user.id, req.body.title || 'New Chat');
  if (req.incrementChat) req.incrementChat();
  res.json(db.prepare('SELECT * FROM chats WHERE id = ?').get(id));
});

app.delete('/api/chats/:chatId', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(req.params.chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  db.prepare('DELETE FROM messages WHERE chat_id = ?').run(req.params.chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.chatId);
  res.json({ success: true });
});

app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(req.params.chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  res.json(db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.chatId));
});

app.post('/api/chats/:chatId/message', authMiddleware, (req, res, next) => {
  if (req.body.imageBase64) return checkScreenshotLimit(req, res, next);
  next();
}, async (req, res) => {
  const { chatId } = req.params;
  const { content, imageBase64, imageType, simpleMode } = req.body;
  const chat = db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });

  const userMsgId = uuidv4();
  db.prepare('INSERT INTO messages (id, chat_id, role, content, image_base64, image_type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userMsgId, chatId, 'user', content || 'Explain this screenshot.', imageBase64 || null, imageType || null);
  if (imageBase64 && req.incrementScreenshot) req.incrementScreenshot();

  const history = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatId);
  const systemPrompt = simpleMode
    ? 'You are a friendly assistant that explains things simply. No jargon. Short sentences. Be warm.'
    : 'You explain screenshots clearly. Identify what it shows, explain errors, give step-by-step solutions.';

  const groqMessages = history.map(msg => msg.image_base64
    ? { role: msg.role, content: [{ type: 'image_url', image_url: { url: `data:${msg.image_type};base64,${msg.image_base64}` } }, { type: 'text', text: msg.content }] }
    : { role: msg.role, content: msg.content }
  );

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.2-90b-vision-preview',
      messages: [{ role: 'system', content: systemPrompt }, ...groqMessages],
      max_tokens: 1024,
    });
    const aiText = completion.choices[0].message.content;
    const aiMsgId = uuidv4();
    db.prepare('INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)').run(aiMsgId, chatId, 'assistant', aiText);
    if (imageBase64 && history.length <= 1) db.prepare('UPDATE chats SET title = ? WHERE id = ?').run((content || 'Screenshot').slice(0, 40), chatId);
    res.json({ message: { id: aiMsgId, role: 'assistant', content: aiText } });
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PAYMENT / COUPON ROUTES ──────────────────────────────────
app.get('/api/payment/me', authMiddleware, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const month = new Date().toISOString().slice(0, 7);
  const screenshotUsage = db.prepare('SELECT count FROM screenshot_usage WHERE user_id = ? AND date = ?').get(req.user.id, today);
  const chatUsage = db.prepare('SELECT count FROM chat_usage WHERE user_id = ? AND month = ?').get(req.user.id, month);
  const chatCount = db.prepare('SELECT COUNT(*) as count FROM chats WHERE user_id = ?').get(req.user.id);
  const limits = TIER_LIMITS[req.user.tier];
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, tier: req.user.tier },
    usage: {
      screenshots_today: screenshotUsage?.count || 0,
      screenshots_limit: limits.screenshots_per_day === Infinity ? -1 : limits.screenshots_per_day,
      chats_this_month: chatUsage?.count || 0,
      chats_limit: limits.chats_per_month === Infinity ? -1 : limits.chats_per_month,
      total_chats: chatCount.count
    }
  });
});

app.post('/api/payment/validate-coupon', authMiddleware, (req, res) => {
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(req.body.code?.toUpperCase());
  if (!coupon) return res.status(404).json({ error: 'Invalid coupon code.' });
  if (coupon.expiry_date && new Date(coupon.expiry_date) < new Date()) return res.status(400).json({ error: 'Coupon expired.' });
  if (coupon.max_uses !== -1 && coupon.uses_count >= coupon.max_uses) return res.status(400).json({ error: 'Coupon limit reached.' });
  if (db.prepare('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?').get(coupon.id, req.user.id)) return res.status(400).json({ error: 'Already used.' });
  res.json({ valid: true, discount_type: coupon.discount_type, discount_value: coupon.discount_value, tier_override: coupon.tier_override, code: coupon.code });
});

app.post('/api/payment/redeem-coupon', authMiddleware, (req, res) => {
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(req.body.code?.toUpperCase());
  if (!coupon) return res.status(404).json({ error: 'Invalid coupon code.' });
  if (!coupon.tier_override) return res.status(400).json({ error: 'This coupon requires payment. Coming soon!' });
  if (db.prepare('SELECT id FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?').get(coupon.id, req.user.id)) return res.status(400).json({ error: 'Already used.' });
  db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(coupon.tier_override, req.user.id);
  db.prepare('INSERT INTO coupon_redemptions (id, coupon_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), coupon.id, req.user.id);
  db.prepare('UPDATE coupons SET uses_count = uses_count + 1 WHERE id = ?').run(coupon.id);
  res.json({ success: true, tier: coupon.tier_override });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────
const adminPath = `/admin-${process.env.ADMIN_PATH_SECRET}`;

app.get(`${adminPath}/stats`, adminMiddleware, (req, res) => {
  res.json({
    total_users: db.prepare('SELECT COUNT(*) as count FROM users').get().count,
    tier_breakdown: db.prepare('SELECT tier, COUNT(*) as count FROM users GROUP BY tier').all(),
    total_chats: db.prepare('SELECT COUNT(*) as count FROM chats').get().count,
    total_messages: db.prepare('SELECT COUNT(*) as count FROM messages').get().count,
    screenshots_today: db.prepare('SELECT SUM(count) as total FROM screenshot_usage WHERE date = ?').get(new Date().toISOString().split('T')[0]).total || 0
  });
});

app.get(`${adminPath}/users`, adminMiddleware, (req, res) => {
  res.json(db.prepare('SELECT id, email, name, tier, created_at FROM users ORDER BY created_at DESC').all());
});

app.patch(`${adminPath}/users/:userId/tier`, adminMiddleware, (req, res) => {
  if (!['free', 'pro', 'premium'].includes(req.body.tier)) return res.status(400).json({ error: 'Invalid tier.' });
  db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(req.body.tier, req.params.userId);
  res.json({ success: true });
});

app.get(`${adminPath}/coupons`, adminMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all());
});

app.post(`${adminPath}/coupons`, adminMiddleware, (req, res) => {
  const { code, discount_type, discount_value, tier_override, max_uses, expiry_date } = req.body;
  if (!code || !discount_type) return res.status(400).json({ error: 'code and discount_type required.' });
  const id = uuidv4();
  db.prepare('INSERT INTO coupons (id, code, discount_type, discount_value, tier_override, max_uses, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, code.toUpperCase(), discount_type, discount_value || 0, tier_override || null, max_uses || -1, expiry_date || null);
  res.json(db.prepare('SELECT * FROM coupons WHERE id = ?').get(id));
});

app.patch(`${adminPath}/coupons/:couponId/toggle`, adminMiddleware, (req, res) => {
  const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.couponId);
  if (!coupon) return res.status(404).json({ error: 'Not found.' });
  db.prepare('UPDATE coupons SET active = ? WHERE id = ?').run(coupon.active ? 0 : 1, req.params.couponId);
  res.json({ success: true, active: !coupon.active });
});

app.delete(`${adminPath}/coupons/:couponId`, adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.couponId);
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'snap.explain API running 🚀' }));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
