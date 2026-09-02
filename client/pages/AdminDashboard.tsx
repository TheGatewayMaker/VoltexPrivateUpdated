import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Ban,
  Clock3,
  DatabaseBackup,
  Gauge,
  Globe2,
  HardDrive,
  LogOut,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  UserCog,
  UserX,
  Users,
  Wifi,
} from "lucide-react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";

import { ADMIN_DASHBOARD_PATH } from "@/lib/adminPanel";

const ADMIN_STORAGE_KEY = "voltex_admin_session_token";

type BackupRestorePoint = {
  id: string;
  takenAt: string;
  takenAtEpoch: number | null;
  reason: string;
  host: string;
};

type BackupStatusResponse = {
  configured: boolean;
  health: {
    state: "healthy" | "stale" | "failing" | "unknown";
    detail: string;
  };
  live: {
    kind: string;
    host: string;
    database: string;
    role: string;
    connected: boolean;
    counts: {
      users: number | null;
      messages: number | null;
      conversations: number | null;
    };
  };
  backup:
    | null
    | {
        kind: string;
        bucket: string;
        role: string;
        lastBackupAt: string | null;
        lastBackupAgeSeconds: number | null;
        lastBackupDurationSeconds: number;
        lastReachableAt: string | null;
        storage: {
          usedBytes: number;
          freeAllowanceBytes: number;
          usedPercent: number | null;
        };
        watcher: {
          checkIntervalSeconds: number;
          forcedRunIntervalSeconds: number;
        };
        restorePointCount: number;
        restorePoints: BackupRestorePoint[];
        generatedAt: string;
      };
};

type RestorePointDetail = {
  status: "not-requested" | "queued" | "running" | "ready" | "failed";
  restorePointId: string;
  databaseTables?: Record<string, number>;
  fileCount?: number;
  fileBytes?: number;
  error?: string;
};

type AppealRecord = {
  id: string;
  type: "banned-user" | "ip-restricted";
  userId?: string;
  ipAddress?: string;
  contactEmail: string;
  message: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected";
  reviewedAt?: number;
  reviewedBy?: string;
};

type BannedUserRecord = {
  userId: string;
  banned: boolean;
  ipRestricted: boolean;
  reason: string;
  bannedAt: number;
  bannedBy: string;
  updatedAt: number;
};

type Metrics = {
  totalUsers: number;
  totalGroups: number;
  totalEmailNotificationsSent: number;
  totalRegisteredEmails: number;
  connectedUsers: number;
  queuedMessages: number;
  usersWithQueuedMessages: number;
  totalMessages: number;
  activeMessages: number;
  archivedMessages: number;
  bannedUsers: number;
  pendingAppeals: number;
};

type SearchResult = {
  userId: string;
  username: string;
  createdAt: number;
  totalGroupCount: number;
  totalIndividualChatCount: number;
  notificationEmail: string | null;
  latestIpAddress: string | null;
  passkeyEnabled: boolean;
  passkeyCreatedAt: number | null;
  passkeyLastUsedAt: number | null;
  ipLogs: Array<{
    ipAddress: string;
    action: string;
    createdAt: number;
  }>;
  banned: boolean;
  banReason: string | null;
  ipRestricted: boolean;
};

type UserBaseFilter = "all" | "active" | "inactive" | "banned" | "ip-restricted";

type UserBaseRecord = {
  userId: string;
  username: string;
  createdAt: number;
  notificationEmail: string | null;
  activeSessionCount: number;
  lastSeenAt: number | null;
  banned: boolean;
  ipRestricted: boolean;
};

type UserBaseResponse = {
  users: UserBaseRecord[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  status: UserBaseFilter;
};

type AdminAccess = {
  configuredAdminCount: number;
  activeSessionCount: number;
  activeSessions: Array<{
    username: string;
    createdAt: number;
    expiresAt: number;
  }>;
};

type NavItem = {
  key: string;
  label: string;
  summary: string;
  icon: typeof Gauge;
};

const navItems: NavItem[] = [
  {
    key: "overview",
    label: "Overview",
    summary: "Platform health and operator coverage",
    icon: Gauge,
  },
  {
    key: "users",
    label: "User Moderation",
    summary: "Investigate accounts and apply actions",
    icon: UserCog,
  },
  {
    key: "user-base",
    label: "User Base",
    summary: "Filter the full customer directory",
    icon: Users,
  },
  {
    key: "banned",
    label: "Restrictions",
    summary: "Audit the active ban inventory",
    icon: ShieldBan,
  },
  {
    key: "appeals",
    label: "Appeals",
    summary: "Resolve pending moderation reviews",
    icon: ShieldAlert,
  },
  {
    key: "backups",
    label: "Data & Backups",
    summary: "Live store health and restore points",
    icon: DatabaseBackup,
  },
];

const userBaseFilterOptions: Array<{ value: UserBaseFilter; label: string }> = [
  { value: "all", label: "All users" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "banned", label: "Banned" },
  { value: "ip-restricted", label: "IP restricted" },
];

function formatDate(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatRelativeTime(ts: number): string {
  if (!ts) return "-";
  const diffMs = ts - Date.now();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60_000);

  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ${diffMs >= 0 ? "remaining" : "ago"}`;
  }

  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ${diffMs >= 0 ? "remaining" : "ago"}`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ${diffMs >= 0 ? "remaining" : "ago"}`;
}

function readAdminToken(): string {
  try {
    return window.sessionStorage.getItem(ADMIN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveAdminToken(token: string): void {
  try {
    if (!token) {
      window.sessionStorage.removeItem(ADMIN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(ADMIN_STORAGE_KEY, token);
    }
  } catch {
    // Ignore storage failures.
  }
}

function sectionPath(sectionKey: string): string {
  return `${ADMIN_DASHBOARD_PATH}/${sectionKey}`;
}

function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[28px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--card)/0.82)_100%)] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl ${className}`}
    >
      {children}
    </section>
  );
}

