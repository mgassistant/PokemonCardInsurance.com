import { clientIP, verifyEmail } from './_emailVerification.js';

// ZeroBounce check the form runs before submit, so the visitor can fix a bad
// address. /api/quote runs the same check again server-side (see
// _emailVerification.js), so this endpoint is a courtesy, not the only gate.
// Fail-open: ok:true when the address could not be checked.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let email = '';
  try { const b = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}'); email = (b.email || '').toString().trim(); } catch {}
  if (!email || !email.includes('@')) return res.status(200).json({ ok: false, checked: false, reason: 'invalid_format' });
  return res.status(200).json(await verifyEmail(email, clientIP(req)));
}
