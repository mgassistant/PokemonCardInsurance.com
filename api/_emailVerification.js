/**
 * Server-side ZeroBounce email verification, shared by /api/verify-email (the
 * check the form runs before submit) and by /api/quote (so a lead cannot skip
 * the check: partial / abandoned captures, sendBeacon posts and direct POSTs
 * are verified too).
 *
 * The leading underscore keeps Vercel from exposing this file as a route.
 *
 * Server only: reads ZEROBOUNCE_API_KEY, which must never reach the browser.
 *
 * Fail-open: a missing key, a ZeroBounce outage, a timeout, or an error body
 * (bad key / out of credits) never blocks a lead. Those cases return
 * `checked: false` with a `reason`, and are logged, so a silent outage is
 * visible in the logs and on the lead record instead of passing unnoticed.
 *
 * Verdict shape: { ok, checked, status, sub_status, reason? }
 *   ok         false only when ZeroBounce gave a definitive bad verdict.
 *   checked    true when ZeroBounce actually returned a verdict for this address.
 *   reason     why the address was not checked (only when checked is false).
 */

const BLOCK_STATUSES = new Set(['invalid', 'spamtrap', 'abuse', 'do_not_mail']);
const TIMEOUT_MS = 6000;

// The form verifies in the browser and /api/quote verifies again on submit.
// A short per-instance cache keeps that second check from spending a second
// ZeroBounce credit when both land on the same warm function instance.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function unchecked(reason) {
  return { ok: true, checked: false, status: null, sub_status: null, reason };
}

// `req` is the Node request Vercel passes to api/*.js handlers (plain headers object).
export function clientIP(req) {
  const h = (req && req.headers) || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v) || '';
  const xff = first(h['x-forwarded-for']);
  if (xff) return String(xff).split(',')[0].trim();
  return String(first(h['x-real-ip']));
}

export async function verifyEmail(rawEmail, ip = '') {
  const email = (rawEmail == null ? '' : String(rawEmail)).trim().toLowerCase();
  if (!email) return unchecked('no_email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, checked: false, status: 'invalid', sub_status: 'invalid_format', reason: 'invalid_format' };
  }

  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;

  const apiKey = process.env.ZEROBOUNCE_API_KEY;
  if (!apiKey) {
    console.warn('[EMAIL-VERIFY] ZEROBOUNCE_API_KEY is not set; email not verified');
    return unchecked('no_api_key');
  }

  const url =
    'https://api.zerobounce.net/v2/validate' +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&email=${encodeURIComponent(email)}` +
    `&ip_address=${encodeURIComponent(ip === 'unknown' ? '' : ip)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      console.error(`[EMAIL-VERIFY] ZeroBounce HTTP ${res.status}; email not verified`);
      return unchecked(`http_${res.status}`);
    }
    const data = await res.json();
    // ZeroBounce answers HTTP 200 with an `error` field (and no status) for a
    // bad key or an account that is out of credits. That is an outage, not a
    // verdict, so it must not be reported as "checked".
    if (!data || data.error || !data.status) {
      console.error(`[EMAIL-VERIFY] ZeroBounce returned no verdict: ${(data && data.error) || 'empty status'}`);
      return unchecked('zerobounce_error');
    }
    const verdict = {
      ok: !BLOCK_STATUSES.has(data.status),
      checked: true,
      status: data.status,
      sub_status: data.sub_status || null,
    };
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(email, { at: Date.now(), verdict });
    return verdict;
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : 'network_error';
    console.error(`[EMAIL-VERIFY] ZeroBounce ${reason}; email not verified`);
    return unchecked(reason);
  } finally {
    clearTimeout(timer);
  }
}

/** Short tag for notes / spam flags, e.g. "invalid-email:possible_typo". */
export function badEmailFlag(v) {
  if (v.ok) return null;
  return `invalid-email:${v.sub_status || v.status || 'invalid'}`;
}

/**
 * Returns the `raw` object to forward with a lead: whatever `raw` the lead
 * already carried, plus the verdict. A rejected address soft-flags the lead
 * for review (suspected_spam + spam_flags); it is never dropped.
 */
export function rawWithEmailVerdict(existingRaw, verdict) {
  const base =
    existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)
      ? existingRaw
      : existingRaw == null || existingRaw === '' ? {} : { value: existingRaw };
  const raw = { ...base, email_verification: verdict };
  const flag = badEmailFlag(verdict);
  if (flag) {
    raw.suspected_spam = true;
    raw.spam_flags = [...(Array.isArray(base.spam_flags) ? base.spam_flags : []), flag];
  }
  return raw;
}

/** Suffix for the Email line of the internal notification email. */
export function emailVerdictNote(email, v) {
  if (!email) return '';
  if (!v.checked && v.ok) return ' (not verified)';
  if (!v.ok) return ` ❌ ${v.sub_status || v.status || 'invalid'}`;
  // Only "valid" is a confirmed address; catch-all / unknown are inconclusive.
  return v.status === 'valid' ? ' ✅ verified' : ` (${v.status || 'not verified'})`;
}
