// DISABLED: not wired into the `techsoup` command, which now imports a single
// PDC JSON file (see techsoup.ts). Kept for a future step that turns OKF
// markdown bundles (zip/folder) into that single JSON file.
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { logger } from './logger.js';
import { readOkfBundlePackages } from './okf.js';
import { readPdcJsonPackages } from './pdc-json.js';
import type { TechSoupPackage } from './fields.js';

/** How `--source` is interpreted: auto-detect, raw OKF bundles, or exporter `_pdc.json` files. */
type SourceFormat = 'auto' | 'okf' | 'json';

/** Narrow a raw CLI string (constrained by yargs `choices`) to a `SourceFormat`. */
const asSourceFormat = (value: string): SourceFormat => (value === 'okf' || value === 'json' ? value : 'auto');

/** Extract a .zip into `destDir` using adm-zip (cross-platform, no shell dependency). */
const extractZip = async (zipPath: string, destDir: string): Promise<void> => {
  const zip = new AdmZip(zipPath);
  await zip.extractAllToAsync(destDir, true, false);
};

/**
 * Resolve a `--source` argument (a `.zip` file, a folder, or a folder containing
 * `.zip` files) to a single directory tree to read. Returns the root plus a
 * cleanup for any temp dir created for extraction. The resolved root is read by
 * either the OKF or the `_pdc.json` reader depending on `--source-format`.
 */
const prepareSourceRoot = async (source: string): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const stats = await stat(source);
  const noop = async (): Promise<void> => {
    /* nothing to clean up when the source directory is read in place */
  };
  if (stats.isFile()) {
    if (!source.toLowerCase().endsWith('.zip')) {
      throw new Error(`Source file is not a .zip (pass a .zip or a folder): ${source}`);
    }
    const temp = await mkdtemp(join(tmpdir(), 'techsoup-'));
    logger.info(`Extracting ${source} to ${temp}`);
    await extractZip(source, temp);
    return {
      root: temp,
      cleanup: async () => {
        await rm(temp, { recursive: true, force: true });
      },
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`Source is neither a .zip file nor a directory: ${source}`);
  }
  const entries = await readdir(source, { withFileTypes: true });
  const zips = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'));
  if (zips.length === 0) {
    return { root: source, cleanup: noop };
  }
  const temp = await mkdtemp(join(tmpdir(), 'techsoup-'));
  logger.info(`Found ${zips.length} zip file(s) in ${source}; extracting to ${temp}`);
  for (const zip of zips) {
    // eslint-disable-next-line no-await-in-loop -- extract archives sequentially to bound disk/CPU pressure
    await extractZip(join(source, zip.name), join(temp, zip.name.replace(/\.zip$/iv, '')));
  }
  return {
    root: temp,
    cleanup: async () => {
      await rm(temp, { recursive: true, force: true });
    },
  };
};

/**
 * Read the packages under `root` in the requested format. `auto` prefers raw OKF
 * bundles and falls back to `_pdc.json` files when none are found. Returns the
 * packages plus the format actually used (for logging).
 */
const readPackages = async (
  root: string,
  format: SourceFormat,
): Promise<{ packages: TechSoupPackage[]; format: 'okf' | 'json' }> => {
  if (format === 'json') {
    return { packages: await readPdcJsonPackages(root), format: 'json' };
  }
  if (format === 'okf') {
    return { packages: await readOkfBundlePackages(root), format: 'okf' };
  }
  const okfPackages = await readOkfBundlePackages(root);
  if (okfPackages.length > 0) {
    return { packages: okfPackages, format: 'okf' };
  }
  return { packages: await readPdcJsonPackages(root), format: 'json' };
};

/** Report whether the source resolved to a single package or several (all processed one at a time). */
const describePackageCount = (packages: TechSoupPackage[], source: string, format: 'okf' | 'json'): void => {
  const label = format === 'okf' ? 'OKF' : 'PDC-JSON';
  if (packages.length === 0) {
    logger.warn(`No ${label} packages found under ${source}`);
  } else if (packages.length === 1) {
    logger.info(`Detected a single ${label} package under ${source}: ${packages[0]?.slug ?? '(unknown)'}`);
  } else {
    logger.info(`Detected ${packages.length} ${label} packages under ${source}; processing one at a time`);
  }
};

export { type SourceFormat, asSourceFormat, describePackageCount, prepareSourceRoot, readPackages };
