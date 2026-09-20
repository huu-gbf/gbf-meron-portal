const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('tools/yosen-predictor.html', 'utf8');
const begin = html.indexOf('const NOON_MEDIAN_MULTIPLIERS =');
const end = html.indexOf('const CONFIG =', begin);
assert(begin >= 0 && end > begin);
const context = {};
vm.runInNewContext(html.slice(begin, end) + '\nglobalThis.predict = predictFromNoon;', context);
const predict = context.predict;

test('100億から200億、平日倍率2.325で758億', () => {
  const p = predict('weekday', 100e8, 200e8);
  assert.equal(p.morningSpeed, 20e8);
  assert.equal(p.multiplier, 2.325);
  assert.equal(p.predictedRemainingSpeed, 46.5e8);
  assert.equal(p.predictedFinalScore, 758e8);
});

test('土曜・日曜・祝日は休日倍率2.189', () => {
  const weekday = predict('weekday', 100e8, 200e8).predictedFinalScore;
  for (const day of ['saturday', 'sunday', 'holiday']) {
    const p = predict(day, 100e8, 200e8);
    assert.equal(p.multiplier, 2.189);
    assert.equal(p.predictedFinalScore, 200e8 + 20e8 * 2.189 * 12);
    assert(p.predictedFinalScore < weekday);
  }
});

test('欠損・逆転・不正な数値では結果を返さない', () => {
  for (const [a, b] of [[NaN, 200e8], [100e8, NaN], [200e8, 100e8], [100e8, 100e8], [-1, 200e8], [1, Infinity]]) {
    assert.equal(predict('weekday', a, b), null);
  }
  assert.equal(predict('other', 100e8, 200e8), null);
});

test('正常な大きな整数も有限の結果になる', () => {
  const p = predict('weekday', 1_000_000_000_000, 2_000_000_000_000);
  assert(Number.isFinite(p.predictedFinalScore));
  assert(Number.isFinite(predict('weekday', 100e8 + 1, 200e8).predictedFinalScore));
});

test('表示計算: カンマ入力、欠損、文字、逆転で結果を隠す', () => {
  const start = html.indexOf('function parseNumber(');
  const calcEnd = html.indexOf('function calculateLegacy()', start);
  assert(start >= 0 && calcEnd > start);
  const ids = ['result12', 'calcDetails', 'model12Note', 'calcExplanation', 'valPred12'];
  const dom = Object.fromEntries(ids.map(id => [id, { style: {}, textContent: '' }]));
  const elements = {
    score7: { value: '' }, score12: { value: '' }, dayType: { value: 'weekday' },
    err7: { style: {}, textContent: '' }, err12: { style: {}, textContent: '' },
    info12: { style: {}, textContent: '' }
  };
  const ui = { document: { getElementById: id => dom[id] } };
  vm.runInNewContext('const OKU=100000000;\n' + html.slice(begin, end)
    + '\nconst els=globalThis.elements;\n' + html.slice(start, calcEnd)
    + '\nglobalThis.calculateNoon=calculate; globalThis.parseScore=parseNumber;', Object.assign(ui, { elements }));
  const run = (a, b) => { elements.score7.value = a; elements.score12.value = b; ui.calculateNoon(); };
  run('10,000,000,000', '20,000,000,000');
  assert.equal(dom.valPred12.textContent, '758.00 億');
  assert.equal(dom.result12.style.display, 'block');
  run('', '200億');
  assert.equal(dom.result12.style.display, 'none');
  assert.match(elements.err7.textContent, /入力/);
  run('100億', '');
  assert.match(elements.err12.textContent, /入力/);
  run('abc', '200億');
  assert.match(elements.err7.textContent, /正しい/);
  run('100億', 'abc');
  assert.match(elements.err12.textContent, /正しい/);
  run('200億', '100億');
  assert.match(elements.err12.textContent, /大きく/);
  assert.equal(dom.result12.style.display, 'none');
  assert.equal(ui.parseScore('10,000,000,000'), 100e8);
});

test('詳細エリアの過去誤差グラフに指定の13開催だけを表示する', () => {
  const expected = [[66,3.46],[67,-0.26],[69,5.12],[70,-7.52],[72,10.87],
    [74,16.17],[75,15.23],[77,9.95],[78,9.26],[80,-2.96],
    [81,9.57],[82,4.62],[83,-4.77]];
  const chart = { innerHTML: '' };
  const ui = { document: { getElementById: id => id === 'noonErrorChart' ? chart : null } };
  vm.runInNewContext(html.slice(begin, end)
    + '\nglobalThis.rows=NOON_BACKTEST_ERRORS;globalThis.render=renderNoonErrorChart;', ui);
  assert.deepEqual(Array.from(ui.rows, row => Array.from(row)), expected);
  ui.render();
  assert.equal((chart.innerHTML.match(/class="noon-error-bar/g) || []).length, 13);
  assert.equal((chart.innerHTML.match(/<li>第/g) || []).length, 13);
  assert.match(chart.innerHTML, /第67回 -0\.26%/);
  assert.match(chart.innerHTML, /第74回 \+16\.17%/);
  assert.match(chart.innerHTML, /top:40px/);
  assert.match(chart.innerHTML, /top:80px/);
  assert.match(chart.innerHTML, /top:120px/);
  assert.equal(expected.filter(([, error]) => Math.abs(error) <= 10).length, 10);
  assert.equal(expected.some(([, error]) => error < -10), false);
});

test('予測結果が詳細グラフより先にあり、説明と免責は簡潔', () => {
  assert(html.indexOf('id="result12"') < html.indexOf('id="calcDetails"'));
  assert(html.indexOf('id="calcDetails"') < html.indexOf('id="noonErrorChart"'));
  assert.match(html, /なぜ12時時点の予測のみ？/);
  assert.match(html, /今後の結果を保証するものではありません/);
  assert.match(html, /株式会社Cygamesおよび運営・関係各社とは関係ありません/);
  assert.doesNotMatch(html, /第三者サイトの記事、文章、表、デザイン等/);
  assert.match(html, /\.noon-error-columns,.noon-error-rounds \{ display:grid; grid-template-columns:repeat\(13,minmax\(0,1fr\)\)/);
});

test('参考要因は詳細グラフの下にあり、旧モデル表示は隠して保持する', () => {
  const chart = html.indexOf('id="noonErrorChart"');
  const factors = html.indexOf('誤差が目立った開催の参考要因');
  const advanced = html.indexOf('モデル開発・検証データ（高度な情報）');
  assert(chart > 0 && chart < factors && factors < advanced);
  for (const text of [
    '第70回（−7.52%）：翌日が祝日。予選2日目夜の参加状況に影響した可能性。',
    '第72回（+10.87%）：極星器追加・10周年後夜祭期間。',
    '第74回（+16.17%）：古戦場の大規模仕様変更・極星器追加。',
    '第75回（+15.23%）：極星器追加・肉ドロップ量調整。',
    '※上記は誤差の原因を断定するものではなく、当時の環境変化としての参考情報です。'
  ]) assert(html.includes(text));
  assert.match(html.slice(html.lastIndexOf('<details', advanced), advanced), /<details hidden\b/);
  assert(html.includes('過去20大会 夜の伸び倍率'));
  assert(html.includes('id="shadowComparison"'));
  assert(html.includes('id="walkForwardResults"'));
});
