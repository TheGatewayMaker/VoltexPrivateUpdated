import { useCallback, useEffect, useRef, useState } from "react";
import { useWebSocket } from "@/lib/useWebSocket";
import { normalizeUnreadCount } from "@/lib/unreadCount";
import { EncryptedMessage } from "@shared/crypto";
import * as browserStorage from "@/lib/browserStorage";

export interface ConversationListItem {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  timestamp: number;
  unread: number;
  online: boolean;
  unreadCount?: number;
  type?: "direct" | "group" | "invite";
  routePath?: string;
  subtitle?: string;
}

export interface RequestListItem {
  id: string;
  groupId: string;
  name: string;
  avatar: string | null;
  timestamp: number;
  subtitle: string;
  routePath: string;
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Date.now();
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export function useConversationDirectory() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [requests, setRequests] = useState<RequestListItem[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthResolved, setIsAuthResolved] = useState(false);
  const [currentUserId, setCurrentUserId] = useState("");
  const [currentDisplayName, setCurrentDisplayName] = useState("User");
  const [currentAvatar, setCurrentAvatar] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const unreadRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const processedIncomingMessageIdsRef = useRef<Set<string>>(new Set());
  const profileCacheRef = useRef<
    Map<
      string,
      {
        displayName: string;
        username: string;
        avatar: string | null;
        fetched: number;
      }
    >
  >(new Map());
  const getRestoredSessionToken = useCallback(
    async () =>
      browserStorage.waitForItem("session_token", {
        timeoutMs: 3000,
        retryIntervalMs: 200,
      }),
    [],
  );

