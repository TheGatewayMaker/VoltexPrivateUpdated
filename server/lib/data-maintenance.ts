import fs from "fs/promises";
import path from "path";
import { storageRoot } from "./storage-paths";
import { logger } from "./logger";

interface IntegrityReport {
  scannedFiles: number;
  repairedTempFiles: number;
  quarantinedFiles: number;
  createdDirectories: number;
  startedAt: number;
  completedAt: number;
}

const systemRoot = path.join(storageRoot, "voltex-system");
const snapshotRoot = path.join(systemRoot, "snapshots");
const quarantineRoot = path.join(systemRoot, "quarantine");

let snapshotInterval: NodeJS.Timeout | null = null;
let lastIntegrityReport: IntegrityReport | null = null;
let lastSnapshotAt: number | null = null;

async function ensureBaseDirectories(): Promise<number> {
  const directories = [
    storageRoot,
    path.join(storageRoot, "voltex-users"),
    path.join(storageRoot, "voltex-recovery"),
    path.join(storageRoot, "voltex-messages"),
    path.join(storageRoot, "voltex-system"),
    snapshotRoot,
    quarantineRoot,
  ];

  let createdDirectories = 0;
  for (const directory of directories) {
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      createdDirectories += 1;
    } catch {
      // Ignore directory creation races.
    }
  }
  return createdDirectories;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
          return listFilesRecursive(fullPath);
        }
        return [fullPath];
      }),
    );

    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function quarantineFile(filePath: string): Promise<void> {
  const relativePath = path.relative(storageRoot, filePath).replace(/[\\/]/g, "__");
  const targetPath = path.join(
    quarantineRoot,
    `${relativePath}.${Date.now()}.corrupt`,
  );
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.rename(filePath, targetPath);
}

export async function runIntegrityRepair(): Promise<IntegrityReport> {
  const startedAt = Date.now();
  let scannedFiles = 0;
  let repairedTempFiles = 0;
  let quarantinedFiles = 0;
  const createdDirectories = await ensureBaseDirectories();

  const files = await listFilesRecursive(storageRoot);
  for (const filePath of files) {
    if (filePath.startsWith(snapshotRoot) || filePath.startsWith(quarantineRoot)) {
      continue;
    }

    scannedFiles += 1;

    if (filePath.endsWith(".tmp")) {
      await fs.unlink(filePath).catch(() => undefined);
      repairedTempFiles += 1;
      continue;
    }

    if (!filePath.endsWith(".json")) {
      continue;
    }

    try {
      const data = await fs.readFile(filePath, "utf8");
      JSON.parse(data);
    } catch (error) {
      logger.warn("Quarantining corrupt storage file", {
        filePath: path.relative(storageRoot, filePath),
        error: error instanceof Error ? error.message : String(error),
      });
      await quarantineFile(filePath);
      quarantinedFiles += 1;
    }
  }

  lastIntegrityReport = {
    scannedFiles,
    repairedTempFiles,
    quarantinedFiles,
    createdDirectories,
    startedAt,
    completedAt: Date.now(),
  };
  return lastIntegrityReport;
}

async function copyStorageDirectory(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (sourcePath === snapshotRoot || sourcePath.startsWith(snapshotRoot + path.sep)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyStorageDirectory(sourcePath, targetPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await fs.copyFile(sourcePath, targetPath);
  }
}

export async function createStorageSnapshot(): Promise<string> {
  await ensureBaseDirectories();
  const snapshotId = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(snapshotRoot, snapshotId);
  await copyStorageDirectory(storageRoot, targetDir);
  lastSnapshotAt = Date.now();
  return snapshotId;
}

export async function rotateSnapshots(retentionCount: number): Promise<void> {
  await ensureBaseDirectories();
  const entries = await fs.readdir(snapshotRoot, { withFileTypes: true });
  const snapshotDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const staleSnapshots = snapshotDirs.slice(retentionCount);
  for (const snapshot of staleSnapshots) {
    await fs.rm(path.join(snapshotRoot, snapshot), { recursive: true, force: true });
  }
}

export function startSnapshotScheduler(): void {
  if (snapshotInterval) {
    return;
  }

  const intervalMs = parseInt(process.env.SNAPSHOT_INTERVAL_MS || "3600000", 10);
  const retentionCount = parseInt(process.env.SNAPSHOT_RETENTION_COUNT || "24", 10);

  snapshotInterval = setInterval(() => {
    void createStorageSnapshot()
      .then(async (snapshotId) => {
        await rotateSnapshots(retentionCount);
        logger.info("Created storage snapshot", { snapshotId });
      })
      .catch((error) => {
        logger.error("Snapshot creation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  snapshotInterval.unref?.();
}

export async function initializeDataMaintenance(): Promise<void> {
  const report = await runIntegrityRepair();
  logger.info("Integrity repair completed", {
    scannedFiles: report.scannedFiles,
    repairedTempFiles: report.repairedTempFiles,
    quarantinedFiles: report.quarantinedFiles,
    createdDirectories: report.createdDirectories,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
  });
  startSnapshotScheduler();
}

export function getDataMaintenanceStatus(): {
  storageRoot: string;
  lastIntegrityReport: IntegrityReport | null;
  lastSnapshotAt: number | null;
  snapshotsEnabled: boolean;
} {
  return {
    storageRoot: path.relative(process.cwd(), storageRoot) || ".",
    lastIntegrityReport,
    lastSnapshotAt,
    snapshotsEnabled: snapshotInterval !== null,
  };
}
