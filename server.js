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
const crypto = require('crypto');
const store = require('./database');
const mailer = require('./mailer');

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

// Stores that must never be exposed through the generic /api/store API.
const INTERNAL_STORES = ['reset_tokens'];

// ── Expense email notifications ──
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB') : '—';
function reportTotal(reportId) {
  return store.getAll('lines')
    .filter(l => l.report_id === reportId)
    .reduce((sum, l) => sum + Number(l.amount || 0), 0);
}
function notifyReport(report, stage) {
  try {
    const owner = store.get('users', report.user_id);
    if (!owner) return;
    const isCC = report.type === 'creditcard';
    const label = isCC ? 'Credit card report' : 'Expense claim';
    const subj = isCC ? 'Credit card report' : 'Expense';
    const approver1 = owner.approver1_id ? store.get('users', owner.approver1_id) : null;
    const approver2 = owner.approver2_id ? store.get('users', owner.approver2_id) : null;
    const money = '£' + reportTotal(report.id).toFixed(2);
    const ref = report.reference || report.title || report.id;
    const rows = [
      ['Employee', owner.full_name],
      ['Reference', ref],
      ['Amount', money],
      ['Submitted', fmtDate(report.submitted_at)],
      ['Manager approved', fmtDate(report.manager_approved_at)],
      ['Finance approved', fmtDate(report.finance_approved_at)],
    ];
    if (!isCC) rows.push(['Reimbursed', fmtDate(report.reimbursed_at)]);
    const table = '<table style="border-collapse:collapse;margin:8px 0">' +
      rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#666">${k}</td><td style="padding:3px 0"><strong>${v}</strong></td></tr>`).join('') +
      '</table>';
    let subject, intro, extra = null;
    if (stage === 'submitted') { subject = `${subj} ${ref} submitted — ${owner.full_name}`; intro = `${owner.full_name} has submitted ${label.toLowerCase()} <strong>${ref}</strong> for <strong>${money}</strong>, awaiting approval.`; extra = (approver1 || approver2 || {}).email; }
    else if (stage === 'manager_approved') { subject = `${subj} ${ref} approved by manager`; intro = `${label} <strong>${ref}</strong> (${money}) has been approved by the manager and is awaiting finance approval.`; extra = (approver2 || {}).email; }
    else if (stage === 'finance_approved') { subject = `${subj} ${ref} approved by finance`; intro = isCC ? `${label} <strong>${ref}</strong> (${money}) has been fully approved.` : `Expense claim <strong>${ref}</strong> (${money}) has been approved by finance and is due for reimbursement.`; extra = (approver2 || {}).email; }
    else if (stage === 'reimbursed') { subject = `Expense ${ref} reimbursed`; intro = `Expense claim <strong>${ref}</strong> (${money}) has been reimbursed.`; }
    else if (stage === 'rejected') { subject = `${subj} ${ref} returned for changes`; intro = `Your ${label.toLowerCase()} <strong>${ref}</strong> (${money}) has been <strong>returned for changes</strong>.` + (report.rejection_note ? ` Reason: <em>${String(report.rejection_note).replace(/</g, '&lt;')}</em>` : ' Please amend it and resubmit.'); }
    else return;
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
      <p>${intro}</p>${table}
      <p style="margin-top:16px"><a href="${mailer.APP_URL}" style="background:#565A5C;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">Open the Expenses System</a></p>
      <p style="color:#999;font-size:12px">Komfort Partitioning Ltd — Expenses System</p></div>`;
    mailer.sendMail([owner.email, extra], subject, html);
  } catch (e) { console.warn('notifyReport failed:', e.message); }
}

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

// Email diagnostic — sends a test email and returns the exact result (so we can
// see Graph/SMTP errors). Allowed for a logged-in finance user, or via a secret
// ?key=<MAIL_TEST_KEY> query (env-set) so it can be checked without logging in.
app.get('/api/test-email', async (req, res) => {
  let allowed = false;
  const testKey = process.env.MAIL_TEST_KEY;
  if (testKey && req.query.key === testKey) allowed = true;
  else { try { allowed = role(jwt.verify((req.headers['authorization'] || '').split(' ')[1], JWT_SECRET), 'finance'); } catch (e) {} }
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  const to = req.query.to || mailer.mailStatus().sender;
  const result = await mailer.sendResult(to, 'Komfort Expenses — test email',
    '<p>This is a test email from the Komfort Expenses System.</p><p>If you received this, Microsoft Graph email is working.</p>');
  res.json({ config: mailer.mailStatus(), to, result });
});

// ── Forgot / reset password (no auth; emails a time-limited link) ──
app.post('/api/forgot-password', (req, res) => {
  const id = String((req.body || {}).username_or_email || '').toLowerCase().trim();
  if (id) {
    const user = store.getAll('users').find(u =>
      String(u.username).toLowerCase() === id || String(u.email || '').toLowerCase() === id);
    if (user && user.active && user.email) {
      const token = crypto.randomBytes(24).toString('hex');
      store.put('reset_tokens', token, { token, user_id: user.id, expires: Date.now() + 60 * 60 * 1000 });
      const link = mailer.APP_URL + '/?reset=' + token;
      mailer.sendMail(user.email, 'Reset your Komfort Expenses password',
        `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
          <p>Hello ${user.full_name},</p>
          <p>We received a request to reset your Komfort Expenses System password. Click below to choose a new one (valid for 1 hour):</p>
          <p><a href="${link}" style="background:#565A5C;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
          <p style="color:#999;font-size:12px">If you didn't request this, you can safely ignore this email.</p></div>`);
    }
  }
  // Always respond the same way, so we never reveal whether an account exists.
  res.json({ ok: true });
});

