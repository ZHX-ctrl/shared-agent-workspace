param(
  [ValidateSet('Run', 'Probe')][string]$Mode = 'Run',
  [string]$JobName
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-job-host.cs')
  if ($Mode -eq 'Probe') {
    $count = [SharedWorkspaceJobHost]::Probe($JobName)
    if ($count -lt 0) { [Console]::Out.WriteLine('{"exists":false,"activeProcesses":null}') }
    else { [Console]::Out.WriteLine('{"exists":true,"activeProcesses":' + $count + '}') }
    exit 0
  }
  $configText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SHARED_WORKSPACE_JOB_CONFIG))
  $config = $configText | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable('SHARED_WORKSPACE_JOB_CONFIG', $null, 'Process')
  $exitCode = [SharedWorkspaceJobHost]::Run([string]$config.command, [string[]]$config.args, [string]$config.cwd,
    [string]$config.jobName, [string]$config.pipeName, [string]$config.token, [int]$config.startupTimeout)
  exit $exitCode
} catch {
  [Console]::Error.WriteLine('Windows Job host: ' + $_.Exception.Message)
  exit 125
}
