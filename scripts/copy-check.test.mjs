import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectCopyFailures } from './copy-check.mjs';

const validTimeSource = [
  "const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';",
  'const full = parts => `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;',
  'const short = parts => `${parts.hour}:${parts.minute}:${parts.second}`;',
].join('\n');
const enUSSource = readFileSync(new URL('../frontend/src/locales/en-US.ts', import.meta.url), 'utf8');
const zhCNSource = readFileSync(new URL('../frontend/src/locales/zh-CN.ts', import.meta.url), 'utf8');
const generationLocaleSource = readFileSync(new URL('../frontend/src/locales/features/generation.ts', import.meta.url), 'utf8');
const workspaceLocaleSource = readFileSync(new URL('../frontend/src/locales/features/workspaceSettingsStatistics.ts', import.meta.url), 'utf8');
const reviewLocaleSource = readFileSync(new URL('../frontend/src/locales/features/reviewArchive.ts', import.meta.url), 'utf8');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'conflictstudio-copy-check-'));
  const source = join(root, 'frontend', 'src');
  mkdirSync(join(source, 'locales'), { recursive: true });
  writeFileSync(join(source, 'time.ts'), validTimeSource, 'utf8');
  writeFileSync(join(source, 'locales', 'en-US.ts'), "export const copy = { ready: 'Ready' };\n", 'utf8');
  writeFileSync(join(source, 'locales', 'zh-CN.ts'), "export const copy = { ready: '就绪' };\n", 'utf8');
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(source, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
}

function withFixture(files, action) {
  const root = fixture(files);
  try {
    action(collectCopyFailures(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('ignores TypeScript generics, arrows, and comparisons around JSX', () => {
  withFixture({
    'FalsePositives.tsx': `
      const draft = readGenerationDraft<BatchForm>('batch-form');
      const valid = quantity > 0 && seed < 100;
      export function View() {
        if (queries.some(query => query.isPending)) return <p>{g('state.loadingBody')}</p>;
        return <button aria-label={g('actions.save')}>{g('actions.save')}</button>;
      }
      void draft;
      void valid;
    `,
  }, failures => assert.deepEqual(failures, []));
});

test('reports JSX text and static visible attributes and expressions', () => {
  withFixture({
    'VisibleCopy.tsx': `
      export const view = <section>
        Visible body
        <input aria-label="Literal label" title={'Literal title'} />
        <span>{'Static expression'}</span>
      </section>;
    `,
  }, failures => {
    const visible = failures.filter(value => value.includes('hard-coded visible copy'));
    assert.equal(visible.length, 4);
    assert.equal(visible.some(value => value.endsWith('Visible body')), true);
    assert.equal(visible.some(value => value.endsWith('Literal label')), true);
    assert.equal(visible.some(value => value.endsWith('Literal title')), true);
    assert.equal(visible.some(value => value.endsWith('Static expression')), true);
  });
});

test('reports visible delimiters and ignores code expressions', () => {
  withFixture({
    'Delimiters.tsx': `
      const value = <T,>(input: T) => input;
      export const view = <p>Read · review — now</p>;
    `,
  }, failures => {
    assert.equal(failures.some(value => value.includes('visible delimiter')), true);
    assert.equal(failures.some(value => value.includes('hard-coded visible copy')), true);
    assert.equal(failures.some(value => value.includes('T,>')), false);
  });
});

test('keeps blocked, mixed-language, and local-time checks active', () => {
  withFixture({
    'Blocked.tsx': 'export const view = <p>Seamless workflow</p>;',
    'BadTime.ts': 'export const badTime = value => value.toLocaleString();',
    'locales/en-US.ts': "export const copy = { bad: '中文' };\n",
    'locales/zh-CN.ts': "export const copy = { bad: 'English' };\n",
  }, failures => {
    assert.equal(failures.some(value => value.includes('blocked copy: Seamless')), true);
    assert.equal(failures.some(value => value.includes('local time formatting bypass')), true);
    assert.equal(failures.filter(value => value.includes('mixed language')).length, 2);
  });
  assert.match(workspaceLocaleSource, /datasetCount_one: '\{\{count\}\} dataset'/u);
});

test('generation English copy has singular and plural counts', () => {
  assert.match(generationLocaleSource, /combinationCount_one': '\{\{count\}\} combination'/u);
  assert.match(generationLocaleSource, /seedCount_one': '\{\{count\}\} seed'/u);
  assert.match(generationLocaleSource, /videoCount_one': '\{\{count\}\} video'/u);
});

test('dataset states and review gate guidance have complete English and Chinese copy', () => {
  assert.match(enUSSource, /dataset: \{ Active: 'Active', Disabled: 'Disabled', Inactive: 'Inactive' \}/u);
  assert.match(zhCNSource, /dataset: \{ Active: '已启用', Disabled: '已禁用', Inactive: '已停用' \}/u);
  assert.match(reviewLocaleSource, /title: 'Reviewer required'[\s\S]*title: '需要审核人'/u);
  assert.match(reviewLocaleSource, /body: 'Reviews in this workspace use the fixed reviewer \{\{name\}\}\.'/u);
  assert.doesNotMatch(`${enUSSource}\n${zhCNSource}`, /continueReadOnly|readOnlyHint/u);
  assert.match(workspaceLocaleSource, /Disabled: 'Disabled',[\s\S]*?Inactive: 'Inactive'/u);
  assert.match(workspaceLocaleSource, /Disabled: '已禁用',[\s\S]*?Inactive: '已停用'/u);
});

test('pagination copy avoids repeating page and handles singular records', () => {
  assert.match(enUSSource, /summary: 'Page \{\{page\}\} of \{\{totalPages\}\}, \{\{recordCount\}\}'/u);
  assert.doesNotMatch(enUSSource, /pageCount_(?:one|other)/u);
  assert.match(enUSSource, /recordCount_one: '\{\{count\}\} record'/u);
  assert.match(enUSSource, /recordCount_other: '\{\{count\}\} records'/u);
});
