use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, fs::File, io::Read, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_file_bytes: u64,
    max_batch_bytes: u64,
    max_files: usize,
    max_characters: usize,
    document_extensions: Vec<String>,
    text_extensions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMessage {
    shellspan_document_message: u8,
    text: String,
    documents: Vec<DocumentPart>,
}

#[derive(Deserialize)]
struct DocumentPart {
    id: String,
    name: String,
    size: u64,
    text: String,
}

/// Slash commands are user gestures. Extracted document text must never invoke them.
pub(crate) fn user_prompt(content: &str) -> Cow<'_, str> {
    let plain = Cow::Borrowed(content);
    if !content.starts_with("{\"shellspanDocumentMessage\":1,")
        || content.len() > crate::agent_runtime::MAX_AGENT_MESSAGE_BYTES
    {
        return plain;
    }
    let Ok(message) = serde_json::from_str::<DocumentMessage>(content) else {
        return plain;
    };
    let Ok(limits) =
        serde_json::from_str::<Limits>(include_str!("../../src/lib/ai/document-contract.json"))
    else {
        return plain;
    };
    if message.shellspan_document_message != 1
        || message.documents.is_empty()
        || message.documents.len() > limits.max_files
    {
        return plain;
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0;
    for document in &message.documents {
        let extension = document
            .name
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if document.id.is_empty()
            || document.id.len() > 100
            || !ids.insert(&document.id)
            || document.name.encode_utf16().count() > 255
            || (!limits.document_extensions.contains(&extension)
                && !limits.text_extensions.contains(&extension))
            || document.size == 0
            || document.size > limits.max_file_bytes
            || document.text.trim().is_empty()
            || document.text.encode_utf16().count() > limits.max_characters
        {
            return plain;
        }
        total += document.size;
    }
    if total > limits.max_batch_bytes {
        return plain;
    }
    Cow::Owned(message.text)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentFile {
    name: String,
    data: String,
}

fn read_attachment(path: &Path) -> Result<AttachmentFile, String> {
    let limits: Limits =
        serde_json::from_str(include_str!("../../src/lib/ai/document-contract.json"))
            .map_err(|_| "DOCUMENT_INVALID")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("DOCUMENT_FORMAT")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !limits.document_extensions.contains(&extension)
        && !limits.text_extensions.contains(&extension)
    {
        return Err("DOCUMENT_FORMAT".into());
    }
    if !path.is_absolute() {
        return Err("DOCUMENT_INVALID".into());
    }
    // Inspect before opening so directories and special devices are never read.
    let metadata = std::fs::metadata(path).map_err(|_| "DOCUMENT_INVALID")?;
    if !metadata.is_file() {
        return Err("DOCUMENT_INVALID".into());
    }
    if metadata.len() > limits.max_file_bytes {
        return Err("DOCUMENT_SIZE_LIMIT".into());
    }
    let file = File::open(path).map_err(|_| "DOCUMENT_INVALID")?;
    if !file.metadata().map_err(|_| "DOCUMENT_INVALID")?.is_file() {
        return Err("DOCUMENT_INVALID".into());
    }
    let mut bytes = Vec::new();
    file.take(limits.max_file_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "DOCUMENT_INVALID")?;
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err("DOCUMENT_SIZE_LIMIT".into());
    }
    if bytes.is_empty() {
        return Err("DOCUMENT_EMPTY".into());
    }
    Ok(AttachmentFile {
        name: name.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub(crate) async fn read_ai_attachment(path: String) -> Result<AttachmentFile, String> {
    tauri::async_runtime::spawn_blocking(move || read_attachment(Path::new(&path)))
        .await
        .map_err(|_| "DOCUMENT_INVALID".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_prompt_leaves_plain_and_invalid_json_unchanged() {
        for content in [
            "/review notes",
            r#"{"text":"/review"}"#,
            r#"{"shellspanDocumentMessage":1,"text":"/review","documents":[{}]}"#,
        ] {
            assert_eq!(user_prompt(content), content);
        }
    }

    #[test]
    fn document_contract_matches_runtime_message_limit() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/ai/document-contract.json")).unwrap();
        assert_eq!(
            contract["maxMessageBytes"].as_u64().unwrap() as usize,
            crate::agent_runtime::MAX_AGENT_MESSAGE_BYTES
        );
    }

    #[test]
    fn reads_complete_text_beyond_preview_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large.TXT");
        let bytes = "文档内容".repeat(30000).into_bytes();
        std::fs::write(&path, &bytes).unwrap();
        let result = read_attachment(&path).unwrap();
        assert_eq!(result.name, "large.TXT");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result.data)
                .unwrap(),
            bytes
        );
    }

    #[test]
    fn rejects_empty_oversized_unsupported_and_directory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file.txt");
        let file = File::create(&path).unwrap();
        assert_eq!(read_attachment(&path).err().unwrap(), "DOCUMENT_EMPTY");
        file.set_len(8388609).unwrap();
        assert_eq!(read_attachment(&path).err().unwrap(), "DOCUMENT_SIZE_LIMIT");
        assert_eq!(
            read_attachment(&directory.path().join("file.exe"))
                .err()
                .unwrap(),
            "DOCUMENT_FORMAT"
        );
        let folder = directory.path().join("folder.pdf");
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(read_attachment(&folder).err().unwrap(), "DOCUMENT_INVALID");
        assert_eq!(
            read_attachment(Path::new("relative.txt")).err().unwrap(),
            "DOCUMENT_INVALID"
        );
    }
}
