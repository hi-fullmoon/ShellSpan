import { extractOffice } from './document-office';

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; extension: string }>) => {
  try { self.postMessage({ text: await extractOffice(event.data.bytes, event.data.extension) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
