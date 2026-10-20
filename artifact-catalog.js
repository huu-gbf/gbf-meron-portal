/* Artifact catalog: the single source for stable IDs, enums and defaults. */
(function (root) {
  'use strict';
  // 対応表の意味を変える場合だけ更新し、表示順・表示名の変更では更新しない。
  const ARTIFACT_CATALOG_VERSION = 1;

  // effectIdは表示順・表示名に依存しない固定ID。追加時も既存IDの再採番・再利用は禁止。
  const dataSlot12 = [
    { effectId: "artifact_slot12_attack", name: "攻撃力", values: ["1320", "1440", "1560", "1680", "1800"] },
    { effectId: "artifact_slot12_elemental_attack", name: "自属性攻撃力", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot12_charge_attack_damage", name: "奥義ダメ", values: ["13.2%", "14.4%", "15.6%", "16.8%", "18%"] },
    { effectId: "artifact_slot12_skill_damage", name: "アビダメ", values: ["13.2%", "14.4%", "15.6%", "16.8%", "18%"] },
    { effectId: "artifact_slot12_triple_attack_rate", name: "TA率", values: ["4.4%", "4.8%", "5.2%", "5.6%", "6%"] },
    { effectId: "artifact_slot12_double_attack_rate", name: "DA率", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot12_hp", name: "HP", values: ["660", "720", "780", "840", "900"] },
    { effectId: "artifact_slot12_defense", name: "防御力", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot12_healing", name: "回復性能", values: ["13.2%", "14.4%", "15.6%", "16.8%", "18%"] },
    { effectId: "artifact_slot12_critical_rate", name: "クリティカル確率", values: ["13.2%", "14.4%", "15.6%", "16.8%", "18%"] },
    { effectId: "artifact_slot12_favorable_element_damage_reduction", name: "有利属性軽減", values: ["4.4%", "4.8%", "5.2%", "5.6%", "6%"] },
    { effectId: "artifact_slot12_debuff_success_rate", name: "弱体成功率", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot12_debuff_resistance", name: "弱体耐性", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot12_dodge_rate", name: "回避率", values: ["4.4%", "4.8%", "5.2%", "5.6%", "6%"] }
  ];

  const dataSlot3 = [
    { effectId: "artifact_slot3_full_hp_damage", name: "HP100%時与ダメUP", values: ["2.2%", "2.4%", "2.6%", "2.8%", "3%"] },
    { effectId: "artifact_slot3_critical_damage_cap", name: "クリ発動時ダメ上限", values: ["2.2%", "2.4%", "2.6%", "2.8%", "3%"] },
    { effectId: "artifact_slot3_normal_supplemental_damage", name: "通常与ダメ上昇", values: ["8800", "9600", "10400", "11200", "12000"] },
    { effectId: "artifact_slot3_normal_damage_cap", name: "通常ダメ上限", values: ["2.2%", "2.4%", "2.6%", "2.8%", "3%"] },
    { effectId: "artifact_slot3_normal_cap_skill_charge_penalty", name: "通常上限UP/アビ-80%/奥義-60%", values: ["4.4%", "4.8%", "5.2%", "5.6%", "6%"] },
    { effectId: "artifact_slot3_skill_supplemental_damage", name: "アビ与ダメ上昇", values: ["11000", "12000", "13000", "14000", "15000"] },
    { effectId: "artifact_slot3_skill_damage_cap", name: "アビ上限", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot3_skill_cap_normal_charge_penalty", name: "アビ上限UP/通常-20%/奥義-60%", values: ["17.6%", "19.2%", "20.8%", "22.4%", "24%"] },
    { effectId: "artifact_slot3_charge_supplemental_damage", name: "奥義与ダメ上昇", values: ["110000", "120000", "130000", "140000", "150000"] },
    { effectId: "artifact_slot3_charge_damage_cap", name: "奥義上限", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot3_charge_special_damage_cap", name: "奥義特殊上限", values: ["4.4%", "4.8%", "5.2%", "5.6%", "6%"] },
    { effectId: "artifact_slot3_charge_cap_normal_skill_penalty", name: "奥義上限UP/通常-20%/アビ-80%", values: ["13.2%", "14.4%", "15.6%", "16.8%", "18%"] },
    { effectId: "artifact_slot3_half_hp_or_more_triple_attack", name: "HP50%以上時TA率UP", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot3_chain_damage", name: "チェイン与ダメ", values: ["6.6%", "7.2%", "7.8%", "8.4%", "9%"] },
    { effectId: "artifact_slot3_turn_damage_reduction", name: "ターンダメ軽減", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot3_regeneration", name: "再生", values: ["440", "480", "520", "560", "600"] },
    { effectId: "artifact_slot3_half_hp_or_less_damage_reduction", name: "HP50%以下時ダメ軽減", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot3_hp_defense_penalty", name: "最大HP上昇/防御-70%", values: ["8.8%", "9.6%", "10.4%", "11.2%", "12%"] },
    { effectId: "artifact_slot3_buff_removal_resistance", name: "確率で強化効果が無効化されない", values: ["20%"] },
    { effectId: "artifact_slot3_attack_start_debuff_recovery", name: "確率で攻撃開始時に弱体効果1つ回復", values: ["20%"] }
  ];

  const dataSlot4 = [
    { effectId: "artifact_slot4_battle_entry_damage_boost", name: "バトル登場時、一度だけ自分の与ダメUP", value: "3%" },
    { effectId: "artifact_slot4_long_cooldown_skill_damage_boost", name: "使用間隔10T以上のアビ使用時、自分に与ダメUP", value: "4%" },
    { effectId: "artifact_slot4_initial_hp_cost_delayed_damage_cap", name: "バトル開始時に最大HP20%消費/3T後自分ダメ上限UP", value: "10%" },
    { effectId: "artifact_slot4_target_count_elemental_echo", name: "一定回数敵のタゲになった場合、一度だけ自属性追撃", value: "7回" },
    { effectId: "artifact_slot4_skill_use_count_damage_cap", name: "アビを一定回数使用する度に、自分ダメ上限UP(累積)", value: "5回" },
    { effectId: "artifact_slot4_skill_damage_count_supplemental", name: "アビダメを一定量与える毎に、アビ与ダメ上昇(累積)", value: "4000万" },
    { effectId: "artifact_slot4_turn_charge_gauge_supplemental", name: "T終了時、T中消費奥義ゲージに応じて与ダメ上昇", value: "5000" },
    { effectId: "artifact_slot4_debuff_skill_enemy_damage_taken", name: "弱体アビ使用時、敵に被ダメUP(2回)", value: "4%" },
    { effectId: "artifact_slot4_potion_fated_chain_gauge", name: "キュアポかオルポ使用時にFCゲージUP", value: "3%" },
    { effectId: "artifact_slot4_healing_skill_next_character_echo", name: "回復アビ使用時、次の配置キャラに自属性追撃(1回)", value: "4%" },
    { effectId: "artifact_slot4_turn_hp_consumption_plain_damage", name: "T終了時、T中消費HPに応じて無属性ダメ", value: "10倍" },
    { effectId: "artifact_slot4_enemy_half_hp_self_heal", name: "T終了時にHP50%以下の敵がいる時、一度だけHP回復", value: "2000" },
    { effectId: "artifact_slot4_knockout_party_random_buff", name: "戦闘不能時、一度だけ味方全体に一定個数ランダム強化", value: "1個" },
    { effectId: "artifact_slot4_single_attack_random_buff", name: "1回攻撃発動時、自分に一定個数ランダム強化", value: "1個" },
    { effectId: "artifact_slot4_no_attack_random_buff", name: "攻撃行動を行わなかった場合T終了時、ランダム強化", value: "1個" },
    { effectId: "artifact_slot4_battle_start_random_buff", name: "バトル開始時に、自分に一定個数ランダム強化", value: "1個" },
    { effectId: "artifact_slot4_attack_hit_count_flurry", name: "敵に一定回数攻撃を与えた時、一度だけ乱撃3hit", value: "200回" },
    { effectId: "artifact_slot4_attack_start_chance_flurry", name: "攻撃開始時、確率で自分に乱撃(6hit/1回)", value: "1%" },
    { effectId: "artifact_slot4_sub_periodic_random_debuff", name: "サブ時、一定T毎に敵全体にランダムな弱体効果", value: "7ターン" },
    { effectId: "artifact_slot4_turn_end_chance_dispel_all", name: "ターン終了時、確率で敵の強化効果を全て無効化", value: "1%" },
    { effectId: "artifact_slot4_few_enemy_debuffs_block", name: "攻撃開始時に敵の弱体効果が3個以下の時、ブロック", value: "5%" },
    { effectId: "artifact_slot4_battle_start_damage_reduction", name: "バトル開始時、1T被ダメ減少", value: "1000" },
    { effectId: "artifact_slot4_periodic_barrier", name: "バトル開始時と5T毎に自分にバリア効果", value: "1000" },
    { effectId: "artifact_slot4_link_skill_count_cooldown_reduction", name: "リンクアビ一定回数使用時、リンクアビ再使用1T短縮", value: "8回" },
    { effectId: "artifact_slot4_skill_one_hp_cost_cooldown_reduction", name: "1アビ使用時にHPを一定消費するが1アビ使用間隔1T短縮", value: "30%" },
    { effectId: "artifact_slot4_chance_advance_five_turns", name: "確率でターン進行時に、経過ターンを5T進める", value: "0.2%" },
    { effectId: "artifact_slot4_experience", name: "獲得経験値UP(重複不可)", value: "1%" },
    { effectId: "artifact_slot4_drop_rate", name: "アイテムドロップ率UP(重複不可)", value: "0.5%" },
    { effectId: "artifact_slot4_battle_end_earring", name: "バトル終了時にランダムな耳飾りを入手", value: "-" }
  ];

  // 旧localStorageの位置を固定する対応表。catalogの並び替えでも変更・再採番しない。
  const ARTIFACT_LEGACY_EFFECT_IDS = Object.freeze({
    s12_0: 'artifact_slot12_attack',
    s12_1: 'artifact_slot12_elemental_attack',
    s12_2: 'artifact_slot12_charge_attack_damage',
    s12_3: 'artifact_slot12_skill_damage',
    s12_4: 'artifact_slot12_triple_attack_rate',
    s12_5: 'artifact_slot12_double_attack_rate',
    s12_6: 'artifact_slot12_hp',
    s12_7: 'artifact_slot12_defense',
    s12_8: 'artifact_slot12_healing',
    s12_9: 'artifact_slot12_critical_rate',
    s12_10: 'artifact_slot12_favorable_element_damage_reduction',
    s12_11: 'artifact_slot12_debuff_success_rate',
    s12_12: 'artifact_slot12_debuff_resistance',
    s12_13: 'artifact_slot12_dodge_rate',
    s3_0: 'artifact_slot3_full_hp_damage',
    s3_1: 'artifact_slot3_critical_damage_cap',
    s3_2: 'artifact_slot3_normal_supplemental_damage',
    s3_3: 'artifact_slot3_normal_damage_cap',
    s3_4: 'artifact_slot3_normal_cap_skill_charge_penalty',
    s3_5: 'artifact_slot3_skill_supplemental_damage',
    s3_6: 'artifact_slot3_skill_damage_cap',
    s3_7: 'artifact_slot3_skill_cap_normal_charge_penalty',
    s3_8: 'artifact_slot3_charge_supplemental_damage',
    s3_9: 'artifact_slot3_charge_damage_cap',
    s3_10: 'artifact_slot3_charge_special_damage_cap',
    s3_11: 'artifact_slot3_charge_cap_normal_skill_penalty',
    s3_12: 'artifact_slot3_half_hp_or_more_triple_attack',
    s3_13: 'artifact_slot3_chain_damage',
    s3_14: 'artifact_slot3_turn_damage_reduction',
    s3_15: 'artifact_slot3_regeneration',
    s3_16: 'artifact_slot3_half_hp_or_less_damage_reduction',
    s3_17: 'artifact_slot3_hp_defense_penalty',
    s3_18: 'artifact_slot3_buff_removal_resistance',
    s3_19: 'artifact_slot3_attack_start_debuff_recovery',
    s4_0: 'artifact_slot4_battle_entry_damage_boost',
    s4_1: 'artifact_slot4_long_cooldown_skill_damage_boost',
    s4_2: 'artifact_slot4_initial_hp_cost_delayed_damage_cap',
    s4_3: 'artifact_slot4_target_count_elemental_echo',
    s4_4: 'artifact_slot4_skill_use_count_damage_cap',
    s4_5: 'artifact_slot4_skill_damage_count_supplemental',
    s4_6: 'artifact_slot4_turn_charge_gauge_supplemental',
    s4_7: 'artifact_slot4_debuff_skill_enemy_damage_taken',
    s4_8: 'artifact_slot4_potion_fated_chain_gauge',
    s4_9: 'artifact_slot4_healing_skill_next_character_echo',
    s4_10: 'artifact_slot4_turn_hp_consumption_plain_damage',
    s4_11: 'artifact_slot4_enemy_half_hp_self_heal',
    s4_12: 'artifact_slot4_knockout_party_random_buff',
    s4_13: 'artifact_slot4_single_attack_random_buff',
    s4_14: 'artifact_slot4_no_attack_random_buff',
    s4_15: 'artifact_slot4_battle_start_random_buff',
    s4_16: 'artifact_slot4_attack_hit_count_flurry',
    s4_17: 'artifact_slot4_attack_start_chance_flurry',
    s4_18: 'artifact_slot4_sub_periodic_random_debuff',
    s4_19: 'artifact_slot4_turn_end_chance_dispel_all',
    s4_20: 'artifact_slot4_few_enemy_debuffs_block',
    s4_21: 'artifact_slot4_battle_start_damage_reduction',
    s4_22: 'artifact_slot4_periodic_barrier',
    s4_23: 'artifact_slot4_link_skill_count_cooldown_reduction',
    s4_24: 'artifact_slot4_skill_one_hp_cost_cooldown_reduction',
    s4_25: 'artifact_slot4_chance_advance_five_turns',
    s4_26: 'artifact_slot4_experience',
    s4_27: 'artifact_slot4_drop_rate',
    s4_28: 'artifact_slot4_battle_end_earring'
  });

  // 将来同期用のpure projection。既存local/UIからは呼ばず、元データやメモを変更しない。
  function projectArtifactSettings(legacySettings, catalog = [...dataSlot12, ...dataSlot3, ...dataSlot4]) {
    const projection = { catalogVersion: ARTIFACT_CATALOG_VERSION, items: {} };
    if (!legacySettings || typeof legacySettings !== 'object' || Array.isArray(legacySettings) || !Array.isArray(catalog)) {
      return projection;
    }

    const catalogById = new Map();
    catalog.forEach(item => {
      if (item && typeof item === 'object' && typeof item.effectId === 'string') {
        catalogById.set(item.effectId, item);
      }
    });

    Object.entries(ARTIFACT_LEGACY_EFFECT_IDS).forEach(([legacyKey, effectId]) => {
      if (!Object.prototype.hasOwnProperty.call(legacySettings, legacyKey)) return;
      const setting = legacySettings[legacyKey];
      const item = catalogById.get(effectId);
      if (!item || !setting || typeof setting !== 'object' || Array.isArray(setting)) return;
      if (!Object.prototype.hasOwnProperty.call(setting, 'needed') || typeof setting.needed !== 'boolean') return;

      if (Array.isArray(item.values)) {
        if (!Object.prototype.hasOwnProperty.call(setting, 'selectedValue') || typeof setting.selectedValue !== 'string' || !item.values.includes(setting.selectedValue)) return;
        projection.items[effectId] = { needed: setting.needed, selectedValue: setting.selectedValue };
      } else if (typeof item.value === 'string') {
        projection.items[effectId] = { needed: setting.needed };
      }
    });
    return projection;
  }

  // Catalog data is shared by the local tool, validators and generated Rules.
  // Never mutate it through an API result; defaults are fresh values per call.
  const ARTIFACT_CATALOG = Object.freeze([...dataSlot12, ...dataSlot3, ...dataSlot4]);
  for (const item of ARTIFACT_CATALOG) {
    if (item.values) Object.freeze(item.values);
    Object.freeze(item);
  }
  Object.freeze(dataSlot12);
  Object.freeze(dataSlot3);
  Object.freeze(dataSlot4);

  function createDefaultArtifactProjection() {
    return {catalogVersion: ARTIFACT_CATALOG_VERSION, items: Object.fromEntries(
      ARTIFACT_CATALOG.map(item => [item.effectId, {needed: false,
        ...(item.values ? {selectedValue: item.values[item.values.length - 1]} : {})}])
    )};
  }

  const api = Object.freeze({ARTIFACT_CATALOG_VERSION, ARTIFACT_CATALOG,
    dataSlot12, dataSlot3, dataSlot4, ARTIFACT_LEGACY_EFFECT_IDS,
    projectArtifactSettings, createDefaultArtifactProjection});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArtifactCatalog = api;

})(globalThis);
