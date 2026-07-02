// Email sending via Microsoft 365 SMTP (or any SMTP).
// Configured entirely through environment variables so no secrets live in code:
//   SMTP_HOST  (default smtp.office365.com)
//   SMTP_PORT  (default 587)
//   SMTP_USER  the sending mailbox, e.g. expenses@komfort.co.uk
//   SMTP_PASS  that mailbox's password / app password
//   MAIL_FROM  optional "From" (defaults to SMTP_USER)
//   APP_URL    base link used in emails (default https://komfortexpenses.co.uk)
// If SMTP_USER/SMTP_PASS aren't set, email is skipped (logged) and the app runs normally.
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.office365.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const APP_URL = (process.env.APP_URL || 'https://komfortexpenses.co.uk').replace(/\/$/, '');
const mailEnabled = !!(SMTP_USER && SMTP_PASS);

let transporter = null;
if (mailEnabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,   // 465 = implicit TLS; 587 = STARTTLS
    requireTLS: SMTP_PORT !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log('Email enabled via', SMTP_HOST, 'as', SMTP_USER);
} else {
  console.log('Email NOT configured (set SMTP_USER / SMTP_PASS to enable notifications).');
}

async function sendMail(to, subject, html) {
  const list = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!list.length) return;
  if (!mailEnabled) { console.log('[mail skipped]', subject, '->', list.join(', ')); return; }
  try {
    await transporter.sendMail({ from: MAIL_FROM, to: list.join(','), subject, html });
    console.log('mail sent:', subject, '->', list.join(', '));
  } catch (e) {
    console.warn('mail failed:', subject, '-', e.message);
  }
}

module.exports = { sendMail, APP_URL, mailEnabled };
