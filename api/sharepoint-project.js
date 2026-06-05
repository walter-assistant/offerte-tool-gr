const GRAPH = 'https://graph.microsoft.com/v1.0';
const BASE_PATH = 'werkmap/Offerte map';
const TEMPLATE_PATH = `${BASE_PATH}/02 Standaard mappen structuur`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function cleanPart(value, fallback) {
  return String(value || fallback || '')
    .normalize('NFKC')
    .replace(/[~"#%&*:<>?/\\{|}\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || fallback;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function getToken() {
  const body = new URLSearchParams({
    client_id: required('MS_CLIENT_ID'),
    scope: process.env.MS_SCOPE || 'https://graph.microsoft.com/.default',
    username: required('MS_USERNAME'),
    password: required('MS_PASSWORD'),
    grant_type: 'password'
  });
  if (process.env.MS_CLIENT_SECRET) body.set('client_secret', process.env.MS_CLIENT_SECRET);

  const res = await fetch(`https://login.microsoftonline.com/${required('MS_TENANT_ID')}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || 'Token request failed');
  return json.access_token;
}

async function graph(token, path, options = {}) {
  const res = await fetch(`${GRAPH}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || text || `Graph ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return { json, res };
}

async function getDrive(token) {
  const hostname = required('SHAREPOINT_HOSTNAME');
  const sitePath = required('SHAREPOINT_SITE_PATH');
  const { json: site } = await graph(token, `/sites/${hostname}:${sitePath}`);
  const { json: drives } = await graph(token, `/sites/${site.id}/drives`);
  const drive = drives.value.find(d => d.name === 'Documents' || d.name === 'Shared Documents');
  if (!drive) throw new Error('Documents library niet gevonden');
  return drive;
}

async function getItemByPath(token, driveId, path) {
  try {
    const { json } = await graph(token, `/drives/${driveId}/root:/${encodePath(path)}`);
    return json;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function createFolder(token, driveId, parentPath, name) {
  const parent = await getItemByPath(token, driveId, parentPath);
  if (!parent) throw new Error(`Map niet gevonden: ${parentPath}`);
  const { json } = await graph(token, `/drives/${driveId}/items/${parent.id}/children`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
  }).catch(async err => {
    if (err.status === 409) return { json: await getItemByPath(token, driveId, `${parentPath}/${name}`) };
    throw err;
  });
  return json;
}

async function ensureProject(token, drive) {
  const template = await getItemByPath(token, drive.id, TEMPLATE_PATH);
  if (!template) throw new Error(`Template-map niet gevonden: ${TEMPLATE_PATH}`);

  const customer = cleanPart(this.customerName, 'Onbekende klant');
  const project = cleanPart(this.projectFolderName, 'Nieuw project');
  const customerPath = `${BASE_PATH}/${customer}`;
  const projectPath = `${customerPath}/${project}`;

  await createFolder(token, drive.id, BASE_PATH, customer);
  let projectItem = await getItemByPath(token, drive.id, projectPath);
  let created = false;

  if (!projectItem) {
    const customerItem = await getItemByPath(token, drive.id, customerPath);
    await graph(token, `/drives/${drive.id}/items/${template.id}/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parentReference: { driveId: drive.id, id: customerItem.id }, name: project })
    });
    created = true;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      projectItem = await getItemByPath(token, drive.id, projectPath);
      if (projectItem) break;
    }
  }

  if (!projectItem) throw new Error('SharePoint kopie loopt nog; probeer over enkele seconden opnieuw.');
  return { customer, project, projectPath, projectItem, created };
}

async function uploadPdf(token, drive, folderPath, filename, base64) {
  const safeName = cleanPart(filename, 'Offerte.pdf').replace(/\.pdf$/i, '') + '.pdf';
  const bytes = Buffer.from(base64, 'base64');
  const { json } = await graph(token, `/drives/${drive.id}/root:/${encodePath(`${folderPath}/Offerte/${safeName}`)}:/content`, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: bytes
  });
  return json;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body || {};
    const token = await getToken();
    const drive = await getDrive(token);
    const ctx = {
      customerName: body.customerName,
      projectFolderName: body.projectFolderName
    };
    const project = await ensureProject.call(ctx, token, drive);
    let pdf = null;
    if (body.pdfBase64) {
      pdf = await uploadPdf(token, drive, project.projectPath, body.filename, body.pdfBase64);
    }
    return res.status(200).json({
      ok: true,
      created: project.created,
      customer: project.customer,
      project: project.project,
      path: project.projectPath,
      webUrl: project.projectItem.webUrl,
      pdfUrl: pdf?.webUrl || null
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'SharePoint fout' });
  }
};
