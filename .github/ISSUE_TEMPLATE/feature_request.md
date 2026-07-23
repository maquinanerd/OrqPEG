---
name: Propor uma melhoria
about: Sugerir uma capacidade nova ou uma mudança de comportamento do OrqPEG
title: '[MELHORIA] '
labels: ['melhoria', 'triagem']
assignees: ''
---

## Problema a resolver

<!-- Qual dificuldade real você enfrenta hoje. Descreva a situação, não a solução. -->

## Proposta

<!-- O que você gostaria que o OrqPEG passasse a fazer, em termos de comportamento
     observável: dado <estado>, quando <ação>, então <resultado>. -->

## Alternativas consideradas

<!-- O que você já tentou, e por que não resolve. -->

## Área afetada

- [ ] CLI e wrappers `.cmd`
- [ ] Painel local
- [ ] Cadastro de projetos e configuração
- [ ] Prompts e revisão
- [ ] Execução, testes e worktrees
- [ ] Git, GitHub, Pull Request e CI
- [ ] Consenso, gates e merge
- [ ] Estado, locks, relatórios e artefatos
- [ ] Segurança
- [ ] Documentação

## Compatibilidade com as regras invioláveis

A proposta precisa respeitar os princípios do produto. Confirme:

- [ ] Não exige nenhuma dependência de runtime (só módulos nativos do Node)
- [ ] Não usa SDK, endpoint de API de IA nem API key — apenas os executáveis locais `claude` e `codex`
- [ ] Não introduz operação Git destrutiva (`push --force`, `reset --hard`, `git clean`, `branch -D`)
- [ ] Não afrouxa nenhum dos 20 gates de merge nem permite merge com uma única IA
- [ ] Não faz o painel escutar fora de `127.0.0.1`
- [ ] Não executa processo externo por shell ou concatenação de linha de comando

Se algum item acima não puder ser marcado, explique por quê:

## Impacto esperado

- Quem se beneficia:
- Frequência de uso:
- O que fica pior ou mais complexo:

## Critérios de aceitação sugeridos

- [ ]
- [ ]
- [ ]
