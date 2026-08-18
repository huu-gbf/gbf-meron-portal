export interface Notice {
  id: string;
  title: string;
  content: string;
  category: '重要' | '古戦場' | 'ドレバラ' | '連絡' | '団ルール';
  author: string;
  date: string;
  pinned?: boolean;
}

export interface ScheduleEvent {
  id: string;
  title: string;
  period: string;
  description: string;
  type: 'prelim' | 'interval' | 'finals' | 'special' | 'event';
}

export interface ExternalLink {
  id: string;
  title: string;
  category: string;
  description: string;
  url: string;
  icon: string;
  highlight?: boolean;
}

export interface UpdateHistoryItem {
  id: string;
  date: string;
  category: 'ポータル改善' | '古戦場' | '団ルール' | 'イベント' | '開設';
  title: string;
  details?: string[];
  description?: string;
  author: string;
}
