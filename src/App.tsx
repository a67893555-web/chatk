/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { TopNav, WorkspaceTab } from './components/TopNav';
import { ChatPane } from './components/ChatPane';
import { CreateChannelModal } from './components/CreateChannelModal';
import { ArchitectureView } from './components/ArchitectureView';
import { CodeDeliverableView } from './components/CodeDeliverableView';
import { DeployView } from './components/DeployView';
import { useChatClient } from './client/useChatClient';

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('messages');
  const [isNewChannelOpen, setIsNewChannelOpen] = useState(false);
  const [isDualSplit, setIsDualSplit] = useState(false);

  // Primary Client Session: Elena Vance (Principal Architect)
  const primaryClient = useChatClient('u-elena', 'dev-elena-workstation');

  const usersList = useMemo(
    () => Object.values(primaryClient.usersById),
    [primaryClient.usersById]
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-50 text-slate-900 overflow-hidden">
      <TopNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenNewChannel={() => {
          setActiveTab('messages');
          setIsNewChannelOpen(true);
        }}
      />

      <main className="flex-1 flex min-h-0 overflow-hidden">
        {activeTab === 'messages' && (
          <div className="flex-1 flex min-h-0 divide-x divide-slate-200 overflow-hidden">
            <ChatPane
              client={primaryClient}
              paneLabel="Primary Workspace"
              compact={isDualSplit}
              isDualSplit={isDualSplit}
              onToggleDualSplit={() => setIsDualSplit((prev) => !prev)}
            />
            {isDualSplit && (
              <SecondaryPeerPane onCloseSplit={() => setIsDualSplit(false)} />
            )}
          </div>
        )}

        {activeTab === 'architecture' && (
          <ArchitectureView jwtToken={primaryClient.jwtToken} />
        )}

        {activeTab === 'schemas' && <CodeDeliverableView category="schemas" />}

        {activeTab === 'pipeline' && <CodeDeliverableView category="pipeline" />}

        {activeTab === 'deploy' && <DeployView />}
      </main>

      <CreateChannelModal
        isOpen={isNewChannelOpen}
        onClose={() => setIsNewChannelOpen(false)}
        users={usersList}
        currentUserId={primaryClient.currentUser?.id ?? 'u-elena'}
        onCreate={primaryClient.createChannel}
      />
    </div>
  );
}

/**
 * Mounts an independent second real WebSocket session (Marcus Chen) when Split Dual-Client is toggled,
 * demonstrating real multi-gateway delivery ACKs, read watermarks, typing Pub/Sub, and offline /sync.
 */
const SecondaryPeerPane: React.FC<{ onCloseSplit: () => void }> = ({ onCloseSplit }) => {
  const secondaryClient = useChatClient('u-marcus', 'dev-marcus-laptop');
  return (
    <ChatPane
      client={secondaryClient}
      paneLabel="Secondary Peer Socket"
      compact
      isDualSplit
      onToggleDualSplit={onCloseSplit}
    />
  );
};
