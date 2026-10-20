param([switch]$NoOpen, [string]$WorkspaceRoot = $PSScriptRoot, [ValidateRange(1024,65535)][int]$Port = 43118)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
$workspaceUrl = "http://127.0.0.1:$Port/"
$launcherHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($workspaceRoot.ToLowerInvariant()))).Replace('-', '')
$launcherMutex = New-Object Threading.Mutex($false, "Local\SharedWorkspaceLauncher-$launcherHash")
$launcherLocked = $false
try {
    try { $launcherLocked = $launcherMutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $launcherLocked = $true }
    if (-not $launcherLocked) { throw '工作台仍在启动，请稍后再试。' }
    function Test-WorkspaceReady {
        try {
            $health = Invoke-RestMethod -Uri ($workspaceUrl + 'health') -TimeoutSec 2 -UseBasicParsing
        } catch { return $false } # Compatible with Windows PowerShell 5.1 and PowerShell 7; no optional exception type references.
        if ($health.application -eq 'shared-agent-workspace') { return $true }
        throw "本机端口 $Port 已被其他应用使用。"
    }
    if (-not (Test-WorkspaceReady)) {
        $workspaceNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (-not $workspaceNode -and (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe')) { $workspaceNode = 'C:\Program Files\nodejs\node.exe' }
        if (-not $workspaceNode) { throw '未找到 Node.js。请检查已有 Node.js 安装。' }
        $launcherLogDir = Join-Path $workspaceRoot 'work\launcher'
        New-Item -ItemType Directory -Path $launcherLogDir -Force | Out-Null
        $launcherStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $launcherStdout = Join-Path $launcherLogDir "$launcherStamp.stdout.log"
        $launcherStderr = Join-Path $launcherLogDir "$launcherStamp.stderr.log"
        $serviceScript = Join-Path $workspaceRoot 'src\workspace-service.ps1'
        if (-not (Test-Path -LiteralPath $serviceScript -PathType Leaf)) { throw '工作台后台启动文件缺失。' }
        $launcherPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $logPrefix = Join-Path $launcherLogDir $launcherStamp
        # The Windows process service launches this outside the calling app's
        # process tree/job. Closing Codex must not kill the workbench service.
        $serviceCommand = '"' + $launcherPowerShell + '" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $serviceScript + '" -WorkspaceRoot "' + $workspaceRoot + '" -NodePath "' + $workspaceNode + '" -LogPrefix "' + $logPrefix + '" -Port ' + $Port
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$serviceCommand; CurrentDirectory=$workspaceRoot; ProcessStartupInformation=$startup}
        if ($created.ReturnValue -ne 0) { throw "无法启动独立后台（Windows 返回 $($created.ReturnValue)）。未启动依赖 Codex 的临时后台。" }
        $workspaceProcess = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
        if (-not $workspaceProcess) { throw "后台启动失败，请查看日志：$logPrefix.bootstrap-error.log" }
        $launcherDeadline = (Get-Date).AddSeconds(25)
        $workspaceReady = $false
        do {
            Start-Sleep -Milliseconds 250
            $workspaceReady = Test-WorkspaceReady
            $workspaceProcess.Refresh()
            if ($workspaceReady) { break }
            if ($workspaceProcess.HasExited) { throw "工作台启动失败，请查看日志：$launcherStderr" }
        } while ((Get-Date) -lt $launcherDeadline)
        if (-not $workspaceReady) { throw "工作台启动超时，请查看日志：$launcherStderr" }
    }
    if (-not $NoOpen) { Start-Process $workspaceUrl }
    Write-Output $workspaceUrl
} catch {
    $launcherError = $_.Exception.Message
    if (-not $NoOpen) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($launcherError, '共享工作台', 'OK', 'Error') | Out-Null
    }
    Write-Error $launcherError
    exit 1
} finally {
    if ($launcherLocked) { $launcherMutex.ReleaseMutex() }
    $launcherMutex.Dispose()
}
