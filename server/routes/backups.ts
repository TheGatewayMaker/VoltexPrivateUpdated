import { RequestHandler } from "express";
import fs from "fs/promises";
import path from "path";
import { isDatabaseConnected, queryOne } from "../lib/db";

// The backup watcher runs as a separate service and owns the R2 credentials.
// This module only reads the status files it publishes, so the web app never
// holds backup credentials and can never alter the live data source.
const STATE_DIR =
  process.env.VOLTEX_BACKUP_STATE_DIR || "/home/neoroot/voltex-backup/state";

const RESTORE_POINT_ID = /^[0-9a-f]{8}$/;
const STALE_AFTER_SECONDS = 7 * 60 * 60; // forced run is every 6h

interface LiveCounts {
  users: number | null;
  messages: number | null;
  conversations: number | null;
}

async function readSummary(): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, "summary.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readLiveCounts(): Promise<LiveCounts> {
  if (!isDatabaseConnected()) {
    return { users: null, messages: null, conversations: null };
  }

  try {
    const row = await queryOne<{
      users: string;
      messages: string;
      conversations: string;
    }>(
      `select
         (select count(*) from user_accounts) as users,
         (select count(*) from messages) as messages,
         (select count(*) from conversations) as conversations`,
    );

    return {
      users: row ? Number(row.users) : null,
      messages: row ? Number(row.messages) : null,
      conversations: row ? Number(row.conversations) : null,
    };
  } catch (error) {
    console.error("[BACKUPS] Failed to read live counts:", error);
    return { users: null, messages: null, conversations: null };
  }
}

function describeHealth(summary: any): {
  state: "healthy" | "stale" | "failing" | "unknown";
  detail: string;
} {
  if (!summary) {
    return {
      state: "unknown",
      detail: "The backup service has not reported yet.",
    };
  }

  if (summary.lastError) {
    return { state: "failing", detail: String(summary.lastError) };
  }

  const age = Number(summary.lastBackupAgeSeconds);
  if (!Number.isFinite(age)) {
    return { state: "unknown", detail: "No successful backup recorded yet." };
  }

  if (age > STALE_AFTER_SECONDS) {
    return {
      state: "stale",
      detail: `Last backup completed ${Math.floor(age / 3600)}h ago.`,
    };
  }

  return { state: "healthy", detail: "Backups are current." };
}

export const handleAdminPanelBackupStatus: RequestHandler = async (_req, res) => {
  try {
    const [summary, live] = await Promise.all([readSummary(), readLiveCounts()]);
    const health = describeHealth(summary);

    return res.status(200).json({
      configured: summary !== null,
      health,
      live: {
        kind: "postgresql",
        host: summary?.liveSource?.host ?? "127.0.0.1",
        database: summary?.liveSource?.database ?? "voltex_sms",
        role: "primary - all reads and writes",
        connected: isDatabaseConnected(),
        counts: live,
      },
      backup: summary
        ? {
            ...summary.backupTarget,
            lastBackupAt: summary.lastBackupAt,
            lastBackupAgeSeconds: summary.lastBackupAgeSeconds,
            lastBackupDurationSeconds: summary.lastBackupDurationSeconds,
            lastReachableAt: summary.lastReachableAt,
            storage: summary.storage,
            watcher: summary.watcher,
            restorePointCount: summary.restorePointCount,
            restorePoints: summary.restorePoints,
            generatedAt: summary.generatedAt,
          }
        : null,
    });
  } catch (error) {
    console.error("[BACKUPS] Failed to build backup status:", error);
    return res.status(500).json({ error: "Failed to read backup status" });
  }
};

export const handleAdminPanelInspectRestorePoint: RequestHandler = async (
  req,
  res,
) => {
  try {
    const id =
      typeof req.body?.restorePointId === "string"
        ? req.body.restorePointId.trim().toLowerCase()
        : "";

    if (!RESTORE_POINT_ID.test(id)) {
      return res.status(400).json({ error: "Invalid restore point id" });
    }

    const summary = await readSummary();
    if (!summary) {
      return res.status(503).json({ error: "Backup service is not reporting" });
    }

    const known = (summary.restorePoints || []).some(
      (point: any) => point.id === id,
    );
    if (!known) {
      return res.status(404).json({ error: "Unknown restore point" });
    }

    await fs.mkdir(path.join(STATE_DIR, "inspect-requests"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(STATE_DIR, "inspect-requests", `${id}.req`),
      `requested ${new Date().toISOString()}\n`,
      { mode: 0o640 },
    );

    return res.status(202).json({ status: "queued", restorePointId: id });
  } catch (error) {
    console.error("[BACKUPS] Failed to queue restore point inspection:", error);
    return res.status(500).json({ error: "Failed to queue inspection" });
  }
};

export const handleAdminPanelRestorePointDetail: RequestHandler = async (
  req,
  res,
) => {
  try {
    const id = String(req.params.restorePointId || "").toLowerCase();
    if (!RESTORE_POINT_ID.test(id)) {
      return res.status(400).json({ error: "Invalid restore point id" });
    }

    let raw: string;
    try {
      raw = await fs.readFile(
        path.join(STATE_DIR, "inspect-results", `${id}.json`),
        "utf8",
      );
    } catch {
      return res.status(200).json({ status: "not-requested", restorePointId: id });
    }

    return res.status(200).json(JSON.parse(raw));
  } catch (error) {
    console.error("[BACKUPS] Failed to read inspection result:", error);
    return res.status(500).json({ error: "Failed to read inspection result" });
  }
};
