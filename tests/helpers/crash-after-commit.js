'use strict';

/**
 * Executa uma rodada que MORRE entre `git commit` e a gravação do estado.
 *
 * É o processo separado do teste da janela que o diário de commits fecha. A
 * porta `git.commit` delega ao Git REAL e, assim que o commit existe, o
 * processo se mata — antes de o orquestrador chegar a registrar o SHA. Nenhum
 * dublê poderia reproduzir isso: a janela só existe entre duas operações
 * reais, e é justamente ali que o processo precisa desaparecer.
 *
 * Uso: node crash-after-commit.js <home> <projectId> <repoDir> <arquivoDeSaida>
 */

const fs = require('node:fs');
const path = require('node:path');

const [home, projectId, repoDir, outFile] = process.argv.slice(2);

process.env.ORQPEG_HOME = home;
process.env.ORQPEG_NO_FILE_LOG = '1';

const DIST = path.resolve(__dirname, '..', '..', 'dist');
const { runProject } = require(path.join(DIST, 'execution', 'orchestrator'));
const realGit = require(path.join(DIST, 'git', 'git'));
const { nullLogger } = require(path.join(DIST, 'utils', 'logger'));
const { defaultGlobalConfig } = require(path.join(DIST, 'config', 'global-config'));

const OK = (value) => ({ ok: true, value });

function agentResult(output) {
  const at = new Date().toISOString();
  return {
    ok: true,
    value: {
      output,
      invocation: {
        agent: 'claude',
        role: 'executor',
        instructionPath: '',
        cwd: '',
        model: null,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        status: 'COMPLETED',
        exitCode: 0,
        sessionId: null,
        stdoutPath: '',
        stderrPath: '',
        usageLimitReached: false,
        authRequired: false,
      },
      process: {
        command: 'mock',
        args: [],
        cwd: '',
        status: 'COMPLETED',
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: '',
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    },
  };
}

function promptReviewJson() {
  return JSON.stringify({
    verdict: 'APPROVED',
    summary: 'Revisão automatizada de teste.',
    confidence: 0.97,
    meetsPromptRequirements: true,
    blockingIssues: [],
    nonBlockingIssues: [],
    requiredActions: [],
    scopeAssessment: { withinScope: true, unexpectedChanges: [] },
    testsAssessment: { localTestsPassed: true, coverageAcceptable: true },
    riskAssessment: { level: 'low', summary: 'Baixo risco.' },
  });
}

function passingTests() {
  const at = new Date().toISOString();
  return {
    status: 'PASSED',
    passed: true,
    startedAt: at,
    finishedAt: at,
    durationMs: 1,
    commands: [
      {
        command: 'noop',
        cwd: '',
        status: 'PASSED',
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        durationMs: 1,
        stdout: 'ok',
        stderr: '',
      },
    ],
    failedCommands: [],
  };
}

async function main() {
  const ports = {
    agents: {
      async runClaude() {
        /* O "executor" escreve de verdade: sem alteração não há o que commitar. */
        fs.writeFileSync(path.join(repoDir, 'app.txt'), `trabalho ${Date.now()}\n`, 'utf8');
        return agentResult('Implementado.');
      },
      async runCodex() {
        return agentResult(promptReviewJson());
      },
      async claudeAvailable() {
        return true;
      },
      async codexAvailable() {
        return true;
      },
    },

    git: {
      headSha: (dir) => realGit.headSha(dir),
      currentBranch: (dir) => realGit.currentBranch(dir),
      changedFiles: (dir) => realGit.changedFiles(dir),
      async statusText() {
        return OK('M app.txt');
      },
      diffStat: (dir, from) => realGit.diffStat(dir, from),
      diffPatch: (dir, from) => realGit.diffPatch(dir, from),
      addPaths: (dir, paths) => realGit.addPaths(dir, paths),

      async commit(dir, message) {
        /* Commit REAL, com os carimbos que o orquestrador montou. */
        const result = await realGit.commit(dir, message);
        if (!result.ok) {
          fs.writeFileSync(outFile, JSON.stringify({ erro: result.error }), 'utf8');
          process.exit(4);
        }
        fs.writeFileSync(outFile, JSON.stringify({ sha: result.value }), 'utf8');
        /*
         * A QUEDA. O commit existe no Git; o estado ainda não sabe dele.
         * `process.exit` aqui é o equivalente fiel a uma queda de energia
         * neste ponto exato.
         */
        process.exit(9);
      },

      async push() {
        return OK(undefined);
      },
      async remoteUrl() {
        return OK('https://github.com/maquinanerd/demo.git');
      },
      async commitLog() {
        return OK('');
      },
      listCommitsSince: (dir, fromRef) => realGit.listCommitsSince(dir, fromRef),
      commitChangedFiles: (dir, sha) => realGit.commitChangedFiles(dir, sha),
    },

    worktree: {
      async prepare(input) {
        return OK({ path: input.worktreePath, branch: input.branch });
      },
      async verifyOwnership(input) {
        return OK({ path: input.worktreePath, branch: input.branch });
      },
    },

    github: {
      async createDraftPullRequest() {
        return OK(null);
      },
      async getPullRequest() {
        return OK(null);
      },
      async findPullRequestForBranch() {
        return OK(null);
      },
      async updatePullRequestBody() {
        return OK(undefined);
      },
      async markReadyForReview() {
        return OK(undefined);
      },
      async getChecks() {
        return OK(null);
      },
      async waitForChecks() {
        return OK(null);
      },
    },

    merge: {
      async execute() {
        return OK({
          attempted: false,
          merged: false,
          mergeSha: null,
          strategy: 'squash',
          matchedHeadSha: null,
          performedAt: null,
          reason: 'desabilitado',
          idempotentSkip: true,
        });
      },
    },

    tests: {
      async run() {
        return passingTests();
      },
    },
  };

  const result = await runProject({
    projectId,
    dryRun: false,
    config: defaultGlobalConfig(),
    logger: nullLogger(),
    ports,
  });

  /* Só chega aqui se o commit NÃO aconteceu — o teste trata como falha. */
  fs.writeFileSync(
    outFile,
    JSON.stringify({ semQueda: true, state: result.ok ? result.value.state : null }),
    'utf8',
  );
  process.exit(0);
}

main().catch((error) => {
  fs.writeFileSync(outFile, JSON.stringify({ erro: String(error && error.message) }), 'utf8');
  process.exit(1);
});
