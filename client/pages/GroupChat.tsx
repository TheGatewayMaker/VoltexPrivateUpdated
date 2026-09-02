import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Check,
  CheckCheck,
  Info,
  ImagePlus,
  LogOut,
  MessageCircle,
  MoreVertical,
  Pin,
  Send,
  Settings,
  Smile,
  UserRound,
  UserPlus,
  Users,
} from "lucide-react";
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";
import Layout from "@/components/Layout";
import ConversationSidebar from "@/components/ConversationSidebar";
import GifMessageContent from "@/components/GifMessageContent";
import GifPicker from "@/components/GifPicker";
import ImageMessageContent from "@/components/ImageMessageContent";
import { UserAvatar } from "@/components/UserAvatar";
import AvatarCropDialog from "@/components/AvatarCropDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader } from "@/components/ui/loader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConversationDirectory } from "@/hooks/useConversationDirectory";
import {
  encryptMessage,
  decryptMessage,
  getStoredKeyPair,
  waitForStoredKeyPair,
} from "@/lib/crypto";
import { buildGifMessageContent, KlipyGifItem, parseGifMessageContent } from "@/lib/gifMessages";
import { buildImageMessageContent, parseImageMessageContent } from "@/lib/imageMessages";
import { uploadGroupImage } from "@/lib/imageUpload";
import { useWebSocket } from "@/lib/useWebSocket";
import { formatMessageTimestamp } from "@/lib/dateFormatter";
import { EncryptedMessage } from "@shared/crypto";
import { GroupMessageReceiptSummary } from "@shared/groups";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

interface GroupMember {
  userId: string;
  role: "admin" | "member";
  status: "active" | "left" | "removed";
  joinedAt: number;
  username: string;
  displayName: string;
  avatar: string | null;
  publicKey: string;
  signPublicKey: string;
}

interface GroupDetails {
  id: string;
  name: string;
  bio: string;
  avatar: string | null;
  createdBy: string;
  members: GroupMember[];
}

interface GroupMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar: string | null;
  content: string;
  timestamp: number;
  isOwn: boolean;
  receipt?: GroupMessageReceiptSummary;
}

interface GroupEncryptedMessagePayload {
  id?: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  senderId: string;
  recipientId: string;
  timestamp: number;
}

interface SearchResult {
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
}

interface PendingGroupAction {
  type: "assign-admin" | "transfer-owner" | "remove-member";
  userId: string;
  displayName: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

export default function GroupChat() {
  const { id: groupId } = useParams<{ id: string }>();
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
    isConnected: isDirectoryConnected,
    isRefreshing: isDirectoryRefreshing,
    refreshConversations,
  } = useConversationDirectory();

