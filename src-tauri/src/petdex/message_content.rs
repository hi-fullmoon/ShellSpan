//! The only content boundary for /bubble. No raw candidates, business identity,
//! or diagnostic formatting is exposed to transport.
use std::{collections::BTreeMap, sync::LazyLock};

use pulldown_cmark::{Event, LinkType, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

use super::{
    slots::{Content, MessageLocale},
    types::{ActivityKind, ActivityPhase, WaitReason},
};

pub(crate) const MAX_CANDIDATE_BYTES: usize = 32 * 1024;
pub(super) const TITLE_BYTES: usize = 96;
pub(super) const TEXT_BYTES: usize = 200;

#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MessagePreferences {
    pub petdex_messages_enabled: bool,
    pub petdex_message_details_enabled: bool,
}

// Already bounded and sanitized. Never Debug/Serialize or persisted.
#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct SafeDetails {
    title: Option<String>,
    final_reply: Option<String>,
}

impl SafeDetails {
    pub(crate) fn title(&mut self, candidate: &str) {
        self.title = safe_text(candidate, TITLE_BYTES, false);
    }

    pub(crate) fn file(&mut self, path: &str) {
        // Check the complete bounded field before deriving the basename.
        self.title = if acceptable(path) {
            path.rsplit(['/', '\\'])
                .find(|part| !part.is_empty())
                .filter(|part| !matches!(*part, "." | ".."))
                .and_then(|name| safe_text(name, TITLE_BYTES, false))
        } else {
            None
        };
    }

    pub(crate) fn final_reply(&mut self, candidate: &str) {
        self.final_reply = safe_text(candidate, TEXT_BYTES, true);
    }

    pub(super) fn clear_reply(&mut self) {
        self.final_reply = None;
    }
}

fn acceptable(value: &str) -> bool {
    if value.len() > MAX_CANDIDATE_BYTES {
        return false;
    }
    let lower = value.to_lowercase();
    !lower.contains("[redacted")
        && !lower.contains("private key")
        && !lower.contains("${{ secrets.")
        && crate::redaction::redact_sensitive_text(value) == value
        && serde_json::from_str::<serde_json::Value>(value)
            .map(|parsed| crate::redaction::redact_json_value(&parsed) == parsed)
            .unwrap_or(true)
}

fn block_boundary(tag: TagEnd) -> bool {
    !matches!(
        tag,
        TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript
            | TagEnd::Link
            | TagEnd::Image
    )
}

fn markdown_text(candidate: &str) -> Option<String> {
    let mut text = String::new();
    let mut excluded = 0usize;
    for event in Parser::new(candidate) {
        match event {
            Event::Start(tag) => {
                if excluded > 0
                    || matches!(
                        tag,
                        Tag::CodeBlock(_)
                            | Tag::HtmlBlock
                            | Tag::Image { .. }
                            | Tag::Link {
                                link_type: LinkType::Autolink | LinkType::Email,
                                ..
                            }
                    )
                {
                    excluded += 1;
                } else if block_boundary(tag.to_end()) {
                    text.push(' ');
                }
            }
            Event::End(tag) => {
                excluded = excluded.saturating_sub(1);
                if block_boundary(tag) {
                    text.push(' ');
                }
            }
            Event::Text(value) if excluded == 0 => text.push_str(&value),
            Event::SoftBreak | Event::HardBreak | Event::Rule if excluded == 0 => text.push(' '),
            // Inline HTML may hide script/style text. Conservatively fall back
            // rather than try to reconstruct HTML visibility by hand.
            Event::InlineHtml(_) => return None,
            // Inline code, HTML, math, images and link destinations never enter text.
            _ => {}
        }
    }
    if !acceptable(&text) {
        return None;
    }
    // CommonMark does not recognize bare URLs or URL-looking link labels.
    // Linkify supplies mature URL/email boundaries; do not hand-parse them.
    let finder = linkify::LinkFinder::new();
    let mut visible = String::new();
    let mut offset = 0;
    for link in finder.links(&text) {
        visible.push_str(&text[offset..link.start()]);
        visible.push(' ');
        offset = link.end();
    }
    visible.push_str(&text[offset..]);
    Some(visible)
}

fn direction_control(c: char) -> bool {
    matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

pub(super) fn valid(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() || direction_control(c) || matches!(c, '"' | '\\'))
        && acceptable(value)
}

fn safe_text(candidate: &str, limit: usize, markdown: bool) -> Option<String> {
    if !acceptable(candidate) {
        return None;
    }
    let text = if markdown {
        markdown_text(candidate)?
    } else {
        candidate.to_owned()
    };
    if !acceptable(&text) {
        return None;
    }
    let normalized: String = text
        .chars()
        .filter(|c| !direction_control(*c))
        .map(|c| match c {
            '"' => '”',
            '\\' => '＼',
            c if c.is_control() || c.is_whitespace() => ' ',
            c => c,
        })
        .collect();
    let mut normalized = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    // Normalization can join previously separated sensitive structures.
    if !acceptable(&normalized) {
        return None;
    }
    if normalized.len() > limit {
        let mut end = limit - '…'.len_utf8();
        while !normalized.is_char_boundary(end) {
            end -= 1;
        }
        normalized.truncate(end);
        normalized.push('…');
    }
    valid(&normalized, limit).then_some(normalized)
}

static TEMPLATES: LazyLock<BTreeMap<String, BTreeMap<String, String>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../src/locales/petdex-messages.json"))
        .expect("compiled Petdex message resource")
});

