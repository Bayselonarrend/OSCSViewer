@echo off
echo Installing dependencies...
call npm install

echo Compiling TypeScript...
call npm run compile

echo Installing vsce if needed...
call npm install -g @vscode/vsce

echo Building VSIX package...
call vsce package

echo Done!
pause
