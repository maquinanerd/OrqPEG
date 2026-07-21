# OrqPEG

Orquestrador local que coordena **Claude Code** e **Codex CLI** para executar,
revisar, testar e integrar trabalhos de desenvolvimento em múltiplos repositórios
Git já existentes no seu computador.

- **Pasta de instalação:** `C:\OrqPEG`
- **Repositório:** <https://github.com/maquinanerd/OrqPEG>
- **Branch padrão:** `main`
- **Plataforma alvo:** Windows 10/11, PowerShell 5.1+, Node.js LTS

## Zero API de IA

O OrqPEG usa **exclusivamente** os executáveis locais `claude` e `codex`,
autenticados pelas assinaturas **Claude Max** e **ChatGPT Plus**.

Não são usadas — em nenhuma hipótese — a Anthropic API, a OpenAI API, SDKs de
provedor, API keys ou automação de navegador. Todo processo filho de IA recebe um
ambiente sanitizado, do qual `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` e
`CODEX_API_KEY` são removidos.

## Documentação

A documentação completa é instalada junto com o produto:

- `COMECE-AQUI.html` — guia visual offline
- `README.md` — este arquivo
- `CHANGELOG.md` — histórico de versões

## Status

Repositório inicializado. A plataforma completa é entregue pela branch
`feat/orqpeg-initial-platform`.
