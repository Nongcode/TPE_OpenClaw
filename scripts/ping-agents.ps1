<#
Ping agents using the `openclaw` CLI.

Usage examples:
  # Ping default hardcoded agents sequentially
  .\scripts\ping-agents.ps1 -Local

  # Ping agents read from your user config (~\.openclaw\openclaw.json)
  .\scripts\ping-agents.ps1 -FromConfig -Local -Json

  # Ping a specific list
  .\scripts\ping-agents.ps1 -Agents main,truong_phong -Local -Json

Options:
  -Agents    Comma-separated list or array of agent ids
  -FromConfig Read agent list from $env:USERPROFILE\\.openclaw\\openclaw.json
  -Local     Use `--local` flag (default for local testing)
  -Gateway   Gateway URL to pass to `openclaw --gateway`
  -Token     Gateway token to pass to `openclaw --token`
  -DelayMs   Milliseconds to wait between pings (default 200)
  -Json      Ask `openclaw` for JSON output and pretty-print summary
  -Verbose   Pass `--verbose` to `openclaw`

Note: Ensure `openclaw` CLI is in your PATH.
#>

Param(
  [Parameter(Position=0, ValueFromRemainingArguments=$true)]
  [string[]] $Agents,

  [switch] $FromConfig,
  [switch] $Local,
  [string] $Gateway,
  [string] $Token,
  [int] $DelayMs = 200,
  [switch] $Json,
  [switch] $Verbose
)

function Show-Usage {
  Write-Host "Usage: .\scripts\ping-agents.ps1 [-Agents agent1,agent2] [-FromConfig] [-Local] [-Gateway url] [-Token token] [-DelayMs ms] [-Json] [-Verbose]"
  exit 1
}

if ($PSBoundParameters.ContainsKey('Help')) { Show-Usage }

if ($FromConfig) {
  $cfgPath = Join-Path $env:USERPROFILE ".openclaw\openclaw.json"
  if (-not (Test-Path $cfgPath)) {
    Write-Error "Config not found: $cfgPath"
    exit 1
  }
  try {
    $raw = Get-Content -Raw $cfgPath
    $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
    $list = $cfg.agents?.list
    if ($null -eq $list) {
      Write-Error "No agents list found in $cfgPath"
      exit 1
    }
    $Agents = $list | ForEach-Object { $_.id }
  } catch {
    Write-Error "Failed to read/parse $cfgPath: $($_.Exception.Message)"
    exit 1
  }
}

if (-not $Agents -or $Agents.Count -eq 0) {
  # sensible defaults for local dev
  $Agents = @('main','quan_ly','truong_phong','pho_phong','nv_content','nv_media','nv_consultant')
}

foreach ($a in $Agents) {
  if ([string]::IsNullOrWhiteSpace($a)) { continue }
  $agentId = $a.Trim()
  Write-Host "--- Pinging $agentId ---"

  $cmdArgs = @('agent')
  if ($Local) { $cmdArgs += '--local' }
  if ($Gateway) { $cmdArgs += '--gateway'; $cmdArgs += $Gateway }
  if ($Token) { $cmdArgs += '--token'; $cmdArgs += $Token }
  $cmdArgs += '--agent'; $cmdArgs += $agentId
  $cmdArgs += '--message'; $cmdArgs += 'ping'
  $cmdArgs += '--thinking'; $cmdArgs += 'low'
  if ($Json) { $cmdArgs += '--json' }
  if ($Verbose) { $cmdArgs += '--verbose' }

  try {
    $procOut = & openclaw @cmdArgs 2>&1
    if ($procOut -is [System.Array]) { $outStr = $procOut -join "`n" } else { $outStr = [string]$procOut }
  } catch {
    $outStr = "(failed to run openclaw) $($_.Exception.Message)"
  }

  if ($Json) {
    try {
      $parsed = $outStr | ConvertFrom-Json -ErrorAction Stop
      $status = if ($parsed -and $parsed.ok) { 'OK' } else { 'ERROR' }
      Write-Host ("{0,-18} {1}" -f $agentId, $status)
      Write-Host $outStr
    } catch {
      Write-Host $outStr
    }
  } else {
    Write-Host $outStr
  }

  Start-Sleep -Milliseconds ([int]$DelayMs)
}

Write-Host "All pings complete." | Out-Host
