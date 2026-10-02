import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectAppAssets } from './assets.mjs';
import { publishPages, runGit } from './publish-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fileURLToPath(new URL('../dist/', import.meta.url));
try {
  const repository = runGit(['remote', 'get-url', 'origin'], root);
  const name = runGit(['config', 'user.name'], root);
  const email = runGit(['config', 'user.email'], root);
  const revision = runGit(['rev-parse', '--short=12', 'HEAD'], root);
  const dirty = runGit(['status', '--porcelain'], root) ? ' (working tree)' : '';
  // The build contains the same explicit public-asset allowlist as the server.
  await collectAppAssets(directory);
  const gh = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
  const gitOptions = /^https:\/\/github\.com\//.test(repository) && gh.status === 0
    ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
  const result = await publishPages({ directory, repository, name, email,
    message: `Deploy Kings Langley living town from ${revision}${dirty}`, gitOptions });
  console.log(result.changed ? `Published ${result.commit.slice(0,12)} to origin/gh-pages.` : 'The gh-pages branch already matches this build.');
  console.log('Pages source: Deploy from a branch → gh-pages → / (root).');
} catch (error) {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
}
