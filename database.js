// Shared, server-side data store for the Komfort Expenses System.
// A single SQLite database (via sql.js) persisted to a file on DATA_DIR.
// Every front-end "store" (users, reports, lines, …) is kept as JSON rows in
// one generic `records` table, so the front-end's data model stays authoritative.
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// DATA_DIR points at the persistent disk in production (e.g. /var/data on Render),
// falling back to a local ./data folder for development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'expenses-system.db');

let db = null;
let SQL = null;
let dirty = false;

function save() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  dirty = false;
}
// Flush to disk shortly after writes (debounced by the interval) so a burst of
// writes doesn't rewrite the file on every call.
setInterval(() => { if (dirty) save(); }, 4000);

async function initDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run(`CREATE TABLE IF NOT EXISTS records (
    store TEXT NOT NULL,
    key   TEXT NOT NULL,
    data  TEXT NOT NULL,
    PRIMARY KEY (store, key)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
  seedBootstrapAdmin();
  save();
  return db;
}

// ── Generic record access ──
function getAll(store) {
  const stmt = db.prepare('SELECT data FROM records WHERE store = ?');
  stmt.bind([store]);
  const rows = [];
  while (stmt.step()) rows.push(JSON.parse(stmt.getAsObject().data));
  stmt.free();
  return rows;
}
function get(store, key) {
  const stmt = db.prepare('SELECT data FROM records WHERE store = ? AND key = ?');
  stmt.bind([store, String(key)]);
  let out = null;
  if (stmt.step()) out = JSON.parse(stmt.getAsObject().data);
  stmt.free();
  return out;
}
function put(store, key, obj) {
  db.run('INSERT OR REPLACE INTO records (store, key, data) VALUES (?,?,?)',
    [store, String(key), JSON.stringify(obj)]);
  dirty = true;
}
function del(store, key) {
  db.run('DELETE FROM records WHERE store = ? AND key = ?', [store, String(key)]);
  dirty = true;
}
function nextCounter(name) {
  const stmt = db.prepare('SELECT value FROM counters WHERE name = ?');
  stmt.bind([name]);
  let cur = 0;
  if (stmt.step()) cur = Number(stmt.getAsObject().value) || 0;
  stmt.free();
  const n = cur + 1;
  db.run('INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)', [name, n]);
  dirty = true;
  return n;
}

// ── One-time bootstrap: create a single admin so someone can log in on day one.
// A random temporary password is printed to the server log (visible only to the
// workspace owner); the admin is forced to change it on first login.
function seedBootstrapAdmin() {
  const hasUsers = getAll('users').length > 0;
  if (hasUsers) return;
  const id = uuidv4();
  const tempPassword = process.env.ADMIN_PASSWORD ||
    ('Komfort-' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10));
  put('users', id, {
    id,
    username: 'admin',
    password_hash: bcrypt.hashSync(tempPassword, 10),
    full_name: 'System Administrator',
    email: null,
    roles: ['employee', 'manager', 'finance', 'credit_card'],
    department_id: null,
    location_id: null,
    approver1_id: null,
    approver2_id: null,
    active: 1,
    must_change_password: true,
    created_at: new Date().toISOString(),
  });
  console.log('──────────────────────────────────────────────');
  console.log(' Bootstrap admin created');
  console.log('   username: admin');
  console.log('   password: ' + tempPassword);
  console.log('   (you will be asked to change it on first login)');
  console.log('──────────────────────────────────────────────');
}

module.exports = { initDb, getAll, get, put, del, nextCounter, save };
