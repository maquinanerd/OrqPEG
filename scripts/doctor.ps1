<#
    OrqPEG - diagnostico do ambiente com saida colorida.

    Compativel com Windows PowerShell 5.1 (sem os operadores &&, ||, ?: e ??).
    Uso:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\doctor.ps1

    Chama "node dist\cli\main.js doctor", pinta cada linha conforme o status
    e devolve:
        0  nenhum ERRO encontrado
        1  pelo menos um ERRO encontrado (ou falha ao rodar o diagnostico)

    Nenhum valor de credencial e lido ou exibido: o diagnostico reporta apenas
    os NOMES das variaveis de API presentes no ambiente.
    Texto sem acentos de proposito, para nao depender do codepage do console.
#>

param()

$ErrorActionPreference = 'Stop'

$script:Root    = Split-Path -Parent $PSScriptRoot
$script:CliPath = Join-Path $script:Root 'dist\cli\main.js'

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
    # Console sem suporte a troca de codificacao: seguimos assim mesmo.
}

$node = Get-Command -Name 'node' -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host ''
    Write-Host '  ERRO  Node.js nao encontrado no PATH.' -ForegroundColor Red
    Write-Host '        Instale a versao LTS 20 ou superior em https://nodejs.org' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

if (-not (Test-Path -LiteralPath $script:CliPath)) {
    Write-Host ''
    Write-Host '  ERRO  O OrqPEG ainda nao foi compilado: dist\cli\main.js nao existe.' -ForegroundColor Red
    Write-Host '        Execute INSTALAR-E-CONFIGURAR.cmd primeiro.' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

$previousLocation = Get-Location
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

$outputLines = @()
$cliExit = 1

try {
    Set-Location -LiteralPath $script:Root
    $outputLines = @(& node $script:CliPath 'doctor')
    $cliExit = $LASTEXITCODE
}
catch {
    Write-Host ('  ERRO  Falha ao executar o diagnostico: ' + $_.Exception.Message) -ForegroundColor Red
    $cliExit = 1
}
finally {
    Set-Location -LiteralPath $previousLocation.Path
    $ErrorActionPreference = $previousPreference
}

if ($null -eq $cliExit) {
    $cliExit = 0
}

$errorItems   = 0
$warningItems = 0
$okItems      = 0

foreach ($line in $outputLines) {
    $text = [string] $line

    if ($text -match '^\s*\[ERRO') {
        $errorItems = $errorItems + 1
        Write-Host $text -ForegroundColor Red
        continue
    }
    if ($text -match '^\s*\[AVISO') {
        $warningItems = $warningItems + 1
        Write-Host $text -ForegroundColor Yellow
        continue
    }
    if ($text -match '^\s*\[OK') {
        $okItems = $okItems + 1
        Write-Host $text -ForegroundColor Green
        continue
    }
    if ($text -match '^\s*RESULTADO:') {
        if ($text -match 'RESULTADO:\s*ERRO') {
            Write-Host $text -ForegroundColor Red
        }
        elseif ($text -match 'RESULTADO:\s*AVISO') {
            Write-Host $text -ForegroundColor Yellow
        }
        else {
            Write-Host $text -ForegroundColor Green
        }
        continue
    }
    Write-Host $text -ForegroundColor Gray
}

Write-Host ''
Write-Host ('  Itens: {0} OK, {1} AVISO, {2} ERRO' -f $okItems, $warningItems, $errorItems) -ForegroundColor White

if ($errorItems -gt 0) {
    Write-Host '  Corrija os itens em vermelho e rode este diagnostico de novo.' -ForegroundColor Red
    Write-Host ''
    exit 1
}

if ($cliExit -ne 0) {
    Write-Host ('  O diagnostico terminou com o codigo ' + $cliExit + '.') -ForegroundColor Red
    Write-Host ''
    exit 1
}

if ($warningItems -gt 0) {
    Write-Host '  Nenhum erro. Leia os avisos em amarelo antes de executar um projeto.' -ForegroundColor Yellow
    Write-Host ''
    exit 0
}

Write-Host '  Ambiente pronto para uso.' -ForegroundColor Green
Write-Host ''
exit 0
