import type { GlobalConfig, Result } from '../types';
import { ok } from '../utils/errors';
import * as git from '../git/git';
import { reuseOrCreateWorktree } from '../git/worktree';
import { detectClaude, detectCodex } from '../agents/agent-detect';
import { runClaude } from '../agents/claude-agent';
import { runCodex } from '../agents/codex-agent';
import { runTestSuite } from '../tests-runner/test-runner';
import {
  createDraftPullRequest,
  findPullRequestForBranch,
  getPullRequest,
  markReadyForReview,
  updatePullRequestBody,
} from '../github/pull-request';
import { getChecks, waitForChecks } from '../github/checks';
import { executeMerge } from '../merge/merge-executor';
import type { GitPort, OrchestratorPorts } from './ports';

/**
 * Ligação entre as portas do orquestrador e os adaptadores reais.
 *
 * A suíte de testes substitui este conjunto por dublês, o que permite exercitar
 * o ciclo completo sem chamar Claude, Codex, Git, GitHub ou a rede.
 */

const gitPort: GitPort = {
  headSha: (dir) => git.headSha(dir),
  currentBranch: (dir) => git.currentBranch(dir),
  changedFiles: (dir) => git.changedFiles(dir),

  async statusText(dir) {
    const result = await git.status(dir);
    if (!result.ok) return result;
    const lines = result.value.entries.map(
      (entry) => `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`,
    );
    return ok(lines.join('\n'));
  },

  diffStat: (dir, from) => git.diffStat(dir, from),
  diffPatch: (dir, from) => git.diffPatch(dir, from),
  addPaths: (dir, paths) => git.addPaths(dir, paths),
  commit: (dir, message) => git.commit(dir, message),
  push: (dir, remote, branch, setUpstream) => git.push(dir, remote, branch, setUpstream),
  remoteUrl: (dir, remote) => git.remoteUrl(dir, remote),

  async commitLog(dir, fromRef) {
    const result = await git.runGitRaw(
      dir,
      ['log', '--no-color', '--pretty=format:%h %s (%an, %ad)', '--date=short', `${fromRef}..HEAD`],
      {},
    );
    // Falha ao listar commits não é fatal para o pacote de auditoria: o auditor
    // recebe o diff completo de qualquer forma.
    if (!result.ok || result.value.status !== 'COMPLETED') return ok('');
    return ok(result.value.stdout.trim());
  },
};

export function createDefaultPorts(): OrchestratorPorts {
  return {
    agents: {
      runClaude: (options) => runClaude(options),
      runCodex: (options) => runCodex(options),
      async claudeAvailable(config: GlobalConfig) {
        return (await detectClaude(config)).available;
      },
      async codexAvailable(config: GlobalConfig) {
        return (await detectCodex(config)).available;
      },
    },

    git: gitPort,

    worktree: {
      async prepare(input) {
        const result = await reuseOrCreateWorktree({
          repoDir: input.repoDir,
          worktreePath: input.worktreePath,
          branch: input.branch,
          baseRef: input.baseRef,
          reuseWhenSafe: input.reuseWhenSafe,
        });
        if (!result.ok) return result;
        return ok({ path: result.value.path, branch: result.value.branch });
      },
    },

    github: {
      createDraftPullRequest: (input) => createDraftPullRequest(input),
      getPullRequest: (input) =>
        getPullRequest({ cwd: input.cwd, repo: input.repo, prNumber: input.prNumber }),
      findPullRequestForBranch: (input) => findPullRequestForBranch(input),
      updatePullRequestBody: (input) => updatePullRequestBody(input),
      markReadyForReview: (input) => markReadyForReview(input),
      getChecks: (input) => getChecks(input),
      waitForChecks: (input) => waitForChecks(input),
    },

    merge: {
      execute: (input) => executeMerge(input),
    },

    tests: {
      run: (input) =>
        runTestSuite({
          commands: input.commands,
          cwd: input.cwd,
          timeoutSeconds: input.timeoutSeconds,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onCommandStart ? { onCommandStart: input.onCommandStart } : {}),
        }),
    },
  };
}

/** Reexportado para os testes construírem portas parciais sobre as reais. */
export type { OrchestratorPorts };
export type DefaultPortsResult = Result<OrchestratorPorts>;
