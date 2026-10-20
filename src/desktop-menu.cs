// Windows accessibility adapter for the user's explicitly requested Codex menu
// actions. No cache edits, renderer injection, restart, or project-file access.
using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using System.Windows.Forms;

public static class WorkspaceDesktopMenu {
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO value);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("ole32.dll")] static extern int OleFlushClipboard();
    [DllImport("ole32.dll")] static extern int OleIsCurrentClipboard(System.Runtime.InteropServices.ComTypes.IDataObject data);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    static IntPtr handle;
    static AutomationElement window;
    static string phase;
    static bool copiedMarkerUnchanged, copyContainsExpectedId, copyHasExpectedPath;
    static uint? protectedInputTick;
    public static string LastArchiveIdentityMethod { get; private set; }
    public static string LastClipboardRestoreStatus { get; private set; }
    public static string LastClipboardRestoreError { get; private set; }
    public class ArchiveNeutralProof {
        public int pid; public long hwnd; public uint lastInputTick; public long checkedAt;
    }
    static uint InputTick() {
        var value = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
        if (!GetLastInputInfo(ref value)) throw new Exception("DESKTOP_INPUT_PROOF_UNAVAILABLE");
        return value.dwTime;
    }
    static void Check() {
        if ((GetAsyncKeyState(27) & 0x8000) != 0) throw new Exception("DESKTOP_CANCELLED: Escape pressed; operation stopped.");
        if (GetForegroundWindow() != handle) throw new Exception("DESKTOP_FOCUS_CHANGED: Codex is no longer the foreground window; operation stopped.");
        if (protectedInputTick.HasValue && InputTick() != protectedInputTick.Value) throw new Exception("DESKTOP_INPUT_CHANGED: User input changed during the verified route transition.");
    }
    static AutomationElement[] Find(AutomationElement root, ControlType type, params string[] names) {
        var condition = type == null ? Condition.TrueCondition : new PropertyCondition(AutomationElement.ControlTypeProperty, type);
        return root.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>()
            .Where(e => names.Length == 0 || names.Any(n => e.Current.Name == n ||
                (type == ControlType.MenuItem && e.Current.Name.StartsWith(n + " ") && Regex.IsMatch(e.Current.Name.Substring(n.Length + 1), @"^(?:(?:Alt|Ctrl|Shift|Cmd)\+)+[A-Za-z0-9]+$")))).ToArray();
    }
    static AutomationElement One(AutomationElement[] values, string label) {
        if (values.Length != 1) throw new Exception("DESKTOP_TARGET_AMBIGUOUS: " + label + " matched " + values.Length + " controls; nothing else will be clicked.");
        return values[0];
    }
    static void Attach(bool activate) {
        var candidates = new List<Process>();
        foreach (var p in Process.GetProcessesByName("ChatGPT")) {
            try { if (p.MainWindowHandle != IntPtr.Zero && p.MainModule.FileName.IndexOf(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0) candidates.Add(p); }
            catch { }
        }
        if (candidates.Count != 1) throw new Exception("DESKTOP_NOT_AVAILABLE: Expected exactly one installed Codex window.");
        handle = candidates[0].MainWindowHandle;
        window = AutomationElement.FromHandle(handle);
        if (activate) { SetForegroundWindow(handle); Thread.Sleep(200); Check(); }
    }
    static AutomationElement Sidebar() {
        return One(Find(window, null, "首页", "Home").Where(e => e.Current.ControlType != ControlType.Button &&
            Find(e, ControlType.Button, "新聊天", "New chat").Length > 0).ToArray(), "Codex sidebar");
    }
    static void Invoke(AutomationElement element) {
        Check();
        if (!element.Current.IsEnabled) throw new Exception("DESKTOP_CONTROL_DISABLED");
        object pattern;
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) ((InvokePattern)pattern).Invoke();
        else if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) ((ExpandCollapsePattern)pattern).Expand();
        else throw new Exception("DESKTOP_INVOKE_UNSUPPORTED");
    }
    static void ContextMenu(AutomationElement element) {
        Check();
        object pattern;
        if (element.Current.IsOffscreen && element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern)) ((ScrollItemPattern)pattern).ScrollIntoView();
        if (element.Current.IsOffscreen) throw new Exception("DESKTOP_TARGET_NOT_VISIBLE");
        element.SetFocus();
        Thread.Sleep(100);
        if (!Automation.Compare(AutomationElement.FocusedElement, element)) throw new Exception("DESKTOP_TARGET_FOCUS_MISMATCH");
        Check();
        SendKeys.SendWait("+{F10}");
    }
    static AutomationElement WaitOne(ControlType type, string[] names, int timeout) {
        var clock = Stopwatch.StartNew();
        do {
            Check(); var matches = Find(window, type, names).Where(e => !e.Current.IsOffscreen).ToArray();
            if (matches.Length > 0) return One(matches, String.Join(" / ", names));
            Thread.Sleep(150);
        } while (clock.ElapsedMilliseconds < timeout);
        throw new Exception("DESKTOP_CONTROL_NOT_FOUND: " + String.Join(" / ", names));
    }
    static bool HasSidebarName(string name) { return Find(Sidebar(), ControlType.Button, name).Length != 0; }
    public static string[] Inspect() {
        Attach(false);
        return Find(Sidebar(), ControlType.Button).Select(e => e.Current.Name).Where(n => !String.IsNullOrEmpty(n)).ToArray();
    }
    public static string[] InspectMenus() {
        Attach(false);
        return Find(window, null).Where(e => !e.Current.IsOffscreen && (e.Current.ControlType == ControlType.MenuItem || e.Current.ControlType == ControlType.Window ||
            (e.Current.ControlType == ControlType.Button && new [] { "删除", "Delete", "取消", "Cancel", "关闭", "Close" }.Contains(e.Current.Name)) ||
            e.Current.Name == "要删除聊天吗？" || e.Current.Name == "Delete chat?" || e.Current.Name == "无法删除聊天。请重试。"))
            .Select(e => e.Current.ControlType.ProgrammaticName + ":" + e.Current.Name).ToArray();
    }
    public static string CancelConfirmation() {
        Attach(true);
        if (Find(window, ControlType.Text, "要删除聊天吗？", "Delete chat?").Any(e => !e.Current.IsOffscreen)) {
            Invoke(One(Find(window, ControlType.Button, "取消", "Cancel"), "cancel pending deletion"));
            Thread.Sleep(250);
        }
        return "cancelled";
    }

    // Archive operations are separate from the existing delete implementation.
    // Every mutation uses the official app controls and exact copied deep link.
    static void AttachArchive() {
        Attach(false);
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle); Thread.Sleep(120);
        if (GetForegroundWindow() != handle) {
            uint ignored; uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint current = GetCurrentThreadId(); bool joined = false;
            try { if (foreground != 0 && current != foreground) joined = AttachThreadInput(current, foreground, true); SetForegroundWindow(handle); }
            finally { if (joined) AttachThreadInput(current, foreground, false); }
            Thread.Sleep(120);
        }
        Check();
    }
    static void InvokeArchive(AutomationElement element) {
        Check(); if (!element.Current.IsEnabled) throw new Exception("DESKTOP_CONTROL_DISABLED");
        object pattern;
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); return; }
        ClickArchiveControl(element);
    }
    static void ClickArchiveControl(AutomationElement element) {
        Check(); if (!element.Current.IsEnabled) throw new Exception("DESKTOP_CONTROL_DISABLED");
        System.Windows.Point point;
        if (element.Current.IsOffscreen || !element.TryGetClickablePoint(out point)) throw new Exception("DESKTOP_TARGET_NOT_VISIBLE");
        var hit = AutomationElement.FromPoint(point); bool matched = false;
        for (int i = 0; hit != null && i < 8; i++, hit = TreeWalker.RawViewWalker.GetParent(hit)) {
            if (Automation.Compare(hit, element)) { matched = true; break; }
        }
        if (!matched || (GetAsyncKeyState(1) & 0x8000) != 0) throw new Exception("DESKTOP_CLICK_TARGET_MISMATCH");
        Check(); protectedInputTick = null; SetCursorPos((int)point.X, (int)point.Y); Check();
        mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
    public static ArchiveNeutralProof VerifyArchiveNeutral() {
        using (var gate = new Mutex(false, "Local\\SharedAgentWorkspace-CodexMenu")) {
            bool entered; try { entered = gate.WaitOne(0); } catch (AbandonedMutexException) { entered = true; }
            if (!entered) throw new Exception("DESKTOP_BUSY");
            try {
                protectedInputTick = null; AttachArchive();
                var timer = Stopwatch.StartNew();
                do {
                    Check();
                    bool general = Find(window, null, "常规", "General").Any(e => !e.Current.IsOffscreen);
                    bool setting = Find(window, null, "自动归档不活跃的聊天", "Auto-archive inactive chats", "默认终端位置", "Default terminal location", "关闭窗口前确认", "Confirm before closing window", "纯文本编辑器", "Plain text composer", "显示上下文窗口使用情况", "Show context window usage").Any(e => !e.Current.IsOffscreen);
                    bool archived = Find(window, ControlType.Text, "此聊天已归档", "This chat is archived", "此聊天已归档。要继续，请先取消归档。", "This chat is archived. To continue, unarchive it first").Any(e => !e.Current.IsOffscreen);
                    if (general && setting && !archived) return new ArchiveNeutralProof {
                        pid = window.Current.ProcessId, hwnd = handle.ToInt64(), lastInputTick = InputTick(), checkedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    };
                    Thread.Sleep(100);
                } while (timer.ElapsedMilliseconds < 6000);
                throw new Exception("DESKTOP_NEUTRAL_ROUTE_NOT_VERIFIED");
            } finally { protectedInputTick = null; gate.ReleaseMutex(); }
        }
    }
    static bool VerifyRouteTransition(ArchiveNeutralProof proof) {
        if (proof == null) return false;
        long age = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - proof.checkedAt;
        if (age < 0 || age > 15000 || proof.hwnd != handle.ToInt64() || proof.pid != window.Current.ProcessId
            || proof.lastInputTick != InputTick()) throw new Exception("DESKTOP_TRANSITION_PROOF_EXPIRED_OR_CHANGED");
        protectedInputTick = proof.lastInputTick; Check(); return true;
    }
    static void OpenHeaderActions() {
        InvokeArchive(WaitOne(ControlType.Button, new [] { "聊天操作", "Chat actions" }, 7000));
    }
    static bool ClipboardBusy(ExternalException error) { return error.HResult == unchecked((int)0x800401D0); }
    static T ReadClipboardWithRetry<T>(Func<T> read, string stage) {
        var timer = Stopwatch.StartNew();
        while (true) {
            try { return read(); }
            catch (ExternalException error) {
                if (!ClipboardBusy(error) || timer.ElapsedMilliseconds >= 1200) throw new ExternalException("DESKTOP_CLIPBOARD_" + stage.ToUpperInvariant(), error.HResult);
                Thread.Sleep(60);
            }
        }
    }
    static void WriteClipboardWithRetry(Action write) {
        ReadClipboardWithRetry(() => { write(); return true; }, "marker");
    }
    static string ClipboardHolderKind() {
        IntPtr owner = GetOpenClipboardWindow(); if (owner == IntPtr.Zero) return "none";
        uint ownerPid, codexPid; GetWindowThreadProcessId(owner, out ownerPid); GetWindowThreadProcessId(handle, out codexPid);
        return ownerPid == (uint)Process.GetCurrentProcess().Id ? "helper" : ownerPid == codexPid ? "codex" : "other";
    }
    static string ReadCopiedUnicodeText() {
        // Fresh app links are plain CF_UNICODETEXT. Reading that handle avoids
        // OLE delayed-render data objects and the STA proxy used by GetText.
        var timer = Stopwatch.StartNew();
        while (!OpenClipboard(IntPtr.Zero)) {
            Check(); Application.DoEvents(); Check();
            if (timer.ElapsedMilliseconds >= 1200) throw new ExternalException("DESKTOP_CLIPBOARD_READ_WIN32: holder=" + ClipboardHolderKind(), unchecked((int)0x800401D0));
            Thread.Sleep(60);
        }
        try {
            IntPtr data = GetClipboardData(13); if (data == IntPtr.Zero) return null;
            ulong length = GlobalSize(data).ToUInt64();
            // Identity links and the fresh marker are small. Never fetch a
            // large or non-text clipboard payload as part of verification.
            if (length == 0 || length > 32768 || length % 2 != 0) return null;
            IntPtr value = GlobalLock(data); if (value == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(value, (int)(length / 2)).TrimEnd('\0'); }
            finally { GlobalUnlock(data); }
        } finally { CloseClipboard(); }
    }
    static DataObject SnapshotClipboard(out bool hadData) {
        var timer = Stopwatch.StartNew();
        do {
            uint before = GetClipboardSequenceNumber(); bool nonempty = false;
            var snapshot = ReadClipboardWithRetry(() => {
                var existing = Clipboard.GetDataObject(); var copy = new DataObject();
                if (existing != null) foreach (var format in existing.GetFormats(false)) {
                    object value = existing.GetData(format, false);
                    if (value == null) continue;
                    // Clipboard providers may return delayed-render streams or
                    // GDI handles that stop being valid when replaced. Own the
                    // materialized bytes/bitmap before writing our marker.
                    var stream = value as Stream;
                    if (stream != null) {
                        long position = stream.CanSeek ? stream.Position : 0;
                        var bytes = new MemoryStream();
                        try { if (stream.CanSeek) stream.Position = 0; stream.CopyTo(bytes); }
                        finally { if (stream.CanSeek) stream.Position = position; }
                        bytes.Position = 0; value = bytes;
                    } else if (value is System.Drawing.Image) value = ((System.Drawing.Image)value).Clone();
                    else if (value is Array) value = ((Array)value).Clone();
                    copy.SetData(format, false, value); nonempty = true;
                }
                return copy;
            }, "capture");
            if (before == GetClipboardSequenceNumber()) { hadData = nonempty; return snapshot; }
        } while (timer.ElapsedMilliseconds < 1200);
        throw new Exception("DESKTOP_CLIPBOARD_CHANGED: Clipboard changed while preserving its original contents.");
    }
    static string RestoreOwnedClipboard(DataObject original, bool hadData, uint ownedSequence) {
        var timer = Stopwatch.StartNew();
        do {
            // Another app or the user may have copied something meanwhile.
            // Never replace that new content with our earlier snapshot.
            if (GetClipboardSequenceNumber() != ownedSequence) return "superseded";
            try {
                if (hadData) Clipboard.SetDataObject(original, false, 0, 0); else Clipboard.Clear();
                break;
            } catch (ExternalException error) {
                if (!ClipboardBusy(error) || timer.ElapsedMilliseconds >= 1200) throw new ExternalException("DESKTOP_CLIPBOARD_RESTORE_SET", error.HResult);
                Thread.Sleep(60);
            }
        } while (true);
        if (!hadData) return "restored";
        timer.Restart();
        do {
            // Do not set the object again if persistence alone is temporarily
            // blocked, and never flush someone else's newly copied content.
            if (OleIsCurrentClipboard((System.Runtime.InteropServices.ComTypes.IDataObject)original) != 0) return "superseded";
            int result = OleFlushClipboard();
            if (result >= 0) return "restored";
            if (result != unchecked((int)0x800401D0) || timer.ElapsedMilliseconds >= 1200) throw new ExternalException("DESKTOP_CLIPBOARD_RESTORE_FLUSH", result);
            Thread.Sleep(60);
        } while (true);
    }
    static void VerifyCopiedThreadLink(string threadId, Action copyAction) {
        bool hadData; var original = SnapshotClipboard(out hadData);
        string copied = null;
        string marker = "shared-agent-workspace-verifying-" + Guid.NewGuid().ToString();
        uint ownedSequence = 0; bool ownsClipboard = false;
        copiedMarkerUnchanged = false; copyContainsExpectedId = false; copyHasExpectedPath = false;
        try {
            // A previously copied matching link must not make a failed menu
            // invocation look like fresh proof of the selected conversation.
            WriteClipboardWithRetry(() => Clipboard.SetDataObject(new DataObject(DataFormats.UnicodeText, marker), true, 0, 0));
            ownedSequence = GetClipboardSequenceNumber(); ownsClipboard = true;
            copyAction();
            var timer = Stopwatch.StartNew();
            do {
                Application.DoEvents(); Thread.Sleep(100); Application.DoEvents(); Check(); uint before = GetClipboardSequenceNumber();
                copied = ReadCopiedUnicodeText();
                uint after = GetClipboardSequenceNumber();
                if (before != after) { copied = null; continue; }
                Uri expected;
                if (copied == marker || Uri.TryCreate(copied, UriKind.Absolute, out expected) && expected.Scheme == "codex" && expected.Host == "threads" && expected.AbsolutePath.TrimEnd('/') == "/" + threadId) ownedSequence = after;
            }
            while ((copied == null || !copied.Contains(threadId)) && timer.ElapsedMilliseconds < 2000);
            copiedMarkerUnchanged = copied == marker;
            copyContainsExpectedId = copied != null && copied.Contains(threadId);
            Uri link;
            copyHasExpectedPath = Uri.TryCreate(copied, UriKind.Absolute, out link) && link.AbsolutePath.TrimEnd('/') == "/" + threadId;
            if (!Uri.TryCreate(copied, UriKind.Absolute, out link) || link.Scheme != "codex" || link.Host != "threads" ||
                link.AbsolutePath.TrimEnd('/') != "/" + threadId || !String.IsNullOrEmpty(link.Fragment) ||
                (!String.IsNullOrEmpty(link.Query) && link.Query != "?hostId=local")) throw new Exception("DESKTOP_ID_MISMATCH: Copied chat differs from requested local UUID.");
        } finally {
            if (ownsClipboard) try {
                string restored = RestoreOwnedClipboard(original, hadData, ownedSequence);
                if (LastClipboardRestoreStatus != "failed") LastClipboardRestoreStatus = restored;
            } catch (Exception error) {
                // Cleanup must not erase the real identity result or replace a
                // prior UI failure. Report its separate status to the caller.
                LastClipboardRestoreStatus = "failed";
                LastClipboardRestoreError = ExceptionKind(error) + ":" + error.Message;
            }
        }
    }
    static void ClickCopyDeeplink() {
        // Electron's clipboard write is synchronous. Calling that handler
        // through UIA Invoke can leave its lock waiting on this STA. Only this
        // read-only copy action uses the dedicated hit-tested physical click.
        ClickArchiveControl(WaitOne(ControlType.MenuItem, new [] { "复制深度链接", "Copy deep link", "Copy app link", "Copy deeplink" }, 3000));
    }
    static void CopyRowDeeplink() {
        // The official shared menu builder returns a direct copy-link item
        // when it has one action, or a Copy submenu when it has several.
        var timer = Stopwatch.StartNew();
        do {
            Check();
            var direct = Find(window, ControlType.MenuItem, "复制深度链接", "Copy deep link", "Copy app link", "Copy deeplink").Where(e => !e.Current.IsOffscreen).ToArray();
            if (direct.Length > 0) { ClickArchiveControl(One(direct, "row copy deeplink")); return; }
            var submenu = Find(window, ControlType.MenuItem, "复制", "Copy").Where(e => !e.Current.IsOffscreen).ToArray();
            if (submenu.Length > 0) { Invoke(One(submenu, "row copy submenu")); ClickCopyDeeplink(); return; }
            Thread.Sleep(100);
        } while (timer.ElapsedMilliseconds < 3000);
        throw new Exception("DESKTOP_ROW_COPY_NOT_FOUND");
    }
    static string DeleteMenuDiagnostics() {
        // Only counts for known static controls; never arbitrary menu labels
        // or chat names. Used before dismissing a failed context menu.
        try {
            Func<string[], int> count = labels => Find(window, null, labels).Count(e => !e.Current.IsOffscreen);
            return "deleteMenu={copy:" + count(new [] { "复制", "Copy" })
                + ",copyDeeplink:" + count(new [] { "复制深度链接", "Copy deep link", "Copy app link", "Copy deeplink" })
                + ",delete:" + count(new [] { "永久删除", "Permanently delete", "删除", "Delete" })
                + ",archive:" + count(new [] { "归档", "Archive", "归档聊天", "Archive chat" })
                + ",menuItems:" + Find(window, ControlType.MenuItem).Count(e => !e.Current.IsOffscreen) + "}";
        } catch { return "deleteMenu={unavailable:true}"; }
    }
    static void VerifyCurrentThreadLink(string threadId) {
        VerifyCopiedThreadLink(threadId, () => {
            var headers = Find(window, ControlType.Button, "聊天操作", "Chat actions").Where(e => !e.Current.IsOffscreen).ToArray();
            if (headers.Length > 0) {
                InvokeArchive(One(headers, "current chat actions"));
                InvokeArchive(WaitOne(ControlType.MenuItem, new [] { "复制", "Copy" }, 3000));
                ClickCopyDeeplink();
            } else {
                // Official command registry: copyDeeplink => CmdOrCtrl+Alt+L.
                Check(); SendKeys.SendWait("^%l");
            }
        });
    }
    static string ExceptionKind(Exception error) {
        return error.GetType().Name + ":0x" + error.HResult.ToString("X8");
    }
    static void VerifyRestoredThreadLink(string threadId, int expectedPid) {
        // The restore can replace Chromium's accessibility document while the
        // native top-level window stays alive. Refresh only that same window's
        // read handle and retry exact-link verification, never the restore.
        var timer = Stopwatch.StartNew(); string lastTransient = "none";
        do {
            Check();
            try {
                var refreshed = AutomationElement.FromHandle(handle);
                if (refreshed == null || refreshed.Current.ProcessId != expectedPid) throw new Exception("DESKTOP_FOCUS_CHANGED: Restored window identity changed.");
                window = refreshed;
                if (!Find(window, ControlType.Button, "聊天操作", "Chat actions").Any(e => !e.Current.IsOffscreen)) {
                    Thread.Sleep(150); continue;
                }
                VerifyCurrentThreadLink(threadId); return;
            } catch (ElementNotAvailableException error) {
                lastTransient = ExceptionKind(error);
            } catch (COMException error) {
                lastTransient = ExceptionKind(error);
            }
            // Closing a partially opened copy menu is read-only; all identity,
            // focus and cancellation errors remain fatal instead of retrying.
            Check(); SendKeys.SendWait("{ESC}"); Thread.Sleep(150);
        } while (timer.ElapsedMilliseconds < 13000);
        throw new Exception("DESKTOP_RESTORED_IDENTITY_NOT_READY: " + lastTransient);
    }
    static string SanitizedRoutePath(string value) {
        var allowed = new [] { "local", "threads", "settings", "general-settings", "archived-chats", "archive", "index.html", "index.htm", "home", "webview", "app", "remote" };
        string path = (value ?? "").Split('?')[0].TrimStart('#');
        return String.Join("/", path.Split('/').Take(16).Select(part => part == "" ? "" : allowed.Contains(part) ? part
            : Regex.IsMatch(part, @"^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", RegexOptions.IgnoreCase) ? "<id>" : "<other>"));
    }
    static void RejectUnsafeArchiveDialog() {
        var dangerous = Find(window, ControlType.Text,
            "停止并归档此聊天？", "Stop and archive this chat?",
            "归档聊天并移除已安排的任务？", "Archive chat and remove scheduled task?").Where(e => !e.Current.IsOffscreen).ToArray();
        if (dangerous.Length > 0) {
            var cancel = Find(window, ControlType.Button, "取消", "Cancel").Where(e => !e.Current.IsOffscreen).ToArray();
            if (cancel.Length == 1) InvokeArchive(cancel[0]);
            throw new Exception("DESKTOP_ARCHIVE_UNSAFE_SIDE_EFFECT: Running or scheduled work will not be stopped or removed.");
        }
    }
    static AutomationElement RestoreControl(string name) {
        // Both official layouts are reached through the exact UUID deep link.
        // The caller already verified that UUID from the header's copied link.
        // Never use a generic Unarchive button elsewhere in the window.
        var timer = Stopwatch.StartNew();
        do {
            Check();
            if (Find(window, ControlType.Text, "此聊天已归档。要继续，请先取消归档。", "This chat is archived. To continue, unarchive it first").Any(e => !e.Current.IsOffscreen))
                return WaitOne(ControlType.Button, new [] { "取消归档", "Unarchive" }, 4000);
            if (Find(window, ControlType.Text, "此聊天已归档", "This chat is archived").Any(e => !e.Current.IsOffscreen)
                && Find(window, ControlType.Text, "取消归档此聊天后即可打开", "Unarchive this chat to open it").Any(e => !e.Current.IsOffscreen))
                return WaitOne(ControlType.Button, new [] { "取消归档并打开", "Unarchive and open" }, 4000);
            Thread.Sleep(100);
        } while (timer.ElapsedMilliseconds < 5000);
        throw new Exception("DESKTOP_ARCHIVE_PREVIEW_NOT_FOUND");
    }
    static string ArchiveDiagnostics(string name, string threadId) {
        // Report only bounded, preselected state booleans/counts. Never emit an
        // accessibility tree, other titles, clipboard contents, or chat text.
        try {
            Func<ControlType, string[], int> count = (type, labels) => Find(window, type, labels).Count(e => !e.Current.IsOffscreen);
            bool documentValueAvailable = false, routeIdMatches = false, documentContainsExpectedId = false, fragmentHasExpectedPath = false;
            var routeKinds = new List<string>();
            foreach (var doc in Find(window, ControlType.Document).Where(e => !e.Current.IsOffscreen).Take(8)) {
                object value;
                if (doc.TryGetCurrentPattern(ValuePattern.Pattern, out value)) {
                    documentValueAvailable = true;
                    string raw = ((ValuePattern)value).Current.Value;
                    documentContainsExpectedId |= raw != null && raw.Contains(threadId);
                    Uri route;
                    if (Uri.TryCreate(raw, UriKind.Absolute, out route)) {
                        routeIdMatches |= route.Scheme == "app" && route.AbsolutePath == "/local/" + threadId
                            || route.Scheme == "codex" && route.Host == "threads" && route.AbsolutePath == "/" + threadId;
                        var fragmentPath = route.Fragment.TrimStart('#').Split('?')[0];
                        fragmentHasExpectedPath |= fragmentPath == "/local/" + threadId || fragmentPath == "/threads/" + threadId;
                        string scheme = new [] { "app", "codex", "file", "http", "https", "about" }.Contains(route.Scheme) ? route.Scheme : "other";
                        routeKinds.Add(scheme + ":" + SanitizedRoutePath(route.AbsolutePath) + "#" + SanitizedRoutePath(route.Fragment));
                    } else routeKinds.Add("non-uri");
                }
            }
            return "archiveState={documentValueAvailable:" + (documentValueAvailable ? "true" : "false") + ",routeIdMatches:" + (routeIdMatches ? "true" : "false")
                + ",documentContainsExpectedId:" + (documentContainsExpectedId ? "true" : "false") + ",fragmentHasExpectedPath:" + (fragmentHasExpectedPath ? "true" : "false")
                + ",documentRouteKinds:" + String.Join("|", routeKinds.Distinct().Take(3))
                + ",copiedMarkerUnchanged:" + (copiedMarkerUnchanged ? "true" : "false") + ",copyContainsExpectedId:" + (copyContainsExpectedId ? "true" : "false") + ",copyHasExpectedPath:" + (copyHasExpectedPath ? "true" : "false")
                + ",archivedNotice:" + (count(ControlType.Text, new [] { "此聊天已归档", "This chat is archived", "此聊天已归档。要继续，请先取消归档。", "This chat is archived. To continue, unarchive it first" }) > 0 ? "true" : "false")
                + ",unarchiveButton:" + (count(ControlType.Button, new [] { "取消归档", "Unarchive", "取消归档并打开", "Unarchive and open" }) > 0 ? "true" : "false")
                + ",unarchiveButtonDisabled:" + (Find(window, ControlType.Button, "取消归档", "Unarchive", "取消归档并打开", "Unarchive and open").Any(e => !e.Current.IsOffscreen && !e.Current.IsEnabled) ? "true" : "false")
                + ",unarchiveError:" + (count(null, new [] { "无法为此聊天取消归档", "Could not unarchive this chat" }) > 0 ? "true" : "false")
                + ",resumeError:" + (count(ControlType.Text, new [] { "继续聊天未成功", "Could not resume chat", "Could not open archived chat", "无法打开已归档的聊天" }) > 0 ? "true" : "false")
                + ",settingsLabel:" + (count(ControlType.Text, new [] { "设置", "Settings", "通用", "General" }) > 0 ? "true" : "false")
                + ",archiveLabel:" + (count(ControlType.Text, new [] { "归档", "Archive", "已归档的聊天", "Archived chats" }) > 0 ? "true" : "false")
                + ",targetTitlePresent:" + (count(ControlType.Text, new [] { name }) > 0 || count(ControlType.Button, new [] { name }) > 0 ? "true" : "false")
                + ",chatActionsCount:" + count(ControlType.Button, new [] { "聊天操作", "Chat actions" }) + "}";
        } catch { return "archiveState={unavailable:true}"; }
    }
    public static string RunArchive(string operation, string name, string threadId, bool archived, ArchiveNeutralProof proof) {
        Guid parsed;
        if (!Guid.TryParse(threadId, out parsed) || String.IsNullOrWhiteSpace(name) ||
            (operation != "archiveThread" && operation != "unarchiveThread" && operation != "verifyThreadArchive")) throw new Exception("DESKTOP_INVALID_ARCHIVE_REQUEST");
        using (var gate = new Mutex(false, "Local\\SharedAgentWorkspace-CodexMenu")) {
            bool entered; try { entered = gate.WaitOne(0); } catch (AbandonedMutexException) { entered = true; }
            if (!entered) throw new Exception("DESKTOP_BUSY");
            try {
                protectedInputTick = null; LastArchiveIdentityMethod = "copied-deeplink";
                LastClipboardRestoreStatus = "not-used"; LastClipboardRestoreError = null;
                AttachArchive(); phase = "ARCHIVE_IDENTITY";
                int archiveWindowPid = window.Current.ProcessId;
                // Stale modal state is never approved as part of a new request.
                var cancel = Find(window, ControlType.Button, "取消", "Cancel").Where(e => !e.Current.IsOffscreen).ToArray();
                if (Find(window, ControlType.Text, "归档对话？", "Archive chat?", "要删除聊天吗？", "Delete chat?").Any(e => !e.Current.IsOffscreen)) {
                    InvokeArchive(One(cancel, "cancel stale confirmation")); Thread.Sleep(150);
                }
                bool routeTransition = operation == "unarchiveThread" && proof != null &&
                    !Find(window, ControlType.Button, "聊天操作", "Chat actions").Any(e => !e.Current.IsOffscreen);
                if (routeTransition) {
                    VerifyRouteTransition(proof);
                    RestoreControl(name); // An official archived placeholder must now replace the verified neutral page.
                    LastArchiveIdentityMethod = "neutral-route-transition-and-final-copied-deeplink";
                } else VerifyCurrentThreadLink(threadId);
                if (operation == "verifyThreadArchive") {
                    if (archived) {
                        // The archive-specific restore control and preview UUID
                        // jointly prove that the requested entry is archived.
                        RestoreControl(name);
                        return "archived";
                    }
                    OpenHeaderActions(); WaitOne(ControlType.MenuItem, new [] { "归档聊天", "Archive chat", "归档", "Archive" }, 4000);
                    Check(); SendKeys.SendWait("{ESC}"); return "unarchived";
                }
                if (operation == "unarchiveThread") {
                    phase = "UNARCHIVE";
                    if (Find(window, ControlType.Text, "此聊天已归档", "This chat is archived", "此聊天已归档。要继续，请先取消归档。", "This chat is archived. To continue, unarchive it first").Any(e => !e.Current.IsOffscreen))
                        InvokeArchive(RestoreControl(name));
                    else {
                        // A prior retry may already have restored the desktop.
                        // Exact copied UUID plus its archive menu proves active.
                        OpenHeaderActions(); WaitOne(ControlType.MenuItem, new [] { "归档聊天", "Archive chat", "归档", "Archive" }, 4000);
                        Check(); SendKeys.SendWait("{ESC}");
                    }
                    protectedInputTick = null;
                    // The transition allows only the reversible official restore.
                    // Completion still requires a fresh exact-UUID active header.
                    phase = "RESTORED_IDENTITY";
                    VerifyRestoredThreadLink(threadId, archiveWindowPid);
                    return "unarchived";
                }
                phase = "ARCHIVE"; OpenHeaderActions();
                InvokeArchive(WaitOne(ControlType.MenuItem, new [] { "归档聊天", "Archive chat", "归档", "Archive" }, 4000));
                Thread.Sleep(250);
                var timer = Stopwatch.StartNew(); bool readStablePage = false;
                AutomationElement archiveConfirmation = null;
                do {
                    Check();
                    try {
                        var refreshed = AutomationElement.FromHandle(handle);
                        if (refreshed == null || refreshed.Current.ProcessId != archiveWindowPid) throw new Exception("DESKTOP_FOCUS_CHANGED: Archived window identity changed.");
                        window = refreshed;
                        RejectUnsafeArchiveDialog();
                        if (Find(window, ControlType.Text, "归档对话？", "Archive chat?").Any(e => !e.Current.IsOffscreen))
                            archiveConfirmation = WaitOne(ControlType.Button, new [] { "归档", "Archive" }, 1500);
                        readStablePage = true;
                    } catch (ElementNotAvailableException) { readStablePage = false; }
                    catch (COMException) { readStablePage = false; }
                    if (archiveConfirmation != null || readStablePage && timer.ElapsedMilliseconds >= 1200) break;
                    Thread.Sleep(100);
                } while (timer.ElapsedMilliseconds < 3000);
                if (!readStablePage) throw new Exception("DESKTOP_ARCHIVE_POST_ACTION_NOT_READY");
                // Only the read-only page inspection above is retried. Neither
                // the archive menu action nor this confirmation is replayed.
                if (archiveConfirmation != null) InvokeArchive(archiveConfirmation);
                return "archived"; // Caller must still verify both persisted stores.
            } catch (Exception error) {
                try { if (GetForegroundWindow() == handle && (GetAsyncKeyState(27) & 0x8000) == 0) SendKeys.SendWait("{ESC}"); } catch { }
                throw new Exception("DESKTOP_STEP_" + phase + ": " + ExceptionKind(error) + ": " + error.Message + "; " + ArchiveDiagnostics(name, threadId));
            } finally { protectedInputTick = null; gate.ReleaseMutex(); }
        }
    }
    public static string Run(string operation, string name, string threadId) {
        using (var gate = new Mutex(false, "Local\\SharedAgentWorkspace-CodexMenu")) {
        bool entered;
        try { entered = gate.WaitOne(0); } catch (AbandonedMutexException) { entered = true; }
        if (!entered) throw new Exception("DESKTOP_BUSY: Another workspace is managing the Codex menu.");
        try { return RunCore(operation, name, threadId); }
        catch (Exception error) {
            string diagnostic = DeleteMenuDiagnostics();
            // Dismiss only this foreground app's transient menus after a failed
            // step; never send keys after user focus changed or Escape was held.
            try { if (GetForegroundWindow() == handle && (GetAsyncKeyState(27) & 0x8000) == 0) {
                if (Find(window, ControlType.MenuItem, "永久删除", "Permanently delete", "移除项目", "Remove project").Any(e => !e.Current.IsOffscreen)) {
                    SendKeys.SendWait("{ESC}"); SendKeys.SendWait("{ESC}");
                }
            } } catch { }
            throw new Exception("DESKTOP_STEP_" + phase + ": " + error.GetType().Name + ": " + error.Message + "; " + diagnostic);
        }
        finally { gate.ReleaseMutex(); }
        }
    }
    static string RunCore(string operation, string name, string threadId) {
        if (operation != "removeProject" && operation != "deleteThread") throw new Exception("Unsupported desktop operation");
        if (String.IsNullOrWhiteSpace(name)) throw new Exception("Missing target name");
        phase = "ATTACH"; protectedInputTick = null;
        LastClipboardRestoreStatus = "not-used"; LastClipboardRestoreError = null;
        AttachArchive();
        if (Find(window, ControlType.Text, "要删除聊天吗？", "Delete chat?").Any(e => !e.Current.IsOffscreen)) {
            // A retry cannot trust a leftover confirmation. Cancel it, then
            // obtain the row link and validate the identifier again from scratch.
            Invoke(One(Find(window, ControlType.Button, "取消", "Cancel"), "cancel previous confirmation"));
            Thread.Sleep(250);
        }
        if (Find(window, ControlType.MenuItem, "永久删除", "Permanently delete", "移除项目", "Remove project").Any(e => !e.Current.IsOffscreen)) {
            SendKeys.SendWait("{ESC}"); SendKeys.SendWait("{ESC}"); Thread.Sleep(150);
        }
        var sidebar = Sidebar();
        var target = One(Find(sidebar, ControlType.Button, name), "exact target " + name);
        if (operation != "deleteThread") { phase = "CONTEXT"; ContextMenu(target); }
        if (operation == "deleteThread") {
            Guid parsed;
            if (!Guid.TryParse(threadId, out parsed)) throw new Exception("Invalid thread identifier");
            // Verify the actual row's official deep link, not just its display
            // name. Clipboard content stays local and is never logged.
            phase = "CLIPBOARD_SNAPSHOT";
            VerifyCopiedThreadLink(threadId, () => {
                // This is still the verified sidebar row's context menu. Do
                // not substitute the currently open conversation's header.
                // Set the fresh clipboard marker first, then open the menu so
                // clipboard ownership changes cannot dismiss its popup.
                target = One(Find(Sidebar(), ControlType.Button, name), "copy target " + name);
                phase = "CONTEXT"; ContextMenu(target);
                phase = "COPY_MENU"; CopyRowDeeplink();
            });
            target = One(Find(Sidebar(), ControlType.Button, name), "verified target " + name);
            phase = "VERIFIED_CONTEXT"; ContextMenu(target);
        }
        var menuNames = operation == "removeProject" ? new [] { "移除项目", "Remove project" } : new [] { "永久删除", "Permanently delete" };
        phase = "DELETE_MENU"; Invoke(WaitOne(ControlType.MenuItem, menuNames, 4000));
        var headingNames = operation == "removeProject" ? new [] { "移除 " + name + "？", "移除 " + name + "?", "Remove " + name + "?" } : new [] { "要删除聊天吗？", "删除聊天？", "删除聊天?", "Delete chat?" };
        phase = "CONFIRM_HEADING"; WaitOne(ControlType.Text, headingNames, 5000);
        // The modal heading and the unique confirm button are checked afresh.
        var confirm = operation == "removeProject" ? new [] { "移除项目", "Remove project" } : new [] { "删除", "Delete" };
        phase = "CONFIRM"; Invoke(WaitOne(ControlType.Button, confirm, 2000));
        var clock = Stopwatch.StartNew();
        do {
            Check();
            if (Find(window, ControlType.Button, confirm).Length == 0) {
                try { if (!HasSidebarName(name)) return "removed"; }
                catch (ElementNotAvailableException) { }
                catch (Exception error) { if (!error.Message.Contains("Codex sidebar matched 0 controls")) throw; }
            }
            Thread.Sleep(200);
        } while (clock.ElapsedMilliseconds < 12000);
        throw new Exception("DESKTOP_VERIFICATION_PENDING: The target or its confirmation is still present.");
    }
}
