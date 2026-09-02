import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type RestrictionType = "ACCOUNT_BANNED" | "IP_RESTRICTED";

interface RestrictionAppealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restrictionType: RestrictionType;
  reason?: string;
  userId?: string;
}

export default function RestrictionAppealDialog({
  open,
  onOpenChange,
  restrictionType,
  reason,
  userId,
}: RestrictionAppealDialogProps) {
  const [contactEmail, setContactEmail] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const title = useMemo(
    () =>
      restrictionType === "ACCOUNT_BANNED"
        ? "Account Banned"
        : "IP Access Restricted",
    [restrictionType],
  );

  const description = useMemo(() => {
    if (restrictionType === "ACCOUNT_BANNED") {
      return (
        reason ||
        "Your account has been banned for violating Voltex terms of service."
      );
    }
    return (
      reason ||
      "Access from this IP address has been permanently restricted on Voltex."
    );
  }, [restrictionType, reason]);

  const resetForm = () => {
    setStatus("");
    setError("");
    setContactEmail("");
    setMessage("");
  };

  const submitAppeal = async () => {
    if (!contactEmail.trim()) {
      setError("Contact email is required");
      return;
    }
    if (!message.trim()) {
      setError("Please explain why your appeal should be considered");
      return;
    }

    setIsSubmitting(true);
    setError("");
    setStatus("");

    try {
      const response = await fetch("/api/admin/panel/appeals", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type:
            restrictionType === "ACCOUNT_BANNED"
              ? "banned-user"
              : "ip-restricted",
          userId: userId || null,
          contactEmail: contactEmail.trim(),
          message: message.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Failed to submit appeal");
      }

      setStatus("Appeal submitted. Admin will review your request.");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Failed to submit appeal",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          resetForm();
        }
      }}
    >
      <DialogContent className="rounded-none border-border bg-card p-0 sm:max-w-xl">
        <div className="border-b border-border px-6 py-4">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black tracking-tight">
              {title}
            </DialogTitle>
            <DialogDescription className="pt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-6 py-5">
          {error && (
            <div className="border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {status && (
            <div className="border border-primary bg-primary/10 px-3 py-2 text-sm text-foreground">
              {status}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-[0.18em] text-foreground">
              Contact Email
            </label>
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="h-11 w-full rounded-none border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
              placeholder="you@example.com"
              disabled={isSubmitting}
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-[0.18em] text-foreground">
              Appeal Message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="min-h-[120px] w-full rounded-none border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              placeholder="Describe your appeal request"
              disabled={isSubmitting}
            />
          </div>
        </div>

        <DialogFooter className="border-t border-border px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="rounded-none"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Close
          </Button>
          <Button
            type="button"
            className="rounded-none"
            onClick={submitAppeal}
            disabled={isSubmitting}
          >
            {isSubmitting ? "Submitting..." : "Request Appeal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
