export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  let email = '';
  try { const b = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}'); email = (b.email || '').toString().trim(); } catch {}
  if (!email || !email.includes('@')) return res.status(200).json({ ok: false, checked: false, reason: 'invalid_format' });
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return res.status(200).json({ ok: true, checked: false, reason: 'no_api_key' });
  const BLOCK = new Set(['invalid', 'spamtrap', 'abuse', 'do_not_mail']);
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`, { signal: c.signal });
    if (!r.ok) return res.status(200).json({ ok: true, checked: false });
    const d = await r.json(); const s = d.status || 'unknown';
    return res.status(200).json({ ok: !BLOCK.has(s), checked: true, status: s });
  } catch { return res.status(200).json({ ok: true, checked: false }); }
  finally { clearTimeout(t); }
}
