//! Live ConPTY/PSReadLine check, independently for each selected host executable.
//! This executable has no mechanism for injecting a native control receipt.
use shellspan_native_input_editors::protocol;
use protocol as nip;
#[path="../../src/terminal_command/capture.rs"]
mod capture;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use sha2::Digest;
use std::{fs, io::{Read, Write}, path::PathBuf, sync::{Arc,Mutex}, thread, time::{Duration,Instant}};
fn main() {
    assert!(cfg!(windows), "ConPTY acceptance requires the actual Windows host");
    let args: Vec<_> = std::env::args().collect(); assert_eq!(args.len(),4);
    let shell=PathBuf::from(&args[1]); let evidence=PathBuf::from(&args[2]);
    fs::create_dir_all(&evidence).unwrap();
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let id=format!("p3-{}",std::process::id());
    let windows51=args[3]=="51";
    let profile=nip::PeerProfile { shell: if windows51 { nip::ShellFamily::WindowsPowerShell } else { nip::ShellFamily::PowerShell7 },
        shell_version: Some(if windows51 {"5.1.26100.9711"} else {"7.6.9"}.into()),
        editor: nip::EditorFamily::PsReadLine, editor_version: Some("2.4.5".into()), editor_numeric_version: 20405,
        adapter_version:"1".into(), verified_profile_id:Some(format!("{}-psreadline-2.4.5-windows-x64-native",if windows51 {"windows-powershell-5.1.26100.9711"}else{"powershell-7.6.9"})) };
    let quote=|s: &str| format!("'{}'",s.replace('\'',"''"));
    let bootstrap=evidence.join("bootstrap.ps1");
    let module=root.join("../resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1");
    let history=evidence.join("history.txt");
    let library=root.join("target/debug/shellspan_native_input_editors.dll");
    let script=format!(r#"$ErrorActionPreference='Stop'
Import-Module {} -ErrorAction Stop
Set-PSReadLineOption -HistorySavePath {} -ErrorAction Stop
$__shellspanFixtureProfile={}
$__shellspanFixtureModule=Get-Module PSReadLine
$__shellspanFixtureAssembly=[Microsoft.PowerShell.PSConsoleReadLine].Assembly
$__shellspanFixtureOptions=Get-PSReadLineOption
$__shellspanFixtureRecord=@{{engine=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;host=$Host.Name;hostVersion=$Host.Version.ToString();pid=$PID;session=[Diagnostics.Process]::GetCurrentProcess().SessionId;moduleVersion=$__shellspanFixtureModule.Version.ToString();modulePath=$__shellspanFixtureModule.Path;assemblyPath=$__shellspanFixtureAssembly.Location;assemblySha256=(Get-FileHash $__shellspanFixtureAssembly.Location -Algorithm SHA256).Hash;historyPath=$__shellspanFixtureOptions.HistorySavePath;prediction=[string]$__shellspanFixtureOptions.PredictionSource;tokenColor=[string]$__shellspanFixtureOptions.CommandColor;exe=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName}}
[IO.File]::WriteAllText({},($__shellspanFixtureRecord|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
if($__shellspanFixtureModule.Version.ToString()-cne '2.4.5'){{throw 'Actual module is not the frozen provider'}}
. {} -Library {} -PipeName {} -ProfileJson $__shellspanFixtureProfile -TransportSource ([IO.File]::ReadAllText({})) -ExpectedClientPid {} -ExpectedEditorHash {} -JobHelpersPath {} -JobHostPath {} -ConsoleSignalPath {} -HostReferencePath {}
"#,if windows51 {quote(&module.to_string_lossy())}else{"PSReadLine".into()},quote(&history.to_string_lossy()),quote(&serde_json::to_string(&profile).unwrap()),
        quote(&evidence.join("actual-provider.json").to_string_lossy()),quote(&root.join("psreadline.ps1").to_string_lossy()),quote(&library.to_string_lossy()),quote(&id),quote(&root.join("psreadline.cs").to_string_lossy()),std::process::id(),quote(&hex::encode(sha2::Sha256::digest(fs::read(root.join("../resources/powershell/PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll")).unwrap()))),quote(&root.join("../src/terminal_jobs.ps1").to_string_lossy()),quote(&root.join("../src/terminal_job_host.cs").to_string_lossy()),quote(&root.join("../src/terminal_console_signals.cs").to_string_lossy()),quote(&root.join("../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.ps1").to_string_lossy()));
    fs::write(&bootstrap,script).unwrap();
    let pair=native_pty_system().openpty(PtySize{rows:30,cols:100,pixel_width:0,pixel_height:0}).unwrap();
    let mut command=CommandBuilder::new(&shell); command.args(["-NoLogo","-NoProfile","-NoExit","-File"]);command.arg(&bootstrap);
    if windows51 {
        let mut paths=vec![root.join("../resources/powershell")];
        if let Some(previous)=std::env::var_os("PSModulePath") {paths.extend(std::env::split_paths(&previous));}
        command.env("PSModulePath",std::env::join_paths(paths).unwrap());
    }
    let mut child=pair.slave.spawn_command(command).unwrap();drop(pair.slave);
    let writer=Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let mut reader=pair.master.try_clone_reader().unwrap();
    let raw=Arc::new(Mutex::new(Vec::new()));let capture=raw.clone();
    let terminal=Arc::new(Mutex::new(vt100::Parser::new(30,100,10000)));
    let terminal_reader=terminal.clone();let responses=writer.clone();
    let output=thread::spawn(move|| {
        let mut queries=vte::Parser::new();let mut query=TerminalQueries::default();let mut bytes=[0;8192];
        while let Ok(count)=reader.read(&mut bytes) {if count==0 {break;}
            capture.lock().unwrap().extend_from_slice(&bytes[..count]);
            for byte in &bytes[..count] {
                let mut terminal=terminal_reader.lock().unwrap(); terminal.process(&[*byte]);
                queries.advance(&mut query,&[*byte]);
                if query.cursor {
                    let (row,col)=terminal.screen().cursor_position(); query.cursor=false;
                    let mut writer=responses.lock().unwrap();writer.write_all(format!("\x1b[{};{}R",row+1,col+1).as_bytes()).unwrap();writer.flush().unwrap();
                }
            }
        }
    });
    let messages=Arc::new(Mutex::new(Vec::<nip::Message>::new()));
    let control_raw=Arc::new(Mutex::new(Vec::new()));
    let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline=Instant::now()+Duration::from_secs(30);
        let mut control=loop {match fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\{id}")) {
            Ok(file)=>break file,Err(_) if Instant::now()<deadline=>thread::sleep(Duration::from_millis(10)),Err(e)=>panic!("Native pipe startup: {e}")}};
        let mut input=control.try_clone().unwrap(); let observed=messages.clone();let control_capture=control_raw.clone();
        let _control_reader=thread::spawn(move||{
            let mut decoder=nip::Decoder::default();let mut bytes=[0;8192];
            loop {
                match available(&input) {Some(0)=>{thread::sleep(Duration::from_millis(5));continue;},None=>break,Some(_)=>{}}
                let Ok(count)=input.read(&mut bytes)else{break;};if count==0 {break;}
                control_capture.lock().unwrap().extend_from_slice(&bytes[..count]);
                for message in decoder.push(&bytes[..count]).unwrap(){observed.lock().unwrap().push(message);}
            }
        });
        let send=|control:&mut fs::File, value:Vec<u8>|control.write_all(&value).unwrap();
        let probe=nip::ConnectionEnvelope{protocol:nip::PROTOCOL.into(),request_id:"probe".into(),connection:nip::ConnectionIdentity{terminal_session_id:id.clone(),terminal_generation:1,control_id:id.clone()},payload:nip::ConnectionPayload::Probe};
        send(&mut control,probe.encode().unwrap());
        write(&writer,b"\x18\x02");
        wait(||messages.lock().unwrap().iter().any(|m|matches!(m,nip::Message::Connection(v) if matches!(v.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..}))),&raw);
        let mut checks=Vec::new();
        for (index,cols) in [32,40,100,180,100,100].into_iter().enumerate() {
            pair.master.resize(PtySize{rows:30,cols,pixel_width:0,pixel_height:0}).unwrap();
            terminal.lock().unwrap().screen_mut().set_size(30,cols);
            let source=if index==4 {"cmd.exe /d /c exit 7".to_string()}
            else if index==5 {"if($?){throw 'Prior failure status changed'}; if($LASTEXITCODE -ne 7){throw 'Prior native exit code changed'}; if($Error.Count -ne $P3ErrorCount){throw 'Private management changed Error.Count'}; [Console]::WriteLine('P3-STATUS-'+'PRESERVED')".to_string()}
            else if index%2==0 {
                "using namespace System.Text\nparam($HeaderValue=$([Console]::WriteLine('P3-PRE-'+'HEADER');'header-value'))\n$P3Parent='父Shell-é-👩🏽‍💻'; $P3ErrorCount=$Error.Count; if($HeaderValue -cne 'header-value'){throw 'Header scope changed'}; [Console]::WriteLine('P3-BODY-'+'HEADER')".to_string()
            }else{
                "if($P3Parent -cne '父Shell-é-👩🏽‍💻'){throw 'Parent scope changed'}; [Console]::WriteLine('P3-PARENT-'+'PERSISTED')".to_string()
            };
            let expected_exit=if index==4{7}else{0};
            let identity=nip::Identity{terminal_session_id:id.clone(),terminal_generation:1,lease_id:format!("lease-{index}"),lease_generation:index as u64+1,agent_session_id:"p3-agent".into(),task_id:"p3-task".into(),operation_id:format!("p3-op-{index}"),command_id:format!("p3-cmd-{index}"),source_revision:1};
            let plan=nip::native_foreground_plan(&source,profile.shell).unwrap(); let digest=nip::sha(&source);let bound=nip::bound_plan_digest(&digest,&plan);
            let prepare=nip::Envelope{protocol:nip::PROTOCOL.into(),request_id:format!("prepare-{index}"),identity:identity.clone(),payload:nip::Payload::PrepareInput{source:source.clone(),source_digest:digest.clone(),plan,plan_digest:bound.clone(),budget_ms:5000,reduced_motion:false,job:None}};
            send(&mut control,prepare.encode().unwrap());write(&writer,b"\x18\x02");
            wait(||has(&messages,&prepare.request_id,"inputConfirmed"),&raw);
            assert!(messages.lock().unwrap().iter().any(|m|matches!(m,nip::Message::Operation(v)if v.request_id==prepare.request_id&&matches!(&v.payload,nip::Payload::InputConfirmed{source_digest,utf8_bytes,cursor_utf8_bytes,end_utf8_bytes,..}if source_digest==&digest&&*utf8_bytes==source.len()&&*cursor_utf8_bytes==source.len()&&*end_utf8_bytes==source.len()))));
            let commit=nip::Envelope{protocol:nip::PROTOCOL.into(),request_id:format!("commit-{index}"),identity,payload:nip::Payload::Commit{source_digest:digest,plan_digest:bound}};
            send(&mut control,commit.encode().unwrap());
            wait(||has(&messages,&commit.request_id,"commitArmed"),&raw);
            write(&writer,b"\x18a");
            wait(||has(&messages,&prepare.request_id,"settled"),&raw);
            assert!(has(&messages,&prepare.request_id,"started"));
            assert!(messages.lock().unwrap().iter().any(|m|matches!(m,nip::Message::Operation(v)if v.request_id==prepare.request_id&&matches!(v.payload,nip::Payload::Settled{exit_code}if exit_code==expected_exit))));
            wait(||{let mut fence=capture::CaptureFence::new(&prepare.request_id);fence.push(&raw.lock().unwrap());fence.complete()},&raw);
            let mut fence=capture::CaptureFence::new(&prepare.request_id);let combined=fence.push(&raw.lock().unwrap());assert!(fence.complete());
            assert!(fence.finish_incomplete().is_empty(),"A completed real capture retained pending bytes");
            fs::write(evidence.join(format!("combined-{index}.bin")),&combined).unwrap();
            let combined=String::from_utf8(combined).unwrap();
            if index==5 {assert_eq!(combined.matches("P3-STATUS-PRESERVED").count(),1);}
            else if index==4 {}
            else if index%2==0 {
                assert_eq!(combined.matches("P3-PRE-HEADER").count(),1);assert_eq!(combined.matches("P3-BODY-HEADER").count(),1);
                assert!(combined.find("P3-PRE-HEADER").unwrap()<combined.find("P3-BODY-HEADER").unwrap(),"All pre-body output must cross the actual production capture fence");
            }else {assert_eq!(combined.matches("P3-PARENT-PERSISTED").count(),1);}
            checks.push(serde_json::json!({"columns":cols,"started":true,"settled":true,"exitCode":expected_exit,"captureComplete":true,"preBodyOutput":index<4&&index%2==0,"statusAndErrorsPreserved":index==5}));
            wait(||messages.lock().unwrap().iter().any(|m|matches!(m,nip::Message::Connection(v) if matches!(&v.payload,nip::ConnectionPayload::EditorReady{after_command:Some(i),..} if i.operation_id==prepare.identity.operation_id))),&raw);
        }
        fs::write(evidence.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"ok":true,"checks":checks,"realSubmissions":6})).unwrap()).unwrap();
    }));
    let _=child.kill();let _=child.wait(); drop(writer);drop(pair.master);let _=output.join();
    fs::write(evidence.join("raw.bin"),&*raw.lock().unwrap_or_else(|e|e.into_inner())).unwrap();
    fs::write(evidence.join("control.jsonl"),&*control_raw.lock().unwrap_or_else(|e|e.into_inner())).unwrap();
    if let Err(error)=outcome {std::panic::resume_unwind(error);}
}
fn write(writer:&Arc<Mutex<Box<dyn Write+Send>>>,bytes:&[u8]) {let mut writer=writer.lock().unwrap();writer.write_all(bytes).unwrap();writer.flush().unwrap();}
#[cfg(windows)]
fn available(file:&fs::File)->Option<u32>{
    use std::os::windows::io::AsRawHandle;
    let mut bytes=0;
    let result=unsafe{windows_sys::Win32::System::Pipes::PeekNamedPipe(file.as_raw_handle(),std::ptr::null_mut(),0,std::ptr::null_mut(),&mut bytes,std::ptr::null_mut())};
    (result!=0).then_some(bytes)
}
#[cfg(not(windows))]
fn available(_file:&fs::File)->Option<u32>{None}
#[derive(Default)]
struct TerminalQueries { cursor:bool }
impl vte::Perform for TerminalQueries {
    fn csi_dispatch(&mut self,params:&vte::Params,intermediates:&[u8],ignore:bool,action:char) {
        if !ignore && intermediates.is_empty() && action=='n' && params.iter().collect::<Vec<_>>()==vec![&[6][..]] {self.cursor=true;}
    }
}
fn wait(mut predicate:impl FnMut()->bool,raw:&Arc<Mutex<Vec<u8>>>) {
    let deadline=Instant::now()+Duration::from_secs(10);
    while Instant::now()<deadline {if predicate(){return;}thread::sleep(Duration::from_millis(10));}
    let captured=raw.lock().unwrap().len();
    panic!("Actual native boundary missing; captured {captured} PTY bytes");
}
fn has(messages:&Arc<Mutex<Vec<nip::Message>>>,id:&str,kind:&str)->bool {
    messages.lock().unwrap().iter().any(|m|match m {nip::Message::Operation(v) if v.request_id==id=>serde_json::to_value(&v.payload).unwrap()["kind"]==kind,_=>false})
}
