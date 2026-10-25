// Console control attributes are process-local and inherited by child
// processes. A newly integrated foreground shell must receive Ctrl+C even
// when its launcher ignored it; background console workers opt out instead.
public static class ShellSpanConsoleSignals {
    // Called only after the native key handler has acknowledged its unchanged
    // editor buffer. Native input records avoid a kernel round trip per byte.
    // Peeking first leaves every event after the private data fence untouched.
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Explicit, Size=20)]
    private struct InputRecord {
        [System.Runtime.InteropServices.FieldOffset(0)] public ushort Type;
        [System.Runtime.InteropServices.FieldOffset(4)] public int KeyDown;
        [System.Runtime.InteropServices.FieldOffset(8)] public ushort Repeat;
        [System.Runtime.InteropServices.FieldOffset(10)] public ushort VirtualKey;
        [System.Runtime.InteropServices.FieldOffset(14)] public ushort Character;
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern System.IntPtr GetStdHandle(int id);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint="PeekConsoleInputW", SetLastError=true)]
    private static extern bool PeekInput(System.IntPtr input, [System.Runtime.InteropServices.Out] InputRecord[] records, uint count, out uint read);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint="ReadConsoleInputW", SetLastError=true)]
    private static extern bool ReadInput(System.IntPtr input, [System.Runtime.InteropServices.Out] InputRecord[] records, uint count, out uint read);
    private static bool IsDataKey(InputRecord record) {
        if(record.Type!=1 || record.KeyDown==0) return false;
        if(record.Character!=0) return true;
        return !(record.VirtualKey==16 || record.VirtualKey==17 || record.VirtualKey==18 || record.VirtualKey==20 ||
            record.VirtualKey==91 || record.VirtualKey==92 || record.VirtualKey==144 || record.VirtualKey==145 ||
            (record.VirtualKey>=160 && record.VirtualKey<=165));
    }
    public static string ReadEditorData() {
        bool previousControlCAsInput = System.Console.TreatControlCAsInput;
        System.Console.TreatControlCAsInput = true;
        try { return ReadEditorDataCore(); }
        finally { System.Console.TreatControlCAsInput = previousControlCAsInput; }
    }
    private static string ReadEditorDataCore() {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var encoded = new System.Text.StringBuilder(10924);
        bool fence = false;
        bool interrupted = false;
        var input=GetStdHandle(-10);
        if(input==System.IntPtr.Zero || input==new System.IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
        var records=new InputRecord[256];
        while (clock.ElapsedMilliseconds < 2000) {
            uint available;
            if(!PeekInput(input,records,(uint)records.Length,out available)) throw new System.ComponentModel.Win32Exception();
            if(available==0) { System.Threading.Thread.Sleep(1); continue; }
            uint consume=available;
            bool previewFence=fence;
            for(uint index=0;index<available;index++) {
                if(!IsDataKey(records[index])) continue;
                if(previewFence) { consume=index+1; break; }
                if(records[index].Character==0x18) previewFence=true;
            }
            uint received;
            if(!ReadInput(input,records,consume,out received)) throw new System.ComponentModel.Win32Exception();
            for(uint index=0;index<received;index++) {
                var record=records[index];
                if(!IsDataKey(record)) continue;
                for(int repeat=0;repeat<record.Repeat;repeat++) {
                    char character=(char)record.Character;
                    if(fence && character=='\u0006' && record.Repeat==1) {
                        if(interrupted) throw new System.OperationCanceledException("Native editor data interrupted");
                        var bytes=System.Convert.FromBase64String(encoded.ToString());
                        if(bytes.Length>8192) throw new System.InvalidOperationException("Native editor data exceeds 8192 bytes");
                        return new System.Text.UTF8Encoding(false,true).GetString(bytes);
                    }
                    if(fence) throw new System.InvalidOperationException("Native editor data fence was interrupted");
                    if(character=='\u0018') { fence=true; continue; }
                    if(character=='\u0003') { interrupted=true; continue; }
                    if(char.IsControl(character)) throw new System.OperationCanceledException("Native editor data interrupted");
                    if(encoded.Length>=10924) throw new System.InvalidOperationException("Native editor data exceeds its wire bound");
                    encoded.Append(character);
                }
            }
        }
        throw new System.TimeoutException("Native editor data was not delivered");
    }
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool ignore);
    public static void SetIgnore(bool ignore) {
        if (!SetConsoleCtrlHandler(System.IntPtr.Zero, ignore))
            throw new System.ComponentModel.Win32Exception();
    }
}
