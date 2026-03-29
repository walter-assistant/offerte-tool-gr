const fs = require('fs');
const htmlPath = 'C:/Users/Walter/.openclaw/workspace/offerte-tool-gr/index.html';
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(
  "cats[cat].sort((a,b) => (a[5]*1||0)-(b[5]*1||0)).forEach",
  "cats[cat].sort((a,b) => a[3].localeCompare(b[3],'nl')).forEach"
);
fs.writeFileSync(htmlPath, html, 'utf8');
fs.copyFileSync(htmlPath, 'C:/Users/Walter/.openclaw/workspace/offerte-tool-gr/public/index.html');
console.log('Done');
