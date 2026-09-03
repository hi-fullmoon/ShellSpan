# DeepSeek Harness `hello` 目标结构

固定会话在 DeepSeek Harness `49a606bc5b5934603f22a26957a07dc799ab0291` 上通过 keyless test scaffold 注入并重放；没有请求模型。目标顺序为：

```text
SystemPromptRow
User message: hello
TurnProcessNodeView: 已思考
  ContextInjectionRow
  ReasoningRow
Assistant answer: Hello! How can I help?
Turn tail / stats
```

折叠态与展开态分别保存在本目录的 PNG 和 aria 文本中；`deepseek-hello.dom.html` 记录展开态 DOM。

参考结构源文件及 SHA-256：

```text
7ff176c14d623384a929f2906c456ce4160338f1aceee6a3101318e634fb89c5  packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx
5681295fb0897a36d6255b88bec454cfd231e71f23885ce748bb4b9de5396346  packages/client/ui-chat/src/client/chat/ReasoningRow.tsx
d00c839d17e7fbbc313d09623a281827b9246843cd47ed5855138562d2b95a45  packages/client/ui-chat/src/client/chat/ContextInjectionRow.tsx
d397f1e92f76585fa49b924b3d43d829ad503a4ffa821660234d4b51e5cc743f  packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx
7633ffcf467a6a2b0af7068ed7fff8258d264ba61e5dbd67dd20c4a3509da11c  packages/client/ui-chat/src/client/conversation-nodes/turn-process-presentation.ts
aea23c047b89bd4503104a501f4cc5efadc3f5f1cfec9735d7efd2d1f3952f4b  packages/client/ui-chat/src/client/chat/ChatView.tsx
157c7d62bb8fb66b6f9a79cd2ca8cd78b396f58549944b0506d47fb692936220  packages/client/connection/src/client/fixture.ts
```
