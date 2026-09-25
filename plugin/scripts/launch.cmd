@echo off
rem Purpose: P5 - start the plugin's MCP server with a Node that runs TypeScript directly (Node 24 or newer).
rem Tries the Node runtimes that Codex ships first, then a node on PATH.
rem Input: the script to run and its arguments. Output: whatever the script prints (the MCP stdio stream).
setlocal

if "%~1"=="" (
  echo codex-attachment-manager: missing script path 1>&2
  exit /b 64
)

if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" (
  "%CODEX_MCP_NODE_PATH%" %*
  exit /b
)
if defined CODEX_BROWSER_USE_NODE_PATH if exist "%CODEX_BROWSER_USE_NODE_PATH%" (
  "%CODEX_BROWSER_USE_NODE_PATH%" %*
  exit /b
)
if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if exist "%%~fD\bin\node.exe" (
  "%%~fD\bin\node.exe" %*
  exit /b
)
if defined USERPROFILE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" %*
  exit /b
)

where node >nul 2>&1
if not errorlevel 1 (
  node %*
  exit /b
)

echo codex-attachment-manager: no Node runtime found; update Codex or install Node 24 1>&2
exit /b 127
