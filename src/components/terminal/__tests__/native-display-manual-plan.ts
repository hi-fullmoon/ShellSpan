export const nativeDisplaySamples = Object.freeze({
  ascii: 'SELECT_ASCII alpha  beta END_ASCII',
  unicode: 'SELECT_UNICODE 中文 e\u0301 👩🏽‍💻 ! END_UNICODE',
  soft: 'SOFT_START '+Array.from({length:40},(_,i)=>`word${String(i).padStart(2,'0')}`).join(' ')+' SOFT_END',
  hard: 'HARD_FIRST alpha\nHARD_SECOND beta',
  history: 'HISTORY_090 stable anchor',
});
export type ManualPointerGesture = Readonly<{trusted:boolean;startX:number;startY:number;endX:number;endY:number;startRow:number;endRow:number}>;
export function manualPointerRow(clientY:number,screenTop:number,screenHeight:number,rows:number):number|null{
 if(![clientY,screenTop,screenHeight,rows].every(Number.isFinite)||!Number.isInteger(rows)||rows<=0||screenHeight<=0||clientY<screenTop||clientY>=screenTop+screenHeight)return null;
 return Math.min(rows-1,Math.floor((clientY-screenTop)*rows/screenHeight));
}
export function isManualSelection(expected:string,actual:string,gesture:ManualPointerGesture|undefined,direction:'forward'|'reverse'){
  if(actual!==expected||!gesture?.trusted)return false;
 if(![gesture.startX,gesture.startY,gesture.endX,gesture.endY].every(Number.isFinite)||![gesture.startRow,gesture.endRow].every(row=>Number.isInteger(row)&&row>=0))return false;
 const delta=gesture.endRow===gesture.startRow?gesture.endX-gesture.startX:gesture.endRow-gesture.startRow;
  return direction==='forward'?delta>0:delta<0;
}
export function matchesKnownClipboard(expected:string,actual:string):'exact'|'windows-newlines'|null{
  if(actual===expected)return 'exact';
  if(expected.includes('\n')&&actual===expected.replace(/\n/g,'\r\n'))return 'windows-newlines';
  return null;
}
