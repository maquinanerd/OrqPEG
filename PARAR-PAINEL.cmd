@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Parar painel

rem ---------------------------------------------------------------------------
rem  OrqPEG - encerra o painel local.
rem  Nenhuma execucao em andamento e destruida: o estado, o codigo, a branch e
rem  os logs sao preservados.
rem  Comando: node dist\cli\main.js panel stop
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" panel stop %*
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
