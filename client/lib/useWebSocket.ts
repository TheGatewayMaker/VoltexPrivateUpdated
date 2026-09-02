import { useEffect, useRef, useState } from "react";
import { EncryptedMessage } from "@shared/crypto";
import * as browserStorage from "./browserStorage";

interface UseWebSocketOptions {
  onMessage?: (message: EncryptedMessage) => void;
  onError?: (error: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onStatus?: (
    messageId: string,
    status: "sent" | "delivered" | "failed" | "seen",
    metadata?: {
      serverUUID?: string;
      deliveredAt?: number;
      seenAt?: number;
    },
  ) => void;
  onAck?: (
    messageId: string,
    delivered: boolean,
    serverTimestamp?: number,
    serverMessageId?: string,
  ) => void; // Track delivery ACKs and server timestamp
  onMessageDeleted?: (
    messageId: string,
    deletedBy: string,
    metadata?: {
      serverUUID?: string;
      messageTimestamp?: number;
      senderId?: string;
    },
  ) => void; // Handle message deletion with optional metadata
  onGroupMessage?: (
    groupId: string,
    message: EncryptedMessage & { id?: string },
  ) => void;
  onGroupMessageDeleted?: (
    groupId: string,
    messageId: string,
    deletedBy: string,
  ) => void;
  onGroupMessageStatus?: (
    groupId: string,
    messageId: string,
    receipt: Record<string, unknown>,
  ) => void;
  onGroupUpdated?: (group: Record<string, unknown>) => void;
  onGroupPinUpdated?: (
    groupId: string,
    pinnedMessage: Record<string, unknown> | null,
  ) => void;
  onGroupRemoved?: (groupId: string, reason?: string) => void;
  onGroupInvite?: (invite: Record<string, unknown>) => void;
  onGroupInviteRemoved?: (inviteId: string) => void;
  onDirectBlockUpdated?: (
    otherUserId: string,
    status: {
      blockedByMe: boolean;
      blockedMe: boolean;
      isMutual: boolean;
      canSend: boolean;
    },
    updatedBy?: string,
    updatedAt?: number,
  ) => void;
  onSendError?: (
    messageId?: string,
    error?: string,
    code?: string,
    blockStatus?: {
      blockedByMe?: boolean;
      blockedMe?: boolean;
      isMutual?: boolean;
      canSend?: boolean;
    },
  ) => void;
}

export function useWebSocket(options?: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options); // Keep a mutable reference to latest options
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = useRef(true);
  const activeConnectionIdRef = useRef(0);
  const lastReportedErrorRef = useRef<{ message: string; at: number } | null>(
    null,
  );

  // Update the ref whenever options change so handlers always call the latest callbacks
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    let cancelled = false;

