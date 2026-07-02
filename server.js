// Komfort Expenses System — shared multi-user API server.
// Serves the front-end and exposes a small REST API that mirrors the app's
// data helpers, backed by one shared SQLite database (see database.js), with
// real login (JWT + bcrypt) and role-based permissions.
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const store = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'expenses-dev-secret-change-me';

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
const REF_STORES = ['categories', 'departments', 'locations', 'vehicle_types',
  'mileage_rates', 'advisory_rates', 'mileage_adjustments', 'suppliers', 'vat_rates'];
const FINANCE_ONLY_READ = ['audit_log', 'payment_runs'];

function keyField(s) { return s === 'settings' ? 'key' : 'id'; }
function role(user, r) { return Array.isArray(user.roles) && user.roles.includes(r); }
function strip(u) { if (!u) return u; const { password_hash, ...rest } = u; return rest; }
function signToken(u) {
  return jwt.sign({ id: u.id, username: u.username, roles: u.roles, full_name: u.full_name },
    JWT_SECRET, { expiresIn: '12h' });
}
function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'Invalid or expired session' }); }
}

// Report visibility: finance sees all; owners see their own; a manager/finance
// approver sees reports of people who report to them.
function reportApprovers(report) {
  const owner = store.get('users', report.user_id);
  return owner ? [owner.approver1_id, owner.approver2_id] : [];
}
function canReadReport(user, report) {
  if (role(user, 'finance')) return true;
  if (report.user_id === user.id) return true;
  return reportApprovers(report).includes(user.id);
}
const canWriteReport = canReadReport; // v1: the same people who can see a report can act on it

// ── Auth endpoints ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = store.getAll('users').find(x =>
    String(x.username).toLowerCase() === String(username || '').toLowerCase());
  if (!u || !u.active) return res.status(401).json({ error: 'Invalid username or password' });
  if (!bcrypt.compareSync(String(password || ''), u.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: signToken(u), user: strip(u) });
});

app.get('/api/me', auth, (req, res) => {
  const u = store.get('users', req.user.id);
  if (!u || !u.active) return res.status(401).json({ error: 'Account not available' });
  res.json(strip(u));
});

app.post('/api/change-password', auth, (req, res) => {
  const u = store.get('users', req.user.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { current, new: next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), u.password_hash))
    return res.status(400).json({ error: 'Current password is incorrect' });
  if (String(next || '').length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  u.password_hash = bcrypt.hashSync(String(next), 10);
  u.must_change_password = false;
  store.put('users', u.id, u);
  res.json({ ok: true });
});

// Download a fresh copy of the whole database (finance only) for off-site backup.
app.get('/api/backup', auth, (req, res) => {
  if (!role(req.user, 'finance')) return res.status(403).json({ error: 'Finance only' });
  store.save();
  const name = 'komfort-expenses-backup-' + new Date().toISOString().slice(0, 10) + '.db';
  res.download(store.DB_PATH, name);
});

// Trigger an immediate on-disk snapshot (finance only).
app.post('/api/backup/run', auth, (req, res) => {
  if (!role(req.user, 'finance')) return res.status(403).json({ error: 'Finance only' });
  store.backupDb();
  res.json({ ok: true });
});

// ── Read scoping ──
function scopedGetAll(user, s) {
  const all = store.getAll(s);
  if (s === 'users') return all.map(strip);
  if (s === 'reports') return all.filter(r => canReadReport(user, r));
  if (s === 'lines') return all.filter(l => {
    const rep = store.get('reports', l.report_id);
    return rep && canReadReport(user, rep);
  });
  if (FINANCE_ONLY_READ.includes(s)) return role(user, 'finance') ? all : [];
  return all; // reference data + settings: any authenticated user
}

// ── Generic store API (mirrors idbGetAll / idbGet / idbPut / idbDelete / idbByIndex) ──
app.get('/api/store/:store', auth, (req, res) => {
  res.json(scopedGetAll(req.user, req.params.store));
});

app.get('/api/store/:store/index/:field/:value', auth, (req, res) => {
  const { store: s, field, value } = req.params;
  const rows = scopedGetAll(req.user, s).filter(r => String(r[field]) === String(value));
  res.json(rows);
});

