import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const source = readFileSync(new URL('../frontend/src/preferences.ts', import.meta.url), 'utf8');
const gateSource = readFileSync(new URL('../frontend/src/app/ReviewGate.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../frontend/src/app/App.tsx', import.meta.url), 'utf8');

function loadPreferences(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as Record<string, any> };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    window: { localStorage },
    require: (specifier: string) => {
      if (specifier === 'react') return { useEffect: () => undefined, useSyncExternalStore: () => undefined };
      if (specifier === './api/client') return { ApiError: class ApiError extends Error {} };
      if (specifier === './api/queries') return { useReviewerQuery: () => undefined, useReviewersQuery: () => undefined };
      throw new Error('Unexpected import: ' + specifier);
    },
  });
  return { preferences: module.exports, values };
}

test('reviewer selection persists and clears without a read-only bypass', () => {
  const { preferences, values } = loadPreferences();
  preferences.setCurrentReviewer({ id: 7, name: 'Reviewer' });
  assert.equal(values.get('conflictstudio.reviewer.id'), '7');
  assert.equal(values.get('conflictstudio.reviewer.name'), 'Reviewer');
  preferences.setCurrentReviewer(null);
  assert.equal(values.has('conflictstudio.reviewer.id'), false);
  assert.equal(values.has('conflictstudio.reviewer.name'), false);
  assert.doesNotMatch(source, /reviewer\.readOnly|PROMPT_DISMISSED|dismissReviewerPrompt|isReviewerPromptDismissed/u);
});

test('review routes resolve the reviewer from stored preferences and allow guests', () => {
  assert.match(appSource, /<Route element=\{<ReviewGate \/>\}>[\s\S]*path="\/review"[\s\S]*path="\/review\/:sampleId"/u);
  assert.doesNotMatch(appSource, /FirstReviewerDialog/u);
  assert.match(gateSource, /const \{ currentReviewer, isPending, error, retry \} = useReviewerState\(\)/u);
  assert.match(gateSource, /reviewer: Reviewer \| null/u);
  assert.match(gateSource, /review\.gate\.guestBody/u);
  assert.match(gateSource, /<Link to="\/settings">/u);
  assert.match(gateSource, /<Outlet context=\{\{ reviewer: currentReviewer \}/u);
  assert.doesNotMatch(gateSource, /FIXED_REVIEWER_NAME|useReviewerByNameQuery|zhanghaonan/u);
  assert.doesNotMatch(gateSource, /reviewers\.map|type="radio"|<input|<Pagination|maxLength|readOnly|dismiss/u);
});

test('frontend sources contain no hardcoded reviewer name', () => {
  const srcRoot = new URL('../frontend/src/', import.meta.url);
  const offenderPaths: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) walk(entryUrl);
      else if (/\.(tsx?|css)$/u.test(entry.name)) {
        if (readFileSync(entryUrl, 'utf8').includes('zhanghaonan')) offenderPaths.push(entry.name);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenderPaths, []);
});
