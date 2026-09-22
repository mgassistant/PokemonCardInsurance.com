// Vercel serverless function: receives a lead from the pokemoncardinsurance.com
// intake form and (1) forwards it to BrokerIQ and (2) emails the agency, mirroring
// how tcg-insurance.com handles leads.
//
// Config (Vercel env vars):
//   BROKERIQ_URL         - defaults to the BrokerIQ inbound endpoint
//   BROKERIQ_TENANT_ID   - the SEPARATE tenant for pokemoncardinsurance (create in BrokerIQ)
//   RESEND_API_KEY       - Resend key for the notification email
//   LEAD_NOTIFY_TO       - recipient(s), comma-separated (e.g. maria@fastrakins.com)
//   LEAD_NOTIFY_FROM     - from address (verified Resend sender)
//
// Fail-open: never blocks the visitor — always returns { ok: true } even if a
// downstream (BrokerIQ / Resend) call fails; errors are logged server-side.

const BROKERIQ_URL = process.env.BROKERIQ_URL || "https://www.broker-iq.com/api/leads/inbound";
const BROKERIQ_TENANT_ID = process.env.BROKERIQ_TENANT_ID || "a48b4bbb-0a1a-4cef-bb21-56c7bf94f64e"; // defaults to tcg-insurance tenant; override in Vercel with the separate tenant when ready
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFY_TO = process.env.LEAD_NOTIFY_TO || "";
const NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || "Pokemon Card Insurance <support@pokemoncardinsurance.com>";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback: read the stream.
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

async function forwardToBrokerIQ(lead) {
  try {
    const res = await fetch(BROKERIQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    return res.ok;
  } catch (err) {
    console.error("BrokerIQ forward failed:", err);
    return false;
  }
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !NOTIFY_TO) return false; // not configured — skip silently
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ***}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: NOTIFY_TO.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        html,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Lead email notification failed:", err);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const b = await readBody(req);
  const firstName = String(b.first_name || b.firstName || "").trim();
  const lastName = String(b.last_name || b.lastName || "").trim();
  const name = `${firstName} ${lastName}`.trim();
  const email = String(b.email || "").trim();
  const phone = String(b.phone || "").trim();
  const notes = String(b.collection_notes || b.message || "").trim();

  // Rich collection details captured by the intake form.
  const detailKeys = [
    "collection_value", "collection_type", "highest_item_value", "primary_storage",
    "exposure", "business_use", "documentation", "inventory_url", "state", "zip",
  ];
  const details = {};
  for (const k of detailKeys) if (b[k] != null && b[k] !== "") details[k] = b[k];

  const detailLines = Object.entries(details)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");

  const isPartial = b.partial === true || b.partial === "true";
  const lead = {
    source: "pokemoncardinsurance.com",
    tenant_id: BROKERIQ_TENANT_ID,
    lead_type: "collectible_insurance",
    lead_status: isPartial ? "partial" : "complete",
    partial: isPartial,
    name,
    email,
    phone,
    message: [notes, detailLines].filter(Boolean).join("\n\n"),
    ...details,
  };

  // Fire both destinations; don't let either block the visitor.
  await Promise.allSettled([
    forwardToBrokerIQ(lead),
    sendEmail(
      `${isPartial ? "[PARTIAL LEAD] " : ""}New Pokemon Card Insurance lead: ${name || email || phone || "(no name)"}`,
      `<h2>${isPartial ? "[PARTIAL — form not completed] " : ""}New Pokemon Card Insurance lead</h2>
       <p><b>Name:</b> ${esc(name)}</p>
       <p><b>Email:</b> ${esc(email)}</p>
       <p><b>Phone:</b> ${esc(phone)}</p>
       ${detailLines ? `<p><b>Collection details:</b></p><pre>${esc(detailLines)}</pre>` : ""}
       ${notes ? `<p><b>Notes:</b> ${esc(notes)}</p>` : ""}
       <p style="color:#888">Source: pokemoncardinsurance.com</p>`
    ),
  ]);

  return res.status(200).json({ ok: true });
}
