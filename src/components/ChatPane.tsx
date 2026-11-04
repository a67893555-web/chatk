import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  Clock,
  Edit3,
  FileUp,
  Hash,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Trash2,
  User,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  ChannelType,
  ChatMessage,
  MediaAttachmentMeta,
  MessageLifecycleState,
  PresenceState,
} from '../shared/types';
import { ChatClientState } from '../client/useChatClient';
import { apiUrl } from '../client/runtimeConfig';

interface ChatPaneProps {
  client: ChatClientState;
  paneLabel: string;
  compact?: boolean;
  isDualSplit?: boolean;
  onToggleDualSplit?: () => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--';
  }
}

function formatRelativeLastSeen(iso: string): string {
  try {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return 'Last seen just now';
    if (diffSec < 3600) return `Last seen ${Math.floor(diffSec / 60)}m ago`;
    return `Last seen ${Math.floor(diffSec / 3600)}h ago`;
  } catch {
    return 'Offline';
  }
}

export const ChatPane: React.FC<ChatPaneProps> = ({
  client,
  paneLabel,
  compact = false,
  isDualSplit = false,
  onToggleDualSplit,
}) => {
  const [channelQuery, setChannelQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [stagedAttachment, setStagedAttachment] = useState<{
    mediaUrl: string;
    thumbnailUrl: string;
    mediaMeta: MediaAttachmentMeta;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingStopTimerRef = useRef<number | null>(null);

  const activeChannel = useMemo(
    () => client.channels.find((c) => c.id === client.activeChannelId) ?? client.channels[0],
    [client.channels, client.activeChannelId]
  );

  const filteredChannels = useMemo(() => {
    const q = channelQuery.trim().toLowerCase();
    if (!q) return client.channels;
    return client.channels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );
  }, [client.channels, channelQuery]);

  const groupChannels = useMemo(
    () => filteredChannels.filter((c) => c.type === ChannelType.GROUP),
    [filteredChannels]
  );

  const directChannels = useMemo(
    () => filteredChannels.filter((c) => c.type === ChannelType.DIRECT),
    [filteredChannels]
  );

  const activeMessages: ChatMessage[] = useMemo(() => {
    if (!activeChannel) return [];
    return client.messagesByChannel[activeChannel.id] ?? [];
  }, [activeChannel, client.messagesByChannel]);

  const activeTypingNames = useMemo(() => {
    if (!activeChannel) return [];
    return client.typingUsersByChannel[activeChannel.id] ?? [];
  }, [activeChannel, client.typingUsersByChannel]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeMessages.length, activeChannel?.id]);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (!activeChannel) return;

    if (value.trim().length > 0) {
      client.notifyTyping(activeChannel.id, true);
      if (typingStopTimerRef.current) window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = window.setTimeout(() => {
        client.notifyTyping(activeChannel.id, false);
      }, 2500);
    } else {
      client.notifyTyping(activeChannel.id, false);
    }
  };

  const handleSubmitMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() && !stagedAttachment) return;
    const textToSend = draft;
    const mediaToSend = stagedAttachment ?? undefined;
    setDraft('');
    setStagedAttachment(null);
    if (activeChannel) {
      client.notifyTyping(activeChannel.id, false);
    }
    await client.sendMessage(textToSend, mediaToSend);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploadingMedia(true);
    try {
      const uploaded = await client.uploadMediaViaPresignedPut(file);
      setStagedAttachment(uploaded);
    } catch (err) {
      alertFallbackError(client, err);
    } finally {
      setUploadingMedia(false);
    }
  };

  const handleGenerateSamplePresignedPut = async () => {
    setUploadingMedia(true);
    try {
      const svgDiagram = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280" viewBox="0 0 640 280">
        <rect width="640" height="280" fill="#f8fafc"/>
        <rect x="24" y="24" width="592" height="232" rx="12" fill="#ffffff" stroke="#cbd5e1" stroke-width="2"/>
        <text x="48" y="68" fill="#0f172a" font-family="sans-serif" font-size="16" font-weight="700">Presigned Object Storage Direct HTTP PUT Artifact</text>
        <text x="48" y="98" fill="#475569" font-family="monospace" font-size="13">Client -&gt; HTTP PUT /api/v1/media/upload/:key (Zero WebSocket Binary Load)</text>
        <rect x="48" y="128" width="160" height="72" rx="8" fill="#eff6ff" stroke="#3b82f6"/>
        <text x="68" y="168" fill="#1d4ed8" font-family="monospace" font-size="12" font-weight="600">1. POST /presign</text>
        <rect x="240" y="128" width="160" height="72" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
        <text x="260" y="168" fill="#15803d" font-family="monospace" font-size="12" font-weight="600">2. HTTP PUT S3</text>
        <rect x="432" y="128" width="160" height="72" rx="8" fill="#f8fafc" stroke="#64748b"/>
        <text x="450" y="168" fill="#334155" font-family="monospace" font-size="12" font-weight="600">3. WS media_url</text>
      </svg>`;
      const file = new File([svgDiagram], `topology-shard-${Date.now().toString().slice(-4)}.svg`, {
        type: 'image/svg+xml',
      });
      const uploaded = await client.uploadMediaViaPresignedPut(file);
      setStagedAttachment(uploaded);
    } catch (err) {
      alertFallbackError(client, err);
    } finally {
      setUploadingMedia(false);
    }
  };

  const getDirectPeerPresence = (memberIds: string[]) => {
    const peerId = memberIds.find((id) => id !== client.currentUser?.id) ?? memberIds[0];
    return {
      peer: client.usersById[peerId],
      presence: client.presencesByUser[peerId],
    };
  };

  if (client.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-white p-8 text-sm text-slate-500">
        Initializing JWT session handshake and WebSocket Gateway pool...
      </div>
    );
  }

  return (
    <section
      aria-label={paneLabel}
      className="flex flex-1 min-h-0 bg-white overflow-hidden"
    >
      {/* Left Channel & Direct Message Sidebar */}
      <aside
        aria-label={`${paneLabel} channels`}
        className={`${
          compact ? 'w-48' : 'w-64'
        } hidden md:flex flex-col border-r border-slate-200 bg-slate-50/70 shrink-0`}
      >
        {/* User Session Header */}
        <div className="p-3.5 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <div
              aria-hidden="true"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0"
              style={{ backgroundColor: client.currentUser?.avatarBg || '#1d4ed8' }}
            >
              {client.currentUser?.avatarInitials || 'PW'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-slate-900 truncate">
                {client.currentUser?.displayName}
              </div>
              <div className="text-[11px] text-slate-500 font-mono tabular-nums truncate">
                {client.connectionState === 'connected'
                  ? client.gatewayServerId ?? 'gw-eu-west2-01'
                  : client.connectionState === 'offline-simulated'
                  ? `Offline · Outbox ${client.outboxCount}`
                  : 'Reconnecting...'}
              </div>
            </div>
          </div>

          {/* Search Input */}
          <div className="mt-3 relative">
            <Search
              aria-hidden="true"
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              type="search"
              value={channelQuery}
              onChange={(e) => setChannelQuery(e.target.value)}
              aria-label={`Filter channels for ${client.currentUser?.displayName ?? 'workspace'}`}
              placeholder="Filter channels..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
            />
          </div>
        </div>

        {/* Channel Lists */}
        <div className="flex-1 overflow-y-auto p-3 space-y-5">
          <div>
            <div className="px-2 mb-1.5 text-xs font-semibold text-slate-500">
              Scalable Group Channels
            </div>
            <div className="space-y-0.5">
              {groupChannels.map((ch) => {
                const isSelected = activeChannel?.id === ch.id;
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => client.setActiveChannelId(ch.id)}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-left text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50 text-blue-700 font-semibold'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Hash aria-hidden="true" className="w-3.5 h-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{ch.name}</span>
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono tabular-nums shrink-0">
                      {ch.memberCount >= 1000
                        ? `${(ch.memberCount / 1000).toFixed(1)}k`
                        : ch.memberCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="px-2 mb-1.5 text-xs font-semibold text-slate-500">
              Direct Messages
            </div>
            <div className="space-y-0.5">
              {directChannels.map((ch) => {
                const isSelected = activeChannel?.id === ch.id;
                const { peer, presence } = getDirectPeerPresence(ch.memberIds);
                const isOnline = presence?.status === PresenceState.ONLINE;
                const displayLabel = peer?.displayName ?? ch.name;

                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => client.setActiveChannelId(ch.id)}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-left text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-blue-50 text-blue-700 font-semibold'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <User aria-hidden="true" className="w-3.5 h-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{displayLabel}</span>
                    </span>
                    <span
                      className={`text-[11px] shrink-0 ${
                        isOnline ? 'text-emerald-700 font-medium' : 'text-slate-400'
                      }`}
                    >
                      {isOnline ? 'Online' : 'Offline'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {filteredChannels.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-slate-500">
              No channels match "{channelQuery}".
            </div>
          )}
        </div>
      </aside>

      {/* Main Conversation Column */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Workspace Channel Toolbar */}
        <div className="px-5 py-3 border-b border-slate-200 flex flex-wrap xl:flex-nowrap items-center justify-between gap-3 bg-white shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm font-bold text-slate-900 truncate">
                {activeChannel?.type === ChannelType.GROUP
                  ? `#${activeChannel.name}`
                  : activeChannel
                  ? getDirectPeerPresence(activeChannel.memberIds).peer?.displayName ??
                    activeChannel.name
                  : 'Select Channel'}
              </h2>
              {activeChannel && (
                <span className="text-xs text-slate-500 font-mono tabular-nums truncate">
                  ·{' '}
                  {activeChannel.type === ChannelType.GROUP
                    ? `${activeChannel.memberCount.toLocaleString()} members${
                        compact
                          ? ''
                          : ` · ${
                              activeChannel.fanoutTier === 'large-group-worker-pool'
                                ? 'Worker-pool fan-out'
                                : 'Direct pub/sub'
                            }`
                      }`
                    : (() => {
                        const { presence } = getDirectPeerPresence(activeChannel.memberIds);
                        return presence?.status === PresenceState.ONLINE
                          ? 'Online (60s TTL)'
                          : presence?.lastSeenAt
                          ? formatRelativeLastSeen(presence.lastSeenAt)
                          : 'Offline';
                      })()}
                </span>
              )}
            </div>
            {!compact && (
              <p className="text-xs text-slate-500 truncate mt-0.5">
                {activeChannel?.description} · Sync cursor{' '}
                <span className="font-mono tabular-nums text-slate-700">
                  {client.curMaxMessageId === '0'
                    ? '0'
                    : `...${client.curMaxMessageId.slice(-10)}`}
                </span>
                {client.lastSyncSummary ? ` · ${client.lastSyncSummary}` : ''}
              </p>
            )}
          </div>

          {/* Connection & Multi-Device Sync Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={client.toggleSimulatedOffline}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                client.connectionState === 'offline-simulated'
                  ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {client.connectionState === 'offline-simulated' ? (
                <>
                  <WifiOff aria-hidden="true" className="w-3.5 h-3.5" />
                  Reconnect & Sync
                </>
              ) : (
                <>
                  <Wifi aria-hidden="true" className="w-3.5 h-3.5 text-emerald-600" />
                  Simulate Offline
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => void client.triggerManualSync()}
              aria-label={`Run manual cursor sync for ${client.currentUser?.displayName ?? 'user'}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw aria-hidden="true" className="w-3.5 h-3.5" />
              Sync Cursor
            </button>

            {onToggleDualSplit && (
              <button
                type="button"
                onClick={onToggleDualSplit}
                className={`hidden md:inline-flex px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isDualSplit
                    ? 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {isDualSplit ? 'Close Split Client' : 'Split Dual-Client'}
              </button>
            )}
          </div>
        </div>

        {/* Transient Offline or Rate-Limit Banner */}
        {client.connectionState === 'offline-simulated' && (
          <div
            role="status"
            className="px-5 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 flex items-center justify-between gap-4"
          >
            <span>
              Socket disconnected. Outgoing messages are persisted to IndexedDB outbox (
              <strong className="font-mono tabular-nums">{client.outboxCount}</strong> queued) and
              will replay idempotently after <code className="font-mono">/sync?cursor=</code> on
              reconnect.
            </span>
          </div>
        )}

        {client.errorBanner && (
          <div
            role="alert"
            className="px-5 py-2 bg-red-50 border-b border-red-200 text-xs text-red-800 flex items-center justify-between gap-4"
          >
            <span>{client.errorBanner}</span>
            <button
              type="button"
              onClick={client.clearErrorBanner}
              aria-label="Dismiss error alert"
              className="p-1 text-red-700 hover:text-red-900 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Mobile Channel Switcher */}
        <div className="md:hidden px-4 py-2 border-b border-slate-200 bg-slate-50">
          <label htmlFor={`mobile-ch-${paneLabel}`} className="sr-only">
            Select active channel
          </label>
          <select
            id={`mobile-ch-${paneLabel}`}
            value={activeChannel?.id ?? ''}
            onChange={(e) => client.setActiveChannelId(e.target.value)}
            className="w-full text-xs bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-slate-900"
          >
            {client.channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.type === ChannelType.GROUP ? `#${ch.name}` : ch.name}
              </option>
            ))}
          </select>
        </div>

        {/* Message Timeline */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {activeMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-12">
              <p className="text-sm font-semibold text-slate-800">
                No messages in this partition yet
              </p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">
                Messages sent here are assigned a 64-bit Snowflake ID, deduplicated via{' '}
                <code className="font-mono">client_msg_id</code>, and clustered descending in
                ScyllaDB.
              </p>
            </div>
          ) : (
            activeMessages.map((msg) => {
              const sender = client.usersById[msg.senderId];
              const isOwn = msg.senderId === client.currentUser?.id;
              const isEditing = editingMsgId === msg.messageId;

              return (
                <article
                  key={msg.clientMsgId || msg.messageId}
                  className="group flex items-start gap-3 py-1.5 hover:bg-slate-50/80 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div
                    aria-hidden="true"
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold text-white shrink-0 mt-0.5"
                    style={{ backgroundColor: sender?.avatarBg || '#475569' }}
                  >
                    {sender?.avatarInitials || 'U'}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Unboxed Metadata Row with typographic separators */}
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                      <span className="font-semibold text-slate-900">
                        {sender?.displayName ?? msg.senderId}
                      </span>
                      <span className="text-slate-400" aria-hidden="true">
                        ·
                      </span>
                      <time
                        dateTime={msg.createdAt}
                        className="text-slate-500 font-mono tabular-nums"
                      >
                        {formatTime(msg.createdAt)}
                      </time>
                      {msg.channelSeq > 0 && (
                        <>
                          <span className="text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-400 font-mono tabular-nums">
                            seq #{msg.channelSeq}
                          </span>
                        </>
                      )}
                      {msg.isEdited && !msg.isDeleted && (
                        <>
                          <span className="text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-slate-500 italic">edited</span>
                        </>
                      )}
                      {isOwn && !msg.isDeleted && (
                        <>
                          <span className="text-slate-400" aria-hidden="true">
                            ·
                          </span>
                          <LifecycleReceipt state={msg.lifecycleState} />
                        </>
                      )}
                    </div>

                    {/* Message Body or Inline Editor */}
                    {msg.isDeleted ? (
                      <p className="mt-1 text-xs italic text-slate-400">
                        Message deleted (soft-delete tombstone propagated across devices)
                      </p>
                    ) : isEditing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editingText.trim()) {
                            client.editMessage(msg.channelId, msg.messageId, editingText);
                          }
                          setEditingMsgId(null);
                        }}
                        className="mt-1.5 flex items-center gap-2"
                      >
                        <input
                          type="text"
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          aria-label="Edit message content"
                          className="flex-1 px-3 py-1.5 text-sm bg-white border border-blue-500 rounded-md text-slate-900 focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingMsgId(null)}
                          className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        {msg.content && (
                          <p className="mt-1 text-sm text-slate-800 leading-relaxed break-words">
                            {msg.content}
                          </p>
                        )}
                        {msg.mediaUrl && (
                          <div className="mt-2 max-w-sm border border-slate-200 rounded-lg overflow-hidden bg-slate-50">
                            {msg.mediaMeta?.mimeType.startsWith('image/') ? (
                              <img
                                src={apiUrl(msg.mediaUrl)}
                                alt={msg.mediaMeta.fileName || 'Uploaded media attachment'}
                                referrerPolicy="no-referrer"
                                onLoad={() =>
                                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                                }
                                className="w-full max-h-44 object-contain bg-white"
                              />
                            ) : msg.thumbnailUrl ? (
                              <img
                                src={apiUrl(msg.thumbnailUrl)}
                                alt={`Thumbnail for ${msg.mediaMeta?.fileName ?? 'attachment'}`}
                                referrerPolicy="no-referrer"
                                onLoad={() =>
                                  messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
                                }
                                className="w-full h-32 object-cover"
                              />
                            ) : null}
                            <div className="px-3 py-2 border-t border-slate-200 flex items-center justify-between gap-2 text-xs text-slate-600">
                              <span className="truncate font-medium">
                                {msg.mediaMeta?.fileName ?? 'Presigned S3 Object'}
                              </span>
                              <a
                                href={apiUrl(msg.mediaUrl)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-600 hover:underline font-mono tabular-nums shrink-0"
                              >
                                {msg.mediaMeta
                                  ? `${Math.max(1, Math.round(msg.mediaMeta.sizeBytes / 1024))} KB`
                                  : 'Open'}
                              </a>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Author Edit / Delete Actions */}
                  {isOwn &&
                    !msg.isDeleted &&
                    msg.lifecycleState !== MessageLifecycleState.PENDING &&
                    !isEditing && (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMsgId(msg.messageId);
                            setEditingText(msg.content);
                          }}
                          aria-label={`Edit message seq ${msg.channelSeq}`}
                          className="p-1.5 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-200/60 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => client.deleteMessage(msg.channelId, msg.messageId)}
                          aria-label={`Delete message seq ${msg.channelSeq}`}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded hover:bg-red-50 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                </article>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Ephemeral Redis Pub/Sub Typing Bar */}
        <div className="px-5 h-5 flex items-center text-xs text-slate-500 shrink-0">
          {activeTypingNames.length > 0 && (
            <span>
              {activeTypingNames.join(', ')}{' '}
              {activeTypingNames.length === 1 ? 'is' : 'are'} typing... (ephemeral Redis Pub/Sub)
            </span>
          )}
        </div>

        {/* Staged Presigned Media Preview */}
        {stagedAttachment && (
          <div className="mx-5 mb-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between gap-3 text-xs">
            <div className="min-w-0">
              <span className="font-semibold text-slate-800">
                Uploaded via Presigned HTTP PUT:
              </span>{' '}
              <span className="text-slate-600 font-mono">
                {stagedAttachment.mediaMeta.fileName} (
                {Math.max(1, Math.round(stagedAttachment.mediaMeta.sizeBytes / 1024))} KB)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setStagedAttachment(null)}
              aria-label="Remove staged attachment"
              className="p-1 text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Message Composer */}
        <form
          onSubmit={(e) => void handleSubmitMessage(e)}
          className="px-5 pb-4 pt-1 flex items-center gap-2 shrink-0"
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={(e) => void handleFileChange(e)}
            className="hidden"
            aria-label={`Upload attachment as ${client.currentUser?.displayName ?? 'user'}`}
          />
          <button
            type="button"
            disabled={uploadingMedia}
            onClick={() => fileInputRef.current?.click()}
            aria-label={`Attach file via presigned HTTP PUT (${paneLabel})`}
            title="Upload file via Presigned HTTP PUT"
            className="p-2.5 text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <button
            type="button"
            disabled={uploadingMedia}
            onClick={() => void handleGenerateSamplePresignedPut()}
            title="Test Presigned HTTP PUT Media Upload with generated SVG diagram"
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FileUp className="w-3.5 h-3.5" />
            {uploadingMedia ? 'Uploading...' : compact ? 'PUT' : 'Sample PUT'}
          </button>

          <label htmlFor={`composer-${paneLabel}`} className="sr-only">
            Message {activeChannel?.name ?? 'channel'} as {client.currentUser?.displayName}
          </label>
          <input
            id={`composer-${paneLabel}`}
            type="text"
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            placeholder={`Message ${
              activeChannel?.type === ChannelType.GROUP
                ? `#${activeChannel.name}`
                : activeChannel?.name ?? ''
            } as ${client.currentUser?.displayName ?? 'user'}...`}
            className="flex-1 min-w-0 px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-blue-600"
          />

          <button
            type="submit"
            disabled={!draft.trim() && !stagedAttachment}
            aria-label={`Send message as ${client.currentUser?.displayName ?? 'user'}`}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
        </form>
      </div>
    </section>
  );
};

const LifecycleReceipt: React.FC<{ state: MessageLifecycleState }> = ({ state }) => {
  if (state === MessageLifecycleState.PENDING) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
        <Clock aria-hidden="true" className="w-3 h-3" />
        Pending
      </span>
    );
  }
  if (state === MessageLifecycleState.SENT) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-500">
        <Check aria-hidden="true" className="w-3 h-3" />
        Sent
      </span>
    );
  }
  if (state === MessageLifecycleState.DELIVERED) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-600">
        <CheckCheck aria-hidden="true" className="w-3 h-3" />
        Delivered
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-blue-600 font-medium">
      <CheckCheck aria-hidden="true" className="w-3 h-3" />
      Read
    </span>
  );
};

function alertFallbackError(_client: ChatClientState, err: unknown) {
  console.error('Media upload failed:', err);
}
