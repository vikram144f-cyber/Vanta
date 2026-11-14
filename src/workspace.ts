import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { VantaError } from './trueforge';

export interface WorkspaceScope {
  path: string;
  isAvailable(): boolean;
}

function normalizeDrive(path: string): string {
  return process.platform === 'win32' ? path.replace(/^[a-z]:/i, (drive) => drive.toUpperCase()) : path;
}

async function verifyRoot(scope: WorkspaceScope): Promise<string> {
  if (!scope.isAvailable() || !isAbsolute(scope.path)
    || (process.platform === 'win32' && !/^[a-z]:\\[^:]*$/i.test(scope.path))) {
    throw new VantaError('Workspace overview requires a trusted local folder.');
  }
  const root = normalizeDrive(resolve(scope.path));
  if (!basename(root) || normalizeDrive(await realpath(root)) !== root || !(await stat(root)).isDirectory()) {
    throw new VantaError('Workspace overview requires a canonical local folder.');
  }
  return root;
}

export async function bindOverview(scope: WorkspaceScope) {
  const root = await verifyRoot(scope);
  return async () => {
    if (await verifyRoot(scope) !== root) throw new VantaError('Workspace root changed.');
    const files: string[] = [];
    const folders: string[] = [];
    let scanned = 0;
    let truncated = false;
    for await (const entry of await opendir(root)) {
      if (++scanned > 2048 || files.length + folders.length >= 100) {
        truncated = true;
        break;
      }
      // Never descend or report links, dotfiles, suspicious names or dependency caches.
      const name = entry.name;
      if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,95}$/u.test(name)
        || /secret|credential|password|token|private|^id_(?:rsa|ed25519)|\.(?:pem|p12|pfx|key|keystore)$/i.test(name)
        || name.toLowerCase() === 'node_modules' || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) folders.push(name);
      else if (entry.isFile()) files.push(name);
    }
    if (!scope.isAvailable()) throw new VantaError('Workspace scope is no longer available.');
    return {
      root: basename(root), files: files.sort(), folders: folders.sort(),
      fileCount: files.length, folderCount: folders.length, truncated,
    };
  };
}
