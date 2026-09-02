import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  MoreVertical,
  Search,
  Send,
  Smile,
  X,
} from "lucide-react";
import EmojiPicker, {
  EmojiStyle,
  Theme,
  type EmojiClickData,
} from "emoji-picker-react";
import Layout from "@/components/Layout";
import ConversationSidebar from "@/components/ConversationSidebar";
import GifPicker from "@/components/GifPicker";
import GifMessageContent from "@/components/GifMessageContent";
import ImageMessageContent from "@/components/ImageMessageContent";
import { UserAvatar } from "@/components/UserAvatar";
import { ProfileQuickActions } from "@/components/ProfileQuickActions";
import { Loader } from "@/components/ui/loader";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useConversationDirectory } from "@/hooks/useConversationDirectory";
import { useWebSocket } from "@/lib/useWebSocket";
import {
  getStoredKeyPair,
  encryptMessage,
  decryptMessage,
  bytesToBase64,
  waitForStoredKeyPair,
} from "@/lib/crypto";
import { getServerTime } from "@/lib/serverTime";
import { formatMessageTimestamp } from "@/lib/dateFormatter";
import { buildGifMessageContent, KlipyGifItem, parseGifMessageContent } from "@/lib/gifMessages";
import { buildImageMessageContent, parseImageMessageContent } from "@/lib/imageMessages";
import { uploadDirectImage } from "@/lib/imageUpload";
import { getDirectMessageV2ReadinessForUsername } from "@/lib/directMessageV2";
import { EncryptedMessage, DecryptedMessage } from "@shared/crypto";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

interface ChatMessage extends DecryptedMessage {
  id: string;
  isOwn: boolean;
  status?: "sent" | "delivered" | "seen" | "failed";
  // Server's canonical message ID (UUID) for deletion operations
  serverUUID?: string;
  // Encrypted data stored for retry on reconnect
  nonce?: string;
  ciphertext?: string;
  signature?: string;
}

interface DirectBlockStatus {
  blockedByMe: boolean;
  blockedMe: boolean;
  isMutual: boolean;
  canSend: boolean;
}

const ALLOW_ALL_DIRECT_MESSAGES: DirectBlockStatus = {
  blockedByMe: false,
  blockedMe: false,
  isMutual: false,
  canSend: true,
};

