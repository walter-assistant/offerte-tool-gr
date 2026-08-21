const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const OFFERTE_BASE = process.env.DROPBOX_OFFERTE_BASE_PATH || '/werkmap/Offerte map';
const LINK_FILE = '.brl2100-koppeling.json';
const MAX_CHANGED_FILE_BYTES = 40 * 1024 * 1024;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function normalizePath(path) {
  const clean = String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return clean.startsWith('/') ? clean || '/' : `/${clean}`;
}

function joinPath(...parts) {
  return normalizePath(parts.join('/'));
}

async function getAccessToken() {
  const auth = Buffer.from(`${required('DROPBOX_APP_KEY')}:${required('DROPBOX_APP_SECRET')}`).toString('base64');
  const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: required('DROPBOX_REFRESH_TOKEN') })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || 'Dropbox token refresh mislukt');
  return data.access_token;
}

async function dropbox(token, endpoint, body) {
  const response = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error_summary || text || `Dropbox ${response.status}`);
  return data;
}

async function listRecursive(token, path) {
  let data = await dropbox(token, '/files/list_folder', {
    path: normalizePath(path), recursive: true, include_deleted: false, include_non_downloadable_files: false
  });
  const entries = [...(data.entries || [])];
  while (data.has_more) {
    data = await dropbox(token, '/files/list_folder/continue', { cursor: data.cursor });
    entries.push(...(data.entries || []));
  }
  return entries;
}

async function createFolder(token, path) {
  try {
    await dropbox(token, '/files/create_folder_v2', { path: normalizePath(path), autorename: false });
  } catch (error) {
    if (!/conflict|already_exists/i.test(error.message || '')) throw error;
  }
}

async function download(token, path) {
  const response = await fetch(`${DROPBOX_CONTENT}/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: normalizePath(path) }) }
  });
  if (!response.ok) throw new Error(`Download mislukt: ${path}`);
  return Buffer.from(await response.arrayBuffer());
}

async function uploadOverwrite(token, path, bytes) {
  const response = await fetch(`${DROPBOX_CONTENT}/files/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: normalizePath(path), mode: 'overwrite', autorename: false, mute: true })
    },
    body: bytes
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error_summary || `Upload mislukt: ${path}`);
}

async function readLink(token, entry) {
  try {
    const value = JSON.parse((await download(token, entry.path_display || entry.path_lower)).toString('utf8'));
    return value?.type === 'brl2100-mirror' && value.sourcePath && value.destinationPath ? value : null;
  } catch (_) {
    return null;
  }
}

async function syncLink(token, link) {
  const sourcePath = normalizePath(link.sourcePath);
  const destinationPath = normalizePath(link.destinationPath);
  const [sourceEntries, destinationEntries] = await Promise.all([
    listRecursive(token, sourcePath),
    listRecursive(token, destinationPath).catch(error => /not_found/i.test(error.message || '') ? [] : Promise.reject(error))
  ]);
  const destinationByRelativePath = new Map(destinationEntries.map(entry => [
    (entry.path_lower || '').slice(destinationPath.toLowerCase().length), entry
  ]));
  const result = { project: link.project || sourcePath.split('/').pop(), copied: 0, updated: 0, unchanged: 0, errors: [] };

  for (const entry of sourceEntries) {
    const sourceEntryPath = entry.path_display || entry.path_lower;
    const relativePath = (entry.path_lower || '').slice(sourcePath.toLowerCase().length);
    if (!relativePath || relativePath.toLowerCase() === `/${LINK_FILE}`) continue;
    const targetPath = joinPath(destinationPath, relativePath);
    const existing = destinationByRelativePath.get(relativePath);
    try {
      if (entry['.tag'] === 'folder') {
        if (!existing) await createFolder(token, targetPath);
        continue;
      }
      if (entry['.tag'] !== 'file') continue;
      if (existing?.['.tag'] === 'file' && existing.content_hash === entry.content_hash) {
        result.unchanged++;
        continue;
      }
      if (!existing) {
        await dropbox(token, '/files/copy_v2', { from_path: sourceEntryPath, to_path: targetPath, autorename: false });
        result.copied++;
        continue;
      }
      if (entry.size > MAX_CHANGED_FILE_BYTES) throw new Error('Gewijzigd bestand is groter dan 40 MB');
      await uploadOverwrite(token, targetPath, await download(token, sourceEntryPath));
      result.updated++;
    } catch (error) {
      result.errors.push({ path: relativePath, error: error.message || 'Onbekende fout' });
    }
  }
  return result;
}

function isAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  return secret && req.headers.authorization === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = await getAccessToken();
    const entries = await listRecursive(token, OFFERTE_BASE);
    const linkEntries = entries.filter(entry => entry['.tag'] === 'file' && entry.name === LINK_FILE);
    const links = (await Promise.all(linkEntries.map(entry => readLink(token, entry)))).filter(Boolean);
    const projects = [];
    for (const link of links) projects.push(await syncLink(token, link));
    const totals = projects.reduce((sum, item) => ({
      copied: sum.copied + item.copied,
      updated: sum.updated + item.updated,
      unchanged: sum.unchanged + item.unchanged,
      errors: sum.errors + item.errors.length
    }), { copied: 0, updated: 0, unchanged: 0, errors: 0 });
    return res.status(totals.errors ? 207 : 200).json({ ok: totals.errors === 0, linkedProjects: links.length, totals, projects });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Dropbox-sync mislukt' });
  }
};

