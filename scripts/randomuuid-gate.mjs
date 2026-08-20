import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const distRoot = join(projectRoot, 'frontend', 'dist');
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json']);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(fullPath);
    return textExtensions.has(extname(entry.name)) ? [fullPath] : [];
  });
}

if (!existsSync(distRoot)) {
  console.error('frontend/dist is missing. Run the build first.');
  process.exit(1);
}

const failures = [];
const entryScript = join(distRoot, 'assets', 'app.js');
if (!existsSync(entryScript)) {
  failures.push('frontend/dist/assets/app.js is missing');
} else if (statSync(entryScript).size >= 450_000) {
  failures.push(`frontend/dist/assets/app.js is ${statSync(entryScript).size} bytes; route splitting is not effective`);
}
for (const chunkName of ['GeneratePage.js', 'ReviewListPage.js', 'ReviewDetailPage.js', 'ArchivePage.js', 'SettingsPage.js', 'StatisticsPage.js']) {
  if (!existsSync(join(distRoot, 'assets', chunkName))) {
    failures.push(`frontend/dist/assets/${chunkName} is missing`);
  }
}
for (const file of filesUnder(distRoot)) {
  const source = readFileSync(file, 'utf8');
  const index = source.indexOf('randomUUID');
  if (index !== -1) {
    const line = source.slice(0, index).split(/\r?\n/u).length;
    failures.push(`${relative(projectRoot, file)}:${line} contains randomUUID`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Built artifact gate passed.');
