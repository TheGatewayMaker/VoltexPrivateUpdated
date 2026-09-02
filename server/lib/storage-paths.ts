import path from "path";
import { fileURLToPath } from "url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(moduleDir, "../..");

export function getStorageDir(): string {
  return process.env.LOCAL_STORAGE_DIR || path.join("server", "data");
}

export function getStorageRoot(): string {
  return path.resolve(projectRoot, getStorageDir());
}

export const storageDir = getStorageDir();
export const storageRoot = getStorageRoot();
