import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('../frontend/node_modules/typescript');
const source = readFileSync(new URL('../frontend/src/preferences.ts', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('../frontend/src/app/FirstReviewerDialog.tsx', import.meta.url), 'utf8');

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
      if (specifier === 'react') return { useSyncExternalStore: () => undefined };
      throw new Error('Unexpected import: ' + specifier);
    },
  });
  return { preferences: module.exports, values };
}

test('read-only reviewer choice persists and selecting a reviewer clears it', () => {
  const { preferences, values } = loadPreferences();
  assert.equal(preferences.isReviewerPromptDismissed(), false);
  preferences.dismissReviewerPrompt();
  assert.equal(preferences.isReviewerPromptDismissed(), true);
  assert.equal(values.get(preferences.REVIEWER_PROMPT_DISMISSED_STORAGE_KEY), 'true');

  preferences.setCurrentReviewer({ id: 7, name: 'Reviewer' });
  assert.equal(preferences.isReviewerPromptDismissed(), false);
  assert.equal(values.get('conflictstudio.reviewer.id'), '7');
  assert.equal(values.get('conflictstudio.reviewer.name'), 'Reviewer');
});

test('reviewer dialog uses the persistent read-only choice', () => {
  assert.match(dialogSource, /useState\(isReviewerPromptDismissed\)/u);
  assert.match(dialogSource, /dismissReviewerPrompt\(\);[\s\S]*setDismissed\(true\)/u);
  assert.match(source, /setCurrentReviewer[\s\S]*removeItem\(REVIEWER_PROMPT_DISMISSED_STORAGE_KEY\)/u);
});
