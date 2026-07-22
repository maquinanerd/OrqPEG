@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Diagnostico

rem ---------------------------------------------------------------------------
rem  OrqPEG - diagnostico completo do ambiente.
rem  Verifica sistema, instalacao, configuracao, ferramentas (node, git, gh,
rem  claude, codex), porta do painel, schemas, wrappers, projetos e locks.
rem  Nenhum valor de credencial e lido ou exibido.
rem  Comando: node dist\cli\main.js doctor
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" doctor %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
echo.
pause
endlocal & exit /b %ORQPEG_EXIT%

:sem_node
echo.
echo  [ERRO] O Node.js nao foi encontrado no PATH deste computador.
echo         Instale a versao LTS 20 ou superior a partir de https://nodejs.org
echo         e depois abra este arquivo novamente.
echo.
pause
endlocal & exit /b 1

:sem_build
echo.
echo  [ERRO] O OrqPEG ainda nao foi compilado.
echo         Arquivo ausente: dist\cli\main.js
echo         Execute primeiro INSTALAR-E-CONFIGURAR.cmd, nesta mesma pasta.
echo.
pause
endlocal & exit /b 1