  const fetchUserProfile = useCallback(async (sessionToken: string) => {
    try {
      const response = await fetch("/api/profile/me", {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentUserId(data.userId || "");
        setCurrentDisplayName(data.displayName || "User");
        setCurrentAvatar(data.avatar || null);
        setIsAuthenticated(true);
        return;
      }

      setIsAuthenticated(false);
      setCurrentUserId("");
      setCurrentDisplayName("User");
      setCurrentAvatar(null);

      if (response.status === 401) {
        await browserStorage.clear();
      }
    } catch (error) {
      console.error("Failed to fetch profile:", error);
      setIsAuthenticated(false);
      setCurrentUserId("");
      setCurrentDisplayName("User");
      setCurrentAvatar(null);
    } finally {
      setIsAuthResolved(true);
    }
  }, []);

  const fetchUserProfileWithCache = useCallback(
    async (
      username: string,
      retryCount: number = 0,
    ): Promise<{ displayName: string; username: string; avatar: string | null }> => {
      const maxRetries = 2;
      const cacheExpiry = 5 * 60 * 1000;

      const cacheKey = normalizeUsername(username);
      const cached = profileCacheRef.current.get(cacheKey);
      if (
        cached &&
        Date.now() - cached.fetched < cacheExpiry &&
        cached.displayName !== "User"
      ) {
        return {
          displayName: cached.displayName,
          username: cached.username,
          avatar: cached.avatar,
        };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const profileRes = await fetch(
          `/api/profile/by-username/${encodeURIComponent(cacheKey)}`,
          {
          signal: controller.signal,
          },
        );

        clearTimeout(timeoutId);

        if (profileRes.ok) {
          const profileData = await profileRes.json();
          const displayName = profileData.displayName || "User";
          const username = profileData.username || "";
          const avatar = profileData.avatar || null;

          profileCacheRef.current.set(cacheKey, {
            displayName,
            username,
            avatar,
            fetched: Date.now(),
          });

          return { displayName, username, avatar };
        }

        if (retryCount < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, retryCount)),
          );
          return fetchUserProfileWithCache(cacheKey, retryCount + 1);
        }
      } catch (error) {
        console.error(`Error fetching profile for ${cacheKey}:`, error);
        if (retryCount < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, retryCount)),
          );
          return fetchUserProfileWithCache(cacheKey, retryCount + 1);
        }
      }

      profileCacheRef.current.set(cacheKey, {
        displayName: "User",
        username: "",
        avatar: null,
        fetched: Date.now(),
      });
      return { displayName: "User", username: "", avatar: null };
    },
    [],
  );

  const loadConversations = useCallback(
    async (sessionToken: string) => {
      try {
        const response = await fetch("/api/messages/conversations", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });

        if (!response.ok) {
          return;
        }

        const data = await response.json();
        const conversationPromises = data.conversations.map(async (conv: any) => {
          return {
            id: conv.username,
            name: conv.displayName || "User",
            username: conv.username || "",
            avatar: conv.avatar || null,
            timestamp: normalizeTimestamp(conv.timestamp),
            unread: normalizeUnreadCount(conv.unread),
            unreadCount: normalizeUnreadCount(conv.unread),
            online: false,
            type: "direct" as const,
            routePath: `/chat/${conv.username || ""}`,
            subtitle: conv.username ? `@${conv.username}` : "",
          } satisfies ConversationListItem;
        });

        const [conversationList, groupResponse] = await Promise.all([
          Promise.all(conversationPromises),
          fetch("/api/groups/conversations", {
            headers: {
              Authorization: `Bearer ${sessionToken}`,
            },
          }),
        ]);

        let groupItems: ConversationListItem[] = [];
        let requestItems: RequestListItem[] = [];
        if (groupResponse.ok) {
          const groupData = await groupResponse.json();
          const groups = Array.isArray(groupData.groups) ? groupData.groups : [];
          const invites = Array.isArray(groupData.invites) ? groupData.invites : [];
          groupItems = [
            ...groups.map((group: any) => ({
              id: String(group.id || ""),
              name: group.name || "Group",
              username: "",
              avatar: group.avatar || null,
              timestamp: normalizeTimestamp(group.timestamp),
              unread: normalizeUnreadCount(group.unreadCount),
              unreadCount: normalizeUnreadCount(group.unreadCount),
              online: false,
              type: "group" as const,
              routePath: `/groups/${group.id}`,
              subtitle: `${group.memberCount || 0} members`,
            })),
          ];
          requestItems = invites.map((invite: any) => ({
            id: String(invite.id || ""),
            groupId: String(invite.groupId || ""),
            name: invite.groupName || "Group invite",
            avatar: invite.groupAvatar || null,
            timestamp: normalizeTimestamp(invite.createdAt),
            subtitle: invite.inviterUsername
              ? `Invite from @${invite.inviterUsername}`
              : "Pending group invitation",
            routePath: `/group-invites/${invite.id}`,
          }));
        }

        setRequests(requestItems.sort((a, b) => b.timestamp - a.timestamp));
        setConversations(
          [...conversationList, ...groupItems].sort((a, b) => b.timestamp - a.timestamp),
        );
      } catch (error) {
        console.error("Failed to load conversations:", error);
      }
    },
    [],
  );

  const refreshConversations = useCallback(async () => {
    const sessionToken = await getRestoredSessionToken();
    if (!sessionToken) {
      return;
    }

    setIsRefreshing(true);
    try {
      await loadConversations(sessionToken);
    } finally {
      setIsRefreshing(false);
    }
  }, [getRestoredSessionToken, loadConversations]);

  const scheduleUnreadRefresh = useCallback(() => {
    if (unreadRefreshTimeoutRef.current) {
      clearTimeout(unreadRefreshTimeoutRef.current);
    }

    unreadRefreshTimeoutRef.current = setTimeout(() => {
      unreadRefreshTimeoutRef.current = null;
      void (async () => {
        const sessionToken = await getRestoredSessionToken();
        if (!sessionToken) {
          return;
        }
        await loadConversations(sessionToken);
      })();
    }, 120);
  }, [getRestoredSessionToken, loadConversations]);

  const handleWebSocketMessage = useCallback(
    async (message: EncryptedMessage) => {
      if (!message?.senderId) {
        return;
      }

      const fallbackConversationKey =
        message.senderId === currentUserId ? message.recipientId : message.senderId;
      const conversationUsername =
        typeof (message as EncryptedMessage & { senderUsername?: string; recipientUsername?: string }).senderUsername ===
          "string" && (message as any).senderId !== currentUserId
          ? (message as any).senderUsername
          : typeof (message as any).recipientUsername === "string"
            ? (message as any).recipientUsername
            : "";

      const conversationKey = conversationUsername || fallbackConversationKey;
      if (!conversationKey) {
        return;
      }

      const isIncoming = message.senderId !== currentUserId;
      const messageKey = `${message.senderId}:${message.recipientId}:${normalizeTimestamp(message.timestamp)}:${message.ciphertext}`;
      const alreadyProcessed = processedIncomingMessageIdsRef.current.has(
        messageKey,
      );

      if (isIncoming && alreadyProcessed) {
        return;
      }

      if (isIncoming) {
        processedIncomingMessageIdsRef.current.add(messageKey);
        if (processedIncomingMessageIdsRef.current.size > 500) {
          const oldestKey =
            processedIncomingMessageIdsRef.current.values().next().value;
          if (oldestKey) {
            processedIncomingMessageIdsRef.current.delete(oldestKey);
          }
        }
      }

      const { displayName, username, avatar } = conversationUsername
        ? await fetchUserProfileWithCache(conversationUsername)
        : { displayName: "User", username: "", avatar: null };

      setConversations((prev) => {
        const existing = prev.find((conv) => conv.id === conversationKey);
        const existingUnread = normalizeUnreadCount(existing?.unread);
        const existingUnreadCount = normalizeUnreadCount(existing?.unreadCount);
        const nextConversation: ConversationListItem = existing
          ? {
              ...existing,
              name: displayName,
              username,
              avatar,
              timestamp: normalizeTimestamp(message.timestamp),
              unread: existingUnread,
              unreadCount: existingUnreadCount,
            }
          : {
              id: conversationKey,
              name: displayName,
              username,
              avatar,
              timestamp: normalizeTimestamp(message.timestamp),
              unread: isIncoming ? 1 : 0,
              unreadCount: isIncoming ? 1 : 0,
              online: false,
            };

        const remaining = prev.filter((conv) => conv.id !== conversationKey);
        return [nextConversation, ...remaining].sort(
          (a, b) => b.timestamp - a.timestamp,
        );
      });

      if (isIncoming) {
        scheduleUnreadRefresh();
      }
    },
    [currentUserId, fetchUserProfileWithCache, scheduleUnreadRefresh],
  );

  const handleWebSocketConnected = useCallback(() => {
    console.log("WebSocket connected");
  }, []);

  const handleWebSocketDisconnected = useCallback(() => {
    console.log("WebSocket disconnected");
  }, []);

  const handleWebSocketMessageDeleted = useCallback(() => {
    scheduleUnreadRefresh();
  }, [scheduleUnreadRefresh]);

  const handleGroupRefresh = useCallback(() => {
    scheduleUnreadRefresh();
  }, [scheduleUnreadRefresh]);

  const { isConnected } = useWebSocket({
    onMessage: handleWebSocketMessage,
    onMessageDeleted: handleWebSocketMessageDeleted,
    onGroupMessage: handleGroupRefresh,
    onGroupMessageDeleted: handleGroupRefresh,
    onGroupUpdated: handleGroupRefresh,
    onGroupRemoved: handleGroupRefresh,
    onGroupInvite: handleGroupRefresh,
    onGroupInviteRemoved: handleGroupRefresh,
    onConnected: handleWebSocketConnected,
    onDisconnected: handleWebSocketDisconnected,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sessionToken = await getRestoredSessionToken();

      if (cancelled) {
        return;
      }

      if (!sessionToken) {
        setIsAuthenticated(false);
        setCurrentUserId("");
        setCurrentDisplayName("User");
        setCurrentAvatar(null);
        setIsAuthResolved(true);
        return;
      }

      setIsAuthResolved(false);
      await Promise.all([
        fetchUserProfile(sessionToken),
        loadConversations(sessionToken),
      ]);
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchUserProfile, getRestoredSessionToken, loadConversations]);

  useEffect(() => {
    let disposed = false;
    if (!isAuthenticated) {
      return;
    }

    void (async () => {
      const sessionToken = await getRestoredSessionToken();
      if (disposed || !sessionToken) {
        return;
      }

      const pollMs = isConnected ? 15000 : 4000;
      pollIntervalRef.current = setInterval(() => {
        if (document.visibilityState === "hidden") {
          return;
        }

        void loadConversations(sessionToken);
      }, pollMs);
    })();

    return () => {
      disposed = true;
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (unreadRefreshTimeoutRef.current) {
        clearTimeout(unreadRefreshTimeoutRef.current);
        unreadRefreshTimeoutRef.current = null;
      }
    };
  }, [getRestoredSessionToken, isAuthenticated, isConnected, loadConversations]);

  return {
    conversations,
    requests,
    pendingRequestCount: requests.length,
    currentDisplayName,
    currentAvatar,
    currentUserId,
    isAuthenticated,
    isAuthResolved,
    isConnected,
    isRefreshing,
    refreshConversations,
  };
}
