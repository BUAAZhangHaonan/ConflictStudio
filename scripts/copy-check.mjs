import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const sourceRoot = join(projectRoot, 'frontend', 'src');
const localeRoot = join(sourceRoot, 'locales');

const blockedPatterns = [
  /赋能/u,
  /智能/u,
  /一站式/u,
  /全链路/u,
  /无缝/u,
  /解锁/u,
  /探索/u,
  /旅程/u,
  /重新定义/u,
  /为你/u,
  /懂你/u,
  /助力/u,
  /轻松/u,
  /极速/u,
  /强大/u,
  /未来/u,
  /革新/u,
  /\bempower(?:ed|ing|ment)?\b/iu,
  /\bseamless(?:ly)?\b/iu,
  /\beffortless(?:ly)?\b/iu,
  /\bunlock(?:ed|ing)?\b/iu,
  /\bjourney\b/iu,
  /\btransform(?:ed|ing|ation)?\b/iu,
  /\breimagine(?:d)?\b/iu,
  /\bpowerful\b/iu,
  /image-text/iu,
  /\bSVT\b/u,
  /\bGLM\b/u,
  /Z-Image/iu,
  /\bZIP\b/iu,
  /\bB(?:\s*[·-]|\s+class\b|类)/iu,
  /(?:^|["'\s])\/api(?:\/|\b)/iu,
  /\b(?:POST|PUT|PATCH|DELETE)\s+\//u,
  /[A-Za-z]:\\[^\s"']+/u,
  /\/home\/[^\s"']+/u,
];

const technicalTokens = [
  'ConflictStudio',
  'A-VA',
  'A-VT',
  'C-VA',
  'C-VT',
  'A ·',
  'C ·',
  'VA',
  'VT',
  'LTX-2.3',
  'MiniMax H3',
  'GPU0',
  'GPU1',
  'GPU',
  'JSONL',
  'MP4',
  'A100',
  'CH-SIMS v2',
  'Ctrl',
  'Cmd',
  'Enter',
  'J',
  'K',
];

function filesUnder(directory, acceptedExtensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(fullPath, acceptedExtensions);
    return acceptedExtensions.has(extname(entry.name)) ? [fullPath] : [];
  });
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/u).length;
}

function withoutTechnicalTokens(value) {
  let output = value.replace(/\{\{[^}]+\}\}/gu, '');
  for (const token of technicalTokens.sort((a, b) => b.length - a.length)) {
    output = output.split(token).join('');
  }
  return output;
}

function isChineseLocaleValue(file, source, index) {
  const localeExports = [...source.matchAll(/^export const \w+(EnUS|ZhCN)\s*=/gmu)];
  if (localeExports.length > 0) {
    const activeExport = localeExports.findLast(match => match.index <= index);
    return activeExport?.[1] === 'ZhCN';
  }
  return file.endsWith('zh-CN.ts');
}

const failures = [];
const localeFiles = filesUnder(localeRoot, new Set(['.ts']));
const jsxFiles = filesUnder(sourceRoot, new Set(['.tsx']));

for (const file of [...localeFiles, ...jsxFiles]) {
  const source = readFileSync(file, 'utf8');
  for (const pattern of blockedPatterns) {
    const match = pattern.exec(source);
    if (match) {
      failures.push(`${relative(projectRoot, file)}:${lineNumber(source, match.index)} blocked copy: ${match[0]}`);
    }
    pattern.lastIndex = 0;
  }
}

for (const file of jsxFiles) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const visibleText = [
      ...line.matchAll(/>([^<>{}]+)</gu),
      ...line.matchAll(/>\s*\{["'`]([^"'`]+)["'`]\}\s*</gu),
      ...line.matchAll(/\b(?:aria-label|title|alt|placeholder|label|caption|description|message)=["']([^"']+)["']/gu),
      ...line.matchAll(/\b(?:aria-label|title|alt|placeholder)=\{\s*["'`]([^"'`]+)["'`]\s*\}/gu),
    ];
    for (const match of visibleText) {
      if (/^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/u.test(match[1])) continue;
      const value = withoutTechnicalTokens(match[1]).replace(/[\s\d.,:;!?()（）·—–\-+/%×●○✓▶☰*]/gu, '');
      if (value.length > 0) {
        failures.push(`${relative(projectRoot, file)}:${index + 1} hard-coded visible copy: ${match[1].trim()}`);
      }
    }
    if (/document\.title\s*=/u.test(line) && !/\bt\(\s*['"]/u.test(line)) {
      failures.push(`${relative(projectRoot, file)}:${index + 1} document title is not localized`);
    }
    if (/\b(?:showToast|window\.confirm)\(\s*["'`]/u.test(line)) {
      failures.push(`${relative(projectRoot, file)}:${index + 1} hard-coded visible message`);
    }
  });
}

for (const file of localeFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/:\s*'([^']*)'/gu)) {
    const value = withoutTechnicalTokens(match[1]);
    const isChinese = isChineseLocaleValue(file, source, match.index);
    if (isChinese && /[A-Za-z]/u.test(value)) {
      failures.push(`${relative(projectRoot, file)}:${lineNumber(source, match.index)} mixed language: ${match[1]}`);
    }
    if (!isChinese && /[\u3400-\u9fff]/u.test(value)) {
      failures.push(`${relative(projectRoot, file)}:${lineNumber(source, match.index)} mixed language: ${match[1]}`);
    }
  }
}

if (!existsSync(sourceRoot)) failures.push('frontend/src is missing');

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Static copy check passed.');
}
