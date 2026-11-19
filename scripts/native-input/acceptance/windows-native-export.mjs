import assert from 'node:assert/strict';

function exportLayout(bytes){
  assert(Buffer.isBuffer(bytes),'Expected PE bytes');
  const range=(offset,size)=>{assert(Number.isSafeInteger(offset)&&offset>=0&&offset+size<=bytes.length,'Truncated PE image');return offset;};
  const u16=offset=>bytes.readUInt16LE(range(offset,2)),u32=offset=>bytes.readUInt32LE(range(offset,4));
  assert(u16(0)===0x5a4d,'DOS header missing');const pe=u32(0x3c);assert(u32(pe)===0x4550&&u16(pe+4)===0x8664,'Expected Windows x64 PE');
  const sections=u16(pe+6),optional=pe+24,optionalSize=u16(pe+20);assert(optionalSize>=120&&u16(optional)===0x20b,'Expected PE32+ optional header');range(optional,optionalSize);
  const imageSize=u32(optional+56),headerSize=u32(optional+60),directory=u32(optional+112),directorySize=u32(optional+116),table=optional+optionalSize;
  assert(sections>0&&sections<128&&directory>0&&directorySize>=40,'PE exports missing');range(table,sections*40);
  const entries=Array.from({length:sections},(_,index)=>{const at=table+40*index;return{rva:u32(at+12),rawSize:u32(at+16),raw:u32(at+20),flags:u32(at+36)};});
  const offset=(rva,size=1)=>{
    assert(Number.isSafeInteger(rva)&&rva>=0&&rva+size<=imageSize,'PE RVA outside image');
    if(rva+size<=headerSize)return range(rva,size);
    const entry=entries.find(value=>rva>=value.rva&&rva-value.rva+size<=value.rawSize);assert(entry,'PE RVA has no file-backed section');return range(entry.raw+rva-entry.rva,size);
  };
  const text=rva=>{const at=offset(rva),end=bytes.indexOf(0,at);assert(end>=at&&end-at<4096,'Invalid PE export name');offset(rva,end-at+1);return bytes.toString('ascii',at,end);};
  const exp=offset(directory,40),functionCount=u32(exp+20),nameCount=u32(exp+24),functions=u32(exp+28),names=u32(exp+32),ordinals=u32(exp+36);
  assert(nameCount<=65536&&functionCount<=65536,'Excessive PE export table');offset(functions,functionCount*4);offset(names,nameCount*4);offset(ordinals,nameCount*2);
  const records=Array.from({length:nameCount},(_,index)=>{
    const nameRva=u32(offset(names+index*4,4)),name=text(nameRva);
    const ordinal=u16(offset(ordinals+index*2,2));assert(ordinal<functionCount,'PE export ordinal invalid');const rva=u32(offset(functions+ordinal*4,4));
    return{name,nameRva,nameOffset:offset(nameRva),ordinal,rva};
  });
  return{records,namesOffset:offset(names,nameCount*4),ordinalsOffset:offset(ordinals,nameCount*2),directory,directorySize,entries,offset};
}

/** Reads an x64 PE export address; never loads or executes the image. */
export function nativeExportRva(bytes,name){
  assert(Buffer.isBuffer(bytes)&&typeof name==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),'Invalid export lookup');
  const {records,directory,directorySize,entries,offset}=exportLayout(bytes),record=records.find(value=>value.name===name);
  if(record){const rva=record.rva;assert(!(rva>=directory&&rva<directory+directorySize),'Forwarded PE export is not a code breakpoint');offset(rva);assert(entries.some(entry=>rva>=entry.rva&&rva-entry.rva<entry.rawSize&&(entry.flags&0x20000000)!==0),'Export is not executable code');return rva;}
  throw new Error('PE export not found: '+name);
}

export function nativeExports(bytes){return exportLayout(bytes).records.map(({name,rva})=>({name,rva}));}

/** Fault-injection copy. Keep the PE name and ordinal indexes sorted together. */
export function renameNativeExport(bytes,name,replacement){
  assert([name,replacement].every(value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))&&name!==replacement&&name.length===replacement.length,'Equal-length distinct ASCII export names required');
  const layout=exportLayout(bytes),record=layout.records.find(value=>value.name===name);assert(record,'Export to rename not found');assert(!layout.records.some(value=>value.name===replacement),'Replacement export already exists');
  const compare=(a,b)=>Buffer.compare(Buffer.from(a.name,'ascii'),Buffer.from(b.name,'ascii'));
  assert(layout.records.every((value,index)=>index===0||compare(layout.records[index-1],value)<0),'Input export names are not sorted and unique');
  const output=Buffer.from(bytes);output.write(replacement,record.nameOffset,replacement.length,'ascii');
  const sorted=layout.records.map(value=>value===record?{...value,name:replacement}:value).sort(compare);
  for(const [index,value] of sorted.entries()){output.writeUInt32LE(value.nameRva,layout.namesOffset+index*4);output.writeUInt16LE(value.ordinal,layout.ordinalsOffset+index*2);}
  const after=exportLayout(output).records;assert.deepEqual(after.map(({name,rva})=>({name,rva})),sorted.map(({name,rva})=>({name,rva})),'Export-name storage overlapped another name');
  return output;
}
