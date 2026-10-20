// Workbench runtime adapter. Invokes the installed Claude app's own menu.
// It never edits desktop caches, injects renderer code, or removes project files.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

public static class WorkspaceClaudeMenu {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    static IntPtr handle;
    static AutomationElement window;
    static string desktopId;
    public static string LastStage = "not-started";
    static void Check() {
        if ((GetAsyncKeyState(27) & 0x8000) != 0) throw new Exception("CLAUDE_CANCELLED");
        if (GetForegroundWindow() != handle) throw new Exception("CLAUDE_FOCUS_CHANGED");
    }
    static AutomationElement[] Find(AutomationElement root, ControlType type, params string[] names) {
        return root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, type))
            .Cast<AutomationElement>().Where(e => !e.Current.IsOffscreen && (names.Length == 0 || names.Contains(e.Current.Name))).ToArray();
    }
    static AutomationElement One(AutomationElement[] values, string label) {
        if (values.Length != 1) throw new Exception("CLAUDE_AMBIGUOUS_" + label + ":" + values.Length);
        return values[0];
    }
    static string Url(AutomationElement element) {
        object value = element.GetCurrentPropertyValue(ValuePattern.ValueProperty, true);
        return value == AutomationElement.NotSupported ? "" : value as string ?? "";
    }
    static AutomationElement Document(bool optional = false) {
        Check();
        var docs = Find(window, ControlType.Document).Where(e => {
            Uri uri;
            return Uri.TryCreate(Url(e), UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "claude.ai"
                && uri.AbsolutePath.TrimEnd('/') == "/epitaxy/" + desktopId;
        }).ToArray();
        return optional ? OptionalOne(docs, "SESSION_ID") : One(docs, "SESSION_ID");
    }
    static void Invoke(AutomationElement e) {
        Check(); if (!e.Current.IsEnabled) throw new Exception("CLAUDE_DISABLED");
        object pattern;
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { ((InvokePattern)pattern).Invoke(); return; }
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { ((ExpandCollapsePattern)pattern).Expand(); return; }
        // Chromium menu buttons may expose no InvokePattern. Resolve the live
        // accessible element's clickable point, and prove it still hits that
        // same element before sending the single mouse click.
        System.Windows.Point point;
        if (e.Current.IsOffscreen || !e.TryGetClickablePoint(out point)) throw new Exception("CLAUDE_NOT_CLICKABLE");
        var hit = AutomationElement.FromPoint(point); bool matched = false;
        for (int i = 0; hit != null && i < 8; i++, hit = TreeWalker.RawViewWalker.GetParent(hit)) {
            if (Automation.Compare(hit, e)) { matched = true; break; }
        }
        if (!matched || (GetAsyncKeyState(1) & 0x8000) != 0) throw new Exception("CLAUDE_CLICK_TARGET_MISMATCH");
        Check(); SetCursorPos((int)point.X, (int)point.Y); Check();
        mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
    static AutomationElement Wait(Func<AutomationElement> probe, int ms) {
        var timer = Stopwatch.StartNew();
        do { Check(); try { var e = probe(); if (e != null) return e; } catch (ElementNotAvailableException) { }
            catch (COMException) { /* Chromium may replace a UIA subtree while navigating; retry reads only. */ }
            Thread.Sleep(120);
        } while (timer.ElapsedMilliseconds < ms);
        throw new Exception("CLAUDE_CONTROL_TIMEOUT:" + LastStage);
    }
    static AutomationElement OptionalOne(AutomationElement[] items, string label) {
        return items.Length == 0 ? null : One(items, label);
    }
    static AutomationElement DeleteDialog() {
        // Chromium exposes alertdialog as a Pane/Group, depending on its version.
        return OptionalOne(window.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>()
            .Where(e => !e.Current.IsOffscreen && (e.Current.Name == "删除 1 个会话？" || e.Current.Name == "Delete 1 session?" || e.Current.Name == "Delete session?")
                && Find(e, ControlType.Button, "删除", "Delete").Length == 1
                && Find(e, ControlType.Button, "取消", "Cancel").Length == 1).ToArray(), "DELETE_DIALOG");
    }
    static void Attach() {
        var candidates = new List<Process>();
        foreach (var p in Process.GetProcessesByName("claude")) {
            try { if (p.MainWindowHandle != IntPtr.Zero && p.MainModule.FileName.IndexOf(@"\WindowsApps\Claude_", StringComparison.OrdinalIgnoreCase) >= 0) candidates.Add(p); } catch { }
        }
        if (candidates.Count != 1) throw new Exception("CLAUDE_WINDOW_AMBIGUOUS");
        handle = candidates[0].MainWindowHandle; window = AutomationElement.FromHandle(handle);
        if (IsIconic(handle)) ShowWindow(handle, 9);
        SetForegroundWindow(handle); Thread.Sleep(120);
        if (GetForegroundWindow() != handle) {
            // A background workbench process may not own the last input queue.
            // Attach only while raising the requested app, then detach before
            // any menu action. Later user focus changes still abort immediately.
            uint ignored; uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
            uint currentThread = GetCurrentThreadId(); bool attached = false;
            try {
                if (foregroundThread != 0 && currentThread != foregroundThread) attached = AttachThreadInput(currentThread, foregroundThread, true);
                SetForegroundWindow(handle);
            } finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
            Thread.Sleep(150);
        }
        Check();
    }
    public static string VerifyAbsent(string id) {
        Guid parsed;
        if (!id.StartsWith("local_") || !Guid.TryParse(id.Substring(6), out parsed)) throw new Exception("CLAUDE_INVALID_TARGET");
        desktopId = id; Attach();
        Wait(() => {
            var doc = Document(true); if (doc == null) return null;
            return OptionalOne(doc.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>()
                .Where(e => !e.Current.IsOffscreen && (e.Current.Name == "找不到此会话" || e.Current.Name == "Session not found" || e.Current.Name == "Session Not Found"))
                .ToArray(), "NOT_FOUND");
        }, 7000);
        Document(); return "absent";
    }
    static AutomationElement Header(string title) {
        return Header(Document(), title);
    }
    static AutomationElement Header(AutomationElement doc, string title) {
        return OptionalOne(Find(doc, ControlType.Button, title + "，重命名会话", title + ", Rename session", title + ", rename session"), "HEADER");
    }
    static AutomationElement ArchivedState(string title) {
        var doc = Document(true); if (doc == null || Header(doc, title) == null) return null;
        var restore = OptionalOne(Find(doc, ControlType.Button, "取消归档", "Unarchive"), "UNARCHIVE");
        var notes = doc.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>()
            .Where(e => !e.Current.IsOffscreen && (e.Current.Name == "此会话已归档。取消归档后即可在此会话中继续工作。"
                || e.Current.Name == "This session is archived. Unarchive to continue working in this session.")).ToArray();
        return restore != null && notes.Length > 0 ? restore : null;
    }
    static AutomationElement UnarchivedState(string title) {
        var doc = Document(true); if (doc == null || Header(doc, title) == null) return null;
        if (Find(doc, ControlType.Button, "取消归档", "Unarchive").Length > 0) return null;
        return OptionalOne(Find(doc, ControlType.Edit, "提示词", "Prompt").Where(e => e.Current.IsEnabled).ToArray(), "PROMPT");
    }
    public static string ArchiveCurrent(string id, string title, string operation) {
        Guid parsed;
        if (!id.StartsWith("local_") || !Guid.TryParse(id.Substring(6), out parsed) || String.IsNullOrWhiteSpace(title)
            || !new[] { "archiveCurrent", "unarchiveCurrent", "verifyArchived", "verifyUnarchived" }.Contains(operation)) throw new Exception("CLAUDE_INVALID_TARGET");
        desktopId = id;
        using (var gate = new Mutex(false, "Local\\SharedAgentWorkspace-ClaudeMenu")) {
            bool entered; try { entered = gate.WaitOne(0); } catch (AbandonedMutexException) { entered = true; }
            if (!entered) throw new Exception("CLAUDE_BUSY");
            try {
                LastStage = "attach"; Attach(); LastStage = "document"; Wait(() => Document(true), 7000);
                LastStage = "header"; Wait(() => Header(title), 5000);
                if (DeleteDialog() != null) throw new Exception("CLAUDE_PENDING_DELETE_CONFIRMATION");
                if (operation == "verifyArchived") { LastStage = "verify-archived"; Wait(() => ArchivedState(title), 8000); Document(); return "archived"; }
                if (operation == "verifyUnarchived") { LastStage = "verify-unarchived"; Wait(() => UnarchivedState(title), 8000); Document(); return "unarchived"; }
                if (operation == "unarchiveCurrent") {
                    LastStage = "find-restore";
                    var restore = Wait(() => ArchivedState(title), 8000);
                    Document(); LastStage = "invoke-restore"; Invoke(restore);
                    LastStage = "restore-readback"; Wait(() => UnarchivedState(title), 8000); Document(); return "unarchived";
                }
                LastStage = "find-active-prompt"; Wait(() => UnarchivedState(title), 8000);
                var header = TreeWalker.ControlViewWalker.GetParent(Header(title));
                var more = One(Find(header, ControlType.Button, title + " 的更多选项", "More options for " + title), "MORE");
                Document(); LastStage = "open-menu"; Invoke(more);
                LastStage = "find-menu";
                var menu = Wait(() => OptionalOne(Find(Document(), ControlType.Menu, title + " 的更多选项", "More options for " + title), "MENU"), 3500);
                Document(); LastStage = "invoke-archive"; Invoke(One(Find(menu, ControlType.MenuItem, "归档", "Archive"), "ARCHIVE_MENU"));
                LastStage = "archive-readback";
                var timer = Stopwatch.StartNew();
                do {
                    Check();
                    try {
                        var doc = Document(true);
                        // This app navigates home after its official archive action.
                        // The caller additionally verifies persisted exact-ID state.
                        if (doc == null || ArchivedState(title) != null) return "archived";
                    } catch (ElementNotAvailableException) { }
                    catch (COMException) { /* Only retry post-action reads; never click Archive twice. */ }
                    Thread.Sleep(150);
                } while (timer.ElapsedMilliseconds < 10000);
                throw new Exception("CLAUDE_ARCHIVE_VERIFY_PENDING");
            } finally { gate.ReleaseMutex(); }
        }
    }
    public static string DeleteCurrent(string id, string title) {
        Guid parsed;
        if (!id.StartsWith("local_") || !Guid.TryParse(id.Substring(6), out parsed) || String.IsNullOrWhiteSpace(title)) throw new Exception("CLAUDE_INVALID_TARGET");
        desktopId = id;
        using (var gate = new Mutex(false, "Local\\SharedAgentWorkspace-ClaudeMenu")) {
            bool entered; try { entered = gate.WaitOne(0); } catch (AbandonedMutexException) { entered = true; }
            if (!entered) throw new Exception("CLAUDE_BUSY");
            try {
                Attach();
                Wait(() => Document(true), 7000);
                // A stale confirmation is never used as permission to delete.
                var dialog = DeleteDialog();
                if (dialog != null) { Invoke(One(Find(dialog, ControlType.Button, "取消", "Cancel"), "CANCEL")); Thread.Sleep(200); }
                var doc = Document();
                var rename = Wait(() => OptionalOne(Find(Document(), ControlType.Button, title + "，重命名会话", title + ", Rename session", title + ", rename session"), "HEADER"), 3500);
                var header = TreeWalker.ControlViewWalker.GetParent(rename);
                var more = One(Find(header, ControlType.Button, title + " 的更多选项", "More options for " + title), "MORE");
                Document(); Invoke(more);
                var menu = Wait(() => OptionalOne(Find(Document(), ControlType.Menu, title + " 的更多选项", "More options for " + title), "MENU"), 3500);
                Document(); Invoke(One(Find(menu, ControlType.MenuItem, "删除", "Delete"), "DELETE_MENU"));
                dialog = Wait(() => DeleteDialog(), 5000);
                Document();
                if (!Find(dialog, ControlType.Text).Any(e => e.Current.Name.Contains(title))) throw new Exception("CLAUDE_CONFIRM_TARGET_MISMATCH");
                // Exact URL, named header/menu, and the single-session dialog
                // all describe this same verified UUID before final invocation.
                Invoke(One(Find(dialog, ControlType.Button, "删除", "Delete"), "CONFIRM"));
                var timer = Stopwatch.StartNew();
                do { Check();
                    bool stillOpen = Find(window, ControlType.Document).Any(e => Url(e).Split('?')[0].TrimEnd('/') == "https://claude.ai/epitaxy/" + desktopId);
                    if (!stillOpen && DeleteDialog() == null) return "deleted";
                    Thread.Sleep(150);
                } while (timer.ElapsedMilliseconds < 10000);
                throw new Exception("CLAUDE_VERIFY_PENDING");
            } finally { gate.ReleaseMutex(); }
        }
    }
}
