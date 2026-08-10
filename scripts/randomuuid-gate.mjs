import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
