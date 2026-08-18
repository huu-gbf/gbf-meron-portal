'use client';

import React from 'react';
import { UpdateHistoryItem } from '@/types';

const UPDATE_LOGS: UpdateHistoryItem[] = [
  {
    id: '1',
    date: '2026/08/19',
    category: '開設',
    title: 'めろ～ん王国 ポータルサイト運用開始',
    description: '本日より騎空団専用ポータルサイトの運用を開始しました。',
    author: ''
  }
];

export const UpdateHistory: React.FC = () => {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 backdrop-blur-md">
      <div className="flex items-center justify-between mb-6 pb-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xl">🔄</span>
          <h3 className="text-lg font-bold text-white">団内ポータル 更新履歴</h3>
        </div>
        <span className="text-xs text-slate-400">最終更新: 2026/08/19</span>
      </div>

      {/* Timeline list */}
      <div className="relative pl-6 space-y-6 before:content-[''] before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
        {UPDATE_LOGS.map((item) => (
          <div key={item.id} className="relative">
            {/* Timeline Dot */}
            <span className="absolute -left-6 top-1.5 w-4 h-4 rounded-full border-4 border-slate-950 bg-amber-400 shadow-md shadow-amber-500/40" />

            <div className="bg-slate-950/70 border border-slate-800/90 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-mono font-bold text-amber-300 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded">
                  {item.date}
                </span>
                <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  運用開始
                </span>
                <strong className="text-sm font-bold text-white">
                  {item.title}
                </strong>
              </div>

              {item.description && (
                <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/60 mt-2">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
