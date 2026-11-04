import React from 'react';

export type WorkspaceTab = 'messages' | 'architecture' | 'schemas' | 'pipeline' | 'deploy';

interface TopNavProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onOpenNewChannel: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'messages', label: 'Messages' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'schemas', label: 'Schemas' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'deploy', label: 'Deploy' },
];

export const TopNav: React.FC<TopNavProps> = ({
  activeTab,
  onSelectTab,
  onOpenNewChannel,
}) => {
  return (
    <header className="flex items-center justify-between gap-4 md:gap-8 px-4 md:px-6 h-14 bg-white border-b border-slate-200 shrink-0">
      {/* Zone 1: Single text element wordmark */}
      <a
        href="#messages"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('messages');
        }}
        className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        PulseWire
      </a>

      {/* Zone 2: 5 concise single-line text navigation links */}
      <nav aria-label="Primary navigation" className="flex items-center gap-4 md:gap-6 overflow-x-auto">
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                isActive
                  ? 'border-blue-600 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onOpenNewChannel}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          New Channel
        </button>
      </div>
    </header>
  );
};
