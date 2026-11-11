import {createRoot} from 'react-dom/client';
import {AppShell} from '@/components/layout/app-shell';
import {useAppStore} from '@/stores/appStore';
import {terminalRegistry} from '../registry/terminal-registry';

/** Keep the actual titlebar outside terminal cells; no synthetic terminal
 * padding, hidden overlays, or changed stream bytes. Controllers attach later. */
export async function macLifecycleSurface(){
 const element=document.getElementById('root');if(!element)throw Error('Actual lifecycle root missing');
 useAppStore.getState().setActiveSection('terminal');const root=createRoot(element);let host:HTMLDivElement|null=null;
 root.render(<AppShell><div className="min-h-0 flex-1 overflow-hidden"><div ref={value=>{host=value;}} style={{width:1100,height:650,maxWidth:'100%'}}/></div></AppShell>);
 const deadline=Date.now()+10000;while(!host){if(Date.now()>=deadline){root.unmount();throw Error('Actual lifecycle AppShell did not mount');}await new Promise(done=>requestAnimationFrame(done));}
 const actualHost=host as HTMLDivElement,measurementId='mac-lifecycle-'+crypto.randomUUID();actualHost.dataset.terminalMeasureSession=measurementId;
 return{host:actualHost,measureInitialDimensions:()=>terminalRegistry.measureInitialDimensions(measurementId),unmount:()=>root.unmount()};
}
