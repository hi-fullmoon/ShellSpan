# Independent ABI control. Fixed owned UUID name and loopback DNS receiver only.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class FixedDnsNativeControl {
  [StructLayout(LayoutKind.Sequential)] struct Request {
    public uint Version; public IntPtr Name; public ushort Type; public ulong Options;
    public IntPtr Servers; public uint Interface; public IntPtr Callback; public IntPtr Context;
  }
  [StructLayout(LayoutKind.Sequential)] struct Result {
    public uint Version; public int Status; public ulong Options; public IntPtr Records; public IntPtr Reserved;
  }
  [DllImport("dnsapi.dll")] static extern int DnsQueryEx(ref Request request, ref Result result, IntPtr cancel);
  [DllImport("dnsapi.dll")] static extern void DnsFree(IntPtr records, int type);
  public sealed class Observation {
    public string fixture_id; public int dispatch_status; public int completion_status;
    public bool records_returned; public int received; public string receiver_error;
    public int request_size; public int result_size;
  }
  public static Observation Run() {
    Guid id = Guid.NewGuid(); string name = "sspa-" + id.ToString("N") + ".invalid";
    var observation = new Observation { fixture_id=id.ToString(), request_size=Marshal.SizeOf(typeof(Request)), result_size=Marshal.SizeOf(typeof(Result)) };
    using (var server = new UdpClient(new IPEndPoint(IPAddress.Loopback, 53))) {
      server.Client.ReceiveTimeout = 3000;
      var receiver = Task.Run(() => {
        try {
          IPEndPoint peer = null; byte[] packet = server.Receive(ref peer); observation.received++;
          // Independently validate the fixed question; never forward a packet.
          int end=12; string actual="";
          while (end < packet.Length && packet[end] != 0) {
            int length=packet[end++]; if (length>63 || end+length>packet.Length) throw new Exception("invalid label");
            actual += (actual.Length==0 ? "" : ".") + System.Text.Encoding.ASCII.GetString(packet,end,length); end+=length;
          }
          end+=5;
          if (packet.Length>512 || actual!=name || end>packet.Length || packet[4]!=0 || packet[5]!=1 || packet[end-4]!=0 || packet[end-3]!=1 || packet[end-2]!=0 || packet[end-1]!=1) throw new Exception("question mismatch");
          byte[] answer=new byte[end+16]; Array.Copy(packet,answer,end);
          answer[2]=0x81; answer[3]=0x80; answer[6]=0; answer[7]=1; answer[8]=answer[9]=answer[10]=answer[11]=0;
          byte[] record={0xc0,0x0c,0,1,0,1,0,0,0,0,0,4,127,0,0,42}; Array.Copy(record,0,answer,end,16);
          server.Send(answer,answer.Length,peer);
        } catch(Exception error) { observation.receiver_error=error.GetType().Name + ": " + error.Message; }
      });
      IntPtr text=Marshal.StringToHGlobalUni(name), addresses=Marshal.AllocHGlobal(96);
      Result result=new Result {Version=1};
      try {
        byte[] data=new byte[96]; data[0]=1; data[4]=1; data[12]=2; data[32]=2; data[36]=127; data[39]=1; data[64]=16;
        Marshal.Copy(data,0,addresses,data.Length);
        Request request=new Request {Version=1,Name=text,Type=1,Options=8|256|64|32|128|2048,Servers=addresses};
        observation.dispatch_status=DnsQueryEx(ref request,ref result,IntPtr.Zero);
        observation.completion_status=result.Status; observation.records_returned=result.Records!=IntPtr.Zero;
      } finally {
        if(result.Records!=IntPtr.Zero) DnsFree(result.Records,1);
        Marshal.FreeHGlobal(text); Marshal.FreeHGlobal(addresses);
      }
      receiver.Wait();
    }
    return observation;
  }
}
'@
[FixedDnsNativeControl]::Run() | ConvertTo-Json -Depth 3
