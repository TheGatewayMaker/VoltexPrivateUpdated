import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Layout from "@/components/Layout";
import { UserAvatar } from "@/components/UserAvatar";
import { Loader } from "@/components/ui/loader";
import { toast } from "sonner";
import * as browserStorage from "@/lib/browserStorage";

interface InviteSummary {
  id: string;
  groupId: string;
  groupName: string;
  groupBio: string;
  groupAvatar: string | null;
  invitedBy: string;
  inviterUsername: string;
  inviterDisplayName: string;
  createdAt: number;
}

export default function GroupInvite() {
  const { inviteId } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<InviteSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken || !inviteId) {
      navigate("/signin");
      return;
    }

    setIsLoading(true);
    fetch(`/api/group-invites/${inviteId}`, {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || "Failed to load invitation");
        }
        return response.json();
      })
      .then((data) => setInvite(data.invite || null))
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Failed to load invitation");
        navigate("/");
      })
      .finally(() => setIsLoading(false));
  }, [inviteId, navigate]);

  const submit = async (action: "accept" | "decline") => {
    const sessionToken = browserStorage.getItem("session_token");
    if (!sessionToken || !inviteId) {
      navigate("/signin");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/group-invites/${inviteId}/${action}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Failed to ${action} invitation`);
      }

      if (action === "accept" && invite) {
        toast.success("Joined group");
        navigate(`/groups/${invite.groupId}`);
        return;
      }

      toast.success("Invitation declined");
      navigate("/");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to ${action} invitation`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Layout showBack={true} title="Group Invitation" onBackClick={() => navigate("/")} showProfileMenu={false}>
      <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_top,rgba(176,228,204,0.12),transparent_30%)] p-6">
        <div className="w-full max-w-lg rounded-[28px] border border-border/70 bg-card/90 p-8 shadow-[0_22px_56px_rgba(2,6,23,0.24)]">
          {isLoading ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Loader size="lg" />
              <p className="text-sm text-muted-foreground">Loading invitation...</p>
            </div>
          ) : invite ? (
            <>
              <div className="mx-auto mb-6 flex justify-center">
                <UserAvatar
                  name={invite.groupName}
                  avatar={invite.groupAvatar}
                  className="h-20 w-20"
                />
              </div>
              <h1 className="text-center text-3xl font-black tracking-[-0.05em] text-foreground">
                {invite.groupName}
              </h1>
              <p className="mt-3 text-center text-sm text-muted-foreground">
                Invited by {invite.inviterDisplayName}
                {invite.inviterUsername ? ` (@${invite.inviterUsername})` : ""}
              </p>
              <p className="mt-6 rounded-3xl border border-border/70 bg-background/70 px-4 py-4 text-sm text-foreground">
                {invite.groupBio || "This group does not have a bio yet."}
              </p>
              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void submit("decline")}
                  disabled={isSubmitting}
                  className="tactical-button-outline h-12 text-sm font-semibold"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => void submit("accept")}
                  disabled={isSubmitting}
                  className="tactical-button h-12 text-sm font-semibold"
                >
                  {isSubmitting ? "Working..." : "Accept Invite"}
                </button>
              </div>
            </>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Invitation not found.</p>
          )}
        </div>
      </div>
    </Layout>
  );
}
