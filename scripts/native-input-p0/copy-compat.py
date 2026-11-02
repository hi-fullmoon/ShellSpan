"""Real PTY cell/selection corpus and actual owned native-buffer bindings."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
from types import SimpleNamespace
from acceptance import Session

ESC='\x1b'
def selection(col,row,length,text):return dict(col=col,row=row,length=length,text=text)

def cases():
    return [
        dict(name='tab-history-soft-wrap',cols=16,rows=5,scrollback=30,steps=[
            dict(write='A\tB\r\nZ',checkpoint='before',selections=[selection(0,0,9,'A       B')]),
            dict(resize=[8,5],checkpoint='narrow',selections=[selection(0,0,9,'A       B'),selection(0,0,8,'A       '),selection(1,0,7,'       '),selection(6,0,3,'  B'),selection(0,0,4,'A   ')],
                 drags=[dict(start=[0,0],end=[1,1],text='A       B'),dict(start=[1,1],end=[0,0],text='A       B')])]),
        dict(name='tab-three-soft-rows',cols=16,rows=6,scrollback=30,steps=[
            dict(write='A\tB\r\nZ',checkpoint='before'),
            dict(resize=[4,6],checkpoint='narrow',selections=[selection(0,0,9,'A       B'),selection(1,0,7,'       ')])]),
        dict(name='tab-after-resize',cols=16,rows=5,scrollback=20,steps=[
            dict(write='A',checkpoint='before'),dict(resize=[4,5],checkpoint='narrow'),
            dict(write='\tB',checkpoint='arrived',selections=[selection(0,0,4,'A  B')])]),
        dict(name='custom-tab-stop',cols=16,rows=5,scrollback=20,steps=[
            dict(write=ESC+'[4G'+ESC+'H\rA\tB',checkpoint='custom',selections=[selection(0,0,4,'A  B')])]),
        dict(name='explicit-spaces-soft-wrap',cols=4,rows=5,scrollback=20,steps=[
            dict(write='ab  cd',checkpoint='written',selections=[selection(0,0,6,'ab  cd'),selection(2,0,2,'  ')])]),
        dict(name='erased-internal-soft-cells',cols=4,rows=5,scrollback=20,steps=[
            dict(write='ABCDEF'+ESC+'[1;2H'+ESC+'[3X'+ESC+'[2;3H',checkpoint='erased',selections=[selection(0,0,6,'A   EF'),selection(1,0,3,'   ')])]),
        dict(name='erased-hard-end',cols=4,rows=5,scrollback=20,steps=[
            dict(write='ABCD\r\nEF'+ESC+'[1;2H'+ESC+'[3X'+ESC+'[2;3H',checkpoint='erased',selections=[selection(0,0,6,'A\nEF'),selection(1,0,3,'')])]),
        dict(name='wide-wrap-gap',cols=4,rows=5,scrollback=20,steps=[
            dict(write='abc中Z',checkpoint='written',selections=[selection(0,0,7,'abc中Z'),selection(3,0,2,'中')])]),
        dict(name='explicit-space-before-wide',cols=4,rows=5,scrollback=20,steps=[
            dict(write='ab 中',checkpoint='written',selections=[selection(0,0,6,'ab 中')])]),
        dict(name='tab-before-wide',cols=4,rows=5,scrollback=20,steps=[
            dict(write='a\t中',checkpoint='written',selections=[selection(0,0,6,'a  中')])]),
        dict(name='wide-placeholder-partial',cols=8,rows=5,scrollback=20,steps=[
            dict(write='a中文b',checkpoint='written',selections=[selection(1,0,4,'中文'),selection(1,0,1,'中')])]),
        dict(name='combining-emoji-soft-wrap',cols=5,rows=5,scrollback=20,steps=[
            dict(write='é中👩‍💻Z',checkpoint='written',selections=[selection(0,0,6,'é中👩‍💻Z')])]),
        dict(name='typed-trailing-spaces-hard-lines',cols=8,rows=5,scrollback=20,steps=[
            dict(write='A  \r\nB ',checkpoint='written',selections=[selection(0,0,10,'A  \nB ')])]),
        dict(name='unwritten-hard-end',cols=8,rows=5,scrollback=20,steps=[
            dict(write='A',checkpoint='written',selections=[selection(0,0,8,'A'),selection(1,0,5,'')])]),
        dict(name='blank-soft-rows-internal',cols=4,rows=6,scrollback=20,steps=[
            dict(write='ABCDEFGHIJKLM'+ESC+'[1;2H'+ESC+'[3X'+ESC+'[2;1H'+ESC+'[4X'+ESC+'[3;1H'+ESC+'[4X'+ESC+'[4;2H',checkpoint='erased',selections=[selection(0,0,13,'A           M')])]),
        dict(name='erased-soft-tail',cols=4,rows=6,scrollback=20,steps=[
            dict(write='ABCDEF'+ESC+'[1;2H'+ESC+'[3X'+ESC+'[2;1H'+ESC+'[2X',checkpoint='erased',selections=[selection(0,0,8,'A')])]),
        dict(name='public-selection-outside-buffer',cols=8,rows=5,scrollback=20,steps=[
            dict(write='A',checkpoint='written',selections=[dict(col=0,row=100,length=4,sameAsBaseline=True),dict(col=0,row=-1,length=4,sameAsBaseline=True)])]),
        dict(name='typed-spaces-soft-boundary',cols=4,rows=5,scrollback=20,steps=[
            dict(write='ab  EF',checkpoint='written',selections=[selection(0,0,4,'ab  '),selection(0,0,6,'ab  EF')])]),
        dict(name='typed-space-erased-soft-tail',cols=4,rows=5,scrollback=20,steps=[
            dict(write='A bcDEF'+ESC+'[1;3H'+ESC+'[2X'+ESC+'[2;1H'+ESC+'[3X',checkpoint='erased',selections=[selection(0,0,8,'A ')])]),
        dict(name='alternate-soft-wrap-resize',cols=8,rows=5,scrollback=20,steps=[
            dict(write=ESC+'[?1049hABCDEFGHIJK',checkpoint='wide',selections=[selection(0,0,11,'ABCDEFGHIJK')]),
            dict(resize=[4,5],checkpoint='narrow',selections=[selection(0,0,7,'ABCDEFGHIJK'),selection(2,0,5,'CDEFGHIJK')])]),
        dict(name='alternate-tab-soft-wrap',cols=8,rows=5,scrollback=20,steps=[
            dict(write=ESC+'[?1049hA\tBC',checkpoint='wide',selections=[selection(0,0,9,'A      BC')]),
            dict(resize=[4,5],checkpoint='narrow',selections=[selection(0,0,5,'A      BC')])]),
        dict(name='column-selection',cols=8,rows=5,scrollback=20,steps=[
            dict(write='abcdefgh\r\nijklmnop\r\nqrstuvwx',checkpoint='written',drags=[
                dict(start=[1,0],end=[3,2],text='bc\njk\nrs',column=True),dict(start=[3,2],end=[1,0],text='bc\njk\nrs',column=True)])]),
        dict(name='upstream-wrapped-word',cols=8,rows=5,scrollback=20,steps=[
            dict(write='     foobar',checkpoint='written',clicks=[dict(at=[1,1],count=2,text='foobar'),dict(at=[1,1],count=3,text='     foobar')])]),
        dict(name='upstream-whitespace-word',cols=8,rows=5,scrollback=20,steps=[
            dict(write='a   b',checkpoint='written',clicks=[dict(at=[2,0],count=2,text='   ')])]),
    ]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--shell',type=Path,required=True);parser.add_argument('--bridge',type=Path,required=True)
    parser.add_argument('--library-only',action='store_true');parser.add_argument('--case',action='append')
    args=parser.parse_args();args.output=args.output.resolve();args.output.mkdir(parents=True)
    spec=importlib.util.spec_from_file_location('terminal_compat',Path(__file__).with_name('terminal-compat.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    names=[]
    for case in cases():
        if args.case and case['name'] not in args.case:continue
        module.capture(case,args.output);names.append(case['name'])
    if args.library_only:
        (args.output/'manifest.json').write_text(json.dumps(dict(cases=names,kind='actual PTY terminal-program library corpus'),indent=2))
        print(args.output);return
    inputs={}
    for kind in ['shell','bridge']:
        original=getattr(args,kind);frozen=args.output/('bash' if kind=='shell' else 'bridge.so')
        shutil.copy2(original,frozen);setattr(args,kind,str(frozen))
        inputs[kind]=hashlib.sha256(frozen.read_bytes()).hexdigest()
    options=SimpleNamespace(**vars(args),ssh=False,locale='en_US.UTF-8',display_profile='append')
    for label,payload in [('owned-tab','OWN_A\tOWN_B '+ 'tail-'*12),('owned-wide','中 é 👩‍💻 '+ 'wide-'*12),
                          ('owned-multiline','first\nsecond\twide 中')]:
        s=Session(options,label,user_config='export SHELLSPAN_P0_INBAND_REFLOW=1')
        source="printf '%s' "+shlex.quote(payload)+' > effect'
        def checkpoint(name):s.timeline.append(dict(checkpoint=name,oracle=dict(referenceCopy=True)))
        try:
            request=s.prepare(source,reduced=True);confirmed=s.wait('InputConfirmed',request)
            observation=s.send('inspect');editor=s.wait('EditorState',observation)
            assert editor['details']['line']==source
            assert editor['details']['point_utf8_bytes']==len(source.encode())
            assert confirmed['details']['source_digest']==hashlib.sha256(source.encode()).hexdigest()
            s.drain(0.05);checkpoint('full-owned')
            for cols in [8,16,32,100]:s.resize(cols,24);s.drain(0.06);checkpoint(f'owned-{cols}')
            commit=s.send('commit');s.wait('SubmissionAccepted',commit);s.wait('Settled')
            s.drain(0.1);checkpoint('accepted-history')
            assert (s.directory/'effect').read_text()==payload
            assert len([e for e in s.events if e['event']=='SubmissionAccepted'])==1
            assert b'p0_begin' not in s.raw
            (s.directory/'native-result.json').write_text(json.dumps(dict(result='PASS',
                sourceDigest=confirmed['details']['source_digest'],nativeBufferBound=True,nativePoint=editor['details']['point_utf8_bytes'],
                actualEffect=payload,submissionCount=1),ensure_ascii=False,indent=2))
            (s.directory/'scenario.json').write_text(json.dumps(dict(name=label,cols=100,rows=24,scrollback=1000,
                initialReflow=False,inbandDisplay=True,referenceCopy=True)))
            names.append(s.directory.name)
        finally:s.close()
    # Ordinary Readline receives a real quoted-insert key and Tab; no module,
    # private channel, owned provider or source-equality clipboard requirement.
    spec=importlib.util.spec_from_file_location('copy_pure_session',Path(__file__).with_name('background-causality.py'))
    pure=importlib.util.module_from_spec(spec);spec.loader.exec_module(pure)
    s=pure.PureSession(options,'native-edit-tab')
    try:
        pure.fixture_ready(s,1)
        s.type(b"printf '%s' 'USER_A");s.type(b'\x16\t');s.type(b"USER_B' > \"$HOME/user-tab-effect\"")
        s.drain(0.08);s.timeline.append(dict(checkpoint='ordinary-draft'))
        for cols in [32,16,100]:
            s.resize(cols,24);s.drain(0.08);s.timeline.append(dict(checkpoint=f'ordinary-{cols}'))
        s.type(b'\n');pure.fixture_ready(s,2)
        expected='USER_A\tUSER_B';assert (s.home/'user-tab-effect').read_text()==expected
        assert "USER_A\tUSER_B" in (s.home/'history').read_text()
        s.timeline.append(dict(checkpoint='ordinary-submitted'))
        (s.directory/'native-result.json').write_text(json.dumps(dict(result='PASS',actualEffect=expected,
            quotedInsertTabHistoryPreserved=True,ordinaryNative=True),indent=2))
        (s.directory/'scenario.json').write_text(json.dumps(dict(name='native-edit-tab',cols=100,rows=24,scrollback=1000)))
        names.append(s.directory.name)
    finally:s.close()
    (args.output/'manifest.json').write_text(json.dumps(dict(cases=names,inputs=inputs,
        kind='real PTY library corpus plus actual owned native buffer/side-effect checks'),indent=2))
    print(args.output)

if __name__=='__main__':main()
