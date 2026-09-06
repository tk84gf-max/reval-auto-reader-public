@echo off
chcp 65001 >nul
title ReVal APIキー初回設定
set DIR=%USERPROFILE%\.config\reval
if not exist "%DIR%" mkdir "%DIR%"
set F=%DIR%\apikey.txt
if not exist "%F%" type nul > "%F%"
echo Anthropic APIキー（sk-ant-... で始まる）を取得し、開くメモ帳に貼り付けて保存してください。
echo 取得先: https://console.anthropic.com  （左メニュー API Keys → Create Key）
echo 保存先: %F%
echo （この鍵で使った分だけ各自に課金されます。1枚あたり数円程度）
start notepad "%F%"
echo.
echo 貼り付け＆保存したら、この窓を閉じて「ReVal自動読み取りを起動.bat」を実行してください。
pause
