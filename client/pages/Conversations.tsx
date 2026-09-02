import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import Layout from "@/components/Layout";
import ConversationSidebar from "@/components/ConversationSidebar";
import { Loader } from "@/components/ui/loader";
import { useConversationDirectory } from "@/hooks/useConversationDirectory";
import { VOLTEX_LOGO_URL } from "@/lib/branding";
import { UserAvatar } from "@/components/UserAvatar";
import { ProfileQuickActions } from "@/components/ProfileQuickActions";
import AvatarCropDialog from "@/components/AvatarCropDialog";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

interface SearchResult {
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
}

export default function Conversations() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    conversations,
    requests,
    currentDisplayName,
    currentAvatar,
    currentUserId,
    isAuthenticated,
    isAuthResolved,
    isConnected,
    isRefreshing,
    refreshConversations,
  } = useConversationDirectory();

  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupBio, setGroupBio] = useState("");
  const [groupAvatar, setGroupAvatar] = useState<string | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [createGroupRequestId, setCreateGroupRequestId] = useState("");
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [cropImageType, setCropImageType] = useState<"image/jpeg" | "image/png" | null>(null);
  const [isCropOpen, setIsCropOpen] = useState(false);
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isCreateGroupLockedRef = useRef(false);

  const generateSubmissionId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `group-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const openCreateGroupModal = () => {
    setCreateGroupRequestId(generateSubmissionId());
    setShowCreateGroupModal(true);
  };

  const closeCreateGroupModal = () => {
    if (isCreatingGroup) {
      return;
    }
    setShowCreateGroupModal(false);
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });

  useEffect(() => {
    if (isAuthResolved && !isAuthenticated) {
      navigate("/signin");
    }
  }, [isAuthResolved, isAuthenticated, navigate]);

  useEffect(() => {
    if (location.pathname === "/" || location.pathname === "/conversations") {
      void refreshConversations();
    }
  }, [location.pathname, refreshConversations]);

  useEffect(() => {
    if (location.state && typeof location.state === "object" && "openSearchModal" in location.state) {
      setShowSearchModal(true);
      navigate(location.pathname, { replace: true });
    }
  }, [location.pathname, location.state, navigate]);

  const handleSearchUsers = async (query: string) => {
    setSearchQuery(query);

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = null;
    }

    if (!query.trim()) {
      setSearchResults([]);
      setSearchError("");
      setIsSearching(false);
      return;
    }

    searchDebounceRef.current = setTimeout(async () => {
      setIsSearching(true);
      setSearchError("");

      try {
        const sessionToken = browserStorage.getItem("session_token");
        const response = await fetch("/api/users/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionToken
              ? { Authorization: `Bearer ${sessionToken}` }
              : {}),
          },
          body: JSON.stringify({ query: query.trim() }),
        });

        if (response.ok) {
          const data = await response.json();
          setSearchResults(data.results);
        } else {
          const errorData = await response.json();
          setSearchError(errorData.error || "Search failed");
        }
      } catch (error) {
        console.error("Search error:", error);
        setSearchError("Failed to search users");
      } finally {
        setIsSearching(false);
      }
    }, 250);
  };

  const handleSelectUser = (user: SearchResult) => {
    setShowSearchModal(false);
    setSearchQuery("");
    setSearchResults([]);
    navigate(`/chat/${user.username}`);
  };

  const handleRefresh = async () => {
    await refreshConversations();
    toast.success("Conversations refreshed");
  };

  const handleCreateGroup = async () => {
    const sessionToken = browserStorage.getItem("session_token");
    if (isCreateGroupLockedRef.current) {
      return;
    }
    if (!sessionToken || !groupName.trim()) {
      toast.error("Group name is required");
      return;
    }

    const requestId = createGroupRequestId || generateSubmissionId();
    isCreateGroupLockedRef.current = true;
    setIsCreatingGroup(true);
    if (!createGroupRequestId) {
      setCreateGroupRequestId(requestId);
    }

    try {
      const response = await fetch("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          requestId,
          name: groupName.trim(),
          bio: groupBio.trim(),
          avatar: groupAvatar,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || "Failed to create group");
      }

      const data = await response.json();
      toast.success("Group created");
      setShowCreateGroupModal(false);
      setGroupName("");
      setGroupBio("");
      setGroupAvatar(null);
      setCreateGroupRequestId("");
      await refreshConversations();
      navigate(`/groups/${data.group.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create group");
    } finally {
      isCreateGroupLockedRef.current = false;
      setIsCreatingGroup(false);
    }
  };

  if (!isAuthResolved) {
    return (
      <Layout showProfileMenu={false}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <Loader size="lg" />
            <p className="text-sm font-medium text-muted-foreground">
              Restoring your session
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return (
      <Layout showProfileMenu={false}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center">
            <Loader size="lg" />
            <p className="text-sm font-medium text-muted-foreground">
              Redirecting to sign in
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      showProfileMenu={true}
      profileData={{
        displayName: currentDisplayName,
        avatar: currentAvatar || undefined,
      }}
      onSearchClick={() => setShowSearchModal(true)}
    >
      <div className="flex h-full min-h-0 bg-background">
        <div className="hidden min-h-0 flex-1 lg:flex">
          <ConversationSidebar
            conversations={conversations}
            requests={requests}
            isConnected={isConnected}
            isRefreshing={isRefreshing}
            onRefresh={handleRefresh}
            onCompose={() => setShowSearchModal(true)}
            className="w-[360px] min-w-[360px]"
          />

          <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[radial-gradient(circle_at_top,rgba(176,228,204,0.12),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] p-8">
            <div className="mx-auto flex max-w-xl flex-col items-center text-center">
              <img
                src={VOLTEX_LOGO_URL}
                alt="Voltex"
                className="mb-6 h-14 w-14 object-contain"
              />
              <h2 className="text-4xl font-black tracking-[-0.05em] text-foreground md:text-5xl">
                Select a conversation
              </h2>
              <p className="mt-3 text-lg font-semibold text-muted-foreground md:text-xl">
                Choose a chat from the left to view messages, or start a new
                conversation.
              </p>
            </div>
          </section>
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
          <ConversationSidebar
            conversations={conversations}
            requests={requests}
            isConnected={isConnected}
            isRefreshing={isRefreshing}
            onRefresh={handleRefresh}
            onCompose={() => setShowSearchModal(true)}
            className="border-r-0"
          />
        </div>

        {showSearchModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,20,19,0.88)] p-3 sm:p-4">
            <div className="tactical-panel flex max-h-[min(90vh,calc(var(--app-viewport-height)-1.5rem))] w-full max-w-md flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/70 p-5">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Start a new chat
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Enter the exact username or @username to open a secure conversation.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowSearchModal(false);
                    setSearchQuery("");
                    setSearchResults([]);
                  }}
                  type="button"
                  aria-label="Close user search"
                  className="tactical-icon-button h-10 w-10 shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="border-b border-border/70 p-5">
                <button
                  type="button"
                  onClick={() => {
                    setShowSearchModal(false);
                    openCreateGroupModal();
                  }}
                  className="tactical-button-outline mb-4 h-11 w-full text-sm font-semibold"
                >
                  Create secure group
                </button>
                <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-background/80 px-3 py-2.5">
                  <Search className="h-5 w-5 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearchUsers(e.target.value)}
                    placeholder="Enter exact username or @username"
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {searchError ? (
                  <div className="border-b border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {searchError}
                  </div>
                ) : null}

                {isSearching ? (
                  <div className="flex h-32 items-center justify-center">
                    <Loader />
                  </div>
                ) : null}

                {!isSearching && searchQuery && searchResults.length === 0 ? (
                  <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
                    <p className="text-sm font-medium text-foreground">
                      No users found
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Enter the exact username to find that account.
                    </p>
                  </div>
                ) : null}

                {searchResults.map((user) => (
                  <div
                    key={user.username}
                    className="flex items-center gap-3 border-b border-border/60 px-5 py-4 transition hover:bg-accent/70"
                  >
                    <ProfileQuickActions username={user.username} align="start">
                      <button
                        type="button"
                        className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
                        aria-label={`Open profile actions for ${user.displayName}`}
                      >
                        <UserAvatar
                          name={user.displayName}
                          avatar={user.avatar}
                          className="h-11 w-11"
                        />
                      </button>
                    </ProfileQuickActions>
                    <button
                      type="button"
                      onClick={() => handleSelectUser(user)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {user.displayName}
                      </h3>
                      <p className="truncate text-sm text-muted-foreground">
                        @{user.username}
                      </p>
                      {user.bio ? (
                        <p className="truncate pt-0.5 text-xs text-muted-foreground">
                          {user.bio}
                        </p>
                      ) : null}
                    </button>
                  </div>
                ))}

                {!searchQuery && !isSearching ? (
                  <div className="flex h-32 flex-col items-center justify-center px-6 text-center">
                    <Search className="mb-3 h-8 w-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Exact username search only. Type the full username or @username.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}

        {showCreateGroupModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(9,20,19,0.88)] p-3 sm:p-4">
            <div className="tactical-panel flex max-h-[min(90vh,calc(var(--app-viewport-height)-1.5rem))] w-full max-w-lg flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/70 p-5">
                <div>
                  <h2 className="text-2xl font-black tracking-[-0.04em] text-foreground">
                    Create group
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add the group details now and invite members after creation.
                  </p>
                </div>
                <button
                  onClick={closeCreateGroupModal}
                  disabled={isCreatingGroup}
                  className="tactical-icon-button h-10 w-10"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                <div className="flex items-center gap-4">
                  <UserAvatar name={groupName || "Group"} avatar={groupAvatar} className="h-16 w-16" />
                  <label className="inline-flex cursor-pointer items-center justify-center rounded-2xl border border-border/70 bg-background/70 px-4 py-3 text-sm font-semibold text-foreground transition hover:bg-accent">
                    Choose photo
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          setCropImageUrl(URL.createObjectURL(file));
                          setCropImageType(file.type === "image/png" ? "image/png" : "image/jpeg");
                          setIsCropOpen(true);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>

                <input
                  type="text"
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  placeholder="Group name"
                  className="w-full rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-foreground"
                />
                <textarea
                  value={groupBio}
                  onChange={(event) => setGroupBio(event.target.value)}
                  placeholder="Group bio"
                  className="min-h-[140px] w-full rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-foreground"
                />

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={closeCreateGroupModal}
                    disabled={isCreatingGroup}
                    className="tactical-button-outline h-11 flex-1 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateGroup()}
                    disabled={isCreatingGroup || !groupName.trim()}
                    className="tactical-button h-11 flex-1 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isCreatingGroup ? "Creating group..." : "Create group"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <AvatarCropDialog
          imageUrl={cropImageUrl}
          imageType={cropImageType}
          open={isCropOpen}
          onOpenChange={setIsCropOpen}
          onSave={async (file) => {
            setGroupAvatar(await fileToDataUrl(file));
            setIsCropOpen(false);
          }}
        />
      </div>
    </Layout>
  );
}
