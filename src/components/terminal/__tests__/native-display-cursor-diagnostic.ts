// Acceptance-only readonly sampling; never a native receipt or an input API.
export function nativeDisplayCursorDiagnostic(token: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) throw Error('Owned cursor diagnostic token required');
  const name = 'DisplayCursor_' + token.split('-').join('');
  const code = `using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Threading;
public static class ${name} {
 static Timer timer; static object gate=new object(); static object instance;
 static Type type; static string path; static DateTime end;
 static object Field(object value,string key){if(value==null)return null;var f=value.GetType().GetField(key,BindingFlags.Instance|BindingFlags.NonPublic|BindingFlags.Public);return f==null?null:f.GetValue(value);}
 static int Number(object value){return value is int?(int)value:-1;}
 static int ConsoleValue(Func<int> read){try{return read();}catch(IOException){return -1;}catch(InvalidOperationException){return -1;}}
 public static void Start(Type value,string file){
  if(File.Exists(file))throw new IOException("Cursor diagnostic already exists");
  using(var stream=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){}
  type=value;path=file;end=DateTime.UtcNow.AddMinutes(3);
  var singleton=type.GetField("_singleton",BindingFlags.Static|BindingFlags.NonPublic);if(singleton==null)throw new MissingFieldException("Private provider singleton unavailable");
  instance=singleton.GetValue(null);timer=new Timer(Sample,null,Timeout.Infinite,Timeout.Infinite);timer.Change(0,40);
 }
 static void Sample(object state){lock(gate){
  if(DateTime.UtcNow>end){timer.Dispose();return;}
  try{var render=Field(instance,"_previousRender");var buffer=Field(instance,"_buffer");
   int length=buffer is StringBuilder?((StringBuilder)buffer).Length:-1;
   string line=String.Format(System.Globalization.CultureInfo.InvariantCulture,
    "{{\\\"ticks\\\":{0},\\\"left\\\":{1},\\\"top\\\":{2},\\\"width\\\":{3},\\\"height\\\":{4},\\\"initialX\\\":{5},\\\"initialY\\\":{6},\\\"current\\\":{7},\\\"length\\\":{8},\\\"renderWidth\\\":{9},\\\"renderHeight\\\":{10}}}",
    DateTime.UtcNow.Ticks,ConsoleValue(()=>Console.CursorLeft),ConsoleValue(()=>Console.CursorTop),ConsoleValue(()=>Console.WindowWidth),ConsoleValue(()=>Console.WindowHeight),Number(Field(instance,"_initialX")),Number(Field(instance,"_initialY")),Number(Field(instance,"_current")),length,Number(Field(render,"bufferWidth")),Number(Field(render,"bufferHeight")));
   File.AppendAllText(path,line+Environment.NewLine,new UTF8Encoding(false));
  }catch(Exception error){File.AppendAllText(path,"ERROR:"+error.GetType().Name+Environment.NewLine,new UTF8Encoding(false));timer.Dispose();}
 }}
}`;
  const literal = code.split('\n').join(' ').split("'").join("''");
  return `Add-Type -TypeDefinition '${literal}' -ErrorAction Stop; [${name}]::Start([Microsoft.PowerShell.PSConsoleReadLine],(Join-Path $env:SHELLSPAN_LOCAL_HOME 'display-cursor-${token}.jsonl'))`;
}
