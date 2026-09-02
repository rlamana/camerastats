import { opendir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { extensionOf, isIgnoredDirectory } from './extensions.js';

export interface ScanOptions {
  /** Descend into subdirectories. */
  recursive: boolean;
  /** Extensions (lowercase, no dot) to collect. */
  extensions: ReadonlySet<string>;
  /** Include dot-files and dot-directories. */
  includeHidden: boolean;
  /** Follow directory symlinks (guarded against cycles). */
  followSymlinks: boolean;
  /** Called for every directory that could not be read. */
  onError?: (path: string, error: NodeJS.ErrnoException) => void;
}

/**
 * Yield image paths under `root`, depth-first.
 *
 * This is a generator so the caller can start parsing EXIF while the walk is
 * still running; on a large card or archive the walk itself is a meaningful
 * chunk of the wall clock.
 */
export async function* walkImages(root: string, options: ScanOptions): AsyncGenerator<string> {
  const seenDirectories = new Set<string>();
  yield* walk(resolve(root), options, seenDirectories, true);
}

async function* walk(
  directory: string,
  options: ScanOptions,
  seenDirectories: Set<string>,
  isRoot: boolean,
): AsyncGenerator<string> {
  // Guard against symlink loops by tracking resolved identities, not paths.
  if (options.followSymlinks || isRoot) {
    let real: string;
    try {
      real = await realpath(directory);
    } catch {
      real = directory;
    }
    if (seenDirectories.has(real)) return;
    seenDirectories.add(real);
  }

  let dir;
  try {
    dir = await opendir(directory);
  } catch (error) {
    options.onError?.(directory, error as NodeJS.ErrnoException);
    return;
  }

  const subdirectories: string[] = [];

  try {
    for await (const entry of dir) {
      const name = entry.name;
      if (!options.includeHidden && name.startsWith('.')) continue;

      const fullPath = join(directory, name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        try {
          const target = await stat(fullPath);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch (error) {
          options.onError?.(fullPath, error as NodeJS.ErrnoException);
          continue;
        }
      }

      if (isDirectory) {
        if (options.recursive && !isIgnoredDirectory(name)) subdirectories.push(fullPath);
        continue;
      }

      if (isFile && options.extensions.has(extensionOf(name))) yield fullPath;
    }
  } catch (error) {
    options.onError?.(directory, error as NodeJS.ErrnoException);
    return;
  }

  // Files first, then recurse — keeps output grouped per directory and keeps
  // memory flat regardless of tree depth.
  for (const subdirectory of subdirectories) {
    yield* walk(subdirectory, options, seenDirectories, false);
  }
}
