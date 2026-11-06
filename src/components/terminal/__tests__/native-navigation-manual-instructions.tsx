import {useState,type MouseEvent} from 'react';
import {Button} from '@/components/ui/button';
import {Card,CardHeader,CardTitle,CardDescription,CardAction,CardContent} from '@/components/ui/card';
import {Alert,AlertTitle,AlertDescription} from '@/components/ui/alert';
import {t,type LocaleKey} from '@/locales';
const steps:readonly LocaleKey[]=['terminal.navigationAcceptance.step1','terminal.navigationAcceptance.step2','terminal.navigationAcceptance.step3','terminal.navigationAcceptance.step4','terminal.navigationAcceptance.step5'];
export function NativeNavigationManualInstructions({ready,started,busy,step,message,onStart,onVerify,onDefer}:{ready:boolean;started:boolean;busy:boolean;step:number;message:string;onStart:(event:MouseEvent<HTMLButtonElement>)=>void;onVerify:(event:MouseEvent<HTMLButtonElement>)=>void;onDefer:()=>void}){
 const [confirmDefer,setConfirmDefer]=useState(false);
 return <Card size="sm" radius="compact" variant="outline" className="min-h-0 max-h-[35vh] shrink-0" data-testid="navigation-instructions">
  <CardHeader className="shrink-0"><CardTitle><h1>{t('terminal.navigationAcceptance.title')}</h1></CardTitle><CardDescription>{t('terminal.navigationAcceptance.intro')}</CardDescription><CardAction><Button disabled={!ready||busy} onClick={started?onVerify:onStart}>{t(started?(step===4?'terminal.navigationAcceptance.finish':'terminal.navigationAcceptance.verify'):'terminal.navigationAcceptance.start')}</Button></CardAction></CardHeader>
  <CardContent className="min-h-0 overflow-auto"><div className="flex flex-col gap-3"><Alert variant="info"><AlertTitle>{t('terminal.navigationAcceptance.current',{step:Math.min(step+1,5)})}</AlertTitle><AlertDescription>{t(steps[Math.min(step,4)],{viewTask:t('terminal.occupancy.viewTask')})}</AlertDescription></Alert><p role="status" aria-live="polite">{message}</p><div className="flex flex-wrap items-center gap-3">{confirmDefer?<><span>{t('terminal.navigationAcceptance.deferConfirm')}</span><Button variant="outline" disabled={busy} onClick={onDefer}>{t('terminal.navigationAcceptance.confirmDefer')}</Button><Button variant="ghost" onClick={()=>setConfirmDefer(false)}>{t('terminal.navigationAcceptance.keepGoing')}</Button></>:<Button variant="outline" disabled={busy} onClick={()=>setConfirmDefer(true)}>{t('terminal.navigationAcceptance.defer')}</Button>}</div></div></CardContent>
 </Card>;
}
