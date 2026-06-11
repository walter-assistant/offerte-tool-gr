const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function cleanText(value, max = 12000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function normalizeArticle(a) {
  return {
    lijst: String(a.lijst || '').slice(0, 80),
    categorie: String(a.categorie || '').slice(0, 80),
    code: String(a.code || '').slice(0, 40),
    omschrijving: String(a.omschrijving || '').slice(0, 180),
    eenheid: String(a.eenheid || '').slice(0, 30),
    prijs: Number(a.prijs) || 0
  };
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('AI gaf geen geldige JSON terug');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  try {
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return json(res, 500, { error: 'OPENAI_API_KEY ontbreekt op Vercel' });

    const body = req.body || {};
    const aanvraagText = cleanText(body.text, 16000);
    if (!aanvraagText) return json(res, 400, { error: 'Geen aanvraagtekst ontvangen' });

    const articles = (Array.isArray(body.articles) ? body.articles : [])
      .slice(0, 220)
      .map(normalizeArticle)
      .filter(a => a.omschrijving);

    const system = `Je bent een Nederlandse offerte-assistent voor Ground Research BV. Analyseer aanvraagmails voor bodemonderzoek/boringen/bodemenergie en geef alleen JSON terug.

Regels:
- Vul alleen velden als je ze redelijk zeker weet.
- Gok niet op bedragen of aantallen als ze niet genoemd zijn; gebruik aantal 1 als een werkzaamheid duidelijk gevraagd wordt maar aantal ontbreekt.
- Kies bestaande artikelen uitsluitend uit de meegegeven artikellijst. Als geen goede match bestaat: type custom.
- Geen markdown, geen uitleg buiten JSON.
- Zet onzekerheden in uncertainties.

JSON-schema:
{
  "klant": {"bedrijf":"", "contact":"", "adres":"", "postcode":"", "plaats":""},
  "project": {"naam":"", "kenmerk":"", "locatie":""},
  "opmerkingen":"",
  "regels":[
    {"type":"artikel|custom", "code":"", "omschrijving":"", "categorie":"", "eenheid":"Stuk", "prijs":0, "aantal":1, "reden":"", "confidence":0.0}
  ],
  "uncertainties":[""],
  "summary":"korte samenvatting"
}`;

    const user = JSON.stringify({ aanvraagText, beschikbareArtikelen: articles });
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_AANVRAAG_MODEL || 'gpt-4.1-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(res, response.status, { error: data.error?.message || 'AI analyse mislukt' });
    }

    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = safeJsonParse(content);
    return json(res, 200, { ok: true, result: parsed, usage: data.usage || null });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message || 'AI analyse fout' });
  }
};
