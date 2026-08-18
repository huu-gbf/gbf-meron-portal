'use client';

import React from 'react';
import { ScheduleEvent } from '@/types';

const UNF_EVENTS: ScheduleEvent[] = [
  {
    id: '1',
    title: '予選',
    period: '21日(月) 19:00 〜 22日(火) 23:59',
    description: '※90HELL / 95HELL解禁',
    type: 'prelim'
  },
  {
    id: '2',
    title: '予選集計',
    period: '23日(水) 00:00 〜 23日(水) 06:59',
    description: '集計期間',
    type: 'event'
  },
  {
    id: '3',
    title: 'インターバル',
    period: '23日(水) 07:00 〜 24日(木) 06:59',
    description: '肉集め＆トリガー確保',
    type: 'interval'
  },
  {
    id: '4',
    title: '本戦 1戦目',
    period: '24日(木) 07:00 〜 24日(木) 23:59',
    description: '※100HELL / 150HELL解禁',
    type: 'finals'
  },
  {
    id: '5',
    title: '本戦 2戦目',
    period: '25日(金) 07:00 〜 25日(金) 23:59',
    description: '※200HELL解禁',
    type: 'finals'
  },
  {
    id: '6',
    title: '本戦 3戦目',
    period: '26日(土) 07:00 〜 26日(土) 23:59',
    description: '※250HELL解禁',
    type: 'finals'
  },
  {
    id: '7',
    title: '本戦 4戦目',
    period: '27日(日) 07:00 〜 27日(日) 23:59',
    description: '最終決戦（250HELLノルマ日）',
    type: 'finals'
  },
  {
    id: '8',
    title: 'スペシャルバトル',
    period: '28日(月) 07:00 〜 28日(月) 23:59',
    description: '※ゼウス戦（討伐報酬獲得）',
    type: 'special'
  }
];

export const ScheduleSection: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* UNF Main Timeline */}
      <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5 pb-3 border-b border-slate-800">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <span>⚔️</span> 次回「決戦！星の古戦場（光属性有利）」日程表
          </h3>
          <span className="text-xs px-3 py-1 bg-amber-500/10 text-amber-300 border border-amber-500/30 rounded-full font-semibold font-mono">
            全体期間: 09/21(月) 19:00 〜 09/28(月) 23:59
          </span>
        </div>

        <div className="space-y-2.5">
          {UNF_EVENTS.map(event => (
            <div 
              key={event.id} 
              className={`flex flex-col sm:flex-row sm:items-center justify-between p-3.5 rounded-xl border gap-2 ${
                event.type === 'event'
                  ? 'bg-slate-950/40 border-slate-800/60 opacity-80'
                  : 'bg-slate-950/70 border-slate-800/80'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  event.type === 'prelim' ? 'bg-cyan-400' :
                  event.type === 'event' ? 'bg-slate-500' :
                  event.type === 'interval' ? 'bg-slate-400' :
                  event.type === 'finals' ? 'bg-amber-400' :
                  'bg-purple-400'
                }`} />
                <div>
                  <strong className={`text-sm ${event.type === 'event' ? 'text-slate-300' : 'text-white'}`}>
                    {event.title}
                  </strong>
                  <span className={`text-xs block sm:inline sm:ml-2 ${
                    event.description.includes('※') ? 'text-amber-300 font-semibold' : 'text-slate-400'
                  }`}>
                    {event.description}
                  </span>
                </div>
              </div>
              <span className={`text-xs font-mono px-2.5 py-1 rounded whitespace-nowrap border ${
                event.type === 'special' ? 'text-purple-200 bg-slate-900 border-slate-800' :
                event.type === 'event' ? 'text-slate-400 bg-slate-900/60 border-slate-800/60' :
                'text-slate-200 bg-slate-900 border-slate-800'
              }`}>
                {event.period}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
