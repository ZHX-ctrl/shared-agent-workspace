$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.operation -notin @('deleteCurrent','verifyAbsent','archiveCurrent','unarchiveCurrent','verifyArchived','verifyUnarchived')) { throw 'Unsupported Claude menu operation' }
    $framework = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $references = @('System.Core.dll', (Join-Path $framework 'WPF\UIAutomationClient.dll'), (Join-Path $framework 'WPF\UIAutomationTypes.dll'), (Join-Path $framework 'WPF\WindowsBase.dll'))
    Add-Type -Path (Join-Path $PSScriptRoot 'claude-desktop-menu.cs') -ReferencedAssemblies $references
    if ($request.operation -eq 'verifyAbsent') { $result = [WorkspaceClaudeMenu]::VerifyAbsent($request.desktopId) }
    elseif ($request.operation -eq 'deleteCurrent') { $result = [WorkspaceClaudeMenu]::DeleteCurrent($request.desktopId, $request.title) }
    else { $result = [WorkspaceClaudeMenu]::ArchiveCurrent($request.desktopId, $request.title, $request.operation) }
    @{ ok = $true; result = $result } | ConvertTo-Json -Compress
    exit 0
} catch {
    # Return only stage and exception class, never UI text, title, paths, or a
    # raw automation tree. Some UIA COM exceptions have an empty base message.
    $failure = $_.Exception
    $safeError = 'CLAUDE_NATIVE_EXCEPTION'
    while ($failure) {
        if ($failure.Message -match 'CLAUDE_[A-Z_]+(?::[a-zA-Z0-9_:-]+)?') { $safeError = $Matches[0]; break }
        $failure = $failure.InnerException
    }
    $stage = 'load-helper'
    try { $stage = [WorkspaceClaudeMenu]::LastStage } catch { }
    @{ ok = $false; error = $safeError; stage = $stage; exceptionType = $_.Exception.GetBaseException().GetType().FullName } | ConvertTo-Json -Compress
    exit 1
}
