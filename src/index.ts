import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Context, Probot, ProbotOctokit } from 'probot';
import queue from 'queue';
import simpleGit from 'simple-git';

import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

async function getPRWithMergability(
  octokit: InstanceType<typeof ProbotOctokit>,
  owner: string,
  repo: string,
  pr: number,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pull = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pr,
    });
    if (pull.data.mergeable_state !== 'unknown') return pull.data;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.resolve(os.tmpdir(), 'patch-merge-'));
  try {
    await fn(dir);
  } catch (err) {
    throw err;
  } finally {
    await fs.remove(dir);
  }
}

async function getRepoToken(robot: Probot, context: Context<'push'>): Promise<string> {
  const hub = await robot.auth();
  const response = await hub.apps.createInstallationAccessToken({
    installation_id: context.payload.installation!.id,
  });
  return response.data.token;
}

const mergabilityQueue = queue({
  concurrency: 4,
  autostart: true,
});

const mergeQueue = queue({
  concurrency: 3,
  autostart: true,
});

module.exports = (app: Probot) => {
  app.on('push', async (context) => {
    const { ref } = context.payload;
    app.log.info(`push for ref: ${ref}`);
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.substr('refs/heads/'.length);
      app.log.info(`push for branch: ${branch}`);
      if (branch === 'main' || /^[0-9]+-x-y$/.test(branch)) {
        const owner = context.payload.repository.owner.login;
        const repo = context.payload.repository.name;
        // A release branch was updated, now we have to pull all active PRs that might need patch fixes
        const prs = await context.octokit.paginate<
          RestEndpointMethodTypes['pulls']['list']['response']['data'][0]
        >(
          context.octokit.pulls.list.endpoint.merge({
            owner,
            repo,
            base: branch,
            state: 'open',
            per_page: 100,
          }),
        );
        for (const pr of prs) {
          // Skip fork PRs
          if (pr.head.repo.owner?.login !== owner || pr.head.repo.name !== repo) continue;
          // Only run this logic for cherry-pick PRs
          // if (!pr.head.ref.startsWith(`cherry-pick/${branch}/`)) continue;

          app.log.info(`queuing dirty check pr: #${pr.number}`);

          mergabilityQueue.push(async () => {
            try {
              // Get the PR but with mergability status
              const prButBetter = await getPRWithMergability(
                context.octokit,
                owner,
                repo,
                pr.number,
              );
              app.log.info(`pr mergability: ${prButBetter?.mergeable_state}`);

              // There is a merge conflict, let's queue a merge attempt
              if (prButBetter && prButBetter.mergeable_state === 'dirty') {
                mergeQueue.push(async () => {
                  let tempBranchName: string = '';

                  try {
                    await withTempDir(async (dir) => {
                      const clonePath = path.resolve(dir, 'clone');
                      // Ensure dir exists and is empty
                      await fs.mkdirp(clonePath);
                      await fs.remove(clonePath);
                      await fs.mkdirp(clonePath);

                      // Clone the repo with auth
                      const git = simpleGit(clonePath);
                      const accessToken = await getRepoToken(app, context);
                      await git.clone(
                        `https://x-access-token:${accessToken}@github.com/${owner}/${repo}.git`,
                        '.',
                      );

                      app.log.info(`Cloned for pr: #${pr.id}`);

                      // Init Electron Bot as the merger
                      await git.addConfig('user.email', 'electron@github.com');
                      await git.addConfig('user.name', 'Electron Bot');
                      await git.addConfig('commit.gpgsign', 'false');

                      // Initialize local branches
                      await git.checkout(prButBetter.base.ref);
                      await git.checkout(prButBetter.head.ref);

                      app.log.info(`Checked out for pr: #${pr.id}`);

                      // Merge base to head
                      let result = 'failed';
                      try {
                        await git.raw([
                          'merge',
                          prButBetter.base.ref,
                          '-m',
                          `[ci skip] Merged in branch '${prButBetter.base.ref}' to fix mergability`,
                        ]);
                        result = 'success';
                      } catch (err) {
                        // Failed to merge
                      }

                      app.log.info(`Merged for pr: #${pr.id} with status: ${result}`);

                      // If the merge failed, throw it all away, we're done here
                      if (result !== 'success') return;

                      // If the merge worked, push up the merge result to a temporary branch to create a git tree
                      tempBranchName = `patch-conflict-fix/${
                        prButBetter.head.ref
                      }/${Date.now()}`.toLowerCase();
                      await git.raw(['checkout', '-b', tempBranchName]);
                      await git.push('origin', tempBranchName);

                      app.log.info(
                        `Pushed temp branch for pr: #${pr.id} with name: ${tempBranchName}`,
                      );

                      // Get the tree for the pushed commit, then make a second commit that will be signed using the
                      // first tree
                      const ref = await context.octokit.git.getRef({
                        owner,
                        repo,
                        ref: `heads/${tempBranchName}`,
                      });
                      const commit = await context.octokit.git.getCommit({
                        owner,
                        repo,
                        commit_sha: ref.data.object.sha,
                      });
                      const newCommit = await context.octokit.git.createCommit({
                        owner,
                        repo,
                        message: commit.data.message.replace(/^\[ci skip\] /g, ''),
                        tree: commit.data.tree.sha,
                        parents: commit.data.parents.map((p) => p.sha),
                      });

                      // Set the upstream ref to be the merge commit that is now magically signed
                      await context.octokit.git.updateRef({
                        owner,
                        repo,
                        ref: `heads/${prButBetter.head.ref}`,
                        sha: newCommit.data.sha,
                      });
                    });
                  } catch (err) {
                    console.error('Failed to process PR:', pr.html_url);
                    console.error(err);
                  } finally {
                    if (tempBranchName) {
                      // Delete the temporary branch remotely
                      await context.octokit.git
                        .deleteRef({
                          ref: `heads/${tempBranchName}`,
                          owner,
                          repo,
                        })
                        .catch(() => {});
                    }
                  }
                });
              }
            } catch (err) {
              console.error('Failed to get merge-status for PR:', pr.html_url);
              console.error(err);
            }
          });
        }
      }
    }
  });
};