    // Only connect once per session
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // WebSocket already connected, update the callbacks
      return;
    }

    const connectWebSocket = (sessionToken: string) => {
      if (!shouldReconnectRef.current || isConnecting) {
        return;
      }

      try {
        setIsConnecting(true);
        const connectionId = activeConnectionIdRef.current + 1;
        activeConnectionIdRef.current = connectionId;
        void (async () => {
          const ticketResponse = await fetch("/api/auth/ws-ticket", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${sessionToken}`,
            },
          });

          if (!ticketResponse.ok) {
            if (ticketResponse.status === 401) {
              throw new Error("Session expired");
            }
            throw new Error("Failed to create WebSocket connection ticket");
          }

          const ticketData = await ticketResponse.json();

          // Determine WebSocket URL based on current location
          const protocol =
            window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = `${protocol}//${window.location.host}/ws?ticket=${ticketData.ticket}`;

          console.log("[WS-CLIENT] Attempting WebSocket connection");
          console.log("[WS-CLIENT] Session token present:", !!sessionToken);

          const ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            if (
              !shouldReconnectRef.current ||
              activeConnectionIdRef.current !== connectionId
            ) {
              ws.close();
              return;
            }
            console.log("[WS-CLIENT] WebSocket connected successfully");
            setIsConnecting(false);
            setIsConnected(true);
            reconnectAttemptsRef.current = 0;
            optionsRef.current?.onConnected?.();
          };

          ws.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);

              if (data.type === "message") {
                optionsRef.current?.onMessage?.(data.data);
              } else if (data.type === "message-ack") {
                const delivered = data.delivered !== false;
                const serverTimestamp = data.timestamp;
                console.log(
                  `Message ${data.messageId} acknowledged (delivered: ${delivered}, timestamp: ${serverTimestamp})`,
                );
                optionsRef.current?.onAck?.(
                  data.messageId,
                  delivered,
                  serverTimestamp,
                  data.serverMessageId,
                );
              } else if (data.type === "message-status") {
                optionsRef.current?.onStatus?.(
                  data.messageId,
                  data.status,
                  data.metadata,
                );
              } else if (data.type === "message-deleted") {
                const { messageId, deletedBy, metadata } = data.data;
                console.log(
                  `Message ${messageId} deleted by ${deletedBy}`,
                  metadata,
                );
                optionsRef.current?.onMessageDeleted?.(
                  messageId,
                  deletedBy,
                  metadata,
                );
              } else if (data.type === "group-message") {
                optionsRef.current?.onGroupMessage?.(
                  String(data.data?.groupId || ""),
                  data.data?.message,
                );
              } else if (data.type === "group-message-deleted") {
                optionsRef.current?.onGroupMessageDeleted?.(
                  String(data.data?.groupId || ""),
                  String(data.data?.messageId || ""),
                  String(data.data?.deletedBy || ""),
                );
              } else if (data.type === "group-message-status") {
                optionsRef.current?.onGroupMessageStatus?.(
                  String(data.data?.groupId || ""),
                  String(data.data?.messageId || ""),
                  (data.data?.receipt || {}) as Record<string, unknown>,
                );
              } else if (data.type === "group-updated") {
                optionsRef.current?.onGroupUpdated?.(data.data?.group || {});
              } else if (data.type === "group-pin-updated") {
                optionsRef.current?.onGroupPinUpdated?.(
                  String(data.data?.groupId || ""),
                  (data.data?.pinnedMessage || null) as Record<string, unknown> | null,
                );
              } else if (data.type === "group-removed") {
                optionsRef.current?.onGroupRemoved?.(
                  String(data.data?.groupId || ""),
                  typeof data.data?.reason === "string"
                    ? data.data.reason
                    : undefined,
                );
              } else if (data.type === "group-invite") {
                optionsRef.current?.onGroupInvite?.(data.data?.invite || {});
              } else if (data.type === "group-invite-removed") {
                optionsRef.current?.onGroupInviteRemoved?.(
                  String(data.data?.inviteId || ""),
                );
              } else if (data.type === "direct-block-updated") {
                optionsRef.current?.onDirectBlockUpdated?.(
                  String(data.data?.otherUserId || ""),
                  {
                    blockedByMe: Boolean(data.data?.status?.blockedByMe),
                    blockedMe: Boolean(data.data?.status?.blockedMe),
                    isMutual: Boolean(data.data?.status?.isMutual),
                    canSend: Boolean(data.data?.status?.canSend),
                  },
                  typeof data.data?.updatedBy === "string"
                    ? data.data.updatedBy
                    : undefined,
                  typeof data.data?.updatedAt === "number"
                    ? data.data.updatedAt
                    : undefined,
                );
              } else if (data.type === "error") {
                console.error("WebSocket error:", data.error);
                optionsRef.current?.onSendError?.(
                  typeof data.messageId === "string" ? data.messageId : undefined,
                  typeof data.error === "string" ? data.error : undefined,
                  typeof data.code === "string" ? data.code : undefined,
                  data.blockStatus || undefined,
                );
                optionsRef.current?.onError?.(data.error);
              }
            } catch (error) {
              console.error("Error parsing WebSocket message:", error);
            }
          };

          ws.onerror = (error) => {
            console.warn("[WS-CLIENT] WebSocket connection error:", error);
            setIsConnecting(false);
            scheduleReconnect();
          };

          ws.onclose = (event) => {
            console.log(
              "[WS-CLIENT] WebSocket disconnected (code:",
              event.code,
              "reason:",
              event.reason,
              ")",
            );
            setIsConnected(false);
            setIsConnecting(false);
            wsRef.current = null;
            optionsRef.current?.onDisconnected?.();

            scheduleReconnect();
          };

          wsRef.current = ws;
        })().catch((error) => {
          console.error("Error connecting to WebSocket:", error);
          setIsConnecting(false);
          const errorMessage =
            error instanceof Error ? error.message : "Failed to connect to WebSocket";
          reportConnectionError(errorMessage);
          if (errorMessage !== "Session expired") {
            scheduleReconnect();
          }
        });
      } catch (error) {
        console.error("Error connecting to WebSocket:", error);
        setIsConnecting(false);
        const errorMessage =
          error instanceof Error ? error.message : "Failed to connect to WebSocket";
        reportConnectionError(errorMessage);
        if (errorMessage !== "Session expired") {
          scheduleReconnect();
        }
      }
    };

    const reportConnectionError = (message: string) => {
      const normalizedMessage =
        message === "Session expired" ? message : "Failed to connect to WebSocket";
      const now = Date.now();
      const lastReported = lastReportedErrorRef.current;

      if (
        lastReported &&
        lastReported.message === normalizedMessage &&
        now - lastReported.at < 30000
      ) {
        return;
      }

      lastReportedErrorRef.current = {
        message: normalizedMessage,
        at: now,
      };
      optionsRef.current?.onError?.(normalizedMessage);
    };

    // Schedule reconnection with exponential backoff
    const scheduleReconnect = () => {
      if (!shouldReconnectRef.current) {
        return;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      const maxAttempts = 10;
      if (reconnectAttemptsRef.current >= maxAttempts) {
        console.error("Max WebSocket reconnection attempts reached, giving up");
        return;
      }

      const baseDelay = 1000; // 1 second
      const maxDelay = 30000; // 30 seconds
      const delay = Math.min(
        baseDelay * Math.pow(2, reconnectAttemptsRef.current),
        maxDelay,
      );

      reconnectAttemptsRef.current += 1;
      console.log(
        `Scheduling WebSocket reconnect attempt ${reconnectAttemptsRef.current} in ${delay}ms`,
      );

      reconnectTimeoutRef.current = setTimeout(async () => {
        if (!shouldReconnectRef.current) {
          return;
        }
        const latestToken = await browserStorage.waitForItem("session_token", {
          timeoutMs: 2500,
          retryIntervalMs: 200,
        });
        if (!latestToken) {
          return;
        }
        console.log(
          `Attempting WebSocket reconnect (attempt ${reconnectAttemptsRef.current})`,
        );
        wsRef.current = null; // Clear the old reference
        connectWebSocket(latestToken);
      }, delay);
    };

    void (async () => {
      const sessionToken = await browserStorage.waitForItem("session_token", {
        timeoutMs: 3000,
        retryIntervalMs: 200,
      });
      if (cancelled || !sessionToken) {
        return;
      }
      connectWebSocket(sessionToken);
    })();

    return () => {
      cancelled = true;
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  /**
   * Send an encrypted message through WebSocket
   */
  const sendEncryptedMessage = (
    message: EncryptedMessage,
    messageId?: string,
  ) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error("WebSocket is not connected");
      return false;
    }

    try {
      wsRef.current.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          data: message,
        }),
      );
      return true;
    } catch (error) {
      console.error("Error sending message:", error);
      return false;
    }
  };

  return {
    isConnected,
    isConnecting,
    sendEncryptedMessage,
  };
}
