import { highlightSftpSource } from './sftp-code-highlight-core';

self.onmessage = (event: MessageEvent<{ content: string; language: string }>) => {
  self.postMessage(highlightSftpSource(event.data.content, event.data.language));
};
