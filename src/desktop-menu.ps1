$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $framework = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $references = @('System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', (Join-Path $framework 'WPF\UIAutomationClient.dll'), (Join-Path $framework 'WPF\UIAutomationTypes.dll'), (Join-Path $framework 'WPF\WindowsBase.dll'))
    Add-Type -Path (Join-Path $PSScriptRoot 'desktop-menu.cs') -ReferencedAssemblies $references
    if ($request.operation -eq 'inspect') {
        $value = @{ ok = $true; names = @([WorkspaceDesktopMenu]::Inspect()) }
    } elseif ($request.operation -eq 'inspectMenus') {
        $value = @{ ok = $true; names = @([WorkspaceDesktopMenu]::InspectMenus()) }
    } elseif ($request.operation -eq 'cancelConfirmation') {
        $value = @{ ok = $true; result = [WorkspaceDesktopMenu]::CancelConfirmation() }
    } elseif ($request.operation -eq 'verifyArchiveNeutral') {
        $value = @{ ok = $true; result = 'neutral'; proof = [WorkspaceDesktopMenu]::VerifyArchiveNeutral() }
    } elseif ($request.operation -in @('archiveThread', 'unarchiveThread', 'verifyThreadArchive')) {
        $proof = $null
        if ($null -ne $request.transitionProof) {
            $proof = New-Object WorkspaceDesktopMenu+ArchiveNeutralProof
            $proof.pid = [int]$request.transitionProof.pid
            $proof.hwnd = [long]$request.transitionProof.hwnd
            $proof.lastInputTick = [uint32]$request.transitionProof.lastInputTick
            $proof.checkedAt = [long]$request.transitionProof.checkedAt
        }
        $result = [WorkspaceDesktopMenu]::RunArchive($request.operation, $request.name, $request.threadId, [bool]$request.archived, $proof)
        $value = @{ ok = $true; result = $result; identityMethod = [WorkspaceDesktopMenu]::LastArchiveIdentityMethod; clipboardRestoreStatus = [WorkspaceDesktopMenu]::LastClipboardRestoreStatus; clipboardRestoreError = [WorkspaceDesktopMenu]::LastClipboardRestoreError }
    } else {
        $value = @{ ok = $true; result = [WorkspaceDesktopMenu]::Run($request.operation, $request.name, $request.threadId) }
    }
    $value | ConvertTo-Json -Compress -Depth 5
    exit 0
} catch {
    @{ ok = $false; error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress
    exit 1
}
