/* ==========================================================================
   OrqPEG — cliente do fluxo de eventos do painel.

   Corrige três defeitos do transporte anterior:

     1. O servidor SEMPRE nomeia o evento ("event: run-update"). O cliente antigo
        só escutava `source.onmessage`, que dispara exclusivamente para eventos
        sem nome. Nenhum evento de dado chegava: o painel parecia "ao vivo" e na
        prática vivia só do polling de 5 s.
     2. Não havia cursor. Depois de qualquer queda, o que passou enquanto a
        conexão estava fora sumia em silêncio.
     3. Não havia deduplicação. Reemissão de backlog aplicaria o mesmo evento
        duas vezes.

   Este módulo é compartilhado pelo dashboard e pelas páginas anteriores.
   Sem dependência externa; compatível com o ES5 usado no restante de public/.
   ========================================================================== */

(function (global) {
  'use strict';

  var DEFAULT_TYPES = ['run-update', 'log'];
  var DEFAULT_POLL_MS = 5000;
  var MAX_BACKOFF_MS = 30000;
  var BASE_BACKOFF_MS = 2000;

  /**
   * Estados possíveis do transporte, na ordem de degradação:
   *   live         — SSE conectado, eventos chegando
   *   reconnecting — SSE caiu, tentando voltar; polling cobrindo o intervalo
   *   polling      — SSE indisponível no ambiente; polling é o transporte
   *   down         — sem servidor (file://) ou desligado pelo chamador
   */
  function connect(options) {
    var url = options.url || '/api/events';
    var types = options.types || DEFAULT_TYPES;
    var pollMs = options.pollMs || DEFAULT_POLL_MS;
    var onEvent = options.onEvent || function () {};
    var onStatus = options.onStatus || function () {};
    var onPoll = options.onPoll || function () {};
    var onResync = options.onResync || function () {};

    var source = null;
    var pollTimer = null;
    var reconnectTimer = null;
    var attempts = 0;
    var closed = false;

    /* Cursor do fluxo. Avança apenas com eventos identificados; heartbeat é
       anônimo de propósito e não mexe nele. */
    var lastEventId = 0;

    var isFile = global.location && global.location.protocol === 'file:';

    function setStatus(status, detail) {
      onStatus(status, detail);
    }

    function startPolling() {
      if (pollTimer !== null || closed) return;
      pollTimer = global.setInterval(onPoll, pollMs);
    }

    function stopPolling() {
      if (pollTimer === null) return;
      global.clearInterval(pollTimer);
      pollTimer = null;
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== null) return;
      attempts += 1;
      var delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * attempts);
      reconnectTimer = global.setTimeout(function () {
        reconnectTimer = null;
        open();
      }, delay);
    }

    /**
     * Aplica um quadro recebido. Devolve false quando o quadro é descartado —
     * por ser ilegível ou por já ter sido aplicado antes.
     */
    function handle(event) {
      var payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return false;
      }
      if (!payload || typeof payload !== 'object') return false;

      /* O servidor avisa quando o cliente ficou fora tempo demais e o backlog
         já não cobre o buraco. Recarregar tudo é a única resposta correta. */
      if (payload.message === 'backlog-truncated') {
        lastEventId = 0;
        onResync();
        return true;
      }

      if (payload.type === 'heartbeat') return false;

      /* Deduplicação por cursor monotônico. */
      var id = typeof payload.id === 'number' ? payload.id : null;
      if (id !== null) {
        if (id <= lastEventId) return false;
        lastEventId = id;
      } else if (event.lastEventId) {
        var parsed = parseInt(event.lastEventId, 10);
        if (!isNaN(parsed)) {
          if (parsed <= lastEventId) return false;
          lastEventId = parsed;
        }
      }

      onEvent(payload);
      return true;
    }

    function open() {
      if (closed) return;

      if (isFile) {
        setStatus('down', 'Sem servidor (file://)');
        return;
      }

      if (typeof global.EventSource !== 'function') {
        setStatus('polling', 'Atualização a cada ' + Math.round(pollMs / 1000) + ' s');
        startPolling();
        return;
      }

      setStatus('reconnecting', 'Conectando…');

      /* O cursor vai na query porque esta é uma reabertura MANUAL: o navegador
         só repõe Last-Event-ID sozinho na reconexão que ele mesmo faz. */
      var target = lastEventId > 0 ? url + '?lastEventId=' + encodeURIComponent(lastEventId) : url;

      try {
        source = new global.EventSource(target);
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

      /* O defeito central: o servidor nomeia todos os eventos, então é preciso
         registrar um listener por tipo. `message` fica como compatibilidade
         para quadros anônimos. */
      types.forEach(function (type) {
        source.addEventListener(type, handle);
      });
      source.addEventListener('message', handle);

      source.onerror = function () {
        if (source) {
          try {
            source.close();
          } catch (error) {
            /* o fluxo já estava fechado */
          }
          source = null;
        }
        if (closed) return;
        setStatus('reconnecting', 'Reconectando — atualizando a cada ' + Math.round(pollMs / 1000) + ' s');
        startPolling();
        scheduleReconnect();
      };
    }

    function close() {
      closed = true;
      stopPolling();
      if (reconnectTimer !== null) {
        global.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (source) {
        try {
          source.close();
        } catch (error) {
          /* nada a fazer */
        }
        source = null;
      }
      setStatus('down', 'Desconectado');
    }

    open();

    global.addEventListener('beforeunload', function () {
      closed = true;
      stopPolling();
      if (reconnectTimer !== null) global.clearTimeout(reconnectTimer);
      if (source) {
        try {
          source.close();
        } catch (error) {
          /* nada a fazer no descarregamento da página */
        }
      }
    });

    return {
      close: close,
      cursor: function () {
        return lastEventId;
      },
    };
  }

  global.OrqEventStream = { connect: connect };
})(window);
