import fs from "fs/promises";
import path from "path";
import { isDatabaseConnected, query, queryOne } from "./db";
import { storageRoot } from "./storage-paths";

const BLOCK_ROOT = path.join(storageRoot, "voltex-system", "blocks");
const BLOCK_STATE_PATH = path.join(BLOCK_ROOT, "state.json");

interface StoredBlockRecord {
  blockerId: string;
  blockedId: string;
  createdAt: number;
}

interface BlockFileState {
  entries: Record<string, StoredBlockRecord>;
}

export interface DirectBlockStatus {
  blockedByMe: boolean;
  blockedMe: boolean;
  isMutual: boolean;
  canSend: boolean;
}

let blockFileCache: BlockFileState | null = null;
let writeChain: Promise<void> = Promise.resolve();

function now(): number {
  return Date.now();
}

function getPairKey(blockerId: string, blockedId: string): string {
  return `${blockerId}:${blockedId}`;
}

function buildStatus(blockedByMe: boolean, blockedMe: boolean): DirectBlockStatus {
  return {
    blockedByMe,
    blockedMe,
    isMutual: blockedByMe && blockedMe,
    canSend: !blockedByMe && !blockedMe,
  };
}

async function ensureBlockDir(): Promise<void> {
  await fs.mkdir(BLOCK_ROOT, { recursive: true });
}

async function loadFileState(): Promise<BlockFileState> {
  if (blockFileCache) {
    return blockFileCache;
  }

  await ensureBlockDir();
  try {
    const raw = await fs.readFile(BLOCK_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as BlockFileState;
    blockFileCache = {
      entries: parsed?.entries || {},
    };
  } catch {
    blockFileCache = { entries: {} };
  }

  return blockFileCache;
}

async function persistFileState(state: BlockFileState): Promise<void> {
  await ensureBlockDir();
  await fs.writeFile(BLOCK_STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

function enqueueFileWrite(
  updater: (state: BlockFileState) => void | Promise<void>,
): Promise<void> {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const state = await loadFileState();
      await updater(state);
      await persistFileState(state);
    })
    .catch((error) => {
      console.error("[BLOCK] Failed to persist block state:", error);
    });

  return writeChain;
}

async function getFileBlockStatus(
  userId: string,
  otherUserId: string,
): Promise<DirectBlockStatus> {
  const state = await loadFileState();
  const blockedByMe = Boolean(state.entries[getPairKey(userId, otherUserId)]);
  const blockedMe = Boolean(state.entries[getPairKey(otherUserId, userId)]);
  return buildStatus(blockedByMe, blockedMe);
}

export async function getDirectBlockStatus(
  userId: string,
  otherUserId: string,
): Promise<DirectBlockStatus> {
  if (!userId || !otherUserId || userId === otherUserId) {
    return buildStatus(false, false);
  }

  if (isDatabaseConnected()) {
    const row = await queryOne<{
      blocked_by_me: boolean;
      blocked_me: boolean;
    }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM user_blocks
           WHERE blocker_id = $1 AND blocked_id = $2
         ) AS blocked_by_me,
         EXISTS(
           SELECT 1 FROM user_blocks
           WHERE blocker_id = $2 AND blocked_id = $1
         ) AS blocked_me;`,
      [userId, otherUserId],
    );

    return buildStatus(Boolean(row?.blocked_by_me), Boolean(row?.blocked_me));
  }

  return getFileBlockStatus(userId, otherUserId);
}

export async function setUserBlock(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  if (!blockerId || !blockedId || blockerId === blockedId) {
    return;
  }

  if (isDatabaseConnected()) {
    await query(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id)
       DO UPDATE SET created_at = EXCLUDED.created_at;`,
      [blockerId, blockedId, now()],
    );
    return;
  }

  await enqueueFileWrite((state) => {
    const key = getPairKey(blockerId, blockedId);
    state.entries[key] = {
      blockerId,
      blockedId,
      createdAt: now(),
    };
  });
}

export async function removeUserBlock(
  blockerId: string,
  blockedId: string,
): Promise<void> {
  if (!blockerId || !blockedId || blockerId === blockedId) {
    return;
  }

  if (isDatabaseConnected()) {
    await query(
      `DELETE FROM user_blocks
       WHERE blocker_id = $1 AND blocked_id = $2;`,
      [blockerId, blockedId],
    );
    return;
  }

  await enqueueFileWrite((state) => {
    delete state.entries[getPairKey(blockerId, blockedId)];
  });
}

export async function isDirectMessageBlocked(
  senderId: string,
  recipientId: string,
): Promise<DirectBlockStatus> {
  return getDirectBlockStatus(senderId, recipientId);
}

export async function getTotalDirectBlockCount(): Promise<number> {
  if (isDatabaseConnected()) {
    const row = await queryOne<{ total: string }>(
      "SELECT COUNT(*)::text AS total FROM user_blocks;",
    );
    return Number.parseInt(row?.total || "0", 10) || 0;
  }

  const state = await loadFileState();
  return Object.keys(state.entries).length;
}
