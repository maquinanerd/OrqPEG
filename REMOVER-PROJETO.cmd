@echo off
chcp 65001 >nul
setlocal
title OrqPEG - Remover projeto

rem ---------------------------------------------------------------------------
rem  OrqPEG - remove o CADASTRO de um projeto.
rem  O repositorio real no disco NAO e apagado: somente os dados operacionais
rem  do OrqPEG para aquele projeto. A CLI pede uma confirmacao explicita.
rem  Comando: node dist\cli\main.js project remove
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto sem_node

if not exist "%~dp0dist\cli\main.js" goto sem_build

node "%~dp0dist\cli\main.js" project remove %*
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
