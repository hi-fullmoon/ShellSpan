import {useState,type MouseEvent} from 'react';
import {Button} from '@/components/ui/button';
import {Card,CardHeader,CardTitle,CardDescription,CardAction,CardContent} from '@/components/ui/card';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {t,type LocaleKey} from '@/locales';
import {nativeDisplaySamples} from './native-display-manual-plan';

const instructions:readonly LocaleKey[]=[
 'terminal.acceptance.step1','terminal.acceptance.step2','terminal.acceptance.step3',
 'terminal.acceptance.step4','terminal.acceptance.step5','terminal.acceptance.step6',
];
const samples=[nativeDisplaySamples.ascii,nativeDisplaySamples.ascii,nativeDisplaySamples.unicode,nativeDisplaySamples.soft,nativeDisplaySamples.hard,nativeDisplaySamples.history];
type Props={ready:boolean;started:boolean;busy:boolean;step:number;message:string;macCopy?:boolean;onStart:(event:MouseEvent<HTMLButtonElement>)=>void;onVerify:()=>void;onDefer:()=>void};
export function NativeDisplayManualInstructions({ready,started,busy,step,message,macCopy=false,onStart,onVerify,onDefer}:Props){
 const [confirmDefer,setConfirmDefer]=useState(false);
 return <Card size="sm" radius="compact" variant="outline" className="min-h-0 max-h-[45vh] shrink-0" data-testid="manual-instructions">
  <CardHeader className="shrink-0">
   <CardTitle><h1>{t('terminal.acceptance.title')}</h1></CardTitle>
   <CardDescription>{t('terminal.acceptance.intro')}</CardDescription>
   <CardAction><Button disabled={!ready||busy} onClick={started?onVerify:onStart}>{t(started?'terminal.acceptance.verify':'terminal.acceptance.start')}</Button></CardAction>
  </CardHeader>
  <CardContent className="min-h-0 overflow-auto">
   <div className="flex flex-col gap-3">
    <Alert variant="info">
     <AlertTitle>{t('terminal.acceptance.current',{step:Math.min(step+1,6)})}</AlertTitle>
     <AlertDescription>{t(macCopy&&step===4?'terminal.acceptance.step5Mac':instructions[Math.min(step,5)])}</AlertDescription>
    </Alert>
    <div><p>{t('terminal.acceptance.sample')}</p><pre className="whitespace-pre-wrap break-all select-none" aria-label={t('terminal.acceptance.sample')}>{samples[Math.min(step,5)]}</pre></div>
    <p role="status" aria-live="polite">{message}</p>
    <p>{t('terminal.acceptance.completed',{count:step})}</p>
    <div className="flex flex-wrap items-center gap-3">
     {confirmDefer?<><span>{t('terminal.acceptance.deferConfirm')}</span><Button variant="outline" disabled={busy} onClick={onDefer}>{t('terminal.acceptance.confirmDefer')}</Button><Button variant="ghost" onClick={()=>setConfirmDefer(false)}>{t('terminal.acceptance.keepGoing')}</Button></>:<Button variant="outline" disabled={busy} onClick={()=>setConfirmDefer(true)}>{t('terminal.acceptance.defer')}</Button>}
    </div>
   </div>
  </CardContent>
 </Card>;
}
