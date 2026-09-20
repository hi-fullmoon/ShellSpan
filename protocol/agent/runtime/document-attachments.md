# Document attachments

The Ask and Agent composers accept PDF, DOCX, XLSX and the text/code extensions
listed in `src/lib/ai/document-contract.json`. This contract is shared by the
frontend admission checks and the native complete-file reader.

## User flow

Selecting, dropping or pasting a supported document starts local extraction.
Processing cards show the file name and size. Ready cards can be removed or
opened to preview the exact extracted text. The text editor contains only the
user's prompt. Sending is disabled during extraction; cancellation or navigation
invalidates the operation. Failed extraction leaves the previous draft intact and
reports one localized toast. The user can select the file again to retry.

The composer plus menu has Add, Skills and Chat history groups. Add file uploads
documents and images from the local computer. Add folder opens the target-scoped
project browser instead of a local OS directory picker.
Images keep their existing normalization, capability checks and durable submission.
Importing a document does not require a project directory or copy it to a remote machine.

Builtin skills come from the shared native catalog. Selecting one inserts its slash
command into the prompt without sending. Search matches localized descriptions,
command names and conversation titles. Folder references and skills require Agent mode.

Typing a whitespace-delimited `@` opens the same compact groups above the composer,
without taking focus from the editor. Continued typing filters skills and chat titles
and queries project files through the existing target-scoped adapter. Selecting a
skill replaces the active token with its slash command; selecting a chat removes
the token and attaches its transcript. Email addresses remain ordinary text.
Local document upload and target file references are separate actions. The project
browser shows the bound target and root; remote candidates use the existing SSH/SFTP
listing and relative-path reference contract. Remote paths are never passed to a
local OS picker or local attachment reader. Browsing an unbound project requires
explicit root selection on that target. Existing cancellation and scope-epoch checks
discard stale results when the target changes.

Remote directory enumerations have a process-memory cache with a 15-second TTL,
at most 64 directories, and at most 256 KiB of entry names per cached directory.
The key includes the full frozen target, canonical root identity and relative
directory. Prefix filtering and the 40-result display limit apply after caching
the complete bounded enumeration, so typing another prefix does not lose matches.
Concurrent reads of the same directory share a successful enumeration; waiting
remains cancellable and deadline-bounded. Errors and cancelled reads are not cached.
Local directories remain live. Remote connection and root-identity checks still
run on cache hits; the cache avoids repeated directory enumeration, not SSH
validation. Directory changes become visible on the first query after expiry.

Chat history initially shows only a search hint. The first non-empty search in
each menu opening refreshes the existing workspace-scoped session list. Results
include matching non-archived top-level conversations, excluding the current chat,
ordered by most recent update. Clearing the search hides the results again.
Selecting a chat reads its existing projection without navigating or submitting.
Its committed human and settled assistant text is serialized into a previewable
TXT attachment using the normal document limits and durable envelope. Original
attachments, images, system prompts, reasoning and tool output are excluded.
Empty or incomplete history is rejected. Cancellation and workspace changes
invalidate a pending reference import, just as for document extraction.

## Extraction and limits

- PDF.js extracts PDF text. CMaps and standard font resources are bundled locally.
- Mammoth extracts DOCX text, including tables, footnotes and endnotes.
- ExcelJS extracts XLSX worksheet names, cell addresses, text and cached formula
  results. Formulas are never evaluated.
- UTF-8 and BOM-marked UTF-16 text are decoded strictly.
- Office extraction runs in a disposable worker with a 30-second deadline. ZIP
  metadata is checked before decompression. PDF extraction uses PDF.js's worker.
- At most 10 documents and 16 MiB of original bytes per message, 8 MiB per file,
  100,000 text code units per file and 200 PDF pages. The complete serialized UTF-8
  message must fit the runtime's existing 128 KiB message limit, including metadata
  and JSON escaping. A native regression test keeps these limits synchronized.
  Office declared ZIP expansion is capped at 32 MiB and 2,048 entries. Oversized
  documents are rejected, never truncated.
- Scanned or blank PDF pages require OCR or removal before import. Embedded images,
  original layout, legacy DOC/XLS, password-protected files, audio/video and
  archives are not document inputs in this implementation.

`read_ai_attachment` reads absolute regular file paths on a blocking worker and
returns `{ name, data }`, where `data` is base64. It verifies extension and byte
limits and reads at most `maxFileBytes + 1`, independent of the SFTP preview prefix
limit. Neither file bytes nor extracted text are written to diagnostic logs.

## Durable message representation

Messages without documents remain unchanged. A document message uses a versioned
JSON content envelope:

```json
{
  "shellspanDocumentMessage": 1,
  "text": "Summarize this file",
  "documents": [
    { "id": "unique-id", "name": "notes.txt", "size": 5, "text": "Notes" }
  ]
}
```

The encoder emits the version property first. The decoder only recognizes that
prefix and validates every attachment; arbitrary JSON remains ordinary text.
The complete envelope travels through the existing message content transaction,
so draft navigation, queued submissions, failure restoration, images, persistence
and conversation replay retain the same attachment set. Queue editing changes only
the prompt. Session summaries use the prompt or file names. Conversation rendering
shows the prompt and attachment cards separately.
Native slash-skill detection examines only the envelope's user prompt; skill names
inside extracted document text are data and cannot invoke skills.

Providers receive this structured content in the user message through the existing
text protocol. No original document is uploaded to a provider Files API. This
keeps text-document support available across providers without claiming native
multimodal PDF support or OCR. Model context budgets still apply.

## Reference and verification

- [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs)
  describes inline file data and upload-then-reference `file_id` flows, with
  different document capabilities for Responses and Chat Completions.
- [DeepSeek upload file](https://api-docs.deepseek.com/api/create-file/)
  documents image uploads; it is not evidence of general document API support.
- `pnpm test:document-upload` exercises real PDF, DOCX, XLSX and text uploads,
  preview, submission, removal, failures and navigation in Chromium and WebKit at
  narrow and wide widths. It uses PDF-lib, ExcelJS and Mammoth's actual DOCX fixture.
