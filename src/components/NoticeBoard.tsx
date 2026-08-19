'use client';

import React, { useState } from 'react';
import { Notice } from '@/types';

const INITIAL_NOTICES: Notice[] = [
  {
    id: '1',
    title: '次回光有利古戦場の個人ノルマ・目標について',
    category: '古戦場',
    author: '',
    date: '',
    content: `4戦目に250HELLを20体以上討伐またはそれに相当する貢献度15億稼ぐ、本戦最終順位個人10万位以内（連期割れで除名対象)。`
  },
  {
    id: '2',
    title: '傭兵　ノルマ',
    category: '古戦場',
    author: '',
    date: '',
    content: `募集する時期などにより変動あり、現在は10万位以内`
  },
  {
    id: '3',
    title: 'ドレッドバラージュの目標・ノルマについて',
    category: 'ドレバラ',
    author: '',
    date: '',
    content: `最大報酬獲得に必要なものの1/30(150万貢献度)⇚※ドレッドバラージュのみ参加の人はこの条件だけでOK`
  },
  {
    id: '4',
    title: '禁止事項',
    category: '団規約',
    author: '',
    date: '',
    content: `・ノルマ２期連続達成失敗
・３日以上の連続非ログイン
・4日以上応答なし
・報連相ができない、やる気がないと感じる等が重なった場合、こちらの裁量で退団処理の可能性があります。`
  },
  {
    id: '5',
    title: 'マルチのルール',
    category: 'マルチ',
    author: '',
    date: '',
    content: `団に救援を流す際は、他参戦者が戦闘不能or動けなくなる場合、自身が戦闘不能となるまでは行動し、外部救援も活用し速やかな討伐に努め放置しないこと`
  }
];

export const NoticeBoard: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<string>('全て');

  const categories = ['全て', '古戦場', 'ドレバラ', '団規約', 'マルチ'];

  const filteredNotices = selectedCategory === '全て' 
    ? INITIAL_NOTICES 
    : INITIAL_NOTICES.filter(n => n.category === selectedCategory);

  return (
    <div className="space-y-4">
      {/* Category Filter Chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
              selectedCategory === cat 
                ? 'bg-amber-500 text-slate-950 font-bold' 
                : 'bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Notices List */}
      <div className="space-y-4">
        {filteredNotices.map(notice => (
          <div 
            key={notice.id} 
            className={`p-5 rounded-2xl backdrop-blur-md transition ${
              notice.category === '団規約'
                ? 'bg-slate-900/60 border border-rose-500/20 hover:border-rose-500/30'
                : 'bg-slate-900/60 border border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2 py-0.5 text-xs font-bold rounded-md ${
                  notice.category === '古戦場' ? 'bg-cyan-500/20 text-cyan-300' :
                  notice.category === 'ドレバラ' ? 'bg-emerald-500/20 text-emerald-300' :
                  notice.category === '団規約' ? 'bg-rose-500/20 text-rose-300' :
                  'bg-cyan-500/20 text-cyan-300'
                }`}>
                  {notice.category}
                </span>
                <h3 className="text-base font-bold text-white">{notice.title}</h3>
              </div>
            </div>

            <div className="text-slate-300 text-sm whitespace-pre-line leading-relaxed bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
              {notice.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
