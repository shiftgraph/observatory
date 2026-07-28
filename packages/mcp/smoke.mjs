#!/usr/bin/env node
/**
 * Pre-publish smoke test: pack, install clean, and run it as a stranger would.
 *
 * The unit tests pass against the source. They cannot see what npm does to the
 * package on the way out, and npm has now silently removed the `bin` entry from
 * two ShiftGraph packages under a warning that reads like routine housekeeping:
 *
 *     npm warn publish npm auto-corrected some errors in your package.json
 *     npm warn publish "bin[shiftgraph-mcp]" script name cli.js was invalid and removed
 *
 * A stripped bin means `npx @shiftgraph/mcp` does nothing at all, which is the
 * only line of the install instructions anyone will ever run. The package
 * publishes, the tests pass, and the product does not exist.
 *
 * This is the third occurrence of that shape. The generate package has had this
 * check since the first one; this one shipped with unit tests alone, and that
 * omission is exactly what let it through.
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('.', import.meta.url));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('\nPre-publish smoke test: packing, installing and running as a stranger would.\n');

const dir = mkdtempSync(path.join(tmpdir(), 'sg-mcp-smoke-'));
try {
  let tarball;

  check('the package packs', () => {
    const out = execSync('npm pack --pack-destination "' + dir + '"', {
      cwd: PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    tarball = path.join(dir, out.trim().split('\n').pop().trim());
    if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
  });

  check('it installs into a clean directory', () => {
    execSync('npm init -y', { cwd: dir, stdio: 'ignore' });
    execSync(`npm install "${tarball}"`, { cwd: dir, stdio: 'ignore' });
  });

  /**
   * THE ONE THAT MATTERS. npm strips a bin it dislikes and warns rather than
   * failing, so the only way to know is to look for the shim after an install.
   */
  check('a bin shim exists, so npx would actually run something', () => {
    const binDir = path.join(dir, 'node_modules', '.bin');
    const shims = existsSync(binDir) ? readdirSync(binDir) : [];
    if (!shims.length) {
      throw new Error(
        'node_modules/.bin is empty: npm stripped the bin entry. `npx @shiftgraph/mcp` would do nothing.',
      );
    }
  });

  check('it speaks the protocol over stdio', () => {
    const cli = path.join(dir, 'node_modules', '@shiftgraph', 'mcp', 'cli.js');
    if (!existsSync(cli)) throw new Error('cli.js is not in the installed package');

    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`;

    const out = execFileSync(process.execPath, [cli], {
      input: request,
      encoding: 'utf8',
      timeout: 30_000,
    });

    const lines = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (lines.length !== 2) throw new Error(`expected 2 responses, got ${lines.length}`);

    const init = lines.find((l) => l.id === 1);
    if (!init?.result?.serverInfo?.name) throw new Error('initialize returned no serverInfo');

    const tools = lines.find((l) => l.id === 2);
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    if (!names.includes('lookup_contract')) {
      throw new Error(`lookup_contract missing from tools/list (got: ${names.join(', ') || 'none'})`);
    }
  });

  check('it answers from the live published record', () => {
    const cli = path.join(dir, 'node_modules', '@shiftgraph', 'mcp', 'cli.js');
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'lookup_contract',
        arguments: { target: 'https://api.github.com/repos/facebook/react' },
      },
    })}\n`;

    const out = execFileSync(process.execPath, [cli], {
      input: request,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const res = JSON.parse(out.trim().split('\n').filter(Boolean)[0]);
    const text = res?.result?.content?.[0]?.text ?? '';
    if (res?.result?.isError) throw new Error(`lookup returned an error: ${text.slice(0, 120)}`);
    if (!text.includes('Observed')) throw new Error('answer carries no evidence line');
    if (!text.includes('```typescript')) throw new Error('answer carries no declaration');
  });

  check('it refuses rather than guessing', () => {
    const cli = path.join(dir, 'node_modules', '@shiftgraph', 'mcp', 'cli.js');
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'lookup_contract',
        arguments: { target: 'https://api.stripe.com/v1/charges' },
      },
    })}\n`;

    const out = execFileSync(process.execPath, [cli], {
      input: request,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const text = JSON.parse(out.trim().split('\n').filter(Boolean)[0]).result.content[0].text;
    if (!text.includes('No observed record')) throw new Error('an unheld interface was not refused');
    if (text.includes('```typescript')) throw new Error('a refusal carried a declaration anyway');
  });

  check('the package has no third-party dependencies', () => {
    const installed = path.join(dir, 'node_modules', '@shiftgraph', 'mcp', 'package.json');
    const meta = JSON.parse(execSync(`node -p "JSON.stringify(require('${installed.replace(/\\/g, '\\\\')}'))"`, {
      encoding: 'utf8',
    }));
    const deps = Object.keys(meta.dependencies ?? {});
    if (deps.length) throw new Error(`expected zero dependencies, found: ${deps.join(', ')}`);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`SMOKE TEST FAILED (${failures}). Do not publish.\n`);
  process.exit(1);
}
console.log('All checks passed. Safe to publish.\n');
