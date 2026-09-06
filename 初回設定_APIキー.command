#!/bin/bash
mkdir -p "$HOME/.config/reval"
F="$HOME/.config/reval/apikey.txt"
[ -f "$F" ] || touch "$F"
echo "Anthropic APIキー（sk-ant-... で始まる）を取得し、開くエディタに貼り付けて保存してください。"
echo "取得先: https://console.anthropic.com  （API Keys -> Create Key）"
echo "保存先: $F"
open -e "$F"
echo ""
echo "貼り付け＆保存したら、このウィンドウを閉じて「ReVal自動読み取りを起動.command」を実行してください。"
read -n1 -s
