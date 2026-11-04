import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Channel,
  ChannelType,
  ChatMessage,
  MediaAttachmentMeta,
  MessageLifecycleState,
  PresenceSnapshot,
  PresignedUploadResponse,
  SyncResponsePayload,
  UserProfile,
  WsClientFrame,
  WsServerFrame,
} from '../shared/types';
import {
  advanceSyncCursor,
  computeBackoffWithFullJitter,
  mergeAndDeduplicateMessages,
} from '../shared/distributedCore';
import { BrowserSyncStore } from './indexedDbStore';
import { apiUrl, buildWsUrl } from './runtimeConfig';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline-simulated';

export interface ChatClientState {
  currentUser: UserProfile | null;
  usersById: Record<string, UserProfile>;
  channels: Channel[];
  activeChannelId: string;
  setActiveChannelId: (id: string) => void;
  messagesByChannel: Record<string, ChatMessage[]>;
  presencesByUser: Record<string, PresenceSnapshot>;
  typingUsersByChannel: Record<string, string[]>;
  connectionState: ConnectionState;
  gatewayServerId: string | null;
  curMaxMessageId: string;
  outboxCount: number;
  lastSyncSummary: string | null;
  errorBanner: string | null;
  clearErrorBanner: () => void;
  isLoading: boolean;
  sendMessage: (
    content: string,
    attachment?: {
      mediaUrl: string;
      thumbnailUrl: string;
      mediaMeta: MediaAttachmentMeta;
    }
  ) => Promise<void>;
  editMessage: (channelId: string, messageId: string, content: string) => void;
  deleteMessage: (channelId: string, messageId: string) => void;
  notifyTyping: (channelId: string, isTyping: boolean) => void;
  uploadMediaViaPresignedPut: (file: File) => Promise<{
    mediaUrl: string;
    thumbnailUrl: string;
    mediaMeta: MediaAttachmentMeta;
  }>;
  createChannel: (params: {
    name: string;
    description: string;
    type: ChannelType;
    memberIds: string[];
    simulatedLargeGroupCount?: number;
  }) => Promise<Channel>;
  toggleSimulatedOffline: () => void;
  triggerManualSync: () => Promise<void>;
  jwtToken: string | null;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useChatClient(personaId: string, deviceId: string): ChatClientState {
  const [jwtToken, setJwtToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [usersById, setUsersById] = useState<Record<string, UserProfile>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>('ch-core-arch');
  const [messagesByChannel, setMessagesByChannel] = useState<Record<string, ChatMessage[]>>({});
  const [presencesByUser, setPresencesByUser] = useState<Record<string, PresenceSnapshot>>({});
  const [typingMap, setTypingMap] = useState<Record<string, Record<string, number>>>({});
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [gatewayServerId, setGatewayServerId] = useState<string | null>(null);
  const [curMaxMessageId, setCurMaxMessageId] = useState<string>('0');
  const [outboxCount, setOutboxCount] = useState<number>(0);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [simulatedOffline, setSimulatedOffline] = useState<boolean>(false);

  const store = useMemo(() => new BrowserSyncStore(personaId, deviceId), [personaId, deviceId]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const cursorRef = useRef<string>('0');
  const activeChannelRef = useRef<string>(activeChannelId);
  const simulatedOfflineRef = useRef<boolean>(simulatedOffline);
  const tokenRef = useRef<string | null>(null);

  activeChannelRef.current = activeChannelId;
  simulatedOfflineRef.current = simulatedOffline;
  tokenRef.current = jwtToken;

  const updateCursor = useCallback(
    async (candidate: string) => {
      if (!candidate || candidate === '0') return;
      const next = advanceSyncCursor(cursorRef.current, [
        {
          channelId: '',
          messageId: candidate,
          channelSeq: 0,
          senderId: '',
          clientMsgId: '',
          content: '',
          mediaUrl: null,
          thumbnailUrl: null,
          mediaMeta: null,
          createdAt: '',
          updatedAt: null,
          isEdited: false,
          isDeleted: false,
          lifecycleState: MessageLifecycleState.SENT,
          deliveredTo: [],
          readBy: [],
        },
      ]);
      cursorRef.current = next;
      setCurMaxMessageId(next);
      await store.setCursor(next);
    },
    [store]
  );

  const sendFrame = useCallback((frame: WsClientFrame): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && !simulatedOfflineRef.current) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }, []);

  const performSyncCatchUp = useCallback(
    async (authToken: string) => {
      const fromCursor = cursorRef.current || (await store.getCursor()) || '0';
      const res = await fetch(
        apiUrl(
          `/api/v1/sync?cursor=${encodeURIComponent(fromCursor)}&deviceId=${encodeURIComponent(
            deviceId
          )}`
        ),
        {
          headers: { Authorization: `Bearer ${authToken}` },
        }
      );
      if (!res.ok) return;

      const delta = (await res.json()) as SyncResponsePayload;
      if (delta.messages.length > 0) {
        setMessagesByChannel((prev) => {
          const next = { ...prev };
          const byCh = new Map<string, ChatMessage[]>();
          for (const m of delta.messages) {
            const arr = byCh.get(m.channelId) ?? [];
            arr.push(m);
            byCh.set(m.channelId, arr);
          }
          for (const [chId, incoming] of byCh.entries()) {
            next[chId] = mergeAndDeduplicateMessages(next[chId] ?? [], incoming);
          }
          return next;
        });
        await store.persistMessages(delta.messages);
      }

      if (delta.newMaxMessageId && delta.newMaxMessageId !== '0') {
        await updateCursor(delta.newMaxMessageId);
      }

      setLastSyncSummary(
        `Synced ${delta.messages.length} delta event${delta.messages.length === 1 ? '' : 's'} from cursor ${fromCursor.slice(-8)}`
      );
    },
    [deviceId, store, updateCursor]
  );

  const flushOutbox = useCallback(async () => {
    const queued = await store.listOutbox();
    setOutboxCount(queued.length);
    for (const item of queued) {
      const sent = sendFrame({
        type: 'message:send',
        channelId: item.channelId,
        clientMsgId: item.clientMsgId,
        content: item.content,
        mediaUrl: item.mediaUrl,
        thumbnailUrl: item.thumbnailUrl,
        mediaMeta: item.mediaMeta,
      });
      if (!sent) break;
    }
  }, [sendFrame, store]);

  // 1. Initial Auth Handshake & Bootstrap
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    async function initSession() {
      try {
        const authRes = await fetch(apiUrl('/api/v1/auth/session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: personaId, deviceId }),
        });
        if (!authRes.ok) {
          throw new Error('Authentication handshake failed');
        }
        const authData = (await authRes.json()) as {
          token: string;
          user: UserProfile;
        };
        if (cancelled) return;

        const bootRes = await fetch(apiUrl('/api/v1/bootstrap'), {
          headers: { Authorization: `Bearer ${authData.token}` },
        });
        if (!bootRes.ok) {
          throw new Error('Workspace bootstrap failed');
        }
        const boot = (await bootRes.json()) as {
          currentUser: UserProfile;
          users: UserProfile[];
          channels: Channel[];
          presences: PresenceSnapshot[];
          messagesByChannel: Record<string, ChatMessage[]>;
          curMaxMessageId: string;
        };
        if (cancelled) return;

        const uMap: Record<string, UserProfile> = {};
        for (const u of boot.users) uMap[u.id] = u;

        const pMap: Record<string, PresenceSnapshot> = {};
        for (const p of boot.presences) pMap[p.userId] = p;

        setJwtToken(authData.token);
        setCurrentUser(boot.currentUser);
        setUsersById(uMap);
        setChannels(boot.channels);
        setPresencesByUser(pMap);
        setMessagesByChannel(boot.messagesByChannel);

        if (
          boot.channels.length > 0 &&
          !boot.channels.some((c) => c.id === activeChannelRef.current)
        ) {
          setActiveChannelId(boot.channels[0].id);
        }

        await updateCursor(boot.curMaxMessageId);
        const queued = await store.listOutbox();
        setOutboxCount(queued.length);
      } catch (err) {
        if (!cancelled) {
          setErrorBanner(err instanceof Error ? err.message : 'Unable to initialize session');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void initSession();
    return () => {
      cancelled = true;
    };
  }, [personaId, deviceId, store, updateCursor]);

  // 2. WebSocket Connection Lifecycle + Exponential Backoff & Full Jitter
  useEffect(() => {
    if (!jwtToken) return;

    if (simulatedOffline) {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, 'Simulated client offline');
        wsRef.current = null;
      }
      setConnectionState('offline-simulated');
      setGatewayServerId(null);
      return;
    }

    let unmounted = false;

    const openSocket = () => {
      if (unmounted || simulatedOfflineRef.current) return;

      setConnectionState(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      const wsUrl = buildWsUrl(jwtToken);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = async () => {
        if (unmounted) return;
        reconnectAttemptRef.current = 0;
        setConnectionState('connected');

        if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
          }
        }, 25_000);

        await performSyncCatchUp(jwtToken);
        await flushOutbox();
      };

      ws.onmessage = (event) => {
        if (unmounted) return;
        let frame: WsServerFrame;
        try {
          frame = JSON.parse(event.data as string) as WsServerFrame;
        } catch {
          return;
        }

        if (frame.type === 'hello') {
          setGatewayServerId(frame.gatewayServerId);
          return;
        }

        if (frame.type === 'message:server_ack') {
          setMessagesByChannel((prev) => ({
            ...prev,
            [frame.channelId]: mergeAndDeduplicateMessages(prev[frame.channelId] ?? [], [
              frame.message,
            ]),
          }));
          void store.persistMessages([frame.message]);
          void store.removeOutbox(frame.clientMsgId).then(async () => {
            const rem = await store.listOutbox();
            setOutboxCount(rem.length);
          });
          void updateCursor(frame.messageId);
          return;
        }

        if (frame.type === 'message:new') {
          const msg = frame.message;
          setMessagesByChannel((prev) => ({
            ...prev,
            [msg.channelId]: mergeAndDeduplicateMessages(prev[msg.channelId] ?? [], [msg]),
          }));
          void store.persistMessages([msg]);
          void updateCursor(msg.messageId);

          // If another user sent this message, send immediate Delivery Ack & Read Mark if channel is open
          if (msg.senderId !== personaId) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'message:ack_delivered',
                  channelId: msg.channelId,
                  messageId: msg.messageId,
                })
              );
              if (activeChannelRef.current === msg.channelId) {
                ws.send(
                  JSON.stringify({
                    type: 'message:mark_read',
                    channelId: msg.channelId,
                    upToMessageId: msg.messageId,
                  })
                );
              }
            }
          }
          return;
        }

        if (frame.type === 'message:updated') {
          const msg = frame.message;
          setMessagesByChannel((prev) => ({
            ...prev,
            [msg.channelId]: mergeAndDeduplicateMessages(prev[msg.channelId] ?? [], [msg]),
          }));
          void store.persistMessages([msg]);
          return;
        }

        if (frame.type === 'message:receipt') {
          setMessagesByChannel((prev) => {
            const list = prev[frame.channelId];
            if (!list) return prev;
            return {
              ...prev,
              [frame.channelId]: list.map((m) =>
                m.messageId === frame.messageId
                  ? {
                      ...m,
                      lifecycleState: frame.lifecycleState,
                      deliveredTo: frame.deliveredTo,
                      readBy: frame.readBy,
                    }
                  : m
              ),
            };
          });
          return;
        }

        if (frame.type === 'typing:update') {
          setTypingMap((prev) => {
            const chTyping = { ...(prev[frame.channelId] ?? {}) };
            if (frame.isTyping) {
              chTyping[frame.userId] = frame.expiresAt;
            } else {
              delete chTyping[frame.userId];
            }
            return { ...prev, [frame.channelId]: chTyping };
          });
          return;
        }

        if (frame.type === 'presence:update') {
          setPresencesByUser((prev) => ({
            ...prev,
            [frame.presence.userId]: frame.presence,
          }));
          return;
        }

        if (frame.type === 'error') {
          setErrorBanner(frame.message);
        }
      };

      ws.onclose = () => {
        if (unmounted || simulatedOfflineRef.current) return;
        setGatewayServerId(null);
        setConnectionState('reconnecting');
        const delay = computeBackoffWithFullJitter(reconnectAttemptRef.current++, 500, 15_000);
        reconnectTimerRef.current = window.setTimeout(openSocket, delay);
      };
    };

    openSocket();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (pingIntervalRef.current) window.clearInterval(pingIntervalRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close(1000, 'Component unmounting');
        wsRef.current = null;
      }
    };
  }, [jwtToken, simulatedOffline, personaId, performSyncCatchUp, flushOutbox, store, updateCursor]);

  // 3. Mark active channel messages as Read when viewing channel
  useEffect(() => {
    const channelMsgs = messagesByChannel[activeChannelId] ?? [];
    if (channelMsgs.length === 0) return;

    const latestPeerMsg = [...channelMsgs]
      .reverse()
      .find(
        (m) =>
          m.senderId !== personaId &&
          m.lifecycleState !== MessageLifecycleState.PENDING &&
          !m.readBy.includes(personaId)
      );

    if (latestPeerMsg) {
      sendFrame({
        type: 'message:mark_read',
        channelId: activeChannelId,
        upToMessageId: latestPeerMsg.messageId,
      });
    }
  }, [activeChannelId, messagesByChannel, personaId, sendFrame]);

  // 4. Prune expired ephemeral typing indicators every second
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTypingMap((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [chId, users] of Object.entries(prev)) {
          const active: Record<string, number> = {};
          for (const [uid, exp] of Object.entries(users)) {
            if (exp > now) {
              active[uid] = exp;
            } else {
              changed = true;
            }
          }
          next[chId] = active;
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const typingUsersByChannel = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [chId, uObj] of Object.entries(typingMap)) {
      result[chId] = Object.keys(uObj)
        .filter((uid) => uid !== personaId)
        .map((uid) => usersById[uid]?.displayName ?? uid);
    }
    return result;
  }, [typingMap, personaId, usersById]);

  const sendMessage = useCallback(
    async (
      content: string,
      attachment?: {
        mediaUrl: string;
        thumbnailUrl: string;
        mediaMeta: MediaAttachmentMeta;
      }
    ) => {
      const trimmed = content.trim();
      if (!trimmed && !attachment) return;

      const clientMsgId = makeUuid();
      const nowIso = new Date().toISOString();
      const channelId = activeChannelRef.current;

      const optimisticMsg: ChatMessage = {
        channelId,
        messageId: `pending-${clientMsgId}`,
        channelSeq: 0,
        senderId: personaId,
        clientMsgId,
        content: trimmed,
        mediaUrl: attachment?.mediaUrl ?? null,
        thumbnailUrl: attachment?.thumbnailUrl ?? null,
        mediaMeta: attachment?.mediaMeta ?? null,
        createdAt: nowIso,
        updatedAt: null,
        isEdited: false,
        isDeleted: false,
        lifecycleState: MessageLifecycleState.PENDING,
        deliveredTo: [],
        readBy: [personaId],
      };

      // 1. Optimistic local state + IndexedDB outbox write (Zero-Message-Loss guarantee)
      setMessagesByChannel((prev) => ({
        ...prev,
        [channelId]: mergeAndDeduplicateMessages(prev[channelId] ?? [], [optimisticMsg]),
      }));
      await store.persistMessages([optimisticMsg]);
      await store.enqueueOutbox({
        clientMsgId,
        channelId,
        content: trimmed,
        mediaUrl: attachment?.mediaUrl ?? null,
        thumbnailUrl: attachment?.thumbnailUrl ?? null,
        mediaMeta: attachment?.mediaMeta ?? null,
        createdAt: nowIso,
      });

      const outboxNow = await store.listOutbox();
      setOutboxCount(outboxNow.length);

      // 2. Dispatch over WebSocket if connected; otherwise held safely in IndexedDB outbox until reconnect
      sendFrame({
        type: 'message:send',
        channelId,
        clientMsgId,
        content: trimmed,
        mediaUrl: attachment?.mediaUrl ?? null,
        thumbnailUrl: attachment?.thumbnailUrl ?? null,
        mediaMeta: attachment?.mediaMeta ?? null,
      });
    },
    [personaId, sendFrame, store]
  );

  const editMessage = useCallback(
    (channelId: string, messageId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      const ok = sendFrame({
        type: 'message:edit',
        channelId,
        messageId,
        content: trimmed,
      });
      if (!ok) {
        setErrorBanner('Reconnect before editing server-persisted messages.');
      }
    },
    [sendFrame]
  );

  const deleteMessage = useCallback(
    (channelId: string, messageId: string) => {
      const ok = sendFrame({
        type: 'message:delete',
        channelId,
        messageId,
      });
      if (!ok) {
        setErrorBanner('Reconnect before deleting server-persisted messages.');
      }
    },
    [sendFrame]
  );

  const notifyTyping = useCallback(
    (channelId: string, isTyping: boolean) => {
      sendFrame({
        type: isTyping ? 'typing:start' : 'typing:stop',
        channelId,
      });
    },
    [sendFrame]
  );

  const uploadMediaViaPresignedPut = useCallback(
    async (file: File) => {
      const token = tokenRef.current;
      if (!token) throw new Error('Session not authenticated');

      // Step 1: Request Presigned HTTP PUT URL from Media Processing Engine
      const presignRes = await fetch(apiUrl('/api/v1/media/presign'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        }),
      });

      if (!presignRes.ok) {
        const errBody = await presignRes.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to obtain presigned upload URL');
      }

      const presigned = (await presignRes.json()) as PresignedUploadResponse;

      // Step 2: Direct HTTP PUT binary upload to Object Storage (NEVER sent through WebSockets)
      const putRes = await fetch(apiUrl(presigned.uploadUrl), {
        method: 'PUT',
        headers: {
          ...presigned.requiredHeaders,
          Authorization: `Bearer ${token}`,
        },
        body: file,
      });

      if (!putRes.ok) {
        const errBody = await putRes.json().catch(() => ({}));
        throw new Error(errBody.error || 'Direct HTTP PUT media upload failed');
      }

      const mediaMeta: MediaAttachmentMeta = {
        objectKey: presigned.objectKey,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        thumbnailStatus: 'ready',
      };

      return {
        mediaUrl: apiUrl(presigned.publicMediaUrl),
        thumbnailUrl: apiUrl(presigned.thumbnailUrl),
        mediaMeta,
      };
    },
    []
  );

  const createChannel = useCallback(
    async (params: {
      name: string;
      description: string;
      type: ChannelType;
      memberIds: string[];
      simulatedLargeGroupCount?: number;
    }) => {
      const token = tokenRef.current;
      if (!token) throw new Error('Session not authenticated');

      const res = await fetch(apiUrl('/api/v1/channels'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(params),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to create channel');
      }

      const created = body.channel as Channel;
      setChannels((prev) => [...prev, created]);
      setMessagesByChannel((prev) => ({ ...prev, [created.id]: [] }));
      setActiveChannelId(created.id);
      return created;
    },
    []
  );

  const toggleSimulatedOffline = useCallback(() => {
    setSimulatedOffline((prev) => !prev);
  }, []);

  const triggerManualSync = useCallback(async () => {
    if (!tokenRef.current) return;
    await performSyncCatchUp(tokenRef.current);
  }, [performSyncCatchUp]);

  const clearErrorBanner = useCallback(() => setErrorBanner(null), []);

  return {
    currentUser,
    usersById,
    channels,
    activeChannelId,
    setActiveChannelId,
    messagesByChannel,
    presencesByUser,
    typingUsersByChannel,
    connectionState,
    gatewayServerId,
    curMaxMessageId,
    outboxCount,
    lastSyncSummary,
    errorBanner,
    clearErrorBanner,
    isLoading,
    sendMessage,
    editMessage,
    deleteMessage,
    notifyTyping,
    uploadMediaViaPresignedPut,
    createChannel,
    toggleSimulatedOffline,
    triggerManualSync,
    jwtToken,
  };
}
