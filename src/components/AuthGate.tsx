'use client';

import React, { useState, useEffect } from 'react';

interface AuthGateProps {
  children: React.ReactNode;
  correctPassword?: string;
}

export const AuthGate: React.FC<AuthGateProps> = ({ 
  children, 
  correctPassword = process.env.NEXT_PUBLIC_CREW_PASSWORD || 'gbf2026' 
}) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [inputPassword, setInputPassword] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    const savedAuth = localStorage.getItem('gbf_crew_auth');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
    } else {
      setIsAuthenticated(false);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPassword.trim() === correctPassword) {
      localStorage.setItem('gbf_crew_auth', 'true');
      setIsAuthenticated(true);
      setError(false);
    } else {
      setError(true);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('gbf_crew_auth');
    setIsAuthenticated(false);
    setInputPassword('');
  };

  if (isAuthenticated === null) {
    return <div className="min-h-screen bg-[#080b14] flex items-center justify-center text-slate-400">読み込み中...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#080b14] text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
        {/* Atmosphere Background */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-amber-500/10 via-transparent to-transparent pointer-events-none" />

        <div className="w-full max-w-md bg-slate-900/80 backdrop-blur-xl border border-amber-500/20 rounded-2xl p-8 shadow-2xl shadow-amber-500/10 text-center relative z-10">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-tr from-amber-500 to-yellow-300 p-0.5 flex items-center justify-center shadow-lg shadow-amber-500/20">
            <div className="w-full h-full bg-[#0a0e1a] rounded-full flex items-center justify-center text-2xl">
              ⚔️
            </div>
          </div>

          <span className="inline-block px-3 py-1 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-semibold rounded-full tracking-wider mb-2">
            GRANBLUE FANTASY CREW
          </span>
          <h1 className="text-2xl font-bold text-white mb-2">めろ～ん王国 ポータル</h1>
          <p className="text-slate-400 text-sm mb-6">団員専用ページです。合言葉（パスワード）を入力して入場してください。</p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="text-left">
              <label htmlFor="crewPassword" className="block text-xs font-semibold text-slate-300 mb-1">
                合言葉 / 団員パスワード
              </label>
              <input
                id="crewPassword"
                type="password"
                value={inputPassword}
                onChange={(e) => setInputPassword(e.target.value)}
                placeholder="合言葉を入力..."
                required
                className="w-full bg-slate-950 border border-slate-700 focus:border-amber-400 focus:ring-1 focus:ring-amber-400 rounded-xl px-4 py-3 text-white placeholder-slate-500 outline-none transition"
              />
            </div>

            {error && (
              <div className="text-rose-400 text-xs bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
                パスワードが正しくありません。団長にお問い合わせください。
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-bold py-3 px-4 rounded-xl shadow-lg shadow-amber-500/25 transition transform active:scale-95 flex items-center justify-center gap-2"
            >
              <span>団員認証して入室</span>
              <span>→</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="sticky top-0 z-50 bg-slate-950/80 backdrop-blur border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚔️</span>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-white tracking-wide text-lg">めろ～ん王国</h1>
              <span className="text-[10px] px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full font-semibold">
                団員30名専用
              </span>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="text-xs bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 transition"
          >
            ログアウト
          </button>
        </div>
      </div>
      {children}
    </>
  );
};
