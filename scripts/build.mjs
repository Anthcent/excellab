// Builds the single-file site from src/:
//   index.html          full document, opens by double click (committed)
//   public/index.html   same document, served by the Fastify server (generated)
//   gridlab.html        fragment without doctype/head/body, used to publish as an artifact (committed)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const fill = (tpl, marker, text) => {
  if (!tpl.includes(marker)) throw new Error(`template is missing ${marker}`);
  return tpl.replace(marker, () => text);
};

const css = `${read('src/style.css').trimEnd()}\n${read('src/lab.css').trimEnd()}`;
const body = read('src/body.html').trimEnd();
const engine = read('src/engine.js').trimEnd();
const app = read('src/app.js').trimEnd();
// Lab UI (login, exams, staff console). Order matters: lab-core (pure logic) -> lab (shell, student) ->
// lab-staff (console shell and shared helpers) -> lab-admin (exercise editor) -> lab-exam (exam builder).
const labFiles = ['lab-core.js', 'lab.js', 'lab-staff.js', 'lab-admin.js', 'lab-exam.js'].map((name) => [name, read(`src/${name}`).trimEnd()]);
const lab = labFiles.map(([, text]) => text).join('\n</script>\n<script>\n');
for (const [name, text] of [['engine.js', engine], ['app.js', app], ...labFiles]) {
  if (/<\/script/i.test(text)) throw new Error(`${name} contains a closing script tag`);
}

let page = read('src/template.html');
page = fill(page, '/*{{CSS}}*/', css);
page = fill(page, '<!--{{BODY}}-->', body);
page = fill(page, '/*{{ENGINE}}*/', engine);
page = fill(page, '/*{{APP}}*/', app);
page = fill(page, '/*{{LAB}}*/', lab);

writeFileSync(join(root, 'index.html'), page);
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'index.html'), page);

// Artifact fragment: head links + style + body markup + one script (no doctype/html/head/body).
const head = read('src/template.html');
const links = head.slice(head.indexOf('<title>'), head.indexOf('<style>')).trimEnd();
const fragment = `${links}\n<style>\n${css}\n</style>\n\n${body}\n\n<script>\n${engine}\n</script>\n<script>\n${app}\n</script>\n<script>\n${lab}\n</script>\n`;
writeFileSync(join(root, 'gridlab.html'), fragment);

console.log(`built index.html + public/index.html (${(page.length / 1024).toFixed(0)} KB) and gridlab.html`);
