import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatCompactDateTime,
  formatDate,
  formatDateTime,
  formatTime,
} from '../frontend/src/time.ts';

test('formats UTC timestamps in Asia/Shanghai', () => {
  const timestamp = '2026-08-11T06:29:34.000Z';
  assert.equal(formatDateTime(timestamp), '2026-08-11 14:29:34');
  assert.equal(formatTime(timestamp), '14:29:34');
  assert.equal(formatCompactDateTime(timestamp), '20260811-142934');
});

test('uses the Shanghai calendar date at the UTC day boundary', () => {
  assert.equal(formatDate('2026-08-10T16:00:00.000Z'), '2026-08-11');
});
