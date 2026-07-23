<#
    OrqPEG - inicia o painel local em segundo plano e abre o navegador.

    Compativel com Windows PowerShell 5.1 (sem os operadores &&, ||, ?: e ??).
    Uso:
        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launcher.ps1

    Comportamento:
      - se o painel ja estiver respondendo, apenas abre o navegador;
      - caso contrario, inicia "node dist\cli\main.js panel start" em segundo
        plano, grava o PID em .orqpeg-server.pid, espera a porta responder e
        so entao abre o navegador.

    O painel escuta apenas em 127.0.0.1: nunca fica exposto na rede.
    Texto sem acentos de proposito, para nao depender do codepage do console.
#>

param()

$ErrorActionPreference = 'Stop'

$script:Root    = Split-Path -Parent $PSScriptRoot
$script:CliPath = Join-Path $script:Root 'dist\cli\main.js'
$script:PidFile = Join-Path $script:Root '.orqpeg-server.pid'

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

function Write-Warn {
    param([string] $Text)
    Write-Host ('  AVISO ' + $Text) -ForegroundColor Yellow
}

function Write-Problem {
    param([string] $Text)
    Write-Host ('  ERRO  ' + $Text) -ForegroundColor Red
}

function Write-Detail {
    param([string] $Text)
    Write-Host ('        ' + $Text) -ForegroundColor DarkGray
}

# Verdadeiro quando alguem esta escutando em host:porta.
function Test-PanelListening {
    param(
        [Parameter(Mandatory = $true)][string] $PanelHost,
        [Parameter(Mandatory = $true)][int] $Port
    )

    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect($PanelHost, $Port)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) {
            $client.Close()
        }
    }
}

# Le o PID gravado por uma execucao anterior, se o processo ainda estiver vivo.
function Get-RecordedServerProcess {
    if (-not (Test-Path -LiteralPath $script:PidFile)) {
        return $null
    }

    $raw = ''
    try {
        $raw = (Get-Content -LiteralPath $script:PidFile -Raw).Trim()
    }
    catch {
        return $null
    }

    $recordedId = 0
    if (-not [int]::TryParse($raw, [ref] $recordedId)) {
        return $null
    }
    if ($recordedId -le 0) {
        return $null
    }

    $process = Get-Process -Id $recordedId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    if ($process.ProcessName -ne 'node') {
        # O PID foi reaproveitado pelo Windows por outro programa: ignoramos.
        return $null
    }
    return $process
}

Write-Host ''
Write-Host '  ORQPEG - painel local' -ForegroundColor Cyan
Write-Host ''

# --- Pre-requisitos ---------------------------------------------------------

$node = Get-Command -Name 'node' -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Problem 'Node.js nao encontrado no PATH.'
    Write-Detail 'Instale a versao LTS 20 ou superior em https://nodejs.org'
    exit 1
}

if (-not (Test-Path -LiteralPath $script:CliPath)) {
    Write-Problem 'O OrqPEG ainda nao foi compilado: dist\cli\main.js nao existe.'
    Write-Detail 'Execute INSTALAR-E-CONFIGURAR.cmd primeiro.'
    exit 1
}

# --- Endereco do painel -----------------------------------------------------

$panelHost = '127.0.0.1'
$panelPort = 8765

$configFile = Join-Path $script:Root 'config\global.json'
if (Test-Path -LiteralPath $configFile) {
    $config = $null
    try {
        $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        $config = $null
    }
    if ($null -ne $config -and $null -ne $config.panel) {
        if ($config.panel.host) {
            $panelHost = [string] $config.panel.host
        }
        $configuredPort = 0
        if ([int]::TryParse([string] $config.panel.port, [ref] $configuredPort)) {
            if ($configuredPort -gt 0) {
                $panelPort = $configuredPort
            }
        }
    }
}

$url = 'http://' + $panelHost + ':' + $panelPort

# --- Painel ja no ar? -------------------------------------------------------

if (Test-PanelListening -PanelHost $panelHost -Port $panelPort) {
    Write-Ok ('O painel ja esta respondendo em ' + $url)
    Write-Detail 'Abrindo o navegador na instancia que ja estava rodando.'
    Start-Process $url | Out-Null
    exit 0
}

$recorded = Get-RecordedServerProcess
if ($null -ne $recorded) {
    Write-Warn ('Existe um processo node registrado (PID ' + $recorded.Id + '), mas a porta ' + $panelPort + ' nao responde.')
    Write-Detail 'Encerre esse processo ou use PARAR-PAINEL.cmd antes de iniciar outro.'
    Write-Detail 'Para ver as mensagens do servidor, rode INICIAR-PAINEL.cmd.'
    exit 1
}

if (Test-Path -LiteralPath $script:PidFile) {
    # PID antigo de um processo que ja terminou.
    Remove-Item -LiteralPath $script:PidFile -Force
}

# --- Inicio em segundo plano ------------------------------------------------

Write-Host ('  Iniciando o painel em ' + $url + ' ...') -ForegroundColor Gray

$arguments = '"' + $script:CliPath + '" panel start'
$server = $null
try {
    $server = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru
}
catch {
    Write-Problem ('Nao foi possivel iniciar o servidor: ' + $_.Exception.Message)
    exit 1
}

if ($null -eq $server) {
    Write-Problem 'O Windows nao devolveu o processo do servidor.'
    exit 1
}

try {
    Set-Content -LiteralPath $script:PidFile -Value ([string] $server.Id) -Encoding ASCII
    Write-Detail ('PID ' + $server.Id + ' gravado em .orqpeg-server.pid')
}
catch {
    Write-Warn ('Nao foi possivel gravar .orqpeg-server.pid: ' + $_.Exception.Message)
}

# --- Espera a porta responder ----------------------------------------------

$listening = $false
for ($attempt = 1; $attempt -le 40; $attempt++) {
    if ($server.HasExited) {
        break
    }
    if (Test-PanelListening -PanelHost $panelHost -Port $panelPort) {
        $listening = $true
        break
    }
    Start-Sleep -Milliseconds 500
}

if (-not $listening) {
    if ($server.HasExited) {
        Write-Problem ('O servidor encerrou sozinho com codigo ' + $server.ExitCode + '.')
    }
    else {
        Write-Problem ('O painel nao respondeu em ' + $url + ' dentro de 20 segundos.')
    }
    Write-Detail 'Rode INICIAR-PAINEL.cmd para ver as mensagens do servidor na tela.'
    Write-Detail 'Os logs ficam em data\logs.'
    if (Test-Path -LiteralPath $script:PidFile) {
        Remove-Item -LiteralPath $script:PidFile -Force
    }
    exit 1
}

Write-Ok ('Painel no ar em ' + $url)
Start-Process $url | Out-Null
Write-Detail 'O servidor continua rodando em segundo plano.'
Write-Detail 'Para encerrar, use PARAR-PAINEL.cmd ou feche o processo node do PID acima.'
Write-Host ''
exit 0
