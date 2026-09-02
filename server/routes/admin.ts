import { RequestHandler } from "express";
import {
  getArchivalJobStatus,
  runArchivalJob,
  getDefaultArchivalConfig,
} from "../lib/archival-job";
import { getDatabaseStats } from "../lib/db-messages";
import { isDatabaseConnected } from "../lib/db";
import {
  getConnectedUserCount,
  getConnectedUserIds,
  getQueueStats,
} from "../lib/messaging";
import { getLocalStorageRoot } from "../lib/r2-storage";
import { getCloudBackupStatus } from "../lib/cloud-backup";
import { getDataMaintenanceStatus } from "../lib/data-maintenance";
import fs from "fs/promises";
import path from "path";
import { storageRoot } from "../lib/storage-paths";

async function getDirectorySize(root: string): Promise<number> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return getDirectorySize(fullPath);
        }
        const stat = await fs.stat(fullPath);
        return stat.size;
      }),
    );
    return sizes.reduce((sum, value) => sum + value, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

/**
 * GET /api/admin/health
 * Check if database and archival system are healthy
 */
export const handleHealthCheck: RequestHandler = async (req, res) => {
  try {
    const dbConnected = isDatabaseConnected();
    const stats = dbConnected ? await getDatabaseStats() : null;
    const archivalStatus = dbConnected ? getArchivalJobStatus() : null;
    const storageBytes = await getDirectorySize(storageRoot);

    res.status(200).json({
      status: "healthy",
      app: {
        publicOrigin:
          process.env.PUBLIC_APP_ORIGIN || "https://voltexchat.online",
      },
      database: {
        connected: dbConnected,
        stats: stats,
      },
      archival: {
        status: archivalStatus,
      },
      backup: getCloudBackupStatus(),
      maintenance: getDataMaintenanceStatus(),
      storage: {
        root: getLocalStorageRoot(),
        bytes: storageBytes,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: Date.now(),
    });
  }
};

/**
 * GET /api/admin/archival-status
 * Get current archival job status
 */
export const handleArchivalStatus: RequestHandler = async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        error: "Database not connected",
        message: "Archival system requires PostgreSQL connection",
      });
    }

    const status = getArchivalJobStatus();
    const stats = await getDatabaseStats();

    res.status(200).json({
      archival: status,
      database: stats,
      config: getDefaultArchivalConfig(),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Archival status error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * GET /api/admin/database-stats
 * Get detailed database statistics
 */
export const handleDatabaseStats: RequestHandler = async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        error: "Database not connected",
        message: "Requires PostgreSQL connection",
      });
    }

    const stats = await getDatabaseStats();

    res.status(200).json({
      messages: {
        total: stats.total,
        archived: stats.archived,
        active: stats.active,
        archivalPercentage:
          stats.total > 0
            ? ((stats.archived / stats.total) * 100).toFixed(2) + "%"
            : "0%",
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Database stats error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * POST /api/admin/run-archival
 * Manually trigger archival job (for testing/maintenance)
 * Requires admin authentication (can be extended with auth middleware)
 */
export const handleRunArchival: RequestHandler = async (req, res) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({
        error: "Database not connected",
        message: "Archival system requires PostgreSQL connection",
      });
    }

    console.log("Manual archival job triggered");

    const result = await runArchivalJob();

    res.status(200).json({
      success: true,
      result: {
        archived: result.archived,
        deleted: result.deleted,
      },
      message: `Archival complete: ${result.archived} messages archived, ${result.deleted} deleted from PostgreSQL`,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Manual archival error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
      success: false,
    });
  }
};

/**
 * GET /api/admin/archival-config
 * Get current archival job configuration
 */
export const handleArchivalConfig: RequestHandler = async (req, res) => {
  try {
    const config = getDefaultArchivalConfig();

    res.status(200).json({
      configuration: {
        intervalMs: config.intervalMs,
        intervalHours: (config.intervalMs / (60 * 60 * 1000)).toFixed(2),
        messageAgeMs: config.messageAgeMs,
        messageAgeHours: (config.messageAgeMs / (60 * 60 * 1000)).toFixed(2),
        batchSize: config.batchSize,
        deleteAfterArchival: config.deleteAfterArchival,
        deleteGraceMs: config.deleteGraceMs,
        deleteGraceMinutes: (config.deleteGraceMs / (60 * 1000)).toFixed(2),
      },
      environment: {
        archivalIntervalFromEnv: process.env.ARCHIVAL_INTERVAL_MS || "not set",
        messageAgeFromEnv: process.env.MESSAGE_AGE_MS || "not set",
        batchSizeFromEnv: process.env.ARCHIVAL_BATCH_SIZE || "not set",
        deleteAfterFromEnv: process.env.DELETE_AFTER_ARCHIVAL || "not set",
        deleteGraceFromEnv: process.env.DELETE_GRACE_MS || "not set",
      },
      note: "To change configuration, update environment variables and restart the application",
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Archival config error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * GET /api/admin/r2-diagnostics
 * Report local storage backend status
 */
export const handleR2Diagnostics: RequestHandler = async (req, res) => {
  try {
    const storageBytes = await getDirectorySize(storageRoot);
    res.status(200).json({
      storage: {
        mode: "local-filesystem",
        root: getLocalStorageRoot(),
        bytes: storageBytes,
      },
      r2Backup: getCloudBackupStatus(),
      maintenance: getDataMaintenanceStatus(),
      status: "✓ Ready",
      recommendation:
        "Project data is stored locally under the server/data directory, with optional Cloudflare R2 backup sync",
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Storage diagnostics error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
      status: "✗ Error",
    });
  }
};

/**
 * GET /api/admin/system-stats
 * Get real-time system statistics (connected users, queue size, etc)
 */
export const handleSystemStats: RequestHandler = async (req, res) => {
  try {
    const connectedUserCount = getConnectedUserCount();
    const queueStats = getQueueStats();
    const dbStats = isDatabaseConnected() ? await getDatabaseStats() : null;
    const storageBytes = await getDirectorySize(storageRoot);

    res.status(200).json({
      realtime: {
        connectedUsers: connectedUserCount,
        queuedMessages: queueStats.totalQueuedMessages,
        usersWithQueuedMessages: queueStats.usersWithQueuedMessages,
      },
      backup: getCloudBackupStatus(),
      maintenance: getDataMaintenanceStatus(),
      storage: {
        bytes: storageBytes,
      },
      database: dbStats
        ? {
            totalMessages: dbStats.total,
            activeMessages: dbStats.active,
            archivedMessages: dbStats.archived,
            connected: true,
          }
        : {
            connected: false,
            message: "Database not connected",
          },
      capacity: {
        maxConnectionPool: 100,
        maxQueuePerUser: 500,
        totalCapacity: "supports ~1000 concurrent users",
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("System stats error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
