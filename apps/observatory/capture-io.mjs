/**
 * How the observatory reads and writes the files it keeps.
 *
 * This is deliberately not in `packages/core/utils.js`. That file is vendored
 * verbatim into the published `@shiftgraph/generate` package and mirrored into
 * the platform's engine, and a test fails on a single byte of drift, because
 * the published tool has to profile exactly the way this record does. Storage
 * is not profiling. Putting a compression policy in a file three consumers
 * copy would make two of them inherit a decision only this one makes, which is
 * the same shape as every other defect found here: two rules in one system,
 * agreeing until they don't, and the silent one winning.
 *
 * So the rule lives once, next to the only code that holds it.
 *
 * Captures are compressed because they are kept forever and they compound. A
 * sweep is about 9 MB of NDJSON and about an eighth of that gzipped, which at
 * four sweeps a day is the difference between roughly 8.5 GB a year and
 * roughly 1.7 GB. The baseline is compressed for a sharper reason: it is
 * rewritten every sweep rather than appended, so an uncompressed one would put
 * a fresh 10 MB object into the repository's history four times a day.
 */
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);
export const gzip = promisify(zlib.gzip);

/**
 * Matches a capture in either representation.
 *
 * Captures written before compression landed are still captures. A filter that
 * accepted only one suffix would drop the older half of the series without
 * saying anything, and a series that silently loses its early days reports
 * the first re-appearance of an old field as something new.
 */
export const CAPTURE_FILE = /\.ndjson(\.gz)?$/;

/** Reads a stored file, transparently decompressing a gzipped one. */
export async function readStored(filePath) {
  if (filePath.endsWith('.gz')) {
    return (await gunzip(await fs.readFile(filePath))).toString('utf8');
  }
  return fs.readFile(filePath, 'utf8');
}

/** The synchronous sibling, for the scripts that walk the capture directory. */
export function readStoredSync(filePath) {
  if (filePath.endsWith('.gz')) {
    return zlib.gunzipSync(readFileSync(filePath)).toString('utf8');
  }
  return readFileSync(filePath, 'utf8');
}

/** Writes text, compressing when the target path asks for it. */
export async function writeStored(filePath, text) {
  if (filePath.endsWith('.gz')) {
    return fs.writeFile(filePath, await gzip(Buffer.from(text, 'utf8'), { level: 9 }));
  }
  return fs.writeFile(filePath, text, 'utf8');
}
