'use client';

import React from 'react';
import { ExternalLink } from '@/types';

const TOOLS: ExternalLink[] = [
  {
    id: '1',
    title: '古戦場 周回効率計算機',
    category: '騎空団専用ツール',
    description: '討伐秒数とロード硬直時間を入力するだけで、1時間あたりの貢献度時速・周回数・消費肉数を自動計算します。目標貢献度（10億など）からの逆算や全難易度の時速比較機能も搭載しています。',
    url: '../時速ツール/index.html',
    icon: '⏱️',
    highlight: true
  }
];

export const LinksSection: React.FC = () => {
  return (
    <div className="max-w-2xl mx-auto">
      {TOOLS.map(link => (
        <a
          key={link.id}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group block p-6 sm:p-8 rounded-2xl bg-slate-900/80 border border-amber-500/40 hover:border-amber-400 transition backdrop-blur-md shadow-xl shadow-amber-500/5 hover:shadow-amber-500/15"
        >
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center justify-center text-3xl group-hover:scale-110 transition shadow-lg shadow-amber-500/10">
              {link.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-xl font-bold text-white group-hover:text-amber-300 transition">
                  {link.title}
                </h4>
                <span className="text-xs px-2.5 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full font-bold">
                  {link.category}
                </span>
              </div>
              <span className="text-xs text-slate-400">90HELL〜250HELL対応 / 貢献度時速・必要肉数・目標逆算</span>
            </div>
          </div>

          <p className="text-sm text-slate-300 leading-relaxed bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            {link.description}
          </p>

          <div className="mt-4 flex items-center justify-end text-xs font-bold text-amber-400 group-hover:translate-x-1 transition gap-1">
            <span>ツールを開く</span>
            <span>→</span>
          </div>
        </a>
      ))}
    </div>
  );
};
