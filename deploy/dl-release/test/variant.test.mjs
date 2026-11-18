import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MARKER,
  parseVariantFromXmltree,
  normalizeAllowEntry,
  resolveVariant,
} from '../variant.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'xmltree-fixtures', name), 'utf8');

// 这几个 fixture 是真实 aapt2 输出：
//   with-marker-internal.txt  ← 构建期加了标记的最小 APK（aapt2 link 生成）
//   real-beta3-no-marker.txt  ← 线上 deepseek-chat-1.4.0-beta.3.apk 的真实清单
const REAL_BETA3 = fixture('real-beta3-no-marker.txt');

test('真实线上包（beta.3）没有标记 → unknown，且不会被 androidx 的 meta-data 误判', () => {
  const r = parseVariantFromXmltree(REAL_BETA3, DEFAULT_MARKER);
  assert.equal(r.variant, null);
  assert.equal(r.reason, 'marker_absent');
});

test('真实带标记的 APK → internal', () => {
  const r = parseVariantFromXmltree(fixture('with-marker-internal.txt'), DEFAULT_MARKER);
  assert.equal(r.variant, 'internal');
  assert.equal(r.reason, 'marker');
});

test('标记为 standard 时 → standard', () => {
  const r = parseVariantFromXmltree(fixture('marker-standard.txt'), DEFAULT_MARKER);
  assert.equal(r.variant, 'standard');
});

test('标记值不在枚举内 → unknown（不猜、不降级 standard）', () => {
  const r = parseVariantFromXmltree(fixture('marker-out-of-enum.txt'), DEFAULT_MARKER);
  assert.equal(r.variant, null);
  assert.equal(r.reason, 'marker_out_of_enum');
  assert.equal(r.raw, 'beta');
});

test('标记名对不上（只改大小写不同）→ marker_absent', () => {
  const r = parseVariantFromXmltree(fixture('with-marker-internal.txt'), 'com.example.deepseekchat.artifact_variant');
  assert.equal(r.variant, null);
  assert.equal(r.reason, 'marker_absent');
});

test('xmltree 缺失/空输出 → unknown', () => {
  assert.equal(parseVariantFromXmltree('', DEFAULT_MARKER).variant, null);
  assert.equal(parseVariantFromXmltree(null, DEFAULT_MARKER).reason, 'xmltree_failed');
});

test('白名单条目归一化：只接受枚举内取值', () => {
  assert.deepEqual(normalizeAllowEntry('internal'), { variant: 'internal', note: '', version: '' });
  assert.equal(normalizeAllowEntry('beta'), null);
  assert.equal(normalizeAllowEntry({ variant: 'Production' }), null);
  assert.equal(normalizeAllowEntry(null), null);
});

test('合成优先级：标记 > 白名单 > unknown', () => {
  // 仅标记
  assert.deepEqual(
    resolveVariant({ variant: 'internal', reason: 'marker' }, null),
    { variant: 'internal', source: 'apk-manifest' },
  );
  // 仅白名单（历史包）
  assert.deepEqual(
    resolveVariant({ variant: null, reason: 'marker_absent' }, { variant: 'internal' }),
    { variant: 'internal', source: 'sha256-allowlist' },
  );
  // 都没有 → unknown，绝不默认 standard
  const none = resolveVariant({ variant: null, reason: 'marker_absent' }, null);
  assert.equal(none.variant, null);
  assert.equal(none.source, null);
});

test('标记与白名单矛盾 → conflict（调用方必须拒绝写入）', () => {
  const r = resolveVariant({ variant: 'internal', reason: 'marker' }, { variant: 'standard' });
  assert.equal(r.conflict, true);
  assert.equal(r.markerVariant, 'internal');
  assert.equal(r.allowVariant, 'standard');
});
