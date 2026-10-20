using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SharedWorkspaceJobHost
{
    const uint KILL_ON_JOB_CLOSE = 0x2000, JOB_OBJECT_QUERY = 4;
    const uint CREATE_SUSPENDED = 4, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    const uint STARTF_USESTDHANDLES = 0x100, DUPLICATE_SAME_ACCESS = 2;
    const uint INFINITE = 0xffffffff;
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

    static Exception Error(string action) { return new Win32Exception(Marshal.GetLastWin32Error(), action); }
    static void ValidateName(string name) {
        if (!System.Text.RegularExpressions.Regex.IsMatch(name ?? "", @"^Local\\SharedAgentWorkspace-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) throw new ArgumentException("Invalid workspace Job name.");
    }
    public static long Probe(string name) {
        ValidateName(name);
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY, false, name);
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return -1;
            throw new Win32Exception(error, "Cannot inspect workspace Job; lifecycle is unknown.");
        }
        try {
            Accounting accounting;
            if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Error("Cannot query workspace Job; lifecycle is unknown.");
            return accounting.ActiveProcesses;
        } finally { CloseHandle(job); }
    }
    // Microsoft CRT quoting, without cmd.exe or PowerShell interpretation.
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static IntPtr InheritStandard(int kind) {
        IntPtr copy, current = GetCurrentProcess();
        if (!DuplicateHandle(current, GetStdHandle(kind), current, out copy, 0, true, DUPLICATE_SAME_ACCESS)) throw Error("Cannot duplicate CLI standard stream.");
        return copy;
    }
    sealed class JobLifetime : IDisposable {
        public readonly object Gate = new object();
        public IntPtr Handle;
        public bool Closed;
        public JobLifetime(IntPtr job) { Handle = job; }
        public void Dispose() {
            lock (Gate) {
                if (Closed) return;
                Closed = true;
                // Termination also handles a short-lived concurrent query handle.
                TerminateJobObject(Handle, 125); CloseHandle(Handle); Handle = IntPtr.Zero;
            }
        }
    }
    public static int Run(string executable, string[] args, string cwd, string name, string pipeName, string token, int startupTimeout) {
        ValidateName(name);
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        int creationError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero) throw new Win32Exception(creationError, "Cannot create workspace Job.");
        if (creationError == 183) { CloseHandle(job); throw new InvalidOperationException("Workspace Job already exists."); }
        using (JobLifetime lifetime = new JobLifetime(job)) {
            ExtendedLimits limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE; // No BREAKAWAY_OK or SILENT_BREAKAWAY_OK.
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw Error("Cannot set kill-on-close Job policy.");
            using (NamedPipeClientStream control = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
                control.Connect(startupTimeout);
                using (StreamReader reader = new StreamReader(control, new UTF8Encoding(false), false, 1024, true))
                using (StreamWriter writer = new StreamWriter(control, new UTF8Encoding(false), 1024, true)) {
                    writer.AutoFlush = true;
                    writer.WriteLine("{\"type\":\"created\",\"jobName\":\"" + name.Replace("\\", "\\\\") + "\",\"token\":\"" + token + "\"}");
                    // No process has been created before the parent authorizes it.
                    string authorization = reader.ReadLine();
                    if (authorization != "{\"type\":\"start\",\"token\":\"" + token + "\"}") throw new IOException("Workspace parent did not authorize startup.");
                    Thread watcher = new Thread(delegate() {
                        try { reader.ReadLine(); } catch { }
                        lifetime.Dispose();
                    });
                    watcher.IsBackground = true; watcher.Start();
                    ProcessInformation process = new ProcessInformation();
                    StartupInfoEx startup = new StartupInfoEx();
                    startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx)); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    IntPtr jobList = IntPtr.Zero, handleList = IntPtr.Zero;
                    bool attributesInitialized = false;
                    try {
                        startup.StartupInfo.hStdInput = InheritStandard(-10); startup.StartupInfo.hStdOutput = InheritStandard(-11); startup.StartupInfo.hStdError = InheritStandard(-12);
                        IntPtr attributeBytes = IntPtr.Zero;
                        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                        if (attributeBytes == IntPtr.Zero) throw Error("Cannot size CLI process attributes.");
                        startup.AttributeList = Marshal.AllocHGlobal(attributeBytes);
                        if (!InitializeProcThreadAttributeList(startup.AttributeList, 2, 0, ref attributeBytes)) throw Error("Cannot initialize CLI process attributes.");
                        attributesInitialized = true;
                        jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
                        // Windows 10+: assign at process creation, removing the
                        // user-mode create-then-assign suspended-orphan window.
                        // Unsupported platforms fail; there is no loose fallback.
                        if (!UpdateProcThreadAttribute(startup.AttributeList, 0, new UIntPtr(0x2000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Error("Cannot bind CLI creation to workspace Job (Windows 10 or newer is required).");
                        handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                        Marshal.WriteIntPtr(handleList, 0, startup.StartupInfo.hStdInput);
                        Marshal.WriteIntPtr(handleList, IntPtr.Size, startup.StartupInfo.hStdOutput);
                        Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, startup.StartupInfo.hStdError);
                        if (!UpdateProcThreadAttribute(startup.AttributeList, 0, new UIntPtr(0x20002), handleList, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw Error("Cannot restrict CLI inherited handles.");
                        StringBuilder command = new StringBuilder(Quote(executable));
                        foreach (string arg in args ?? new string[0]) { command.Append(' '); command.Append(Quote(arg)); }
                        lock (lifetime.Gate) {
                            if (lifetime.Closed) throw new IOException("Workspace parent disconnected before startup.");
                            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref startup, out process)) throw Error("Cannot create suspended CLI in workspace Job.");
                            bool assigned;
                            if (!IsProcessInJob(process.hProcess, lifetime.Handle, out assigned) || !assigned) {
                                Exception failure = new InvalidOperationException("Created CLI is not confirmed in workspace Job.");
                                TerminateProcess(process.hProcess, 125); throw failure;
                            }
                            if (ResumeThread(process.hThread) == 0xffffffff) throw Error("Cannot resume CLI in workspace Job.");
                        }
                        writer.WriteLine("{\"type\":\"started\",\"pid\":" + process.dwProcessId + "}");
                        if (WaitForSingleObject(process.hProcess, INFINITE) != 0) throw Error("Cannot wait for CLI.");
                        uint exitCode;
                        if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Error("Cannot read CLI exit code.");
                        return unchecked((int)exitCode);
                    } finally {
                        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                        if (attributesInitialized) DeleteProcThreadAttributeList(startup.AttributeList);
                        if (startup.AttributeList != IntPtr.Zero) Marshal.FreeHGlobal(startup.AttributeList);
                        if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                        if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                        if (startup.StartupInfo.hStdInput != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdInput);
                        if (startup.StartupInfo.hStdOutput != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdOutput);
                        if (startup.StartupInfo.hStdError != IntPtr.Zero) CloseHandle(startup.StartupInfo.hStdError);
                    }
                }
            }
        }
    }
}
