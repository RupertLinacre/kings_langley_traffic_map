import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPages, runGit } from '../scripts/publish-pages.mjs';

test('branch deployment publishes only app assets, preserves history and leaves source alone', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kings-langley-deploy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), source = join(root, 'source'), directory = join(root, 'dist');
  await mkdir(source);
  runGit(['init', '--bare', remote], root);
  runGit(['init', '-b', 'main'], source);
  runGit(['config', 'user.name', 'Deployment test'], source);
  runGit(['config', 'user.email', 'test@example.invalid'], source);
  await writeFile(join(source, 'README.md'), 'Source only.');
  runGit(['add', '.'], source);
  runGit(['commit', '-m', 'Source'], source);
  runGit(['remote', 'add', 'origin', remote], source);
  runGit(['push', 'origin', 'main'], source);
  const original = runGit(['rev-parse', 'HEAD'], source);
  await mkdir(join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'data/kings-langley'), { recursive: true });
  for (const [file, contents] of Object.entries({
    'index.html': '<p>First build</p>', 'favicon.svg': '<svg/>', 'src/app.js': 'export const version=1;',
    'src/old.js': 'export const retired=true;', 'data/kings-langley/network.json': '{}',
    'data/kings-langley/demand.json': '{}', 'data/kings-langley/README.md': 'Public map attribution.',
    '.env': 'PRIVATE_DEVELOPMENT_NOTE=excluded', 'debug.log': 'Local log',
  })) await writeFile(join(directory, file), contents);
  const options = { directory, repository: remote, name: 'Deployment test', email: 'test@example.invalid', message: 'First deployment' };
  const first = await publishPages(options);
  assert.ok(first.changed);
  const tracked = runGit(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'gh-pages'], root).split('\n');
  assert.ok(tracked.includes('.nojekyll') && tracked.includes('src/app.js'));
  assert.ok(!tracked.includes('.env') && !tracked.includes('debug.log') && !tracked.includes('README.md'));
  const unchanged = await publishPages(options);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.commit, first.commit);
  await writeFile(join(directory, 'index.html'), '<p>Updated build</p>');
  await rm(join(directory, 'src/old.js'));
  const second = await publishPages({ ...options, message: 'Second deployment' });
  assert.ok(second.changed);
  assert.equal(runGit(['--git-dir', remote, 'rev-parse', 'gh-pages^'], root), first.commit);
  assert.equal(runGit(['--git-dir', remote, 'show', 'gh-pages:index.html'], root), '<p>Updated build</p>');
  assert.ok(!runGit(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'gh-pages'], root).includes('src/old.js'));
  assert.equal(runGit(['--git-dir', remote, 'rev-parse', 'main'], root), original);
  assert.equal(runGit(['rev-parse', 'HEAD'], source), original);
  assert.equal(runGit(['branch', '--show-current'], source), 'main');
  assert.equal(runGit(['status', '--porcelain'], source), '');
});
