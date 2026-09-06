@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ReVal 自動読み取り
where node >nul 2>nul
if errorlevel 1 ( echo [エラー] Node.js が見つかりません。https://nodejs.org の LTS を入れてください。 & pause & exit /b 1 )
if not exist "%USERPROFILE%\.config\reval\apikey.txt" ( echo [!] APIキー未設定。先に「初回設定_APIキー.bat」を実行してください。 & pause & exit /b 1 )
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5178" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>nul
echo ReVal を起動します。数秒でブラウザが開きます  ->  http://localhost:5178
echo この黒い画面は開いたままに（閉じると停止）。落ちても自動で再起動します。
echo.
:loop
node server.js
echo.
echo [!] 停止しました。3秒後に自動再起動します...（やめるなら窓を閉じる）
timeout /t 3 >nul
goto loop
