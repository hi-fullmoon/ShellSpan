// Display-only pipe. It never reads, prepares, accepts or executes editor input.
namespace ShellSpan.Display {
    using System;
    using System.IO;
    using System.IO.Pipes;
    using System.Reflection;
    using System.Runtime.InteropServices;
    using System.Threading;

    public sealed class OriginPipe : IDisposable {
        [DllImport("kernel32", SetLastError=true)]
        static extern bool GetNamedPipeClientProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle handle, out uint processId);
        [DllImport("kernel32", SetLastError=true)]
        static extern bool GetHandleInformation(Microsoft.Win32.SafeHandles.SafePipeHandle handle, out uint flags);
        readonly NamedPipeServerStream pipe;
        readonly uint expectedClient;
        readonly int editorThread;
        readonly ManualResetEventSlim connected = new ManualResetEventSlim(false);
        volatile bool failed;
        int nextRequest;

        public OriginPipe(NamedPipeServerStream ownedPrivatePipe, uint expectedClientPid) {
            if(ownedPrivatePipe==null || expectedClientPid==0)throw new ArgumentException("Private display endpoint required");
            pipe=ownedPrivatePipe;expectedClient=expectedClientPid;editorThread=Thread.CurrentThread.ManagedThreadId;
            uint flags;
            if(!GetHandleInformation(pipe.SafePipeHandle,out flags)||(flags&1)!=0){pipe.Dispose();throw new IOException("Display endpoint inherited");}
            pipe.BeginWaitForConnection(result=>{
                try{pipe.EndWaitForConnection(result);uint actual;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle,out actual)||actual!=expectedClient)throw new IOException("Display peer mismatch");}
                catch{failed=true;try{pipe.Dispose();}catch(ObjectDisposedException){}}
                finally{connected.Set();}
            },null);
        }

        static int Remaining(System.Diagnostics.Stopwatch clock){return (int)Math.Max(0,10000-clock.ElapsedMilliseconds);}
        void ReadExact(byte[] buffer,System.Diagnostics.Stopwatch clock){int offset=0;while(offset<buffer.Length){var read=pipe.BeginRead(buffer,offset,buffer.Length-offset,null,null);int count;using(var wait=read.AsyncWaitHandle){if(!wait.WaitOne(Remaining(clock))){Dispose();throw new IOException("Display response deadline");}count=pipe.EndRead(read);}if(count==0)throw new EndOfStreamException("Display endpoint closed");offset+=count;}}
        void Write(byte[] buffer,System.Diagnostics.Stopwatch clock){var write=pipe.BeginWrite(buffer,0,buffer.Length,null,null);using(var wait=write.AsyncWaitHandle){if(!wait.WaitOne(Remaining(clock))){Dispose();throw new IOException("Display request deadline");}pipe.EndWrite(write);}pipe.Flush();}
        static void U16(byte[] bytes,int at,int value){bytes[at]=(byte)value;bytes[at+1]=(byte)(value>>8);}
        static void U32(byte[] bytes,int at,int value){for(int i=0;i<4;i++)bytes[at+i]=(byte)(value>>(8*i));}
        static uint Get32(byte[] bytes,int at){return(uint)(bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16|bytes[at+3]<<24);}

        public Tuple<int[],bool> Observe(int columns,int rows,int x,int y){
            if(Thread.CurrentThread.ManagedThreadId!=editorThread)throw new InvalidOperationException("Display editor thread changed");
            if(columns<1||columns>65535||rows<1||rows>65535||x<0||x>=columns||y<0||y>=rows)throw new ArgumentOutOfRangeException("Display geometry");
            var deadline=System.Diagnostics.Stopwatch.StartNew();
            try{
                if(!connected.Wait(Remaining(deadline))||failed)throw new IOException("Display peer unavailable");
                int id=checked(++nextRequest);var request=new byte[20];request[0]=83;request[1]=83;request[2]=68;request[3]=79;request[4]=2;U32(request,8,id);U16(request,12,columns);U16(request,14,rows);U16(request,16,x);U16(request,18,y);
                Write(request,deadline);var header=new byte[16];ReadExact(header,deadline);
                if(header[0]!=83||header[1]!=83||header[2]!=68||header[3]!=79||header[4]!=2||header[6]>1||header[7]!=0||Get32(header,8)!=(uint)id)throw new IOException("Display response identity");
                uint size=Get32(header,12);if(size>65536||header[5]!=1)throw new IOException("Display response unavailable");
                var payload=new byte[(int)size];ReadExact(payload,deadline);var widths=new int[payload.Length];for(int i=0;i<payload.Length;i++){if(payload[i]!=1&&payload[i]!=2)throw new IOException("Display width rejected");widths[i]=payload[i];}return Tuple.Create(widths,header[6]==1);
            }catch{Dispose();throw;}
        }
        public bool Install(System.Reflection.Assembly editor){
            var type=editor.GetType("Microsoft.PowerShell.ShellSpanPromptOrigin",false);
            var configure=type==null?null:type.GetMethod("ConfigureProvider",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic);
            if(configure==null)return false;
            configure.Invoke(null,new object[]{new Func<int,int,int,int,Tuple<int[],bool>>(Observe)});return true;
        }
        public static bool Supports(System.Reflection.Assembly editor){var type=editor.GetType("Microsoft.PowerShell.ShellSpanPromptOrigin",false);return type!=null&&type.GetMethod("ConfigureProvider",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic)!=null;}
        public void Dispose(){failed=true;try{pipe.Dispose();}catch(ObjectDisposedException){}connected.Set();}
    }
}
