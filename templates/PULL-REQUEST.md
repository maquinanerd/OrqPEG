## Resumo

Execução automatizada do OrqPEG sobre o projeto **{{PROJECT_NAME}}**.

| Campo | Valor |
| --- | --- |
| Projeto | {{PROJECT_NAME}} |
| Execução | `{{RUN_ID}}` |
| Branch | `{{BRANCH}}` |
| Branch base | `{{BASE_BRANCH}}` |

Cada prompt desta execução foi implementado por uma IA executora, teve os testes do projeto executados localmente e passou por uma revisão independente antes de virar commit. Um prompt só é marcado como aprovado quando o revisor emite veredito de aprovação sem problemas bloqueantes.

Esta Pull Request só é elegível para merge automático quando **todos** os gates listados no final deste documento estiverem aprovados, incluindo as duas auditorias finais independentes sobre o mesmo commit de HEAD.

## Prompts executados

{{PROMPT_TABLE}}

Legenda de status: `APPROVED` aprovado pela revisão independente · `CHANGES_REQUESTED` reprovado e reenviado para correção · `BLOCKED` interrompido para decisão humana · `SKIPPED` não executado · `FAILED` falhou na execução · `PENDING` ainda não executado.

## Testes

{{TEST_SUMMARY}}

Os comandos acima são os definidos em `commands.tests` do projeto e foram executados no diretório de trabalho da execução (worktree isolada quando habilitada). Nenhum teste foi removido, ignorado ou enfraquecido para obter aprovação: a política do OrqPEG trata isso como falha bloqueante.

As verificações de integração contínua do repositório rodam sobre o commit de HEAD desta branch e são avaliadas separadamente pelos gates de merge.

## Commits

{{COMMIT_LIST}}

Cada commit corresponde a um prompt aprovado. Nenhum commit é criado antes da aprovação da revisão independente, e a branch nunca recebe push forçado.

## Estado dos gates de merge

{{GATE_STATUS}}

O merge automático exige aprovação de **todos** os gates, entre eles:

- todos os prompts aprovados e com commit criado;
- branch enviada para o remoto correto e Pull Request aberta contra `{{BASE_BRANCH}}`;
- ausência de conflitos com a branch base;
- testes locais aprovados;
- verificações obrigatórias de CI aprovadas, sem pendentes e sem puladas;
- nenhuma thread de revisão não resolvida e nenhuma revisão humana pedindo mudanças;
- auditoria final do Claude e auditoria final do Codex aprovadas, ambas sobre **o mesmo commit de HEAD**;
- confiança mínima atingida pelas duas auditorias e nenhum problema bloqueante em aberto;
- commit de HEAD inalterado entre a auditoria e o merge.

Qualquer novo commit nesta branch invalida as aprovações das auditorias, que precisam ser refeitas sobre o novo HEAD.

---

Pull Request gerada automaticamente pelo OrqPEG (execução `{{RUN_ID}}`). Revisão humana continua bem-vinda e prevalece sobre a decisão automatizada: uma revisão humana pedindo mudanças bloqueia o merge.
