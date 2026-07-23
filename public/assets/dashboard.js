/* ==========================================================================
   OrqPEG — dashboard (frame Figma "OrqPEG / Master Canvas", node 2:2).

   Liga a composição do Figma aos dados reais do orquestrador. Nenhum valor
   demonstrativo do desenho sobrevive aqui: 6, 27, 22, 3, 72%, "Run #ORQ-0042"
   e os nomes de projeto eram referência de composição.

   Restrições respeitadas:
     - JavaScript de navegador puro, sem framework e sem dependência externa;
     - CSP default-src 'self': nenhum estilo inline em markup, nenhum eval;
     - todo texto vindo do servidor entra por textContent, nunca por innerHTML;
     - o campo do console NUNCA é um canal de prompt arbitrário (§ governança).
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------------------
     1. Utilidades
     ---------------------------------------------------------------------- */

  var POLL_MS = 5000;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', 'assets/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function show(node, visible) {
    if (node) node.hidden = !visible;
  }

  /** Iniciais de um nome, para monogramas. Nunca mais de duas letras. */
  function initials(value) {
    var parts = String(value || '')
      .split(/[\s/_.-]+/)
      .filter(Boolean);
    if (parts.length === 0) return '··';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function clockTime(iso) {
    if (!iso) return '--:--';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '--:--';
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function fullTime(iso) {
    if (!iso) return 'sem data';
    var date = new Date(iso);
    if (isNaN(date.getTime())) return 'sem data';
    return date.toLocaleString('pt-BR');
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(
      function (response) {
        return response.json().then(
          function (body) {
            if (!response.ok) {
              var message = body && body.error ? body.error : 'Falha ' + response.status;
              throw new Error(message);
            }
            return body;
          },
          function () {
            throw new Error('Resposta ilegível do servidor (' + response.status + ').');
          },
        );
      },
    );
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload || {}),
    }).then(function (response) {
      return response.json().then(
        function (body) {
          if (!response.ok) {
            throw new Error(body && body.error ? body.error : 'Falha ' + response.status);
          }
          return body;
        },
        function () {
          throw new Error('Resposta ilegível do servidor (' + response.status + ').');
        },
      );
    });
  }

  /* ----------------------------------------------------------------------
     2. Domínio: RunState → estágio visual

     As três pílulas do Figma (Discovery / Execution / Approved) são um recorte
     de composição. Os 26 RunState reais do OrqPEG são agrupados aqui, mais
     "blocked" e "idle", que o desenho não cobria mas o domínio exige.
     ---------------------------------------------------------------------- */

  var STAGE_BY_STATE = {
    IDLE: 'discovery',
    VALIDATING: 'discovery',
    PREPARING_WORKTREE: 'discovery',

    RUNNING_CLAUDE: 'execution',
    RUNNING_TESTS: 'execution',
    BUILDING_REVIEW_PACKAGE: 'execution',
    RUNNING_CODEX: 'execution',
    CHANGES_REQUESTED: 'execution',
    COMMITTING: 'execution',
    PUSHING: 'execution',
    CREATING_PR: 'execution',
    WAITING_CI: 'execution',
    RUNNING_CLAUDE_MERGE_AUDIT: 'execution',
    RUNNING_CODEX_MERGE_AUDIT: 'execution',
    MERGE_CONSENSUS_PENDING: 'execution',
    MERGING: 'execution',

    PROMPT_APPROVED: 'approved',
    MERGE_APPROVED: 'approved',
    MERGED: 'approved',
    COMPLETED: 'approved',

    BLOCKED: 'blocked',
    CI_FAILED: 'blocked',
    LOOP_GUARD_TRIGGERED: 'blocked',
    AUTH_REQUIRED: 'blocked',
    USAGE_LIMIT_REACHED: 'blocked',
    INTERRUPTED: 'blocked',
    FAILED: 'blocked',
    CANCELLED: 'blocked',
  };

  var STATE_LABEL = {
    IDLE: 'Ociosa',
    VALIDATING: 'Validando',
    PREPARING_WORKTREE: 'Preparando worktree',
    RUNNING_CLAUDE: 'Claude executando',
    RUNNING_TESTS: 'Testes em curso',
    BUILDING_REVIEW_PACKAGE: 'Montando pacote',
    RUNNING_CODEX: 'Codex revisando',
    CHANGES_REQUESTED: 'Ajustes pedidos',
    PROMPT_APPROVED: 'Prompt aprovado',
    COMMITTING: 'Commitando',
    PUSHING: 'Enviando',
    CREATING_PR: 'Abrindo PR',
    WAITING_CI: 'Aguardando CI',
    CI_FAILED: 'CI falhou',
    RUNNING_CLAUDE_MERGE_AUDIT: 'Auditoria Claude',
    RUNNING_CODEX_MERGE_AUDIT: 'Auditoria Codex',
    MERGE_CONSENSUS_PENDING: 'Consenso pendente',
    MERGE_APPROVED: 'Merge aprovado',
    MERGING: 'Mesclando',
    MERGED: 'Mesclada',
    BLOCKED: 'Bloqueada',
    LOOP_GUARD_TRIGGERED: 'Loop Guard parou',
    AUTH_REQUIRED: 'Autenticação exigida',
    USAGE_LIMIT_REACHED: 'Limite de uso',
    INTERRUPTED: 'Interrompida',
    FAILED: 'Falhou',
    COMPLETED: 'Concluída',
    CANCELLED: 'Cancelada',
  };

  /** Estados em que uma decisão humana é a única coisa que falta. */
  var AWAITING_HUMAN = {
    LOOP_GUARD_TRIGGERED: true,
    MERGE_CONSENSUS_PENDING: true,
    BLOCKED: true,
    CHANGES_REQUESTED: true,
    AUTH_REQUIRED: true,
    USAGE_LIMIT_REACHED: true,
  };

  function stageOf(state) {
    if (!state) return 'idle';
    return STAGE_BY_STATE[state] || 'idle';
  }

  function labelOf(state) {
    if (!state) return 'Sem execução';
    return STATE_LABEL[state] || state;
  }

  /** Prioridade do cartão de projeto: derivada do estado real, não fixa. */
  function priorityOf(summary) {
    var stage = stageOf(summary.activeState);
    if (stage === 'blocked' || summary.lastError) {
      return { className: 'pill--priority-high', label: 'Alta' };
    }
    if (summary.activeRunId) {
      return { className: 'pill--priority-medium', label: 'Média' };
    }
    return { className: 'pill--priority-low', label: 'Baixa' };
  }

  /* ----------------------------------------------------------------------
     3. Estado da página
     ---------------------------------------------------------------------- */

  var state = {
    home: null,
    projectId: null,
    runId: null,
    runs: [],
    run: null,
    consensus: null,
    loading: true,
    error: null,
    transport: 'down',
  };

  /* ----------------------------------------------------------------------
     4. Renderização — StatGrid (Figma 2:30 … 2:45)
     ---------------------------------------------------------------------- */

  function renderStats(home) {
    var grid = $('stat-grid');
    grid.setAttribute('aria-busy', 'false');

    var pendingApprovals = home.projects.reduce(function (total, project) {
      return total + (project.promptPending || 0);
    }, 0);

    var agentsAvailable = home.tools.filter(function (tool) {
      return tool.available;
    }).length;

    var values = {
      projects: String(home.projects.length),
      agents: agentsAvailable + '/' + home.tools.length,
      active: String(home.activeRuns),
      pending: String(pendingApprovals),
    };

    Object.keys(values).forEach(function (key) {
      var cell = grid.querySelector('[data-stat="' + key + '"] [data-field="value"]');
      if (cell) cell.textContent = values[key];
    });

    var alerts = home.blockedRuns + home.pausedRuns;
    var badge = $('rail-notify-count');
    badge.textContent = String(alerts);
    show(badge, alerts > 0);
  }

  /* ----------------------------------------------------------------------
     5. Renderização — ProjectList (Figma 2:48 … 2:87)
     ---------------------------------------------------------------------- */

  function renderProjectList(home) {
    var list = $('project-list');
    list.setAttribute('aria-busy', 'false');
    clear(list);

    show($('project-list-empty'), home.projects.length === 0);
    show($('project-list-error'), false);

    home.projects.forEach(function (project) {
      var item = document.createElement('li');
      var card = el('button', 'project-card');
      card.type = 'button';
      card.setAttribute('aria-current', String(project.id === state.projectId));
      card.dataset.projectId = project.id;

      card.appendChild(el('p', 'project-avatar', initials(project.name)));
      card.appendChild(el('p', 'project-card-name', project.name));

      var status = project.lastError
        ? project.lastError
        : project.activeState
          ? labelOf(project.activeState)
          : 'Sem execução ativa';
      card.appendChild(el('p', 'project-card-status', status));

      var strip = el('div', 'task-strip');
      strip.appendChild(icon(project.activeRunId ? 'play' : 'prompt'));
      var task = project.activeRunId
        ? project.promptApproved + ' de ' + project.promptTotal + ' prompts aprovados'
        : project.promptTotal + ' prompts cadastrados';
      strip.appendChild(el('span', 'task-text', task));

      var priority = priorityOf(project);
      strip.appendChild(el('span', 'pill ' + priority.className, priority.label));
      card.appendChild(strip);

      card.addEventListener('click', function () {
        selectProject(project.id);
      });

      item.appendChild(card);
      list.appendChild(item);
    });
  }

  /* ----------------------------------------------------------------------
     6. Renderização — ProjectHeader (Figma 2:88 … 2:100)
     ---------------------------------------------------------------------- */

  function renderProjectHeader(project) {
    if (!project) {
      $('project-monogram').textContent = '··';
      $('project-title').textContent = 'Selecione um projeto';
      $('project-meta').textContent = 'Nenhum projeto selecionado.';
      $('project-path').textContent = '';
      $('owner-name').textContent = '—';
      $('owner-avatar').textContent = '··';
      show($('pill-env'), false);
      show($('pill-ready'), false);
      return;
    }

    $('project-monogram').textContent = initials(project.name);
    $('project-title').textContent = project.name;

    var meta = [];
    meta.push(project.worktreeEnabled ? 'Worktree isolado' : 'Repositório direto');
    meta.push('base ' + project.baseBranch);
    if (project.ciStatus) meta.push('CI ' + project.ciStatus);
    $('project-meta').textContent = meta.join(' • ');

    $('project-path').textContent = project.repositoryPath;

    var envPill = $('pill-env');
    envPill.textContent = project.githubRepository ? 'REMOTO' : 'LOCAL';
    show(envPill, true);

    /* READY exige ferramentas disponíveis e ausência de erro registrado. */
    var toolsReady =
      state.home && state.home.tools.length > 0
        ? state.home.tools.every(function (tool) {
            return tool.available;
          })
        : false;
    var ready = toolsReady && !project.lastError;
    var readyPill = $('pill-ready');
    readyPill.textContent = ready ? 'READY' : 'ATENÇÃO';
    readyPill.dataset.ready = String(ready);
    show(readyPill, true);

    $('owner-avatar').textContent = initials(project.githubRepository || project.name);
    $('owner-name').textContent = project.githubRepository || 'sem remoto';
  }

  /* ----------------------------------------------------------------------
     7. Renderização — RunSelector (Figma 2:111)
     ---------------------------------------------------------------------- */

  function renderRunSelector() {
    var select = $('run-selector');
    clear(select);

    if (state.runs.length === 0) {
      var none = el('option', null, 'Sem execuções');
      none.value = '';
      select.appendChild(none);
      select.disabled = true;
      return;
    }

    state.runs.forEach(function (run) {
      var option = el('option', null, run.runId + ' — ' + labelOf(run.state));
      option.value = run.runId;
      if (run.runId === state.runId) option.selected = true;
      select.appendChild(option);
    });
    select.disabled = false;
  }

  /* ----------------------------------------------------------------------
     8. Renderização — ExecutionTimeline (Figma 2:119 … 2:145)
     ---------------------------------------------------------------------- */

  var STAGE_ICON = {
    discovery: 'diagnostics',
    execution: 'play',
    approved: 'check',
    blocked: 'alert',
    idle: 'clock',
  };

  var STAGE_LABEL = {
    discovery: 'Descoberta',
    execution: 'Execução',
    approved: 'Aprovado',
    blocked: 'Bloqueio',
    idle: 'Ocioso',
  };

  function renderTimeline(run) {
    var list = $('timeline');
    list.setAttribute('aria-busy', 'false');
    clear(list);

    var events = run && Array.isArray(run.events) ? run.events.slice().reverse() : [];
    show($('timeline-empty'), events.length === 0);

    events.slice(0, 40).forEach(function (event) {
      var stage = stageOf(event.state);
      var item = document.createElement('li');
      item.className = 'event';

      var marker = el('div', 'event-marker');
      var bubble = el('span', 'event-icon');
      bubble.dataset.stage = stage;
      bubble.appendChild(icon(STAGE_ICON[stage]));
      marker.appendChild(bubble);
      marker.appendChild(el('span', 'event-time', clockTime(event.at)));
      item.appendChild(marker);

      var card = el('div', 'event-card');
      var body = el('div');
      body.appendChild(el('p', 'event-title', labelOf(event.state)));
      body.appendChild(el('p', 'event-detail', event.message || ''));
      card.appendChild(body);

      var side = el('div', 'event-side');
      side.appendChild(el('span', 'event-agent', initials(agentOfState(event.state))));
      side.appendChild(el('span', 'pill pill--stage-' + stage, STAGE_LABEL[stage]));
      card.appendChild(side);

      item.appendChild(card);
      list.appendChild(item);
    });
  }

  /** Qual agente é responsável pelo estado — o desenho mostrava só "AI". */
  function agentOfState(runState) {
    if (runState === 'RUNNING_CLAUDE' || runState === 'RUNNING_CLAUDE_MERGE_AUDIT') return 'Claude';
    if (runState === 'RUNNING_CODEX' || runState === 'RUNNING_CODEX_MERGE_AUDIT') return 'Codex';
    if (runState === 'RUNNING_TESTS' || runState === 'WAITING_CI' || runState === 'CI_FAILED') {
      return 'CI';
    }
    return 'Orq';
  }

  /* ----------------------------------------------------------------------
     9. Renderização — AgentConsole (Figma 2:146 … 2:163)
     ---------------------------------------------------------------------- */

  function renderConsole(run) {
    var log = $('console-log');
    clear(log);

    if (!run) {
      log.appendChild(el('p', 'state-note', 'Selecione uma execução para ver o diálogo.'));
      return;
    }

    var events = Array.isArray(run.events) ? run.events.slice(-12) : [];
    if (events.length === 0) {
      log.appendChild(el('p', 'state-note', 'Nenhuma mensagem registrada.'));
      return;
    }

    events.forEach(function (event) {
      var fromOperator = event.state === 'IDLE' || event.state === 'INTERRUPTED';
      var bubble = el('p', 'bubble ' + (fromOperator ? 'bubble--operator' : 'bubble--agent'));
      bubble.appendChild(document.createTextNode(event.message || labelOf(event.state)));
      bubble.appendChild(el('span', 'bubble-time', clockTime(event.at)));
      log.appendChild(bubble);
    });

    log.scrollTop = log.scrollHeight;
  }

  /* ----------------------------------------------------------------------
     10. Governança do console (§8)

     O campo NUNCA vira um canal de prompt arbitrário. O OrqPEG não expõe
     endpoint que aceite instrução livre para o agente, e o dashboard não
     inventa um. O campo tem quatro modos, e no único em que aceita digitação o
     texto é JUSTIFICATIVA de uma autorização — que vai para
     POST /runs/:id/override, validado no servidor.
     ---------------------------------------------------------------------- */

  var GOVERNANCE = {
    blocked: {
      placeholder: 'Selecione uma execução…',
      note: 'Campo bloqueado: nenhuma execução selecionada.',
      enabled: false,
    },
    readonly: {
      placeholder: 'Execução encerrada — somente leitura',
      note: 'Somente leitura: a execução terminou. O histórico não aceita instrução.',
      enabled: false,
    },
    limited: {
      placeholder: 'Execução em curso — instrução indisponível',
      note:
        'Instrução limitada: a execução está sob política congelada. ' +
        'Intervenção só é aceita quando o Loop Guard ou um gate pedir decisão humana.',
      enabled: false,
    },
    authorized: {
      placeholder: 'Justificativa da autorização…',
      note:
        'Intervenção autorizada: descreva a justificativa e confirme em "Autorizar etapa". ' +
        'O texto é registrado na execução e validado no servidor.',
      enabled: true,
    },
  };

  function governanceModeFor(run) {
    if (!run) return 'blocked';
    if (AWAITING_HUMAN[run.state]) return 'authorized';
    if (run.finishedAt || stageOf(run.state) === 'approved') return 'readonly';
    return 'limited';
  }

  function renderGovernance(run) {
    var mode = governanceModeFor(run);
    var config = GOVERNANCE[mode];

    var input = $('console-input');
    input.placeholder = config.placeholder;
    input.disabled = !config.enabled;
    if (!config.enabled) input.value = '';

    $('console-send').disabled = !config.enabled;

    var note = $('console-governance');
    note.textContent = config.note;
    note.dataset.mode = mode;
  }

  /* ----------------------------------------------------------------------
     11. Renderização — CurrentStageCard + GateChecklist (Figma 2:165 … 2:182)
     ---------------------------------------------------------------------- */

  function renderStageCard(run) {
    var card = $('stage-card');
    var stage = stageOf(run && run.state);
    card.dataset.stage = stage;

    if (!run) {
      $('h-stage').textContent = 'Sem execução ativa';
      $('stage-state').textContent = '—';
      $('stage-progress-pill').textContent = '—';
      $('stage-progress-value').textContent = '—';
      setProgress(0, null);
      renderGates(null);
      return;
    }

    var promptId = run.currentPromptId || (run.prompts[0] && run.prompts[0].promptId) || null;
    $('h-stage').textContent = promptId ? promptId : labelOf(run.state);

    var statePill = $('stage-state');
    statePill.textContent = labelOf(run.state);
    statePill.className = 'pill pill--stage-' + stage;

    var total = run.prompts.length;
    var approved = run.prompts.filter(function (prompt) {
      return prompt.status === 'APPROVED';
    }).length;
    var percent = total > 0 ? Math.round((approved / total) * 100) : 0;

    $('stage-progress-pill').textContent = approved + '/' + total + ' prompts';
    $('stage-progress-value').textContent = total > 0 ? percent + '%' : 'sem prompts';
    setProgress(percent, total > 0 ? percent : null);

    renderGates(run.gateReport);
  }

  function setProgress(percent, ariaValue) {
    var bar = $('stage-progress-bar');
    var fill = $('stage-progress-fill');
    /* Escrita via CSSOM, não atributo style em markup: a CSP permite e o
       markup segue sem estilo inline. */
    fill.style.setProperty('--fig-progress', String(Math.max(0, Math.min(100, percent)) / 100));
    if (ariaValue === null) {
      bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-valuetext', 'indisponível');
    } else {
      bar.setAttribute('aria-valuenow', String(ariaValue));
      bar.removeAttribute('aria-valuetext');
    }
  }

  var GATE_STATUS_CLASS = {
    PASSED: 'passed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    NOT_EVALUATED: 'pending',
  };

  var GATE_STATUS_MARK = {
    PASSED: '✓',
    FAILED: '✕',
    SKIPPED: '–',
    NOT_EVALUATED: '·',
  };

  function renderGates(gateReport) {
    var list = $('gate-checklist');
    clear(list);

    var gates = gateReport && Array.isArray(gateReport.gates) ? gateReport.gates : [];
    show($('gate-checklist-empty'), gates.length === 0);

    gates.forEach(function (gate) {
      var item = document.createElement('li');
      item.className = 'check-item';
      item.dataset.status = GATE_STATUS_CLASS[gate.status] || 'pending';

      var mark = el('span', 'check-mark', GATE_STATUS_MARK[gate.status] || '·');
      mark.setAttribute('aria-hidden', 'true');
      item.appendChild(mark);

      var label = el('span', null, gate.title);
      label.appendChild(el('span', 'sr-only', ' — ' + gate.status + '. ' + (gate.reason || '')));
      item.appendChild(label);

      item.title = gate.reason || gate.title;
      list.appendChild(item);
    });
  }

  /* ----------------------------------------------------------------------
     12. Renderização — ApprovalCard (Figma 2:183 … 2:207)
     ---------------------------------------------------------------------- */

  function renderApproval(run) {
    var card = $('approval-card');
    var pending = Boolean(run && AWAITING_HUMAN[run.state]);
    card.dataset.pending = String(pending);

    $('approval-title').textContent = pending ? 'Decisão pendente' : 'Nenhuma decisão pendente';
    $('approval-subtitle').textContent = pending
      ? 'A execução parou de propósito e aguarda autorização humana: ' + labelOf(run.state) + '.'
      : run
        ? 'A execução não está aguardando intervenção humana.'
        : 'Selecione uma execução para ver o estado de aprovação.';

    /* Artefatos reais da execução, não um nome de arquivo fixo. */
    var files = $('approval-files');
    clear(files);
    if (run) {
      artifactsOf(run).forEach(function (artifact) {
        var item = document.createElement('li');
        item.className = 'file-row';
        item.appendChild(icon(artifact.icon));
        item.appendChild(el('span', 'file-row-name', artifact.label));
        if (artifact.href) {
          var link = el('a', 'file-row-action');
          link.href = artifact.href;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          link.appendChild(icon('external'));
          link.appendChild(el('span', 'sr-only', 'Abrir ' + artifact.label));
          item.appendChild(link);
        }
        files.appendChild(item);
      });
    }

    /* Verificações que o servidor exige antes de qualquer autorização. */
    var checks = $('approval-checks');
    clear(checks);
    approvalChecksOf(run).forEach(function (check) {
      var item = document.createElement('li');
      item.className = 'check-item';
      item.dataset.status = check.ok ? 'passed' : 'pending';
      var mark = el('span', 'check-mark', check.ok ? '✓' : '·');
      mark.setAttribute('aria-hidden', 'true');
      item.appendChild(mark);
      item.appendChild(el('span', null, check.label));
      checks.appendChild(item);
    });

    $('btn-approve').disabled = !pending;
    $('btn-reject').disabled = !pending;
  }

  function artifactsOf(run) {
    var list = [];
    if (run.pullRequest && run.pullRequest.url) {
      list.push({
        icon: 'pr',
        label: 'PR #' + run.pullRequest.number,
        href: run.pullRequest.url,
      });
    }
    if (run.branchName) list.push({ icon: 'worktree', label: run.branchName, href: null });
    if (run.finalTests) {
      list.push({ icon: 'flask', label: 'Evidência de teste: ' + run.finalTests.status, href: null });
    }
    if (run.gateReport) {
      list.push({
        icon: 'shield',
        label: 'Relatório de gates (' + run.gateReport.gates.length + ')',
        href: null,
      });
    }
    if (list.length === 0) list.push({ icon: 'report', label: 'Nenhum artefato ainda', href: null });
    return list;
  }

  function approvalChecksOf(run) {
    if (!run) return [];
    return [
      {
        label: 'Política congelada presente',
        ok: Boolean(run.effectivePolicy),
      },
      {
        label: 'Commit base registrado',
        ok: Boolean(run.baseCommitSha),
      },
      {
        label: 'Gates avaliados',
        ok: Boolean(run.gateReport),
      },
    ];
  }

  /* ----------------------------------------------------------------------
     13. Abas e painéis auxiliares
     ---------------------------------------------------------------------- */

  function renderAgents(home) {
    var list = $('agent-list');
    clear(list);
    if (!home) return;
    home.tools.forEach(function (tool) {
      var item = document.createElement('li');
      item.className = 'list-row';
      item.appendChild(el('span', 'list-row-label', tool.name));
      var detail = tool.available
        ? (tool.version || 'disponível') + (tool.authenticated === false ? ' • sem autenticação' : '')
        : 'indisponível';
      item.appendChild(el('span', 'list-row-value', detail));
      list.appendChild(item);
    });
  }

  function renderPrompts(run) {
    var list = $('prompt-list');
    clear(list);
    var prompts = run && Array.isArray(run.prompts) ? run.prompts : [];
    show($('prompt-list-empty'), prompts.length === 0);
    prompts.forEach(function (prompt) {
      var item = document.createElement('li');
      item.className = 'list-row';
      item.appendChild(el('span', 'list-row-label', prompt.promptId));
      item.appendChild(
        el('span', 'list-row-value', prompt.status + ' • ' + prompt.attempts + ' tentativa(s)'),
      );
      list.appendChild(item);
    });
  }

  function renderArtifacts(run) {
    var list = $('artifact-list');
    clear(list);
    show($('artifact-list-empty'), !run);
    if (!run) return;

    var rows = [
      ['Execução', run.runId],
      ['Estado', labelOf(run.state)],
      ['Criada em', fullTime(run.createdAt)],
      ['Atualizada em', fullTime(run.updatedAt)],
      ['Commit base', run.baseCommitSha || 'não registrado'],
      ['Branch', run.branchName || 'não criada'],
      ['Worktree', run.worktreePath || 'não usado'],
      ['Commits', String(run.commits.length)],
      ['Pull request', run.pullRequest ? '#' + run.pullRequest.number : 'não aberto'],
      ['Merge', run.mergeOutcome && run.mergeOutcome.merged ? run.mergeOutcome.mergeSha : 'não mesclada'],
    ];

    rows.forEach(function (row) {
      list.appendChild(el('dt', null, row[0]));
      list.appendChild(el('dd', null, row[1]));
    });
  }

  function renderHistory() {
    var list = $('history-list');
    clear(list);
    show($('history-list-empty'), state.runs.length === 0);
    state.runs.forEach(function (run) {
      var item = document.createElement('li');
      item.className = 'list-row';
      item.appendChild(el('span', 'list-row-label', run.runId));
      item.appendChild(
        el('span', 'list-row-value', labelOf(run.state) + ' • ' + fullTime(run.updatedAt)),
      );
      list.appendChild(item);
    });
  }

  /* ----------------------------------------------------------------------
     14. Ações do cabeçalho
     ---------------------------------------------------------------------- */

  function renderHeaderActions(run) {
    var active = Boolean(run) && !run.finishedAt;
    var map = {
      start: Boolean(state.projectId) && !active,
      pause: active && !run.pauseRequested,
      resume: active && run.pauseRequested,
      cancel: active,
      open: Boolean(state.projectId),
    };
    Object.keys(map).forEach(function (action) {
      var button = document.querySelector('.header-action[data-action="' + action + '"]');
      if (button) button.disabled = !map[action];
    });

    document.querySelectorAll('.console-action').forEach(function (button) {
      button.disabled = !state.projectId;
    });
  }

  /* ----------------------------------------------------------------------
     15. Ciclo de dados
     ---------------------------------------------------------------------- */

  function announce(message) {
    $('live-region').textContent = message;
  }

  function announceAlert(message) {
    $('alert-region').textContent = message;
  }

  function loadHome() {
    return getJson('/api/home')
      .then(function (home) {
        state.home = home;
        state.error = null;

        $('canvas-meta').textContent =
          home.product + ' ' + home.version + ' • painel local • ' + fullTime(home.generatedAt);
        $('rail-avatar').textContent = initials(home.product);

        renderStats(home);

        if (!state.projectId && home.projects.length > 0) {
          state.projectId = home.projects[0].id;
        }

        renderProjectList(home);
        renderAgents(home);

        var project = home.projects.filter(function (item) {
          return item.id === state.projectId;
        })[0];
        renderProjectHeader(project || null);

        return project ? loadRuns(project.id) : renderEmptyRun();
      })
      .catch(function (error) {
        state.error = error.message;
        var box = $('project-list-error');
        box.textContent = 'Falha ao carregar dados: ' + error.message;
        show(box, true);
        $('project-list').setAttribute('aria-busy', 'false');
        announceAlert('Falha ao carregar dados do painel: ' + error.message);
      });
  }

  function loadRuns(projectId) {
    return getJson('/api/projects/' + encodeURIComponent(projectId) + '/runs')
      .then(function (payload) {
        state.runs = payload.runs || [];
        if (state.runs.length === 0) {
          state.runId = null;
          renderRunSelector();
          renderHistory();
          return renderEmptyRun();
        }
        var stillThere = state.runs.some(function (run) {
          return run.runId === state.runId;
        });
        if (!stillThere) state.runId = state.runs[0].runId;
        renderRunSelector();
        renderHistory();
        return loadRun(projectId, state.runId);
      })
      .catch(function (error) {
        var box = $('timeline-error');
        box.textContent = 'Falha ao listar execuções: ' + error.message;
        show(box, true);
      });
  }

  function loadRun(projectId, runId) {
    return getJson(
      '/api/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId),
    )
      .then(function (payload) {
        state.run = payload.run;
        show($('timeline-error'), false);
        renderRun(payload.run);
      })
      .catch(function (error) {
        var box = $('timeline-error');
        box.textContent = 'Falha ao carregar a execução: ' + error.message;
        show(box, true);
        $('timeline').setAttribute('aria-busy', 'false');
      });
  }

  /* ----------------------------------------------------------------------
     15b. Estados explícitos da execução

     O Figma desenhava um único estado feliz. O domínio tem oito que o operador
     precisa distinguir, e cada um muda o que ele pode fazer.
     ---------------------------------------------------------------------- */

  var RUN_STATUS = {
    paused: {
      kind: 'paused',
      text: 'Execução pausada. O estado está preservado; use "Retomar" para continuar.',
    },
    waiting: {
      kind: 'waiting',
      text: 'Aguardando decisão humana. A execução parou de propósito e não avança sozinha.',
    },
    completed: {
      kind: 'completed',
      text: 'Execução concluída.',
    },
    failed: {
      kind: 'failed',
      text: 'Execução encerrada com falha. O erro está registrado na linha do tempo.',
    },
    running: null,
    idle: null,
  };

  function runStatusOf(run) {
    if (!run) return 'idle';
    if (run.pauseRequested || run.state === 'INTERRUPTED') return 'paused';
    if (AWAITING_HUMAN[run.state]) return 'waiting';
    if (run.state === 'COMPLETED' || run.state === 'MERGED') return 'completed';
    if (run.state === 'FAILED' || run.state === 'CANCELLED') return 'failed';
    return 'running';
  }

  function renderRunStatus(run) {
    var box = $('run-status');

    /* Desconexão vence qualquer estado da execução: com o transporte fora, o
       que está na tela pode já estar velho, e isso precisa ser dito. */
    if (state.transport === 'down') {
      box.dataset.kind = 'disconnected';
      box.textContent =
        'Sem conexão com o servidor. Os dados exibidos podem estar desatualizados.';
      show(box, true);
      return;
    }

    var status = RUN_STATUS[runStatusOf(run)];
    if (!status) {
      show(box, false);
      return;
    }

    box.dataset.kind = status.kind;
    box.textContent = status.text;
    show(box, true);
  }

  /** Esqueletos de carregamento — marcam o espaço antes do primeiro dado. */
  function renderLoading() {
    var list = $('project-list');
    clear(list);
    for (var i = 0; i < 3; i += 1) {
      var item = document.createElement('li');
      item.appendChild(el('div', 'skeleton skeleton--card'));
      item.setAttribute('aria-hidden', 'true');
      list.appendChild(item);
    }

    var timeline = $('timeline');
    clear(timeline);
    for (var j = 0; j < 3; j += 1) {
      var event = document.createElement('li');
      event.appendChild(el('div', 'skeleton skeleton--event'));
      event.setAttribute('aria-hidden', 'true');
      timeline.appendChild(event);
    }

    announce('Carregando dados do painel.');
  }

  function renderRun(run) {
    renderRunStatus(run);
    renderTimeline(run);
    renderConsole(run);
    renderGovernance(run);
    renderStageCard(run);
    renderApproval(run);
    renderPrompts(run);
    renderArtifacts(run);
    renderHeaderActions(run);
  }

  function renderEmptyRun() {
    state.run = null;
    renderRun(null);
    $('timeline').setAttribute('aria-busy', 'false');
    show($('timeline-empty'), true);
    return Promise.resolve();
  }

  function selectProject(projectId) {
    if (state.projectId === projectId) return;
    state.projectId = projectId;
    state.runId = null;
    state.run = null;
    renderProjectList(state.home);
    var project = state.home.projects.filter(function (item) {
      return item.id === projectId;
    })[0];
    renderProjectHeader(project || null);
    announce('Projeto selecionado: ' + (project ? project.name : projectId));
    loadRuns(projectId);
  }

  /* ----------------------------------------------------------------------
     16. Ligações de evento
     ---------------------------------------------------------------------- */

  function wireEvents() {
    $('run-selector').addEventListener('change', function (event) {
      state.runId = event.target.value;
      if (state.projectId && state.runId) loadRun(state.projectId, state.runId);
    });

    $('sidebar-refresh').addEventListener('click', function () {
      announce('Recarregando projetos.');
      loadHome();
    });

    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        activateTab(tab.dataset.view);
      });

      /* Padrão WAI-ARIA de abas: setas navegam, Home/End vão às pontas, e só a
         aba selecionada fica na ordem de tabulação (tabindex móvel). */
      tab.addEventListener('keydown', function (event) {
        var target = null;
        if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
        else if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === 'Home') target = tabs[0];
        else if (event.key === 'End') target = tabs[tabs.length - 1];
        if (!target) return;
        event.preventDefault();
        activateTab(target.dataset.view);
        target.focus();
      });
    });

    document.querySelectorAll('.rail-item[data-view]').forEach(function (item) {
      item.addEventListener('click', function () {
        var view = item.dataset.view;
        activateTab(view === 'execucoes' || view === 'gates' ? 'resumo' : view);
      });
    });

    document.querySelectorAll('.header-action').forEach(function (button) {
      button.addEventListener('click', function () {
        runAction(button.dataset.action);
      });
    });

    document.querySelectorAll('.console-action').forEach(function (button) {
      button.addEventListener('click', function () {
        consoleAction(button.dataset.console);
      });
    });

    $('console-form').addEventListener('submit', function (event) {
      event.preventDefault();
      /* O envio nunca manda prompt livre: reencaminha para o fluxo governado. */
      requestDecision('approve');
    });

    $('btn-approve').addEventListener('click', function () {
      requestDecision('approve');
    });
    $('btn-reject').addEventListener('click', function () {
      requestDecision('reject');
    });
  }

  var TAB_TO_RAIL = {
    resumo: 'resumo',
    agentes: 'execucoes',
    prompts: 'prompts',
    artefatos: 'artefatos',
    historico: 'historico',
  };

  function activateTab(view) {
    if (!view || !TAB_TO_RAIL[view]) return;

    document.querySelectorAll('.tab').forEach(function (tab) {
      var selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    ['resumo', 'agentes', 'prompts', 'artefatos', 'historico'].forEach(function (name) {
      var panel = $('panel-' + name);
      if (panel) panel.hidden = name !== view;
    });

    /* O console pertence ao resumo: ele some junto com a linha do tempo. */
    var console_ = document.querySelector('.console');
    if (console_) console_.hidden = view !== 'resumo';

    document.querySelectorAll('.rail-item[data-view]').forEach(function (item) {
      if (item.dataset.view === TAB_TO_RAIL[view]) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  /* ----------------------------------------------------------------------
     17. Ações governadas — sempre com confirmação e validação no servidor
     ---------------------------------------------------------------------- */

  function runAction(action) {
    if (!state.projectId) return;
    var base = '/api/projects/' + encodeURIComponent(state.projectId);

    if (action === 'open') {
      postJson('/api/open', { projectId: state.projectId, target: 'repo' })
        .then(function () {
          announce('Repositório aberto no sistema.');
        })
        .catch(function (error) {
          announceAlert('Não foi possível abrir: ' + error.message);
        });
      return;
    }

    var endpoints = { start: '/run', pause: '/pause', resume: '/resume', cancel: '/cancel' };
    if (!endpoints[action]) return;

    confirmAction(
      action === 'cancel' ? 'Cancelar a execução?' : 'Confirmar ação: ' + action,
      action === 'cancel'
        ? 'A execução em curso será interrompida. O estado já gravado é preservado.'
        : 'A ação é registrada na execução e validada pelo servidor.',
      false,
      function () {
        return postJson(base + endpoints[action], {}).then(function () {
          announce('Ação aceita: ' + action + '.');
          return loadHome();
        });
      },
    );
  }

  /** Atalhos do console: abrem alvos reais ou disparam a auditoria governada. */
  function consoleAction(kind) {
    if (!state.projectId) return;

    var OPEN_TARGET = { logs: 'logs', pr: 'pr', worktree: 'worktree' };
    if (OPEN_TARGET[kind]) {
      postJson('/api/open', {
        projectId: state.projectId,
        runId: state.runId || undefined,
        target: OPEN_TARGET[kind],
      })
        .then(function () {
          announce('Alvo aberto: ' + kind + '.');
        })
        .catch(function (error) {
          announceAlert('Não foi possível abrir ' + kind + ': ' + error.message);
        });
      return;
    }

    if (kind === 'report') {
      if (!state.runId) return;
      window.open(
        '/api/projects/' +
          encodeURIComponent(state.projectId) +
          '/runs/' +
          encodeURIComponent(state.runId) +
          '/report',
        '_blank',
        'noopener',
      );
      return;
    }

    if (kind === 'diagnostics') {
      getJson('/api/diagnostics')
        .then(function () {
          announce('Diagnóstico executado. Veja o painel clássico para o detalhe.');
        })
        .catch(function (error) {
          announceAlert('Diagnóstico falhou: ' + error.message);
        });
      return;
    }

    if (kind === 'audit') {
      if (!state.runId) return;
      confirmAction(
        'Disparar auditoria de merge?',
        'A auditoria roda Claude e Codex sobre o head atual e grava o resultado na execução.',
        false,
        function () {
          return postJson(
            '/api/projects/' +
              encodeURIComponent(state.projectId) +
              '/runs/' +
              encodeURIComponent(state.runId) +
              '/audit',
            {},
          ).then(function () {
            announce('Auditoria disparada.');
            return loadRun(state.projectId, state.runId);
          });
        },
      );
    }
  }

  function requestDecision(kind) {
    var run = state.run;
    if (!run || !AWAITING_HUMAN[run.state]) return;

    var promptId = run.currentPromptId || (run.prompts[0] && run.prompts[0].promptId) || '';
    if (!promptId) {
      announceAlert('Não há prompt corrente para autorizar.');
      return;
    }

    if (kind === 'reject') {
      confirmAction(
        'Solicitar ajuste?',
        'Nenhuma autorização é concedida. A execução permanece parada aguardando correção.',
        false,
        function () {
          announce('Ajuste solicitado. A execução segue parada.');
          return Promise.resolve();
        },
      );
      return;
    }

    var prefill = $('console-input').value.trim();
    confirmAction(
      'Autorizar a etapa ' + promptId + '?',
      'A autorização manual é registrada no RunRecord com justificativa e responsável, ' +
        'e é validada contra a política congelada da execução.',
      true,
      function (justification) {
        return postJson(
          '/api/projects/' +
            encodeURIComponent(state.projectId) +
            '/runs/' +
            encodeURIComponent(run.runId) +
            '/override',
          {
            promptId: promptId,
            justification: justification,
            authorizedBy: 'painel-local',
          },
        ).then(function () {
          $('console-input').value = '';
          announce('Autorização concedida para ' + promptId + '.');
          return loadRun(state.projectId, run.runId);
        });
      },
      prefill,
    );
  }

  /* ----------------------------------------------------------------------
     18. Diálogo de confirmação
     ---------------------------------------------------------------------- */

  var dialogState = { onConfirm: null, needsReason: false, lastFocus: null };

  function confirmAction(title, body, needsReason, onConfirm, prefill) {
    dialogState.onConfirm = onConfirm;
    dialogState.needsReason = needsReason;
    dialogState.lastFocus = document.activeElement;

    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    show($('confirm-error'), false);

    var field = $('confirm-reason').parentElement;
    field.hidden = !needsReason;
    $('confirm-reason').value = prefill || '';

    show($('confirm-backdrop'), true);
    show($('confirm-dialog'), true);
    (needsReason ? $('confirm-reason') : $('confirm-ok')).focus();
  }

  function closeDialog() {
    show($('confirm-backdrop'), false);
    show($('confirm-dialog'), false);
    dialogState.onConfirm = null;
    if (dialogState.lastFocus && dialogState.lastFocus.focus) dialogState.lastFocus.focus();
  }

  function wireDialog() {
    $('confirm-cancel').addEventListener('click', closeDialog);

    $('confirm-ok').addEventListener('click', function () {
      if (!dialogState.onConfirm) return;
      var reason = $('confirm-reason').value.trim();

      if (dialogState.needsReason && reason.length < 8) {
        var box = $('confirm-error');
        box.textContent = 'A justificativa é obrigatória e precisa ter ao menos 8 caracteres.';
        show(box, true);
        $('confirm-reason').focus();
        return;
      }

      var action = dialogState.onConfirm;
      $('confirm-ok').disabled = true;
      action(reason)
        .then(function () {
          $('confirm-ok').disabled = false;
          closeDialog();
        })
        .catch(function (error) {
          $('confirm-ok').disabled = false;
          var box = $('confirm-error');
          box.textContent = error.message;
          show(box, true);
          announceAlert('Ação recusada: ' + error.message);
        });
    });

    document.addEventListener('keydown', function (event) {
      var dialog = $('confirm-dialog');
      if (dialog.hidden) return;

      if (event.key === 'Escape') {
        closeDialog();
        return;
      }

      /* Aprisiona o foco: um diálogo modal que deixa tabular para trás da
         cortina é modal só visualmente. */
      if (event.key !== 'Tab') return;

      var focusable = Array.prototype.slice
        .call(dialog.querySelectorAll('button, input, a[href], select, textarea'))
        .filter(function (node) {
          return !node.disabled && node.offsetParent !== null;
        });
      if (focusable.length === 0) return;

      var first = focusable[0];
      var last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /* ----------------------------------------------------------------------
     19. Início
     ---------------------------------------------------------------------- */

  /* ----------------------------------------------------------------------
     19. Transporte — SSE retomável com polling como rede de segurança
     ---------------------------------------------------------------------- */

  var TRANSPORT_TEXT = {
    live: 'Tempo real',
    reconnecting: 'Reconectando',
    polling: 'Atualizando a cada 5 s',
    down: 'Sem conexão',
  };

  var CONSOLE_LIVE = {
    live: 'true',
    reconnecting: 'degraded',
    polling: 'degraded',
    down: 'false',
  };

  function renderTransport(status, detail) {
    if (status === state.transport) return;
    state.transport = status;

    var box = $('transport');
    box.dataset.status = status;
    $('transport-text').textContent = detail || TRANSPORT_TEXT[status] || status;

    $('console-dot').dataset.live = CONSOLE_LIVE[status] || 'false';
    $('console-status').textContent = TRANSPORT_TEXT[status] || status;

    /* Queda do transporte muda o que a tela significa, não só o indicador. */
    renderRunStatus(state.run);

    announce('Transporte: ' + (TRANSPORT_TEXT[status] || status) + '.');
  }

  /**
   * Um evento do fluxo diz QUE algo mudou; ele não carrega o RunRecord inteiro.
   * A recarga é dirigida: só o que o evento tocou.
   */
  function applyEvent(event) {
    if (event.projectId && event.projectId !== state.projectId) {
      /* Projeto diferente do selecionado: só as métricas mudam. */
      loadHome();
      return;
    }

    if (event.runId && state.projectId) {
      if (event.runId !== state.runId) {
        loadRuns(state.projectId);
        return;
      }
      loadRun(state.projectId, event.runId);
      loadHome();
      return;
    }

    loadHome();
  }

  function start() {
    wireEvents();
    wireDialog();
    activateTab('resumo');
    renderLoading();
    loadHome();

    if (window.OrqEventStream) {
      window.OrqEventStream.connect({
        url: '/api/events',
        types: ['run-update', 'log'],
        pollMs: POLL_MS,
        onStatus: renderTransport,
        onEvent: applyEvent,
        /* Polling não é o transporte: é a rede de segurança que cobre o
           intervalo em que o SSE está fora. */
        onPoll: function () {
          loadHome();
        },
        /* O servidor avisou que o backlog já não cobre o buraco. */
        onResync: function () {
          announceAlert('Fluxo retomado além do backlog: recarregando o painel.');
          loadHome();
        },
      });
    } else {
      renderTransport('polling');
      window.setInterval(loadHome, POLL_MS);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