function SectionHeader({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border/70 pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="tactical-kicker">{eyebrow}</p>
        <h2 className="mt-2 text-2xl font-black tracking-[-0.04em] text-foreground">
          {title}
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

function StatusBadge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "success" | "danger" | "warning";
}) {
  const toneClass =
    tone === "success"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
      : tone === "danger"
        ? "border-red-500/25 bg-red-500/10 text-red-300"
        : tone === "warning"
          ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
          : "border-border/80 bg-background/50 text-foreground/75";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${toneClass}`}
    >
      {label}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="break-words text-sm text-foreground">{value}</p>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-[24px] border border-dashed border-border/80 bg-background/30 px-4 py-8 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function UserStatusBadge({ user }: { user: UserBaseRecord }) {
  if (user.banned && user.ipRestricted) {
    return <StatusBadge label="IP Restricted" tone="danger" />;
  }
  if (user.banned) {
    return <StatusBadge label="Banned" tone="danger" />;
  }
  if (user.activeSessionCount > 0) {
    return <StatusBadge label="Active" tone="success" />;
  }
  return <StatusBadge label="Inactive" tone="neutral" />;
}

function OverviewSection({
  metrics,
  adminAccess,
  appeals,
  bannedUsers,
  currentAdmin,
  lastUpdatedAt,
}: {
  metrics: Metrics | null;
  adminAccess: AdminAccess | null;
  appeals: AppealRecord[];
  bannedUsers: BannedUserRecord[];
  currentAdmin: string;
  lastUpdatedAt: number | null;
}) {
  const cards = [
    {
      label: "Registered users",
      value: formatCompactNumber(metrics?.totalUsers ?? 0),
      detail: `${metrics?.connectedUsers ?? 0} connected now`,
      icon: Users,
    },
    {
      label: "Message volume",
      value: formatCompactNumber(metrics?.totalMessages ?? 0),
      detail: `${metrics?.activeMessages ?? 0} active / ${metrics?.archivedMessages ?? 0} archived`,
      icon: Activity,
    },
    {
      label: "Delivery queue",
      value: formatCompactNumber(metrics?.queuedMessages ?? 0),
      detail: `${metrics?.usersWithQueuedMessages ?? 0} users affected`,
      icon: Wifi,
    },
    {
      label: "Admin coverage",
      value: formatCompactNumber(adminAccess?.activeSessionCount ?? 0),
      detail: `${adminAccess?.configuredAdminCount ?? 0} configured operators`,
      icon: ShieldCheck,
    },
  ];

  const latestPendingAppeals = appeals.filter((appeal) => appeal.status === "pending").slice(0, 3);
  const recentRestrictions = bannedUsers.slice(0, 4);

  return (
    <div className="space-y-5">
      <Panel className="overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(64,196,169,0.16),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent_38%)]" />
        <div className="relative">
          <SectionHeader
            eyebrow="Command Center"
            title="Platform operations at a glance"
            body="Voltex admin is organized around response speed, moderation visibility, and concurrent operator coverage rather than decorative dashboard cards."
            action={
              <div className="space-y-2 text-right">
                <StatusBadge label={`Signed in as ${currentAdmin}`} tone="success" />
                <p className="text-xs text-muted-foreground">
                  Last sync {lastUpdatedAt ? formatDate(lastUpdatedAt) : "-"}
                </p>
              </div>
            }
          />

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {cards.map((card) => {
              const Icon = card.icon;
              return (
                <article
                  key={card.label}
                  className="rounded-[24px] border border-border/70 bg-background/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {card.label}
                    </p>
                    <div className="rounded-2xl border border-primary/20 bg-primary/10 p-2 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="mt-4 text-3xl font-black tracking-[-0.05em] text-foreground">
                    {card.value}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{card.detail}</p>
                </article>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-[1.45fr_0.95fr]">
        <Panel>
          <SectionHeader
            eyebrow="Concurrent Admin Access"
            title="Operator coverage"
            body="Multiple admins can stay logged in at the same time. Session visibility is exposed here so handoffs and parallel review are explicit."
          />

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Active sessions
              </p>
              <p className="mt-3 text-3xl font-black tracking-[-0.05em]">
                {adminAccess?.activeSessionCount ?? 0}
              </p>
            </article>
            <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Configured admins
              </p>
              <p className="mt-3 text-3xl font-black tracking-[-0.05em]">
                {adminAccess?.configuredAdminCount ?? 0}
              </p>
            </article>
            <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Review queue
              </p>
              <p className="mt-3 text-3xl font-black tracking-[-0.05em]">
                {metrics?.pendingAppeals ?? 0}
              </p>
            </article>
          </div>

          <div className="mt-5 space-y-3">
            {(adminAccess?.activeSessions || []).length === 0 && (
              <EmptyState label="No active admin sessions detected." />
            )}

            {(adminAccess?.activeSessions || []).map((session, index) => (
              <article
                key={`${session.username}-${session.createdAt}-${index}`}
                className="flex flex-col gap-3 rounded-[22px] border border-border/70 bg-background/30 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">@{session.username}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Started {formatDate(session.createdAt)}
                  </p>
                </div>
                <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2 md:gap-6">
                  <span>Session age: {formatRelativeTime(session.createdAt)}</span>
                  <span>Expires: {formatRelativeTime(session.expiresAt)}</span>
                </div>
              </article>
            ))}
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel>
            <SectionHeader
              eyebrow="Moderation Queue"
              title="Pending appeals"
              body="The newest unresolved cases are surfaced here so the console has a real working backlog."
            />

            <div className="mt-5 space-y-3">
              {latestPendingAppeals.length === 0 && (
                <EmptyState label="No pending appeals are waiting for review." />
              )}

              {latestPendingAppeals.map((appeal) => (
                <article
                  key={appeal.id}
                  className="rounded-[22px] border border-border/70 bg-background/30 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        {appeal.userId || appeal.ipAddress || appeal.contactEmail}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {appeal.type} • {formatDate(appeal.createdAt)}
                      </p>
                    </div>
                    <StatusBadge label={appeal.status} tone="warning" />
                  </div>
                  <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
                    {appeal.message}
                  </p>
                </article>
              ))}
            </div>
          </Panel>

          <Panel>
            <SectionHeader
              eyebrow="Restriction Snapshot"
              title="Recent enforcement actions"
              body="A compact view of the latest bans helps admins validate whether action volume and reason quality look normal."
            />

            <div className="mt-5 space-y-3">
              {recentRestrictions.length === 0 && (
                <EmptyState label="No active restrictions are currently recorded." />
              )}

              {recentRestrictions.map((record) => (
                <article
                  key={record.userId}
                  className="rounded-[22px] border border-border/70 bg-background/30 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{record.userId}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Applied by {record.bannedBy || "admin"}
                      </p>
                    </div>
                    <StatusBadge
                      label={record.ipRestricted ? "IP Restricted" : "Banned"}
                      tone="danger"
                    />
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{record.reason || "-"}</p>
                </article>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

type UserBaseSectionProps = {
  loading: boolean;
  error: string;
  data: UserBaseResponse | null;
  pageSize: 10 | 25 | 50 | 100;
  statusFilter: UserBaseFilter;
  onPageSizeChange: (value: 10 | 25 | 50 | 100) => void;
  onStatusFilterChange: (value: UserBaseFilter) => void;
  onPageChange: (page: number) => void;
};

function UserBaseSection({
  loading,
  error,
  data,
  pageSize,
  statusFilter,
  onPageSizeChange,
  onStatusFilterChange,
  onPageChange,
}: UserBaseSectionProps) {
  const users = data?.users || [];
  const currentPage = data?.page || 1;
  const totalPages = data?.totalPages || 1;
  const totalCount = data?.totalCount || 0;
  const pageNumbers =
    totalPages <= 7
      ? Array.from({ length: totalPages }, (_, index) => index + 1)
      : Array.from(
          new Set(
            [1, currentPage - 1, currentPage, currentPage + 1, totalPages].filter(
              (page) => page >= 1 && page <= totalPages,
            ),
          ),
        ).sort((a, b) => a - b);

  return (
    <Panel>
      <SectionHeader
        eyebrow="Directory"
        title="Registered user base"
        body="A cleaner admin table with fast filtering, session visibility, and status-driven scanning for operations and trust teams."
        action={
          <div className="flex flex-wrap gap-3">
            <label className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Rows
              </span>
              <select
                value={pageSize}
                onChange={(e) =>
                  onPageSizeChange(Number(e.target.value) as 10 | 25 | 50 | 100)
                }
                className="tactical-input h-11 min-w-[110px] px-3"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
            <label className="space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Status
              </span>
              <select
                value={statusFilter}
                onChange={(e) => onStatusFilterChange(e.target.value as UserBaseFilter)}
                className="tactical-input h-11 min-w-[170px] px-3"
              >
                {userBaseFilterOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      />

      <div className="mt-5 flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <p>
          {totalCount} users matched • page {currentPage} of {totalPages}
        </p>
        <p>Active sessions highlighted separately from restriction state.</p>
      </div>

      {error && (
        <div className="mt-5 rounded-[20px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {!error && loading && <div className="mt-5"><EmptyState label="Loading user directory..." /></div>}
      {!error && !loading && users.length === 0 && (
        <div className="mt-5">
          <EmptyState label="No users matched the current filter." />
        </div>
      )}

      {!error && !loading && users.length > 0 && (
        <>
          <div className="mt-5 hidden overflow-hidden rounded-[24px] border border-border/70 xl:block">
            <table className="min-w-full text-sm">
              <thead className="bg-background/55 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Last seen</th>
                  <th className="px-4 py-3">Sessions</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.userId} className="border-t border-border/70 bg-card/20 align-top">
                    <td className="px-4 py-4">
                      <p className="font-semibold text-foreground">
                        {user.username ? `@${user.username}` : "Unnamed account"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">{user.userId}</p>
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {user.notificationEmail || "-"}
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {formatDate(user.createdAt)}
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {formatDate(user.lastSeenAt || 0)}
                    </td>
                    <td className="px-4 py-4">
                      <span className="text-sm font-semibold text-foreground">
                        {user.activeSessionCount}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <UserStatusBadge user={user} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 space-y-3 xl:hidden">
            {users.map((user) => (
              <article
                key={user.userId}
                className="rounded-[22px] border border-border/70 bg-background/30 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {user.username ? `@${user.username}` : "Unnamed account"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{user.userId}</p>
                  </div>
                  <UserStatusBadge user={user} />
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <InfoRow label="Created" value={formatDate(user.createdAt)} />
                  <InfoRow label="Last seen" value={formatDate(user.lastSeenAt || 0)} />
                  <InfoRow label="Email" value={user.notificationEmail || "-"} />
                  <InfoRow label="Sessions" value={String(user.activeSessionCount)} />
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          className="tactical-chip-button disabled:opacity-50"
        >
          Prev
        </button>

        {pageNumbers.map((page, index) => {
          const previous = index > 0 ? pageNumbers[index - 1] : page;
          const needsGap = page - previous > 1;

          return (
            <div key={page} className="contents">
              {needsGap && <span className="px-1 text-xs text-muted-foreground">...</span>}
              <button
                type="button"
                onClick={() => onPageChange(page)}
                className={
                  page === currentPage ? "tactical-chip-button bg-primary text-primary-foreground" : "tactical-chip-button"
                }
              >
                {page}
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
          className="tactical-chip-button disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </Panel>
  );
}

type UserModerationSectionProps = {
  query: string;
  onQueryChange: (value: string) => void;
  searchResult: SearchResult | null;
  searchError: string;
  reason: string;
  ipRestrictedBan: boolean;
  busyAction: string;
  onReasonChange: (value: string) => void;
  onIpRestrictedChange: (value: boolean) => void;
  onSearch: () => Promise<void>;
  onBan: () => Promise<void>;
  onUnban: () => Promise<void>;
};

function UserModerationSection({
  query,
  onQueryChange,
  searchResult,
  searchError,
  reason,
  ipRestrictedBan,
  busyAction,
  onReasonChange,
  onIpRestrictedChange,
  onSearch,
  onBan,
  onUnban,
}: UserModerationSectionProps) {
  return (
    <div className="space-y-5">
      <Panel>
        <SectionHeader
          eyebrow="Investigations"
          title="Operator search and moderation controls"
          body="Search by username, review the account dossier, inspect IP history, and apply an action without switching contexts."
        />

        <div className="mt-5 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search a username"
              className="tactical-input h-12 w-full pl-11 pr-4"
            />
          </div>
          <button
            type="button"
            onClick={() => void onSearch()}
            disabled={busyAction === "search"}
            className="tactical-button h-12"
          >
            {busyAction === "search" ? "Searching" : "Open account dossier"}
          </button>
        </div>

        {searchError && (
          <div className="mt-5 rounded-[20px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {searchError}
          </div>
        )}
      </Panel>

      {!searchResult && !searchError && (
        <Panel>
          <EmptyState label="Search for a user to inspect profile signals, passkey state, session behavior, and moderation history." />
        </Panel>
      )}

      {searchResult && (
        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <Panel>
            <SectionHeader
              eyebrow="User Dossier"
              title={`@${searchResult.username}`}
              body="Operational profile for moderation review, including identity metadata, session readiness, and the latest known network signal."
            />

            <div className="mt-5 grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              <InfoRow label="User ID" value={searchResult.userId} />
              <InfoRow label="Created" value={formatDate(searchResult.createdAt)} />
              <InfoRow
                label="Notification email"
                value={searchResult.notificationEmail || "-"}
              />
              <InfoRow label="Groups" value={String(searchResult.totalGroupCount)} />
              <InfoRow
                label="Individual chats"
                value={String(searchResult.totalIndividualChatCount)}
              />
              <InfoRow label="Latest IP" value={searchResult.latestIpAddress || "-"} />
              <InfoRow
                label="Passkey"
                value={searchResult.passkeyEnabled ? "Enabled" : "Disabled"}
              />
              <InfoRow
                label="Passkey created"
                value={formatDate(searchResult.passkeyCreatedAt || 0)}
              />
              <InfoRow
                label="Passkey last used"
                value={formatDate(searchResult.passkeyLastUsedAt || 0)}
              />
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <StatusBadge
                label={searchResult.banned ? "Banned" : "Not banned"}
                tone={searchResult.banned ? "danger" : "success"}
              />
              <StatusBadge
                label={searchResult.ipRestricted ? "IP restricted" : "IP open"}
                tone={searchResult.ipRestricted ? "danger" : "neutral"}
              />
            </div>

            {searchResult.banReason && (
              <div className="mt-4 rounded-[20px] border border-border/70 bg-background/30 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Current restriction reason
                </p>
                <p className="mt-2 text-sm text-foreground">{searchResult.banReason}</p>
              </div>
            )}

            <div className="mt-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                IP activity log
              </p>
              <div className="mt-3 overflow-hidden rounded-[24px] border border-border/70">
                <table className="min-w-full text-sm">
                  <thead className="bg-background/55 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Timestamp</th>
                      <th className="px-4 py-3">IP address</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(searchResult.ipLogs || []).length === 0 && (
                      <tr className="border-t border-border/70">
                        <td className="px-4 py-6 text-muted-foreground" colSpan={3}>
                          No IP history is currently available for this account.
                        </td>
                      </tr>
                    )}
                    {(searchResult.ipLogs || []).map((log, index) => (
                      <tr
                        key={`${log.createdAt}-${log.ipAddress}-${index}`}
                        className="border-t border-border/70 bg-card/20"
                      >
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(log.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-foreground">{log.ipAddress}</td>
                        <td className="px-4 py-3 text-muted-foreground">{log.action}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>

          <Panel>
            <SectionHeader
              eyebrow="Enforcement"
              title="Apply moderation action"
              body="Actions are grouped here so the operational decision is separated from the discovery workflow."
            />

            <div className="mt-5 space-y-4">
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Moderation reason
                </span>
                <input
                  value={reason}
                  onChange={(e) => onReasonChange(e.target.value)}
                  placeholder="Violation of terms of service"
                  className="tactical-input h-12 w-full px-4"
                />
              </label>

              <label className="flex items-center justify-between rounded-[20px] border border-border/70 bg-background/30 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">Enable IP restriction</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Blocks the latest known network identity alongside the account.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={ipRestrictedBan}
                  onChange={(e) => onIpRestrictedChange(e.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void onBan()}
                  disabled={busyAction === "ban"}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-[18px] border border-red-500/35 bg-red-500/10 px-4 text-sm font-semibold uppercase tracking-[0.18em] text-red-200 transition hover:bg-red-500/15 disabled:opacity-50"
                >
                  <UserX className="h-4 w-4" />
                  {busyAction === "ban" ? "Applying..." : "Ban account"}
                </button>
                <button
                  type="button"
                  onClick={() => void onUnban()}
                  disabled={busyAction === "unban"}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-[18px] border border-primary/35 bg-primary/10 px-4 text-sm font-semibold uppercase tracking-[0.18em] text-primary transition hover:bg-primary/15 disabled:opacity-50"
                >
                  <Ban className="h-4 w-4" />
                  {busyAction === "unban" ? "Applying..." : "Restore account"}
                </button>
              </div>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

function BannedUsersSection({ bannedUsers }: { bannedUsers: BannedUserRecord[] }) {
  return (
    <Panel>
      <SectionHeader
        eyebrow="Restrictions"
        title="Active ban inventory"
        body="Restriction records are laid out for quick audit, including whether the enforcement includes network-level blocking."
      />

      <div className="mt-5 overflow-hidden rounded-[24px] border border-border/70">
        <table className="min-w-full text-sm">
          <thead className="bg-background/55 text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <tr>
              <th className="px-4 py-3">User ID</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Banned at</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3">By</th>
              <th className="px-4 py-3">Scope</th>
            </tr>
          </thead>
          <tbody>
            {bannedUsers.length === 0 && (
              <tr className="border-t border-border/70">
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  No active restrictions are currently recorded.
                </td>
              </tr>
            )}
            {bannedUsers.map((record) => (
              <tr key={record.userId} className="border-t border-border/70 bg-card/20 align-top">
                <td className="px-4 py-4 font-medium text-foreground">{record.userId}</td>
                <td className="px-4 py-4 text-muted-foreground">{record.reason || "-"}</td>
                <td className="px-4 py-4 text-muted-foreground">{formatDate(record.bannedAt)}</td>
                <td className="px-4 py-4 text-muted-foreground">{formatDate(record.updatedAt)}</td>
                <td className="px-4 py-4 text-muted-foreground">{record.bannedBy || "admin"}</td>
                <td className="px-4 py-4">
                  <StatusBadge
                    label={record.ipRestricted ? "Account + IP" : "Account only"}
                    tone={record.ipRestricted ? "danger" : "warning"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type AppealsSectionProps = {
  appeals: AppealRecord[];
  busyAction: string;
  onResolveAppeal: (appealId: string, action: "approve" | "keep-banned") => Promise<void>;
};

function AppealsSection({ appeals, busyAction, onResolveAppeal }: AppealsSectionProps) {
  return (
    <Panel>
      <SectionHeader
        eyebrow="Review Queue"
        title="Appeals and final decisions"
        body="Each appeal exposes the reporting details, moderation target, and its final disposition so different admins can process requests in parallel."
      />

      <div className="mt-5 space-y-4">
        {appeals.length === 0 && <EmptyState label="No appeals have been submitted." />}

        {appeals.map((appeal) => (
          <article
            key={appeal.id}
            className="rounded-[24px] border border-border/70 bg-background/30 p-4"
          >
            <div className="grid gap-4 xl:grid-cols-[1.5fr_0.9fr]">
              <div className="grid gap-4 sm:grid-cols-2">
                <InfoRow label="Type" value={appeal.type} />
                <InfoRow label="Appeal ID" value={appeal.id} />
                <InfoRow label="User" value={appeal.userId || "-"} />
                <InfoRow label="IP" value={appeal.ipAddress || "-"} />
                <InfoRow label="Contact" value={appeal.contactEmail} />
                <InfoRow label="Submitted" value={formatDate(appeal.createdAt)} />
                <div className="sm:col-span-2">
                  <InfoRow label="Message" value={appeal.message} />
                </div>
              </div>

              <div className="rounded-[20px] border border-border/70 bg-card/35 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">Decision state</p>
                  <StatusBadge
                    label={appeal.status}
                    tone={
                      appeal.status === "approved"
                        ? "success"
                        : appeal.status === "rejected"
                          ? "danger"
                          : "warning"
                    }
                  />
                </div>

                {appeal.status === "pending" ? (
                  <div className="mt-4 grid gap-3">
                    <button
                      type="button"
                      onClick={() => void onResolveAppeal(appeal.id, "approve")}
                      disabled={busyAction === `appeal-${appeal.id}-approve`}
                      className="inline-flex h-11 items-center justify-center rounded-[18px] border border-primary/35 bg-primary/10 px-4 text-xs font-semibold uppercase tracking-[0.18em] text-primary transition hover:bg-primary/15 disabled:opacity-50"
                    >
                      {busyAction === `appeal-${appeal.id}-approve`
                        ? "Processing..."
                        : "Approve appeal"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onResolveAppeal(appeal.id, "keep-banned")}
                      disabled={busyAction === `appeal-${appeal.id}-keep-banned`}
                      className="inline-flex h-11 items-center justify-center rounded-[18px] border border-red-500/35 bg-red-500/10 px-4 text-xs font-semibold uppercase tracking-[0.18em] text-red-200 transition hover:bg-red-500/15 disabled:opacity-50"
                    >
                      {busyAction === `appeal-${appeal.id}-keep-banned`
                        ? "Processing..."
                        : "Keep restriction"}
                    </button>
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Reviewed by {appeal.reviewedBy || "admin"} on{" "}
                    {formatDate(appeal.reviewedAt || 0)}.
                  </p>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}

type BackupsSectionProps = {
  status: BackupStatusResponse | null;
  statusError: string;
  loading: boolean;
  details: Record<string, RestorePointDetail>;
  busyRestorePoint: string;
  onRefresh: () => void;
  onInspect: (restorePointId: string) => void;
};

function BackupsSection({
  status,
  statusError,
  loading,
  details,
  busyRestorePoint,
  onRefresh,
  onInspect,
}: BackupsSectionProps) {
  const backup = status?.backup ?? null;
  const healthTone =
    status?.health.state === "healthy"
      ? "success"
      : status?.health.state === "failing"
        ? "danger"
        : status?.health.state === "stale"
          ? "warning"
          : "neutral";

  return (
    <div className="space-y-5">
      <Panel>
        <SectionHeader
          eyebrow="Data & Backups"
          title="Where your data lives"
          body="The app reads and writes only the database on this machine. Cloudflare R2 holds encrypted copies and is never read by the app."
          action={
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/40 px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/40 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          }
        />

        {statusError ? (
          <p className="mt-4 rounded-[22px] border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {statusError}
          </p>
        ) : null}

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-[24px] border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold text-foreground">
                  Live store (in use)
                </p>
              </div>
              <StatusBadge
                label={status?.live.connected ? "Connected" : "Offline"}
                tone={status?.live.connected ? "success" : "danger"}
              />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoRow label="Type" value="PostgreSQL on this machine" />
              <InfoRow
                label="Database"
                value={`${status?.live.database ?? "voltex_sms"} @ ${status?.live.host ?? "127.0.0.1"}`}
              />
              <InfoRow
                label="Accounts"
                value={
                  status?.live.counts.users === null ||
                  status?.live.counts.users === undefined
                    ? "unknown"
                    : formatCompactNumber(status.live.counts.users)
                }
              />
              <InfoRow
                label="Messages"
                value={
                  status?.live.counts.messages === null ||
                  status?.live.counts.messages === undefined
                    ? "unknown"
                    : formatCompactNumber(status.live.counts.messages)
                }
              />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              All reads and writes go here. This is not affected by anything on this
              page.
            </p>
          </div>

          <div className="rounded-[24px] border border-border/70 bg-background/35 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <DatabaseBackup className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold text-foreground">
                  Backup copy (Cloudflare R2)
                </p>
              </div>
              <StatusBadge
                label={status?.health.state ?? "unknown"}
                tone={healthTone as "success" | "danger" | "warning" | "neutral"}
              />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <InfoRow label="Bucket" value={backup?.bucket ?? "not configured"} />
              <InfoRow
                label="Last backup"
                value={formatDuration(backup?.lastBackupAgeSeconds ?? null)}
              />
              <InfoRow
                label="Checked every"
                value={
                  backup ? `${backup.watcher.checkIntervalSeconds} seconds` : "unknown"
                }
              />
              <InfoRow
                label="Restore points"
                value={String(backup?.restorePointCount ?? 0)}
              />
            </div>
            {backup ? (
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {formatBytes(backup.storage.usedBytes)} of{" "}
                    {formatBytes(backup.storage.freeAllowanceBytes)} free allowance
                  </span>
                  <span>{(backup.storage.usedPercent ?? 0).toFixed(2)}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-background/60">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(100, Math.max(0.5, backup.storage.usedPercent ?? 0))}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}
            <p className="mt-4 text-xs text-muted-foreground">
              {status?.health.detail ?? "The backup service has not reported yet."}
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          eyebrow="Restore points"
          title="Read a backup without touching the live site"
          body="Opening a restore point unpacks a private copy and reports what it contains. The live database is never modified."
        />

        {!backup || backup.restorePoints.length === 0 ? (
          <div className="mt-4">
            <EmptyState label="No restore points yet." />
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {backup.restorePoints.map((point) => {
              const detail = details[point.id];
              const pending =
                busyRestorePoint === point.id ||
                detail?.status === "queued" ||
                detail?.status === "running";

              return (
                <div
                  key={point.id}
                  className="rounded-[24px] border border-border/70 bg-background/35 p-4"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-mono text-sm text-foreground">{point.id}</p>
                        <StatusBadge
                          label={point.reason === "change" ? "Auto" : point.reason}
                          tone="neutral"
                        />
                      </div>
                      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock3 className="h-3.5 w-3.5" />
                        {point.takenAtEpoch
                          ? `${formatDate(point.takenAtEpoch * 1000)} (${formatRelativeTime(point.takenAtEpoch * 1000)})`
                          : point.takenAt}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onInspect(point.id)}
                      disabled={pending}
                      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border/70 bg-background/50 px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/40 disabled:opacity-60"
                    >
                      {pending ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="h-4 w-4" />
                      )}
                      {detail?.status === "ready" ? "Reload contents" : "Open contents"}
                    </button>
                  </div>

                  {detail?.status === "failed" ? (
                    <p className="mt-3 rounded-[18px] border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                      {detail.error || "Could not open this restore point."}
                    </p>
                  ) : null}

                  {detail?.status === "ready" ? (
                    <div className="mt-4 space-y-3 border-t border-border/70 pt-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <InfoRow
                          label="Files inside"
                          value={`${formatCompactNumber(detail.fileCount ?? 0)} files, ${formatBytes(detail.fileBytes ?? 0)}`}
                        />
                        <InfoRow
                          label="Tables captured"
                          value={String(
                            Object.keys(detail.databaseTables ?? {}).length,
                          )}
                        />
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {Object.entries(detail.databaseTables ?? {})
                          .filter(([, rows]) => rows > 0)
                          .map(([table, rows]) => (
                            <div
                              key={table}
                              className="flex items-center justify-between rounded-[16px] border border-border/60 bg-background/40 px-3 py-2"
                            >
                              <span className="truncate text-xs text-muted-foreground">
                                {table}
                              </span>
                              <span className="ml-2 text-sm font-semibold text-foreground">
                                {formatCompactNumber(rows)}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default function AdminDashboard() {
  const [token, setToken] = useState<string>(readAdminToken());
  const [currentAdmin, setCurrentAdmin] = useState("admin");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [bannedUsers, setBannedUsers] = useState<BannedUserRecord[]>([]);
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [adminAccess, setAdminAccess] = useState<AdminAccess | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState("");
  const [reason, setReason] = useState("Violation of terms of service");
  const [ipRestrictedBan, setIpRestrictedBan] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [userBaseData, setUserBaseData] = useState<UserBaseResponse | null>(null);
  const [userBaseLoading, setUserBaseLoading] = useState(false);
  const [userBaseError, setUserBaseError] = useState("");
  const [userBasePage, setUserBasePage] = useState(1);
  const [userBasePageSize, setUserBasePageSize] = useState<10 | 25 | 50 | 100>(25);
  const [userBaseStatus, setUserBaseStatus] = useState<UserBaseFilter>("all");
  const [backupStatus, setBackupStatus] = useState<BackupStatusResponse | null>(
    null,
  );
  const [backupError, setBackupError] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);
  const [restorePointDetails, setRestorePointDetails] = useState<
    Record<string, RestorePointDetail>
  >({});
  const [busyRestorePoint, setBusyRestorePoint] = useState("");

  const adminHeaders = useMemo(
    () => ({
      "Content-Type": "application/json",
      "X-Admin-Session": token,
    }),
    [token],
  );

  const clearAdminSession = () => {
    setToken("");
    setMetrics(null);
    setSearchResult(null);
    setSearchError("");
    setUserBaseData(null);
    setUserBaseError("");
    setUserBasePage(1);
    setAdminAccess(null);
    setCurrentAdmin("admin");
    saveAdminToken("");
  };

  const loadAdminContext = async () => {
    if (!token) return;
    const response = await fetch("/api/admin/panel/me", {
      headers: {
        "X-Admin-Session": token,
      },
    });
    if (response.status === 401) {
      clearAdminSession();
      return;
    }
    const payload = (await response.json()) as {
      error?: string;
      username?: string;
      adminAccess?: AdminAccess;
    };
    if (!response.ok) {
      throw new Error(payload.error || "Failed to load admin context");
    }
    setCurrentAdmin(payload.username || "admin");
    setAdminAccess(payload.adminAccess || null);
  };

  const loadOverview = async () => {
    if (!token) return;
    try {
      const response = await fetch("/api/admin/panel/overview", {
        headers: adminHeaders,
      });
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as {
        error?: string;
        metrics?: Metrics;
        bannedUsers?: BannedUserRecord[];
        appeals?: AppealRecord[];
        adminAccess?: AdminAccess;
        timestamp?: number;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load admin overview");
      }
      setMetrics(payload.metrics || null);
      setBannedUsers(payload.bannedUsers || []);
      setAppeals(payload.appeals || []);
      setAdminAccess(payload.adminAccess || null);
      setLastUpdatedAt(payload.timestamp || Date.now());
    } catch (overviewError) {
      setError(
        overviewError instanceof Error
          ? overviewError.message
          : "Failed to load admin overview",
      );
    }
  };

  const loadBackupStatus = async () => {
    if (!token) return;
    setBackupLoading(true);
    setBackupError("");
    try {
      const response = await fetch("/api/admin/panel/backups", {
        headers: adminHeaders,
      });
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as BackupStatusResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load backup status");
      }
      setBackupStatus(payload);
      if (!payload.configured) {
        setBackupError(
          "The backup service has not reported yet. It publishes status once it has run.",
        );
      }
    } catch (statusError) {
      setBackupError(
        statusError instanceof Error
          ? statusError.message
          : "Failed to load backup status",
      );
    } finally {
      setBackupLoading(false);
    }
  };

  const pollRestorePoint = async (restorePointId: string, attempt = 0) => {
    if (!token || attempt > 40) {
      setBusyRestorePoint("");
      return;
    }
    try {
      const response = await fetch(
        `/api/admin/panel/backups/restore-points/${encodeURIComponent(restorePointId)}`,
        { headers: adminHeaders },
      );
      const payload = (await response.json()) as RestorePointDetail;
      setRestorePointDetails((current) => ({
        ...current,
        [restorePointId]: payload,
      }));
      if (payload.status === "queued" || payload.status === "running" || payload.status === "not-requested") {
        window.setTimeout(() => {
          void pollRestorePoint(restorePointId, attempt + 1);
        }, 2000);
        return;
      }
      setBusyRestorePoint("");
    } catch {
      setBusyRestorePoint("");
    }
  };

  const inspectRestorePoint = async (restorePointId: string) => {
    if (!token) return;
    setBusyRestorePoint(restorePointId);
    setRestorePointDetails((current) => ({
      ...current,
      [restorePointId]: { status: "queued", restorePointId },
    }));
    try {
      const response = await fetch("/api/admin/panel/backups/inspect", {
        method: "POST",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ restorePointId }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || "Could not open that restore point");
      }
      void pollRestorePoint(restorePointId);
    } catch (inspectError) {
      setRestorePointDetails((current) => ({
        ...current,
        [restorePointId]: {
          status: "failed",
          restorePointId,
          error:
            inspectError instanceof Error
              ? inspectError.message
              : "Could not open that restore point",
        },
      }));
      setBusyRestorePoint("");
    }
  };

  const loadUserBase = async (
    nextPage: number = userBasePage,
    nextPageSize: 10 | 25 | 50 | 100 = userBasePageSize,
    nextStatus: UserBaseFilter = userBaseStatus,
  ) => {
    if (!token) return;
    setUserBaseLoading(true);
    setUserBaseError("");
    try {
      const response = await fetch(
        `/api/admin/panel/users?page=${encodeURIComponent(String(nextPage))}&pageSize=${encodeURIComponent(
          String(nextPageSize),
        )}&status=${encodeURIComponent(nextStatus)}`,
        {
          headers: {
            "X-Admin-Session": token,
          },
        },
      );

      if (response.status === 401) {
        clearAdminSession();
        return;
      }

      const payload = (await response.json()) as UserBaseResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to load users");
      }
      setUserBaseData(payload);
      setUserBasePage(payload.page || nextPage);
    } catch (listError) {
      setUserBaseError(
        listError instanceof Error ? listError.message : "Failed to load users",
      );
    } finally {
      setUserBaseLoading(false);
    }
  };

  useEffect(() => {
    if (!token) return;
    setError("");
    void Promise.all([loadAdminContext(), loadOverview(), loadBackupStatus()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void loadUserBase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, userBasePage, userBasePageSize, userBaseStatus]);

  useEffect(() => {
    if (!token) return;
    const intervalId = window.setInterval(() => {
      void Promise.all([loadAdminContext(), loadOverview(), loadBackupStatus()]);
    }, 60_000);

    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/admin/panel/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, username, password }),
      });
      const payload = (await response.json()) as {
        error?: string;
        token?: string;
        username?: string;
      };
      if (!response.ok || !payload.token) {
        throw new Error(payload.error || "Invalid admin credentials");
      }

      setToken(payload.token);
      setCurrentAdmin(payload.username || "admin");
      saveAdminToken(payload.token);
      setPassword("");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Failed to login");
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    if (!token) return;
    await fetch("/api/admin/panel/logout", {
      method: "POST",
      headers: {
        "X-Admin-Session": token,
      },
    }).catch(() => undefined);
    clearAdminSession();
  };

  const searchUser = async () => {
    if (!query.trim()) {
      setSearchError("Enter a username");
      return;
    }
    setSearchError("");
    setBusyAction("search");
    try {
      const response = await fetch(
        `/api/admin/panel/users/search?username=${encodeURIComponent(query.trim())}`,
        {
          headers: {
            "X-Admin-Session": token,
          },
        },
      );
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as { error?: string; user?: SearchResult };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || "Failed to search user");
      }
      setSearchResult(payload.user);
    } catch (searchErr) {
      setSearchResult(null);
      setSearchError(searchErr instanceof Error ? searchErr.message : "Search failed");
    } finally {
      setBusyAction("");
    }
  };

  const banCurrentUser = async () => {
    if (!searchResult?.userId) return;
    setBusyAction("ban");
    try {
      const response = await fetch(
        `/api/admin/panel/users/${encodeURIComponent(searchResult.userId)}/ban`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({
            reason: reason.trim() || "Violation of terms of service",
            ipRestricted: ipRestrictedBan,
          }),
        },
      );
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to ban user");
      }
      await Promise.all([searchUser(), loadOverview(), loadUserBase()]);
    } catch (banError) {
      setSearchError(banError instanceof Error ? banError.message : "Ban failed");
    } finally {
      setBusyAction("");
    }
  };

  const unbanCurrentUser = async () => {
    if (!searchResult?.userId) return;
    setBusyAction("unban");
    try {
      const response = await fetch(
        `/api/admin/panel/users/${encodeURIComponent(searchResult.userId)}/unban`,
        {
          method: "POST",
          headers: {
            "X-Admin-Session": token,
          },
        },
      );
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to unban user");
      }
      await Promise.all([searchUser(), loadOverview(), loadUserBase()]);
    } catch (unbanError) {
      setSearchError(unbanError instanceof Error ? unbanError.message : "Unban failed");
    } finally {
      setBusyAction("");
    }
  };

  const resolveAppealAction = async (
    appealId: string,
    action: "approve" | "keep-banned",
  ) => {
    setBusyAction(`appeal-${appealId}-${action}`);
    try {
      const response = await fetch(
        `/api/admin/panel/appeals/${encodeURIComponent(appealId)}/resolve`,
        {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ action }),
        },
      );
      if (response.status === 401) {
        clearAdminSession();
        return;
      }
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Failed to resolve appeal");
      }
      await Promise.all([loadOverview(), loadUserBase()]);
    } catch (appealError) {
      setError(
        appealError instanceof Error ? appealError.message : "Appeal action failed",
      );
    } finally {
      setBusyAction("");
    }
  };

  const handleUserBasePageSizeChange = (value: 10 | 25 | 50 | 100) => {
    setUserBasePageSize(value);
    setUserBasePage(1);
  };

  const handleUserBaseStatusChange = (value: UserBaseFilter) => {
    setUserBaseStatus(value);
    setUserBasePage(1);
  };

  if (!token) {
    return (
      <div className="tactical-shell flex min-h-screen items-center justify-center px-4 py-8">
        <div className="grid w-full max-w-6xl gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <Panel className="relative overflow-hidden p-8 lg:p-10">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(72,216,183,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent_42%)]" />
            <div className="relative">
              <p className="tactical-kicker">Voltex Admin</p>
              <h1 className="mt-4 max-w-2xl text-4xl font-black tracking-[-0.06em] text-foreground lg:text-5xl">
                A serious control room for moderation, health, and concurrent admin coverage.
              </h1>
              <p className="mt-5 max-w-2xl text-base text-muted-foreground">
                The panel is structured for real operators: cleaner signal density, explicit session
                visibility, and section-by-section workflows instead of decorative widgets.
              </p>

              <div className="mt-8 grid gap-4 md:grid-cols-3">
                <article className="rounded-[24px] border border-border/70 bg-background/35 p-4">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  <p className="mt-4 text-sm font-semibold text-foreground">
                    Concurrent admin sessions
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Multiple admins can stay signed in and operate in parallel.
                  </p>
                </article>
                <article className="rounded-[24px] border border-border/70 bg-background/35 p-4">
                  <Globe2 className="h-5 w-5 text-primary" />
                  <p className="mt-4 text-sm font-semibold text-foreground">
                    Platform visibility
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Message health, queue pressure, restrictions, and appeals stay in one surface.
                  </p>
                </article>
                <article className="rounded-[24px] border border-border/70 bg-background/35 p-4">
                  <Clock3 className="h-5 w-5 text-primary" />
                  <p className="mt-4 text-sm font-semibold text-foreground">
                    Faster operator flow
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Investigation, enforcement, and backlog review are split into clean sections.
                  </p>
                </article>
              </div>
            </div>
          </Panel>

          <Panel className="p-8">
            <p className="tactical-kicker">Authorized Access</p>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.05em] text-foreground">
              Sign in to Admin
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Use any configured admin credential set. Existing sessions stay active across other
              admins and devices.
            </p>

            <form onSubmit={login} className="mt-8 space-y-5">
              {error && (
                <div className="rounded-[20px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                  {error}
                </div>
              )}

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Admin email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="tactical-input h-12 w-full px-4"
                  required
                />
              </label>

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Admin username
                </span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="operator username"
                  className="tactical-input h-12 w-full px-4"
                  required
                />
              </label>

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password"
                  className="tactical-input h-12 w-full px-4"
                  required
                />
              </label>

              <button type="submit" className="tactical-button h-12 w-full" disabled={loading}>
                {loading ? "Signing in..." : "Enter admin console"}
              </button>
            </form>
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div className="tactical-shell">
      <div className="mx-auto flex w-full max-w-[1700px] gap-5 px-4 py-5 lg:px-6 lg:py-6">
        <aside className="sticky top-6 hidden h-[calc(100vh-3rem)] w-[300px] shrink-0 overflow-auto rounded-[30px] border border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--card)/0.82)_100%)] p-5 shadow-[0_28px_80px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)] lg:block">
          <p className="tactical-kicker">Voltex Admin</p>
          <h2 className="mt-3 text-2xl font-black tracking-[-0.05em] text-foreground">
            Operations Console
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Professional moderation, system oversight, and concurrent admin access.
          </p>

          <div className="mt-6 rounded-[22px] border border-border/70 bg-background/35 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Signed in
            </p>
            <p className="mt-2 text-lg font-semibold text-foreground">@{currentAdmin}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {adminAccess?.activeSessionCount ?? 0} active admin sessions
            </p>
          </div>

          <nav className="mt-6 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.key}
                  to={sectionPath(item.key)}
                  className={({ isActive }) =>
                    `block rounded-[22px] border px-4 py-4 transition ${
                      isActive
                        ? "border-primary/30 bg-primary/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                        : "border-transparent bg-transparent hover:border-border/70 hover:bg-background/30"
                    }`
                  }
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl border border-border/70 bg-background/40 p-2 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{item.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
                    </div>
                  </div>
                </NavLink>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 space-y-5">
          <Panel className="overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(72,216,183,0.12),transparent_30%),linear-gradient(135deg,rgba(255,255,255,0.04),transparent_40%)]" />
            <div className="relative">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="tactical-kicker">Section By Section</p>
                  <h1 className="mt-3 text-3xl font-black tracking-[-0.06em] text-foreground lg:text-4xl">
                    Voltex administrative operations
                  </h1>
                  <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
                    The interface has been rebuilt around operational clarity: dense but readable
                    signal, professional moderation flows, and visible support for parallel admins.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void Promise.all([loadAdminContext(), loadOverview(), loadUserBase()])}
                    className="tactical-button-outline h-11 px-4"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </button>
                  <button
                    type="button"
                    onClick={() => void logout()}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[18px] border border-red-500/35 bg-red-500/10 px-4 text-sm font-semibold uppercase tracking-[0.18em] text-red-200 transition hover:bg-red-500/15"
                  >
                    <LogOut className="h-4 w-4" />
                    Logout
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Active admins
                  </p>
                  <p className="mt-3 text-2xl font-black tracking-[-0.05em] text-foreground">
                    {adminAccess?.activeSessionCount ?? 0}
                  </p>
                </article>
                <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Connected users
                  </p>
                  <p className="mt-3 text-2xl font-black tracking-[-0.05em] text-foreground">
                    {metrics?.connectedUsers ?? 0}
                  </p>
                </article>
                <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Pending appeals
                  </p>
                  <p className="mt-3 text-2xl font-black tracking-[-0.05em] text-foreground">
                    {metrics?.pendingAppeals ?? 0}
                  </p>
                </article>
                <article className="rounded-[22px] border border-border/70 bg-background/35 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Queue pressure
                  </p>
                  <p className="mt-3 text-2xl font-black tracking-[-0.05em] text-foreground">
                    {metrics?.queuedMessages ?? 0}
                  </p>
                </article>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2 lg:hidden">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.key}
                      to={sectionPath(item.key)}
                      className={({ isActive }) =>
                        `inline-flex items-center gap-3 rounded-[18px] border px-4 py-3 text-sm font-semibold transition ${
                          isActive
                            ? "border-primary/30 bg-primary/10 text-foreground"
                            : "border-border/70 bg-background/30 text-foreground hover:border-primary/25"
                        }`
                      }
                    >
                      <Icon className="h-4 w-4 text-primary" />
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          </Panel>

          {error && (
            <div className="rounded-[24px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          <Routes>
            <Route index element={<Navigate to="overview" replace />} />
            <Route
              path="overview"
              element={
                <OverviewSection
                  metrics={metrics}
                  adminAccess={adminAccess}
                  appeals={appeals}
                  bannedUsers={bannedUsers}
                  currentAdmin={currentAdmin}
                  lastUpdatedAt={lastUpdatedAt}
                />
              }
            />
            <Route
              path="users"
              element={
                <UserModerationSection
                  query={query}
                  onQueryChange={setQuery}
                  searchResult={searchResult}
                  searchError={searchError}
                  reason={reason}
                  ipRestrictedBan={ipRestrictedBan}
                  busyAction={busyAction}
                  onReasonChange={setReason}
                  onIpRestrictedChange={setIpRestrictedBan}
                  onSearch={searchUser}
                  onBan={banCurrentUser}
                  onUnban={unbanCurrentUser}
                />
              }
            />
            <Route
              path="user-base"
              element={
                <UserBaseSection
                  loading={userBaseLoading}
                  error={userBaseError}
                  data={userBaseData}
                  pageSize={userBasePageSize}
                  statusFilter={userBaseStatus}
                  onPageSizeChange={handleUserBasePageSizeChange}
                  onStatusFilterChange={handleUserBaseStatusChange}
                  onPageChange={setUserBasePage}
                />
              }
            />
            <Route path="banned" element={<BannedUsersSection bannedUsers={bannedUsers} />} />
            <Route
              path="appeals"
              element={
                <AppealsSection
                  appeals={appeals}
                  busyAction={busyAction}
                  onResolveAppeal={resolveAppealAction}
                />
              }
            />
            <Route
              path="backups"
              element={
                <BackupsSection
                  status={backupStatus}
                  statusError={backupError}
                  loading={backupLoading}
                  details={restorePointDetails}
                  busyRestorePoint={busyRestorePoint}
                  onRefresh={() => void loadBackupStatus()}
                  onInspect={(id) => void inspectRestorePoint(id)}
                />
              }
            />
            <Route path="*" element={<Navigate to="overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
