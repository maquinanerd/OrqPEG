<#
    OrqPEG - limpeza do ambiente de desenvolvimento.

    Compativel com Windows PowerShell 5.1 (sem os operadores &&, ||, ?: e ??).
    Uso:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-dev.ps1

    Remove APENAS estas duas pastas, e somente apos confirmacao explicita:
        dist\           saida da compilacao TypeScript
        node_modules\   dependencias de desenvolvimento

    NUNCA remove data\ nem config\. Isso e proposital e inegociavel:
      - data\   guarda projetos cadastrados, prompts, estado das execucoes,
                locks, logs, revisoes, relatorios e artefatos;
      - config\ guarda a configuracao global da instalacao.
    Nada dentro dessas duas pastas e apagado, movido ou sobrescrito por este
    script. Nenhum repositorio de projeto e tocado.

    Texto sem acentos de proposito, para nao depender do codepage do console.
#>

param()

$ErrorActionPreference = 'Stop'

$script:Root = Split-Path -Parent $PSScriptRoot

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
    # Console sem suporte a troca de codificacao: seguimos assim mesmo.
}

function Write-Ok {
    param([string] $Text)
    Write-Host ('  OK    ' + $Text) -ForegroundColor Green
}

function Write-Problem {
    param([string] $Text)
    Write-Host ('  ERRO  ' + $Text) -ForegroundColor Red
}

function Write-Detail {
    param([string] $Text)
    Write-Host ('        ' + $Text) -ForegroundColor DarkGray
}

# Pastas que este script pode remover. A lista e fechada de proposito.
$removableNames = @('dist', 'node_modules')

Write-Host ''
Write-Host '  ORQPEG - limpeza do ambiente de desenvolvimento' -ForegroundColor White
Write-Detail ('Pasta: ' + $script:Root)
Write-Host ''
Write-Host '  Serao removidas SOMENTE estas pastas:' -ForegroundColor Yellow

$targets = @()
foreach ($name in $removableNames) {
    $full = Join-Path $script:Root $name
    $exists = Test-Path -LiteralPath $full
    if ($exists) {
        Write-Host ('    - ' + $name + '   (presente)') -ForegroundColor Yellow
        $targets += $full
    }
    else {
        Write-Host ('    - ' + $name + '   (ja ausente, nada a fazer)') -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host '  NAO serao tocadas, em hipotese alguma:' -ForegroundColor Green
Write-Host '    - data\     projetos, prompts, estado, locks, logs, relatorios' -ForegroundColor Green
Write-Host '    - config\   configuracao global da instalacao' -ForegroundColor Green
Write-Host '    - src\, schemas\, public\, templates\ e os arquivos .cmd' -ForegroundColor Green
Write-Host '    - os repositorios dos seus projetos' -ForegroundColor Green
Write-Host ''

if ($targets.Count -eq 0) {
    Write-Ok 'Nada para remover: dist e node_modules ja nao existem.'
    Write-Host ''
    exit 0
}

Write-Host '  Depois da limpeza sera preciso rodar INSTALAR-E-CONFIGURAR.cmd' -ForegroundColor Gray
Write-Host '  ou scripts\build.ps1 para voltar a usar o OrqPEG.' -ForegroundColor Gray
Write-Host ''

$answer = Read-Host '  Digite LIMPAR para confirmar (qualquer outra coisa cancela)'
if ($answer -cne 'LIMPAR') {
    Write-Host ''
    Write-Host '  Cancelado. Nada foi removido.' -ForegroundColor Cyan
    Write-Host ''
    exit 0
}

Write-Host ''
$failures = 0

foreach ($target in $targets) {
    $name = Split-Path -Leaf $target

    # Rede de seguranca: so removemos um filho direto da raiz cujo nome esteja
    # na lista fechada acima.
    $parent = Split-Path -Parent $target
    if ($parent -ne $script:Root) {
        Write-Problem ('Caminho inesperado, remocao abortada: ' + $target)
        $failures = $failures + 1
        continue
    }
    if ($removableNames -notcontains $name) {
        Write-Problem ('Pasta fora da lista permitida, remocao abortada: ' + $name)
        $failures = $failures + 1
        continue
    }

    try {
        Remove-Item -LiteralPath $target -Recurse -Force -Confirm:$false
        Write-Ok ($name + ' removida.')
    }
    catch {
        Write-Problem ('Nao foi possivel remover ' + $name + ': ' + $_.Exception.Message)
        Write-Detail 'Feche editores, terminais e o painel que estejam usando esses arquivos.'
        $failures = $failures + 1
    }
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host ('  Limpeza terminou com ' + $failures + ' falha(s).') -ForegroundColor Red
    Write-Host ''
    exit 1
}

Write-Host '  Limpeza concluida. data\ e config\ continuam intactos.' -ForegroundColor Green
Write-Host '  Rode INSTALAR-E-CONFIGURAR.cmd ou scripts\build.ps1 para reconstruir.' -ForegroundColor Gray
Write-Host ''
exit 0