app.post('/api/reset-password', (req, res) => {
  const { token, new: next } = req.body || {};
  const rec = token ? store.get('reset_tokens', token) : null;
  if (!rec || rec.expires < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = store.get('users', rec.user_id);
  if (!user) return res.status(400).json({ error: 'Account not found' });
  user.password_hash = bcrypt.hashSync(String(next), 10);
  user.must_change_password = false;
  store.put('users', user.id, user);
  store.del('reset_tokens', token);
  res.json({ ok: true });
});

// Never expose internal stores (e.g. reset tokens) through the generic API.
app.use('/api/store', (req, res, next) => {
  const s = req.path.split('/').filter(Boolean)[0];
  if (INTERNAL_STORES.includes(s)) return res.status(404).json({ error: 'Not found' });
  next();
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
  let prevReport = null;

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
    prevReport = existing;
    if (existing) {
      if (!canWriteReport(user, existing)) return res.status(403).json({ error: 'Forbidden' });
      obj.user_id = existing.user_id;                        // ownership is fixed once set
      if (existing.created_at) obj.created_at = existing.created_at;
      if (existing.reference) obj.reference = existing.reference;   // keep the assigned reference
    } else {
      if (!role(user, 'finance')) obj.user_id = user.id;     // new reports are owned by their creator
      if (!obj.reference) {                                  // assign a sequential reference server-side
        const cc = obj.type === 'creditcard';
        const n = store.nextCounter(cc ? 'seq_creditcard' : 'seq_expense');
        obj.reference = `${cc ? 'KPLCC' : 'KPLEXP'}-${String(n).padStart(6, '0')}`;
      }
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
  if (s === 'reports') {
    const was = prevReport || {};
    const awaiting = st => st === 'awaiting_manager' || st === 'awaiting_finance';
    if (obj.status === 'rejected' && was.status !== 'rejected') notifyReport(obj, 'rejected');
    else if (awaiting(obj.status) && !awaiting(was.status)) notifyReport(obj, 'submitted'); // first submit or resubmit
    else if (!was.manager_approved_at && obj.manager_approved_at) notifyReport(obj, 'manager_approved');
    else if (!was.finance_approved_at && obj.finance_approved_at) notifyReport(obj, 'finance_approved');
    else if (!was.reimbursed_at && obj.reimbursed_at) notifyReport(obj, 'reimbursed');
  }
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
