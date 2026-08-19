'use client';

import React, { useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { NoticeBoard } from '@/components/NoticeBoard';
import { ScheduleSection } from '@/components/ScheduleSection';
import { RecruitSection } from '@/components/RecruitSection';
import { LinksSection } from '@/components/LinksSection';
import { UpdateHistory } from '@/components/UpdateHistory';
import { DropRateCalculator } from '@/components/DropRateCalculator';

export default function Home() {
  const [activeTab, setActiveTab] = useState<'schedule' | 'drops' | 'notices' | 'recruit' | 'links' | 'history'>('drops');

  return (
    <AuthGate>
      <main className="max-w-6xl mx-auto px-4 pt-8 pb-16 relative z-10">
        {/* Crew Banner */}
        <div className="bg-slate-900/80 border border-amber-500/20 rounded-2xl p-6 mb-8 backdrop-blur-md relative overflow-hidden shadow-2xl shadow-amber-500/5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-400 mb-1">
                <span>👑</span> 騎空団基本情報
              </span>
              <h2 className="text-xl sm:text-2xl font-black text-white">
                決戦！星の古戦場（光属性有利）準備期間中
              </h2>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center min-w-[280px]">
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3">
                <span className="block text-[11px] text-slate-400">団員数</span>
                <strong className="text-lg text-white font-bold">30 / 30</strong>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3">
                <span className="block text-[11px] text-slate-400">団グレード</span>
                <strong className="text-lg text-amber-400 font-bold">SSS</strong>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3">
                <span className="block text-[11px] text-slate-400">団サポ</span>
                <strong className="text-lg text-cyan-400 font-bold">LvMAX</strong>
              </div>
            </div>
          </div>
        </div>

        {/* Tab Buttons */}
        <div className="flex items-center gap-2 border-b border-slate-800 mb-6 pb-2 overflow-x-auto">
          <button
            onClick={() => setActiveTab('drops')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'drops'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🎰</span>
            <span>ドロップ率計算機</span>
          </button>
          <button
            onClick={() => setActiveTab('schedule')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'schedule'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>📅</span>
            <span>古戦場・イベント予定</span>
          </button>
          <button
            onClick={() => setActiveTab('notices')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'notices'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>📜</span>
            <span>団規約等</span>
          </button>
          <button
            onClick={() => setActiveTab('recruit')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'recruit'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>📝</span>
            <span>現在の団員募集内容</span>
          </button>
          <button
            onClick={() => setActiveTab('links')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'links'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🔗</span>
            <span>ツール</span>
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition flex items-center gap-2 whitespace-nowrap ${
              activeTab === 'history'
                ? 'bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <span>🔄</span>
            <span>更新履歴</span>
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'drops' && <DropRateCalculator />}
        {activeTab === 'schedule' && <ScheduleSection />}
        {activeTab === 'notices' && <NoticeBoard />}
        {activeTab === 'recruit' && <RecruitSection />}
        {activeTab === 'links' && <LinksSection />}
        {activeTab === 'history' && <UpdateHistory />}
      </main>
    </AuthGate>
  );
}
