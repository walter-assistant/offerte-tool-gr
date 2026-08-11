const SUPABASE_URL = 'https://varflklvllrnrzhnbbpg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_U1N34WcxGPZSf9qDSHTC2g_2Ah_yR3s';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function supabaseAuth(path, payload) {
  const authRes = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await authRes.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
  return { ok: authRes.ok, status: authRes.status, data };
}

function authError(data) {
  const raw = data.error_description || data.msg || data.message || data.error || data.code || 'Login mislukt.';
  const text = String(raw);
  if (/invalid login credentials/i.test(text)) return 'E-mailadres of wachtwoord klopt niet.';
  if (/email not confirmed/i.test(text)) return 'E-mailadres is nog niet bevestigd. Check je mail.';
  if (/too many|rate limit/i.test(text)) return 'Te veel pogingen. Probeer later opnieuw of gebruik Inloglink mailen.';
  if (/signup.*disabled/i.test(text)) return 'Account aanmaken staat uit. Gebruik Inloggen of Inloglink mailen.';
  return text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  try {
    const body = await readJson(req);
    const action = String(body.action || 'login');
    const email = String(body.email || '').trim();
    const password = String(body.password || '');

    if (!email || !email.includes('@') || !password) {
      return sendJson(res, 400, { error: 'Vul e-mailadres en wachtwoord in.' });
    }

    const result = action === 'signup'
      ? await supabaseAuth('/auth/v1/signup', { email, password })
      : await supabaseAuth('/auth/v1/token?grant_type=password', { email, password });

    if (!result.ok) {
      return sendJson(res, result.status, { error: authError(result.data), details: result.data });
    }

    return sendJson(res, 200, result.data);
  } catch (err) {
    console.error('auth proxy error:', err);
    return sendJson(res, 500, { error: 'Login mislukt: serverfout.' });
  }
}
