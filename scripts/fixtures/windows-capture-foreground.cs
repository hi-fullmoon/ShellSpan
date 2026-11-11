using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ShellSpanForegroundGate {
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static bool Wait(IntPtr expected, int maximumMilliseconds) {
        var watch = Stopwatch.StartNew();
        return Wait(expected, maximumMilliseconds, GetForegroundWindow,
            () => watch.ElapsedMilliseconds, Thread.Sleep);
    }

    public static bool Wait(IntPtr expected, int maximumMilliseconds,
        Func<IntPtr> readForeground, Func<long> elapsedMilliseconds, Action<int> pause) {
        if (expected == IntPtr.Zero || maximumMilliseconds < 0 || maximumMilliseconds > 1500)
            throw new ArgumentException("Bounded owned foreground observation required");
        while (elapsedMilliseconds() <= maximumMilliseconds) {
            if (readForeground() == expected) return elapsedMilliseconds() <= maximumMilliseconds;
            if (elapsedMilliseconds() >= maximumMilliseconds) return false;
            pause(20);
        }
        return false;
    }
}
