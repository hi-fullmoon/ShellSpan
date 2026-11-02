//! The existing user's ConsoleHost/ConPTY, with an ACL-bound duplex NIP pipe.
//! Preparation and the bounded pipe worker run off the Tauri main thread.
use super::{editors,protocol as nip,registration::{file_sha,VerifiedNativeProfile}};
use crate::terminal_integration::TerminalShellKind;
use std::{fs::{self,File},io::{Read,Write},os::windows::io::AsRawHandle,path::{Path,PathBuf},
    sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread,time::{Duration,Instant}};
use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId,PeekNamedPipe,SetNamedPipeHandleState,PIPE_NOWAIT,PIPE_READMODE_BYTE};
pub(crate) struct PreparedNativePowerShell {
    root:tempfile::TempDir,bootstrap:PathBuf,pipe_path:String,
    modules:Option<PathBuf>,pub profile:VerifiedNativeProfile,
    server_process_id:Option<u32>,
}
impl PreparedNativePowerShell {
    pub fn prepare(shell:&Path,resources:&Path,data:&Path,kind:TerminalShellKind)->Result<Self,String> {
        if !cfg!(target_arch="x86_64") {return Err("TERMINAL_NATIVE_PROFILE_UNSUPPORTED".into());}
        let digest=file_sha(shell)?;
        let artifact=editors::read_catalogue(resources,"windows-x64")?.into_iter()
            .find(|p|p.shell_sha256==digest).ok_or("TERMINAL_NATIVE_PROFILE_UNSUPPORTED")?;
        let editor_sha=artifact.editor_sha256.as_ref().filter(|v|v.len()==64&&v.bytes().all(|b|b.is_ascii_hexdigit()))
            .ok_or("TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let modules=if kind==TerminalShellKind::WindowsPowerShell {
            Some(crate::terminal_integration::prepare_bundled_powershell_module(data)?)
        }else{None};
        let temporary=data.join("tmp");fs::create_dir_all(&temporary).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let root=tempfile::Builder::new().prefix("shellspan-nip-").tempdir_in(&temporary).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let library=root.path().join("shellspan_native_input_editors.dll");
        fs::copy(resources.join(&artifact.module),&library).map_err(|_|"TERMINAL_NATIVE_ARTIFACTS_UNAVAILABLE")?;
        let profile=editors::verify(&artifact,shell,&library)?;
        let transport=root.path().join("transport.cs");fs::write(&transport,include_str!("../../native-input-editors/psreadline.cs")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let provider=root.path().join("provider.ps1");fs::write(&provider,include_str!("../../native-input-editors/psreadline.ps1")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let helpers=root.path().join("jobs.ps1");fs::write(&helpers,include_str!("../terminal_jobs.ps1")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let job_host=root.path().join("job-host.cs");fs::write(&job_host,include_str!("../terminal_job_host.cs")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let signals=root.path().join("signals.cs");fs::write(&signals,include_str!("../terminal_console_signals.cs")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let host_reference=root.path().join("host-reference.psm1");fs::write(&host_reference,include_bytes!("../../resources/powershell/PSReadLine/2.4.5/Upstream.PSReadLine.ps1")).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        let name=format!("shellspan-nip-{}",uuid::Uuid::new_v4().simple());
        let quote=|s:&str|format!("'{}'",s.replace('\'',"''"));
        // Canonical Rust paths may carry the Win32 verbatim prefix. Expose the
        // existing local-path representation to PowerShell, whose URL/security
        // classifier does not treat that prefix as an ordinary local drive.
        // The files, hashes, ACLs and execution policy remain unchanged.
        let quote_path=|path:&Path|quote(&crate::path_utils::portable_local_path(path));
        let json=serde_json::to_string(&artifact.profile).map_err(|_|"TERMINAL_NATIVE_MANIFEST_INVALID")?;
        let mut startup="Import-Module PSReadLine -ErrorAction Stop\n".to_string();
        if let Some(isolated)=crate::path_utils::configured_data_directory() {
            let histories=isolated.join("shell-history");fs::create_dir_all(&histories).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
            startup.push_str(&format!("Set-PSReadLineOption -HistorySavePath {} -ErrorAction Stop\n",quote_path(&histories.join(format!("{}.txt",kind.protocol_name())))));
        }
        startup.push_str(&format!(". {} -Library {} -PipeName {} -ProfileJson {} -TransportSource ([IO.File]::ReadAllText({})) -ExpectedClientPid {} -ExpectedEditorHash {} -JobHelpersPath {} -JobHostPath {} -ConsoleSignalPath {} -HostReferencePath {}\n",
            quote_path(&provider),quote_path(&library),quote(&name),quote(&json),quote_path(&transport),std::process::id(),quote(editor_sha),quote_path(&helpers),quote_path(&job_host),quote_path(&signals),quote_path(&host_reference)));
        let bootstrap=root.path().join("startup.ps1");fs::write(&bootstrap,startup).map_err(|_|"TERMINAL_NATIVE_STARTUP_UNAVAILABLE")?;
        Ok(Self{root,bootstrap,pipe_path:format!(r"\\.\pipe\{name}"),modules,profile,server_process_id:None})
    }
    pub fn bind_process(&mut self,pid:Option<u32>){self.server_process_id=pid;}
    pub fn configure(&self,command:&mut portable_pty::CommandBuilder)->Result<(),String> {
        if let Some(modules)=&self.modules {
            let mut paths=vec![PathBuf::from(crate::path_utils::portable_local_path(modules))];if let Some(previous)=command.get_env("PSModulePath"){paths.extend(std::env::split_paths(previous));}
            if let Some(system)=std::env::var_os("SystemRoot"){paths.push(PathBuf::from(system).join("System32/WindowsPowerShell/v1.0/Modules"));}
            command.env("PSModulePath",std::env::join_paths(paths).map_err(|_|"TERMINAL_NATIVE_PATH_INVALID")?);
        }
        command.args(["-NoExit","-File"]);command.arg(crate::path_utils::portable_local_path(&self.bootstrap));Ok(())
    }
    pub fn start(self,probe:nip::ConnectionEnvelope,mut on_message:impl FnMut(nip::Message)->Result<(),String>+Send+'static,
        on_closed:impl FnOnce()+Send+'static)->NativeControlHandle {
        let writer=Arc::new(Mutex::new(None));let socket=writer.clone();
        let stopped=Arc::new(AtomicBool::new(false));let done=stopped.clone();
        let worker=thread::spawn(move|| {
            let _root=self.root;
            let _result=(||->Result<(),String> {
                let deadline=Instant::now()+Duration::from_secs(30);
                let mut file=loop {
                    if done.load(Ordering::Acquire)||Instant::now()>=deadline{return Err("TERMINAL_NATIVE_CONNECT_TIMEOUT".into());}
                    match fs::OpenOptions::new().read(true).write(true).open(&self.pipe_path){Ok(file)=>break file,Err(_)=>thread::sleep(Duration::from_millis(5))}
                };
                let mut server_process_id=0;
                if unsafe{GetNamedPipeServerProcessId(file.as_raw_handle(),&mut server_process_id)}==0 || Some(server_process_id)!=self.server_process_id {
                    return Err("TERMINAL_NATIVE_PRIVATE_PEER_MISMATCH".into());
                }
                let mode=PIPE_NOWAIT|PIPE_READMODE_BYTE;
                if unsafe{SetNamedPipeHandleState(file.as_raw_handle(),&mode,std::ptr::null(),std::ptr::null())}==0{return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());}
                file.write_all(&probe.encode().map_err(|_|"TERMINAL_NATIVE_PROTOCOL_INVALID")?).map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                *writer.lock().map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?=Some(file.try_clone().map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?);
                let mut decoder=nip::Decoder::default();let mut bytes=[0;8192];
                while !done.load(Ordering::Acquire) {
                    let mut available=0;
                    if unsafe{PeekNamedPipe(file.as_raw_handle(),std::ptr::null_mut(),0,std::ptr::null_mut(),&mut available,std::ptr::null_mut())}==0 {
                        decoder.finish().map_err(|_|"TERMINAL_NATIVE_PARTIAL_FRAME_EOF")?;break;
                    }
                    if available==0 {thread::sleep(Duration::from_millis(5));continue;}
                    let limit=bytes.len().min(available as usize);
                    let count=file.read(&mut bytes[..limit]).map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?;
                    if count==0 {return Err("TERMINAL_NATIVE_CONTROL_CLOSED".into());}
                    for message in decoder.push(&bytes[..count]).map_err(|_|"TERMINAL_NATIVE_PROTOCOL_INVALID")?{on_message(message)?;}
                }
                Ok(())
            })();
            done.store(true,Ordering::Release);if let Ok(mut file)=writer.lock(){file.take();}on_closed();
        });
        NativeControlHandle{socket,stopped,worker:Some(worker)}
    }
}
pub(crate) struct NativeControlHandle {socket:Arc<Mutex<Option<File>>>,stopped:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl NativeControlHandle {
    pub fn write(&self,bytes:&[u8])->Result<(),String> {
        if self.stopped.load(Ordering::Acquire)||bytes.len()>nip::MAX_MESSAGE_BYTES{return Err("TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into());}
        self.socket.lock().map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?.as_mut().ok_or("TERMINAL_NATIVE_CONTROL_UNAVAILABLE")?
            .write_all(bytes).map_err(|_|"TERMINAL_NATIVE_CONTROL_UNAVAILABLE".into())
    }
}
impl Drop for NativeControlHandle {fn drop(&mut self){self.stopped.store(true,Ordering::Release);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
