"""Real commit/SIGWINCH handoff probe; no widened callback or fake receipt."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import threading
import time
from types import SimpleNamespace
from acceptance import Session

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--shell',required=True);parser.add_argument('--bridge',required=True)
    parser.add_argument('--output',type=Path,required=True);parser.add_argument('--repeats',type=int,default=64)
    parser.add_argument('--without-inband',action='store_true')
    args=parser.parse_args();args.output=args.output.resolve();args.output.mkdir(parents=True)
    inputs={}
    for kind in ['shell','bridge']:
        original=Path(getattr(args,kind));frozen=args.output/('bash' if kind=='shell' else 'bridge.so')
        shutil.copy2(original,frozen);setattr(args,kind,str(frozen))
        inputs[kind]=hashlib.sha256(frozen.read_bytes()).hexdigest()
    options=SimpleNamespace(**vars(args),ssh=False,locale='en_US.UTF-8',display_profile='append')
    s=Session(options,'commit-resize',user_config='export SHELLSPAN_P0_INBAND_REFLOW=1')
    results=[];failures=[];stop=threading.Event();worker=None
    try:
        for index in range(args.repeats):
            payload=['short','中 é 👩‍💻 '*12,'long-draft-'*90][index%3]
            source=f"printf '%s\\n' RUN_{index:03d} >> effect; printf 'OUT_{index:03d}\\n'; : '{payload}'"
            begin=len(s.raw);event_begin=len(s.events)
            prepared=s.prepare(source,reduced=True);s.wait('InputConfirmed',prepared)
            inspect=s.send('inspect');editor=s.wait('EditorState',inspect)
            assert editor['details']['line']==source
            assert editor['details']['point_utf8_bytes']==len(source.encode())
            stop.clear();sizes=[]
            def resize_burst():
                step=0
                while not stop.is_set():
                    cols=[180,32,100,40,24][step%5];rows=[24,12,30][step%3]
                    s.resize(cols,rows);sizes.append([cols,rows]);step+=1
                    time.sleep(0.00005)
            worker=threading.Thread(target=resize_burst);worker.start()
            try:
                time.sleep(0.003)
                request=s.send('commit');s.wait('SubmissionAccepted',request)
                s.wait('Settled',after=event_begin);s.drain(0.015)
            finally:
                stop.set();worker.join();worker=None
            s.resize(100,24);s.drain(0.08)
            segment=bytes(s.raw[begin:])
            events=s.events[event_begin:]
            assert sum(e['event']=='SubmissionAccepted' for e in events)==1
            assert (s.directory/'effect').read_text().splitlines()==[f'RUN_{i:03d}' for i in range(index+1)]
            assert segment.count(f'OUT_{index:03d}\r\n'.encode())==1
            on=b'\x1b]1337;SetUserVar=ShellSpanP0ReflowCursorLine=MQ==\x07'
            off=on.replace(b'MQ==',b'MA==')
            source_at=segment.find(source.encode());off_at=segment.find(off);out_at=segment.find(f'OUT_{index:03d}\r\n'.encode())
            order=(source_at>=0 and source_at+len(source.encode())<out_at) if args.without_inband else (
                segment.find(on)>=0 and source_at>=0 and source_at+len(source.encode())<off_at<out_at)
            leak=b'p0_begin' in segment or b'builtin eval --' in segment
            item=dict(index=index,resizes=len(sizes),rawStart=begin,rawEnd=len(s.raw),source=source,
                nativePoint=editor['details']['point_utf8_bytes'],acceptedExactlyOnce=True,
                sourceThenOffThenOutput=order,hiddenPlanLeak=leak)
            results.append(item)
            if leak or not order:
                failures.append(item);break
        (s.directory/'probe-result.json').write_text(json.dumps(dict(inputs=inputs,requested=args.repeats,
            completed=len(results),inbandModeExpected=not args.without_inband,results=results,failures=failures),ensure_ascii=False,indent=2))
    finally:
        stop.set()
        if worker:worker.join()
        s.close()
    print(json.dumps(dict(completed=len(results),failures=len(failures),evidence=str(s.directory))))
    if failures:raise SystemExit(1)

if __name__=='__main__':main()
