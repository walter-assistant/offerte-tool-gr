const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const BASE_PATH = process.env.DROPBOX_OFFERTE_BASE_PATH || '/werkmap/Offerte map';
const STANDARD_FOLDERS = [
  'Bodemonderzoek',
  'Bodemopbouw dino',
  'Boorprofiel',
  'dag rapport',
  'EED',
  "Foto's",
  'ITge',
  'Klic',
  'Mail',
  'Offerte',
  'OLO',
  'Ontwerp',
  'Oplever rapportage',
  'Plan van aanpak',
  'SPF verklaring',
  'Tekening',
  'Werkbeschrijving 2100',
  'WKO Tool'
];

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function cleanPart(value, fallback) {
  return String(value || fallback || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || fallback;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function projectKey(name) {
  return normalizeName(String(name || '').split(/\s+-\s+/)[0] || name);
}

function normalizePath(path) {
  const clean = String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return clean.startsWith('/') ? clean || '/' : `/${clean}`;
}

function joinPath(...parts) {
  return normalizePath(parts.join('/'));
}

async function getAccessToken() {
  const auth = Buffer.from(`${required('DROPBOX_APP_KEY')}:${required('DROPBOX_APP_SECRET')}`).toString('base64');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: required('DROPBOX_REFRESH_TOKEN')
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || 'Dropbox token refresh mislukt');
  }
  return json.access_token;
}

async function dropbox(token, endpoint, body) {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(json?.error_summary || json?.error?.['.tag'] || text || `Dropbox ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function createFolder(token, path) {
  const folderPath = normalizePath(path);
  if (!folderPath || folderPath === '/') return;
  try {
    await dropbox(token, '/files/create_folder_v2', { path: folderPath, autorename: false });
  } catch (err) {
    const msg = `${err.message || ''} ${JSON.stringify(err.body || {})}`;
    if (/conflict|already_exists|path\/conflict\/folder/i.test(msg)) return;
    throw err;
  }
}

async function ensureFolder(token, path) {
  const segments = normalizePath(path).split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current += `/${segment}`;
    await createFolder(token, current);
  }
}

async function listFolders(token, path) {
  try {
    const json = await dropbox(token, '/files/list_folder', { path: normalizePath(path), recursive: false, include_deleted: false });
    return (json.entries || []).filter(entry => entry['.tag'] === 'folder');
  } catch (err) {
    if (/not_found/i.test(err.message || '')) return [];
    throw err;
  }
}

async function getMetadata(token, path) {
  try {
    return await dropbox(token, '/files/get_metadata', { path: normalizePath(path) });
  } catch (err) {
    if (/not_found/i.test(err.message || '')) return null;
    throw err;
  }
}

function findMatchingFolder(folders, wantedName, projectMode = false) {
  const wantedNorm = normalizeName(wantedName);
  const wantedKey = projectKey(wantedName);
  return folders.find(item => {
    const nameNorm = normalizeName(item.name);
    if (nameNorm === wantedNorm) return true;
    if (!projectMode) return nameNorm.startsWith(`${wantedNorm} `) || wantedNorm.startsWith(`${nameNorm} `);
    const key = projectKey(item.name);
    return key === wantedKey || key.startsWith(`${wantedKey} `) || wantedKey.startsWith(`${key} `);
  });
}

async function resolveCustomerFolder(token, wantedName) {
  const wanted = cleanPart(wantedName, 'Onbekende klant');
  await ensureFolder(token, BASE_PATH);

  const wantedNorm = normalizeName(wanted);
  const folders = await listFolders(token, BASE_PATH);
  const match = findMatchingFolder(folders, wanted, false);

  if (match) return { name: match.name, path: match.path_display || match.path_lower, created: false };

  const path = joinPath(BASE_PATH, wanted);
  await createFolder(token, path);
  return { name: wanted, path, created: true };
}

async function resolveProjectFolder(token, customerPath, projectFolderName) {
  await ensureFolder(token, customerPath);
  const wanted = cleanPart(projectFolderName, 'Nieuw project');
  const folders = await listFolders(token, customerPath);
  const match = findMatchingFolder(folders, wanted, true);
  if (match) return { name: match.name, path: match.path_display || match.path_lower, created: false };
  const path = joinPath(customerPath, wanted);
  await ensureFolder(token, path);
  return { name: wanted, path, created: true };
}

async function getVersionedFilePath(token, requestedPath) {
  const path = normalizePath(requestedPath);
  if (!(await getMetadata(token, path))) return path;
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let version = 2; version < 100; version++) {
    const candidate = joinPath(dir, `${base} - v${version}${ext}`);
    if (!(await getMetadata(token, candidate))) return candidate;
  }
  return joinPath(dir, `${base} - v${Date.now()}${ext}`);
}

async function uploadPdf(token, filePath, base64) {
  const finalPath = await getVersionedFilePath(token, filePath);
  const bytes = Buffer.from(base64, 'base64');
  const res = await fetch(`${DROPBOX_CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: finalPath,
        mode: 'add',
        autorename: false,
        mute: true,
        strict_conflict: true
      })
    },
    body: bytes
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error_summary || 'Dropbox upload mislukt');
  return { ...data, requested_path: normalizePath(filePath), versioned: finalPath !== normalizePath(filePath) };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const customerName = cleanPart(body.customerName, 'Onbekende klant');
    const projectFolderName = cleanPart(body.projectFolderName, 'Nieuw project');
    const filename = cleanPart(body.filename, 'Offerte.pdf').replace(/\.pdf$/i, '') + '.pdf';

    const token = await getAccessToken();
    const customer = await resolveCustomerFolder(token, customerName);
    const project = await resolveProjectFolder(token, customer.path, projectFolderName);
    const projectPath = project.path;

    for (const folder of STANDARD_FOLDERS) {
      await createFolder(token, joinPath(projectPath, folder));
    }

    let pdf = null;
    if (body.pdfBase64) {
      const pdfPath = joinPath(projectPath, 'Offerte', filename);
      pdf = await uploadPdf(token, pdfPath, body.pdfBase64);
    }

    return res.status(200).json({
      ok: true,
      customer: customer.name,
      project: project.name,
      path: projectPath,
      pdfPath: pdf?.path_display || null,
      versioned: pdf?.versioned || false,
      folders: STANDARD_FOLDERS
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Dropbox fout' });
  }
};
