'use client';

import React, { useState, useMemo } from 'react';

// トレハンのレベル別倍率テーブル（加算値: Lv1+20% 〜 Lv10+70%）
const TH_RATES: Record<number, number> = {
  0: 1.00,
  1: 1.20,
  2: 1.22,
  3: 1.24,
  4: 1.26,
  5: 1.28,
  6: 1.31,
  7: 1.35,
  8: 1.40,
  9: 1.50,
  10: 1.70,
};

// 雫のLv別基礎ドロップUP効果（%）
const DROP_LV_RATES: Record<number, number> = {
  0: 0,
  1: 2,
  2: 5,
  3: 7,
  4: 10,
  5: 15,
};

// 雫のCP倍率オプション
interface DropCpOption {
  multiplier: number;
  label: string;
  badge: string;
}

const DROP_CP_OPTIONS: DropCpOption[] = [
  { multiplier: 1, label: '通常時 (1倍)', badge: '1倍' },
  { multiplier: 2, label: 'CP期間 (2倍)', badge: '2倍' },
  { multiplier: 4, label: 'CP期間 (4倍)', badge: '4倍' },
];

// プリセット用アイテム定義
interface PresetItem {
  id: string;
  category: 'summon' | 'character' | 'weapon' | 'custom';
  name: string;
  bonusPercent: number;
  description: string;
  icon: string;
}

const PRESET_ITEMS: PresetItem[] = [
  // 召喚石（カグヤは30%仕様）
  { id: 'kaguya_both', category: 'summon', name: '両面カグヤ4凸', bonusPercent: 60, description: 'メイン30% + フレンド30%', icon: '🌙' },
  { id: 'kaguya_single', category: 'summon', name: '片面カグヤ4凸', bonusPercent: 30, description: 'メインまたはフレンド30%', icon: '🌕' },
  { id: 'kaguya_god_both', category: 'summon', name: '両面カグヤ無凸/ゴッドラビット3凸', bonusPercent: 40, description: 'メイン20% + フレンド20%', icon: '🐰' },
  { id: 'kaguya_god_single', category: 'summon', name: '片面カグヤ無凸/ゴッドラビット3凸', bonusPercent: 20, description: 'メインまたはフレンド20%', icon: '🐇' },
  { id: 'rabbit_both', category: 'summon', name: '両面白兎/黒兎3凸/ノビヨ4凸', bonusPercent: 30, description: 'メイン15% + フレンド15%', icon: '🐇' },
  { id: 'rabbit_single', category: 'summon', name: '片面白兎/黒兎3凸/ノビヨ4凸', bonusPercent: 15, description: 'メインまたはフレンド15%', icon: '🎺' },
  // キャラクター
  { id: 'essel', category: 'character', name: 'エッセル (サポアビ)', bonusPercent: 5, description: 'サブ/メイン配置で+5%', icon: '🔫' },
  { id: 'richard', category: 'character', name: 'リチャード', bonusPercent: 1, description: 'サブ配置で+1%', icon: '🎲' },
  // 武器
  { id: 'oliver', category: 'weapon', name: 'オリバー / 浄瑠璃', bonusPercent: 5, description: 'メイン装備時 +5%', icon: '🗡️' },
  { id: 'damascus_knife', category: 'weapon', name: 'ダマスカスナイフ', bonusPercent: 10, description: 'メイン装備時 +10%', icon: '⚔️' },
  { id: 'septian', category: 'weapon', name: 'セプティアンバーナー / スノーフレーク', bonusPercent: 2, description: 'メイン装備時 +2%', icon: '🪄' },
  { id: 'd_bead', category: 'weapon', name: 'サブ武器D・ビィ', bonusPercent: 3, description: 'サブ装備時 +3%', icon: '🐲' },
];

// 代表的なドロップアイテム例（シミュレーション用: 変動%）
const SAMPLE_DROPS = [
  { name: '90HELL (8%)', rate: 8.0 },
];

// 箱のドロップ率プリセット
const SAMPLE_BOX_RATES = [
  { name: '90HELL (2%)', rate: 2 },
];

