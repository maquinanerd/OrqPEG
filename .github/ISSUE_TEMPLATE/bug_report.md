---
name: Relatar um defeito
about: Comportamento incorreto, erro ou travamento do OrqPEG
title: '[BUG] '
labels: ['bug', 'triagem']
assignees: ''
---

## Resumo

<!-- Uma frase objetiva descrevendo o que está errado. -->

## Passos para reproduzir

1.
2.
3.

## Comportamento esperado

<!-- O que deveria acontecer. -->

## Comportamento observado

<!-- O que realmente aconteceu. Cole a mensagem de erro completa, com o código de erro
     (por exemplo GIT_FAILED, LOCK_HELD, MERGE_GATE_FAILED). -->

```text

```

## Diagnóstico

Cole a saída de `DIAGNOSTICO.cmd` (ou `node dist\cli\main.js doctor`):

```text

```

## Ambiente

| Item | Valor |
| --- | --- |
| Versão do OrqPEG | |
| Windows | |
| Node.js (`node --version`) | |
| npm (`npm --version`) | |
| Git (`git --version`) | |
| GitHub CLI (`gh --version`) | |
| Claude Code (`claude --version`) | |
| Codex CLI (`codex --version`) | instalado? sim / não |

## Estado da execução

- Identificador da execução (`runId`):
- Estado em que parou (por exemplo `BLOCKED`, `CI_FAILED`, `USAGE_LIMIT_REACHED`):
- Prompt em andamento e número da tentativa:
- Gates reprovados, se aplicável:

## Logs e artefatos

Indique os arquivos relevantes (não cole conteúdo com dados sensíveis):

- `data\projects\<projeto>\state\<runId>.json`
- `data\projects\<projeto>\logs\`
- `data\projects\<projeto>\artifacts\<runId>\`
- `data\projects\<projeto>\reports\`

## Verificação de segurança

- [ ] Confirmo que **não** colei valores de chaves de API, tokens ou senhas neste relato.
- [ ] Confirmo que os caminhos e nomes de repositório citados podem ser divulgados.

## Informações adicionais

<!-- Qualquer coisa que ajude: mudança recente de ambiente, antivírus, caminho com acentos,
     rede corporativa, proxy, etc. -->
