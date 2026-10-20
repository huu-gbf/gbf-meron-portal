const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../artifact-catalog.js'), 'utf8');
const context = vm.createContext({});
for (const name of ['document', 'window', 'localStorage', 'sessionStorage', 'firebase', 'fetch', 'XMLHttpRequest']) {
  Object.defineProperty(context, name, {get() { throw new Error(`pure adapter accessed ${name}`); }});
}
vm.runInContext(source, context);
const api = context.ArtifactCatalog;
const catalog = [...api.dataSlot12, ...api.dataSlot3, ...api.dataSlot4];
const mapping = api.ARTIFACT_LEGACY_EFFECT_IDS;
const plain = value => JSON.parse(JSON.stringify(value));
const project = (legacy, fixtureCatalog) => plain(fixtureCatalog === undefined
  ? api.projectArtifactSettings(legacy) : api.projectArtifactSettings(legacy, fixtureCatalog));

// Independent checkpoint of old storage keys, meaning, and permanent effect IDs.
// Never derive these literals from the implementation's mapping or array order.
const golden = [
  ['s12_0', '攻撃力', ['1320', '1440', '1560', '1680', '1800'], 'artifact_slot12_attack'],
  ['s12_1', '自属性攻撃力', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot12_elemental_attack'],
  ['s12_2', '奥義ダメ', ['13.2%', '14.4%', '15.6%', '16.8%', '18%'], 'artifact_slot12_charge_attack_damage'],
  ['s12_3', 'アビダメ', ['13.2%', '14.4%', '15.6%', '16.8%', '18%'], 'artifact_slot12_skill_damage'],
  ['s12_4', 'TA率', ['4.4%', '4.8%', '5.2%', '5.6%', '6%'], 'artifact_slot12_triple_attack_rate'],
  ['s12_5', 'DA率', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot12_double_attack_rate'],
  ['s12_6', 'HP', ['660', '720', '780', '840', '900'], 'artifact_slot12_hp'],
  ['s12_7', '防御力', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot12_defense'],
  ['s12_8', '回復性能', ['13.2%', '14.4%', '15.6%', '16.8%', '18%'], 'artifact_slot12_healing'],
  ['s12_9', 'クリティカル確率', ['13.2%', '14.4%', '15.6%', '16.8%', '18%'], 'artifact_slot12_critical_rate'],
  ['s12_10', '有利属性軽減', ['4.4%', '4.8%', '5.2%', '5.6%', '6%'], 'artifact_slot12_favorable_element_damage_reduction'],
  ['s12_11', '弱体成功率', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot12_debuff_success_rate'],
  ['s12_12', '弱体耐性', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot12_debuff_resistance'],
  ['s12_13', '回避率', ['4.4%', '4.8%', '5.2%', '5.6%', '6%'], 'artifact_slot12_dodge_rate'],
  ['s3_0', 'HP100%時与ダメUP', ['2.2%', '2.4%', '2.6%', '2.8%', '3%'], 'artifact_slot3_full_hp_damage'],
  ['s3_1', 'クリ発動時ダメ上限', ['2.2%', '2.4%', '2.6%', '2.8%', '3%'], 'artifact_slot3_critical_damage_cap'],
  ['s3_2', '通常与ダメ上昇', ['8800', '9600', '10400', '11200', '12000'], 'artifact_slot3_normal_supplemental_damage'],
  ['s3_3', '通常ダメ上限', ['2.2%', '2.4%', '2.6%', '2.8%', '3%'], 'artifact_slot3_normal_damage_cap'],
  ['s3_4', '通常上限UP/アビ-80%/奥義-60%', ['4.4%', '4.8%', '5.2%', '5.6%', '6%'], 'artifact_slot3_normal_cap_skill_charge_penalty'],
  ['s3_5', 'アビ与ダメ上昇', ['11000', '12000', '13000', '14000', '15000'], 'artifact_slot3_skill_supplemental_damage'],
  ['s3_6', 'アビ上限', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot3_skill_damage_cap'],
  ['s3_7', 'アビ上限UP/通常-20%/奥義-60%', ['17.6%', '19.2%', '20.8%', '22.4%', '24%'], 'artifact_slot3_skill_cap_normal_charge_penalty'],
  ['s3_8', '奥義与ダメ上昇', ['110000', '120000', '130000', '140000', '150000'], 'artifact_slot3_charge_supplemental_damage'],
  ['s3_9', '奥義上限', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot3_charge_damage_cap'],
  ['s3_10', '奥義特殊上限', ['4.4%', '4.8%', '5.2%', '5.6%', '6%'], 'artifact_slot3_charge_special_damage_cap'],
  ['s3_11', '奥義上限UP/通常-20%/アビ-80%', ['13.2%', '14.4%', '15.6%', '16.8%', '18%'], 'artifact_slot3_charge_cap_normal_skill_penalty'],
  ['s3_12', 'HP50%以上時TA率UP', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot3_half_hp_or_more_triple_attack'],
  ['s3_13', 'チェイン与ダメ', ['6.6%', '7.2%', '7.8%', '8.4%', '9%'], 'artifact_slot3_chain_damage'],
  ['s3_14', 'ターンダメ軽減', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot3_turn_damage_reduction'],
  ['s3_15', '再生', ['440', '480', '520', '560', '600'], 'artifact_slot3_regeneration'],
  ['s3_16', 'HP50%以下時ダメ軽減', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot3_half_hp_or_less_damage_reduction'],
  ['s3_17', '最大HP上昇/防御-70%', ['8.8%', '9.6%', '10.4%', '11.2%', '12%'], 'artifact_slot3_hp_defense_penalty'],
  ['s3_18', '確率で強化効果が無効化されない', ['20%'], 'artifact_slot3_buff_removal_resistance'],
  ['s3_19', '確率で攻撃開始時に弱体効果1つ回復', ['20%'], 'artifact_slot3_attack_start_debuff_recovery'],
  ['s4_0', 'バトル登場時、一度だけ自分の与ダメUP', '3%', 'artifact_slot4_battle_entry_damage_boost'],
  ['s4_1', '使用間隔10T以上のアビ使用時、自分に与ダメUP', '4%', 'artifact_slot4_long_cooldown_skill_damage_boost'],
  ['s4_2', 'バトル開始時に最大HP20%消費/3T後自分ダメ上限UP', '10%', 'artifact_slot4_initial_hp_cost_delayed_damage_cap'],
  ['s4_3', '一定回数敵のタゲになった場合、一度だけ自属性追撃', '7回', 'artifact_slot4_target_count_elemental_echo'],
  ['s4_4', 'アビを一定回数使用する度に、自分ダメ上限UP(累積)', '5回', 'artifact_slot4_skill_use_count_damage_cap'],
  ['s4_5', 'アビダメを一定量与える毎に、アビ与ダメ上昇(累積)', '4000万', 'artifact_slot4_skill_damage_count_supplemental'],
  ['s4_6', 'T終了時、T中消費奥義ゲージに応じて与ダメ上昇', '5000', 'artifact_slot4_turn_charge_gauge_supplemental'],
  ['s4_7', '弱体アビ使用時、敵に被ダメUP(2回)', '4%', 'artifact_slot4_debuff_skill_enemy_damage_taken'],
  ['s4_8', 'キュアポかオルポ使用時にFCゲージUP', '3%', 'artifact_slot4_potion_fated_chain_gauge'],
  ['s4_9', '回復アビ使用時、次の配置キャラに自属性追撃(1回)', '4%', 'artifact_slot4_healing_skill_next_character_echo'],
  ['s4_10', 'T終了時、T中消費HPに応じて無属性ダメ', '10倍', 'artifact_slot4_turn_hp_consumption_plain_damage'],
  ['s4_11', 'T終了時にHP50%以下の敵がいる時、一度だけHP回復', '2000', 'artifact_slot4_enemy_half_hp_self_heal'],
  ['s4_12', '戦闘不能時、一度だけ味方全体に一定個数ランダム強化', '1個', 'artifact_slot4_knockout_party_random_buff'],
  ['s4_13', '1回攻撃発動時、自分に一定個数ランダム強化', '1個', 'artifact_slot4_single_attack_random_buff'],
  ['s4_14', '攻撃行動を行わなかった場合T終了時、ランダム強化', '1個', 'artifact_slot4_no_attack_random_buff'],
  ['s4_15', 'バトル開始時に、自分に一定個数ランダム強化', '1個', 'artifact_slot4_battle_start_random_buff'],
  ['s4_16', '敵に一定回数攻撃を与えた時、一度だけ乱撃3hit', '200回', 'artifact_slot4_attack_hit_count_flurry'],
  ['s4_17', '攻撃開始時、確率で自分に乱撃(6hit/1回)', '1%', 'artifact_slot4_attack_start_chance_flurry'],
  ['s4_18', 'サブ時、一定T毎に敵全体にランダムな弱体効果', '7ターン', 'artifact_slot4_sub_periodic_random_debuff'],
  ['s4_19', 'ターン終了時、確率で敵の強化効果を全て無効化', '1%', 'artifact_slot4_turn_end_chance_dispel_all'],
  ['s4_20', '攻撃開始時に敵の弱体効果が3個以下の時、ブロック', '5%', 'artifact_slot4_few_enemy_debuffs_block'],
  ['s4_21', 'バトル開始時、1T被ダメ減少', '1000', 'artifact_slot4_battle_start_damage_reduction'],
  ['s4_22', 'バトル開始時と5T毎に自分にバリア効果', '1000', 'artifact_slot4_periodic_barrier'],
  ['s4_23', 'リンクアビ一定回数使用時、リンクアビ再使用1T短縮', '8回', 'artifact_slot4_link_skill_count_cooldown_reduction'],
  ['s4_24', '1アビ使用時にHPを一定消費するが1アビ使用間隔1T短縮', '30%', 'artifact_slot4_skill_one_hp_cost_cooldown_reduction'],
  ['s4_25', '確率でターン進行時に、経過ターンを5T進める', '0.2%', 'artifact_slot4_chance_advance_five_turns'],
  ['s4_26', '獲得経験値UP(重複不可)', '1%', 'artifact_slot4_experience'],
  ['s4_27', 'アイテムドロップ率UP(重複不可)', '0.5%', 'artifact_slot4_drop_rate'],
  ['s4_28', 'バトル終了時にランダムな耳飾りを入手', '-', 'artifact_slot4_battle_end_earring']
];
const independentMap = Object.freeze(Object.fromEntries(golden.map(([key, , , effectId]) => [key, effectId])));

function legacyFixture(mode) {
  const high = mode === 'high';
  const settings = {memos: [{character: high ? '高難易度専用メモ' : '古戦場専用メモ', artifact: 'ローカルのみ'}]};
  golden.forEach(([key, , allowed], index) => {
    settings[key] = {needed: high ? index % 3 !== 0 : index % 2 === 0,
      selectedValue: Array.isArray(allowed) ? allowed[(index + (high ? 1 : 0)) % allowed.length] : allowed};
  });
  return settings;
}

function expectedFixture(settings) {
  return {catalogVersion: 1, items: Object.fromEntries(golden.map(([key, , allowed, effectId]) => [effectId, {
    needed: settings[key].needed,
    ...(Array.isArray(allowed) ? {selectedValue: settings[key].selectedValue} : {})
  }]))};
}

function roundTrip(settings) {
  const projected = project(settings);
  assert.deepEqual(projected, expectedFixture(settings));
  const restored = Object.fromEntries(golden.map(([key, , allowed, effectId]) => {
    const value = projected.items[effectId];
    return [key, {needed: value.needed, selectedValue: Array.isArray(allowed) ? value.selectedValue : allowed}];
  }));
  const originalFields = Object.fromEntries(golden.map(([key]) => [key, settings[key]]));
  assert.deepEqual(restored, originalFields, 'all 63 old keys retain their needed/selected meaning');
  assert.equal(Object.keys(projected.items).length, 63);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('[mapping] catalog version 1 covers the real 14/20/29 split with 63 literal IDs', () => {
  assert.equal(api.ARTIFACT_CATALOG_VERSION, 1);
  assert.deepEqual([api.dataSlot12.length, api.dataSlot3.length, api.dataSlot4.length], [14, 20, 29]);
  assert.equal(catalog.filter(item => Array.isArray(item.values)).length, 34);
  assert.equal(catalog.filter(item => typeof item.value === 'string').length, 29);
  assert.equal((source.match(/effectId:\s*['"][^'"]+['"]/g) || []).length, 63);
});

test('[mapping] every effect has one nonempty unique stable ID in each shared mode catalog', () => {
  const ids = catalog.map(item => item.effectId);
  assert.equal(ids.length, 63);
  assert(ids.every(id => typeof id === 'string' && id.trim() === id && id.length > 0));
  assert.equal(new Set(ids).size, 63);
  assert.equal(new Set(ids).size, Object.keys(legacyFixture('gw')).length - 1);
  assert.equal(new Set(ids).size, Object.keys(legacyFixture('high')).length - 1);
});

test('[mapping] frozen explicit legacy map has exactly 63 keys and no unknown/orphan/duplicate target', () => {
  assert(Object.isFrozen(mapping));
  assert.deepEqual(plain(mapping), independentMap, 'the persisted IDs themselves must never be renamed');
  assert.match(source, /ARTIFACT_LEGACY_EFFECT_IDS\s*=\s*Object\.freeze\s*\(/);
  const keys = golden.map(([key]) => key);
  assert.deepEqual(Object.keys(mapping).sort(), keys.sort());
  const targets = Object.values(mapping);
  assert.equal(targets.length, 63);
  assert.equal(new Set(targets).size, 63);
  assert.deepEqual([...new Set(targets)].sort(), catalog.map(item => item.effectId).sort());
  for (const key of keys) assert.match(source, new RegExp(`['"]?${key}['"]?\\s*:\\s*['"][^'"]+['"]`));
});

test('[mapping] independent legacy key/name/value golden catches all 63 semantic mismatches', () => {
  assert.equal(golden.length, 63);
  for (const [key, name, allowed, effectId] of golden) {
    const item = catalog.find(candidate => candidate.effectId === effectId);
    assert(item, key);
    assert.equal(item.name, name, `${key} must still identify ${name}`);
    if (Array.isArray(allowed)) assert.deepEqual(plain(item.values), allowed, key);
    else assert.equal(item.value, allowed, key);
  }
});

test('[mapping] reordering every catalog group preserves all legacy effect meanings', () => {
  const fixture = legacyFixture('gw');
  const reordered = [...api.dataSlot4].reverse().concat([...api.dataSlot3].reverse(), [...api.dataSlot12].reverse());
  assert.deepEqual(project(fixture, reordered), expectedFixture(fixture));
});

test('[mapping] labels may change without changing IDs or legacy projection', () => {
  const fixture = legacyFixture('high');
  const renamed = catalog.map((item, index) => ({...item, name: `表示変更 ${index}`}));
  assert.deepEqual(project(fixture, renamed), expectedFixture(fixture));
  assert.deepEqual(renamed.map(item => item.effectId), catalog.map(item => item.effectId));
});

test('[mapping] adding or removing a catalog item never reassigns an existing legacy key', () => {
  const fixture = legacyFixture('gw');
  fixture.s12_14 = {needed: true, selectedValue: 'new'};
  const added = [{effectId: 'artifact_future_fixture', name: '新項目', values: ['new']}, ...catalog];
  assert.deepEqual(project(fixture, added), expectedFixture(fixture));
  assert.equal(Object.hasOwn(project(fixture, added).items, 'artifact_future_fixture'), false);
  const removed = catalog.filter(item => item.effectId !== mapping.s12_0);
  const expected = expectedFixture(fixture);
  delete expected.items[mapping.s12_0];
  assert.deepEqual(project(fixture, removed), expected);
});

test('[gw] all 63 legacy values round-trip for a distinct 古戦場 fixture', () => {
  const gw = legacyFixture('gw'), before = plain(gw);
  roundTrip(gw);
  assert.deepEqual(gw, before);
});

test('[high] all 63 legacy values round-trip separately from the 古戦場 fixture', () => {
  const high = legacyFixture('high'), gw = legacyFixture('gw'), before = plain(high);
  roundTrip(high);
  assert.notDeepEqual(project(high), project(gw));
  assert.deepEqual(high, before);
  assert.equal(high.memos[0].character, '高難易度専用メモ');
});

test('[projection] needed true and false are copied as booleans with only sync fields', () => {
  const result = project({s12_0: {needed: true, selectedValue: '1800', extra: 'omit'}, s4_0: {needed: false}});
  assert.deepEqual(result, {catalogVersion: 1, items: {
    [mapping.s12_0]: {needed: true, selectedValue: '1800'}, [mapping.s4_0]: {needed: false}
  }});
});

test('[projection] invalid or missing needed omits the whole item without truthy coercion', () => {
  for (const needed of ['true', 'false', 1, 0, null, {}, [], undefined]) {
    assert.deepEqual(project({s12_0: {needed, selectedValue: '1800'}, s4_0: {needed}}).items, {});
  }
  assert.deepEqual(project({s12_0: {selectedValue: '1800'}, s4_0: {}}).items, {});
});

test('[projection] only own legacy entries and own required fields are accepted', () => {
  const inheritedEntry = Object.create({s12_0: {needed: true, selectedValue: '1800'}});
  assert.deepEqual(project(inheritedEntry).items, {});
  assert.deepEqual(project({s12_0: Object.create({needed: true, selectedValue: '1800'})}).items, {});
  assert.deepEqual(project({s12_0: Object.assign(Object.create({selectedValue: '1800'}), {needed: true})}).items, {});
  const root = Object.create(null), setting = Object.create(null);
  Object.assign(setting, {needed: true, selectedValue: '1800'}); root.s12_0 = setting;
  assert.deepEqual(project(root).items, {[mapping.s12_0]: {needed: true, selectedValue: '1800'}});
});

test('[projection] every currently allowed value of all 34 selectable effects is accepted', () => {
  let effects = 0, choices = 0;
  for (const [key, , allowed] of golden) {
    if (!Array.isArray(allowed)) continue;
    effects++;
    for (const selectedValue of allowed) {
      choices++;
      assert.deepEqual(project({[key]: {needed: choices % 2 === 0, selectedValue}}).items,
        {[mapping[key]]: {needed: choices % 2 === 0, selectedValue}}, `${key}: ${selectedValue}`);
    }
  }
  assert.equal(effects, 34);
  assert.equal(choices, 162);
});

test('[projection] invalid, nonstring, and missing selectedValue omit a selectable item', () => {
  for (const selectedValue of ['unknown', '', '1800 ', '01800', 1800, true, null, {}, [], undefined]) {
    assert.deepEqual(project({s12_0: {needed: true, selectedValue}}).items, {});
  }
  assert.deepEqual(project({s12_0: {needed: false}}).items, {});
});

test('[projection] the two single-choice 20% effects still require selectedValue', () => {
  for (const key of ['s3_18', 's3_19']) {
    assert.deepEqual(project({[key]: {needed: true}}).items, {});
    assert.deepEqual(project({[key]: {needed: false, selectedValue: '20%'}}).items,
      {[mapping[key]]: {needed: false, selectedValue: '20%'}});
    assert.deepEqual(project({[key]: {needed: true, selectedValue: '100%'}}).items, {});
  }
});

test('[projection] all 29 fixed effects retain needed but exclude reproducible fixed values', () => {
  const fixed = Object.fromEntries(golden.filter(([, , allowed]) => !Array.isArray(allowed))
    .map(([key]) => [key, {needed: true, selectedValue: {malformed: true}, value: 'must not copy', memo: 'local'}]));
  const result = project(fixed);
  assert.equal(Object.keys(result.items).length, 29);
  for (const value of Object.values(result.items)) assert.deepEqual(value, {needed: true});
});

test('[projection] broken JSON equivalents and invalid roots safely return empty items', () => {
  for (const value of [undefined, null, [], [legacyFixture('gw')], true, false, 1, 0, '', '{broken',
    JSON.stringify(legacyFixture('gw')), 'null']) {
    assert.deepEqual(project(value), {catalogVersion: 1, items: {}});
  }
});

test('[projection] malformed known entries are ignored independently of valid entries', () => {
  for (const value of [null, [], true, 1, 'entry', undefined]) {
    assert.deepEqual(project({s12_0: value, s3_0: value, s4_0: value, s4_1: {needed: false}}).items,
      {[mapping.s4_1]: {needed: false}});
  }
});

test('[projection] unknown keys, memos, summary, mode, tab, and other UI state never enter output', () => {
  const legacy = {s12_0: {needed: true, selectedValue: '1320', memo: 'private', total: 999, mode: 'high'},
    unknown: {needed: true, selectedValue: '1800'}, s12_999: {needed: true, selectedValue: '1800'},
    memos: [{character: '名前', artifact: 'ローカルメモ'}], memo: 'memo', summary: {sum: 999},
    total: 999, maximum: 999, mode: 'high', currentMode: 'gw', tab: 'summary', scroll: 100, focus: 'memo'};
  assert.deepEqual(project(legacy), {catalogVersion: 1, items: {[mapping.s12_0]: {needed: true, selectedValue: '1320'}}});
});

test('[projection] missing legacy entries are not filled from UI defaults', () => {
  assert.deepEqual(project({}), {catalogVersion: 1, items: {}});
  assert.deepEqual(project({s4_0: {needed: false}}).items, {[mapping.s4_0]: {needed: false}});
  assert.equal(Object.keys(project({s4_0: {needed: false}}).items).length, 1);
});

test('[projection] deep-frozen legacy input and its memo stay intact through repeated conversion', () => {
  const legacy = deepFreeze(legacyFixture('high')), before = plain(legacy);
  const first = project(legacy), second = project(legacy);
  assert.deepEqual(first, second);
  assert.deepEqual(legacy, before);
  assert.equal(legacy.memos[0].artifact, 'ローカルのみ');
  assert.equal(Object.hasOwn(first, 'memos'), false);
  assert.equal(Object.hasOwn(first.items, 'memos'), false);
});

test('[projection] result objects share no mutable references with legacy inputs', () => {
  const legacy = legacyFixture('gw'), first = api.projectArtifactSettings(legacy);
  first.items[mapping.s12_0].needed = !legacy.s12_0.needed;
  first.items[mapping.s12_0].selectedValue = 'changed-output';
  assert.equal(legacy.s12_0.needed, true);
  assert.equal(legacy.s12_0.selectedValue, '1320');
  const second = api.projectArtifactSettings(legacy), before = plain(second);
  legacy.s12_0.needed = false; legacy.s12_0.selectedValue = '1800';
  assert.deepEqual(plain(second), before);
});

test('[projection] current UI defaults project from the actual catalog without writing storage', () => {
  const defaults = {memos: [{character: '', artifact: ''}]};
  for (const [key, effectId] of Object.entries(mapping)) {
    const item = catalog.find(candidate => candidate.effectId === effectId);
    defaults[key] = {needed: false, selectedValue: item.values ? item.values[item.values.length - 1] : item.value};
  }
  const before = plain(defaults), result = project(defaults);
  assert.equal(Object.keys(result.items).length, 63);
  for (const [key, effectId] of Object.entries(mapping)) {
    const item = catalog.find(candidate => candidate.effectId === effectId);
    assert.deepEqual(result.items[effectId], item.values
      ? {needed: false, selectedValue: item.values[item.values.length - 1]} : {needed: false}, key);
  }
  assert.deepEqual(defaults, before);
});

test('[projection] shared default helper preserves all frozen catalog IDs and returns detached full states', () => {
  assert(Object.isFrozen(api.ARTIFACT_CATALOG));
  for (const item of api.ARTIFACT_CATALOG) {
    assert(Object.isFrozen(item));
    if (item.values) assert(Object.isFrozen(item.values));
  }
  const expected = {catalogVersion: 1, items: Object.fromEntries(golden.map(([, , allowed, effectId]) => [effectId, {
    needed: false, ...(Array.isArray(allowed) ? {selectedValue: allowed[allowed.length - 1]} : {})
  }]))};
  const first = api.createDefaultArtifactProjection();
  assert.deepEqual(plain(first), expected);
  first.items[independentMap.s12_0].needed = true;
  first.items[independentMap.s12_0].selectedValue = 'detached';
  assert.deepEqual(plain(api.createDefaultArtifactProjection()), expected);
});
