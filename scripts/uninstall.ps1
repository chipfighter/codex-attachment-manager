# Purpose: v0.1-5 - remove the Codex attachment manager on Windows in one line; also the way back when Codex cannot
# connect because the plugin was removed without turning it off in the panel first:
#   irm https://github.com/chipfighter/context-attachment-manager/releases/latest/download/uninstall.ps1 | iex
# Takes out only the marked blocks this tool wrote to config.toml and .env (config.toml is backed up first), then removes
# the plugin and its marketplace with Codex's own command line. Needs neither Node nor any of the plugin's files.
# Input: CODEX_HOME, CAM_DATA_DIR, CODEX_CLI_PATH. Output: config.toml, .env, Codex's plugin cache.
# ASCII only, and in its own scope (see install.ps1).

& {
  $ErrorActionPreference = 'Stop'
  $name = 'codex-attachment-manager'
  $plugin = "$name@$name"
  $beginMarkers = @(
    '# >>> codex-attachment-manager: managed proxy setting, remove it with the tool >>>',
    '# >>> codex-attachment-manager: managed MCP server, remove it with the tool >>>'
  )
  $endMarker = '# <<< codex-attachment-manager <<<'

  # The rule the plugin itself uses (codexconfig.ts): drop every marked block; a block at the very top takes the blank
  # line after it along. BOM and line endings stay as they were. Returns $null when there is nothing to remove.
  function Remove-ManagedBlocks([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $skip = if ($bom) { 3 } else { 0 }
    $body = [Text.Encoding]::UTF8.GetString($bytes, $skip, $bytes.Length - $skip)
    $eol = if ($body.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = $body.Split([string[]]@($eol), [StringSplitOptions]::None)
    $kept = New-Object System.Collections.Generic.List[string]
    $changed = $false
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($beginMarkers -notcontains $lines[$i].Trim()) { $kept.Add($lines[$i]); continue }
      $stop = $i + 1
      while ($stop -lt $lines.Length -and $lines[$stop].Trim() -ne $endMarker) { $stop++ }
      if ($stop -ge $lines.Length) { throw "A marked block in $Path has no end marker; the file was left as it is." }
      $atTop = $kept.Count -eq 0
      $i = $stop
      if ($atTop -and $i + 1 -lt $lines.Length -and $lines[$i + 1] -eq '') { $i++ }
      $changed = $true
    }
    if (-not $changed) { return $null }
    return [pscustomobject]@{ Bom = $bom; Text = [string]::Join($eol, $kept.ToArray()) }
  }

  function Save-Text([string]$Path, $Result) {
    $out = [Text.Encoding]::UTF8.GetBytes($Result.Text)
    if ($Result.Bom) { $out = [byte[]]((0xEF, 0xBB, 0xBF) + $out) }
    [IO.File]::WriteAllBytes($Path, $out)
  }

  $codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  $dataDir = if ($env:CAM_DATA_DIR) { $env:CAM_DATA_DIR } else { Join-Path $env:USERPROFILE ('.' + $name) }
  $config = Join-Path $codexHome 'config.toml'
  $dotenv = Join-Path $codexHome '.env'

  $result = Remove-ManagedBlocks $config
  if ($result) {
    $backups = Join-Path $dataDir 'config-backup'
    New-Item -ItemType Directory -Force -Path $backups | Out-Null
    Copy-Item -LiteralPath $config -Destination (Join-Path $backups ('config.toml.' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss.fffZ')))
    Save-Text $config $result
    Write-Host 'Codex connects directly again: the proxy settings were taken out of config.toml.'
  } else {
    Write-Host 'config.toml holds no proxy settings of this tool.'
  }
  $result = Remove-ManagedBlocks $dotenv
  if ($result) {
    # A .env that held nothing but this block is deleted rather than left empty.
    if ($result.Text.Trim() -eq '') { Remove-Item -LiteralPath $dotenv } else { Save-Text $dotenv $result }
    Write-Host 'The NO_PROXY block was taken out of .env.'
  }

  $codex = $null
  if ($env:CODEX_CLI_PATH -and (Test-Path -LiteralPath $env:CODEX_CLI_PATH)) { $codex = $env:CODEX_CLI_PATH }
  if (-not $codex) {
    $bin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $bin) {
      $codex = Get-ChildItem -LiteralPath $bin -Directory | ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending | Select-Object -First 1
    }
  }
  if (-not $codex) { $codex = (Get-Command codex -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -match '\.(exe|cmd)$' } | Select-Object -First 1).Source }
  if ($codex) {
    $ErrorActionPreference = 'Continue'
    & $codex plugin remove $plugin 2>&1 | Out-Null
    & $codex plugin marketplace remove $name 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    Write-Host 'The plugin and its marketplace were removed from Codex.'
  } else {
    Write-Host 'Codex command line not found: remove the plugin on the Plugins page in Codex.'
  }
  Write-Host ''
  Write-Host "Done. Restart Codex. Selections and logs stay in $dataDir; delete that folder if you do not need them."
}
