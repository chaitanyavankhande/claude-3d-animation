#!/bin/bash
# Double-click to start ATLAS on macOS (first time: right-click > Open).
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org and try again."; read -r; exit 1; }
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env - put your API key in it, save, then run this again."; open -e .env; exit 0; fi
[ -d node_modules ] || { echo "Installing, first run only..."; npm install || exit 1; }
ATLAS_OPEN=1 npm start
