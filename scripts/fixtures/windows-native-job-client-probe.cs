using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;

// Real competing pipe client, scoped to this probe process's unique server
// prefix. It cannot connect to another terminal's native worker channel.
public sealed class ShellSpanUnexpectedClientProbe : IDisposable {
    private volatile bool stop;
    private NamedPipeClientStream client;
    private readonly Task observer;
    public bool Connected { get; private set; }
    public ShellSpanUnexpectedClientProbe() {
        string prefix = "shellspan-job-" + System.Diagnostics.Process.GetCurrentProcess().Id + "-";
        observer = Task.Factory.StartNew(() => {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (!stop && clock.ElapsedMilliseconds < 5000) {
                foreach (string path in Directory.GetFiles(@"\\.\pipe\")) {
                    string name = Path.GetFileName(path);
                    Guid suffix;
                    if (!name.StartsWith(prefix, StringComparison.Ordinal) ||
                        !Guid.TryParseExact(name.Substring(prefix.Length), "N", out suffix)) continue;
                    try {
                        client = new NamedPipeClientStream(".", name, PipeDirection.InOut);
                        client.Connect(100);
                        Connected = true;
                        client.ReadByte();
                        return;
                    } catch (IOException) { return; }
                      catch (ObjectDisposedException) { return; }
                      catch (TimeoutException) { if (client != null) client.Dispose(); }
                }
                Thread.Sleep(1);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }
    public void Dispose() {
        stop = true;
        if (client != null) client.Dispose();
        if (!observer.Wait(1000)) throw new TimeoutException("Owned probe client did not stop");
    }
}
