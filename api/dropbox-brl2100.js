const DROPBOX_API = 'https://api.dropboxapi.com/2';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';
const OFFERTE_BASE = process.env.DROPBOX_OFFERTE_BASE_PATH || '/werkmap/Offerte map';
const BRL2100_BASE = process.env.DROPBOX_BRL2100_BASE_PATH || '/Projecten met BRL2100';
const LINK_FILE = '.brl2100-koppeling.json';
const DAYS = { maandag:'Maandag', dinsdag:'Dinsdag', woensdag:'Woensdag', donderdag:'Donderdag', vrijdag:'Vrijdag', zaterdag:'Zaterdag', zondag:'Zondag' };

function required(name) { const value=String(process.env[name]||'').trim(); if(!value) throw new Error(`Missing env var: ${name}`); return value; }
function cleanPart(value,fallback) { return String(value||fallback||'').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').replace(/[. ]+$/g,'').trim().slice(0,120)||fallback; }
function normalizeName(value) { return String(value||'').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function projectKey(name) { return normalizeName(String(name||'').split(/\s+-\s+/)[0]||name); }
function normalizePath(path) { const clean=String(path||'').replace(/\\/g,'/').replace(/\/+/g,'/').replace(/\/$/,''); return clean.startsWith('/')?clean||'/':`/${clean}`; }
function joinPath(...parts) { return normalizePath(parts.join('/')); }

async function getAccessToken() {
  const auth=Buffer.from(`${required('DROPBOX_APP_KEY')}:${required('DROPBOX_APP_SECRET')}`).toString('base64');
  const res=await fetch('https://api.dropboxapi.com/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:required('DROPBOX_REFRESH_TOKEN')})});
  const json=await res.json().catch(()=>({})); if(!res.ok||!json.access_token) throw new Error(json.error_description||json.error||'Dropbox token refresh mislukt'); return json.access_token;
}
async function dropbox(token,endpoint,body) {
  const res=await fetch(`${DROPBOX_API}${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  const text=await res.text(); const json=text?JSON.parse(text):null; if(!res.ok) throw new Error(json?.error_summary||json?.error?.['.tag']||text||`Dropbox ${res.status}`); return json;
}
async function createFolder(token,path) { try { await dropbox(token,'/files/create_folder_v2',{path:normalizePath(path),autorename:false}); } catch(err) { if(!/conflict|already_exists/i.test(err.message||'')) throw err; } }
async function ensureFolder(token,path) { let current=''; for(const segment of normalizePath(path).split('/').filter(Boolean)){current+=`/${segment}`;await createFolder(token,current);} }
async function listFolders(token,path) { try { const data=await dropbox(token,'/files/list_folder',{path:normalizePath(path),recursive:false,include_deleted:false}); return (data.entries||[]).filter(x=>x['.tag']==='folder'); } catch(err) { if(/not_found/i.test(err.message||'')) return []; throw err; } }
async function getMetadata(token,path) { try { return await dropbox(token,'/files/get_metadata',{path:normalizePath(path)}); } catch(err) { if(/not_found/i.test(err.message||'')) return null; throw err; } }
function findFolder(folders,wanted,projectMode) { const norm=normalizeName(wanted),key=projectKey(wanted); return folders.find(x=>projectMode?projectKey(x.name)===key:normalizeName(x.name)===norm); }
async function resolveSource(token,customerName,projectFolderName) {
  const customer=findFolder(await listFolders(token,OFFERTE_BASE),cleanPart(customerName,''),false); if(!customer) throw new Error('Klantmap niet gevonden in de Offerte map');
  const customerPath=customer.path_display||customer.path_lower; const project=findFolder(await listFolders(token,customerPath),cleanPart(projectFolderName,''),true); if(!project) throw new Error('Projectmap niet gevonden. Maak eerst minimaal één offerte-PDF.');
  return {customer:customer.name,project:project.name,path:project.path_display||project.path_lower};
}
async function uploadJson(token,path,value) {
  const res=await fetch(`${DROPBOX_CONTENT}/files/upload`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify({path:normalizePath(path),mode:'overwrite',autorename:false,mute:true})},body:Buffer.from(JSON.stringify(value,null,2))});
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data?.error_summary||'Koppeling opslaan mislukt');
}
async function copyFolder(token,from,to) {
  const result=await dropbox(token,'/files/copy_v2',{from_path:normalizePath(from),to_path:normalizePath(to),autorename:false}); if(!result.async_job_id) return;
  for(let i=0;i<30;i++){await new Promise(resolve=>setTimeout(resolve,500));const status=await dropbox(token,'/files/copy_batch/check_v2',{async_job_id:result.async_job_id});if(status['.tag']==='complete')return;if(status['.tag']==='failed')throw new Error('Dropbox kon de projectmap niet kopiëren');}
}

module.exports=async function handler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try {
    const body=req.body||{};const day=DAYS[normalizeName(body.day)];if(!day)throw new Error('Kies een geldige werkdag');
    const token=await getAccessToken();const source=await resolveSource(token,body.customerName,body.projectFolderName);const dayPath=joinPath(BRL2100_BASE,day);await ensureFolder(token,dayPath);
    const destinationPath=joinPath(dayPath,source.project);if(await getMetadata(token,destinationPath))throw new Error(`Dit project staat al bij ${day}`);
    await copyFolder(token,source.path,destinationPath);
    await uploadJson(token,joinPath(source.path,LINK_FILE),{type:'brl2100-mirror',day,sourcePath:source.path,destinationPath,customer:source.customer,project:source.project,linkedAt:new Date().toISOString()});
    return res.status(200).json({ok:true,day,sourcePath:source.path,destinationPath});
  } catch(err) { console.error(err);return res.status(500).json({error:err.message||'Dropbox fout'}); }
};
