import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronUp, Inbox, MessageSquarePlus, RefreshCw, Search } from "lucide-react";
import { formatConversationTime } from "@/lib/dateFormatter";
import { getServerTime } from "@/lib/serverTime";
import { normalizeUnreadCount } from "@/lib/unreadCount";
import { cn } from "@/lib/utils";
import {
  ConversationListItem,
  RequestListItem,
} from "@/hooks/useConversationDirectory";
import { Loader } from "@/components/ui/loader";
import { UserAvatar } from "@/components/UserAvatar";
import { ProfileQuickActions } from "@/components/ProfileQuickActions";

interface ConversationSidebarProps {
  conversations: ConversationListItem[];
  activeConversationId?: string;
  isConnected: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onCompose?: () => void;
  requests?: RequestListItem[];
  heading?: string;
  subheading?: string;
  className?: string;
}

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  isConnected,
  isRefreshing = false,
  onRefresh,
  onCompose,
  requests = [],
  heading = "Messages",
  subheading = "Private, end-to-end encrypted conversations",
  className,
}: ConversationSidebarProps) {
  const [query, setQuery] = useState("");
  const [isRequestsOpen, setIsRequestsOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const pendingRequestCount = requests.length;

  const filteredConversations = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return conversations;
    }

    return conversations.filter((conversation) => {
      return (
        conversation.name.toLowerCase().includes(normalizedQuery) ||
        conversation.username.toLowerCase().includes(normalizedQuery) ||
        (conversation.subtitle || "").toLowerCase().includes(normalizedQuery)
      );
    });
  }, [conversations, deferredQuery]);

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col border-r border-border/70 bg-card/88 backdrop-blur-xl",
        className,
      )}
    >
      <div className="border-b border-border/70 px-4 py-4 md:px-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black tracking-[-0.05em] text-foreground md:text-[2rem]">
              {heading}
            </h2>
            <p className="mt-1 text-base font-semibold text-muted-foreground">
              {subheading}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="tactical-icon-button h-10 w-10"
              title="Refresh"
            >
              {isRefreshing ? (
                <span className="inline-flex h-6 w-6 items-center justify-center">
                  <Loader size="sm" className="shrink-0" />
                </span>
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={onCompose}
              className="tactical-icon-button-primary h-10 w-10"
              title="New chat"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/70 px-3 py-2 shadow-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                isConnected ? "bg-primary" : "bg-muted-foreground/50",
              )}
            />
            <span>{isConnected ? "Connected" : "Reconnecting"}</span>
          </div>
          <button
            type="button"
            onClick={() => setIsRequestsOpen((current) => !current)}
            className="tactical-chip-button ml-auto gap-2"
          >
            <Inbox className="h-3.5 w-3.5" />
            <span>Requests</span>
            {pendingRequestCount > 0 ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                {pendingRequestCount}
              </span>
            ) : null}
            {isRequestsOpen ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        </div>

        {isRequestsOpen ? (
          <div className="mt-3 rounded-2xl border border-border/70 bg-background/70 p-3">
            {pendingRequestCount === 0 ? (
              <p className="text-xs text-muted-foreground">
                No pending group invitations.
              </p>
            ) : (
              <div className="space-y-2">
                {requests.map((request) => (
                  <Link
                    key={request.id}
                    to={request.routePath}
                    className="flex items-center gap-3 rounded-2xl border border-border/50 bg-card/80 px-3 py-2 transition hover:bg-accent/70"
                  >
                    <UserAvatar name={request.name} avatar={request.avatar} className="h-9 w-9" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {request.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {request.subtitle}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filteredConversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 rounded-3xl border border-border/70 bg-background/80 p-4">
              <Search className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-black tracking-[-0.04em] text-foreground">
              {query ? "No matching conversations" : "No conversations yet"}
            </h3>
            <p className="mt-1 max-w-xs text-sm text-muted-foreground">
              {query
                ? "Try a different name or username."
                : "Start a new chat to begin a secure conversation."}
            </p>
          </div>
        ) : (
          filteredConversations.map((conversation) => {
            const unreadCount = normalizeUnreadCount(conversation.unreadCount);
            const isActive = activeConversationId === conversation.id;

            return (
              <div
                key={conversation.id}
                className={cn(
                  "border-b border-border/50 px-4 py-3 transition hover:bg-accent/70 md:px-5",
                  isActive && "bg-accent/90",
                )}
              >
                <div className="flex items-center gap-3">
                  <ProfileQuickActions username={conversation.username} align="start">
                    <button
                      type="button"
                      className="relative shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
                      aria-label={`Open profile actions for ${conversation.name}`}
                    >
                      <UserAvatar
                        name={conversation.name}
                        avatar={conversation.avatar}
                        className="h-12 w-12"
                      />
                      {conversation.online ? (
                        <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-card bg-primary" />
                      ) : null}
                    </button>
                  </ProfileQuickActions>

                  <Link
                    to={conversation.routePath || `/chat/${conversation.username || conversation.id}`}
                    className="min-w-0 flex-1"
                  >
                    <div className="flex items-center gap-3">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                        {conversation.name}
                      </h3>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatConversationTime(
                          conversation.timestamp,
                          getServerTime(),
                        )}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-2">
                      {conversation.subtitle ? (
                        <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {conversation.subtitle}
                        </p>
                      ) : (
                        <span className="flex-1" />
                      )}
                      {unreadCount > 0 ? (
                        <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                          {unreadCount}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
