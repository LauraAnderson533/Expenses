// Email sending. Prefers Microsoft Graph (app-only / client credentials) when
// configured; falls back to SMTP; otherwise skips (logged) so the app still runs.
// Configured entirely through environment variables — no secrets in code.
//
// Microsoft Graph (recommended):
//   GRAPH_TENANT_ID      your Microsoft 365 tenant (directory) ID
//   GRAPH_CLIENT_ID      the Entra app registration's Application (client) ID
//   GRAPH_CLIENT_SECRET  a client secret for that app registration
//   GRAPH_SENDER         the mailbox to send from, e.g. expenses@komfort.co.uk
//   (the app registration needs the Mail.Send APPLICATION permission + admin consent)
//
// SMTP (fallback):
//   SMTP_HOST (default smtp.office365.com), SMTP_PORT (default 587),
//   SMTP_USER, SMTP_PASS, MAIL_FROM
//
// Common:
//   APP_URL  base link used in emails (default https://komfortexpenses.co.uk)
const nodemailer = require('nodemailer');

const APP_URL = (process.env.APP_URL || 'https://komfortexpenses.co.uk').replace(/\/$/, '');

// ── Microsoft Graph config ──
const GRAPH_TENANT = process.env.GRAPH_TENANT_ID || '';
const GRAPH_CLIENT = process.env.GRAPH_CLIENT_ID || '';
const GRAPH_SECRET = process.env.GRAPH_CLIENT_SECRET || '';
const GRAPH_SENDER = process.env.GRAPH_SENDER || process.env.MAIL_FROM || '';
const graphEnabled = !!(GRAPH_TENANT && GRAPH_CLIENT && GRAPH_SECRET && GRAPH_SENDER);

// ── SMTP config (fallback) ──
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.office365.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const smtpEnabled = !graphEnabled && !!(SMTP_USER && SMTP_PASS);

const mailEnabled = graphEnabled || smtpEnabled;

let smtpTransport = null;
if (smtpEnabled) {
  smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT,
    secure: SMTP_PORT === 465, requireTLS: SMTP_PORT !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

if (graphEnabled) console.log('Email enabled via Microsoft Graph, sending as', GRAPH_SENDER);
else if (smtpEnabled) console.log('Email enabled via SMTP', SMTP_HOST, 'as', SMTP_USER);
else console.log('Email NOT configured (set Graph or SMTP env vars to enable notifications).');

// ── Microsoft Graph: app-only access token (cached until shortly before expiry) ──
let _token = null, _tokenExpiry = 0;
async function graphToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;
  const body = new URLSearchParams({
    client_id: GRAPH_CLIENT,
    client_secret: GRAPH_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${GRAPH_TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error('token request ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  _token = j.access_token;
  _tokenExpiry = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _token;
}

async function sendViaGraph(list, subject, html) {
  const token = await graphToken();
  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: list.map(a => ({ emailAddress: { address: a } })),
    },
    saveToSentItems: true,
  };
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_SENDER)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('Graph sendMail ' + r.status + ': ' + (await r.text()).slice(0, 300));
}

async function sendMail(to, subject, html) {
  const list = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!list.length) return;
  if (!mailEnabled) { console.log('[mail skipped]', subject, '->', list.join(', ')); return; }
  try {
    if (graphEnabled) await sendViaGraph(list, subject, html);
    else await smtpTransport.sendMail({ from: MAIL_FROM, to: list.join(','), subject, html });
    console.log('mail sent:', subject, '->', list.join(', '));
  } catch (e) {
    console.warn('mail failed:', subject, '-', e.message);
  }
}

module.exports = { sendMail, APP_URL, mailEnabled };
