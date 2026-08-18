'use client';

import React, { useState } from 'react';

const RECRUIT_TEXT = `はじめまして！めろ～ん王国団長のゆかり愛といいます。フリーランで予選300位以内平均3勝以上で安定してる団です。よろしければぜひご検討ください！

※条件 ノルマ＋実装済みオリジンジョブレベル５０を間に合わせれる、ヴェルサシア挑戦済みもしくは挑戦する気のある、かつやる気のある方

【騎空団名】 めろ～ん王国
【団長ID】804235
【勧誘担当ID】 15436050　※団長かどちらかに言ってもらえればOKです！
【団員の平均ランク】425
【施設(船LV/サポート)】サポート：ポーション、風見鶏、銅鑼、虹炉、勉強机
【団員数】 現在30名

【古戦場】
・予選は出来るだけ200位あたりで着地したいので余裕のあるメンバーで調整しています。

・勝ちは常に目指していますが、敗色濃厚な場合は出来るだけ早期に撤退、その後は古戦場周回でも日課でも自由になります。

・勝敗が早期に判明するような相手団に対しては目標貢献度を設定しその貢献度を超えたら古戦場以外の日課なども自由になります。

・納品ボックスに関しては各自自由

・接戦時は各自が出来る範囲で協力お願いします

低空指示の強制はありませんが余裕のある人が１、２戦目に貢献度を抑えてくれているので成績も予選300位以内で平均3勝以上で安定してます。

【団マルチ】 ヴェルサシアやる気があるけど、未挑戦の人には挑戦のフォローをしています。また、古戦場向けのヴェルサシアの恩寵キャリーも積極的に行っています！（キャリーの内容については、キャラ装備不足していても行けるものを各自に説明しますのでご安心を）

☆前回は火破壊武器5凸22名達成☆

ヴェルサシア(まだ1名)、天元、ルシゼロおすそ分けを流してくれている人も団に何人かいます！！

・古戦場前に要請があったとき、古戦場参戦可能な予定（日ごとに何時から何時という形で)をシート記入または団長挨拶欄へ連絡をお願いしてます。※あくまで団アビ発動時間等作戦の参考にするため

☆ノルマ
4戦目に250HELLを20体以上討伐またはそれに相当する貢献度15億稼ぐ、本戦最終順位個人10万位以内（連期割れで除名対象)、

・ドレッドバラージュ最大報酬獲得に必要なものの1/30(150万貢献度)⇚※ドレッドバラージュのみ参加の人はこの条件だけでOK

※禁止事項
・ノルマ２期連続達成失敗
・３日以上の連続非ログイン
・4日以上応答なし
・報連相ができない、やる気がないと感じる等が重なった場合、こちらの裁量で退団処理の可能性があります。

ルール
・団に救援を流す際は、他参戦者が戦闘不能or動けなくなる場合、自身が戦闘不能となるまでは行動し、外部救援も活用し速やかな討伐に努め放置しないこと

【外部ツール】※非強制
・スプレッドシート
・Xツイッター(スプレッドシートのURL案内用)※個人的なDM等もすることもあるかもしれません

以上です。ご質問などあればお気軽にどうぞ。
ご連絡お待ちしておりますm(_ _)m`;

export const RecruitSection: React.FC = () => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(RECRUIT_TEXT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 backdrop-blur-md space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2.5 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-xs font-bold">
              騎空団員募集
            </span>
            <span className="text-xs text-slate-400">最新要項</span>
          </div>
          <h3 className="text-xl font-bold text-white">めろ～ん王国 団員募集要項</h3>
        </div>
        <button
          onClick={handleCopy}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition transform active:scale-95 whitespace-nowrap"
        >
          <span>📋</span>
          <span>{copied ? 'コピーしました！✨' : '募集全文をコピー'}</span>
        </button>
      </div>

      {/* Basic Info Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">騎空団名</span>
          <strong className="text-base text-white font-bold">めろ～ん王国</strong>
        </div>
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">団長ID（ゆかり愛）</span>
          <strong className="text-base text-amber-300 font-mono font-bold">804235</strong>
        </div>
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">勧誘担当ID</span>
          <strong className="text-base text-cyan-300 font-mono font-bold">15436050</strong>
        </div>
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">団員の平均ランク</span>
          <strong className="text-base text-white font-bold">425</strong>
        </div>
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">団員数</span>
          <strong className="text-base text-white font-bold">現在30名</strong>
        </div>
        <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3.5">
          <span className="block text-xs text-slate-400">団サポート</span>
          <strong className="text-xs text-slate-200 block mt-1">ポーション・風見鶏・銅鑼・虹炉・机</strong>
        </div>
      </div>

      {/* Full Text Display */}
      <div className="bg-slate-950/90 border border-slate-800 rounded-xl p-5 text-sm text-slate-200 leading-relaxed font-mono whitespace-pre-wrap select-all">
        {RECRUIT_TEXT}
      </div>
    </div>
  );
};