  const [currentUserId, setCurrentUserId] = useState("");
  const [group, setGroup] = useState<GroupDetails | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [pinnedMessage, setPinnedMessage] = useState<GroupMessage | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteSuggestions, setInviteSuggestions] = useState<SearchResult[]>([]);
  const [isSearchingInviteUsers, setIsSearchingInviteUsers] = useState(false);
  const [inviteSearchError, setInviteSearchError] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [cropImageType, setCropImageType] = useState<"image/jpeg" | "image/png" | null>(null);
  const [isCropOpen, setIsCropOpen] = useState(false);
  const [pendingGroupAction, setPendingGroupAction] =
    useState<PendingGroupAction | null>(null);
  const [isConfirmingGroupAction, setIsConfirmingGroupAction] = useState(false);
  const [isDeleteGroupDialogOpen, setIsDeleteGroupDialogOpen] = useState(false);
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const inviteSearchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const pendingReceiptUpdatesRef = useRef<
    Map<string, GroupMessageReceiptSummary>
  >(new Map());
  const groupRecoveryAttemptsRef = useRef<number>(0);
  const shouldStickToBottomRef = useRef(true);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior | null>("auto");
  const lastLoadedGroupMessageTimestampRef = useRef<number>(0);
  const hasLoadedGroupOnceRef = useRef(false);
  const scrollLockUntilRef = useRef(0);

  useEffect(() => {
    groupRecoveryAttemptsRef.current = 0;
    shouldStickToBottomRef.current = true;
    pendingScrollBehaviorRef.current = "auto";
    lastLoadedGroupMessageTimestampRef.current = 0;
    hasLoadedGroupOnceRef.current = false;
    scrollLockUntilRef.current = Date.now() + 2500;
  }, [groupId]);

  const activeMembers = useMemo(
    () => (group?.members || []).filter((member) => member.status === "active"),
    [group],
  );
  const currentMember = useMemo(
    () => activeMembers.find((member) => member.userId === currentUserId) || null,
    [activeMembers, currentUserId],
  );
  const isAdmin = currentMember?.role === "admin";
  const isOwner = !!group && group.createdBy === currentUserId;

  const openMemberProfile = useCallback(
    (member: GroupMember) => {
      const normalizedUsername = normalizeUsername(member.username || "");
      if (!normalizedUsername) {
        toast.error("Profile is unavailable for this member");
        return;
      }

      navigate(`/${normalizedUsername}/profile`);
    },
    [navigate],
  );

  const openDirectMessage = useCallback(
    (member: GroupMember) => {
      if (member.userId === currentUserId) {
        toast.error("You cannot direct message yourself");
        return;
      }

      const normalizedUsername = normalizeUsername(member.username || "");
      if (!normalizedUsername) {
        toast.error("Direct message is unavailable for this member");
        return;
      }

      navigate(`/chat/${normalizedUsername}`);
    },
    [currentUserId, navigate],
  );

  const memberMap = useMemo(() => {
    return new Map(activeMembers.map((member) => [member.userId, member]));
  }, [activeMembers]);

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

  const syncGroupRead = useCallback(async () => {
    if (!groupId) {
      return;
    }
    const sessionToken = await getRestoredSessionToken();
    if (!sessionToken || document.visibilityState === "hidden") {
      return;
    }

    try {
      await fetch(`/api/groups/${groupId}/read`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
    } catch (error) {
      console.error("Failed to sync group read state:", error);
    }
  }, [getRestoredSessionToken, groupId]);

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
    if (!behavior || isLoading) {
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
  }, [messages, isLoading]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoading) {
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
  }, [messages, isLoading]);

  const handleEmbeddedMediaReady = useCallback(() => {
    if (
      shouldStickToBottomRef.current ||
      Date.now() < scrollLockUntilRef.current
    ) {
      scrollLockUntilRef.current = Date.now() + 1200;
      forceScrollToBottom("auto");
    }
  }, [forceScrollToBottom]);

  const loadGroup = useCallback(async (options?: { silent?: boolean }) => {
    if (!groupId) {
      return;
    }
    const sessionToken = await getRestoredSessionToken();
    if (!sessionToken) {
      navigate("/signin");
      return;
    }

    const isSilent = options?.silent === true;
    const shouldAutoScrollAfterRefresh =
      isSilent && shouldStickToBottomRef.current;

    if (!isSilent) {
      setIsLoading(true);
    }
    try {
      const meResponse = await fetch("/api/profile/me", {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (meResponse.status === 401) {
        toast.error("Session expired - please sign in again");
        void browserStorage.clear();
        navigate("/signin");
        return;
      }
      if (!meResponse.ok) {
        throw new Error("Failed to load account");
      }
      const me = await meResponse.json();
      setCurrentUserId(String(me.userId || ""));

      const response = await fetch(`/api/groups/${groupId}/messages?limit=100&offset=0&anchor=latest`, {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to load group");
      }
      const data = await response.json();
      const groupData = data.group as GroupDetails;
      setGroup(groupData);
      setEditName(groupData.name || "");
      setEditBio(groupData.bio || "");
      setEditAvatar(groupData.avatar || null);

      const keyPair = (await waitForStoredKeyPair(3000)) || getStoredKeyPair();
      if (!keyPair) {
        throw new Error("Encryption keys are unavailable on this device");
      }

      const decryptedMessages: GroupMessage[] = [];
      for (const encryptedMessage of data.messages || []) {
        const sender = (groupData.members || []).find(
          (member: GroupMember) => member.userId === encryptedMessage.senderId,
        );
        if (!sender) {
          continue;
        }
        const decrypted = decryptMessage(
          encryptedMessage as EncryptedMessage,
          sender.publicKey,
          keyPair.privateKeyBase64,
          sender.signPublicKey || sender.publicKey,
        );
        if (!decrypted) {
          continue;
        }
        decryptedMessages.push({
          id: String(encryptedMessage.id || `${encryptedMessage.timestamp}-${encryptedMessage.senderId}`),
          senderId: encryptedMessage.senderId,
          senderName: sender.displayName || sender.username || "User",
          senderAvatar: sender.avatar || null,
          content: decrypted.content,
          timestamp: Number(encryptedMessage.timestamp),
          isOwn: encryptedMessage.senderId === me.userId,
          receipt: encryptedMessage.receipt,
        });
      }

      const sortedMessages = decryptedMessages.sort((a, b) => a.timestamp - b.timestamp);
      const nextLatestTimestamp =
        sortedMessages.length > 0
          ? sortedMessages[sortedMessages.length - 1]!.timestamp
          : 0;
      const hasNewerMessages =
        nextLatestTimestamp > lastLoadedGroupMessageTimestampRef.current;

      if (!isSilent || (shouldAutoScrollAfterRefresh && hasNewerMessages)) {
        requestScrollToBottom(!isSilent ? "auto" : "smooth");
      }

      setMessages(sortedMessages);
      lastLoadedGroupMessageTimestampRef.current = nextLatestTimestamp;
      hasLoadedGroupOnceRef.current = true;
      const encryptedPinned = (data.pinnedMessage || null) as GroupEncryptedMessagePayload | null;
      if (encryptedPinned) {
        const sender = (groupData.members || []).find(
          (member: GroupMember) => member.userId === encryptedPinned.senderId,
        );
        if (sender) {
          const decryptedPinned = decryptMessage(
            encryptedPinned as EncryptedMessage,
            sender.publicKey,
            keyPair.privateKeyBase64,
            sender.signPublicKey || sender.publicKey,
          );
          if (decryptedPinned) {
            setPinnedMessage({
              id: String(encryptedPinned.id || `${encryptedPinned.timestamp}-${encryptedPinned.senderId}`),
              senderId: encryptedPinned.senderId,
              senderName: sender.displayName || sender.username || "User",
              senderAvatar: sender.avatar || null,
              content: decryptedPinned.content,
              timestamp: Number(encryptedPinned.timestamp),
              isOwn: encryptedPinned.senderId === me.userId,
            });
          } else {
            setPinnedMessage(null);
          }
        } else {
          setPinnedMessage(null);
        }
      } else {
        setPinnedMessage(null);
      }

      await fetch(`/api/groups/${groupId}/read`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
    } catch (error) {
      console.error("Failed to load group:", error);
      if (groupRecoveryAttemptsRef.current < 2) {
        groupRecoveryAttemptsRef.current += 1;
        try {
          await browserStorage.reinitializeBrowserStorage();
          await loadGroup();
          return;
        } catch (recoveryError) {
          console.error("Group recovery attempt failed:", recoveryError);
        }
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Restoring group conversation. Please wait a moment.",
      );
    } finally {
      if (!isSilent) {
        setIsLoading(false);
      }
    }
  }, [getRestoredSessionToken, groupId, navigate, requestScrollToBottom]);

  const appendEncryptedGroupMessage = useCallback(
    (incomingGroupId: string, encryptedMessage: EncryptedMessage & { id?: string }) => {
      if (!group || incomingGroupId !== group.id) {
        return;
      }
      const sender = memberMap.get(encryptedMessage.senderId);
      const keyPair = getStoredKeyPair();
      if (!sender || !keyPair) {
        return;
      }
      const decrypted = decryptMessage(
        encryptedMessage,
        sender.publicKey,
        keyPair.privateKeyBase64,
        sender.signPublicKey || sender.publicKey,
      );
      if (!decrypted) {
        return;
      }
      setMessages((prev) => {
        const nextId = String(encryptedMessage.id || `${encryptedMessage.timestamp}-${encryptedMessage.senderId}`);
        if (prev.some((message) => message.id === nextId)) {
          return prev;
        }
        if (shouldStickToBottomRef.current) {
          requestScrollToBottom("smooth");
        }
        return [
          ...prev,
          {
            id: nextId,
            senderId: encryptedMessage.senderId,
            senderName: sender.displayName || sender.username || "User",
            senderAvatar: sender.avatar || null,
            content: decrypted.content,
            timestamp: Number(encryptedMessage.timestamp),
            isOwn: encryptedMessage.senderId === currentUserId,
          },
        ].sort((a, b) => a.timestamp - b.timestamp);
      });
      void syncGroupRead();
      void refreshConversations();
    },
    [currentUserId, group, memberMap, refreshConversations, syncGroupRead],
  );

  const handleGroupMessageDeleted = useCallback(
    (incomingGroupId: string, messageId: string) => {
      if (incomingGroupId !== groupId) {
        return;
      }
      setMessages((prev) => prev.filter((message) => message.id !== messageId));
    },
    [groupId],
  );

  const handleGroupMessageStatus = useCallback(
    (
      incomingGroupId: string,
      messageId: string,
      receipt: Record<string, unknown>,
    ) => {
      if (incomingGroupId !== groupId) {
        return;
      }

      const normalizedReceipt = receipt as unknown as GroupMessageReceiptSummary;
      let matched = false;

      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          matched = true;
          return {
            ...message,
            receipt: normalizedReceipt,
          };
        }),
      );

      if (!matched) {
        pendingReceiptUpdatesRef.current.set(messageId, normalizedReceipt);
      }
    },
    [groupId],
  );

  const handleGroupUpdated = useCallback(
    (incomingGroup: Record<string, unknown>) => {
      if (String(incomingGroup.id || "") !== groupId) {
        return;
      }
      const typedGroup = incomingGroup as unknown as GroupDetails;
      setGroup(typedGroup);
      setEditName(typedGroup.name || "");
      setEditBio(typedGroup.bio || "");
      setEditAvatar(typedGroup.avatar || null);
    },
    [groupId],
  );

  const handleGroupPinUpdated = useCallback(
    (
      incomingGroupId: string,
      incomingPinnedMessage: Record<string, unknown> | null,
    ) => {
      if (!group || incomingGroupId !== group.id) {
        return;
      }
      if (!incomingPinnedMessage) {
        setPinnedMessage(null);
        return;
      }

      const keyPair = getStoredKeyPair();
      if (!keyPair) {
        return;
      }
      const senderId = String(incomingPinnedMessage.senderId || "");
      const sender = memberMap.get(senderId);
      if (!sender) {
        return;
      }

      const encryptedPinned = incomingPinnedMessage as unknown as EncryptedMessage & {
        id?: string;
      };
      const decryptedPinned = decryptMessage(
        encryptedPinned,
        sender.publicKey,
        keyPair.privateKeyBase64,
        sender.signPublicKey || sender.publicKey,
      );
      if (!decryptedPinned) {
        return;
      }

      setPinnedMessage({
        id: String(encryptedPinned.id || `${encryptedPinned.timestamp}-${encryptedPinned.senderId}`),
        senderId: encryptedPinned.senderId,
        senderName: sender.displayName || sender.username || "User",
        senderAvatar: sender.avatar || null,
        content: decryptedPinned.content,
        timestamp: Number(encryptedPinned.timestamp),
        isOwn: encryptedPinned.senderId === currentUserId,
      });
    },
    [currentUserId, group, memberMap],
  );

  const handleGroupRemoved = useCallback(
    (removedGroupId: string, reason?: string) => {
      if (removedGroupId !== groupId) {
        return;
      }
      if (reason === "removed") {
        toast.info("You were removed from the group");
      } else if (reason === "deleted") {
        toast.info("This group was deleted");
      } else {
        toast.info("You left the group");
      }
      navigate("/");
    },
    [groupId, navigate],
  );

  const { isConnected } = useWebSocket({
    onGroupMessage: appendEncryptedGroupMessage,
    onGroupMessageDeleted: handleGroupMessageDeleted,
    onGroupMessageStatus: handleGroupMessageStatus,
    onGroupUpdated: handleGroupUpdated,
    onGroupPinUpdated: handleGroupPinUpdated,
    onGroupRemoved: handleGroupRemoved,
    onGroupInvite: () => {
      void refreshConversations();
    },
    onGroupInviteRemoved: () => {
      void refreshConversations();
    },
  });

  useEffect(() => {
    if (!groupId) {
      return;
    }
    void loadGroup({ silent: hasLoadedGroupOnceRef.current });
    pollRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadGroup({ silent: true });
      }
    }, isConnected ? 12000 : 3500);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, [groupId, isConnected, loadGroup]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void syncGroupRead();
      }
    };

    const onFocus = () => {
      void syncGroupRead();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [syncGroupRead]);

  const refocusMessageComposer = useCallback(() => {
    window.setTimeout(() => {
      const input = messageInputRef.current;
      if (!input) {
        return;
      }

      input.focus({ preventScroll: true });
    }, 0);
  }, []);

  const sendGroupMessageContent = async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content || !group || !currentUserId) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    const keyPair = getStoredKeyPair();
    if (!sessionToken || !keyPair) {
      toast.error("Session or keys are unavailable");
      return;
    }

    const localId = `local-${Date.now()}`;
    requestScrollToBottom("smooth");
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        senderId: currentUserId,
        senderName: currentMember?.displayName || "You",
        senderAvatar: currentMember?.avatar || null,
        content,
        timestamp: Date.now(),
        isOwn: true,
      },
    ]);
    setMessageInput("");
    refocusMessageComposer();
    setIsSending(true);

    try {
      const envelopes = Object.fromEntries(
        activeMembers.map((member) => {
          const encrypted = encryptMessage(
            content,
            member.publicKey,
            keyPair.privateKeyBase64,
            keyPair.signPrivateKeyBase64,
          );
          return [
            member.userId,
            {
              nonce: encrypted.nonce,
              ciphertext: encrypted.ciphertext,
              signature: encrypted.signature,
              recipientId: member.userId,
              timestamp: encrypted.timestamp,
            },
          ];
        }),
      );

      const response = await fetch(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          timestamp: Date.now(),
          envelopes,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to send group message");
      }

      const data = await response.json();
      setMessages((prev) =>
        prev.map((message) =>
          message.id === localId
            ? (() => {
                const serverMessageId = String(data.messageId || localId);
                const pendingReceipt =
                  pendingReceiptUpdatesRef.current.get(serverMessageId);
                if (pendingReceipt) {
                  pendingReceiptUpdatesRef.current.delete(serverMessageId);
                }

                return {
                  ...message,
                  id: serverMessageId,
                  timestamp: Number(data.timestamp || message.timestamp),
                  receipt:
                    pendingReceipt ||
                    (data.receipt as GroupMessageReceiptSummary),
                };
              })()
            : message,
        ),
      );
      await fetch(`/api/groups/${group.id}/read`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      void refreshConversations();
    } catch (error) {
      setMessages((prev) => prev.filter((message) => message.id !== localId));
      toast.error(error instanceof Error ? error.message : "Failed to send group message");
    } finally {
      setIsSending(false);
      refocusMessageComposer();
    }
  };

  const handleSendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    await sendGroupMessageContent(messageInput);
  };

  const handleGifSelect = useCallback(
    async (gif: KlipyGifItem, type: "gif" | "sticker") => {
      await sendGroupMessageContent(buildGifMessageContent(gif, type));
    },
    [sendGroupMessageContent],
  );

  const handleImageFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file || !group?.id) {
        return;
      }

      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        toast.error("Session expired. Sign in again and retry.");
        return;
      }

      try {
        setIsUploadingImage(true);
        const uploaded = await uploadGroupImage(group.id, file, sessionToken);
        await sendGroupMessageContent(buildImageMessageContent(uploaded));
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to send image",
        );
      } finally {
        setIsUploadingImage(false);
      }
    },
    [group?.id, sendGroupMessageContent],
  );

  const handleDeleteMessage = async (messageId: string, scope: "self" | "everyone") => {
    if (!group) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }
    const existing = messages.find((message) => message.id === messageId);
    if (!existing) {
      return;
    }

    setMessages((prev) => prev.filter((message) => message.id !== messageId));
    setSelectedMessageId(null);

    try {
      const response = await fetch(`/api/groups/${group.id}/messages/${messageId}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ scope }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to delete group message");
      }
    } catch (error) {
      setMessages((prev) => [...prev, existing].sort((a, b) => a.timestamp - b.timestamp));
      toast.error(error instanceof Error ? error.message : "Failed to delete group message");
    }
  };

  const handlePinMessage = async (messageId: string) => {
    if (!group || !isAdmin) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }

    try {
      const response = await fetch(`/api/groups/${group.id}/pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ messageId }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to pin message");
      }
      setSelectedMessageId(null);
      toast.success("Message pinned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin message");
    }
  };

  const inviteUser = async () => {
    if (!group || !inviteUsername.trim()) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }

    try {
      const response = await fetch(`/api/groups/${group.id}/invites`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ username: inviteUsername.trim() }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to send invite");
      }
      setInviteUsername("");
      setInviteSuggestions([]);
      setIsInviteOpen(false);
      toast.success("Invite sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send invite");
    }
  };

  useEffect(() => {
    if (!isInviteOpen) {
      setInviteSuggestions([]);
      setInviteSearchError("");
      setIsSearchingInviteUsers(false);
      if (inviteSearchDebounceRef.current) {
        clearTimeout(inviteSearchDebounceRef.current);
        inviteSearchDebounceRef.current = null;
      }
      return;
    }

    const normalizedQuery = inviteUsername.trim();
    if (!normalizedQuery) {
      setInviteSuggestions([]);
      setInviteSearchError("");
      setIsSearchingInviteUsers(false);
      if (inviteSearchDebounceRef.current) {
        clearTimeout(inviteSearchDebounceRef.current);
        inviteSearchDebounceRef.current = null;
      }
      return;
    }

    if (inviteSearchDebounceRef.current) {
      clearTimeout(inviteSearchDebounceRef.current);
      inviteSearchDebounceRef.current = null;
    }

    inviteSearchDebounceRef.current = setTimeout(async () => {
      const sessionToken = browserStorage.getItem("session_token");
      if (!sessionToken) {
        return;
      }

      setIsSearchingInviteUsers(true);
      setInviteSearchError("");
      try {
        const response = await fetch("/api/users/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ query: normalizedQuery }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "Failed to search users");
        }

        const data = await response.json();
        const memberUsernames = new Set(
          activeMembers.map((member) => member.username.toLowerCase()).filter(Boolean),
        );
        const results = (Array.isArray(data.results) ? data.results : []).filter(
          (result: SearchResult) =>
            !memberUsernames.has((result.username || "").toLowerCase()),
        );
        setInviteSuggestions(results);
      } catch (error) {
        setInviteSuggestions([]);
        setInviteSearchError(
          error instanceof Error ? error.message : "Failed to search users",
        );
      } finally {
        setIsSearchingInviteUsers(false);
      }
    }, 180);

    return () => {
      if (inviteSearchDebounceRef.current) {
        clearTimeout(inviteSearchDebounceRef.current);
        inviteSearchDebounceRef.current = null;
      }
    };
  }, [activeMembers, inviteUsername, isInviteOpen]);

  const saveSettings = async () => {
    if (!group) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }

    try {
      const response = await fetch(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          name: editName,
          bio: editBio,
          avatar: editAvatar,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to save group settings");
      }
      const data = await response.json();
      setGroup(data.group);
      setIsSettingsOpen(false);
      toast.success("Group updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save group settings");
    }
  };

  const updateAdmin = async (userId: string, action: "assign" | "revoke" | "transfer") => {
    if (!group) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }
    try {
      const response = await fetch(`/api/groups/${group.id}/admins`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ userId, action }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to update admin");
      }
      const data = await response.json();
      setGroup(data.group);
      toast.success("Admin settings updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update admin");
    }
  };

  const removeMember = async (userId: string) => {
    if (!group) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }
    try {
      const response = await fetch(`/api/groups/${group.id}/members/${userId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to remove member");
      }
      const data = await response.json();
      setGroup(data.group);
      toast.success("Member removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove member");
    }
  };

  const confirmPendingGroupAction = async () => {
    if (!pendingGroupAction) {
      return;
    }

    setIsConfirmingGroupAction(true);
    try {
      if (pendingGroupAction.type === "assign-admin") {
        await updateAdmin(pendingGroupAction.userId, "assign");
      } else if (pendingGroupAction.type === "transfer-owner") {
        await updateAdmin(pendingGroupAction.userId, "transfer");
      } else {
        await removeMember(pendingGroupAction.userId);
      }
      setPendingGroupAction(null);
    } finally {
      setIsConfirmingGroupAction(false);
    }
  };

  const leaveGroup = async () => {
    if (!group || !window.confirm("Leave this group?")) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }
    try {
      const response = await fetch(`/api/groups/${group.id}/leave`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to leave group");
      }
      navigate("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to leave group");
    }
  };

  const deleteGroupForEveryone = async () => {
    if (!group || !isOwner) {
      return;
    }
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken) {
      return;
    }

    setIsDeletingGroup(true);
    try {
      const response = await fetch(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to delete group");
      }

      setIsDeleteGroupDialogOpen(false);
      setIsSettingsOpen(false);
      await refreshConversations();
      toast.success("Group deleted");
      navigate("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete group");
    } finally {
      setIsDeletingGroup(false);
    }
  };

  const onAvatarFileChange = async (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    setCropImageUrl(objectUrl);
    setCropImageType(file.type === "image/png" ? "image/png" : "image/jpeg");
    setIsCropOpen(true);
  };

  const menuItems = [
    isAdmin
      ? {
          label: "Invite member",
          icon: <UserPlus className="h-4 w-4" />,
          onClick: () => {
            setIsInviteOpen(true);
            setIsMenuOpen(false);
          },
        }
      : null,
    isAdmin
      ? {
          label: "Group settings",
          icon: <Settings className="h-4 w-4" />,
          onClick: () => {
            setIsSettingsOpen(true);
            setIsMenuOpen(false);
          },
        }
      : null,
    {
      label: "Leave group",
      icon: <LogOut className="h-4 w-4" />,
      onClick: () => {
        setIsMenuOpen(false);
        void leaveGroup();
      },
    },
  ].filter(Boolean) as Array<{ label: string; icon: JSX.Element; onClick: () => void }>;

  const pendingActionCopy = useMemo(() => {
    if (!pendingGroupAction) {
      return null;
    }

    if (pendingGroupAction.type === "assign-admin") {
      return {
        title: "Promote Member To Admin?",
        description: `Confirm promoting ${pendingGroupAction.displayName} to admin. They will gain group management permissions.`,
        confirmLabel: "Confirm Promotion",
      };
    }

    if (pendingGroupAction.type === "transfer-owner") {
      return {
        title: "Transfer Group Ownership?",
        description: `Confirm transferring ownership and primary admin control to ${pendingGroupAction.displayName}. Your role will be downgraded to member.`,
        confirmLabel: "Confirm Transfer",
      };
    }

    return {
      title: "Remove Member From Group?",
      description: `Confirm removing ${pendingGroupAction.displayName} from this group. They will immediately lose access to the group chat.`,
      confirmLabel: "Confirm Removal",
    };
  }, [pendingGroupAction]);

  const renderGroupReceipt = useCallback((receipt?: GroupMessageReceiptSummary) => {
    if (!receipt) {
      return <Check className="h-3.5 w-3.5 stroke-[2.25]" />;
    }

    if (receipt.seenByAll) {
      return <CheckCheck className="h-3.5 w-3.5 stroke-[2.25] text-primary" />;
    }

    if (receipt.seenByAny) {
      return <Check className="h-3.5 w-3.5 stroke-[2.25] text-primary" />;
    }

    if (receipt.deliveredToAll) {
      return <CheckCheck className="h-3.5 w-3.5 stroke-[2.25]" />;
    }

    return <Check className="h-3.5 w-3.5 stroke-[2.25]" />;
  }, []);

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
          activeConversationId={groupId}
          isConnected={isDirectoryConnected}
          isRefreshing={isDirectoryRefreshing}
          onRefresh={refreshConversations}
          onCompose={() => navigate("/")}
          className="hidden w-[360px] min-w-[360px] lg:flex"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border/70 bg-card/72 px-4 py-3 backdrop-blur-xl md:px-6 md:py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar name={group?.name || "Group"} avatar={group?.avatar} className="h-11 w-11" />
                <div className="min-w-0">
                  <h2 className="truncate text-2xl font-black tracking-[-0.04em] text-foreground md:text-3xl">
                    {group?.name || "Group"}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {activeMembers.length} members
                  </p>
                </div>
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsMenuOpen((current) => !current)}
                  className="tactical-icon-button h-10 w-10"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
                {isMenuOpen ? (
                  <div className="absolute right-0 top-full z-50 mt-2 min-w-[220px] rounded-2xl border border-border/70 bg-card shadow-[0_20px_40px_rgba(2,6,23,0.45)]">
                    {menuItems.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.onClick}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-foreground transition hover:bg-accent"
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div
            ref={scrollContainerRef}
            className="flex-1 space-y-4 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(176,228,204,0.08),transparent_22%)] px-2 py-4 sm:px-4 md:px-6 md:py-6"
          >
            {pinnedMessage ? (
              <div className="sticky top-0 z-20 rounded-2xl border border-primary/30 bg-card/95 px-3 py-2.5 shadow-sm backdrop-blur md:px-4">
                <div className="flex items-start gap-2">
                  <Pin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-primary">
                      Pinned by admin
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {pinnedMessage.senderName} • {formatMessageTimestamp(pinnedMessage.timestamp)}
                    </p>
                    <p className="truncate text-sm text-foreground">
                      {pinnedMessage.content}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader size="lg" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                No messages yet. Send the first message to start the group conversation.
              </div>
            ) : (
              messages.map((message) => (
                (() => {
                  const image = parseImageMessageContent(message.content);
                  const gif = parseGifMessageContent(message.content);

                  return (
                <div
                  key={message.id}
                  className={`flex gap-3 ${message.isOwn ? "justify-end" : "justify-start"}`}
                >
                  {!message.isOwn ? (
                    <UserAvatar name={message.senderName} avatar={message.senderAvatar} className="h-8 w-8" />
                  ) : null}
                  <div className={`max-w-[78vw] sm:max-w-md ${message.isOwn ? "items-end" : "items-start"} flex flex-col`}>
                    {!message.isOwn ? (
                      <span className="mb-1 text-xs font-semibold text-muted-foreground">
                        {message.senderName}
                      </span>
                    ) : null}
                    <div className="flex items-start gap-2">
                      <div
                        className={`rounded-2xl border px-4 py-2.5 ${
                          message.isOwn
                            ? "rounded-br-md border-primary/20 bg-primary text-primary-foreground"
                            : "rounded-bl-md border-border/80 bg-card text-foreground"
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
                          <p className="break-words text-sm leading-6">{message.content}</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedMessageId((current) => (current === message.id ? null : message.id))}
                        className="mt-1 inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition hover:text-foreground"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </div>
                    {selectedMessageId === message.id ? (
                      <div className={`mt-2 min-w-[180px] rounded-2xl border border-border/70 bg-card shadow-xl ${message.isOwn ? "self-end" : "self-start"}`}>
                        <button
                          type="button"
                          onClick={() => void handleDeleteMessage(message.id, "self")}
                          className="block w-full px-4 py-3 text-left text-sm text-foreground transition hover:bg-accent"
                        >
                          Delete for me
                        </button>
                        {message.isOwn ? (
                          <button
                            type="button"
                            onClick={() => void handleDeleteMessage(message.id, "everyone")}
                            className="block w-full px-4 py-3 text-left text-sm text-destructive transition hover:bg-destructive/10"
                          >
                            Delete for everyone
                          </button>
                        ) : null}
                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => void handlePinMessage(message.id)}
                            className="block w-full px-4 py-3 text-left text-sm text-foreground transition hover:bg-accent"
                          >
                            Pin message
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <span className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{formatMessageTimestamp(message.timestamp)}</span>
                      {message.isOwn ? (
                        <span className="inline-flex items-center">
                          {renderGroupReceipt(message.receipt)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </div>
                  );
                })()
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-border/70 bg-card/82 px-3 py-3 backdrop-blur-xl sm:px-4 md:px-6 md:py-4">
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
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-[linear-gradient(135deg,rgba(21,55,50,0.95),rgba(8,24,22,0.95))] text-[#cde8db] shadow-[0_14px_32px_rgba(6,18,17,0.28)] transition hover:border-primary/40 hover:bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] disabled:opacity-50"
              >
                {isUploadingImage ? <Loader size="sm" /> : <ImagePlus className="h-5 w-5" />}
              </button>
              <GifPicker
                disabled={isSending || isLoading || isUploadingImage}
                onSelect={handleGifSelect}
              />
              <Popover open={isEmojiPickerOpen} onOpenChange={setIsEmojiPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={isSending || isLoading || isUploadingImage}
                    className="hidden h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-[linear-gradient(135deg,rgba(21,55,50,0.95),rgba(8,24,22,0.95))] text-[#cde8db] shadow-[0_14px_32px_rgba(6,18,17,0.28)] transition hover:border-primary/40 hover:bg-[linear-gradient(135deg,rgba(27,71,64,0.98),rgba(10,30,27,0.98))] disabled:opacity-50 md:inline-flex"
                  >
                    <Smile className="h-5 w-5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="hidden w-[340px] overflow-hidden rounded-[1.5rem] border-border/70 bg-card/95 p-0 md:block" side="top" align="start">
                  <EmojiPicker
                    onEmojiClick={(emojiData: EmojiClickData) => setMessageInput((prev) => `${prev}${emojiData.emoji}`)}
                    emojiStyle={EmojiStyle.NATIVE}
                    lazyLoadEmojis={true}
                    previewConfig={{ showPreview: false }}
                    theme={Theme.AUTO}
                    width={340}
                    height={420}
                    style={{ border: "none" }}
                  />
                </PopoverContent>
              </Popover>
              <input
                ref={messageInputRef}
                type="text"
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="Message group"
                disabled={isSending || isLoading || isUploadingImage}
                className="tactical-input min-w-0 flex-1 rounded-full border px-4 py-3 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isSending || isLoading || isUploadingImage || !messageInput.trim()}
                className="tactical-icon-button-primary h-11 w-11"
              >
                {isSending ? <Loader size="sm" /> : <Send className="h-5 w-5" />}
              </button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">Messages are encrypted separately for each group member.</p>
          </div>
        </div>
      </div>

      {isInviteOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-[28px] border border-border/70 bg-card p-6">
            <h3 className="text-2xl font-black tracking-[-0.04em] text-foreground">Invite member</h3>
            <p className="mt-1 text-sm text-muted-foreground">Send a private inbox invitation. They will join only after accepting.</p>
            <input
              type="text"
              value={inviteUsername}
              onChange={(event) => setInviteUsername(event.target.value)}
              placeholder="Enter exact username or @username"
              className="mt-5 w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
            />
            <div className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-background/70">
              {isSearchingInviteUsers ? (
                <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                  <Loader size="sm" />
                  Checking exact username...
                </div>
              ) : inviteSearchError ? (
                <div className="px-4 py-3 text-sm text-destructive">
                  {inviteSearchError}
                </div>
              ) : inviteSuggestions.length > 0 ? (
                inviteSuggestions.map((user) => (
                  <button
                    key={user.username}
                    type="button"
                    onClick={() => setInviteUsername(user.username)}
                    className="flex w-full items-center gap-3 border-t border-border/60 px-4 py-3 text-left transition first:border-t-0 hover:bg-accent/70"
                  >
                    <UserAvatar name={user.displayName} avatar={user.avatar} className="h-9 w-9" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {user.displayName}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        @{user.username}
                      </p>
                    </div>
                  </button>
                ))
              ) : inviteUsername.trim() ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  No matching users found.
                </div>
              ) : (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  Matching usernames will appear here as you type.
                </div>
              )}
            </div>
            <div className="mt-5 flex gap-3">
              <button type="button" onClick={() => setIsInviteOpen(false)} className="tactical-button-outline h-11 flex-1 text-sm font-semibold">
                Cancel
              </button>
              <button type="button" onClick={() => void inviteUser()} className="tactical-button h-11 flex-1 text-sm font-semibold">
                Send invite
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isSettingsOpen && group ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-[28px] border border-border/70 bg-card p-6">
            <h3 className="text-2xl font-black tracking-[-0.04em] text-foreground">Group settings</h3>
            <div className="mt-5 flex items-center gap-4">
              <UserAvatar name={editName || group.name} avatar={editAvatar} className="h-16 w-16" />
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-border bg-background px-4 py-3 text-sm font-semibold text-foreground">
                <Users className="h-4 w-4" />
                Change photo
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void onAvatarFileChange(file);
                    }
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            <input
              type="text"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              placeholder="Group name"
              className="mt-5 w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
            />
            <textarea
              value={editBio}
              onChange={(event) => setEditBio(event.target.value)}
              placeholder="Group bio"
              className="mt-3 min-h-[120px] w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
            />
            <div className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold text-foreground">Members</h4>
              {activeMembers.map((member) => (
                <div key={member.userId} className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-background/70 px-4 py-3">
                  <UserAvatar name={member.displayName} avatar={member.avatar} className="h-10 w-10" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {isAdmin ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition hover:border-border hover:bg-accent hover:text-foreground"
                              aria-label={`Open actions for ${member.displayName || member.username || "member"}`}
                            >
                              <Info className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            side="bottom"
                            sideOffset={8}
                            className="w-52 rounded-2xl border border-border/80 bg-popover/98 p-2 shadow-[0_20px_45px_rgba(0,0,0,0.45)]"
                          >
                            <DropdownMenuItem
                              onClick={() => openMemberProfile(member)}
                              className="cursor-pointer gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold"
                            >
                              <UserRound className="h-4 w-4 shrink-0" />
                              <span>View Profile</span>
                            </DropdownMenuItem>
                            {member.userId !== currentUserId ? (
                              <DropdownMenuItem
                                onClick={() => openDirectMessage(member)}
                                className="cursor-pointer gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold"
                              >
                                <MessageCircle className="h-4 w-4 shrink-0" />
                                <span>Send Direct Msg</span>
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      <p className="truncate text-sm font-semibold text-foreground">
                        {member.displayName} {member.userId === currentUserId ? "(You)" : ""}
                      </p>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {member.username ? `@${member.username}` : member.userId}
                    </p>
                  </div>
                  <span className="rounded-full bg-accent px-3 py-1 text-xs font-semibold text-foreground">
                    {member.role}
                  </span>
                  {isAdmin && member.userId !== currentUserId ? (
                    <div className="flex flex-wrap gap-2">
                      {member.role === "member" ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPendingGroupAction({
                              type: "assign-admin",
                              userId: member.userId,
                              displayName: member.displayName || member.username || "this member",
                            })
                          }
                          className="tactical-chip-button"
                        >
                          Make admin
                        </button>
                      ) : (
                        <>
                          {isOwner ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPendingGroupAction({
                                  type: "transfer-owner",
                                  userId: member.userId,
                                  displayName: member.displayName || member.username || "this admin",
                                })
                              }
                              className="tactical-chip-button"
                            >
                              Transfer owner role
                            </button>
                          ) : null}
                          <button type="button" onClick={() => void updateAdmin(member.userId, "revoke")} className="tactical-chip-button">
                            Revoke admin
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setPendingGroupAction({
                            type: "remove-member",
                            userId: member.userId,
                            displayName: member.displayName || member.username || "this member",
                          })
                        }
                        className="tactical-chip-button-danger"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {isOwner ? (
              <div className="mt-6 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
                <h4 className="text-sm font-semibold text-foreground">
                  Owner controls
                </h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  This permanently deletes the group, all messages, all active
                  memberships, and any pending invitations for everyone.
                </p>
                <button
                  type="button"
                  onClick={() => setIsDeleteGroupDialogOpen(true)}
                  className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-destructive/40 bg-destructive px-4 py-3 text-sm font-semibold text-destructive-foreground transition hover:opacity-90"
                >
                  Remove Everyone & Delete This Group
                </button>
              </div>
            ) : null}
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={() => setIsSettingsOpen(false)} className="tactical-button-outline h-11 flex-1 text-sm font-semibold">
                Close
              </button>
              <button type="button" onClick={() => void saveSettings()} className="tactical-button h-11 flex-1 text-sm font-semibold">
                Save changes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AvatarCropDialog
        imageUrl={cropImageUrl}
        imageType={cropImageType}
        open={isCropOpen}
        onOpenChange={setIsCropOpen}
        onSave={async (file) => {
          const dataUrl = await fileToDataUrl(file);
          setEditAvatar(dataUrl);
          setIsCropOpen(false);
        }}
      />

      <AlertDialog
        open={!!pendingGroupAction}
        onOpenChange={(open) => {
          if (!open && !isConfirmingGroupAction) {
            setPendingGroupAction(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-md rounded-[28px] border-border/70 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-2xl font-black tracking-[-0.04em] text-foreground">
              {pendingActionCopy?.title}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-muted-foreground">
              {pendingActionCopy?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isConfirmingGroupAction}
              className="rounded-2xl"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmPendingGroupAction();
              }}
              disabled={isConfirmingGroupAction}
              className="rounded-2xl"
            >
              {isConfirmingGroupAction
                ? "Working..."
                : pendingActionCopy?.confirmLabel || "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isDeleteGroupDialogOpen}
        onOpenChange={(open) => {
          if (!isDeletingGroup) {
            setIsDeleteGroupDialogOpen(open);
          }
        }}
      >
        <AlertDialogContent className="max-w-md rounded-[28px] border-border/70 bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-2xl font-black tracking-[-0.04em] text-foreground">
              Delete This Group For Everyone?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-6 text-muted-foreground">
              This permanently removes the group, all group messages, all
              members, all admins, and any pending invitations. Nobody will be
              able to see or open it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isDeletingGroup}
              className="rounded-2xl"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void deleteGroupForEveryone();
              }}
              disabled={isDeletingGroup}
              className="rounded-2xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingGroup ? "Deleting..." : "Delete Group"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