fn template(locale: MessageLocale, key: &str) -> &'static str {
    &TEMPLATES[match locale {
        MessageLocale::EnUs => "en-US",
        MessageLocale::ZhCn => "zh-CN",
    }][&format!("petdex.message.{key}")]
}

fn count(value: usize) -> String {
    if value > 99 {
        "99+".into()
    } else {
        value.to_string()
    }
}

fn stage(content: &Content) -> &'static str {
    match content.phase {
        ActivityPhase::Connecting => "connect",
        ActivityPhase::Connected => "connected",
        ActivityPhase::Waiting(WaitReason::Approval) => "approval",
        ActivityPhase::Waiting(WaitReason::Answer) => "answer",
        ActivityPhase::Succeeded => "succeeded",
        ActivityPhase::Failed => "failed",
        ActivityPhase::Cancelled => "cancelled",
        ActivityPhase::Running => match content.kind {
            ActivityKind::Connect => "connect",
            ActivityKind::Upload => "upload",
            ActivityKind::Download => "download",
            ActivityKind::Copy => "copy",
            ActivityKind::CrossCopy => "crossCopy",
            ActivityKind::AiPreparing => "aiPreparing",
            ActivityKind::Ai => "ai",
            ActivityKind::Tool(kind) => kind.template(),
        },
    }
}

/// Finite categories derived exclusively from a committed tool name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolStage {
    ReadFile,
    ListFiles,
    Search,
    WriteFile,
    EditFile,
    TrashFile,
    Command,
    ReadTerminal,
    WriteTerminal,
    WaitProcess,
    StopProcess,
    Inspect,
    Logs,
    Network,
    Transfer,
    Skill,
    Other,
}

impl ToolStage {
    pub(crate) fn from_name(name: &str) -> Self {
        match name {
            "read_file" => Self::ReadFile,
            "list_directory" => Self::ListFiles,
            "search_text" => Self::Search,
            "write_file" => Self::WriteFile,
            "edit_file" | "apply_patch" => Self::EditFile,
            "trash_file" => Self::TrashFile,
            "exec_command" | "terminal_execute" => Self::Command,
            "read_terminal" => Self::ReadTerminal,
            "write_terminal_input" | "write_stdin" => Self::WriteTerminal,
            "wait_terminal" | "wait_process" => Self::WaitProcess,
            "kill_process" => Self::StopProcess,
            "inspect_host" | "inspect_service" => Self::Inspect,
            "query_logs" => Self::Logs,
            "diagnose_endpoint" | "probe_http" => Self::Network,
            "transfer_file" => Self::Transfer,
            "skill" => Self::Skill,
            _ => Self::Other,
        }
    }
    fn template(self) -> &'static str {
        match self {
            Self::ReadFile => "readFile",
            Self::ListFiles => "listFiles",
            Self::Search => "search",
            Self::WriteFile => "writeFile",
            Self::EditFile => "editFile",
            Self::TrashFile => "trashFile",
            Self::Command => "command",
            Self::ReadTerminal => "readTerminal",
            Self::WriteTerminal => "writeTerminal",
            Self::WaitProcess => "waitProcess",
            Self::StopProcess => "stopProcess",
            Self::Inspect => "inspect",
            Self::Logs => "logs",
            Self::Network => "network",
            Self::Transfer => "transfer",
            Self::Skill => "skill",
            Self::Other => "tool",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct SafeMessage {
    title: String,
    text: String,
    busy: bool,
}

impl SafeMessage {
    pub(super) fn busy(&self) -> bool {
        self.busy
    }
    pub(super) fn from_content(content: &Content) -> Self {
        let locale = content.locale;
        let summary = content.owner_count > 1;
        let mut text = if summary {
            template(locale, "summary")
                .replace("{owners}", &count(content.owner_count))
                .replace("{runs}", &count(content.active_run_count))
        } else {
            template(locale, stage(content)).to_owned()
        };
        if !summary && content.active_run_count > 1 {
            text = template(locale, "activeCount")
                .replace("{stage}", &text)
                .replace("{runs}", &count(content.active_run_count));
        }
        let mut title = template(locale, "title").to_owned();
        if !summary {
            if let Some(detail) = &content.details.title {
                title.clone_from(detail);
            }
            if content.phase == ActivityPhase::Succeeded {
                if let Some(reply) = &content.details.final_reply {
                    text.clone_from(reply);
                }
            }
        }
        Self {
            title,
            text,
            busy: content.busy,
        }
    }

    pub(super) fn settled(locale: MessageLocale) -> Self {
        Self::fixed(locale, "settled")
    }
    pub(super) fn test(locale: MessageLocale) -> Self {
        Self::fixed(locale, "test")
    }
    fn fixed(locale: MessageLocale, key: &str) -> Self {
        Self {
            title: template(locale, "title").into(),
            text: template(locale, key).into(),
            busy: false,
        }
    }

    /// Call only with Installation::key. Compact encoding is required by 0.8.
    pub(super) fn encode(&self, key: &str) -> Option<Vec<u8>> {
        if key.is_empty()
            || key.len() > 64
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !valid(&self.title, TITLE_BYTES)
            || !valid(&self.text, TEXT_BYTES)
        {
            return None;
        }
        #[derive(Serialize)]
        struct Request<'a> {
            conversation_key: &'a str,
            agent_source: &'static str,
            title: &'a str,
            text: &'a str,
            busy: bool,
        }
        serde_json::to_vec(&Request {
            conversation_key: key,
            agent_source: "shellspan",
            title: &self.title,
            text: &self.text,
            busy: self.busy,
        })
        .ok()
    }
}

#[cfg(test)]
mod tests;
