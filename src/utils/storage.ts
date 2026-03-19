import fs from 'fs';
import path from 'path';
const BASE = process.env.STORAGE_PATH || '/data';
export async function uploadFile(localPath: string, key: string): Promise<string> {
  const dest = path.join(BASE, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(localPath, dest);
  return dest;
}
export async function downloadFile(storagePath: string, localPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.copyFileSync(storagePath, localPath);
}