export const DropRateCalculator: React.FC = () => {
  // 1. 軌跡の雫（Lv: 0〜5、CP倍率: 1, 2, 4）
  const [dropLv, setDropLv] = useState<number>(5); // デフォルト: Lv5 (+15%)
  const [dropCp, setDropCp] = useState<number>(2); // デフォルト: CP 2倍

  // 2. トレジャーハント
  const [thLevel, setThLevel] = useState<number>(9);

  // 3. 風見鶏の羽（乗算枠: 1.20倍）
  const [useWindmill, setUseWindmill] = useState<boolean>(true);

  // 4. 大事なもの リーベル・イニティス（加算枠: +3%）
  const [useLiberInitis, setUseLiberInitis] = useState<boolean>(true);

  // 5. 編成加算枠（石・キャラ・武器 %）
  const [bonusPercentInput, setBonusPercentInput] = useState<number>(65); // デフォルト: 両面カグヤ(60) + エッセル(5)

  // 6. 選択中のプリセットID
  const [activePresetIds, setActivePresetIds] = useState<string[]>([
    'kaguya_both',
    'essel',
  ]);

  // 7. 実戦確率シミュレーション
  const [boxDropRate, setBoxDropRate] = useState<number>(2); // 箱のドロップ率（%）: デフォルト90HELL 2%
  const [itemBaseRate, setItemBaseRate] = useState<number>(8.0); // アイテムによって変動%: デフォルト90HELL 8%

  // コピー完了トースト
  const [copied, setCopied] = useState<boolean>(false);

  // 雫のドロップUP効果（%）= Lv基礎% × CP倍率
  const dropBuffPercent = useMemo(() => {
    const basePercent = DROP_LV_RATES[dropLv] ?? 0;
    return basePercent * dropCp;
  }, [dropLv, dropCp]);

  // 雫倍率 = 1.0 + (雫UP% / 100)
  const dropBuffMultiplier = useMemo(() => {
    return 1.0 + dropBuffPercent / 100;
  }, [dropBuffPercent]);

  // TH倍率
  const thMultiplier = useMemo(() => {
    return TH_RATES[thLevel] ?? 1.0;
  }, [thLevel]);

  // 風見鶏倍率（乗算枠: 1.20倍 / 1.00倍）
  const windmillMultiplier = useMemo(() => {
    return useWindmill ? 1.20 : 1.00;
  }, [useWindmill]);

  // 加算枠合計% = 石・キャラ・武器% + 大事なもの(3%)
  const totalEquipPercent = useMemo(() => {
    return bonusPercentInput + (useLiberInitis ? 3 : 0);
  }, [bonusPercentInput, useLiberInitis]);

  // 加算枠倍率 = 1.0 + (加算枠合計% / 100)
  const equipMultiplier = useMemo(() => {
    return 1.0 + totalEquipPercent / 100;
  }, [totalEquipPercent]);

  // 計算上の生倍率 = 雫 × トレハン × 風見鶏(1.20) × [1.0 + (加算合計% / 100)]
  const rawMultiplier = useMemo(() => {
    const val = dropBuffMultiplier * thMultiplier * windmillMultiplier * equipMultiplier;
    return Math.round(val * 10000) / 10000;
  }, [dropBuffMultiplier, thMultiplier, windmillMultiplier, equipMultiplier]);

  // 最終ドロップ倍率（上限300% = 最大3.000倍でキャップ）
  const MAX_DROP_MULTIPLIER = 3.000; // 上限 300% (3.000倍)
  const isCapped = useMemo(() => rawMultiplier > MAX_DROP_MULTIPLIER, [rawMultiplier]);

  const finalMultiplier = useMemo(() => {
    return Math.min(MAX_DROP_MULTIPLIER, rawMultiplier);
  }, [rawMultiplier]);

  const finalPercentUp = useMemo(() => {
    const pct = (finalMultiplier - 1) * 100;
    return Math.round(pct * 10) / 10;
  }, [finalMultiplier]);

  // アイテムの補正後ドロップ率 = アイテムによって変動% × 最終ドロップ倍率
  const itemBoostedRate = useMemo(() => {
    const rate = itemBaseRate * finalMultiplier;
    return Math.min(100, Math.round(rate * 10000) / 10000);
  }, [itemBaseRate, finalMultiplier]);

  // 最終実効ドロップ率 = (箱のドロップ率% / 100) × アイテムの補正後ドロップ率
  const simulatedRate = useMemo(() => {
    const finalRate = (boxDropRate / 100) * itemBoostedRate;
    return Math.min(100, Math.round(finalRate * 1000) / 1000);
  }, [boxDropRate, itemBoostedRate]);

  // 期待周回数（平均1個手に入る周回数 = 100 / 確率%）
  const expectedRuns = useMemo(() => {
    if (simulatedRate <= 0) return 0;
    return Math.ceil(100 / simulatedRate);
  }, [simulatedRate]);

  // 95%の確率で少なくとも1個手に入る周回数 = ln(1 - 0.95) / ln(1 - p)
  const runsFor95Percent = useMemo(() => {
    const p = simulatedRate / 100;
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return Math.ceil(Math.log(1 - 0.95) / Math.log(1 - p));
  }, [simulatedRate]);

  // プリセットトグル処理
  const togglePreset = (preset: PresetItem) => {
    const isActive = activePresetIds.includes(preset.id);
    let newIds: string[];
    let newPercent = bonusPercentInput;

    if (isActive) {
      newIds = activePresetIds.filter((id) => id !== preset.id);
      newPercent = Math.max(0, newPercent - preset.bonusPercent);
    } else {
      // 相互排他的なプリセットの自動解除
      if (preset.id === 'kaguya_both') {
        newIds = activePresetIds.filter((id) => id !== 'kaguya_single');
        if (activePresetIds.includes('kaguya_single')) {
          newPercent -= 30;
        }
      } else if (preset.id === 'kaguya_single') {
        newIds = activePresetIds.filter((id) => id !== 'kaguya_both');
        if (activePresetIds.includes('kaguya_both')) {
          newPercent -= 60;
        }
      } else if (preset.id === 'kaguya_god_both') {
        newIds = activePresetIds.filter((id) => id !== 'kaguya_god_single');
        if (activePresetIds.includes('kaguya_god_single')) {
          newPercent -= 20;
        }
      } else if (preset.id === 'kaguya_god_single') {
        newIds = activePresetIds.filter((id) => id !== 'kaguya_god_both');
        if (activePresetIds.includes('kaguya_god_both')) {
          newPercent -= 40;
        }
      } else if (preset.id === 'rabbit_both') {
        newIds = activePresetIds.filter((id) => id !== 'rabbit_single');
        if (activePresetIds.includes('rabbit_single')) {
          newPercent -= 15;
        }
      } else if (preset.id === 'rabbit_single') {
        newIds = activePresetIds.filter((id) => id !== 'rabbit_both');
        if (activePresetIds.includes('rabbit_both')) {
          newPercent -= 30;
        }
      } else {
        newIds = [...activePresetIds];
      }

      newIds.push(preset.id);
      newPercent += preset.bonusPercent;
    }

    setActivePresetIds(newIds);
    setBonusPercentInput(newPercent);
  };

  // 初期状態にリセット
  const handleResetAll = () => {
    setDropLv(5);
    setDropCp(2);
    setThLevel(9);
    setUseWindmill(true);
    setUseLiberInitis(true);
    setActivePresetIds(['kaguya_both', 'essel']);
    setBonusPercentInput(65);
    setBoxDropRate(2);
    setItemBaseRate(8.0);
  };

  // 雫のラベル文字列
  const dropBuffLabel = useMemo(() => {
    if (dropLv === 0) return 'なし (0%)';
    const cpText = dropCp === 1 ? '通常1倍' : `CP ${dropCp}倍`;
    return `Lv.${dropLv} × ${cpText} (+${dropBuffPercent}%)`;
  }, [dropLv, dropCp, dropBuffPercent]);

  // コピー機能
  const handleCopyResult = () => {
    const liberNote = useLiberInitis ? ` (装備等+${bonusPercentInput}% + 大事なもの+3% = 計+${totalEquipPercent}%)` : ` (+${totalEquipPercent}%)`;
    const boxNote = boxDropRate < 100 ? ` (箱ドロップ率${boxDropRate}%)` : '';
    const capNote = isCapped ? ` [※上限+300%キャップ適用 / 計算値 ${rawMultiplier.toFixed(3)}倍]` : '';
    const text = `【グラブル ドロップ率計算】\n最終ドロップ倍率: ${finalMultiplier.toFixed(3)}倍 (+${finalPercentUp.toFixed(1)}% UP)${capNote}\n内訳: 雫${dropBuffMultiplier.toFixed(2)}倍(${dropBuffLabel}) × TH${thLevel}(${thMultiplier}倍) × 風見鶏(${windmillMultiplier.toFixed(2)}倍) × 加算枠${equipMultiplier.toFixed(2)}倍${liberNote}\nアイテム変動基礎: ${itemBaseRate}% × 倍率${finalMultiplier.toFixed(3)} = ${itemBoostedRate.toFixed(3)}% → 実効ドロップ率: ${simulatedRate.toFixed(3)}%${boxNote} (期待値: 約${expectedRuns}周に1個)`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-6">
      {/* ヘッダー＆概要 */}
      <div className="bg-slate-900/90 border border-amber-500/30 rounded-2xl p-6 backdrop-blur-md shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full text-amber-300 text-xs font-semibold mb-2">
              <span>🎰</span>
              <span>DROP RATE CALCULATOR</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white tracking-wide flex items-center gap-2">
              ドロップ率シミュレーター
            </h2>
            <p className="text-slate-400 text-sm mt-1">
              雫(Lv×CP倍率) × トレハン × 風見鶏(1.2倍) × (1.0 + 石・キャラ・武器・大事なもの加算合計) の正確な計算式でリアルタイム算出します。（上限300% / 3.00倍キャップ対応）
            </p>
            <div className="mt-3 bg-slate-950/70 border border-amber-500/20 rounded-xl p-3 text-xs text-slate-300 space-y-1.5 leading-relaxed">
              <p>• 直近のイベント十天衆戦記に関してドロップ率の集計は行われていないので確率は不明</p>
              <p>• 100HELLにトレハンを入れても天星器のドロップ率が上がるだけなので意味は薄い、ただし至極殊越の指輪が落ちるのでオーバートレハンは効果がある(時間効率は非常に悪い)</p>
              <p>• 150HELLは極星器が落ちるのでドロップ率は上げる意味がある、オーバートレハンも至極殊越の指輪ともに最大4個落ちる可能性があるので意味がある</p>
            </div>
          </div>

          {/* リセットボタン */}
          <div>
            <button
              onClick={() => handleResetAll()}
              className="text-xs bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 px-3 py-1.5 rounded-lg transition active:scale-95 flex items-center gap-1 font-bold"
              title="すべてリセット"
            >
              <span>🔄</span>
              <span>初期状態にリセット</span>
            </button>
          </div>
        </div>
      </div>

      {/* ========================================================
          リアルタイム計算結果表示カード（Hero Section）
      ======================================================== */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-900/95 to-slate-950 border-2 border-amber-500/40 rounded-2xl p-6 shadow-2xl shadow-amber-500/10 relative overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          
          {/* 左側: 巨大な最終倍率 */}
          <div className="lg:col-span-5 text-center lg:text-left">
            <div className="flex items-center justify-center lg:justify-start gap-2 mb-1">
              <span className="text-xs font-bold text-amber-400 tracking-wider uppercase">
                FINAL MULTIPLIER (最終ドロップ倍率)
              </span>
              {isCapped && (
                <span className="text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/40 px-2 py-0.5 rounded-full font-bold animate-pulse">
                  上限300%到達 (3.00倍CAP)
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-center lg:justify-start gap-2">
              <span className="text-4xl sm:text-6xl font-black bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-200 bg-clip-text text-transparent tracking-tight">
                {finalMultiplier.toFixed(3)}
              </span>
              <span className="text-xl sm:text-2xl font-bold text-amber-400">倍</span>
            </div>
            <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-full text-xs font-bold text-amber-300">
              <span>ドロップ率 <span className="text-white">+{finalPercentUp.toFixed(1)}%</span> UP</span>
              {isCapped && <span className="text-rose-400 text-[11px]">(上限300%キャップ)</span>}
            </div>

            {isCapped && (
              <p className="text-[11px] text-slate-400 mt-1.5">
                ※計算上の倍率は {rawMultiplier.toFixed(3)}倍 (+{((rawMultiplier - 1) * 100).toFixed(1)}%) ですが、上限 300% (3.00倍) が適用されています。
              </p>
            )}

            <div className="mt-4">
              <button
                onClick={handleCopyResult}
                className="w-full sm:w-auto text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold px-4 py-2 rounded-xl border border-slate-700 transition flex items-center justify-center gap-2 mx-auto lg:mx-0 shadow active:scale-95"
              >
                <span>{copied ? '✅' : '📋'}</span>
                <span>{copied ? '結果をコピーしました！' : '計算結果をコピー'}</span>
              </button>
            </div>
          </div>

          {/* 右側: 乗算枠のブレイクダウン内訳カード（4枠） */}
          <div className="lg:col-span-7">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-2.5 text-center">
              
              {/* 雫枠 */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 sm:p-3 hover:border-amber-500/30 transition">
                <div className="text-[10px] sm:text-[11px] text-slate-400 font-medium mb-1">① 軌跡の雫</div>
                <div className="text-base sm:text-xl font-bold text-cyan-400">
                  {dropBuffMultiplier.toFixed(2)}
                  <span className="text-[10px] font-normal text-slate-400 ml-0.5">倍</span>
                </div>
                <div className="text-[9px] sm:text-[10px] text-slate-400 mt-0.5 truncate">
                  {dropBuffLabel}
                </div>
              </div>

              {/* トレハン枠 */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 sm:p-3 hover:border-amber-500/30 transition">
                <div className="text-[10px] sm:text-[11px] text-slate-400 font-medium mb-1">② トレハン</div>
                <div className="text-base sm:text-xl font-bold text-yellow-400">
                  {thMultiplier.toFixed(2)}
                  <span className="text-[10px] font-normal text-slate-400 ml-0.5">倍</span>
                </div>
                <div className="text-[9px] sm:text-[10px] text-slate-400 mt-0.5">
                  Lv.{thLevel} (+{((thMultiplier - 1) * 100).toFixed(0)}%)
                </div>
              </div>

              {/* 常時バフ枠（風見鶏） */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 sm:p-3 hover:border-amber-500/30 transition">
                <div className="text-[10px] sm:text-[11px] text-slate-400 font-medium mb-1">③ 風見鶏(乗算)</div>
                <div className={`text-base sm:text-xl font-bold ${useWindmill ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {windmillMultiplier.toFixed(2)}
                  <span className="text-[10px] font-normal text-slate-400 ml-0.5">倍</span>
                </div>
                <div className="text-[9px] sm:text-[10px] text-slate-400 mt-0.5 truncate">
                  {useWindmill ? '団サポート(1.2倍)' : 'OFF (1.0倍)'}
                </div>
              </div>

              {/* 加算枠（石・キャラ・武器・大事なもの） */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2.5 sm:p-3 hover:border-amber-500/30 transition">
                <div className="text-[10px] sm:text-[11px] text-slate-400 font-medium mb-1">④ 加算枠合計</div>
                <div className="text-base sm:text-xl font-bold text-amber-400">
                  {equipMultiplier.toFixed(2)}
                  <span className="text-[10px] font-normal text-slate-400 ml-0.5">倍</span>
                </div>
                <div className="text-[9px] sm:text-[10px] text-slate-400 mt-0.5 truncate">
                  合計 +{totalEquipPercent}%
                </div>
              </div>
            </div>

            {/* 計算式バー */}
            <div className="mt-3 bg-slate-950/90 border border-slate-800/80 rounded-xl p-2.5 px-3 text-xs text-slate-300 flex items-center justify-between overflow-x-auto whitespace-nowrap">
              <span className="text-slate-400 text-[11px]">計算式:</span>
              <span className="font-mono text-amber-300 font-bold ml-2 text-[11px] sm:text-xs">
                {dropBuffMultiplier.toFixed(2)} <span className="text-slate-400">×</span> {thMultiplier.toFixed(2)}{' '}
                <span className="text-slate-400">×</span> {windmillMultiplier.toFixed(2)}{' '}
                <span className="text-slate-400">×</span> (1.0 + {totalEquipPercent}%) ={' '}
                <span className="text-amber-400 text-sm font-black">
                  {finalMultiplier.toFixed(3)}倍 {isCapped ? '(上限300%CAP)' : ''}
                </span>
              </span>
            </div>
          </div>

        </div>
      </div>

      {/* ========================================================
          設定パネル（グリッドレイアウト）
      ======================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* 左カラム: 雫・トレハン・常時バフ */}
        <div className="space-y-6">
          
          {/* 1. 軌跡の雫 */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 backdrop-blur-sm space-y-3.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-amber-400">💧</span>
                <span>1. 軌跡の雫（ドロップUP効果）</span>
              </label>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/30 font-mono">
                {dropBuffMultiplier.toFixed(2)}倍 (+{dropBuffPercent}%)
              </span>
            </div>

            {/* 雫 Lv 選択 */}
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                雫 レベル選択
              </span>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                {[
                  { lv: 0, label: 'なし', pct: '+0%' },
                  { lv: 1, label: 'Lv1', pct: '+2%' },
                  { lv: 2, label: 'Lv2', pct: '+5%' },
                  { lv: 3, label: 'Lv3', pct: '+7%' },
                  { lv: 4, label: 'Lv4', pct: '+10%' },
                  { lv: 5, label: 'Lv5', pct: '+15%' },
                ].map((item) => (
                  <button
                    key={item.lv}
                    onClick={() => setDropLv(item.lv)}
                    className={`py-2 px-1.5 rounded-xl border text-center transition flex flex-col items-center justify-center ${
                      dropLv === item.lv
                        ? 'bg-amber-500/20 border-amber-400 text-white shadow-md'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="font-bold text-xs">{item.label}</span>
                    <span className={`text-[10px] font-mono mt-0.5 ${dropLv === item.lv ? 'text-amber-300' : 'text-slate-500'}`}>
                      {item.pct}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* 雫 CP倍率選択 */}
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                キャンペーン倍率（雫効果への乗算）
              </span>
              <div className="grid grid-cols-3 gap-2">
                {DROP_CP_OPTIONS.map((cpOpt) => (
                  <button
                    key={cpOpt.multiplier}
                    onClick={() => setDropCp(cpOpt.multiplier)}
                    className={`py-2 px-2 rounded-xl border text-center transition flex items-center justify-center gap-1.5 ${
                      dropCp === cpOpt.multiplier
                        ? 'bg-gradient-to-r from-amber-500/25 to-yellow-500/25 border-amber-400 text-white font-bold shadow-md'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-xs">{cpOpt.label}</span>
                  </button>
                ))}
              </div>
            </div>

          </div>

          {/* 2. トレジャーハント（TH） */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-yellow-400">🎯</span>
                <span>2. トレジャーハント (TH)</span>
              </label>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-300 font-bold border border-yellow-500/30">
                Lv.{thLevel} : {thMultiplier.toFixed(2)}倍 (+{((thMultiplier - 1) * 100).toFixed(0)}%)
              </span>
            </div>

            {/* スライダー */}
            <input
              type="range"
              min="0"
              max="10"
              step="1"
              value={thLevel}
              onChange={(e) => setThLevel(Number(e.target.value))}
              className="w-full accent-amber-400 h-2 bg-slate-950 rounded-lg cursor-pointer mb-4"
            />

            {/* クイック選択ボタン (0〜10) */}
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-11 gap-1.5">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((lv) => (
                <button
                  key={lv}
                  onClick={() => setThLevel(lv)}
                  className={`py-2 rounded-lg text-xs font-bold transition border ${
                    thLevel === lv
                      ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-slate-950 border-amber-300 shadow-md'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                  }`}
                >
                  {lv === 0 ? 'なし' : `${lv}`}
                </button>
              ))}
            </div>
          </div>

          {/* 3. 常時発動バフ（風見鶏＆リーベル・イニティス） */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 backdrop-blur-sm space-y-4">
            <div className="text-sm font-bold text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-cyan-400">👑</span>
                <span>3. 常時発動バフ（風見鶏 ＆ 大事なもの）</span>
              </div>
            </div>

            {/* 風見鶏 */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800/80">
              <div>
                <div className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span>🐓</span>
                  <span>風見鶏の羽（騎空団サポート）</span>
                  <span className="text-[10px] px-1.5 py-0.2 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded font-bold">
                    乗算 1.20倍
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">全体の最終倍率に 1.20倍 を乗算</p>
              </div>

              <button
                onClick={() => setUseWindmill(!useWindmill)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  useWindmill ? 'bg-amber-500' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    useWindmill ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* リーベル・イニティス */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800/80">
              <div>
                <div className="text-xs font-bold text-white flex items-center gap-1.5">
                  <span>📖</span>
                  <span>大事なもの「リーベル・イニティス」</span>
                  <span className="text-[10px] px-1.5 py-0.2 bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 rounded font-bold">
                    加算 +3%
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">大事なもの効果（石・キャラ・武器枠に +3% を加算）</p>
              </div>

              <button
                onClick={() => setUseLiberInitis(!useLiberInitis)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  useLiberInitis ? 'bg-cyan-500' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    useLiberInitis ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

          </div>

        </div>

        {/* 右カラム: 編成加算枠（石・キャラ・武器・大事なもの プリセット ＆ 直接入力） */}
        <div className="space-y-6">
          
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-amber-400">⚔️</span>
                <span>4. 編成加算枠（石・キャラ・武器・大事なもの）</span>
              </label>
              <div className="text-xs text-amber-400 font-bold">
                加算合計: +{totalEquipPercent}% {useLiberInitis ? `(装備等+${bonusPercentInput}% + 大事なもの+3%)` : ''}
              </div>
            </div>
            <p className="text-xs text-slate-400 mb-2">
              下のプリセットボタンを押すか、数値を直接入力して設定できます。
            </p>
            <div className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5 mb-4 leading-relaxed">
              ⚠️ ゴットラビットの加護3%とメインの加護ドロ率UPとは共存しません手動で3%を加算させてください<br />
              <span className="text-slate-400">（例: サブゴットラビット3%＋片面フレカグヤ4凸30%で合計33%）</span>
            </div>

            {/* 数値直接入力 */}
            <div className="flex items-center gap-3 mb-5">
              <div className="relative flex-1">
                <input
                  type="number"
                  min="0"
                  max="500"
                  value={bonusPercentInput}
                  onChange={(e) => setBonusPercentInput(Math.max(0, Number(e.target.value)))}
                  className="w-full bg-slate-950 border border-slate-700 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 rounded-xl px-4 py-2.5 text-white font-mono text-lg outline-none transition"
                />
                <span className="absolute right-3 top-3 text-slate-400 font-bold text-sm">%</span>
              </div>
              <button
                onClick={() => setBonusPercentInput(0)}
                className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white px-3 py-3 rounded-xl border border-slate-700 transition"
              >
                クリア
              </button>
            </div>

            {/* プリセット選択ボタングループ */}
            <div className="space-y-4">
              
              {/* 召喚石グループ */}
              <div>
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                  召喚石 加護
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PRESET_ITEMS.filter((p) => p.category === 'summon').map((item) => {
                    const active = activePresetIds.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        onClick={() => togglePreset(item)}
                        className={`p-2.5 rounded-xl border text-left transition flex items-center justify-between gap-2 ${
                          active
                            ? 'bg-amber-500/20 border-amber-400 text-white'
                            : 'bg-slate-950/80 border-slate-800/80 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-base shrink-0">{item.icon}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold leading-tight break-words">{item.name}</div>
                            <div className="text-[10px] text-slate-400 leading-tight mt-0.5 break-words">{item.description}</div>
                          </div>
                        </div>
                        <span className={`text-xs font-mono font-bold shrink-0 self-center px-1.5 py-0.5 rounded ${active ? 'bg-amber-500/30 text-amber-300' : 'bg-slate-900 text-slate-400'}`}>
                          +{item.bonusPercent}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* キャラ・武器グループ */}
              <div>
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                  キャラ / 武器 スキル
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PRESET_ITEMS.filter((p) => p.category === 'character' || p.category === 'weapon').map((item) => {
                    const active = activePresetIds.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        onClick={() => togglePreset(item)}
                        className={`p-2.5 rounded-xl border text-left transition flex items-center justify-between gap-2 ${
                          active
                            ? 'bg-amber-500/20 border-amber-400 text-white'
                            : 'bg-slate-950/80 border-slate-800/80 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="text-base shrink-0">{item.icon}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold leading-tight break-words">{item.name}</div>
                            <div className="text-[10px] text-slate-400 leading-tight mt-0.5 break-words">{item.description}</div>
                          </div>
                        </div>
                        <span className={`text-xs font-mono font-bold shrink-0 self-center px-1.5 py-0.5 rounded ${active ? 'bg-amber-500/30 text-amber-300' : 'bg-slate-900 text-slate-400'}`}>
                          +{item.bonusPercent}%
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

            </div>

          </div>

        </div>

      </div>

      {/* ========================================================
          実戦シミュレーター（箱のドロップ率 ＆ 変動% × 最終倍率）
      ======================================================== */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 backdrop-blur-sm shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <span>📊</span>
              <span>実効ドロップ率＆期待周回数シミュレーション</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              計算式: <span className="text-amber-300 font-mono font-bold">アイテムによって変動% × 最終ドロップ倍率</span>（箱ドロップ率を考慮・上限+300%）
            </p>
          </div>
        </div>

        {/* 2段の入力エリア: 箱のドロップ率 & アイテム変動% */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          
          {/* 1. 箱のドロップ率 */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-white flex items-center gap-1.5">
                <span>📦</span>
                <span>箱のドロップ率（%）</span>
              </label>
              <span className="text-xs font-mono text-cyan-400 font-bold">
                {boxDropRate}%
              </span>
            </div>
            
            <div className="relative">
              <input
                type="number"
                step="1"
                min="1"
                max="100"
                value={boxDropRate}
                onChange={(e) => setBoxDropRate(Math.min(100, Math.max(1, Number(e.target.value))))}
                className="w-full bg-slate-900 border border-slate-700 focus:border-amber-400 rounded-lg px-3 py-2 text-white font-mono outline-none"
              />
              <span className="absolute right-3 top-2 text-slate-400 text-sm font-bold">%</span>
            </div>

            {/* 箱プリセット */}
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_BOX_RATES.map((box) => (
                <button
                  key={box.name}
                  onClick={() => setBoxDropRate(box.rate)}
                  className={`text-[11px] px-2 py-1 rounded-lg border transition ${
                    boxDropRate === box.rate
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {box.name}
                </button>
              ))}
            </div>
          </div>

          {/* 2. アイテムによって変動% */}
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-white flex items-center gap-1.5">
                <span>💎</span>
                <span>アイテムによって変動（基礎%）</span>
              </label>
              <span className="text-xs font-mono text-amber-400 font-bold">
                {itemBaseRate}%
              </span>
            </div>

            <div className="relative">
              <input
                type="number"
                step="0.01"
                min="0.001"
                max="100"
                value={itemBaseRate}
                onChange={(e) => setItemBaseRate(Math.max(0, Number(e.target.value)))}
                className="w-full bg-slate-900 border border-slate-700 focus:border-amber-400 rounded-lg px-3 py-2 text-white font-mono outline-none"
              />
              <span className="absolute right-3 top-2 text-slate-400 text-sm font-bold">%</span>
            </div>

            {/* アイテムプリセット */}
            <div className="flex flex-wrap gap-1.5">
              {SAMPLE_DROPS.map((sample) => (
                <button
                  key={sample.name}
                  onClick={() => setItemBaseRate(sample.rate)}
                  className={`text-[11px] px-2 py-1 rounded-lg border transition ${
                    itemBaseRate === sample.rate
                      ? 'bg-amber-500/20 border-amber-400 text-amber-300 font-bold'
                      : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  {sample.name}
                </button>
              ))}
            </div>
          </div>

        </div>

        {/* シミュレーション結果表示カード */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center bg-slate-950/90 border border-amber-500/30 rounded-xl p-4">
          
          {/* 実効ドロップ率 */}
          <div className="text-center md:text-left">
            <span className="text-xs text-slate-400 block mb-1">現在の実効ドロップ率</span>
            <div className="text-2xl sm:text-3xl font-black text-amber-400 font-mono">
              {simulatedRate.toFixed(3)}%
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              {itemBaseRate}% × {finalMultiplier.toFixed(3)}倍 {boxDropRate < 100 ? `× 箱${boxDropRate}%` : ''}
            </span>
          </div>

          {/* 平均必要周回数（期待値1個） */}
          <div className="text-center md:text-left md:border-l border-slate-800 md:pl-4">
            <span className="text-xs text-slate-400 block mb-1">1個ドロップの平均周回数</span>
            <div className="text-2xl sm:text-3xl font-black text-cyan-400 font-mono">
              約 {expectedRuns.toLocaleString()} <span className="text-xs font-normal text-slate-400">周</span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              バフなし時: 約 {Math.ceil(100 / (((boxDropRate / 100) * itemBaseRate) || 1)).toLocaleString()}周
            </span>
          </div>

          {/* 95%確率ライン */}
          <div className="text-center md:text-left md:border-l border-slate-800 md:pl-4">
            <span className="text-xs text-slate-400 block mb-1">95%以上の確率で入手</span>
            <div className="text-2xl sm:text-3xl font-black text-yellow-300 font-mono">
              約 {runsFor95Percent.toLocaleString()} <span className="text-xs font-normal text-slate-400">周</span>
            </div>
            <span className="text-[11px] text-slate-400 block mt-0.5">
              ほぼ確実に1個落ちる目安周回数
            </span>
          </div>

        </div>
      </div>

      {/* グラブルのドロップ仕様に関する豆知識 */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed space-y-1.5">
        <div className="font-bold text-slate-300 flex items-center gap-1.5 mb-1">
          <span>💡</span>
          <span>グラブルのドロップ仕様メモ</span>
        </div>
        <p>• <strong>ドロップ率上限:</strong> ドロップ率UP効果の最終倍率は **300%（最大3.000倍）** が上限となり、これを超えた分は切り捨てられます。</p>
        <p>• <strong>雫効果:</strong> Lv1(+2%), Lv2(+5%), Lv3(+7%), Lv4(+10%), Lv5(+15%) に、キャンペーン倍率（通常1倍 / CP2倍 / CP4倍）が乗算されます。</p>
        <p>• <strong>大事なもの:</strong> 「リーベル・イニティス」の効果は「石・キャラ・武器・大事なもの」の加算枠として +3% 加算されます。</p>
        <p>• <strong>シミュレーター:</strong> 「アイテムによって変動% × 最終ドロップ倍率」に、対象の「箱のドロップ率（確定箱なら100%）」を乗算して実戦期待値を算出します。</p>
        <p>• <strong>注意:</strong> 一部の確定ドロップ箱（金箱・自発箱・順位赤箱など）や、ドロップ率UP効果の対象外となる固定報酬箱には影響しません。</p>
      </div>

      {/* 参考資料・クレジット */}
      <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
        <div className="font-bold text-slate-300 flex items-center gap-1.5 mb-2">
          <span>📚</span>
          <span>参考</span>
        </div>
        <div className="space-y-1.5">
          <div>
            <span className="text-slate-300 font-semibold">音黒くろさん: </span>
            <a
              href="https://x.com/otokuro2"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-400 hover:text-amber-300 hover:underline font-mono"
            >
              https://x.com/otokuro2
            </a>
          </div>
          <ul className="space-y-1 pl-3 border-l border-slate-800 font-mono text-[11px]">
            <li>
              <a
                href="https://x.com/otokuro2/status/1746075817858527250"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
              >
                <span>🔗</span>
                <span>https://x.com/otokuro2/status/1746075817858527250</span>
              </a>
            </li>
            <li>
              <a
                href="https://x.com/otokuro2/status/2044406289942634571"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
              >
                <span>🔗</span>
                <span>https://x.com/otokuro2/status/2044406289942634571</span>
              </a>
            </li>
            <li>
              <a
                href="https://x.com/otokuro2/status/1865597273365004718"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 hover:underline flex items-center gap-1"
              >
                <span>🔗</span>
                <span>https://x.com/otokuro2/status/1865597273365004718</span>
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};
