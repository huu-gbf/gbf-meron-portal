const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('tools/yosen-predictor.html', 'utf8');
const begin = source.indexOf('const HONSEN_MULTIPLIERS =');
const end = source.indexOf('const HISTORY_DATA =', begin);
assert(begin > 0 && end > begin, '本戦型モデルが見つかりません');
const context = {};
vm.runInNewContext(source.slice(begin, end) + '\nglobalThis.predict = honsenPrediction; globalThis.models = HONSEN_MULTIPLIERS; globalThis.noonRange = noonReferenceRange;', context);

test('12時累計と万/hの朝速度から24時を予測し、後続の実測は不要', () => {
  const s12 = 10_000_000_000;
  const baseline = 50_000 * 10_000;
  const result = context.predict('weekday', 50_000, s12);
  const m = context.models.weekday.ratios;
  assert.equal(result.pred12, s12 + baseline * (m[0] * 6 + m[1] * 2 + m[2] * 4));
  assert(Number.isNaN(result.pred18) && Number.isNaN(result.pred20));
  assert.equal(context.predict('weekday', null, s12), null);
});

test('平日と土日祝を分け、18時・20時補正は実測を起点にする', () => {
  const s12 = 10_000_000_000, s18 = 14_000_000_000, s20 = 16_000_000_000;
  for (const type of ['weekday', 'saturday', 'sunday', 'holiday']) {
    const result = context.predict(type, 50_000, s12, s18, s20);
    const m = type === 'weekday' ? context.models.weekday.ratios : context.models.nonWeekday.ratios;
    const baseline = 500_000_000;
    assert.equal(result.pred18, s18 + baseline * result.correction18 * (m[1] * 2 + m[2] * 4));
    assert.equal(result.pred20, s20 + baseline * result.correction20 * m[2] * 4);
    assert.equal(result.model, type === 'weekday' ? context.models.weekday : context.models.nonWeekday);
  }
});

test('実測補正を0.90〜1.10に制限する', () => {
  const s12 = 10_000_000_000, baseline = 500_000_000;
  const [day, early] = context.models.weekday.ratios;
  const standard18 = baseline * day * 6;
  const standard20 = baseline * (day * 6 + early * 2);
  assert.equal(context.predict('weekday', 50_000, s12, s12 + standard18 * 0.5).correction18, 0.90);
  assert.equal(context.predict('weekday', 50_000, s12, s12 + standard18 * 1.5).correction18, 1.10);
  assert.equal(context.predict('weekday', 50_000, s12, NaN, s12 + standard20 * 0.5).correction20, 0.90);
  assert.equal(context.predict('weekday', 50_000, s12, NaN, s12 + standard20 * 1.5).correction20, 1.10);
});

test('12時の参考幅は確定済み累計を固定し、残り増加量だけに適用する', () => {
  const s12 = 10_000_000_000;
  const center = context.predict('weekday', 50_000, s12).pred12;
  const range = context.noonRange(s12, center);
  assert([range.low, range.center, range.high].every(Number.isFinite));
  assert(range.low < center && center < range.high);
  assert.equal(range.low, s12 + (center - s12) * 0.9339);
  assert.equal(range.high, s12 + (center - s12) * 1.0661);
});