app.get('/api/store/:store/:key', auth, (req, res) => {
  const { store: s, key } = req.params;
  const rec = store.get(s, key);
  if (!rec) return res.json(null);
  if (s === 'users') return res.json(strip(rec));
  if (s === 'reports' && !canReadReport(req.user, rec)) return res.status(403).json({ error: 'Forbidden' });
  if (s === 'lines') {
    const rep = store.get('reports', rec.report_id);
    if (!(rep && canReadReport(req.user, rep))) return res.status(403).json({ error: 'Forbidden' });
  }
  if (FINANCE_ONLY_READ.includes(s) && !role(req.user, 'finance')) return res.status(403).json({ error: 'Forbidden' });
  res.json(rec);
});

app.put('/api/store/:store', auth, (req, res) => {
  const s = req.params.store;
  const obj = req.body || {};
  const user = req.user;

  // Reference data: any authenticated user may add a supplier; other reference
  // writes are finance-only.
  if (REF_STORES.includes(s) && s !== 'suppliers' && !role(user, 'finance'))
    return res.status(403).json({ error: 'Finance only' });
  if (s === 'settings' && !role(user, 'finance')) return res.status(403).json({ error: 'Finance only' });
  if (s === 'payment_runs' && !role(user, 'finance')) return res.status(403).json({ error: 'Finance only' });

  if (s === 'users') {
    // Turn any provided plaintext password into a bcrypt hash server-side.
    if (obj.password) { obj.password_hash = bcrypt.hashSync(String(obj.password), 10); }
    delete obj.password;
    const existing = obj.id ? store.get('users', obj.id) : null;
    const isSelf = existing && existing.id === user.id;
    if (!role(user, 'finance')) {
      if (!isSelf) return res.status(403).json({ error: 'Forbidden' });
      // Non-finance users cannot change their own roles or active flag (no privilege escalation)
      obj.roles = existing.roles;
      obj.active = existing.active;
    }
    if (existing && !obj.password_hash) obj.password_hash = existing.password_hash; // keep current password on edits
    if (!obj.id) obj.id = uuidv4();
    if (!obj.password_hash) obj.password_hash = bcrypt.hashSync('changeme', 10);
  }

  if (s === 'reports') {
    const existing = obj.id ? store.get('reports', obj.id) : null;
    if (existing) {
      if (!canWriteReport(user, existing)) return res.status(403).json({ error: 'Forbidden' });
      obj.user_id = existing.user_id;                        // ownership is fixed once set
      if (existing.created_at) obj.created_at = existing.created_at;
    } else if (!role(user, 'finance')) {
      obj.user_id = user.id;                                 // new reports are owned by their creator
    }
    if (!obj.id) obj.id = uuidv4();
  }

  if (s === 'lines') {
    const rep = store.get('reports', obj.report_id);
    if (!rep || !canWriteReport(user, rep)) return res.status(403).json({ error: 'Forbidden' });
    if (!obj.id) obj.id = uuidv4();
  }

  if (s === 'audit_log') {
    if (obj.id === undefined || obj.id === null) obj.id = store.nextCounter('audit_log');
  }

  const kf = keyField(s);
  if (obj[kf] === undefined || obj[kf] === null) obj[kf] = uuidv4();
  const key = obj[kf];
  store.put(s, key, obj);
  res.json({ key, id: obj.id, [kf]: obj[kf] });
});

app.delete('/api/store/:store/:key', auth, (req, res) => {
  const { store: s, key } = req.params;
  const user = req.user;
  if (s === 'reports') {
    const rep = store.get('reports', key);
    if (rep && !canWriteReport(user, rep)) return res.status(403).json({ error: 'Forbidden' });
  }
  if (s === 'lines') {
    const l = store.get('lines', key);
    if (l) { const rep = store.get('reports', l.report_id); if (rep && !canWriteReport(user, rep)) return res.status(403).json({ error: 'Forbidden' }); }
  }
  if (REF_STORES.includes(s) && s !== 'suppliers' && !role(user, 'finance')) return res.status(403).json({ error: 'Finance only' });
  if ((s === 'payment_runs' || s === 'settings') && !role(user, 'finance')) return res.status(403).json({ error: 'Finance only' });
  store.del(s, key);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

store.initDb().then(() => {
  app.listen(PORT, () => console.log(`Komfort Expenses System running on http://localhost:${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
