@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Abrir painel

rem ---------------------------------------------------------------------------
rem  OrqPEG - abre o painel local no navegador padrao.
rem  Este atalho apenas ABRE o endereco do painel. Se a pagina nao carregar,
rem  o servidor ainda nao esta rodando: use INICIAR-PAINEL.cmd.
rem  Comando: node dist\cli\main.js panel open
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" panel open %*
set "ORQPEG_EXIT=%ERRORLEVEL%"
if not "%ORQPEG_EXIT%"=="0" pause
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
