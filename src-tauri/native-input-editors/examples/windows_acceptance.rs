//! Live ConPTY/PSReadLine check, independently for each selected host executable.
//! This executable has no mechanism for injecting a native control receipt.
use shellspan_native_input_editors::protocol;
use protocol as nip;
#[path="../../src/terminal_command/capture.rs"]
mod capture;
use portable_pty::{CommandBuilder, PtySize};
#[cfg(windows)]
use portable_pty::PtySystem;
use sha2::Digest;
use std::{fs, io::{Read, Write}, path::PathBuf, sync::{Arc,Mutex}, thread, time::{Duration,Instant}};
#[path="support/windows_negative.rs"]
mod negative;
#[path="support/windows_input_boundaries.rs"]
mod input_boundaries;
#[path="support/windows_invalid_input.rs"]
mod invalid_input;
#[path="support/windows_fault_input.rs"]
mod fault_input;
#[path="support/windows_pending_cancel.rs"]
mod pending_cancel;
#[path="support/windows_jobs.rs"]
mod jobs;
#[path="support/windows_history.rs"]
mod history_cases;
#[path="support/windows_transport.rs"]
mod transport_cases;
#[path="support/windows_loader_abi.rs"]
mod loader_abi;
#[path="support/windows_display_origin.rs"]
mod display_origin;
#[cfg(windows)]
fn open_windows_conpty(conpty: PathBuf) -> portable_pty::PtyPair {
    portable_pty::win::conpty::ConPtySystem::with_grapheme_host(conpty)
        .openpty(PtySize{rows:30,cols:100,pixel_width:0,pixel_height:0}).unwrap()
}
#[cfg(not(windows))]
fn open_windows_conpty(_: PathBuf) -> portable_pty::PtyPair {
    panic!("ConPTY acceptance requires the actual Windows host")
}
fn main() {
    assert!(cfg!(windows), "ConPTY acceptance requires the actual Windows host");
    let args: Vec<_> = std::env::args().collect(); assert!(args.len()==4||args.len()==5&&(history_cases::is_mode(&args[4])||transport_cases::is_mode(&args[4])||matches!(args[4].as_str(),"loader-abi"|"display-capture"|"negative"|"input-boundaries"|"invalid-overlimit"|"invalid-empty"|"invalid-nul"|"invalid-control"|"invalid-utf8"|"invalid-json"|"invalid-version"|"invalid-after-input"|"fault-typing"|"fault-complete"|"fault-armed"|"fault-unowned"|"fault-unicode"|"fault-armed-enter"|"pending-cancel"|"jobs")));
    assert!(matches!(args[3].as_str(),"7"|"51"),"Unknown frozen Windows host selector");
    assert_eq!(std::env::var("SHELLSPAN_ACCEPTANCE_DISPLAY_BRIDGE").as_deref(),Ok("actual-xterm"),"SDK3 requires the live display bridge, never a legacy renderer fallback");
    assert_eq!(std::env::var("SHELLSPAN_ALLOW_FOREGROUND_TESTS").as_deref(),Ok("1"),"Real native acceptance must be explicitly scheduled");
    let shell=PathBuf::from(&args[1]); let evidence=PathBuf::from(&args[2]);
    let loader_mode=args.get(4).is_some_and(|mode|mode=="loader-abi");
    let display_mode=args.get(4).is_some_and(|mode|mode=="display-capture");
    if display_mode {
        assert_eq!(std::env::var("SHELLSPAN_ALLOW_FOREGROUND_TESTS").as_deref(),Ok("1"),"Display capture requires scheduled native acceptance");
        assert!(!evidence.exists(),"Display capture evidence must be fresh");
    }
    if loader_mode {assert!(!evidence.exists(),"Loader evidence must be fresh");}
    fs::create_dir_all(&evidence).unwrap();
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let id=format!("p3-{}",std::process::id());
    let windows51=args[3]=="51";
    let mut profile=nip::PeerProfile { shell: if windows51 { nip::ShellFamily::WindowsPowerShell } else { nip::ShellFamily::PowerShell7 },
        shell_version: Some(if windows51 {"5.1.26100.9818"} else {"7.6.9"}.into()),
        editor: nip::EditorFamily::PsReadLine, editor_version: Some("2.4.5".into()), editor_numeric_version: 20405,
        adapter_version:"1".into(), verified_profile_id:Some(format!("{}-psreadline-2.4.5-shellspan6-conpty1.25.260930003-graphemes-windows-x64-native",if windows51 {"windows-powershell-5.1.26100.9818"}else{"powershell-7.6.9"})) };
    let quote=|s: &str| format!("'{}'",s.replace('\'',"''"));
    let bootstrap=evidence.join("bootstrap.ps1");
    let transport_source=evidence.join("transport.cs");
    fs::write(&transport_source,concat!(include_str!("../psreadline.cs"),"\n",include_str!("../../src/terminal_display_origin_pipe.cs"))).unwrap();
    let candidate_module=std::env::var_os("SHELLSPAN_ACCEPTANCE_PSREADLINE_MANIFEST").map(PathBuf::from);
    let module=candidate_module.clone().unwrap_or_else(||root.join("../resources/powershell/PSReadLine/2.4.5/PSReadLine.psd1"));
    let editor_hash=if candidate_module.is_some() {
        let owned=root.join("../../.artifacts/tests").canonicalize().unwrap();
        assert!(module.is_absolute()&&module.canonicalize().unwrap().starts_with(owned),"Candidate module must be inside owned test artifacts");
        let expected=std::env::var("SHELLSPAN_ACCEPTANCE_PSREADLINE_SHA256").expect("Explicit candidate assembly digest");
        assert_eq!(expected,hex::encode(sha2::Sha256::digest(fs::read(module.parent().unwrap().join("Microsoft.PowerShell.PSReadLine.dll")).unwrap())));
        // Keep the explicit candidate distinct without exceeding NIP's
        // existing 128-byte profile identifier bound on the longer P5 host.
        profile.verified_profile_id.as_mut().unwrap().push_str("-candidate");
        assert!(profile.verified_profile_id.as_ref().unwrap().len() <= 128);
        expected
    }else{hex::encode(sha2::Sha256::digest(fs::read(root.join("../resources/powershell/PSReadLine/2.4.5/Microsoft.PowerShell.PSReadLine.dll")).unwrap()))};
    let history=evidence.join("history.txt");
    let history_mode=args.get(4).filter(|mode|history_cases::is_mode(mode));
    let library=if loader_mode||display_mode||std::env::var_os("SHELLSPAN_ACCEPTANCE_NATIVE_LIBRARY").is_some() {
        let candidate=PathBuf::from(std::env::var_os("SHELLSPAN_ACCEPTANCE_NATIVE_LIBRARY").expect("Explicit loader candidate"));
        assert!(candidate.is_absolute()&&candidate.canonicalize().unwrap().starts_with(root.join("../../.artifacts/tests").canonicalize().unwrap()));
        assert_eq!(candidate.file_name().unwrap(),"shellspan_native_input_editors.dll");
        assert_eq!(std::env::var("SHELLSPAN_ACCEPTANCE_NATIVE_SHA256").unwrap(),hex::encode(sha2::Sha256::digest(fs::read(&candidate).unwrap())));
        candidate
    }else{root.join("target/debug/shellspan_native_input_editors.dll")};
    let pipe_argument=if loader_mode||display_mode {"$env:SHELLSPAN_ACCEPTANCE_PIPE".into()}else{quote(&id)};
    let mut script=format!(r#"$ErrorActionPreference='Stop'
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
"#,quote(&module.to_string_lossy()),quote(&history.to_string_lossy()),quote(&serde_json::to_string(&profile).unwrap()),
        quote(&evidence.join("actual-provider.json").to_string_lossy()),quote(&root.join("psreadline.ps1").to_string_lossy()),quote(&library.to_string_lossy()),pipe_argument,quote(&transport_source.to_string_lossy()),std::process::id(),quote(&editor_hash),quote(&root.join("../src/terminal_jobs.ps1").to_string_lossy()),quote(&root.join("../src/terminal_job_host.cs").to_string_lossy()),quote(&root.join("../src/terminal_console_signals.cs").to_string_lossy()),quote(&root.join("../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.ps1").to_string_lossy()));
    if let Some(mode)=history_mode {
        let setup=history_cases::bootstrap(mode,&evidence);
        let previous=format!("Set-PSReadLineOption -HistorySavePath {} -ErrorAction Stop\n",quote(&history.to_string_lossy()));
        assert!(script.contains(&previous));
        script=script.replacen(&previous,&setup,1);
    }
    if loader_mode {
        let start=script.rfind("\n. ").expect("One native provider startup");
        script.insert_str(start+1,"try {\n");
        script.push_str(&format!(r#"}} catch {{
$loaderException=$_.Exception;$loaderCode=$null
while($null-ne $loaderException){{
  $loaderMatch=[regex]::Match($loaderException.Message,'TERMINAL_NATIVE_[A-Z_]+(?::ss_editor_[a-z_]+)?')
  if($loaderMatch.Success){{$loaderCode=$loaderMatch.Value;break}}
  $loaderException=$loaderException.InnerException
}}
[IO.File]::WriteAllText({},(@{{code=$loaderCode;errorType=$_.Exception.GetType().FullName}}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
throw
}}
"#,quote(&evidence.join("loader-startup-error.json").to_string_lossy())));
    }
    if args.get(4).is_some_and(|mode|mode.starts_with("fault-")||history_cases::is_mode(mode)||transport_cases::is_mode(mode)) {
        script.push_str(&format!(r#"
$global:__shellspanAcceptanceEditorThread=[Threading.Thread]::CurrentThread.ManagedThreadId
$AcceptanceReadTemplate=@'
  $line=$null;$cursor=0
  [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor)
  $active=$false
  foreach($frame in [Diagnostics.StackTrace]::new().GetFrames()){{
    $method=$frame.GetMethod()
    if($null-ne $method -and $method.DeclaringType-eq [Microsoft.PowerShell.PSConsoleReadLine] -and $method.Name-ceq 'ReadLine'){{$active=$true;break}}
  }}
  $directory={}
  $sample=__SHELLSPAN_SAMPLE__
  if($sample-lt 1 -or $sample-gt 9){{throw 'Invalid acceptance sample'}}
  $path=Join-Path $directory ('actual-editor-'+$sample+'.json')
  $options=PSReadLine\Get-PSReadLineOption
  $history=@([Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems()|ForEach-Object {{$_.CommandLine}})
  $closed=& $global:__shellspanModule {{$script:Context.ControlClosed}}
  $record=@{{sample=$sample;text=[string]$line;cursorUtf16=$cursor;activeEditor=$active;thread=[Threading.Thread]::CurrentThread.ManagedThreadId;expectedThread=$global:__shellspanAcceptanceEditorThread;controlClosed=[bool]$closed;historyOptions=@{{path=$options.HistorySavePath;maximum=$options.MaximumHistoryCount;style=[string]$options.HistorySaveStyle}};history=$history;scope='Actual public editor read only, not a NIP proof or execution receipt'}}
  [IO.File]::WriteAllText($path,($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
'@
foreach($ReadSample in 1..9){{
  $ReadChord='Ctrl+F'+[string]$ReadSample
  if(@(PSReadLine\Get-PSReadLineKeyHandler -Chord $ReadChord).Count -gt 0){{throw 'Acceptance read-only key unavailable'}}
  $ReadHandler=[scriptblock]::Create($AcceptanceReadTemplate.Replace('__SHELLSPAN_SAMPLE__',[string]$ReadSample))
  PSReadLine\Set-PSReadLineKeyHandler -Chord $ReadChord -ScriptBlock $ReadHandler
}}
"#,quote(&evidence.to_string_lossy())));
    }
    // Windows PowerShell decodes BOM-less -File scripts using the ANSI code
    // page. Keep Unicode fixture paths exact without changing host encoding.
    if windows51 {script.insert(0,'\u{feff}');}
    fs::write(&bootstrap,script).unwrap();
    let conpty=root.join("../resources/conpty/1.25.260930003/conpty.dll").canonicalize().unwrap();
    let pin:serde_json::Value=serde_json::from_slice(&fs::read(conpty.parent().unwrap().join("pin.json")).unwrap()).unwrap();
    for name in ["conpty.dll","x64/OpenConsole.exe"] {
        assert_eq!(hex::encode(sha2::Sha256::digest(fs::read(conpty.parent().unwrap().join(name)).unwrap())),pin["files"][name].as_str().unwrap());
    }
    let pair=open_windows_conpty(conpty);
    let mut command=CommandBuilder::new(&shell); command.args(["-NoLogo","-NoProfile","-NoExit","-File"]);command.arg(&bootstrap);
    if loader_mode||display_mode {command.env("SHELLSPAN_ACCEPTANCE_PIPE",&id);}
    command.env("PSModuleAnalysisCachePath",evidence.join("module.cache"));
    {
        for (name,folder) in [("HOME","profile"),("USERPROFILE","profile"),("APPDATA","roaming"),("LOCALAPPDATA","local")] {
            let path=evidence.join("isolated").join(folder);fs::create_dir_all(&path).unwrap();command.env(name,path);
        }
    }
    {
        let module_root=if candidate_module.is_some(){module.parent().unwrap().parent().unwrap().parent().unwrap().to_path_buf()}else{root.join("../resources/powershell")};
        let normalize=|path:PathBuf|PathBuf::from(path.to_string_lossy().replace('/',"\\"));
        let mut paths=vec![normalize(module_root),normalize(shell.parent().unwrap().join("Modules"))];
        if let Some(previous)=std::env::var_os("PSModulePath") {paths.extend(std::env::split_paths(&previous));}
        command.env("PSModulePath",std::env::join_paths(paths).unwrap());
    }
    let mut child=pair.slave.spawn_command(command).unwrap();drop(pair.slave);
    let display_worker=display_origin::start(&id,child.process_id().unwrap(),evidence.clone());
    let writer=Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let mut reader=pair.master.try_clone_reader().unwrap();
    let raw=Arc::new(Mutex::new(Vec::new()));let capture=raw.clone();
    let capture_epoch=Instant::now();
    let read_events=Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let read_capture=read_events.clone();
    let mut resize_events=Vec::new();
    let terminal=Arc::new(Mutex::new(vt100::Parser::new(30,100,10000)));
    let terminal_reader=terminal.clone();let responses=writer.clone();
    let output=thread::spawn(move|| {
        let mut queries=vte::Parser::new();let mut query=TerminalQueries::default();let mut bytes=[0;8192];
        while let Ok(count)=reader.read(&mut bytes) {if count==0 {break;}
            {
                let mut capture=capture.lock().unwrap();
                let offset=capture.len();
                capture.extend_from_slice(&bytes[..count]);
                read_capture.lock().unwrap().push(serde_json::json!({"offset":offset,"length":count,"atMs":capture_epoch.elapsed().as_millis()}));
            }
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
        if loader_mode {loader_abi::Fixture{pipe_name:&id,writer:&writer,messages:&messages,control_raw:&control_raw,evidence:&evidence,shell:&shell,library:&library,child_pid:child.process_id().unwrap(),root:&root}.verify();return;}
        let deadline=Instant::now()+Duration::from_secs(30);
        let mut control=loop {match fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\{id}")) {
            Ok(file)=>break file,Err(_) if Instant::now()<deadline=>thread::sleep(Duration::from_millis(10)),Err(e)=>panic!("Native pipe startup: {e}")}};
        let mut input=control.try_clone().unwrap(); let observed=messages.clone();let control_capture=control_raw.clone();
        let reader_stop=Arc::new(std::sync::atomic::AtomicBool::new(false));let stopping=reader_stop.clone();
        let mut control_reader=Some(thread::spawn(move||{
            let mut decoder=nip::Decoder::default();let mut bytes=[0;8192];
            loop {
                if stopping.load(std::sync::atomic::Ordering::SeqCst){break;}
                match available(&input) {Some(0)=>{thread::sleep(Duration::from_millis(5));continue;},None=>break,Some(_)=>{}}
                let Ok(count)=input.read(&mut bytes)else{break;};if count==0 {break;}
                control_capture.lock().unwrap().extend_from_slice(&bytes[..count]);
                for message in decoder.push(&bytes[..count]).unwrap(){observed.lock().unwrap().push(message);}
            }
        }));
        let send=|control:&mut fs::File, value:Vec<u8>|control.write_all(&value).unwrap();
        let probe=nip::ConnectionEnvelope{protocol:nip::PROTOCOL.into(),request_id:"probe".into(),connection:nip::ConnectionIdentity{terminal_session_id:id.clone(),terminal_generation:1,control_id:id.clone()},payload:nip::ConnectionPayload::Probe};
        send(&mut control,probe.encode().unwrap());
        write(&writer,b"\x18\x02");
        wait(||messages.lock().unwrap().iter().any(|m|matches!(m,nip::Message::Connection(v) if matches!(v.payload,nip::ConnectionPayload::Capabilities{native_inline:true,..}))),&raw);
        if args.get(4).is_some_and(|mode|mode=="negative") {negative::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence);return;}
        if args.get(4).is_some_and(|mode|mode=="input-boundaries") {input_boundaries::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence);return;}
        if args.get(4).is_some_and(|mode|mode.starts_with("invalid-")) {invalid_input::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&args[4]);return;}
        if args.get(4).is_some_and(|mode|mode.starts_with("fault-")) {fault_input::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&args[4]);return;}
        if args.get(4).is_some_and(|mode|mode=="pending-cancel") {pending_cancel::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence);return;}
        if args.get(4).is_some_and(|mode|mode=="jobs") {
            if std::env::var("SHELLSPAN_ACCEPTANCE_WORKER_START_TIMEOUT").as_deref()==Ok("1") {
                jobs::verify_startup_timeout(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&terminal);
            }else if std::env::var("SHELLSPAN_ACCEPTANCE_WORKER_RESULT_EOF").as_deref()==Ok("1") {
                jobs::verify_result_eof(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&terminal);
            }else{jobs::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&terminal);}
            return;
        }
        if let Some(mode)=history_mode {history_cases::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,mode);return;}
        if args.get(4).is_some_and(|mode|transport_cases::is_eof_mode(mode)) {transport_cases::verify_eof(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&args[4],&reader_stop,&mut control_reader);return;}
        if args.get(4).is_some_and(|mode|transport_cases::is_mode(mode)) {transport_cases::verify(&mut control,&writer,&messages,&raw,&profile,&id,&evidence,&args[4]);return;}
        let mut checks=Vec::new();
        for (index,cols) in [32,40,100,180,100,100].into_iter().enumerate() {
            {
                // Bind each actual resize to the bytes already observed by the
                // reader. Keep pending reads behind the same capture fence.
                let captured=raw.lock().unwrap();
                pair.master.resize(PtySize{rows:30,cols,pixel_width:0,pixel_height:0}).unwrap();
                terminal.lock().unwrap().screen_mut().set_size(30,cols);
                resize_events.push(serde_json::json!({"offset":captured.len(),"columns":cols,"rows":30,"atMs":capture_epoch.elapsed().as_millis()}));
            }
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
    let mut graceful_history_exit=false;
    if history_mode.is_some()&&outcome.is_ok() {
        let deadline=Instant::now()+Duration::from_secs(10);
        while Instant::now()<deadline {
            if let Some(status)=child.try_wait().unwrap(){graceful_history_exit=status.success();break;}
            thread::sleep(Duration::from_millis(10));
        }
    }
    let _=child.kill();let _=child.wait();drop(display_worker);drop(writer);drop(pair.master);let _=output.join();
    fs::write(evidence.join("raw.bin"),&*raw.lock().unwrap_or_else(|e|e.into_inner())).unwrap();
    fs::write(evidence.join("read-events.json"),serde_json::to_vec_pretty(&*read_events.lock().unwrap_or_else(|e|e.into_inner())).unwrap()).unwrap();
    fs::write(evidence.join("resize-events.json"),serde_json::to_vec_pretty(&resize_events).unwrap()).unwrap();
    fs::write(evidence.join("control.jsonl"),&*control_raw.lock().unwrap_or_else(|e|e.into_inner())).unwrap();
    if let Err(error)=outcome {std::panic::resume_unwind(error);}
    if let Some(mode)=history_mode {assert!(graceful_history_exit,"History host did not exit normally");history_cases::after_exit(&evidence,mode);}
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