function getMessagePayloadKey(message: {
  senderId: string;
  recipientId: string;
  nonce?: string | null;
  ciphertext?: string | null;
  signature?: string | null;
}): string | null {
  if (!message.nonce || !message.ciphertext || !message.signature) {
    return null;
  }

  return [
    message.senderId,
    message.recipientId,
    message.nonce,
    message.ciphertext,
    message.signature,
  ].join(":");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function Chat() {
  const { id: chatTarget } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const getRestoredSessionToken = useCallback(
    async () =>
      browserStorage.waitForItem("session_token", {
        timeoutMs: 3000,
        retryIntervalMs: 200,
      }),
    [],
  );
  const {
    conversations,
    requests,
    currentAvatar,
    isConnected: isDirectoryConnected,
    isRefreshing: isDirectoryRefreshing,
    refreshConversations,
  } = useConversationDirectory();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const messageElementRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const conversationMenuRef = useRef<HTMLDivElement>(null);
  const pendingMessagesRef = useRef<ChatMessage[]>([]); // Queue for offline messages

  // State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [recipientPublicKey, setRecipientPublicKey] = useState<string>("");
  const [recipientSignPublicKey, setRecipientSignPublicKey] =
    useState<string>("");
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [recipientName, setRecipientName] = useState<string>("");
  const [recipientUsername, setRecipientUsername] = useState<string>("");
  const [recipientAvatar, setRecipientAvatar] = useState<string | null>(null);
  const [resolvedRecipientId, setResolvedRecipientId] = useState<string>("");
  const [directBlockStatus, setDirectBlockStatus] = useState<DirectBlockStatus>(
    ALLOW_ALL_DIRECT_MESSAGES,
  );
  const sentMessagesRef = useRef<Map<string, string>>(new Map()); // Map messageId -> localMessageId
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isDeletingMessageId, setIsDeletingMessageId] = useState<string | null>(
    null,
  );
  const [currentUserShowTimestamps, setCurrentUserShowTimestamps] =
    useState(true);
  const [recipientShowTimestamps, setRecipientShowTimestamps] = useState(true);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isConversationMenuOpen, setIsConversationMenuOpen] = useState(false);
  const [conversationActionPending, setConversationActionPending] = useState<
    "self" | "mixed" | null
  >(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [hasLoadedSearchHistory, setHasLoadedSearchHistory] = useState(false);
  const [conversationTotal, setConversationTotal] = useState(0);
  const lastFetchTimestampRef = useRef<number>(0);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isSendingRef = useRef<boolean>(false); // Synchronous guard to prevent double-submit
  const deletedMessageIdsRef = useRef<Set<string>>(new Set()); // Track recently deleted messages
  const deletedServerMessageIdsRef = useRef<Set<string>>(new Set());
  const lastReadSyncRef = useRef<number>(0);
  const conversationRecoveryAttemptsRef = useRef<number>(0);
  const shouldStickToBottomRef = useRef(true);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior | null>("auto");
  const scrollLockUntilRef = useRef(0);
  const hasLoadedConversationOnceRef = useRef(false);
  const directMessageTransportModeRef = useRef<"v1" | "v2">("v1");

  useEffect(() => {
    conversationRecoveryAttemptsRef.current = 0;
    shouldStickToBottomRef.current = true;
    pendingScrollBehaviorRef.current = "auto";
    scrollLockUntilRef.current = Date.now() + 2500;
    hasLoadedConversationOnceRef.current = false;
  }, [chatTarget]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return true;
    }

    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <= 80
    );
  }, []);

  const requestScrollToBottom = useCallback((behavior: ScrollBehavior) => {
    pendingScrollBehaviorRef.current = behavior;
    scrollLockUntilRef.current = Date.now() + 1500;
  }, []);

  const forceScrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior,
    });
    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
    shouldStickToBottomRef.current = true;
  }, []);

  const rememberDeletedMessage = useCallback(
    (
      messageId?: string | null,
      serverUUID?: string | null,
      ttlMs: number = 30000,
    ) => {
      if (messageId) {
        deletedMessageIdsRef.current.add(messageId);
      }

      if (serverUUID) {
        deletedServerMessageIdsRef.current.add(serverUUID);
      }

      setTimeout(() => {
        if (messageId) {
          deletedMessageIdsRef.current.delete(messageId);
        }

        if (serverUUID) {
          deletedServerMessageIdsRef.current.delete(serverUUID);
        }
      }, ttlMs);
    },
    [],
  );

  const isMessageMarkedDeleted = useCallback(
    (messageId?: string | null, serverUUID?: string | null) => {
      if (messageId && deletedMessageIdsRef.current.has(messageId)) {
        return true;
      }

      if (serverUUID && deletedServerMessageIdsRef.current.has(serverUUID)) {
        return true;
      }

      return false;
    },
    [],
  );

  const renderMessageStatus = (
    status: ChatMessage["status"],
    isOwn: boolean,
  ) => {
    if (!isOwn || !status) {
      return null;
    }

    const iconClass = "h-3.5 w-3.5 stroke-[2.25]";

    if (status === "sent") {
      return <Check className={`${iconClass} text-muted-foreground`} />;
    }

    if (status === "delivered") {
      return <CheckCheck className={`${iconClass} text-muted-foreground`} />;
    }

    if (status === "seen") {
      return <CheckCheck className={`${iconClass} text-primary`} />;
    }

    return <span className="text-xs leading-none text-destructive">!</span>;
  };

  const LONG_MESSAGE_CHARACTER_THRESHOLD = 260;
  const LONG_MESSAGE_LINE_THRESHOLD = 8;

  const isLongMessage = useCallback((content: string) => {
    if (content.length >= LONG_MESSAGE_CHARACTER_THRESHOLD) {
      return true;
    }

    return content.split(/\r?\n/).length >= LONG_MESSAGE_LINE_THRESHOLD;
  }, []);

  const isMessageExpanded = useCallback(
    (messageId: string) => expandedMessageIds.has(messageId),
    [expandedMessageIds],
  );

  const toggleExpandedMessage = useCallback((messageId: string) => {
    setExpandedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const mergeMessageStatus = useCallback(
    (
      currentStatus?: "sent" | "delivered" | "seen" | "failed",
      nextStatus?: "sent" | "delivered" | "seen" | "failed",
    ) => {
      const rank = {
        failed: 0,
        sent: 1,
        delivered: 2,
        seen: 3,
      } as const;

      if (!nextStatus) {
        return currentStatus;
      }

      if (!currentStatus) {
        return nextStatus;
      }

      return rank[nextStatus] >= rank[currentStatus] ? nextStatus : currentStatus;
    },
    [],
  );

  const getMessageStatus = useCallback(
    (message: {
      senderId: string;
      deliveredAt?: number | null;
      readAt?: number | null;
    },
    userIdOverride?: string) => {
      const ownerUserId = userIdOverride || currentUserId;

      if (!ownerUserId || message.senderId !== ownerUserId) {
        return undefined;
      }

      if (message.readAt) {
        return "seen" as const;
      }

      if (message.deliveredAt) {
        return "delivered" as const;
      }

      return "sent" as const;
    },
    [currentUserId],
  );

  const decryptConversationMessages = useCallback(
    (
      encryptedMessages: Array<
        EncryptedMessage & {
          id?: string;
          deliveredAt?: number | null;
          readAt?: number | null;
        }
      >,
      userId: string,
      otherUserPublicKey: string,
      otherUserSignPublicKey: string,
    ) => {
      const keyPair = getStoredKeyPair();

      if (!keyPair) {
        throw new Error("No keys found on this device");
      }

      const currentSignPublicKey =
        browserStorage.getItem("current_sign_public_key") ||
        keyPair.signPublicKeyBase64 ||
        keyPair.publicKeyBase64;

      const decryptedMessages: ChatMessage[] = [];
      const messageIds = new Set<string>();

      for (const encMsg of encryptedMessages) {
        try {
          const normalizedTimestamp = normalizeTimestamp(encMsg.timestamp);
          const messageId = `${normalizedTimestamp}-${encMsg.senderId}`;

          if (isMessageMarkedDeleted(messageId, encMsg.id)) {
            continue;
          }

          if (messageIds.has(messageId)) {
            continue;
          }

          const senderSignPublicKey =
            encMsg.senderId === userId
              ? currentSignPublicKey
              : otherUserSignPublicKey;

          if (!senderSignPublicKey) {
            continue;
          }

          const decrypted = decryptMessage(
            encMsg,
            otherUserPublicKey,
            keyPair.privateKeyBase64,
            senderSignPublicKey,
          );

          if (!decrypted) {
            continue;
          }

          decryptedMessages.push({
            ...decrypted,
            id: messageId,
            timestamp: normalizedTimestamp,
            isOwn: encMsg.senderId === userId,
            status: getMessageStatus(encMsg, userId),
            nonce: encMsg.nonce,
            ciphertext: encMsg.ciphertext,
            signature: encMsg.signature,
            ...(encMsg.id && { serverUUID: encMsg.id }),
          });
          messageIds.add(messageId);
        } catch (error) {
          console.error("Decryption error:", error);
        }
      }

      return decryptedMessages;
    },
    [getMessageStatus, isMessageMarkedDeleted],
  );

  const mergeMessages = useCallback(
    (existing: ChatMessage[], incoming: ChatMessage[]) => {
      const merged = [...existing];

      for (const message of incoming) {
        const existingIndex = merged.findIndex((current) => {
          if (current.id === message.id) {
            return true;
          }

          if (message.serverUUID && current.serverUUID === message.serverUUID) {
          return true;
        }

          const currentPayloadKey = getMessagePayloadKey(current);
          const incomingPayloadKey = getMessagePayloadKey(message);
          return (
            currentPayloadKey !== null &&
            incomingPayloadKey !== null &&
            currentPayloadKey === incomingPayloadKey
          );
        });

        if (existingIndex >= 0) {
          merged[existingIndex] = {
            ...merged[existingIndex],
            ...message,
            status: mergeMessageStatus(
              merged[existingIndex].status,
              message.status,
            ),
          };
          continue;
        }

        merged.push(message);
      }

      merged.sort((a, b) => a.timestamp - b.timestamp);
      return merged;
    },
    [mergeMessageStatus],
  );

  const scrollToMessage = useCallback((messageId: string) => {
    const element = messageElementRefs.current[messageId];
    if (!element) {
      return;
    }

    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, []);

  const insertEmojiIntoComposer = useCallback((emoji: string) => {
    setMessageInput((prev) => {
      const input = messageInputRef.current;
      if (!input) {
        return `${prev}${emoji}`;
      }

      const selectionStart = input.selectionStart ?? prev.length;
      const selectionEnd = input.selectionEnd ?? prev.length;
      const nextValue =
        prev.slice(0, selectionStart) + emoji + prev.slice(selectionEnd);

      requestAnimationFrame(() => {
        const nextCursor = selectionStart + emoji.length;
        input.focus();
        input.setSelectionRange(nextCursor, nextCursor);
      });

      return nextValue;
    });
  }, []);

  const refocusMessageComposer = useCallback(() => {
    window.setTimeout(() => {
      const input = messageInputRef.current;
      if (!input) {
        return;
      }

      input.focus({ preventScroll: true });
    }, 0);
  }, []);

  const handleEmojiSelect = useCallback(
    (emojiData: EmojiClickData) => {
      insertEmojiIntoComposer(emojiData.emoji);
      setIsEmojiPickerOpen(false);
    },
    [insertEmojiIntoComposer],
  );

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const searchMatches = normalizedSearchQuery
    ? messages.filter((message) =>
        message.content.toLowerCase().includes(normalizedSearchQuery),
      )
    : [];
  const matchedMessageIds = new Set(searchMatches.map((message) => message.id));
  const boundedSearchIndex =
    searchMatches.length > 0
      ? Math.min(activeSearchIndex, searchMatches.length - 1)
      : 0;
  const activeSearchMatch = searchMatches[boundedSearchIndex] || null;

  const renderHighlightedContent = useCallback(
    (content: string, messageId: string) => {
      const normalizedQuery = searchQuery.trim();

      if (!normalizedQuery) {
        return content;
      }

      const matcher = new RegExp(`(${escapeRegExp(normalizedQuery)})`, "gi");
      const segments = content.split(matcher);

      if (segments.length === 1) {
        return content;
      }

      const isActiveMatch =
        searchMatches[activeSearchIndex] &&
        searchMatches[activeSearchIndex].id === messageId;

      return segments.map((segment, index) => {
        if (segment.toLowerCase() !== normalizedQuery.toLowerCase()) {
          return (
            <span key={`${messageId}-segment-${index}`}>{segment}</span>
          );
        }

        return (
          <mark
            key={`${messageId}-match-${index}`}
            className={`rounded px-1 py-0.5 ${
              isActiveMatch
                ? "bg-amber-300/90 text-slate-950"
                : "bg-amber-200/70 text-foreground"
            }`}
          >
            {segment}
          </mark>
        );
      });
    },
    [activeSearchIndex, searchMatches, searchQuery],
  );

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      if (Date.now() < scrollLockUntilRef.current) {
        shouldStickToBottomRef.current = true;
        return;
      }

      shouldStickToBottomRef.current = isNearBottom();
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [isNearBottom]);

  useEffect(() => {
    const behavior = pendingScrollBehaviorRef.current;
    if (!behavior || isSearchOpen || isLoading) {
      return;
    }

    pendingScrollBehaviorRef.current = null;
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const scroll = () => {
      messagesEndRef.current?.scrollIntoView({
        block: "end",
        behavior,
      });
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });
      shouldStickToBottomRef.current = true;
    };

    const frameId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(scroll);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [messages, isLoading, isSearchOpen]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoading || isSearchOpen) {
      return;
    }

    const keepPinnedToBottom = () => {
      if (
        !shouldStickToBottomRef.current &&
        Date.now() >= scrollLockUntilRef.current
      ) {
        return;
      }

      messagesEndRef.current?.scrollIntoView({
        block: "end",
        behavior: "auto",
      });
      container.scrollTop = container.scrollHeight;
      shouldStickToBottomRef.current = true;
    };

    const frameId = window.requestAnimationFrame(() => {
      keepPinnedToBottom();
    });

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(frameId);
      };
    }

    const observer = new ResizeObserver(() => {
      keepPinnedToBottom();
    });

    observer.observe(container);
    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [messages, isLoading, isSearchOpen]);

  const handleEmbeddedMediaReady = useCallback(() => {
    if (
      shouldStickToBottomRef.current ||
      Date.now() < scrollLockUntilRef.current
    ) {
      scrollLockUntilRef.current = Date.now() + 1200;
      forceScrollToBottom("auto");
    }
  }, [forceScrollToBottom]);

  useEffect(() => {
    if (!isSearchOpen) {
      return;
    }

    window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, [isSearchOpen]);

  useEffect(() => {
    if (!isConversationMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!conversationMenuRef.current || !target) {
        return;
      }

      if (!conversationMenuRef.current.contains(target)) {
        setIsConversationMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isConversationMenuOpen]);

  useEffect(() => {
    if (!normalizedSearchQuery) {
      setActiveSearchIndex(0);
      return;
    }

    if (boundedSearchIndex !== activeSearchIndex) {
      setActiveSearchIndex(boundedSearchIndex);
    }
  }, [
    activeSearchIndex,
    boundedSearchIndex,
    normalizedSearchQuery,
    searchMatches.length,
  ]);

  useEffect(() => {
    if (!activeSearchMatch) {
      return;
    }

    scrollToMessage(activeSearchMatch.id);
  }, [activeSearchMatch, scrollToMessage]);

  // Mark conversation as read
  const markConversationAsRead = async (
    sessionToken: string,
    otherUsername: string,
    force: boolean = false,
  ) => {
    if (!force) {
      const now = Date.now();
      if (now - lastReadSyncRef.current < 1500) {
        return;
      }
      lastReadSyncRef.current = now;
    } else {
      lastReadSyncRef.current = Date.now();
    }

    try {
      await fetch(
        `/api/messages/conversations/by-username/${encodeURIComponent(otherUsername)}/read`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );
      console.log(`Conversation with ${otherUsername} marked as read`);
    } catch (error) {
      console.error("Failed to mark conversation as read:", error);
      // Don't show error to user as this is non-critical
    }
  };

  const syncConversationRead = useCallback(
    (force: boolean = false) => {
      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken || !recipientUsername || !currentUserId) {
        return;
      }

      if (document.visibilityState === "hidden") {
        return;
      }

      void markConversationAsRead(sessionToken, recipientUsername, force);
    },
    [recipientUsername, currentUserId],
  );

  const loadDirectBlockStatus = useCallback(
    async (sessionToken: string, otherUsername: string) => {
      try {
        const response = await fetch(
          `/api/blocks/status/by-username/${encodeURIComponent(otherUsername)}`,
          {
            headers: {
              Authorization: `Bearer ${sessionToken}`,
            },
          },
        );

        if (!response.ok) {
          return;
        }

        const data = await response.json();
        if (data?.status) {
          setDirectBlockStatus({
            blockedByMe: Boolean(data.status.blockedByMe),
            blockedMe: Boolean(data.status.blockedMe),
            isMutual: Boolean(data.status.isMutual),
            canSend: Boolean(data.status.canSend),
          });
        }
      } catch (error) {
        console.error("Failed to load direct block status:", error);
      }
    },
    [],
  );

  const unblockCurrentUser = useCallback(async () => {
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken || !recipientUsername) {
      return;
    }

    try {
      const response = await fetch(
        `/api/blocks/by-username/${encodeURIComponent(recipientUsername)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Failed to unblock user");
      }

      if (data?.status) {
        setDirectBlockStatus({
          blockedByMe: Boolean(data.status.blockedByMe),
          blockedMe: Boolean(data.status.blockedMe),
          isMutual: Boolean(data.status.isMutual),
          canSend: Boolean(data.status.canSend),
        });
      } else {
        await loadDirectBlockStatus(sessionToken, recipientUsername);
      }

      toast.success("User unblocked");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unblock user");
    }
  }, [loadDirectBlockStatus, recipientUsername]);

  // Verify session token is still valid
  const validateSession = async (
    sessionToken: string,
  ): Promise<"valid" | "invalid" | "unreachable"> => {
    try {
      const response = await fetch("/api/auth/verify-session", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (response.ok) {
        return "valid";
      }

      if (response.status === 401) {
        return "invalid";
      }

      return "unreachable";
    } catch (error) {
      console.error("Session validation error:", error);
      return "unreachable";
    }
  };

  // Verify authentication and get user info
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const sessionToken = await getRestoredSessionToken();

      if (!sessionToken || !chatTarget) {
        navigate("/signin");
        return;
      }

      const validationState = await validateSession(sessionToken);
      if (validationState === "invalid") {
        toast.error("Session expired - please sign in again");
        void browserStorage.clear();
        navigate("/signin");
        return;
      }

      try {
        const response = await fetch("/api/profile/me", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });

        if (response.status === 401) {
          toast.error("Session expired - please sign in again");
          void browserStorage.clear();
          navigate("/signin");
          return;
        }

        if (!response.ok) {
          throw new Error("Failed to load profile");
        }

        const profile = await response.json();
        if (cancelled) {
          return;
        }

        const currentId = String(profile.userId || "");
        setCurrentUserId(currentId);
        setIsSearchOpen(false);
        setSearchQuery("");
        setActiveSearchIndex(0);
        setHasLoadedSearchHistory(false);
        setConversationTotal(0);
        await loadConversation(currentId, sessionToken);
      } catch (error) {
        console.error("Profile bootstrap error:", error);
        if (!cancelled) {
          toast.error("Restoring chat session. Please wait a moment.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chatTarget, getRestoredSessionToken, navigate]);

  useEffect(() => {
    if (!resolvedRecipientId || !currentUserId) {
      return;
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncConversationRead(true);
      }
    };

    const handleWindowFocus = () => {
      syncConversationRead(true);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [resolvedRecipientId, currentUserId, syncConversationRead]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken || !recipientUsername) {
        directMessageTransportModeRef.current = "v1";
        return;
      }

      try {
        const readiness = await getDirectMessageV2ReadinessForUsername(
          recipientUsername,
          sessionToken,
        );
        if (cancelled) {
          return;
        }

        directMessageTransportModeRef.current = readiness.mode;

        if (
          readiness.reason === "device_session_crypto_not_implemented" &&
          readiness.remoteDeviceIds.length > 0
        ) {
          console.log(
            "[DM-V2] Remote bundles support v2, but client device-session crypto is not implemented yet. Staying on v1 transport.",
            {
              localDeviceId: readiness.localDeviceId,
              remoteDeviceIds: readiness.remoteDeviceIds,
            },
          );
        }
      } catch (error) {
        if (!cancelled) {
          directMessageTransportModeRef.current = "v1";
          console.error("Failed to evaluate direct message v2 readiness:", error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [recipientUsername]);

  const resolveChatTarget = useCallback(async () => {
    const normalizedTarget = (chatTarget || "").trim();
    if (!normalizedTarget) {
      return null;
    }

    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return null;
    }

    const response = await fetch(
      `/api/users/resolve/${encodeURIComponent(normalizedTarget.replace(/^@+/, ""))}`,
      {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to resolve chat recipient");
    }

    const data = await response.json();
    return {
      userId: String(data.userId || ""),
      username: String(data.username || ""),
    };
  }, [chatTarget]);

  const fetchConversationBatch = useCallback(
    async (
      sessionToken: string,
      conversationUsername: string,
      userId: string,
      otherUserPublicKey: string,
      otherUserSignPublicKey: string,
      limit: number,
      offset: number,
      options?: {
        anchorLatest?: boolean;
      },
    ) => {
      const anchorQuery = options?.anchorLatest ? "&anchor=latest" : "";
      const historyRes = await fetch(
        `/api/messages/conversation/by-username/${encodeURIComponent(conversationUsername)}?limit=${limit}&offset=${offset}${anchorQuery}`,
        {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      if (!historyRes.ok) {
        const error = await historyRes.json().catch(() => ({}));
        throw new Error(error.error || "Failed to load conversation history");
      }

      const historyData = await historyRes.json();

      return {
        recipientId: String(historyData.recipientId || ""),
        total: Number(historyData.total) || 0,
        messages: decryptConversationMessages(
          historyData.messages || [],
          userId,
          otherUserPublicKey,
          otherUserSignPublicKey,
        ),
      };
    },
    [decryptConversationMessages],
  );

  const loadSearchHistory = useCallback(async () => {
    if (
      isSearchLoading ||
      hasLoadedSearchHistory ||
      !recipientUsername ||
      !currentUserId ||
      !recipientPublicKey ||
      !recipientSignPublicKey
    ) {
      return;
    }

    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }

    setIsSearchLoading(true);

    try {
      const pageSize = 200;
      let offset = 0;
      let total = 0;
      let aggregated: ChatMessage[] = [];

      do {
        const batch = await fetchConversationBatch(
          sessionToken,
          recipientUsername,
          currentUserId,
          recipientPublicKey,
          recipientSignPublicKey,
          pageSize,
          offset,
        );

        aggregated = mergeMessages(aggregated, batch.messages);
        total = batch.total;
        offset += pageSize;

        if (batch.messages.length === 0) {
          break;
        }
      } while (offset < total);

      setMessages((prev) => mergeMessages(prev, aggregated));
      setConversationTotal(total);
      setHasLoadedSearchHistory(true);
    } catch (error) {
      console.error("Search history load error:", error);
      toast.error("Failed to search older messages");
    } finally {
      setIsSearchLoading(false);
    }
  }, [
    currentUserId,
    fetchConversationBatch,
    hasLoadedSearchHistory,
    isSearchLoading,
    mergeMessages,
    recipientPublicKey,
    recipientSignPublicKey,
    recipientUsername,
  ]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    void loadSearchHistory();
  }, [loadSearchHistory]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    setActiveSearchIndex(0);
  }, []);

  const handleConversationSearch = useCallback(() => {
    setIsConversationMenuOpen(false);
    if (isSearchOpen) {
      closeSearch();
    } else {
      openSearch();
    }
  }, [closeSearch, isSearchOpen, openSearch]);

  const handleConversationDelete = useCallback(
    async (scope: "self" | "mixed") => {
      if (!recipientUsername) {
        return;
      }

      const confirmationMessage =
        scope === "self"
          ? "Clear this chat for you only?"
          : "Erase this chat with mixed scope? Your messages will be deleted for both users, and the other user's messages will be cleared only for you.";

      if (!window.confirm(confirmationMessage)) {
        return;
      }

      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        toast.error("Session expired");
        return;
      }

      setConversationActionPending(scope);
      setIsConversationMenuOpen(false);

      try {
        const response = await fetch(
          `/api/messages/conversation/by-username/${encodeURIComponent(recipientUsername)}`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ scope }),
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              (scope === "self"
                ? "Failed to clear chat for you"
                : "Failed to erase chat with the requested scope"),
          );
        }

        for (const message of messages) {
          rememberDeletedMessage(message.id, message.serverUUID, 60000);
        }

        setMessages([]);
        setConversationTotal(0);
        setSelectedMessageId(null);
        setExpandedMessageIds(new Set());
        closeSearch();
        await refreshConversations();

        toast.success(
          scope === "self"
            ? "Chat cleared for you"
            : "Chat erase completed",
        );
      } catch (error) {
        console.error("Conversation deletion error:", error);
        toast.error(
          error instanceof Error ? error.message : "Conversation action failed",
        );
      } finally {
        setConversationActionPending(null);
      }
    },
    [
      closeSearch,
      messages,
      recipientUsername,
      refreshConversations,
      rememberDeletedMessage,
    ],
  );

  const goToSearchMatch = useCallback(
    (direction: "next" | "previous") => {
      if (searchMatches.length === 0) {
        return;
      }

      setActiveSearchIndex((currentIndex) => {
        if (direction === "next") {
          return (currentIndex + 1) % searchMatches.length;
        }

        return (currentIndex - 1 + searchMatches.length) % searchMatches.length;
      });
    },
    [searchMatches.length],
  );

  useEffect(() => {
    if (!isSearchOpen || !normalizedSearchQuery || hasLoadedSearchHistory) {
      return;
    }

    void loadSearchHistory();
  }, [
    hasLoadedSearchHistory,
    isSearchOpen,
    loadSearchHistory,
    normalizedSearchQuery,
  ]);

  // Load conversation history
  const loadConversation = async (userId: string, sessionToken: string) => {
    try {
      if (!hasLoadedConversationOnceRef.current) {
        setIsLoading(true);
      }
      if (!(await waitForStoredKeyPair(3000))) {
        throw new Error("Secure keys are still restoring for this session");
      }

      const fallbackUsername = (chatTarget || "")
        .replace(/^@+/, "")
        .trim()
        .toLowerCase();
      let resolvedTarget:
        | { userId: string; username: string }
        | null = null;

      try {
        resolvedTarget = await resolveChatTarget();
      } catch (resolveError) {
        console.warn("Failed to resolve chat recipient metadata:", resolveError);
      }

      const targetUsername = resolvedTarget?.username || fallbackUsername;

      if (!targetUsername) {
        throw new Error("Invalid chat recipient");
      }

      if (resolvedTarget?.userId) {
        setResolvedRecipientId(resolvedTarget.userId);
      }
      setRecipientUsername(targetUsername);
      setDirectBlockStatus(ALLOW_ALL_DIRECT_MESSAGES);
      if (chatTarget !== targetUsername) {
        navigate(`/chat/${targetUsername}`, { replace: true });
      }
      void markConversationAsRead(sessionToken, targetUsername, true);
      void loadDirectBlockStatus(sessionToken, targetUsername);

      // Get recipient's public key
      const pubKeyRes = await fetch(
        `/api/auth/public-key/by-username/${encodeURIComponent(targetUsername)}`,
      );
      if (!pubKeyRes.ok) {
        const error = await pubKeyRes.json();
        throw new Error(error.error || "Failed to load recipient's public key");
      }
      const pubKeyData = await pubKeyRes.json();
      setRecipientPublicKey(pubKeyData.publicKey);
      setRecipientSignPublicKey(
        pubKeyData.signPublicKey || pubKeyData.publicKey,
      );

      // Get recipient's display name, username, and settings
      try {
        const profileRes = await fetch(
          `/api/profile/by-username/${encodeURIComponent(targetUsername)}`,
        );
        if (profileRes.ok) {
          const profileData = await profileRes.json();
          setRecipientName(profileData.displayName || "User");
          setRecipientUsername(
            profileData.username || targetUsername,
          );
          setRecipientAvatar(profileData.avatar || null);
          setRecipientShowTimestamps(profileData.showTimestamps ?? true);
        } else {
          setRecipientName("User");
          setRecipientUsername(targetUsername);
          setRecipientAvatar(null);
        }
      } catch {
        setRecipientName("User");
        setRecipientUsername(targetUsername);
        setRecipientAvatar(null);
      }

      // Get current user's settings
      try {
        const meRes = await fetch("/api/profile/me", {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          setCurrentUserShowTimestamps(meData.showTimestamps ?? true);
        }
      } catch {
        // Use default
      }

      const initialBatch = await fetchConversationBatch(
        sessionToken,
        targetUsername,
        userId,
        pubKeyData.publicKey,
        pubKeyData.signPublicKey || pubKeyData.publicKey,
        50,
        0,
        { anchorLatest: true },
      );

      if (initialBatch.recipientId) {
        setResolvedRecipientId(initialBatch.recipientId);
      }
      setMessages(initialBatch.messages);
      setConversationTotal(initialBatch.total);
      setHasLoadedSearchHistory(false);

      // Track the last timestamp we've loaded
      if (initialBatch.messages.length > 0) {
        const maxTimestamp = Math.max(
          ...initialBatch.messages.map((m) => m.timestamp),
        );
        lastFetchTimestampRef.current = maxTimestamp;
      }

      hasLoadedConversationOnceRef.current = true;
      setIsLoading(false);
    } catch (error) {
      console.error("Load conversation error:", error);
      if (conversationRecoveryAttemptsRef.current < 2) {
        conversationRecoveryAttemptsRef.current += 1;
        try {
          await browserStorage.reinitializeBrowserStorage();
          const recoveredSessionToken = await getRestoredSessionToken();
          if (recoveredSessionToken) {
            await loadConversation(userId, recoveredSessionToken);
            return;
          }
        } catch (recoveryError) {
          console.error("Conversation recovery attempt failed:", recoveryError);
        }
      }
      toast.error("Failed to load conversation");
      setIsLoading(false);
    }
  };

  // Poll for new messages as a fallback to WebSocket
  const pollForNewMessages = useCallback(async () => {
    try {
      const sessionToken = await getRestoredSessionToken();
      if (!sessionToken || !recipientUsername || !currentUserId) return;

      const historyRes = await fetch(
        `/api/messages/conversation/by-username/${encodeURIComponent(recipientUsername)}?limit=100&offset=0&anchor=latest`,
        {
          headers: {
            Authorization: `Bearer ${sessionToken}`,
          },
        },
      );

      if (!historyRes.ok) return;

      const historyData = await historyRes.json();
      const keyPair = await waitForStoredKeyPair(1500);
      if (!keyPair) return;

      const currentSignPublicKey =
        browserStorage.getItem("current_sign_public_key") ||
        keyPair.signPublicKeyBase64 ||
        keyPair.publicKeyBase64;

      // Process new messages
      for (const encMsg of historyData.messages) {
        const normalizedTimestamp = normalizeTimestamp(encMsg.timestamp);
        // Create message ID for deduplication
        const messageId = `${normalizedTimestamp}-${encMsg.senderId}`;

        // Skip recently deleted messages to prevent re-adding them after deletion
        if (deletedMessageIdsRef.current.has(messageId)) {
          console.log(
            `Polling: Skipping recently deleted message ${messageId}`,
          );
          continue;
        }

        if (isMessageMarkedDeleted(messageId, encMsg.id)) {
          console.log(
            `Polling: Skipping deleted message ${messageId}${encMsg.id ? ` (${encMsg.id})` : ""}`,
          );
          continue;
        }

        try {
          const senderBoxPublicKey =
            encMsg.senderId === currentUserId
              ? browserStorage.getItem("current_public_key") ||
                keyPair.publicKeyBase64
              : recipientPublicKey;

          const senderSignPublicKey =
            encMsg.senderId === currentUserId
              ? currentSignPublicKey
              : recipientSignPublicKey;

          if (!senderBoxPublicKey || !senderSignPublicKey) {
            console.warn(
              `Polling: Missing keys for message from ${encMsg.senderId}`,
            );
            continue;
          }

          const decrypted = decryptMessage(
            encMsg,
            senderBoxPublicKey,
            keyPair.privateKeyBase64,
            senderSignPublicKey,
          );

          if (decrypted) {
            const shouldAutoScroll =
              encMsg.senderId === resolvedRecipientId && isNearBottom();
            // messageId already created above for deduplication check
            const newMessage: ChatMessage = {
              ...decrypted,
              id: messageId,
              timestamp: normalizedTimestamp,
              isOwn: encMsg.senderId === currentUserId,
              status: getMessageStatus(encMsg),
              nonce: encMsg.nonce,
              ciphertext: encMsg.ciphertext,
              signature: encMsg.signature,
              ...(encMsg.id && { serverUUID: encMsg.id }),
            };

            // Merge status updates for existing messages and only append truly new ones.
            setMessages((prev) => {
              const existingIndex = prev.findIndex((m) => {
                if (m.id === messageId) {
                  return true;
                }

                if (encMsg.id && m.serverUUID === encMsg.id) {
                  return true;
                }

                const existingPayloadKey = getMessagePayloadKey(m);
                const incomingPayloadKey = getMessagePayloadKey({
                  senderId: encMsg.senderId,
                  recipientId: encMsg.recipientId,
                  nonce: encMsg.nonce,
                  ciphertext: encMsg.ciphertext,
                  signature: encMsg.signature,
                });

                return (
                  existingPayloadKey !== null &&
                  incomingPayloadKey !== null &&
                  existingPayloadKey === incomingPayloadKey
                );
              });

              if (existingIndex >= 0) {
                const existingMessage = prev[existingIndex];
                const mergedMessage: ChatMessage = {
                  ...existingMessage,
                  ...newMessage,
                  status: mergeMessageStatus(
                    existingMessage.status,
                    newMessage.status,
                  ),
                };

                if (
                  mergedMessage.status === existingMessage.status &&
                  mergedMessage.serverUUID === existingMessage.serverUUID &&
                  mergedMessage.timestamp === existingMessage.timestamp
                ) {
                  return prev;
                }

                const next = [...prev];
                next[existingIndex] = mergedMessage;
                return next;
              }

              if (normalizedTimestamp < lastFetchTimestampRef.current) {
                console.log(
                  `Polling: Skipping old message timestamp=${normalizedTimestamp} (last seen: ${lastFetchTimestampRef.current})`,
                );
                return prev;
              }

              console.log(`Polling: Adding new message ${messageId}`);
              if (shouldAutoScroll) {
                requestScrollToBottom("smooth");
              }
              return [...prev, newMessage];
            });

            // Update ref to track the latest timestamp we've seen
            lastFetchTimestampRef.current = Math.max(
              lastFetchTimestampRef.current,
              normalizedTimestamp,
            );

            if (encMsg.senderId === resolvedRecipientId) {
              syncConversationRead();
            }
          } else {
            console.error(
              `Polling: Failed to decrypt message from ${encMsg.senderId}`,
            );
          }
        } catch (error) {
          console.error("Polling: Error decrypting message:", error);
        }
      }
    } catch (error) {
      console.error("Polling error:", error);
    }
  }, [
    getRestoredSessionToken,
    recipientUsername,
    currentUserId,
    recipientPublicKey,
    recipientSignPublicKey,
    getMessageStatus,
    isMessageMarkedDeleted,
    mergeMessageStatus,
    syncConversationRead,
  ]);

  // WebSocket callbacks - memoized to prevent reconnection loops
  const handleWebSocketMessage = useCallback(
    async (encryptedMessage: EncryptedMessage) => {
      const incomingServerMessageId = (
        encryptedMessage as EncryptedMessage & { id?: string }
      ).id;

      // Only process messages from this conversation
      if (
        encryptedMessage.senderId !== resolvedRecipientId &&
        encryptedMessage.senderId !== currentUserId
      ) {
        return;
      }

      try {
        const keyPair = getStoredKeyPair();
        if (!keyPair) return;

        // Verify sender matches authenticated user (sender authentication)
        if (encryptedMessage.senderId === currentUserId) {
          // Our own message - should not come from WebSocket in normal flow
          // Skip to avoid duplicates
          return;
        }

        // Get sender's public keys for decryption
        // For messages from other user, use their box and sign public keys
        let senderBoxPublicKey = recipientPublicKey;
        let senderSignPublicKey = recipientSignPublicKey;

        // If public keys haven't been loaded yet, fetch them now
        // This handles the race condition where messages arrive before keys are fetched
        if (!senderBoxPublicKey && recipientUsername) {
          try {
            console.log(
              "Public keys not yet loaded, fetching for decryption...",
            );
            const pubKeyRes = await fetch(
              `/api/auth/public-key/by-username/${encodeURIComponent(recipientUsername)}`,
            );
            if (pubKeyRes.ok) {
              const pubKeyData = await pubKeyRes.json();
              senderBoxPublicKey = pubKeyData.publicKey;
              senderSignPublicKey =
                pubKeyData.signPublicKey || pubKeyData.publicKey;
              // Update state so future messages don't need to re-fetch
              setRecipientPublicKey(pubKeyData.publicKey);
              setRecipientSignPublicKey(
                pubKeyData.signPublicKey || pubKeyData.publicKey,
              );
              console.log("Successfully fetched public keys for decryption");
            }
          } catch (error) {
            console.error("Failed to fetch public keys for decryption:", error);
            return;
          }
        }

        if (!senderBoxPublicKey) {
          console.error("No sender box public key available for decryption");
          return;
        }

        if (!senderSignPublicKey) {
          console.error(
            "No sender sign public key available for signature verification",
          );
          return;
        }

        const decrypted = decryptMessage(
          encryptedMessage,
          senderBoxPublicKey,
          keyPair.privateKeyBase64,
          senderSignPublicKey,
        );

        if (decrypted) {
          const shouldAutoScroll = isNearBottom();
          const normalizedTimestamp = normalizeTimestamp(
            encryptedMessage.timestamp,
          );
          // Use senderId + normalized timestamp for unique message ID (consistent across sources)
          // This is crucial for deduplication across polling + WebSocket
          const messageId = `${normalizedTimestamp}-${encryptedMessage.senderId}`;

          if (isMessageMarkedDeleted(messageId, incomingServerMessageId)) {
            console.log(
              `Skipping deleted message ${messageId} from WebSocket`,
            );
            return;
          }

          const newMessage: ChatMessage = {
            ...decrypted,
            id: messageId,
            timestamp: normalizedTimestamp,
            isOwn: false, // Always false since we filtered out own messages
            nonce: encryptedMessage.nonce,
            ciphertext: encryptedMessage.ciphertext,
            signature: encryptedMessage.signature,
            ...(incomingServerMessageId && { serverUUID: incomingServerMessageId }),
          };

          setMessages((prev) => {
            // Check for exact duplicate by message ID
            const isDuplicateByID = prev.some((m) => m.id === messageId);
            if (isDuplicateByID) {
              console.log(
                `Skipping duplicate message ${messageId} from WebSocket`,
              );
              return prev;
            }

            if (isMessageMarkedDeleted(messageId, incomingServerMessageId)) {
              console.log(
                `Skipping deleted message ${messageId} during WebSocket state merge`,
              );
              return prev;
            }

            const incomingPayloadKey = getMessagePayloadKey({
              senderId: encryptedMessage.senderId,
              recipientId: encryptedMessage.recipientId,
              nonce: encryptedMessage.nonce,
              ciphertext: encryptedMessage.ciphertext,
              signature: encryptedMessage.signature,
            });

            const isDuplicateByPayload = prev.some((m) => {
              const existingPayloadKey = getMessagePayloadKey(m);
              return (
                existingPayloadKey !== null &&
                incomingPayloadKey !== null &&
                existingPayloadKey === incomingPayloadKey
              );
            });

            if (isDuplicateByPayload) {
              console.log(
                `Skipping duplicate message by payload match from WebSocket`,
              );
              return prev;
            }

            console.log(
              `Adding new message ${normalizedTimestamp}-${encryptedMessage.senderId} from WebSocket`,
            );
            if (shouldAutoScroll) {
              requestScrollToBottom("smooth");
            }
            return [...prev, newMessage];
          });

          // Update last fetch timestamp to prevent polling from re-adding this message
          lastFetchTimestampRef.current = Math.max(
            lastFetchTimestampRef.current,
            normalizedTimestamp,
          );

          syncConversationRead();
        } else {
          console.error(
            `Failed to decrypt WebSocket message from ${encryptedMessage.senderId}`,
          );
        }
      } catch (error) {
        console.error("WebSocket message processing error:", error);
      }
    },
    [
      resolvedRecipientId,
      currentUserId,
      recipientPublicKey,
      recipientSignPublicKey,
      getMessageStatus,
      isMessageMarkedDeleted,
      syncConversationRead,
    ],
  );

  const handleWebSocketAck = useCallback(
    (
      messageId: string,
      delivered: boolean,
      serverTimestamp?: number,
      serverMessageId?: string,
    ) => {
      // Update message delivery status and timestamp based on ACK
      const localMessageId = sentMessagesRef.current.get(messageId);
      if (localMessageId) {
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id === localMessageId) {
              // If server timestamp is provided, update message ID and timestamp to match server
              if (serverTimestamp) {
                const newMessageId = `${serverTimestamp}-${msg.senderId}`;
                return {
                  ...msg,
                  id: newMessageId,
                  timestamp: serverTimestamp,
                  ...(serverMessageId && { serverUUID: serverMessageId }),
                  status: mergeMessageStatus(
                    msg.status,
                    delivered ? "delivered" : "sent",
                  ),
                };
              }
              return {
                ...msg,
                ...(serverMessageId && { serverUUID: serverMessageId }),
                status: mergeMessageStatus(
                  msg.status,
                  delivered ? "delivered" : "sent",
                ),
              };
            }
            return msg;
          }),
        );

        // Update lastFetchTimestampRef to include the server timestamp
        // This prevents polling from adding the message again
        if (serverTimestamp) {
          lastFetchTimestampRef.current = Math.max(
            lastFetchTimestampRef.current,
            serverTimestamp,
          );
        }
      }
    },
    [mergeMessageStatus],
  );

  const handleWebSocketStatus = useCallback(
    (
      messageId: string,
      status: "sent" | "delivered" | "failed" | "seen",
      metadata?: {
        serverUUID?: string;
        deliveredAt?: number;
        seenAt?: number;
      },
    ) => {
      setMessages((prev) =>
        prev.map((msg) => {
          const matchesById = msg.id === messageId;
          const matchesByServerUuid =
            !!metadata?.serverUUID && msg.serverUUID === metadata.serverUUID;

          if (!matchesById && !matchesByServerUuid) {
            return msg;
          }

          return {
            ...msg,
            status: mergeMessageStatus(msg.status, status),
            ...(metadata?.serverUUID && { serverUUID: metadata.serverUUID }),
          };
        }),
      );
    },
    [mergeMessageStatus],
  );

  const handleWebSocketDeletion = useCallback(
    (
      incomingMessageId: string,
      deletedBy: string,
      metadata?: {
        serverUUID?: string;
        messageTimestamp?: number;
        senderId?: string;
      },
    ) => {
      console.log(
        `[WS-DELETE] Received deletion notification for message ${incomingMessageId} (deleted by: ${deletedBy})`,
      );
      if (metadata) {
        console.log(
          `[WS-DELETE] Metadata: serverUUID=${metadata.serverUUID}, timestamp=${metadata.messageTimestamp}, senderId=${metadata.senderId}`,
        );
      }

      const normalizedMetadataTimestamp =
        metadata?.messageTimestamp != null
          ? normalizeTimestamp(metadata.messageTimestamp)
          : undefined;
      const reconstructedId =
        normalizedMetadataTimestamp != null && metadata?.senderId
          ? `${normalizedMetadataTimestamp}-${metadata.senderId}`
          : undefined;

      rememberDeletedMessage(
        reconstructedId || incomingMessageId,
        metadata?.serverUUID,
      );

      // Find a message that matches the deletion notification by trying multiple ID formats
      let matchedMessage: ChatMessage | undefined;

      setMessages((prev) => {
        // MATCH 1: Direct message.id match (most common case)
        matchedMessage = prev.find((m) => m.id === incomingMessageId);
        if (matchedMessage) {
          console.log(
            `[WS-DELETE] ✓ Matched message by direct ID: ${incomingMessageId}`,
          );
          return prev;
        }

        // MATCH 2: Match by serverUUID (handles client-server UUID mismatch)
        if (metadata?.serverUUID) {
          matchedMessage = prev.find(
            (m) => m.serverUUID === metadata.serverUUID,
          );
          if (matchedMessage) {
            console.log(
              `[WS-DELETE] ✓ Matched message by serverUUID: ${metadata.serverUUID}`,
            );
            return prev;
          }
        }

        // MATCH 3: Reconstruct ID from metadata (handles different timestamp sources)
        if (reconstructedId) {
          matchedMessage = prev.find((m) => m.id === reconstructedId);
          if (matchedMessage) {
            console.log(
              `[WS-DELETE] ✓ Matched message by reconstructed ID: ${reconstructedId}`,
            );
            return prev;
          }
        }

        console.log(
          `[WS-DELETE] Message not found in local state (already deleted or from polling)`,
        );
        return prev;
      });

      // If we found a matching message, remove it
      if (matchedMessage) {
        const deletedMessageId = matchedMessage.id;
        rememberDeletedMessage(deletedMessageId, matchedMessage.serverUUID);
        console.log(
          `[WS-DELETE] Added ${deletedMessageId} to deletion tracking`,
        );

        // Remove from local state
        setMessages((prev) => {
          const updated = prev.filter((m) => m.id !== deletedMessageId);
          console.log(
            `[WS-DELETE] ✓ Removed message ${deletedMessageId} from UI`,
          );
          return updated;
        });

        // Deselect if this message was selected
        if (selectedMessageId === deletedMessageId) {
          setSelectedMessageId(null);
          console.log(`[WS-DELETE] Deselecting deleted message`);
        }

        // Show appropriate notification based on who deleted it
        if (deletedBy === currentUserId) {
          console.log(`[WS-DELETE] Message was deleted by current user`);
        } else {
          toast.info("A message was deleted by the sender");
        }

      }
    },
    [currentUserId, rememberDeletedMessage, selectedMessageId],
  );

  const handleWebSocketError = useCallback((error: string) => {
    console.error("WebSocket error:", error);
    if (error.toLowerCase().includes("blocked")) {
      toast.error(error);
      return;
    }
    toast.error(
      error === "Session expired"
        ? "Session expired. Please sign in again."
        : "Connection error: " + error,
    );
  }, []);

  const handleWebSocketConnected = useCallback(() => {
    console.log("WebSocket connected for chat");
    // Retry any pending messages that failed to send
    retryPendingMessages();
    syncConversationRead(true);
  }, [syncConversationRead]);

  const handleWebSocketSendError = useCallback(
    (
      messageId?: string,
      errorMessage?: string,
      code?: string,
      status?: {
        blockedByMe?: boolean;
        blockedMe?: boolean;
        isMutual?: boolean;
        canSend?: boolean;
      },
    ) => {
      if (messageId) {
        const localMessageId = sentMessagesRef.current.get(messageId);
        if (localMessageId) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === localMessageId
                ? { ...message, status: "failed" }
                : message,
            ),
          );
          sentMessagesRef.current.delete(messageId);
        }
      }

      if (code === "DIRECT_MESSAGE_BLOCKED" && status) {
        setDirectBlockStatus({
          blockedByMe: Boolean(status.blockedByMe),
          blockedMe: Boolean(status.blockedMe),
          isMutual: Boolean(status.isMutual),
          canSend: Boolean(status.canSend),
        });
      }

    },
    [],
  );

  const handleWebSocketDirectBlockUpdated = useCallback(
    (
      otherUserId: string,
      status: {
        blockedByMe: boolean;
        blockedMe: boolean;
        isMutual: boolean;
        canSend: boolean;
      },
    ) => {
      if (!resolvedRecipientId || otherUserId !== resolvedRecipientId) {
        return;
      }

      setDirectBlockStatus({
        blockedByMe: Boolean(status.blockedByMe),
        blockedMe: Boolean(status.blockedMe),
        isMutual: Boolean(status.isMutual),
        canSend: Boolean(status.canSend),
      });
    },
    [resolvedRecipientId],
  );

  // Set up WebSocket for real-time messages
  const { isConnected, sendEncryptedMessage: sendViaWebSocket } = useWebSocket({
    onMessage: handleWebSocketMessage,
    onAck: handleWebSocketAck,
    onStatus: handleWebSocketStatus,
    onMessageDeleted: handleWebSocketDeletion,
    onDirectBlockUpdated: handleWebSocketDirectBlockUpdated,
    onSendError: handleWebSocketSendError,
    onError: handleWebSocketError,
    onConnected: handleWebSocketConnected,
  });

  // Start polling for new messages as a fallback (every 2 seconds)
  useEffect(() => {
    if (!resolvedRecipientId || !currentUserId) return;

    // Initial poll immediately
    pollForNewMessages();

    const pollMs = isConnected ? 12000 : 2500;
    pollIntervalRef.current = setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      pollForNewMessages();
    }, pollMs);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [resolvedRecipientId, currentUserId, pollForNewMessages, isConnected]);

  // Retry pending messages (queued for offline delivery)
  const retryPendingMessages = async () => {
    if (pendingMessagesRef.current.length === 0) return;

    console.log(
      `Retrying ${pendingMessagesRef.current.length} pending messages`,
    );

    const pendingToRetry = [...pendingMessagesRef.current];
    pendingMessagesRef.current = []; // Clear the queue

    for (const message of pendingToRetry) {
      try {
        const sessionToken = browserStorage.getItem("session_token");
        if (!sessionToken) {
          // Re-queue if no session
          pendingMessagesRef.current.push(message);
          continue;
        }

        // Validate we have encrypted data
        if (!message.nonce || !message.ciphertext || !message.signature) {
          console.warn(
            `Message ${message.id} missing encrypted data, skipping`,
          );
          continue;
        }

        // Retry sending the message with stored encrypted data
        const sendRes = await fetch("/api/messages/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            recipientId: resolvedRecipientId,
            nonce: message.nonce,
            ciphertext: message.ciphertext,
            signature: message.signature,
            timestamp: message.timestamp,
          }),
        });

        if (sendRes.ok) {
          const response = await sendRes.json();
          const serverTimestamp = response.timestamp; // Get server's authoritative timestamp
          const serverMessageUUID = response.messageId; // Get server's canonical UUID for deletion
          const serverMessageId = `${serverTimestamp}-${currentUserId}`; // Use server timestamp for message ID

          // Update message with server timestamp, UUID, and delivered status
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === message.id
                ? {
                    ...msg,
                    id: serverMessageId,
                    timestamp: serverTimestamp,
                    status: response.delivered ? "delivered" : "sent",
                    ...(serverMessageUUID && { serverUUID: serverMessageUUID }),
                  }
                : msg,
            ),
          );

          // Update lastFetchTimestampRef with the server timestamp
          lastFetchTimestampRef.current = Math.max(
            lastFetchTimestampRef.current,
            serverTimestamp,
          );

          console.log(
            `Retried message ${message.id} successfully with server timestamp ${serverTimestamp}`,
          );
        } else {
          if (sendRes.status === 403) {
            const errorData = await sendRes.json().catch(() => ({}));
            if (errorData?.code === "DIRECT_MESSAGE_BLOCKED") {
              const status = errorData.blockStatus;
              if (status) {
                setDirectBlockStatus({
                  blockedByMe: Boolean(status.blockedByMe),
                  blockedMe: Boolean(status.blockedMe),
                  isMutual: Boolean(status.isMutual),
                  canSend: Boolean(status.canSend),
                });
              }
              console.warn(`Retry stopped for ${message.id} due to block state`);
              continue;
            }
          }
          // Re-queue if still failed
          pendingMessagesRef.current.push(message);
          console.warn(`Failed to retry message ${message.id}`);
        }
      } catch (error) {
        // Re-queue if error occurred
        pendingMessagesRef.current.push(message);
        console.error(`Error retrying message ${message.id}:`, error);
      }
    }
  };

  const sendMessageContent = async (content: string) => {
    // Synchronous guard to prevent double-submit
    if (isSendingRef.current) {
      console.log(
        "Message send already in progress, ignoring duplicate submit",
      );
      return;
    }

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      return;
    }

    if (!directBlockStatus.canSend) {
      if (directBlockStatus.isMutual) {
        toast.error("Messaging disabled due to mutual block. Unblock to resume.");
      } else if (directBlockStatus.blockedByMe) {
        toast.error("You've blocked this user. Unblock to send a message.");
      } else {
        toast.error("You've been blocked by this user. You cannot send messages.");
      }
      return;
    }

    if (!recipientPublicKey || !currentUserId || !resolvedRecipientId) {
      toast.error("Chat not fully loaded");
      return;
    }

    try {
      isSendingRef.current = true;
      setIsSending(true);

      // Validate session before sending
      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        throw new Error("No active session");
      }

      const isSessionValid = await validateSession(sessionToken);
      if (!isSessionValid) {
        throw new Error("Session expired - please sign in again and try again");
      }

      const keyPair = getStoredKeyPair();
      if (!keyPair) {
        throw new Error(
          "Your encryption keys are missing. Please sign out and sign back in to restore them using your passphrase, or create a new account.",
        );
      }

      // Encrypt message
      const encrypted = encryptMessage(
        trimmedContent,
        recipientPublicKey,
        keyPair.privateKeyBase64,
        keyPair.signPrivateKeyBase64,
      );

      // Create full encrypted message with sender info
      const fullMessage = {
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        signature: encrypted.signature,
        senderId: currentUserId,
        recipientId: resolvedRecipientId,
        timestamp: encrypted.timestamp,
      };

      // Create local message ID for tracking delivery
      const localMessageId = `${encrypted.timestamp}-${currentUserId}`;

      // Add message to local state optimistically with "sent" status
      // Note: timestamp will be updated with server's authoritative timestamp
      const newMessage: ChatMessage = {
        senderId: currentUserId,
        recipientId: resolvedRecipientId,
        content: trimmedContent,
        timestamp: encrypted.timestamp, // Temporary client timestamp, will be replaced
        id: localMessageId,
        isOwn: true,
        status: "sent",
        // Store encrypted data for retry on reconnect
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        signature: encrypted.signature,
      };

      requestScrollToBottom("smooth");
      setMessages((prev) => [...prev, newMessage]);
      setMessageInput("");
      refocusMessageComposer();

      // DO NOT update lastFetchTimestampRef with client timestamp
      // This would prevent polling from fetching the server version with a different (server) timestamp
      // The timestamp will be updated properly once we get the server response

      // Try to send via WebSocket if connected (real-time delivery)
      let sent = false;
      if (isConnected) {
        // Generate a temporary message ID for this WebSocket transmission
        const wsMessageId = `${encrypted.timestamp}-ws`;
        sentMessagesRef.current.set(wsMessageId, localMessageId);

        sent = sendViaWebSocket(fullMessage, wsMessageId);
        if (sent) {
          console.log("Message sent via WebSocket");
        } else {
          sentMessagesRef.current.delete(wsMessageId);
        }
      }

      // If WebSocket not connected or failed, fall back to HTTP
      if (!sent) {
        try {
          const sendRes = await fetch("/api/messages/send", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              recipientId: resolvedRecipientId,
              nonce: encrypted.nonce,
              ciphertext: encrypted.ciphertext,
              signature: encrypted.signature,
              timestamp: encrypted.timestamp,
            }),
          });

          if (!sendRes.ok) {
            const errorData = await sendRes.json();
            if (sendRes.status === 403 && errorData?.code === "DIRECT_MESSAGE_BLOCKED") {
              const status = errorData.blockStatus;
              if (status) {
                setDirectBlockStatus({
                  blockedByMe: Boolean(status.blockedByMe),
                  blockedMe: Boolean(status.blockedMe),
                  isMutual: Boolean(status.isMutual),
                  canSend: Boolean(status.canSend),
                });
              }
            }
            const error = new Error(
              errorData.error || "Failed to send message",
            );
            (error as any).critical = errorData.critical || false;
            throw error;
          }

          const response = await sendRes.json();
          const serverTimestamp = response.timestamp; // Get server's authoritative timestamp
          const serverMessageUUID = response.messageId; // Get server's canonical UUID for deletion
          const serverMessageId = `${serverTimestamp}-${currentUserId}`; // Use server timestamp for display/sorting

          console.log(
            `[SEND] Server response: UUID=${serverMessageUUID}, timestamp=${serverTimestamp}`,
          );

          // Update message with server UUID and timestamp
          // The UUID is crucial for deletion operations
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === localMessageId
                ? {
                    ...msg,
                    id: serverMessageId, // Use timestamp format for sorting/display (backward compat)
                    // Store the actual UUID as a property for deletion operations
                    ...(serverMessageUUID && { serverUUID: serverMessageUUID }),
                    timestamp: serverTimestamp, // Use server-provided timestamp
                    status: response.delivered ? "delivered" : "sent",
                  }
                : msg,
            ),
          );

          // Update the pending messages ref to use new message ID
          pendingMessagesRef.current = pendingMessagesRef.current.map((m) =>
            m.id === localMessageId
              ? {
                  ...m,
                  id: serverMessageId,
                  timestamp: serverTimestamp,
                  ...(serverMessageUUID && { serverUUID: serverMessageUUID }),
                }
              : m,
          );

          // Update lastFetchTimestampRef with the server timestamp
          lastFetchTimestampRef.current = Math.max(
            lastFetchTimestampRef.current,
            serverTimestamp,
          );

          // Warn user if message wasn't persisted to R2 (but still delivered to memory)
          if (!response.persisted) {
            console.warn("Message sent but not persisted to R2");
            toast.warning(
              "Message sent but backup storage failed - may not be recoverable if server restarts",
            );
          }

          console.log("Message sent via HTTP (fallback)");
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          const isCritical = (error as any).critical || false;

          console.error("Failed to send message:", errorMessage);

          // Check if this is a critical persistence error
          if (isCritical) {
            console.error(
              "CRITICAL: Message failed to persist. This is a serious error.",
            );
            toast.error(
              "Critical error: Message could not be saved. Please check your connection and storage configuration.",
            );
          }

          // Update message status to failed
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === localMessageId ? { ...msg, status: "failed" } : msg,
            ),
          );
          // Queue message for retry when connection is restored
          const failedMessage = messages.find((m) => m.id === localMessageId);
          if (failedMessage) {
            pendingMessagesRef.current.push(failedMessage);
            toast.error(`Message queued for retry: ${errorMessage}`);
          }
        }
      }
    } catch (error) {
      console.error("Send message error:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      toast.error(errorMessage);
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
      refocusMessageComposer();
    }
  };

  // Send message
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    await sendMessageContent(messageInput);
  };

  const handleGifSelect = useCallback(
    async (gif: KlipyGifItem, type: "gif" | "sticker") => {
      await sendMessageContent(buildGifMessageContent(gif, type));
    },
    [sendMessageContent],
  );

  const handleImageFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) {
        return;
      }

      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        toast.error("Session expired. Sign in again and retry.");
        return;
      }

      if (!recipientUsername) {
        toast.error("Chat recipient is not ready yet");
        return;
      }

      try {
        setIsUploadingImage(true);
        const uploaded = await uploadDirectImage(
          recipientUsername,
          file,
          sessionToken,
        );
        await sendMessageContent(buildImageMessageContent(uploaded));
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to send image",
        );
      } finally {
        setIsUploadingImage(false);
      }
    },
    [recipientUsername, sendMessageContent],
  );

  // Helper to get user initials
  const handleDeleteMessage = async (
    messageId: string,
    scope: "self" | "everyone" = "self",
  ) => {
    try {
      setIsDeletingMessageId(messageId);

      // STEP 1: Find the message to delete (for potential rollback)
      const messageToDelete = messages.find((m) => m.id === messageId);
      if (!messageToDelete) {
        toast.error("Message not found");
        return;
      }

      console.log(
        `[DELETE-UI] Deleting message ${messageId} with scope=${scope}`,
      );

      // STEP 2: MARK AS DELETED LOCALLY
      // Add to tracking set to prevent polling from re-adding it
      // This window needs to cover:
      // - Network round-trip time
      // - Server processing time
      // - Polling sync time
      // Use 30 seconds to be safe (covers slow connections + processing)
      rememberDeletedMessage(messageId, messageToDelete.serverUUID);
      console.log(`[DELETE-UI] Added to deletion tracking set`);

      // STEP 3: OPTIMISTIC UI UPDATE (instant, no waiting)
      // Remove from local state immediately for instant feedback
      // User sees message disappear right away (like WhatsApp/Telegram)
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setSelectedMessageId(null);
      console.log(`[DELETE-UI] ✓ Message removed from UI`);
      toast.success(
        scope === "everyone"
          ? "Message deleted for both"
          : "Message removed for you",
      );

      // STEP 4: PERSIST DELETION TO SERVER (async in background)
      // Don't wait for this, user already got visual feedback
      // But ensure deletion is persisted before notifying recipient
      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        console.error("[DELETE-UI] No session token");
        toast.error("Session expired - deletion may not be synced");
        // Re-add message locally since we can't verify deletion
        if (messageToDelete) {
          setMessages((prev) => [...prev, messageToDelete]);
        }
        deletedMessageIdsRef.current.delete(messageId);
        if (messageToDelete.serverUUID) {
          deletedServerMessageIdsRef.current.delete(messageToDelete.serverUUID);
        }
        return;
      }

      try {
        console.log(`[DELETE-UI] Sending deletion request to server...`);

        // Use UUID if available (from server response), otherwise use local ID
        // UUID provides cleaner server-side lookup
        const messageUUID = (messageToDelete as any)?.serverUUID;
        const deleteMessageId = messageUUID || messageId;

        console.log(
          `[DELETE-UI] Using ${messageUUID ? "server UUID" : "local ID"} for deletion: ${deleteMessageId}`,
        );

        const deleteRes = await fetch("/api/messages/message", {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            messageId: deleteMessageId, // Send UUID if available, else local ID
            recipientId: resolvedRecipientId,
            scope,
          }),
        });

        if (!deleteRes.ok) {
          const errorData = await deleteRes.json();
          console.error("[DELETE-UI] Server deletion failed:", errorData);

          // ROLLBACK: Re-add message to UI if server deletion failed
          // This is critical - we want to show the message again if deletion didn't work
          setMessages((prev) => {
            // Check if message was already re-added (shouldn't happen, but safety check)
            if (prev.some((m) => m.id === messageId)) {
              return prev;
            }
            // Re-add in its original position
            const restored = [...prev, messageToDelete];
            // Try to maintain chronological order by timestamp
            restored.sort((a, b) => a.timestamp - b.timestamp);
            return restored;
          });

          toast.error(
            errorData.error ||
              (scope === "everyone"
                ? "Failed to delete message for both - message has been restored"
                : "Failed to remove message for you - message has been restored"),
          );
          deletedMessageIdsRef.current.delete(messageId);
          if (messageToDelete.serverUUID) {
            deletedServerMessageIdsRef.current.delete(messageToDelete.serverUUID);
          }
          console.error("[DELETE-UI] ✗ Deletion failed, message restored");
          return;
        }

        const deleteResult = await deleteRes.json();
        console.log(
          `[DELETE-UI] ✓ Server confirmed delete-for-me (DB: ${deleteResult.persisted?.database}, R2: ${deleteResult.persisted?.r2})`,
        );

        // If neither storage backend succeeded, warn user
        if (!deleteResult.persisted?.database && !deleteResult.persisted?.r2) {
          toast.warning(
            scope === "everyone"
              ? "Message deleted but not fully synced - it may reappear"
              : "Message removed locally but not fully synced - it may reappear",
          );
        } else if (!deleteResult.persisted?.r2) {
          console.warn("[DELETE-UI] Filesystem visibility tombstone not written");
        }
      } catch (error) {
        console.error("[DELETE-UI] Network error during deletion:", error);

        // ROLLBACK: Re-add message if network error occurred
        setMessages((prev) => {
          if (prev.some((m) => m.id === messageId)) {
            return prev;
          }
          const restored = [...prev, messageToDelete];
          restored.sort((a, b) => a.timestamp - b.timestamp);
          return restored;
        });

        toast.error(
          scope === "everyone"
            ? "Network error - message delete for both failed and was restored"
            : "Network error - message has been restored",
        );
        deletedMessageIdsRef.current.delete(messageId);
        if (messageToDelete.serverUUID) {
          deletedServerMessageIdsRef.current.delete(messageToDelete.serverUUID);
        }
        console.error("[DELETE-UI] ✗ Network error, message restored");
      }

    } finally {
      setIsDeletingMessageId(null);
    }
  };

  const blockStateNotice = directBlockStatus.isMutual
    ? "Messaging disabled due to mutual block. Unblock to resume messaging."
    : directBlockStatus.blockedByMe
      ? "You've blocked this user. Unblock to send a message."
      : directBlockStatus.blockedMe
        ? "You've been blocked by this user. You cannot send messages."
        : "";

  return (
    <Layout
      showBack={true}
      showDesktopPersistentHeader={true}
      onBackClick={() => navigate("/")}
      showProfileMenu={true}
      onSearchClick={() => navigate("/", { state: { openSearchModal: true } })}
    >
      <div className="flex h-full min-h-0 bg-background">
        <ConversationSidebar
          conversations={conversations}
          requests={requests}
          activeConversationId={recipientUsername || resolvedRecipientId}
          isConnected={isDirectoryConnected}
          isRefreshing={isDirectoryRefreshing}
          onRefresh={refreshConversations}
          onCompose={() => navigate("/")}
          className="hidden w-[360px] min-w-[360px] lg:flex"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative z-[80] border-b border-border/70 bg-card/72 px-4 py-3 backdrop-blur-xl md:px-6 md:py-4">
            <div className="flex items-center justify-between gap-3">
              <ProfileQuickActions username={recipientUsername} align="start">
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-3 rounded-3xl px-1 py-1 text-left transition hover:bg-accent/60 focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <UserAvatar
                    name={recipientName || recipientUsername || "Conversation"}
                    avatar={recipientAvatar}
                    className="h-11 w-11"
                  />
                  <div className="min-w-0">
                    <h2 className="truncate text-2xl font-black tracking-[-0.04em] text-foreground md:text-3xl">
                      {recipientName || "Conversation"}
                    </h2>
                    {recipientUsername ? (
                      <p className="truncate text-sm text-muted-foreground">
                        @{recipientUsername}
                      </p>
                    ) : (
                      <p className="truncate text-sm text-muted-foreground">
                        End-to-end encrypted conversation
                      </p>
                    )}
                  </div>
                </button>
              </ProfileQuickActions>

              <div className="flex items-center gap-2">
                <div className="relative z-[90]" ref={conversationMenuRef}>
                  <button
                    type="button"
                    onClick={() =>
                      setIsConversationMenuOpen((current) => !current)
                    }
                    className="tactical-icon-button h-10 w-10"
                    aria-label="Open chat options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>

                  {isConversationMenuOpen ? (
                    <div className="absolute right-0 top-full z-[100] mt-2 min-w-[min(15rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_20px_40px_rgba(2,6,23,0.45)]">
                      <button
                        type="button"
                        onClick={handleConversationSearch}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-accent"
                      >
                        <Search className="h-4 w-4" />
                        {isSearchOpen ? "Close Search in Chat" : "Search in Chat"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConversationDelete("self")}
                        disabled={conversationActionPending !== null}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {conversationActionPending === "self" ? (
                          <Loader size="sm" className="shrink-0" />
                        ) : (
                          <MoreVertical className="h-4 w-4" />
                        )}
                        Clear Chat for Me
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConversationDelete("mixed")}
                        disabled={conversationActionPending !== null}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-semibold text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {conversationActionPending === "mixed" ? (
                          <Loader size="sm" className="shrink-0" />
                        ) : (
                          <MoreVertical className="h-4 w-4" />
                        )}
                        Erase Chat for Both
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2.5 w-2.5 rounded-full ${
                      isConnected ? "bg-primary" : "bg-muted-foreground/50"
                    }`}
                  />
                  <span className="hidden text-sm text-muted-foreground sm:inline">
                    {isConnected ? "Connected" : "Reconnecting"}
                  </span>
                </div>
              </div>
            </div>

            {isSearchOpen ? (
              <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setActiveSearchIndex(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") {
                        return;
                      }

                      e.preventDefault();
                      goToSearchMatch(e.shiftKey ? "previous" : "next");
                    }}
                    placeholder="Search in chat"
                    className="w-full rounded-full border border-border bg-background pl-10 pr-4 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary md:text-sm"
                  />
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <button
                    type="button"
                    onClick={closeSearch}
                    className="tactical-icon-button h-9 w-9"
                    aria-label="Close chat search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <span className="min-w-[4.5rem] text-xs text-muted-foreground sm:text-sm">
                    {normalizedSearchQuery
                      ? `${searchMatches.length === 0 ? 0 : boundedSearchIndex + 1}/${searchMatches.length || 0}`
                      : isSearchLoading
                        ? "Loading..."
                        : `${messages.length}/${conversationTotal || messages.length}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => goToSearchMatch("previous")}
                    disabled={searchMatches.length === 0}
                    className="tactical-icon-button h-9 w-9"
                    aria-label="Previous search result"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => goToSearchMatch("next")}
                    disabled={searchMatches.length === 0}
                    className="tactical-icon-button h-9 w-9"
                    aria-label="Next search result"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div
            ref={scrollContainerRef}
            className="relative z-0 flex-1 space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(176,228,204,0.08),transparent_22%)] px-2 py-4 sm:px-4 md:px-6 md:py-6"
          >
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-4 text-center">
                <Loader size="lg" />
                <p className="text-muted-foreground text-sm">
                  Loading conversation...
                </p>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-border bg-secondary">
                  <svg
                    className="w-8 h-8 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                    />
                  </svg>
                </div>
                <p className="text-muted-foreground text-sm">
                  No messages yet. Send the first message to begin.
                </p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              (() => {
                const image = parseImageMessageContent(message.content);
                const gif = parseGifMessageContent(message.content);

                return (
              <div
                key={message.id}
                ref={(node) => {
                  if (node) {
                    messageElementRefs.current[message.id] = node;
                  } else {
                    delete messageElementRefs.current[message.id];
                  }
                }}
                className={`flex w-full gap-2.5 ${
                  message.isOwn ? "flex-row-reverse justify-start pl-10" : "justify-start pr-10"
                } group relative sm:gap-3 sm:px-1`}
              >
                {/* Avatar */}
                <div className="flex-shrink-0">
                  {message.isOwn ? (
                    <UserAvatar
                      name="You"
                      avatar={currentAvatar}
                      className="h-8 w-8"
                      fallbackClassName="border border-primary/35 bg-accent text-[0.65rem] font-semibold text-foreground"
                    />
                  ) : (
                    <ProfileQuickActions username={recipientUsername} align="start">
                      <button
                        type="button"
                        className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
                        aria-label={`Open profile actions for ${recipientName || recipientUsername || "user"}`}
                      >
                        <UserAvatar
                          name={recipientName || recipientUsername || "User"}
                          avatar={recipientAvatar}
                          className="h-8 w-8"
                          fallbackClassName="border border-primary/40 bg-primary/15 text-[0.65rem] font-semibold text-primary"
                        />
                      </button>
                    </ProfileQuickActions>
                  )}
                </div>

                {/* Message Bubble with Options */}
                <div
                  className={`flex max-w-[78vw] flex-col sm:max-w-xs md:max-w-md ${
                    message.isOwn ? "items-end" : "items-start"
                  } relative`}
                >
                  <div
                    className={`flex items-start gap-2 ${
                      message.isOwn ? "flex-row-reverse" : "flex-row"
                    }`}
                  >
                    <div
                      className={`rounded-2xl border px-4 py-2.5 transition-all ${
                        message.isOwn
                          ? "rounded-br-md border-primary/20 bg-primary text-primary-foreground shadow-[0_18px_36px_rgba(40,90,72,0.3)] hover:bg-primary/90"
                          : "rounded-bl-md border-border/80 bg-card text-foreground shadow-sm hover:bg-accent"
                      } ${
                        activeSearchMatch?.id === message.id
                          ? "ring-2 ring-amber-400"
                          : matchedMessageIds.has(message.id)
                            ? "ring-1 ring-amber-300/80"
                            : selectedMessageId === message.id
                              ? "ring-2 ring-yellow-500"
                              : ""
                      }`}
                    >
                      <div
                        className={`overflow-hidden ${
                          !gif &&
                          !image &&
                          isLongMessage(message.content) &&
                          !isMessageExpanded(message.id)
                            ? "max-h-[10.5rem]"
                            : ""
                        }`}
                      >
                        {image ? (
                          <ImageMessageContent
                            image={image}
                            onReady={handleEmbeddedMediaReady}
                          />
                        ) : gif ? (
                          <GifMessageContent
                            gif={gif}
                            isOwn={message.isOwn}
                            onReady={handleEmbeddedMediaReady}
                          />
                        ) : (
                          <p className="break-words text-[0.95rem] leading-6 sm:text-sm sm:leading-6">
                            {renderHighlightedContent(message.content, message.id)}
                          </p>
                        )}
                      </div>
                      {!gif && !image && isLongMessage(message.content) ? (
                        <button
                          type="button"
                          onClick={() => toggleExpandedMessage(message.id)}
                          className={`mt-2 inline-flex text-sm font-extrabold tracking-[-0.01em] ${
                            message.isOwn
                              ? "text-primary-foreground/95"
                              : "text-primary"
                          }`}
                        >
                          {isMessageExpanded(message.id)
                            ? "Read less"
                            : "Read more"}
                        </button>
                      ) : null}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setSelectedMessageId(
                          selectedMessageId === message.id ? null : message.id,
                        )
                      }
                      className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition hover:text-foreground"
                      aria-label="Open message actions"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Message Options Menu */}
                  {selectedMessageId === message.id && (
                    <div
                      className={`absolute ${
                        message.isOwn ? "right-0" : "left-0"
                      } top-full z-40 mt-2 max-w-[calc(100vw-2rem)] min-w-max rounded-2xl border border-border/70 bg-card shadow-[0_20px_40px_rgba(2,6,23,0.45)]`}
                    >
                      <button
                        onClick={() => handleDeleteMessage(message.id)}
                        disabled={isDeletingMessageId === message.id}
                        className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors first:rounded-t-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {isDeletingMessageId === message.id ? (
                          <>
                            <Loader size="sm" className="shrink-0" />
                            Removing...
                          </>
                        ) : (
                          <>
                            <svg
                              className="h-4 w-4"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                            Delete for me
                          </>
                        )}
                      </button>
                      {message.isOwn ? (
                        <button
                          onClick={() =>
                            handleDeleteMessage(message.id, "everyone")
                          }
                          disabled={isDeletingMessageId === message.id}
                          className="w-full px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors last:rounded-b-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                          {isDeletingMessageId === message.id ? (
                            <>
                              <Loader size="sm" className="shrink-0" />
                              Removing...
                            </>
                          ) : (
                            <>
                              <svg
                                className="h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                              Delete permanently for both
                            </>
                          )}
                        </button>
                      ) : null}
                    </div>
                  )}

                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {formatMessageTimestamp(message.timestamp)}
                    </span>
                    {message.isOwn && message.status && (
                      <span className="inline-flex items-center text-muted-foreground">
                        {renderMessageStatus(message.status, message.isOwn)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
                );
              })()
            ))
          )}
          <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-border/70 bg-card/82 px-3 py-3 backdrop-blur-xl sm:px-4 md:px-6 md:py-4">
            {!directBlockStatus.canSend ? (
              <div className="border border-border/70 bg-background/60 px-4 py-4">
                <p className="text-sm font-semibold text-foreground">{blockStateNotice}</p>
                {directBlockStatus.blockedByMe || directBlockStatus.isMutual ? (
                  <button
                    type="button"
                    onClick={unblockCurrentUser}
                    className="mt-3 border border-border px-4 py-2 text-sm font-bold text-foreground transition hover:bg-accent"
                  >
                    Unblock
                  </button>
                ) : null}
              </div>
            ) : (
              <form onSubmit={handleSendMessage} className="flex items-end gap-2">
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/avif"
                  className="hidden"
                  onChange={(event) => {
                    void handleImageFileChange(event);
                  }}
                />
                <button
                  type="button"
                  aria-label="Send image"
                  disabled={isSending || isLoading || isUploadingImage}
                  onClick={() => imageInputRef.current?.click()}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-[linear-gradient(135deg,rgba(21,55,50,0.95),rgba(8,24,22,0.95))] text-[#cde8db] shadow-[0_14px_32px_rgba(6,18,17,0.28)] transition hover:border-primary/40 hover:bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] disabled:opacity-50"
                >
                  {isUploadingImage ? (
                    <Loader size="sm" />
                  ) : (
                    <ImagePlus className="h-5 w-5" />
                  )}
                </button>
                <GifPicker
                  disabled={isSending || isLoading || isUploadingImage}
                  onSelect={handleGifSelect}
                />
                <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label="Open emoji picker"
                      disabled={isSending || isLoading || isUploadingImage}
                      className="hidden h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-[linear-gradient(135deg,rgba(21,55,50,0.95),rgba(8,24,22,0.95))] text-[#cde8db] shadow-[0_14px_32px_rgba(6,18,17,0.28)] transition hover:border-primary/40 hover:bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] disabled:opacity-50 md:inline-flex"
                    >
                      <Smile className="h-5 w-5" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    sideOffset={12}
                    className="hidden w-auto rounded-[1.5rem] border-border/70 bg-card/95 p-0 shadow-[0_24px_60px_rgba(2,6,23,0.45)] backdrop-blur-xl md:block"
                  >
                    <EmojiPicker
                      onEmojiClick={handleEmojiSelect}
                      autoFocusSearch={false}
                      emojiStyle={EmojiStyle.NATIVE}
                      lazyLoadEmojis={true}
                      previewConfig={{ showPreview: false }}
                      searchDisabled={false}
                      skinTonesDisabled={false}
                      theme={Theme.AUTO}
                      width={340}
                      height={420}
                    />
                  </PopoverContent>
                </Popover>
                <input
                  ref={messageInputRef}
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="Message"
                  disabled={isSending || isLoading || isUploadingImage}
                  className="tactical-input min-w-0 flex-1 rounded-full border px-4 py-3 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isSending || isLoading || isUploadingImage || !messageInput.trim()}
                  className="tactical-icon-button-primary h-11 w-11"
                >
                  {isSending ? (
                    <Loader size="sm" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </button>
              </form>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Messages are secured with end-to-end encryption.
            </p>
          </div>
        </div>
      </div>
    </Layout>
  );
}
