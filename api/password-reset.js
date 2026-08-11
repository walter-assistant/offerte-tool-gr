const SUPABASE_URL = 'https://varflklvllrnrzhnbbpg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_U1N34WcxGPZSf9qDSHTC2g_2Ah_yR3s';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function authError(data) {
  return data.error_description || data.msg || data.message || data.error || data.code || 'Wachtwoord-reset mislukt.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const email = String(body.email || '').trim();
    const redirectTo = String(body.redirectTo || '').trim();

    if (!email || !email.includes('@')) {
      return sendJson(res, 400, { error: 'Vul een geldig e-mailadres in.' });
    }

    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        gotrue_meta_security: {},
        options: redirectTo ? { email_redirect_to: redirectTo } : undefined
      })
    });

    const text = await authRes.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }

    if (!authRes.ok) {
      return sendJson(res, authRes.status, { error: authError(data), details: data });
    }

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('password-reset error:', err);
    return sendJson(res, 500, { error: 'Wachtwoord-reset mislukt: serverfout.' });
  }
}
