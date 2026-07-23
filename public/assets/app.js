/* ==========================================================================
   OrqPEG — painel local.
   JavaScript puro, sem framework e sem dependência externa.
   Todo texto vindo da API passa por escapeHtml antes de virar HTML.
   ========================================================================== */

'use strict';

(function () {
  /* ------------------------------------------------------------------ */
  /* 1. Utilidades gerais                                                */
  /* ------------------------------------------------------------------ */

  var DASH = '—';
  var IS_FILE = window.location.protocol === 'file:';
  var FILE_NOTICE =
    'Esta página foi aberta direto do disco (file://), e nesse modo o navegador bloqueia o acesso à API local. ' +
    'Inicie o painel e abra http://127.0.0.1:8765 para ver os dados reais.';

  /** Escapa texto para interpolação segura em HTML (proteção contra XSS). */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var esc = escapeHtml;

  function $(id) {
    return document.getElementById(id);
  }

  function setHtml(id, html) {
    var node = $(id);
    if (node) node.innerHTML = html;
  }

  function setText(id, text) {
    var node = $(id);
    if (node) node.textContent = text === null || text === undefined ? '' : String(text);
  }

  function on(id, event, handler) {
    var node = $(id);
    if (node) node.addEventListener(event, handler);
  }

  function iconRef(name) {
    return 'assets/icons.svg#' + name;
  }

  function icon(name, className) {
    return (
      '<svg class="' +
      esc(className || 'ic') +
      '" aria-hidden="true" focusable="false"><use href="' +
      esc(iconRef(name)) +
      '"></use></svg>'
    );
  }

  function param(name) {
    var params = new URLSearchParams(window.location.search);
    var value = params.get(name);
    return value === null ? '' : value;
  }

  function isNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
  }

  function text(value) {
    if (value === null || value === undefined || value === '') return DASH;
    return String(value);
  }

  /* ------------------------------------------------------------------ */
  /* 2. Camada de API                                                    */
  /* ------------------------------------------------------------------ */

  function request(method, path, body) {
    if (IS_FILE) {
      return Promise.resolve({ ok: false, status: 0, error: FILE_NOTICE });
    }

    var init = { method: method, cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return fetch(path, init).then(
      function (response) {
        var contentType = response.headers.get('content-type') || '';
        var reader = contentType.indexOf('json') >= 0 ? response.json() : response.text();
        return reader.then(
          function (payload) {
            if (!response.ok) {
              var message =
                payload && typeof payload === 'object' && typeof payload.error === 'string'
                  ? payload.error
                  : 'O servidor respondeu HTTP ' + response.status + '.';
              return { ok: false, status: response.status, error: message };
            }
            return { ok: true, status: response.status, data: payload };
          },
          function () {
            return {
              ok: false,
              status: response.status,
              error: 'Resposta do servidor em formato inesperado.',
            };
          }
        );
      },
      function (error) {
        return {
          ok: false,
          status: 0,
          error:
            'Não foi possível falar com o servidor do painel: ' +
            (error && error.message ? error.message : String(error)),
        };
      }
    );
  }

  function apiGet(path) {
    return request('GET', path);
  }

  function apiPost(path, body) {
    return request('POST', path, body === undefined ? {} : body);
  }

  function apiDelete(path) {
    return request('DELETE', path);
  }

  function projectPath(projectId) {
    return '/api/projects/' + encodeURIComponent(projectId);
  }

  /* ------------------------------------------------------------------ */
  /* 3. Formatação (pt-BR)                                               */
  /* ------------------------------------------------------------------ */

  var FMT_FULL = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  var FMT_SHORT = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  var FMT_RELATIVE =
    typeof Intl.RelativeTimeFormat === 'function'
      ? new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
      : null;

  function toDate(value) {
    if (typeof value !== 'string' || value === '') return null;
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function fmtDateTime(value) {
    var date = toDate(value);
    if (date) return FMT_FULL.format(date);
    return value ? String(value) : DASH;
  }

  function fmtClock(value) {
    var date = toDate(value);
    if (date) return FMT_SHORT.format(date);
    return value ? String(value) : DASH;
  }

  function fmtRelative(value) {
    var date = toDate(value);
    if (!date || !FMT_RELATIVE) return '';
    var deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
    var absolute = Math.abs(deltaSeconds);
    if (absolute < 60) return FMT_RELATIVE.format(deltaSeconds, 'second');
    if (absolute < 3600) return FMT_RELATIVE.format(Math.round(deltaSeconds / 60), 'minute');
    if (absolute < 86400) return FMT_RELATIVE.format(Math.round(deltaSeconds / 3600), 'hour');
    return FMT_RELATIVE.format(Math.round(deltaSeconds / 86400), 'day');
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function fmtDuration(milliseconds) {
    if (typeof milliseconds !== 'number' || !isFinite(milliseconds) || milliseconds < 0) return DASH;
    if (milliseconds < 1000) return Math.round(milliseconds) + ' ms';
    var totalSeconds = Math.round(milliseconds / 1000);
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    if (hours > 0) return hours + ' h ' + pad2(minutes) + ' min';
    if (minutes > 0) return minutes + ' min ' + pad2(seconds) + ' s';
    return seconds + ' s';
  }

  function durationBetween(startIso, endIso) {
    var start = toDate(startIso);
    var end = toDate(endIso);
    if (!start || !end) return null;
    return end.getTime() - start.getTime();
  }

  function fmtBytes(value) {
    if (typeof value !== 'number' || !isFinite(value) || value < 0) return DASH;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1).replace('.', ',') + ' kB';
    return (value / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  }

  function fmtConfidence(value) {
    if (typeof value !== 'number' || !isFinite(value)) return DASH;
    var normalized = value > 1 ? value : value * 100;
    return Math.round(normalized) + '%';
  }

  function fmtBool(value, whenTrue, whenFalse) {
    if (value === true) return whenTrue;
    if (value === false) return whenFalse;
    return DASH;
  }

  function shortSha(value) {
    if (typeof value !== 'string' || value === '') return DASH;
    return value.length > 12 ? value.slice(0, 12) : value;
  }

  function joinList(values) {
    if (!isNonEmptyArray(values)) return DASH;
    return values.join(', ');
  }

  /* ------------------------------------------------------------------ */
  /* 4. Status e chips                                                   */
  /* ------------------------------------------------------------------ */

  var RUN_STATE_LABEL = {
    IDLE: 'Ocioso',
    VALIDATING: 'Validando',
    PREPARING_WORKTREE: 'Preparando worktree',
    RUNNING_CLAUDE: 'Claude executando',
    RUNNING_TESTS: 'Testes locais',
    BUILDING_REVIEW_PACKAGE: 'Montando pacote de revisão',
    RUNNING_CODEX: 'Codex revisando',
    CHANGES_REQUESTED: 'Mudanças solicitadas',
    PROMPT_APPROVED: 'Prompt aprovado',
    COMMITTING: 'Criando commit',
    PUSHING: 'Enviando ao remoto',
    CREATING_PR: 'Criando pull request',
    WAITING_CI: 'Aguardando CI',
    CI_FAILED: 'CI falhou',
    RUNNING_CLAUDE_MERGE_AUDIT: 'Auditoria Claude',
    RUNNING_CODEX_MERGE_AUDIT: 'Auditoria Codex',
    MERGE_CONSENSUS_PENDING: 'Consenso pendente',
    MERGE_APPROVED: 'Merge aprovado',
    MERGING: 'Mesclando',
    MERGED: 'Mesclado',
    BLOCKED: 'Bloqueado',
    AUTH_REQUIRED: 'Autenticação necessária',
    USAGE_LIMIT_REACHED: 'Limite de uso atingido',
    INTERRUPTED: 'Interrompido',
    FAILED: 'Falhou',
    COMPLETED: 'Concluído',
    CANCELLED: 'Cancelado',
  };

  var RUN_STATE_TONE = {
    IDLE: 'pending',
    VALIDATING: 'running',
    PREPARING_WORKTREE: 'running',
    RUNNING_CLAUDE: 'running',
    RUNNING_TESTS: 'running',
    BUILDING_REVIEW_PACKAGE: 'running',
    RUNNING_CODEX: 'running',
    CHANGES_REQUESTED: 'waiting',
    PROMPT_APPROVED: 'approved',
    COMMITTING: 'running',
    PUSHING: 'running',
    CREATING_PR: 'running',
    WAITING_CI: 'waiting',
    CI_FAILED: 'failed',
    RUNNING_CLAUDE_MERGE_AUDIT: 'audit',
    RUNNING_CODEX_MERGE_AUDIT: 'audit',
    MERGE_CONSENSUS_PENDING: 'audit',
    MERGE_APPROVED: 'approved',
    MERGING: 'running',
    MERGED: 'approved',
    BLOCKED: 'failed',
    AUTH_REQUIRED: 'failed',
    USAGE_LIMIT_REACHED: 'failed',
    INTERRUPTED: 'waiting',
    FAILED: 'failed',
    COMPLETED: 'approved',
    CANCELLED: 'pending',
  };

  var TERMINAL_STATES = {
    MERGED: true,
    COMPLETED: true,
    FAILED: true,
    CANCELLED: true,
  };

  var PROMPT_STATUS_LABEL = {
    PENDING: 'PENDENTE',
    RUNNING: 'EXECUTANDO',
    CHANGES_REQUESTED: 'MUDANÇAS SOLICITADAS',
    APPROVED: 'APROVADO',
    BLOCKED: 'BLOQUEADO',
    SKIPPED: 'IGNORADO',
    FAILED: 'FALHOU',
  };

  var PROMPT_STATUS_TONE = {
    PENDING: 'pending',
    RUNNING: 'running',
    CHANGES_REQUESTED: 'waiting',
    APPROVED: 'approved',
    BLOCKED: 'failed',
    SKIPPED: 'pending',
    FAILED: 'failed',
  };

  var REVIEW_VERDICT_LABEL = {
    APPROVED: 'APROVADO',
    CHANGES_REQUESTED: 'MUDANÇAS SOLICITADAS',
    BLOCKED: 'BLOQUEADO',
  };

  var REVIEW_VERDICT_TONE = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'waiting',
    BLOCKED: 'failed',
  };

  var MERGE_VERDICT_LABEL = {
    APPROVED_FOR_MERGE: 'APROVADO PARA MERGE',
    CHANGES_REQUIRED: 'MUDANÇAS NECESSÁRIAS',
    BLOCKED: 'BLOQUEADO',
  };

  var MERGE_VERDICT_TONE = {
    APPROVED_FOR_MERGE: 'approved',
    CHANGES_REQUIRED: 'waiting',
    BLOCKED: 'failed',
  };

  var GATE_STATUS_LABEL = {
    PASSED: 'PASSOU',
    FAILED: 'FALHOU',
    SKIPPED: 'IGNORADO',
    NOT_EVALUATED: 'NÃO AVALIADO',
  };

  var GATE_STATUS_TONE = {
    PASSED: 'approved',
    FAILED: 'failed',
    SKIPPED: 'waiting',
    NOT_EVALUATED: 'pending',
  };

  var GATE_MODIFIER = {
    PASSED: 'passed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    NOT_EVALUATED: 'pending',
  };

  var DIAGNOSTIC_TONE = {
    OK: 'approved',
    AVISO: 'waiting',
    ERRO: 'failed',
  };

  /** Catálogo canônico dos 20 gates de merge, na ordem de avaliação. */
  var GATE_CATALOG = [
    { id: 'ALL_PROMPTS_APPROVED', index: 1, title: 'Todos os prompts foram aprovados' },
    { id: 'ALL_COMMITS_CREATED', index: 2, title: 'Todos os commits foram criados' },
    { id: 'BRANCH_PUSHED_TO_CORRECT_REMOTE', index: 3, title: 'A branch foi enviada ao remoto correto' },
    { id: 'PR_OPEN', index: 4, title: 'A pull request está aberta' },
    { id: 'PR_BASE_CORRECT', index: 5, title: 'A base da pull request está correta' },
    { id: 'NO_CONFLICTS', index: 6, title: 'Não existe conflito' },
    { id: 'LOCAL_TESTS_PASSED', index: 7, title: 'Testes locais passaram' },
    { id: 'REQUIRED_CHECKS_PASSED', index: 8, title: 'Todos os checks obrigatórios passaram' },
    { id: 'NO_PENDING_REQUIRED_CHECKS', index: 9, title: 'Nenhum check obrigatório está pendente' },
    { id: 'NO_SKIPPED_REQUIRED_CHECKS', index: 10, title: 'Nenhum check obrigatório foi ignorado' },
    { id: 'NO_UNRESOLVED_THREADS', index: 11, title: 'Não existem threads não resolvidas' },
    { id: 'NO_HUMAN_CHANGES_REQUESTED', index: 12, title: 'Não existe revisão humana solicitando mudanças' },
    { id: 'CLAUDE_MERGE_APPROVED', index: 13, title: 'Claude Merge Auditor aprovou' },
    { id: 'CODEX_MERGE_APPROVED', index: 14, title: 'Codex Merge Auditor aprovou' },
    { id: 'AUDITORS_SAME_HEAD_SHA', index: 15, title: 'Ambos revisaram o mesmo head SHA' },
    { id: 'MINIMUM_CONFIDENCE_MET', index: 16, title: 'Ambos atingiram a confiança mínima' },
    { id: 'NO_BLOCKING_ISSUES', index: 17, title: 'Nenhum registrou problema bloqueador' },
    { id: 'HEAD_SHA_UNCHANGED', index: 18, title: 'O head SHA não mudou' },
    { id: 'BASE_NOT_INVALIDATED', index: 19, title: 'A base não mudou de forma invalidante' },
    { id: 'PROJECT_ALLOWS_DUAL_AI_CONSENSUS', index: 20, title: 'O projeto permite dual_ai_consensus' },
  ];

  function chip(label, tone) {
    return '<span class="chip chip--' + esc(tone || 'pending') + '">' + esc(label) + '</span>';
  }

  function runStateChip(state) {
    if (!state) return chip('SEM EXECUÇÃO', 'pending');
    var label = RUN_STATE_LABEL[state] || state;
    return chip(label, RUN_STATE_TONE[state] || 'pending');
  }

  function promptStatusChip(status) {
    if (!status) return chip('SEM REGISTRO', 'pending');
    return chip(PROMPT_STATUS_LABEL[status] || status, PROMPT_STATUS_TONE[status] || 'pending');
  }

  function ciChip(status) {
    if (!status) return chip('SEM CI', 'pending');
    var tone =
      status === 'aprovado'
        ? 'approved'
        : status === 'falha'
        ? 'failed'
        : status === 'pendente'
        ? 'waiting'
        : 'pending';
    return chip(String(status).toUpperCase(), tone);
  }

  function boolChip(value, whenTrue, whenFalse, toneTrue, toneFalse) {
    if (value === true) return chip(whenTrue, toneTrue || 'approved');
    if (value === false) return chip(whenFalse, toneFalse || 'failed');
    return chip('SEM DADOS', 'pending');
  }

  /* ------------------------------------------------------------------ */
  /* 5. Links externos                                                   */
  /* ------------------------------------------------------------------ */

  var GITHUB_PREFIX = 'https://github.com/';
  var REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  function githubRepoLink(repository) {
    if (typeof repository !== 'string' || !REPO_PATTERN.test(repository)) return esc(text(repository));
    return (
      '<a href="' +
      esc(GITHUB_PREFIX + repository) +
      '" target="_blank" rel="noopener noreferrer">' +
      esc(repository) +
      icon('external', 'ic ic--inline') +
      '</a>'
    );
  }

  /** Só renderiza como link URLs de pull request do GitHub, como o servidor exige. */
  function prLink(url, label) {
    if (typeof url !== 'string' || url.indexOf(GITHUB_PREFIX) !== 0) return esc(text(label));
    return (
      '<a href="' +
      esc(url) +
      '" target="_blank" rel="noopener noreferrer">' +
      esc(text(label)) +
      icon('external', 'ic ic--inline') +
      '</a>'
    );
  }

  function internalLink(href, label, extraClass) {
    return (
      '<a class="' + esc(extraClass || '') + '" href="' + esc(href) + '">' + esc(label) + '</a>'
    );
  }

  /* ------------------------------------------------------------------ */
  /* 6. Banner de mensagens                                              */
  /* ------------------------------------------------------------------ */

  function showBanner(kind, message) {
    var banner = $('banner');
    if (!banner) return;
    banner.className = 'banner' + (kind === 'ok' ? ' banner--ok' : kind === 'info' ? ' banner--info' : '');
    banner.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    setText('banner-text', message);
    var use = banner.querySelector('use');
    if (use) use.setAttribute('href', iconRef(kind === 'error' ? 'alert' : 'check'));
    banner.hidden = false;
  }

  function hideBanner() {
    var banner = $('banner');
    if (banner) banner.hidden = true;
  }

  function wireBanner() {
    on('banner-close', 'click', hideBanner);
  }

  /* ------------------------------------------------------------------ */
  /* 7. Atualização em tempo real (SSE + polling)                        */
  /* ------------------------------------------------------------------ */

  function createLiveUpdates(options) {
    var source = null;
    var pollTimer = null;
    var reconnectTimer = null;
    var attempts = 0;
    var closed = false;

    function setStatus(kind, label) {
      var box = $('conn');
      if (box) box.className = 'conn is-' + kind;
      setText('conn-label', label);
    }

    function startPolling() {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(function () {
        options.onRefresh('polling');
      }, 5000);
    }

    function stopPolling() {
      if (pollTimer === null) return;
      window.clearInterval(pollTimer);
      pollTimer = null;
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== null) return;
      attempts += 1;
      var delay = Math.min(30000, 2000 * attempts);
      reconnectTimer = window.setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (closed) return;
      if (IS_FILE) {
        setStatus('down', 'Sem servidor (file://)');
        return;
      }
      if (typeof window.EventSource !== 'function') {
        setStatus('poll', 'Atualização a cada 5 s');
        startPolling();
        return;
      }

      setStatus('poll', 'Conectando…');
      try {
        source = new EventSource('/api/events');
      } catch (error) {
        setStatus('down', 'Falha ao abrir o fluxo de eventos');
        startPolling();
        scheduleReconnect();
        return;
      }

      source.onopen = function () {
        attempts = 0;
        stopPolling();
        setStatus('live', 'Tempo real');
      };

      source.onmessage = function (event) {
        var payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch (error) {
          return;
        }
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'heartbeat') return;
        options.onEvent(payload);
      };

      source.onerror = function () {
        if (source) {
          try {
            source.close();
          } catch (error) {
            /* o fluxo já estava fechado */
          }
          source = null;
        }
        setStatus('poll', 'Reconectando — atualizando a cada 5 s');
        startPolling();
        scheduleReconnect();
      };
    }

    connect();

    window.addEventListener('beforeunload', function () {
      closed = true;
      stopPolling();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (source) {
        try {
          source.close();
        } catch (error) {
          /* nada a fazer no descarregamento da página */
        }
      }
    });
  }

  /** Evita rajadas de atualização quando muitos eventos chegam juntos. */
  function throttle(fn, waitMs) {
    var pending = false;
    var lastRun = 0;
    return function () {
      var now = Date.now();
      if (now - lastRun >= waitMs) {
        lastRun = now;
        fn();
        return;
      }
      if (pending) return;
      pending = true;
      window.setTimeout(function () {
        pending = false;
        lastRun = Date.now();
        fn();
      }, waitMs - (now - lastRun));
    };
  }

  /* ------------------------------------------------------------------ */
  /* 8. Blocos reutilizáveis de renderização                             */
  /* ------------------------------------------------------------------ */

  function emptyRow(columns, message) {
    return '<tr><td class="empty" colspan="' + esc(String(columns)) + '">' + esc(message) + '</td></tr>';
  }

  function kvRow(label, valueHtml) {
    return '<dt>' + esc(label) + '</dt><dd>' + valueHtml + '</dd>';
  }

  /** Linha compacta de especificação: rótulo curto à esquerda, valor à direita. */
  function specRow(label, valueHtml) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + valueHtml + '</dd></div>';
  }

  /** Valor técnico em uma única linha; o texto integral fica no atributo title. */
  function monoLine(value) {
    var full = text(value);
    return '<span class="mono truncate" title="' + esc(full) + '">' + esc(full) + '</span>';
  }

  /** Nomes de variáveis lado a lado, em vez de uma coluna alta de texto. */
  function tagList(values, tone) {
    if (!isNonEmptyArray(values)) {
      return '<span class="taglist"><span class="tag tag--none">Nenhuma</span></span>';
    }
    var suffix = tone ? ' tag--' + tone : '';
    return (
      '<span class="taglist">' +
      values
        .map(function (value) {
          return '<span class="tag' + suffix + '">' + esc(text(value)) + '</span>';
        })
        .join('') +
      '</span>'
    );
  }

  function metric(value, label, tone) {
    return (
      '<div class="metric metric--' +
      esc(tone) +
      '"><div class="metric__value">' +
      esc(String(value)) +
      '</div><div class="metric__label">' +
      esc(label) +
      '</div></div>'
    );
  }

  function toolCard(tool) {
    var availability = boolChip(tool.available === true, 'DISPONÍVEL', 'AUSENTE');
    var auth =
      tool.authenticated === true
        ? chip('AUTENTICADO', 'approved')
        : tool.authenticated === false
        ? chip('SEM AUTENTICAÇÃO', 'failed')
        : chip('NÃO SE APLICA', 'pending');

    return (
      '<article class="card">' +
      '<div class="card-head"><h3>' +
      esc(text(tool.name)) +
      '</h3>' +
      '<span class="chipset">' + availability + auth + '</span>' +
      '</div>' +
      '<dl class="speclist">' +
      specRow('Comando', monoLine(tool.command)) +
      specRow('Versão', monoLine(tool.version)) +
      specRow('Caminho', monoLine(tool.path)) +
      '</dl>' +
      '<p class="faint">' + esc(text(tool.detail)) + '</p>' +
      '</article>'
    );
  }

  /**
   * Guarda de API como faixa operacional horizontal.
   *
   * Deixou de ser um cartão no meio das ferramentas porque não é uma
   * ferramenta: é um estado do ambiente. Aqui ele ganha bloco próprio, com o
   * veredito em destaque no cabeçalho e os parâmetros em linhas rotuladas.
   */
  function apiGuardStrip(guard) {
    if (!guard || typeof guard !== 'object') {
      return '<p class="empty">Sem dados</p>';
    }
    var blocked = guard.blocked === true;
    var warned = !blocked && Array.isArray(guard.warnKeys) && guard.warnKeys.length > 0;

    return (
      '<div class="opstrip">' +
      '<div class="opstrip__head">' +
      '<span class="opstrip__title">Ambiente dos processos filhos</span>' +
      (blocked
        ? chip('EXECUÇÃO BLOQUEADA', 'failed')
        : warned
        ? chip('AMBIENTE LIMPO · COM AVISO', 'waiting')
        : chip('AMBIENTE LIMPO', 'approved')) +
      '</div>' +
      '<div class="opstrip__rows">' +
      opRow('Detectadas', tagList(guard.presentKeys, blocked ? 'danger' : 'warn')) +
      opRow('Aviso', tagList(guard.warnKeys, 'warn')) +
      opRow('Removidas', tagList(guard.strippedForChildren, '')) +
      '</div>' +
      '<p class="opstrip__note">' +
      'Apenas os nomes são inspecionados. O valor de uma variável de API nunca é lido, ' +
      'gravado em log, incluído em relatório nem exibido neste painel. A remoção ocorre ' +
      'somente na cópia entregue ao processo filho; o ambiente do Windows permanece intacto.' +
      '</p>' +
      '</div>'
    );
  }

  function opRow(label, valueHtml) {
    return (
      '<div class="opstrip__row"><span class="opstrip__label">' +
      esc(label) +
      '</span><span class="opstrip__value">' +
      valueHtml +
      '</span></div>'
    );
  }

  function renderDiagnostics(report) {
    var card = $('card-diagnostics');
    if (card) card.hidden = false;

    // Vazio não abre tabela: uma única linha informativa basta. Cabeçalho de
    // coluna sem dado algum é ruído, não informação.
    var wrap = $('diagnostics-table-wrap');
    if (!report || typeof report !== 'object' || !Array.isArray(report.items) || report.items.length === 0) {
      if (wrap) wrap.hidden = true;
      setText(
        'diagnostics-summary',
        'Nenhum diagnóstico executado nesta sessão. Use "Diagnóstico" para verificar sistema, ferramentas, schemas, wrappers, porta e locks.'
      );
      var emptyOverall = $('diagnostics-overall');
      if (emptyOverall) emptyOverall.innerHTML = '';
      return;
    }
    if (wrap) wrap.hidden = false;

    var counts = report.counts || {};
    setText(
      'diagnostics-summary',
      'Gerado em ' +
        fmtDateTime(report.generatedAt) +
        ' · versão ' +
        text(report.orqpegVersion) +
        ' · ' +
        text(counts.ok) +
        ' OK, ' +
        text(counts.aviso) +
        ' avisos, ' +
        text(counts.erro) +
        ' erros'
    );

    var overall = $('diagnostics-overall');
    if (overall) {
      overall.innerHTML = chip(text(report.overall), DIAGNOSTIC_TONE[report.overall] || 'pending');
    }

    var items = Array.isArray(report.items) ? report.items : [];
    if (items.length === 0) {
      setHtml('diagnostics-body', emptyRow(5, 'Sem itens de diagnóstico'));
      return;
    }

    setHtml(
      'diagnostics-body',
      items
        .map(function (item) {
          return (
            '<tr>' +
            '<td>' +
            chip(text(item.status), DIAGNOSTIC_TONE[item.status] || 'pending') +
            '</td>' +
            '<td>' + esc(text(item.category)) + '</td>' +
            '<th scope="row">' + esc(text(item.title)) + '</th>' +
            '<td>' + esc(text(item.detail)) + '</td>' +
            '<td>' + esc(text(item.remediation)) + '</td>' +
            '</tr>'
          );
        })
        .join('')
    );
  }

  function wireDiagnosticsButton(buttonId) {
    on(buttonId, 'click', function () {
      var button = $(buttonId);
      if (button) button.disabled = true;
      apiGet('/api/diagnostics').then(function (result) {
        if (button) button.disabled = false;
        if (!result.ok) {
          showBanner('error', 'Diagnóstico indisponível: ' + result.error);
          return;
        }
        hideBanner();
        renderDiagnostics(result.data);
        var card = $('card-diagnostics');
        if (card) card.scrollIntoView({ block: 'nearest' });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 9. Página: index.html                                               */
  /* ------------------------------------------------------------------ */

  function initHome() {
    var refresh = function () {
      apiGet('/api/home').then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          renderHomeEmpty();
          return;
        }
        hideBanner();
        renderHome(result.data);
      });
    };

    on('btn-refresh', 'click', refresh);
    wireDiagnosticsButton('btn-diagnostics');
    wireNewProjectDialog(refresh);

    refresh();

    createLiveUpdates({
      onEvent: throttle(refresh, 1200),
      onRefresh: refresh,
    });
  }

  function renderHomeEmpty() {
    setHtml('home-metrics', '<p class="empty">Sem dados</p>');
    setHtml('home-tools', '<p class="empty">Sem dados</p>');
    setHtml('home-apiguard', '<p class="empty">Sem dados</p>');
    setHtml('projects-body', emptyRow(12, 'Sem dados'));
    setHtml('recent-activity', '<li class="empty">Sem atividade registrada</li>');
    setHtml('merges-body', emptyRow(5, 'Nenhum merge registrado'));
    setHtml('home-generated', '<span>Sem dados do servidor</span>');
  }

  function renderHome(data) {
    var projects = Array.isArray(data.projects) ? data.projects : [];
    var tools = Array.isArray(data.tools) ? data.tools : [];

    // Faixa monoespaçada do masthead: cada dado da sessão em seu próprio
    // elemento, separados pelo filete que o CSS insere entre irmãos.
    setHtml(
      'home-generated',
      '<span>Versão ' +
        esc(text(data.version)) +
        '</span><span>dados de ' +
        esc(fmtDateTime(data.generatedAt)) +
        '</span><span>painel local 127.0.0.1</span><span>' +
        esc(text(projects.length)) +
        ' projeto(s)</span>'
    );

    var toolsOk = tools.filter(function (tool) {
      return tool && tool.available === true;
    }).length;

    setHtml(
      'home-metrics',
      metric(projects.length, 'Projetos cadastrados', 'pending') +
        metric(text(data.activeRuns), 'Execuções ativas', 'running') +
        metric(text(data.pausedRuns), 'Pausadas', 'waiting') +
        metric(text(data.blockedRuns), 'Bloqueadas', 'failed') +
        metric(toolsOk + '/' + tools.length, 'Ferramentas detectadas', 'approved') +
        metric(
          data.apiGuard && data.apiGuard.blocked ? 'BLOQUEADO' : 'LIVRE',
          'Guarda de API',
          data.apiGuard && data.apiGuard.blocked ? 'failed' : 'approved'
        )
    );

    setHtml(
      'home-tools',
      tools.length === 0 ? '<p class="empty">Sem dados</p>' : tools.map(toolCard).join('')
    );

    setHtml('home-apiguard', apiGuardStrip(data.apiGuard));

    if (projects.length === 0) {
      setHtml(
        'projects-body',
        emptyRow(12, 'Nenhum projeto cadastrado. Use "Cadastrar projeto" para começar.')
      );
    } else {
      setHtml('projects-body', projects.map(homeProjectRow).join(''));
    }

    var activity = Array.isArray(data.recentActivity) ? data.recentActivity : [];
    setHtml(
      'recent-activity',
      activity.length === 0
        ? '<li class="empty">Sem atividade registrada</li>'
        : activity
            .map(function (event) {
              var relative = fmtRelative(event.at);
              return (
                '<li><time datetime="' +
                esc(text(event.at)) +
                '">' +
                esc(fmtClock(event.at)) +
                '</time>' +
                runStateChip(event.state) +
                '<span class="msg">' +
                esc(text(event.message)) +
                (relative ? ' <span class="faint">(' + esc(relative) + ')</span>' : '') +
                '</span></li>'
              );
            })
            .join('')
    );

    var merges = Array.isArray(data.recentMerges) ? data.recentMerges : [];
    setHtml(
      'merges-body',
      merges.length === 0
        ? emptyRow(5, 'Nenhum merge registrado')
        : merges
            .map(function (item) {
              return (
                '<tr>' +
                '<th scope="row">' +
                internalLink('project.html?id=' + encodeURIComponent(text(item.projectId)), text(item.projectId)) +
                '</th>' +
                '<td>' +
                internalLink(
                  'run.html?id=' +
                    encodeURIComponent(text(item.projectId)) +
                    '&run=' +
                    encodeURIComponent(text(item.runId)),
                  text(item.runId),
                  'mono'
                ) +
                '</td>' +
                '<td class="num">' + esc(item.prNumber === null || item.prNumber === undefined ? DASH : '#' + item.prNumber) + '</td>' +
                '<td class="mono">' + esc(shortSha(item.mergeSha)) + '</td>' +
                '<td class="nowrap">' + esc(fmtDateTime(item.at)) + '</td>' +
                '</tr>'
              );
            })
            .join('')
    );
  }

  function homeProjectRow(project) {
    var promptsCell =
      '<span class="counts"><b class="c-total">' +
      esc(text(project.promptTotal)) +
      '</b>/<b class="c-ok">' +
      esc(text(project.promptApproved)) +
      '</b>/<b class="c-pend">' +
      esc(text(project.promptPending)) +
      '</b></span>';

    var runLink = project.activeRunId
      ? internalLink(
          'run.html?id=' +
            encodeURIComponent(text(project.id)) +
            '&run=' +
            encodeURIComponent(text(project.activeRunId)),
          text(project.activeRunId),
          'mono'
        )
      : '<span class="faint">' + esc(DASH) + '</span>';

    return (
      '<tr>' +
      '<th scope="row">' +
      internalLink('project.html?id=' + encodeURIComponent(text(project.id)), text(project.name)) +
      '<div class="faint mono">' +
      esc(text(project.id)) +
      '</div></th>' +
      '<td><span class="mono truncate" title="' +
      esc(text(project.repositoryPath)) +
      '">' +
      esc(text(project.repositoryPath)) +
      '</span></td>' +
      '<td>' + githubRepoLink(project.githubRepository) + '</td>' +
      '<td class="mono">' + esc(text(project.baseBranch)) + '</td>' +
      '<td>' + esc(fmtBool(project.worktreeEnabled, 'Sim', 'Não')) + '</td>' +
      '<td>' + promptsCell + '</td>' +
      '<td>' + runStateChip(project.activeState) + '<div class="faint">' + runLink + '</div></td>' +
      '<td>' +
      (project.pullRequestNumber === null || project.pullRequestNumber === undefined
        ? esc(DASH)
        : prLink(project.pullRequestUrl, '#' + project.pullRequestNumber)) +
      '</td>' +
      '<td>' + ciChip(project.ciStatus) + '</td>' +
      '<td>' +
      (project.consensusReached === null || project.consensusReached === undefined
        ? chip('SEM DADOS', 'pending')
        : boolChip(project.consensusReached, 'ALCANÇADO', 'NÃO ALCANÇADO')) +
      '</td>' +
      '<td>' + boolChip(project.merged === true, 'MESCLADO', 'NÃO MESCLADO', 'approved', 'pending') + '</td>' +
      '<td>' +
      (project.lastError
        ? '<span class="chip chip--failed">ERRO</span><div class="faint">' + esc(project.lastError) + '</div>'
        : '<span class="faint">' + esc(DASH) + '</span>') +
      '</td>' +
      '</tr>'
    );
  }

  function wireNewProjectDialog(afterCreate) {
    var dialog = $('dlg-new-project');
    if (!dialog) return;

    on('btn-new-project', 'click', function () {
      setText('new-project-error', '');
      var box = $('new-project-error-box');
      if (box) box.hidden = true;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
    });

    on('btn-new-project-cancel', 'click', function () {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    });

    var form = $('form-new-project');
    if (!form) return;

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      var payload = {
        id: valueOf('np-id'),
        name: valueOf('np-name'),
        repositoryPath: valueOf('np-repository-path'),
        githubRepository: valueOf('np-github'),
      };
      var remote = valueOf('np-remote');
      var baseBranch = valueOf('np-base-branch');
      var editor = valueOf('np-editor');
      if (remote !== '') payload.remote = remote;
      if (baseBranch !== '') payload.baseBranch = baseBranch;
      if (editor !== '') payload.editor = editor;

      var submit = $('btn-new-project-submit');
      if (submit) submit.disabled = true;

      apiPost('/api/projects', payload).then(function (result) {
        if (submit) submit.disabled = false;
        if (!result.ok) {
          var box = $('new-project-error-box');
          if (box) box.hidden = false;
          setText('new-project-error', result.error);
          return;
        }
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        form.reset();
        showBanner('ok', 'Projeto cadastrado: ' + payload.id + '.');
        afterCreate();
      });
    });
  }

  function valueOf(id) {
    var node = $(id);
    if (!node) return '';
    return String(node.value || '').trim();
  }

  /* ------------------------------------------------------------------ */
  /* 10. Página: project.html                                            */
  /* ------------------------------------------------------------------ */

  function initProject() {
    var projectId = param('id');
    if (projectId === '') {
      showBanner('error', 'Parâmetro obrigatório ausente na URL: id do projeto.');
      return;
    }

    var state = { project: null, prompts: [], runs: [] };

    function selectedRunId() {
      var select = $('run-select');
      if (select && select.value) return select.value;
      var reference = referenceRun(state.runs);
      return reference ? reference.runId : '';
    }

    function refresh() {
      apiGet(projectPath(projectId)).then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          return;
        }
        hideBanner();
        var data = result.data || {};
        state.project = data.project || null;
        state.prompts = Array.isArray(data.prompts) ? data.prompts : [];
        state.runs = Array.isArray(data.runs) ? data.runs : [];
        renderProject(projectId, state);
      });
    }

    function action(method, path, body, successMessage) {
      var pending = method === 'DELETE' ? apiDelete(path) : apiPost(path, body);
      return pending.then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          return result;
        }
        var note =
          result.data && typeof result.data === 'object' && typeof result.data.note === 'string'
            ? ' ' + result.data.note
            : '';
        showBanner('ok', successMessage + note);
        refresh();
        return result;
      });
    }

    on('btn-start', 'click', function () {
      action('POST', projectPath(projectId) + '/run', { dryRun: false }, 'Execução iniciada.');
    });
    on('btn-dry-run', 'click', function () {
      action('POST', projectPath(projectId) + '/run', { dryRun: true }, 'Dry-run iniciado: nenhuma alteração é gravada.');
    });
    on('btn-pause', 'click', function () {
      action('POST', projectPath(projectId) + '/pause', {}, 'Pausa solicitada.');
    });
    on('btn-resume', 'click', function () {
      action('POST', projectPath(projectId) + '/resume', {}, 'Retomada solicitada.');
    });
    on('btn-cancel', 'click', function () {
      action('POST', projectPath(projectId) + '/cancel', {}, 'Cancelamento solicitado.');
    });

    on('btn-open-repo', 'click', function () {
      openTarget('repo', projectId, null);
    });
    on('btn-open-worktree', 'click', function () {
      openTarget('worktree', projectId, null);
    });
    on('btn-open-editor', 'click', function () {
      openTarget('editor', projectId, null);
    });
    on('btn-open-logs', 'click', function () {
      openTarget('logs', projectId, null);
    });
    on('btn-open-pr', 'click', function () {
      var runId = selectedRunId();
      if (runId === '') {
        showBanner('error', 'Selecione uma execução para abrir a pull request.');
        return;
      }
      openTarget('pr', projectId, runId);
    });

    on('btn-report-html', 'click', function () {
      openReport(projectId, selectedRunId(), 'html');
    });
    on('btn-report-md', 'click', function () {
      openReport(projectId, selectedRunId(), 'md');
    });
    on('btn-report-json', 'click', function () {
      openReport(projectId, selectedRunId(), 'json');
    });

    on('btn-refresh', 'click', refresh);

    wireRemoveDialog(projectId, function () {
      window.location.href = 'index.html';
    });

    refresh();

    createLiveUpdates({
      onEvent: throttle(function () {
        refresh();
      }, 1200),
      onRefresh: refresh,
    });
  }

  function openTarget(target, projectId, runId) {
    var body = { target: target, projectId: projectId };
    if (runId) body.runId = runId;
    apiPost('/api/open', body).then(function (result) {
      if (!result.ok) {
        showBanner('error', result.error);
        return;
      }
      showBanner('ok', 'Pedido de abertura enviado ao sistema operacional (' + target + ').');
    });
  }

  function openReport(projectId, runId, format) {
    if (IS_FILE) {
      showBanner('error', FILE_NOTICE);
      return;
    }
    if (!runId) {
      showBanner('error', 'Selecione uma execução para exportar o relatório.');
      return;
    }
    var url =
      projectPath(projectId) +
      '/runs/' +
      encodeURIComponent(runId) +
      '/report?format=' +
      encodeURIComponent(format);
    window.open(url, '_blank', 'noopener');
  }

  function referenceRun(runs) {
    if (!isNonEmptyArray(runs)) return null;
    for (var index = 0; index < runs.length; index += 1) {
      var run = runs[index];
      if (run && !TERMINAL_STATES[run.state]) return run;
    }
    return runs[0];
  }

  function promptProgressMap(run) {
    var map = {};
    if (!run || !Array.isArray(run.prompts)) return map;
    run.prompts.forEach(function (progress) {
      if (progress && typeof progress.promptId === 'string') map[progress.promptId] = progress;
    });
    return map;
  }

  function renderProject(projectId, state) {
    var project = state.project;
    if (!project) {
      showBanner('error', 'Projeto não encontrado: ' + projectId);
      return;
    }

    document.title = project.name + ' — OrqPEG';
    setText('project-name', project.name);
    setText('crumb-project', project.name);
    setText(
      'project-sub',
      project.id + ' · ' + project.githubRepository + ' · base ' + project.baseBranch
    );
    setText('remove-project-id', project.id);
    setText('remove-project-path', project.repositoryPath);

    var reference = referenceRun(state.runs);
    var progress = promptProgressMap(reference);

    setHtml(
      'kv-identification',
      kvRow('Identificador', '<span class="mono">' + esc(project.id) + '</span>') +
        kvRow('Nome', esc(project.name)) +
        kvRow('Repositório local', '<span class="mono">' + esc(project.repositoryPath) + '</span>') +
        kvRow('GitHub', githubRepoLink(project.githubRepository)) +
        kvRow('Editor', '<span class="mono">' + esc(text(project.editor)) + '</span>') +
        kvRow('Cadastrado em', esc(fmtDateTime(project.createdAt))) +
        kvRow('Atualizado em', esc(fmtDateTime(project.updatedAt)))
    );

    setHtml(
      'kv-git',
      kvRow('Remoto', '<span class="mono">' + esc(text(project.remote)) + '</span>') +
        kvRow('Branch base', '<span class="mono">' + esc(text(project.baseBranch)) + '</span>') +
        kvRow('Estratégia de branch', '<span class="mono">' + esc(text(project.branchStrategy)) + '</span>') +
        kvRow('Commit após aprovação', esc(fmtBool(project.git && project.git.commitAfterApproval, 'Sim', 'Não'))) +
        kvRow('Push ao fim da execução', esc(fmtBool(project.git && project.git.pushAfterRun, 'Sim', 'Não'))) +
        kvRow(
          'Prefixo de commit',
          '<span class="mono">' + esc(text(project.git && project.git.commitMessagePrefix)) + '</span>'
        ) +
        kvRow(
          'Worktree',
          project.worktree && project.worktree.enabled
            ? chip('HABILITADA', 'approved')
            : chip('DESABILITADA', 'pending')
        ) +
        kvRow(
          'Raiz da worktree',
          '<span class="mono">' + esc(text(project.worktree && project.worktree.rootPath)) + '</span>'
        )
    );

    var commands = project.commands || {};
    setHtml(
      'kv-commands',
      kvRow(
        'Instalação',
        isNonEmptyArray(commands.install)
          ? '<span class="mono">' + esc(commands.install.join(' && ')) + '</span>'
          : esc('Nenhum comando configurado')
      ) +
        kvRow(
          'Testes',
          isNonEmptyArray(commands.tests)
            ? '<span class="mono">' + esc(commands.tests.join(' && ')) + '</span>'
            : esc('Nenhum comando configurado')
        ) +
        kvRow('Tempo-limite', esc(text(commands.timeoutSeconds) + ' s')) +
        kvRow(
          'Modelo Claude',
          '<span class="mono">' + esc(text(project.agents && project.agents.claudeModel)) + '</span>'
        ) +
        kvRow(
          'Modelo Codex',
          '<span class="mono">' + esc(text(project.agents && project.agents.codexModel)) + '</span>'
        )
    );

    var execution = project.execution || {};
    var pullRequest = project.pullRequest || {};
    setHtml(
      'kv-execution',
      kvRow('Tentativas por prompt', esc(text(execution.maxAttemptsPerPrompt))) +
        kvRow('Retentativas do revisor', esc(text(execution.maxReviewerRetries))) +
        kvRow('Continuar após aprovação', esc(fmtBool(execution.continueAfterApproval, 'Sim', 'Não'))) +
        kvRow('Parar ao bloquear', esc(fmtBool(execution.stopOnBlocked, 'Sim', 'Não'))) +
        kvRow('Pull request', esc(fmtBool(pullRequest.enabled, 'Habilitada', 'Desabilitada'))) +
        kvRow('Abrir como rascunho', esc(fmtBool(pullRequest.draftDuringExecution, 'Sim', 'Não'))) +
        kvRow('Marcar pronta antes do merge', esc(fmtBool(pullRequest.markReadyBeforeMerge, 'Sim', 'Não'))) +
        kvRow('Aguardar checks', esc(fmtBool(pullRequest.waitForChecks, 'Sim', 'Não')))
    );

    var merge = project.merge || {};
    setHtml(
      'kv-merge',
      kvRow('Merge automático', esc(fmtBool(merge.enabled, 'Habilitado', 'Desabilitado'))) +
        kvRow('Modo', '<span class="mono">' + esc(text(merge.mode)) + '</span>') +
        kvRow('Estratégia', '<span class="mono">' + esc(text(merge.strategy)) + '</span>') +
        kvRow('Apagar branch após merge', esc(fmtBool(merge.deleteBranchAfterMerge, 'Sim', 'Não'))) +
        kvRow('Exige aprovação do Claude', esc(fmtBool(merge.requireClaudeApproval, 'Sim', 'Não'))) +
        kvRow('Exige aprovação do Codex', esc(fmtBool(merge.requireCodexApproval, 'Sim', 'Não'))) +
        kvRow('Exige testes locais', esc(fmtBool(merge.requireLocalTests, 'Sim', 'Não'))) +
        kvRow('Exige CI verde', esc(fmtBool(merge.requireCiSuccess, 'Sim', 'Não'))) +
        kvRow('Exige ausência de conflitos', esc(fmtBool(merge.requireNoConflicts, 'Sim', 'Não'))) +
        kvRow('Exige threads resolvidas', esc(fmtBool(merge.requireNoUnresolvedThreads, 'Sim', 'Não'))) +
        kvRow('Invalida aprovação se o head mudar', esc(fmtBool(merge.invalidateApprovalOnHeadChange, 'Sim', 'Não'))) +
        kvRow('Confiança mínima', esc(fmtConfidence(merge.minimumConfidence)))
    );

    if (reference) {
      var duration = durationBetween(reference.createdAt, reference.finishedAt || reference.updatedAt);
      setHtml(
        'kv-active',
        kvRow(
          'Execução',
          internalLink(
            'run.html?id=' +
              encodeURIComponent(projectId) +
              '&run=' +
              encodeURIComponent(reference.runId),
            reference.runId,
            'mono'
          )
        ) +
          kvRow('Estado', runStateChip(reference.state)) +
          kvRow('Dry-run', esc(fmtBool(reference.dryRun, 'Sim', 'Não'))) +
          kvRow('Branch', '<span class="mono">' + esc(text(reference.branchName)) + '</span>') +
          kvRow('Worktree', '<span class="mono">' + esc(text(reference.workingDirectory || reference.worktreePath)) + '</span>') +
          kvRow('Prompt atual', '<span class="mono">' + esc(text(reference.currentPromptId)) + '</span>') +
          kvRow('Tentativa', esc(text(reference.currentAttempt))) +
          kvRow('Criada em', esc(fmtDateTime(reference.createdAt))) +
          kvRow('Atualizada em', esc(fmtDateTime(reference.updatedAt))) +
          kvRow('Duração', esc(duration === null ? DASH : fmtDuration(duration))) +
          kvRow(
            'Pull request',
            reference.pullRequest
              ? prLink(reference.pullRequest.url, '#' + reference.pullRequest.number)
              : esc(DASH)
          ) +
          kvRow('Pausa solicitada', esc(fmtBool(reference.pauseRequested, 'Sim', 'Não'))) +
          kvRow('Cancelamento solicitado', esc(fmtBool(reference.cancelRequested, 'Sim', 'Não'))) +
          kvRow(
            'Último erro',
            reference.lastError
              ? '<span class="chip chip--failed">' +
                esc(text(reference.lastError.code)) +
                '</span> ' +
                esc(text(reference.lastError.message))
              : esc(DASH)
          )
      );
    } else {
      setHtml('kv-active', kvRow('Execução', esc('Nenhuma execução registrada para este projeto.')));
    }

    if (state.prompts.length === 0) {
      setHtml(
        'prompts-body',
        emptyRow(8, 'Nenhum prompt encontrado em data/projects/' + projectId + '/prompts.')
      );
    } else {
      setHtml(
        'prompts-body',
        state.prompts
          .map(function (prompt, position) {
            var item = progress[prompt.id] || null;
            var order = typeof prompt.order === 'number' && prompt.order > 0 ? prompt.order : position + 1;
            return (
              '<tr>' +
              '<td class="mono num">' + esc(padOrder(order)) + '</td>' +
              '<th scope="row">' +
              internalLink(
                'prompt.html?id=' +
                  encodeURIComponent(projectId) +
                  '&prompt=' +
                  encodeURIComponent(prompt.id),
                text(prompt.name)
              ) +
              '</th>' +
              '<td class="mono">' + esc(text(prompt.fileName)) + '</td>' +
              '<td class="num">' + esc(fmtBytes(prompt.sizeBytes)) + '</td>' +
              '<td>' + promptStatusChip(item ? item.status : null) + '</td>' +
              '<td class="num">' + esc(item ? text(item.attempts) : DASH) + '</td>' +
              '<td>' +
              (item && item.lastVerdict
                ? chip(
                    REVIEW_VERDICT_LABEL[item.lastVerdict] || item.lastVerdict,
                    REVIEW_VERDICT_TONE[item.lastVerdict] || 'pending'
                  )
                : esc(DASH)) +
              '</td>' +
              '<td class="mono">' + esc(item ? shortSha(item.commitSha) : DASH) + '</td>' +
              '</tr>'
            );
          })
          .join('')
      );
    }

    if (state.runs.length === 0) {
      setHtml('runs-body', emptyRow(9, 'Nenhuma execução registrada'));
    } else {
      setHtml(
        'runs-body',
        state.runs
          .map(function (run) {
            var approved = Array.isArray(run.prompts)
              ? run.prompts.filter(function (item) {
                  return item && item.status === 'APPROVED';
                }).length
              : 0;
            var total = Array.isArray(run.prompts) ? run.prompts.length : 0;
            var duration = durationBetween(run.createdAt, run.finishedAt || run.updatedAt);
            var runUrl =
              'run.html?id=' + encodeURIComponent(projectId) + '&run=' + encodeURIComponent(run.runId);
            var reportUrl =
              projectPath(projectId) + '/runs/' + encodeURIComponent(run.runId) + '/report?format=html';
            return (
              '<tr>' +
              '<th scope="row">' + internalLink(runUrl, run.runId, 'mono') + '</th>' +
              '<td>' + runStateChip(run.state) + '</td>' +
              '<td>' + esc(fmtBool(run.dryRun, 'Sim', 'Não')) + '</td>' +
              '<td class="nowrap">' + esc(fmtDateTime(run.createdAt)) + '</td>' +
              '<td class="nowrap">' + esc(duration === null ? DASH : fmtDuration(duration)) + '</td>' +
              '<td class="num mono">' + esc(approved + '/' + total) + '</td>' +
              '<td>' +
              (run.pullRequest ? prLink(run.pullRequest.url, '#' + run.pullRequest.number) : esc(DASH)) +
              '</td>' +
              '<td>' +
              (run.mergeOutcome && run.mergeOutcome.merged
                ? chip('MESCLADO', 'approved')
                : run.mergeOutcome && run.mergeOutcome.attempted
                ? chip('NÃO MESCLADO', 'failed')
                : chip('SEM MERGE', 'pending')) +
              '</td>' +
              '<td>' +
              (IS_FILE
                ? '<span class="faint">' + esc(DASH) + '</span>'
                : '<a href="' + esc(reportUrl) + '" target="_blank" rel="noopener noreferrer">Relatório' +
                  icon('external', 'ic ic--inline') +
                  '</a>') +
              '</td>' +
              '</tr>'
            );
          })
          .join('')
      );
    }

    var select = $('run-select');
    if (select) {
      var previous = select.value;
      select.innerHTML = state.runs
        .map(function (run) {
          return (
            '<option value="' +
            esc(run.runId) +
            '">' +
            esc(run.runId + ' — ' + (RUN_STATE_LABEL[run.state] || run.state)) +
            '</option>'
          );
        })
        .join('');
      if (state.runs.length === 0) {
        select.innerHTML = '<option value="">Nenhuma execução</option>';
      } else if (previous) {
        select.value = previous;
        if (!select.value && reference) select.value = reference.runId;
      } else if (reference) {
        select.value = reference.runId;
      }
    }
  }

  function padOrder(order) {
    var value = typeof order === 'number' && isFinite(order) ? Math.trunc(order) : 0;
    var raw = String(Math.abs(value));
    while (raw.length < 3) raw = '0' + raw;
    return raw;
  }

  function wireRemoveDialog(projectId, afterRemove) {
    var dialog = $('dlg-remove');
    if (!dialog) return;

    on('btn-remove', 'click', function () {
      var input = $('remove-confirm');
      if (input) input.value = '';
      var submit = $('btn-remove-confirm');
      if (submit) submit.disabled = true;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', 'open');
    });

    on('remove-confirm', 'input', function () {
      var input = $('remove-confirm');
      var submit = $('btn-remove-confirm');
      if (submit) submit.disabled = !input || String(input.value).trim() !== projectId;
    });

    on('btn-remove-cancel', 'click', function () {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    });

    on('btn-remove-confirm', 'click', function () {
      apiDelete(projectPath(projectId)).then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          return;
        }
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        afterRemove();
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 11. Página: run.html                                                */
  /* ------------------------------------------------------------------ */

  function initRun() {
    var projectId = param('id');
    var runId = param('run');

    if (projectId === '' || runId === '') {
      showBanner('error', 'Parâmetros obrigatórios ausentes na URL: id do projeto e run.');
      return;
    }

    var base = projectPath(projectId) + '/runs/' + encodeURIComponent(runId);

    function refresh() {
      Promise.all([
        apiGet(base),
        apiGet(projectPath(projectId) + '/prompts'),
        apiGet(base + '/consensus'),
      ]).then(function (results) {
        var runResult = results[0];
        var promptsResult = results[1];
        var consensusResult = results[2];

        if (!runResult.ok) {
          showBanner('error', runResult.error);
          return;
        }
        hideBanner();

        var run = (runResult.data && runResult.data.run) || null;
        var prompts =
          promptsResult.ok && promptsResult.data && Array.isArray(promptsResult.data.prompts)
            ? promptsResult.data.prompts
            : [];
        var consensusPayload = consensusResult.ok ? consensusResult.data || {} : {};

        // Limites e situação de override vêm do servidor junto com a execução:
        // o painel não adivinha a configuração do projeto.
        if (run && runResult.data) {
          run.__loopGuard = runResult.data.loopGuard || null;
          run.__override = runResult.data.override || null;
          run.__policyUnavailable = runResult.data.policyUnavailable || null;
          run.__policyDrift = runResult.data.projectConfigDrift || null;
        }

        renderRun(projectId, runId, run, prompts, consensusPayload);
      });
    }

    function action(path, body, successMessage) {
      apiPost(path, body).then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          return;
        }
        var note =
          result.data && typeof result.data === 'object' && typeof result.data.note === 'string'
            ? ' ' + result.data.note
            : '';
        showBanner('ok', successMessage + note);
        refresh();
      });
    }

    on('btn-refresh', 'click', refresh);
    on('btn-pause', 'click', function () {
      action(projectPath(projectId) + '/pause', {}, 'Pausa solicitada.');
    });
    on('btn-resume', 'click', function () {
      action(projectPath(projectId) + '/resume', {}, 'Retomada solicitada.');
    });
    on('btn-cancel', 'click', function () {
      action(projectPath(projectId) + '/cancel', {}, 'Cancelamento solicitado.');
    });
    on('btn-audit', 'click', function () {
      action(base + '/audit', {}, 'Auditorias finais disparadas.');
    });
    on('btn-open-pr', 'click', function () {
      openTarget('pr', projectId, runId);
    });
    on('btn-open-logs', 'click', function () {
      openTarget('logs', projectId, runId);
    });
    on('btn-report-html', 'click', function () {
      openReport(projectId, runId, 'html');
    });
    on('btn-report-md', 'click', function () {
      openReport(projectId, runId, 'md');
    });
    on('btn-report-json', 'click', function () {
      openReport(projectId, runId, 'json');
    });

    wireOverrideDialog(projectId, runId, refresh);

    var crumb = $('crumb-project-link');
    if (crumb) {
      crumb.setAttribute('href', 'project.html?id=' + encodeURIComponent(projectId));
      crumb.textContent = projectId;
    }

    refresh();

    var scheduleRunRefresh = throttle(refresh, 1200);

    createLiveUpdates({
      onEvent: function (event) {
        if (event.runId && event.runId !== runId) return;
        if (event.projectId && event.projectId !== projectId) return;
        setText(
          'live-last-event',
          (event.state ? (RUN_STATE_LABEL[event.state] || event.state) + ' — ' : '') +
            (event.message || '') +
            ' (' + fmtClock(event.at) + ')'
        );
        scheduleRunRefresh();
      },
      onRefresh: refresh,
    });
  }

  function renderRun(projectId, runId, run, prompts, consensusPayload) {
    if (!run) {
      showBanner('error', 'Execução não encontrada: ' + runId);
      return;
    }

    document.title = 'Execução ' + runId + ' — OrqPEG';
    setText('run-id', runId);
    setText('crumb-run', runId);

    var duration = durationBetween(run.createdAt, run.finishedAt || run.updatedAt);
    setHtml(
      'run-state-chip',
      runStateChip(run.state) +
        (run.dryRun ? ' ' + chip('DRY-RUN', 'pending') : '') +
        (run.pauseRequested ? ' ' + chip('PAUSA SOLICITADA', 'waiting') : '') +
        (run.cancelRequested ? ' ' + chip('CANCELAMENTO SOLICITADO', 'failed') : '')
    );
    setText(
      'run-sub',
      'Criada em ' +
        fmtDateTime(run.createdAt) +
        ' · atualizada em ' +
        fmtDateTime(run.updatedAt) +
        ' · duração ' +
        (duration === null ? DASH : fmtDuration(duration))
    );

    setHtml(
      'kv-run',
      kvRow('Projeto', internalLink('project.html?id=' + encodeURIComponent(projectId), projectId)) +
        kvRow('Estado anterior', esc(run.previousState ? RUN_STATE_LABEL[run.previousState] || run.previousState : DASH)) +
        kvRow('Branch', '<span class="mono">' + esc(text(run.branchName)) + '</span>') +
        kvRow('Commit base', '<span class="mono">' + esc(shortSha(run.baseCommitSha)) + '</span>') +
        kvRow('Diretório de trabalho', '<span class="mono">' + esc(text(run.workingDirectory || run.worktreePath)) + '</span>') +
        kvRow('Enviada em', esc(fmtDateTime(run.pushedAt))) +
        kvRow('Remoto', '<span class="mono">' + esc(text(run.pushedRemote)) + '</span>') +
        kvRow('Commits', esc(String(Array.isArray(run.commits) ? run.commits.length : 0))) +
        kvRow('Finalizada em', esc(fmtDateTime(run.finishedAt))) +
        kvRow(
          'Último erro',
          run.lastError
            ? '<span class="chip chip--failed">' +
              esc(text(run.lastError.code)) +
              '</span> ' +
              esc(text(run.lastError.message))
            : esc(DASH)
        )
    );

    renderSteps(run, prompts);
    renderIntegration(run);
    renderLoopGuard(run);
    renderConsensus(run, consensusPayload);
    renderGates(run.gateReport);
    renderRunEvents(run.events);
  }

  /* ----------------------------------------------------------------------
   * Proteção contra looping — somente leitura.
   *
   * Mostra o orçamento consumido pelo prompt corrente e, quando houve parada,
   * o gatilho com suas evidências. Esta tela não oferece nenhuma ação: o
   * objetivo é conferir que o backend entrega os números certos antes de
   * qualquer intervenção pela interface.
   * -------------------------------------------------------------------- */

  var LOOP_TRIGGER_LABEL = {
    MAX_ATTEMPTS_REACHED: 'Limite de tentativas atingido',
    CLAUDE_CALL_BUDGET_EXHAUSTED: 'Orçamento de chamadas do Claude esgotado',
    CODEX_CALL_BUDGET_EXHAUSTED: 'Orçamento de chamadas do Codex esgotado',
    AGENT_CALL_BUDGET_EXHAUSTED: 'Orçamento total de chamadas de IA esgotado',
    PROMPT_TIME_BUDGET_EXHAUSTED: 'Tempo máximo do prompt esgotado',
    RUN_TIME_BUDGET_EXHAUSTED: 'Tempo máximo da execução esgotado',
    NO_PROGRESS: 'A correção não alterou o código',
    REPEATED_REVIEW_ISSUES: 'O revisor apontou os mesmos problemas',
    REPEATED_TEST_FAILURE: 'A mesma falha de teste se repetiu',
    OSCILLATION_DETECTED: 'O código está oscilando entre duas soluções',
    REVIEW_OSCILLATION_DETECTED: 'Os problemas apontados estão oscilando',
    PROMPT_CHANGED_DURING_RUN: 'O prompt foi editado durante a execução',
    PROJECT_CONTEXT_CHANGED: 'O contexto do projeto mudou durante a execução',
    SCOPE_VIOLATION: 'Alteração fora das áreas permitidas',
    FORBIDDEN_AREA_CHANGED: 'Alteração em área proibida',
    DIFF_BUDGET_EXCEEDED: 'Diff acima do limite configurado',
    INCOMPLETE_REVIEW_EVIDENCE: 'Pacote de revisão incompleto',
    REVIEW_FORMAT_RETRIES_EXHAUSTED: 'Revisor não devolveu JSON válido',
    INVALID_CHANGES_REQUEST: 'Pedido de mudança sem ação concreta',
    AUTH_REQUIRED: 'Autenticação necessária',
    USAGE_LIMIT_REACHED: 'Limite da assinatura atingido',
    TOOL_MISSING: 'Ferramenta ausente',
    PROCESS_TIMEOUT: 'Tempo limite do processo',
    REPEATED_CI_FAILURE: 'A mesma falha de CI se repetiu',
    CI_WAIT_TIMEOUT: 'Espera do CI esgotada',
    MERGE_CORRECTION_BUDGET_EXHAUSTED: 'Ciclos de correção após auditoria esgotados',
    USER_PAUSED: 'Pausa solicitada',
    USER_CANCELLED: 'Cancelamento solicitado',
  };

  var LOOP_ACTION_LABEL = {
    OPEN_REPORT: 'Abrir relatório',
    OPEN_DIFF: 'Inspecionar o diff',
    OPEN_TESTS: 'Inspecionar os testes',
    OPEN_REVIEW: 'Ler a revisão',
    EDIT_PROMPT: 'Editar o prompt e iniciar nova execução',
    AUTHORIZE_EXTRA_ATTEMPT: 'Autorizar uma tentativa adicional',
    MARK_FOR_MANUAL_REVIEW: 'Marcar para revisão manual',
    SKIP_PROMPT: 'Pular este prompt',
    CANCEL_RUN: 'Cancelar a execução',
    FIX_AUTH: 'Refazer o login do CLI',
    WAIT_QUOTA: 'Aguardar renovação da cota',
    INSTALL_TOOL: 'Instalar a ferramenta ausente',
    SPLIT_PROMPT: 'Dividir em prompts menores',
    START_NEW_RUN: 'Iniciar uma nova execução',
  };

  function renderLoopGuard(run) {
    var budget = currentBudget(run);
    var limits = loopLimits(run);
    var decision = run.lastLoopGuard || null;

    renderLoopGuardAlert(decision);
    renderPolicyNotice(run);

    if (!budget) {
      setHtml('loopguard-metrics', '<p class="empty">Sem orçamento registrado</p>');
      setHtml(
        'loopguard-fingerprints',
        specRow('Diff', '<span class="faint">Sem dados</span>')
      );
      setHtml(
        'loopguard-decision',
        kvRow('Situação', '<span class="faint">Sem parada registrada</span>')
      );
      return;
    }

    var totalCalls = num(budget.claudeCalls) + num(budget.codexCalls);
    setHtml(
      'loopguard-metrics',
      budgetMetric(budget.attempts, limits.attempts, 'Tentativas') +
        budgetMetric(budget.claudeCalls, limits.claude, 'Chamadas Claude') +
        budgetMetric(budget.codexCalls, limits.codex, 'Chamadas Codex') +
        budgetMetric(totalCalls, limits.total, 'Total de chamadas') +
        budgetMetric(
          Math.round(num(budget.consumedMs) / 60000),
          limits.promptMinutes,
          'Minutos no prompt'
        ) +
        budgetMetric(budget.manualOverridesUsed, limits.overrides, 'Overrides usados')
    );

    setHtml(
      'loopguard-fingerprints',
      specRow('Diff', fingerprintTrail(budget.diffFingerprints)) +
        specRow('Revisão', fingerprintTrail(budget.reviewFingerprints)) +
        specRow('Falha de teste', fingerprintTrail(budget.testFailureFingerprints)) +
        specRow('Retentativas de formato', esc(text(budget.reviewFormatRetries)))
    );

    setHtml('loopguard-decision', loopDecisionRows(budget, decision));
    renderOverrideArea(run, budget, decision);
    renderOverrideHistory(run);
  }

  /**
   * Área de autorização manual.
   *
   * O botão só aparece quando o backend informa que o override é possível. Se a
   * informação não vier, nada é oferecido: na dúvida, não sugerimos uma ação
   * que a API vai recusar. E esconder o botão não é a proteção — o backend
   * recusa a requisição de qualquer forma.
   */
  function renderOverrideArea(run, budget, decision) {
    var area = $('loopguard-override-area');
    var note = $('loopguard-override-note');
    if (!area || !note) return;

    var info = run.__override || null;

    if (!decision || !decision.trigger) {
      note.textContent = '';
      removeOverrideButton();
      return;
    }

    if (!info) {
      note.textContent =
        'Situação de autorização indisponível: recarregue a página para consultar o servidor.';
      removeOverrideButton();
      return;
    }

    note.textContent =
      info.reason +
      ' Overrides usados neste prompt: ' +
      text(info.used) +
      ' de ' +
      text(info.limit) +
      '.';

    if (!info.overridable) {
      removeOverrideButton();
      return;
    }

    if (!$('btn-override')) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--primary';
      button.id = 'btn-override';
      button.textContent = 'Autorizar uma tentativa adicional';
      area.insertBefore(button, note);
      button.addEventListener('click', function () {
        openOverrideDialog(run, budget, decision);
      });
    }
  }

  function removeOverrideButton() {
    var existing = $('btn-override');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function openOverrideDialog(run, budget, decision) {
    var dialog = $('dlg-override');
    if (!dialog) return;

    setHtml(
      'override-evidence',
      kvRow('Gatilho', '<span class="mono">' + esc(text(decision.trigger)) + '</span>') +
        kvRow('Descrição', esc(LOOP_TRIGGER_LABEL[decision.trigger] || DASH)) +
        kvRow('Prompt', '<span class="mono">' + esc(text(budget.promptId)) + '</span>') +
        kvRow('Motivo registrado', esc(text(decision.reason))) +
        kvRow(
          'Tentativas consumidas',
          esc(text(budget.attempts)) + ' · Claude ' + esc(text(budget.claudeCalls)) +
            ' · Codex ' + esc(text(budget.codexCalls))
        ) +
        kvRow('Assinaturas de teste', fingerprintTrail(budget.testFailureFingerprints)) +
        kvRow('Assinaturas de revisão', fingerprintTrail(budget.reviewFingerprints))
    );

    currentOverridePromptId = text(budget.promptId);

    var box = $('override-error-box');
    if (box) box.hidden = true;
    var field = $('override-justification');
    if (field) field.value = '';

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', 'open');
  }

  function renderOverrideHistory(run) {
    var card = $('loopguard-history-card');
    var body = $('loopguard-history');
    if (!card || !body) return;

    if (!isNonEmptyArray(run.overrides)) {
      card.hidden = true;
      body.innerHTML = '';
      return;
    }

    card.hidden = false;
    body.innerHTML = run.overrides
      .map(function (entry) {
        return (
          '<tr>' +
          '<th scope="row"><span class="mono">' + esc(text(entry.promptId)) + '</span></th>' +
          '<td><span class="mono">' + esc(text(entry.trigger)) + '</span></td>' +
          '<td>' + esc(text(entry.authorizedBy)) + '</td>' +
          '<td>' + esc(fmtDateTime(entry.authorizedAt)) + '</td>' +
          '<td>' +
          (entry.consumed ? chip('CONSUMIDO', 'pending') : chip('PENDENTE', 'waiting')) +
          '</td>' +
          '<td>' + esc(text(entry.justification)) + '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function wireOverrideDialog(projectId, runId, afterGrant) {
    var dialog = $('dlg-override');
    var form = $('form-override');
    if (!dialog || !form) return;

    on('btn-override-cancel', 'click', function () {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var justification = ($('override-justification') || {}).value || '';
      var authorizedBy = ($('override-author') || {}).value || '';
      var submit = $('btn-override-submit');
      if (submit) submit.disabled = true;

      apiPost(
        '/api/projects/' + encodeURIComponent(projectId) +
          '/runs/' + encodeURIComponent(runId) + '/override',
        {
          promptId: currentOverridePromptId,
          justification: justification,
          authorizedBy: authorizedBy,
        }
      ).then(function (result) {
        if (submit) submit.disabled = false;
        if (!result.ok) {
          var box = $('override-error-box');
          if (box) box.hidden = false;
          setText('override-error', result.error || 'Não foi possível autorizar.');
          return;
        }
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        showBanner(
          'info',
          'Tentativa adicional autorizada. Retome a execução para exercê-la.'
        );
        if (typeof afterGrant === 'function') afterGrant();
      });
    });
  }

  /** Prompt alvo do diálogo aberto; definido ao abrir. */
  var currentOverridePromptId = '';

  /**
   * Declara a situação da política histórica desta execução.
   *
   * Dois avisos distintos, deliberadamente:
   *
   *  - política indisponível: execução criada antes do congelamento. Os
   *    numeradores continuam válidos; os denominadores não existem e o painel
   *    diz isso em vez de exibir o cadastro de hoje.
   *  - cadastro alterado: a política da execução continua valendo. O aviso é
   *    informativo, não uma troca de limites.
   */
  function renderPolicyNotice(run) {
    var box = $('loopguard-policy');
    if (!box) return;

    var unavailable = run.__policyUnavailable || null;
    var drift = run.__policyDrift || null;

    if (unavailable) {
      box.hidden = false;
      box.className = 'warn-box';
      box.innerHTML =
        '<p class="warn-box__title">' +
        esc(unavailable.title || 'POLÍTICA HISTÓRICA NÃO DISPONÍVEL') +
        '</p><p>' +
        esc(unavailable.message || 'Execução criada antes do snapshot de política.') +
        '</p><p class="faint">' +
        esc(
          'Os valores consumidos continuam corretos. Os limites daquela execução não foram registrados e não serão deduzidos da configuração atual.'
        ) +
        '</p>';
      return;
    }

    if (drift && drift.changed === true) {
      box.hidden = false;
      box.className = 'warn-box';
      box.innerHTML =
        '<p class="warn-box__title">Cadastro do projeto alterado</p><p>' +
        esc(drift.message || '') +
        '</p>';
      return;
    }

    box.hidden = true;
    box.innerHTML = '';
  }

  function renderLoopGuardAlert(decision) {
    var box = $('loopguard-alert');
    if (!box) return;

    if (!decision || decision.allowed === true || !decision.trigger) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    var hard = decision.severity === 'hard_stop';
    box.hidden = false;
    box.className = hard ? 'warn-box warn-box--hard' : 'warn-box';
    box.innerHTML =
      '<p class="warn-box__title">' +
      esc(hard ? 'Execução interrompida — parada dura' : 'Execução interrompida pelo Loop Guard') +
      '</p>' +
      '<p><strong>' +
      esc(text(decision.trigger)) +
      '</strong> — ' +
      esc(LOOP_TRIGGER_LABEL[decision.trigger] || 'Motivo não catalogado') +
      '</p>' +
      '<p>' +
      esc(text(decision.reason)) +
      '</p>' +
      (hard
        ? '<p class="faint">Parada dura não admite tentativa adicional: a causa precisa ser ' +
          'corrigida fora do laço antes de uma nova execução.</p>'
        : '<p class="faint">Parada branda: uma única tentativa adicional pode ser autorizada ' +
          'por uma pessoa, com justificativa registrada.</p>') +
      loopActionsList(decision.nextActions);
  }

  function loopActionsList(actions) {
    if (!isNonEmptyArray(actions)) return '';
    return (
      '<p class="faint">Próximas ações possíveis:</p><ul class="list-plain">' +
      actions
        .map(function (action) {
          return '<li>' + esc(LOOP_ACTION_LABEL[action] || action) + '</li>';
        })
        .join('') +
      '</ul>'
    );
  }

  function loopDecisionRows(budget, decision) {
    if (!decision || !decision.trigger) {
      return (
        kvRow('Situação', chip('SEM PARADA', 'approved')) +
        kvRow('Último gatilho', '<span class="faint">' + esc(DASH) + '</span>') +
        kvRow(
          'Prompt',
          '<span class="mono">' + esc(text(budget.promptId)) + '</span>'
        )
      );
    }

    var tone = decision.severity === 'hard_stop' ? 'failed' : 'waiting';
    return (
      kvRow('Situação', chip(decision.severity === 'hard_stop' ? 'PARADA DURA' : 'PARADA BRANDA', tone)) +
      kvRow('Gatilho', '<span class="mono">' + esc(text(decision.trigger)) + '</span>') +
      kvRow('Descrição', esc(LOOP_TRIGGER_LABEL[decision.trigger] || DASH)) +
      kvRow('Prompt', '<span class="mono">' + esc(text(budget.promptId)) + '</span>') +
      kvRow('Registrada em', esc(fmtDateTime(budget.lastDecisionAt))) +
      kvRow('Motivo', esc(text(decision.reason)))
    );
  }

  function budgetMetric(used, limit, label) {
    var u = num(used);
    var l = num(limit);
    var tone = 'approved';
    if (l > 0) {
      if (u >= l) tone = 'failed';
      else if (u / l >= 0.67) tone = 'waiting';
    }
    /* Sem limite conhecido, o painel mostra o consumido e um travessão: um
       número inventado seria pior que a ausência declarada. */
    var value = limit === null || limit === undefined ? u + ' / —' : l > 0 ? u + ' / ' + l : String(u);
    return metric(value, label, tone);
  }

  function fingerprintTrail(list) {
    if (!isNonEmptyArray(list)) return '<span class="faint">Nenhuma registrada</span>';
    return list
      .map(function (value, index) {
        var repeated = list.indexOf(value) !== index;
        return (
          '<span class="tag' +
          (repeated ? ' tag--warn' : '') +
          '" title="' +
          esc(repeated ? 'Assinatura repetida' : 'Assinatura distinta') +
          '">' +
          esc(text(value)) +
          '</span>'
        );
      })
      .join('');
  }

  /** Orçamento do prompt corrente; na ausência dele, o último registrado. */
  function currentBudget(run) {
    if (!isNonEmptyArray(run.budgets)) return null;
    if (run.currentPromptId) {
      var match = run.budgets.filter(function (entry) {
        return entry && entry.promptId === run.currentPromptId;
      });
      if (match.length > 0) return match[0];
    }
    var used = run.budgets.filter(function (entry) {
      return entry && (num(entry.attempts) > 0 || entry.lastTrigger);
    });
    return used.length > 0 ? used[used.length - 1] : run.budgets[0];
  }

  /**
   * Limites vindos da configuração do projeto quando disponível. O painel da
   * execução não carrega o projeto, então os padrões do produto são usados como
   * referência — e ficam explícitos no título de cada célula.
   */
  /**
   * Limites reais do projeto, enviados pelo servidor junto com a execução.
   * Os padrões só entram quando o servidor não informou nada — e nesse caso o
   * denominador é uma referência, não a configuração em vigor.
   */
  function loopLimits(run) {
    /*
     * Sem política congelada NÃO há denominador.
     *
     * O padrão do produto como fallback produzia exatamente o número errado
     * que este bloco existe para evitar: numeradores históricos, vindos de
     * run.budgets, divididos por um limite que aquela execução talvez nunca
     * tenha usado. 'null' faz a métrica mostrar só o consumido.
     */
    if (run.__policyUnavailable) {
      return {
        attempts: null,
        claude: null,
        codex: null,
        total: null,
        promptMinutes: null,
        overrides: null,
      };
    }
    var guard = run.__loopGuard || {};
    return {
      attempts: num(guard.maxAttemptsPerPrompt) || null,
      claude: num(guard.maxClaudeCallsPerPrompt) || null,
      codex: num(guard.maxCodexCallsPerPrompt) || null,
      total: num(guard.maxTotalAgentCallsPerPrompt) || null,
      promptMinutes: num(guard.maxPromptDurationMinutes) || null,
      overrides: num(guard.maxManualOverridesPerPrompt) || null,
    };
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : 0;
  }

  function renderSteps(run, prompts) {
    var progress = promptProgressMap(run);
    var list = [];

    if (isNonEmptyArray(prompts)) {
      prompts.forEach(function (prompt, position) {
        var order = typeof prompt.order === 'number' && prompt.order > 0 ? prompt.order : position + 1;
        list.push({
          id: prompt.id,
          name: prompt.name,
          order: order,
          progress: progress[prompt.id] || null,
        });
      });
    } else if (Array.isArray(run.prompts)) {
      run.prompts.forEach(function (item, position) {
        list.push({
          id: item.promptId,
          name: item.promptId,
          order: position + 1,
          progress: item,
        });
      });
    }

    if (list.length === 0) {
      setHtml('steps', '<li class="empty">Nenhuma etapa registrada</li>');
      return;
    }

    setHtml(
      'steps',
      list
        .map(function (entry) {
          var item = entry.progress;
          var status = item ? item.status : null;
          var tone = status ? PROMPT_STATUS_TONE[status] || 'pending' : 'pending';
          var current = run.currentPromptId === entry.id;
          var meta = [];
          if (item && typeof item.attempts === 'number') meta.push('tentativas: ' + item.attempts);
          if (item && item.lastAttemptAt) meta.push('última tentativa: ' + fmtDateTime(item.lastAttemptAt));
          if (item && item.approvedAt) meta.push('aprovado em: ' + fmtDateTime(item.approvedAt));
          if (item && item.commitSha) meta.push('commit: ' + shortSha(item.commitSha));
          if (item && typeof item.blockingIssueCount === 'number' && item.blockingIssueCount > 0) {
            meta.push('bloqueios: ' + item.blockingIssueCount);
          }

          return (
            '<li class="step step--' +
            esc(tone) +
            '"' +
            (current ? ' aria-current="step"' : '') +
            '>' +
            '<span class="step__order">' + esc(padOrder(entry.order)) + '</span>' +
            '<span class="step__body"><span class="step__name">' +
            esc(text(entry.name)) +
            '</span><span class="step__meta">' +
            esc(meta.length > 0 ? meta.join(' · ') : 'sem progresso registrado') +
            '</span></span>' +
            promptStatusChip(status) +
            '</li>'
          );
        })
        .join('')
    );
  }

  function renderIntegration(run) {
    var rows = [];
    var pullRequest = run.pullRequest;
    var checks = run.checks;

    rows.push(
      integrationRow(
        'PR',
        pullRequest
          ? chip(
              pullRequest.merged
                ? 'MESCLADA'
                : pullRequest.state === 'OPEN'
                ? pullRequest.isDraft
                  ? 'ABERTA (RASCUNHO)'
                  : 'ABERTA'
                : pullRequest.state === 'CLOSED'
                ? 'FECHADA'
                : text(pullRequest.state),
              pullRequest.merged
                ? 'approved'
                : pullRequest.state === 'OPEN'
                ? pullRequest.isDraft
                  ? 'waiting'
                  : 'running'
                : 'failed'
            )
          : chip('SEM PR', 'pending'),
        pullRequest
          ? prLink(pullRequest.url, '#' + pullRequest.number + ' ' + pullRequest.title) +
              '<div class="faint mono">' +
              esc(
                pullRequest.baseRefName +
                  ' ← ' +
                  pullRequest.headRefName +
                  ' · head ' +
                  shortSha(pullRequest.headSha) +
                  ' · mergeável: ' +
                  text(pullRequest.mergeable) +
                  ' · threads abertas: ' +
                  text(pullRequest.unresolvedThreadCount) +
                  ' · revisão humana: ' +
                  text(pullRequest.reviewDecision)
              ) +
              '</div>'
          : esc('Nenhuma pull request registrada nesta execução.')
      )
    );

    rows.push(
      integrationRow(
        'CI',
        checks
          ? chip(
              checks.anyRequiredFailed
                ? 'FALHOU'
                : checks.anyRequiredPending
                ? 'PENDENTE'
                : checks.allRequiredPassed
                ? 'APROVADO'
                : 'INDEFINIDO',
              checks.anyRequiredFailed
                ? 'failed'
                : checks.anyRequiredPending
                ? 'waiting'
                : checks.allRequiredPassed
                ? 'approved'
                : 'pending'
            )
          : chip('SEM CHECKS', 'pending'),
        checks
          ? esc(
              checks.passed +
                ' aprovados, ' +
                checks.failed +
                ' falhas, ' +
                checks.pending +
                ' pendentes, ' +
                checks.skipped +
                ' ignorados (total ' +
                checks.total +
                ')'
            ) +
              '<div class="faint mono">head ' +
              esc(shortSha(checks.headSha)) +
              '</div>' +
              checkRunsHtml(checks.runs)
          : esc('Nenhum check obtido do GitHub.')
      )
    );

    rows.push(mergeReviewRow('CLAUDE MERGE AUDIT', findReview(run.mergeReviews, 'claude')));
    rows.push(mergeReviewRow('CODEX MERGE AUDIT', findReview(run.mergeReviews, 'codex')));

    var outcome = run.mergeOutcome;
    rows.push(
      integrationRow(
        'MERGE',
        outcome
          ? outcome.merged
            ? chip('MESCLADO', 'approved')
            : outcome.attempted
            ? chip('NÃO MESCLADO', 'failed')
            : chip('NÃO TENTADO', 'pending')
          : chip('SEM DADOS', 'pending'),
        outcome
          ? esc(text(outcome.reason)) +
              '<div class="faint mono">estratégia: ' +
              esc(text(outcome.strategy)) +
              ' · merge SHA: ' +
              esc(shortSha(outcome.mergeSha)) +
              ' · head correspondente: ' +
              esc(shortSha(outcome.matchedHeadSha)) +
              ' · em ' +
              esc(fmtDateTime(outcome.performedAt)) +
              (outcome.idempotentSkip ? ' · repetição idempotente' : '') +
              '</div>'
          : esc('O merge ainda não foi avaliado nesta execução.')
      )
    );

    setHtml('integration-body', rows.join(''));
  }

  function integrationRow(label, statusHtml, detailHtml) {
    return (
      '<tr><th scope="row"><span class="row-label">' +
      esc(label) +
      '</span></th><td>' +
      statusHtml +
      '</td><td>' +
      detailHtml +
      '</td></tr>'
    );
  }

  function checkRunsHtml(runs) {
    if (!isNonEmptyArray(runs)) return '';
    return (
      '<div class="faint">' +
      runs
        .slice(0, 12)
        .map(function (item) {
          return esc(
            (item.required ? '[obrigatório] ' : '') +
              text(item.name) +
              ': ' +
              text(item.conclusion) +
              ' (' + text(item.status) + ')'
          );
        })
        .join('<br>') +
      '</div>'
    );
  }

  function findReview(reviews, auditor) {
    if (!Array.isArray(reviews)) return null;
    var found = null;
    reviews.forEach(function (record) {
      if (record && record.auditor === auditor) found = record;
    });
    return found;
  }

  function mergeReviewRow(label, record) {
    if (!record || !record.review) {
      return integrationRow(label, chip('NÃO EXECUTADA', 'pending'), esc('Auditoria final ainda não produziu resultado.'));
    }
    var review = record.review;
    var tone = record.invalidated ? 'failed' : MERGE_VERDICT_TONE[review.verdict] || 'pending';
    var statusHtml = chip(MERGE_VERDICT_LABEL[review.verdict] || review.verdict, tone);
    if (record.invalidated) statusHtml += ' ' + chip('INVALIDADA', 'failed');

    var risk = review.riskAssessment || {};
    var detail =
      esc(text(review.summary)) +
      '<div class="faint mono">confiança: ' +
      esc(fmtConfidence(review.confidence)) +
      ' · head revisado: ' +
      esc(shortSha(review.reviewedHeadSha)) +
      ' · head observado: ' +
      esc(shortSha(record.observedHeadSha)) +
      ' · risco: ' +
      esc(text(risk.level)) +
      ' · bloqueadores: ' +
      esc(String(Array.isArray(review.blockingIssues) ? review.blockingIssues.length : 0)) +
      ' · produzida em ' +
      esc(fmtDateTime(record.producedAt)) +
      '</div>' +
      (record.invalidationReason
        ? '<div class="faint">Motivo da invalidação: ' + esc(record.invalidationReason) + '</div>'
        : '') +
      issuesHtml(review.blockingIssues);

    return integrationRow(label, statusHtml, detail);
  }

  function issuesHtml(issues) {
    if (!isNonEmptyArray(issues)) return '';
    return (
      '<ul class="list-plain">' +
      issues
        .slice(0, 8)
        .map(function (issue) {
          return (
            '<li>' +
            chip(text(issue.severity).toUpperCase(), issue.severity === 'blocking' ? 'failed' : 'waiting') +
            ' ' +
            esc(text(issue.title)) +
            (issue.file ? ' <span class="mono faint">' + esc(issue.file) + (issue.line ? ':' + esc(String(issue.line)) : '') + '</span>' : '') +
            '</li>'
          );
        })
        .join('') +
      '</ul>'
    );
  }

  function renderConsensus(run, payload) {
    var consensus = payload.consensus || run.consensus || null;
    var gateReport = payload.gateReport || run.gateReport || null;
    var pullRequest = payload.pullRequest || run.pullRequest || null;
    var checks = payload.checks || run.checks || null;
    var finalTests = payload.finalTests || run.finalTests || null;
    var outcome = payload.mergeOutcome || run.mergeOutcome || null;

    var claude = consensus ? consensus.claude : null;
    var codex = consensus ? consensus.codex : null;
    var claudeRecord = findReview(payload.reviews || run.mergeReviews, 'claude');
    var codexRecord = findReview(payload.reviews || run.mergeReviews, 'codex');

    function verdictCell(side, record) {
      var verdict = side && side.verdict ? side.verdict : record && record.review ? record.review.verdict : null;
      if (!verdict) return chip('SEM VEREDITO', 'pending');
      return chip(MERGE_VERDICT_LABEL[verdict] || verdict, MERGE_VERDICT_TONE[verdict] || 'pending');
    }

    function confidenceCell(side, record) {
      var value =
        side && typeof side.confidence === 'number'
          ? side.confidence
          : record && record.review && typeof record.review.confidence === 'number'
          ? record.review.confidence
          : null;
      if (value === null) return esc(DASH);
      var minimum = consensus && typeof consensus.minimumConfidence === 'number' ? consensus.minimumConfidence : null;
      var suffix = minimum === null ? '' : ' <span class="faint">(mínimo ' + esc(fmtConfidence(minimum)) + ')</span>';
      var tone = minimum === null ? 'pending' : value >= minimum ? 'approved' : 'failed';
      return chip(fmtConfidence(value), tone) + suffix;
    }

    var headSha =
      (consensus && consensus.headSha) ||
      (gateReport && gateReport.headSha) ||
      (pullRequest && pullRequest.headSha) ||
      null;
    var baseSha = (gateReport && gateReport.baseSha) || (pullRequest && pullRequest.baseSha) || null;

    var testsCell = finalTests
      ? chip(finalTests.passed ? 'PASSARAM' : text(finalTests.status), finalTests.passed ? 'approved' : 'failed') +
        ' <span class="faint">' +
        esc(
          (Array.isArray(finalTests.commands) ? finalTests.commands.length : 0) +
            ' comando(s) · ' +
            fmtDuration(finalTests.durationMs)
        ) +
        '</span>'
      : chip('NÃO EXECUTADOS', 'pending');

    var ciCell = checks
      ? chip(
          checks.anyRequiredFailed
            ? 'FALHOU'
            : checks.anyRequiredPending
            ? 'PENDENTE'
            : checks.allRequiredPassed
            ? 'APROVADO'
            : 'INDEFINIDO',
          checks.anyRequiredFailed
            ? 'failed'
            : checks.anyRequiredPending
            ? 'waiting'
            : checks.allRequiredPassed
            ? 'approved'
            : 'pending'
        )
      : chip('SEM CHECKS', 'pending');

    var conflictsCell = pullRequest
      ? pullRequest.mergeable === 'CONFLICTING'
        ? chip('COM CONFLITO', 'failed')
        : pullRequest.mergeable === 'MERGEABLE'
        ? chip('SEM CONFLITO', 'approved')
        : chip('INDETERMINADO', 'waiting')
      : chip('SEM DADOS', 'pending');

    var threadsCell = pullRequest
      ? chip(
          String(pullRequest.unresolvedThreadCount) + ' ABERTA(S)',
          pullRequest.unresolvedThreadCount > 0 ? 'failed' : 'approved'
        )
      : chip('SEM DADOS', 'pending');

    setHtml(
      'consensus-kv',
      kvRow(
        'PR',
        pullRequest ? prLink(pullRequest.url, '#' + pullRequest.number) : chip('SEM PR', 'pending')
      ) +
        kvRow('Head SHA', '<span class="mono">' + esc(shortSha(headSha)) + '</span>') +
        kvRow('Base SHA', '<span class="mono">' + esc(shortSha(baseSha)) + '</span>') +
        kvRow('Testes locais', testsCell) +
        kvRow('CI', ciCell) +
        kvRow('Conflitos', conflictsCell) +
        kvRow('Threads', threadsCell) +
        kvRow('Claude verdict', verdictCell(claude, claudeRecord)) +
        kvRow('Claude confidence', confidenceCell(claude, claudeRecord)) +
        kvRow('Codex verdict', verdictCell(codex, codexRecord)) +
        kvRow('Codex confidence', confidenceCell(codex, codexRecord)) +
        kvRow(
          'Mesmo SHA',
          consensus ? boolChip(consensus.sameHeadSha, 'SIM', 'NÃO') : chip('SEM DADOS', 'pending')
        ) +
        kvRow(
          'Consenso',
          consensus ? boolChip(consensus.reached, 'ALCANÇADO', 'NÃO ALCANÇADO') : chip('SEM DADOS', 'pending')
        ) +
        kvRow(
          'Gate final',
          gateReport
            ? boolChip(gateReport.allPassed, 'TODOS PASSARAM', 'REPROVADO') +
              ' <span class="faint">' +
              esc(
                (Array.isArray(gateReport.failedGates) ? gateReport.failedGates.length : 0) +
                  ' gate(s) reprovado(s) · avaliado em ' +
                  fmtDateTime(gateReport.evaluatedAt)
              ) +
              '</span>'
            : chip('NÃO AVALIADO', 'pending')
        ) +
        kvRow(
          'Merge result',
          outcome
            ? (outcome.merged ? chip('MESCLADO', 'approved') : chip('NÃO MESCLADO', outcome.attempted ? 'failed' : 'pending')) +
              ' <span class="faint">' +
              esc(text(outcome.reason)) +
              '</span>'
            : chip('SEM DADOS', 'pending')
        )
    );

    var reasons = consensus && Array.isArray(consensus.reasons) ? consensus.reasons : [];
    setHtml(
      'consensus-reasons',
      reasons.length === 0
        ? '<li class="faint">Nenhum motivo registrado.</li>'
        : reasons
            .map(function (reason) {
              return '<li>' + esc(reason) + '</li>';
            })
            .join('')
    );
  }

  function renderGates(gateReport) {
    var byId = {};
    if (gateReport && Array.isArray(gateReport.gates)) {
      gateReport.gates.forEach(function (gate) {
        if (gate && typeof gate.id === 'string') byId[gate.id] = gate;
      });
    }

    setHtml(
      'gates',
      GATE_CATALOG.map(function (definition) {
        var gate = byId[definition.id] || null;
        var status = gate ? gate.status : 'NOT_EVALUATED';
        var title = gate && gate.title ? gate.title : definition.title;
        var reason = gate && gate.reason ? gate.reason : 'Ainda não avaliado nesta execução.';
        var index = gate && typeof gate.index === 'number' ? gate.index : definition.index;

        return (
          '<article class="gate gate--' +
          esc(GATE_MODIFIER[status] || 'pending') +
          '">' +
          '<div class="gate__index">' + esc(padOrder(index).slice(1)) + '</div>' +
          '<div><div class="gate__top"><span class="gate__title">' +
          esc(title) +
          '</span>' +
          chip(GATE_STATUS_LABEL[status] || status, GATE_STATUS_TONE[status] || 'pending') +
          '</div><div class="gate__reason">' +
          esc(reason) +
          '</div></div>' +
          '</article>'
        );
      }).join('')
    );

    setText(
      'gates-summary',
      gateReport
        ? 'Avaliados em ' +
            fmtDateTime(gateReport.evaluatedAt) +
            ' · head ' +
            shortSha(gateReport.headSha) +
            ' · base ' +
            shortSha(gateReport.baseSha)
        : 'Os gates ainda não foram avaliados nesta execução.'
    );
  }

  function renderRunEvents(events) {
    if (!isNonEmptyArray(events)) {
      setHtml('run-events', '<li class="empty">Nenhum evento registrado</li>');
      return;
    }
    var ordered = events.slice(-80).reverse();
    setHtml(
      'run-events',
      ordered
        .map(function (event) {
          return (
            '<li><time datetime="' +
            esc(text(event.at)) +
            '">' +
            esc(fmtClock(event.at)) +
            '</time>' +
            runStateChip(event.state) +
            '<span class="msg">' +
            esc(text(event.message)) +
            '</span></li>'
          );
        })
        .join('')
    );
  }

  /* ------------------------------------------------------------------ */
  /* 12. Página: prompt.html                                             */
  /* ------------------------------------------------------------------ */

  function initPrompt() {
    var projectId = param('id');
    var promptId = param('prompt');

    if (projectId === '' || promptId === '') {
      showBanner('error', 'Parâmetros obrigatórios ausentes na URL: id do projeto e prompt.');
      return;
    }

    var crumb = $('crumb-project-link');
    if (crumb) {
      crumb.setAttribute('href', 'project.html?id=' + encodeURIComponent(projectId));
      crumb.textContent = projectId;
    }

    function refresh() {
      Promise.all([
        apiGet(projectPath(projectId) + '/prompts/' + encodeURIComponent(promptId)),
        apiGet(projectPath(projectId) + '/runs'),
      ]).then(function (results) {
        var promptResult = results[0];
        var runsResult = results[1];

        if (!promptResult.ok) {
          showBanner('error', promptResult.error);
          return;
        }
        hideBanner();
        renderPrompt(
          projectId,
          promptId,
          promptResult.data || {},
          runsResult.ok && runsResult.data && Array.isArray(runsResult.data.runs) ? runsResult.data.runs : []
        );
      });
    }

    on('btn-refresh', 'click', refresh);
    refresh();
  }

  function renderPrompt(projectId, promptId, data, runs) {
    var parsed = data.prompt || null;
    var file = data.file || null;
    var raw = typeof data.raw === 'string' ? data.raw : '';

    var name = (parsed && parsed.name) || (file && file.name) || promptId;
    document.title = name + ' — OrqPEG';
    setText('prompt-name', name);
    setText('crumb-prompt', name);
    setText(
      'prompt-sub',
      (file ? file.fileName + ' · ' + fmtBytes(file.sizeBytes) + ' · ordem ' + padOrder(file.order) : promptId) +
        ' · projeto ' +
        projectId
    );

    setHtml(
      'kv-prompt',
      kvRow('Identificador', '<span class="mono">' + esc(promptId) + '</span>') +
        kvRow('Arquivo', '<span class="mono">' + esc(file ? text(file.fileName) : DASH) + '</span>') +
        kvRow('Caminho', '<span class="mono">' + esc(file ? text(file.absolutePath) : DASH) + '</span>') +
        kvRow('Tamanho', esc(file ? fmtBytes(file.sizeBytes) : DASH)) +
        kvRow('Objetivo', esc(parsed ? text(parsed.objective) : DASH))
    );

    var sections = [
      ['Escopo', parsed && parsed.scope],
      ['Fora de escopo', parsed && parsed.outOfScope],
      ['Áreas permitidas', parsed && parsed.allowedAreas],
      ['Áreas proibidas', parsed && parsed.forbiddenAreas],
      ['Requisitos funcionais', parsed && parsed.functionalRequirements],
      ['Requisitos técnicos', parsed && parsed.technicalRequirements],
      ['Critérios de aceite', parsed && parsed.acceptanceCriteria],
      ['Testes obrigatórios', parsed && parsed.requiredTests],
      ['Restrições', parsed && parsed.restrictions],
      ['Dependências', parsed && parsed.dependencies],
    ].filter(function (entry) {
      return isNonEmptyArray(entry[1]);
    });

    setHtml(
      'prompt-sections',
      sections.length === 0
        ? '<p class="empty">O arquivo não usa as seções padrão do OrqPEG. Veja o conteúdo integral abaixo.</p>'
        : sections
            .map(function (entry) {
              return (
                '<article class="card"><h3>' +
                esc(entry[0]) +
                '</h3><ul class="list-plain">' +
                entry[1]
                  .map(function (line) {
                    return '<li>' + esc(text(line)) + '</li>';
                  })
                  .join('') +
                '</ul></article>'
              );
            })
            .join('')
    );

    var rawNode = $('prompt-raw');
    if (rawNode) rawNode.textContent = raw === '' ? 'Sem conteúdo legível neste arquivo.' : raw;

    var rows = [];
    runs.forEach(function (run) {
      var item = null;
      if (Array.isArray(run.prompts)) {
        run.prompts.forEach(function (candidate) {
          if (candidate && candidate.promptId === promptId) item = candidate;
        });
      }
      if (!item) return;

      var commit = null;
      if (Array.isArray(run.commits)) {
        run.commits.forEach(function (entry) {
          if (entry && entry.promptId === promptId) commit = entry;
        });
      }

      rows.push(
        '<tr>' +
          '<th scope="row">' +
          internalLink(
            'run.html?id=' + encodeURIComponent(projectId) + '&run=' + encodeURIComponent(run.runId),
            run.runId,
            'mono'
          ) +
          '</th>' +
          '<td>' + runStateChip(run.state) + '</td>' +
          '<td>' + promptStatusChip(item.status) + '</td>' +
          '<td class="num">' + esc(text(item.attempts)) + '</td>' +
          '<td>' +
          (item.lastVerdict
            ? chip(
                REVIEW_VERDICT_LABEL[item.lastVerdict] || item.lastVerdict,
                REVIEW_VERDICT_TONE[item.lastVerdict] || 'pending'
              )
            : esc(DASH)) +
          '</td>' +
          '<td class="num">' + esc(text(item.blockingIssueCount)) + '</td>' +
          '<td class="nowrap">' + esc(fmtDateTime(item.lastAttemptAt)) + '</td>' +
          '<td class="nowrap">' + esc(fmtDateTime(item.approvedAt)) + '</td>' +
          '<td class="mono">' +
          esc(shortSha(item.commitSha || (commit ? commit.sha : null))) +
          (commit ? '<div class="faint">' + esc(text(commit.message)) + '</div>' : '') +
          '</td>' +
          '</tr>'
      );
    });

    setHtml(
      'attempts-body',
      rows.length === 0 ? emptyRow(9, 'Este prompt ainda não foi executado em nenhuma execução.') : rows.join('')
    );
  }

  /* ------------------------------------------------------------------ */
  /* 13. Página: settings.html                                           */
  /* ------------------------------------------------------------------ */

  function initSettings() {
    function refresh() {
      apiGet('/api/home').then(function (result) {
        if (!result.ok) {
          showBanner('error', result.error);
          setHtml('settings-tools-body', emptyRow(6, 'Sem dados'));
          setHtml('kv-panel', kvRow('Estado', esc('Sem dados')));
          setHtml('kv-security', kvRow('Estado', esc('Sem dados')));
          return;
        }
        hideBanner();
        renderSettings(result.data || {});
      });
    }

    on('btn-refresh', 'click', refresh);
    wireDiagnosticsButton('btn-diagnostics');
    refresh();
  }

  function renderSettings(data) {
    var origin = IS_FILE ? null : window.location;

    setHtml(
      'kv-panel',
      kvRow('Produto', esc(text(data.product))) +
        kvRow('Versão', '<span class="mono">' + esc(text(data.version)) + '</span>') +
        kvRow('Dados gerados em', esc(fmtDateTime(data.generatedAt))) +
        kvRow(
          'Endereço do painel',
          '<span class="mono">' +
            esc(origin ? origin.protocol + '//' + origin.host : 'Indisponível (página aberta como arquivo local)') +
            '</span>'
        ) +
        kvRow(
          'Porta',
          '<span class="mono">' +
            esc(origin ? (origin.port === '' ? '80' : origin.port) : DASH) +
            '</span>'
        ) +
        kvRow('Interface de escuta', '<span class="mono">' + esc('127.0.0.1 (somente local)') + '</span>')
    );

    var tools = Array.isArray(data.tools) ? data.tools : [];
    setHtml(
      'settings-tools-body',
      tools.length === 0
        ? emptyRow(6, 'Sem dados')
        : tools
            .map(function (tool) {
              return (
                '<tr>' +
                '<th scope="row">' + esc(text(tool.name)) + '</th>' +
                '<td class="mono">' + esc(text(tool.command)) + '</td>' +
                '<td>' + boolChip(tool.available === true, 'DISPONÍVEL', 'AUSENTE') + '</td>' +
                '<td class="mono">' + esc(text(tool.version)) + '</td>' +
                '<td>' + monoLine(tool.path) + '</td>' +
                '<td>' +
                (tool.authenticated === true
                  ? chip('AUTENTICADO', 'approved')
                  : tool.authenticated === false
                  ? chip('SEM AUTENTICAÇÃO', 'failed')
                  : chip('NÃO SE APLICA', 'pending')) +
                '</td>' +
                '</tr>'
              );
            })
            .join('')
    );

    var guard = data.apiGuard || {};
    setHtml(
      'kv-security',
      kvRow(
        'Bloqueio por variáveis de API',
        guard.blocked === true ? chip('ATIVO', 'failed') : chip('SEM BLOQUEIO', 'approved')
      ) +
        kvRow(
          'Variáveis detectadas',
          tagList(guard.presentKeys, guard.blocked === true ? 'danger' : 'warn')
        ) +
        kvRow('Variáveis apenas com aviso', tagList(guard.warnKeys, 'warn')) +
        kvRow('Removidas dos processos de IA', tagList(guard.strippedForChildren, '')) +
        kvRow('Force push', chip('SEMPRE PROIBIDO', 'approved'))
    );
  }

  /* ------------------------------------------------------------------ */
  /* 14. Inicialização                                                   */
  /* ------------------------------------------------------------------ */

  function start() {
    wireBanner();

    if (IS_FILE) showBanner('info', FILE_NOTICE);

    var page = document.body.getAttribute('data-page');
    if (page === 'home') initHome();
    else if (page === 'project') initProject();
    else if (page === 'run') initRun();
    else if (page === 'prompt') initPrompt();
    else if (page === 'settings') initSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
