"""Real native provider lifetimes; display-policy delivery is experimental only.

No display-policy action grants prepare/commit authority. Native receipts,
immutable binding and the real executable key remain the existing authority.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import time
from types import SimpleNamespace
from acceptance import Session


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--shell',required=True)
    parser.add_argument('--bridge',required=True)
    parser.add_argument('--inband',action='store_true')
    parser.add_argument('--only',action='append')
    args=parser.parse_args();args.output=args.output.resolve();args.output.mkdir(parents=True)
    inputs={}
    for key in ['shell','bridge']:
        original=Path(getattr(args,key));frozen=args.output/('bash' if key=='shell' else 'bridge.so')
        shutil.copy2(original,frozen);setattr(args,key,str(frozen))
        inputs[key]=dict(original=str(original),sha256=hashlib.sha256(frozen.read_bytes()).hexdigest())
    options=SimpleNamespace(**vars(args),ssh=False,locale='en_US.UTF-8',display_profile='append',expected_version='5.3')
    names=[];native_failures=[]
    commit_modes=['commit','handoff-resize-gap','delayed-receipt-tui','open-after-delayed-prepared',
                  'tui-control-eof','background-owned']
    modes=['commit','cancel','cancel-typing','takeover','local-eof','withheld-close',
           'handoff-resize-gap','delayed-receipt-tui','open-after-delayed-prepared']
    if args.inband:modes.extend(['normal-exit','killed-pty-eof','stdout-no-authority','sighup-owned',
                                'tui-control-eof','background-owned'])
    if args.only:modes=args.only
    for mode in modes:
        s=Session(options,mode,user_config='export SHELLSPAN_P0_INBAND_REFLOW=1' if args.inband else '')
        def policy(action):s.timeline.append(dict(displayPolicy=action))
        def checkpoint(name,**oracle):s.timeline.append(dict(checkpoint=name,oracle=oracle))
        try:
            def save():
                (s.directory/'scenario.json').write_text(json.dumps(dict(name=mode,cols=100,rows=24,scrollback=1000,
                    initialReflow=False,ownershipWindow=True,inbandDisplay=args.inband,referenceCopy=mode=='background-owned')))
                names.append(s.directory.name)
            if mode=='stdout-no-authority':
                payload='\\033]1337;SetUserVar=ShellSpanP0ReflowCursorLine=MQ==\\007'
                s.type(('printf %b '+shlex.quote(payload)+'\n').encode());s.drain(0.3)
                checkpoint('untrusted-mode-only',option=True)
                rejected=s.send('commit');s.wait('Rejected',rejected)
                assert not any(e['event']=='SubmissionAccepted' for e in s.events)
                s.type(('printf %b '+shlex.quote(payload.replace('MQ==','MA=='))+'\n').encode());s.drain(0.3)
                checkpoint('untrusted-reset',option=False)
                invalid=payload.replace('MQ==','invalid-value')
                s.type(('printf %b '+shlex.quote(invalid)+'\n').encode());s.drain(0.2)
                checkpoint('invalid-variable-ignored',option=False)
                save();continue
            fixture=s.directory/'vim-input.txt';fixture.write_text('terminal ownership window\nsecond line\n')
            source="printf ONCE >> effect; : '"+'draft-'*40+"'"
            if mode=='normal-exit':source='exit 7'
            if mode in ['delayed-receipt-tui','tui-control-eof']:
                source="/usr/bin/vim -Nu NONE -n -i NONE -M "+shlex.quote(str(fixture))+"; printf ONCE >> effect"
            if mode=='background-owned':
                after=len(s.events)
                s.type(b"(for i in 1 2 3 4 5; do printf 'BG_%s\\n' \"$i\"; sleep 0.15; done) &\n")
                s.wait('EditorReady',after=after)
            if mode!='open-after-delayed-prepared':policy('open-before-prepare')
            prepared=s.prepare(source)
            receipt=s.wait('Prepared',prepared)
            s.drain(0.2);s.resize(40,24);s.drain(0.2);s.resize(32,24)
            s.drain(0.2);s.resize(20,24);s.drain(0.2);s.resize(40,24)
            if mode=='cancel-typing':
                observation=s.send('inspect');native=s.wait('EditorState',observation)
                s.drain(0.05)
                checkpoint('owned-partial',copyPrefix='USER_PROMPT\nP0> '+native['details']['line'],option=True)
            else:
                s.wait('InputConfirmed',prepared);s.drain(0.1)
                if mode=='open-after-delayed-prepared':
                    s.timeline.append(dict(deliverReceipt=receipt,delivery='intentionally delayed display delivery'))
                    policy('open-after-delayed-prepared')
                checkpoint('owned-confirmed',option=True,**(dict(referenceCopy=True,labels=[f'BG_{i}' for i in range(1,6)])
                    if mode=='background-owned' else dict(copy='USER_PROMPT\nP0> '+source)))
            if mode in ['normal-exit','killed-pty-eof','sighup-owned']:
                if mode=='normal-exit':s.send('commit')
                else:os.kill(s.pid,signal.SIGHUP if mode=='sighup-owned' else signal.SIGKILL)
                deadline=time.monotonic()+2;done=0
                while time.monotonic()<deadline and not done:
                    s.pump(0.02);done,status=os.waitpid(s.pid,os.WNOHANG)
                forced=not done
                if forced:
                    native_failures.append(dict(case=mode,reason='native process did not exit by deadline'))
                    os.kill(s.pid,signal.SIGKILL);_,status=os.waitpid(s.pid,0)
                s.reaped_status=status;s.drain(0.1)
                checkpoint('before-pty-end-notification',option=mode=='killed-pty-eof' or forced)
                # Trusted terminal transport end, not a shell lifecycle receipt.
                s.timeline.append(dict(ptyEOF=True,kernelStatus=status))
                checkpoint('closed-terminal',option=False)
                (s.directory/'native-result.json').write_text(json.dumps(dict(result='FAIL' if forced else 'PASS',
                    mode=mode,kernelStatus=status,forcedCleanup=forced,displayAuthority=False)))
                save();continue
            if mode!='withheld-close':policy('close-before-handoff')
            if mode=='handoff-resize-gap':
                # Actual resize after local option restoration, before native
                # acceptance: the provider still owns the confirmed long line.
                s.resize(20,24);s.drain(0.1)
                checkpoint('handoff-gap',copy='USER_PROMPT\nP0> '+source,option=args.inband)
            if mode in commit_modes:
                request=s.send('commit');s.wait('SubmissionAccepted',request)
                if mode in ['delayed-receipt-tui','tui-control-eof']:
                    deadline=time.monotonic()+4
                    while b'\x1b[?1049h' not in s.raw and time.monotonic()<deadline:s.pump()
                    assert b'\x1b[?1049h' in s.raw
                    # Deliver the real earlier receipt to the display controller
                    # after close/TUI entry. Original receipt timing is retained.
                    s.timeline.append(dict(deliverReceipt=receipt,delivery='intentionally delayed display delivery'))
                    checkpoint('tui-late-prepared',buffer='alternate',option=False)
                    if mode=='tui-control-eof':s.close_control()
                    s.resize(40,12);s.drain(0.2)
                    checkpoint('tui-resize',buffer='alternate',option=False)
                    s.type(b':q!\r')
                if mode=='tui-control-eof':
                    s.drain(0.5)
                    assert not any(e['event']=='Settled' for e in s.events)
                else:
                    s.wait('Settled',after=0);s.wait('EditorReady',after=next(i for i,e in enumerate(s.events) if e['event']=='SubmissionAccepted'))
                assert (s.directory/'effect').read_text()=='ONCE'
            elif mode in ['cancel','cancel-typing','takeover']:
                stopped=s.send('cancel' if mode=='cancel-typing' else mode);cleared=s.wait('DraftCleared',stopped)
                if mode=='takeover':s.lease=cleared['lease']
                assert not (s.directory/'effect').exists()
            else:
                s.close_control();s.drain(0.4)
                assert not (s.directory/'effect').exists()
            s.drain(0.15)
            s.type(b"printf '%s\\n' 'user_abcdefghijklmnopqrstuvwxyz'")
            s.drain(0.1);s.resize(20,24);s.drain(0.1);s.resize(100,24);s.drain(0.1)
            checkpoint('returned-user',option=False,contains="P0> printf '%s\\n' 'user_abcdefghijklmnopqrstuvwxyz'")
            s.type(b' > "$HOME/user-result"\n');s.drain(0.25)
            assert (s.home/'user-result').read_text()=='user_abcdefghijklmnopqrstuvwxyz\n'
            (s.directory/'native-result.json').write_text(json.dumps(dict(result='PASS',mode=mode,
                submitted=mode in commit_modes,
                effect=(s.directory/'effect').read_text() if (s.directory/'effect').exists() else None,
                displayAuthority=False)))
            save()
        finally:s.close()
    (args.output/'manifest.json').write_text(json.dumps(dict(cases=names,inputs=inputs,
        nativeFailures=native_failures,kind='actual native PTY/provider lifecycle; isolated display policy, not production integration'),indent=2))
    print(args.output)
    if native_failures:raise SystemExit(1)


if __name__=='__main__':main()
