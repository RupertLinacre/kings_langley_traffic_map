import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectAppAssets } from './assets.mjs';

export function runGit(args, cwd, options = []) {
  const result = spawnSync('git', [...options, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Git failed: ${args[0]}`);
  return result.stdout.trim();
}

// Publish in a disposable checkout, preserving gh-pages history and leaving the
// source checkout alone. A concurrent update is rejected by an ordinary push.
export async function publishPages({ directory, repository, name, email, message, gitOptions = [] }) {
  const assets = await collectAppAssets(directory);
  const checkout = await mkdtemp(join(tmpdir(), 'kings-langley-pages-'));
  const git = args => runGit(args, checkout, gitOptions);
  try {
    git(['init', '-b', 'gh-pages']);
    git(['config', 'user.name', name]);
    git(['config', 'user.email', email]);
    git(['remote', 'add', 'origin', repository]);
    const existing = git(['ls-remote', '--heads', 'origin', 'refs/heads/gh-pages']);
    if (existing) {
      git(['fetch', '--depth=1', 'origin', 'gh-pages']);
      git(['checkout', '-B', 'gh-pages', 'FETCH_HEAD']);
      git(['rm', '-rf', '--ignore-unmatch', '--', '.']);
    }
    for (const asset of assets) {
      const destination = join(checkout, asset);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(directory, asset), destination, { dereference: false });
    }
    await writeFile(join(checkout, '.nojekyll'), '');
    git(['add', '--all']);
    const changes = git(['diff', '--cached', '--name-only']);
    if (!changes) return { changed: false, commit: git(['rev-parse', 'HEAD']) };
    git(['commit', '-m', message]);
    git(['push', 'origin', 'HEAD:refs/heads/gh-pages']);
    return { changed: true, commit: git(['rev-parse', 'HEAD']) };
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
