param(
    [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$LogPrefix,
    [ValidateRange(1024,65535)][int]$Port = 43118
)
$ErrorActionPreference = 'Stop'
try {
    $serverPath = Join-Path $WorkspaceRoot 'src\server.mjs'
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw 'Workspace runtime files are missing.'
    }
    $env:SHARED_AGENT_PORT = [string]$Port
    $env:CODEX_THREAD_ID = $null
    $serviceProcess = Start-Process -FilePath $NodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden -RedirectStandardOutput ($LogPrefix + '.stdout.log') -RedirectStandardError ($LogPrefix + '.stderr.log') -PassThru
    [ordered]@{ pid=$serviceProcess.Id; supervisorPid=$PID; port=$Port; startedAt=(Get-Date).ToUniversalTime().ToString('o'); launchMode='independent-wmi'; root=$WorkspaceRoot } | ConvertTo-Json | Set-Content -LiteralPath ($LogPrefix + '.service.json') -Encoding UTF8
    $serviceProcess.WaitForExit()
    $serviceProcess.Refresh()
    exit $serviceProcess.ExitCode
} catch {
    $_.Exception.Message | Out-File -LiteralPath ($LogPrefix + '.bootstrap-error.log') -Encoding UTF8
    exit 1
}
