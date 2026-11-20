use super::Database;
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnippetInput {
    name: String,
    group_name: String,
    tags: Vec<String>,
    command_template: String,
    description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandSnippet {
    id: String,
    #[serde(flatten)]
    input: SnippetInput,
    created_at: i64,
    updated_at: i64,
}

fn read_snippet(row: &Row<'_>) -> rusqlite::Result<CommandSnippet> {
    let tags: String = row.get(3)?;
    Ok(CommandSnippet {
        id: row.get(0)?,
        input: SnippetInput {
            name: row.get(1)?,
            group_name: row.get(2)?,
            tags: serde_json::from_str(&tags).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?,
            command_template: row.get(4)?,
            description: row.get(5)?,
        },
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

impl Database {
    pub(crate) fn list_command_snippets(&self) -> Result<Vec<CommandSnippet>, String> {
        let conn = self.conn.lock().map_err(|_| "database lock unavailable")?;
        let mut query = conn.prepare(
            "SELECT id,name,group_name,tags_json,command_template,description,created_at,updated_at
             FROM command_snippets ORDER BY group_name COLLATE NOCASE,name COLLATE NOCASE,id",
        ).map_err(|error| error.to_string())?;
        let rows = query
            .query_map([], read_snippet)
            .map_err(|error| error.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn save_command_snippet(
        &self,
        id: Option<String>,
        input: SnippetInput,
    ) -> Result<CommandSnippet, String> {
        let valid =
            |text: &str, limit: usize| text.len() <= limit && !text.chars().any(char::is_control);
        if input.name.trim().is_empty()
            || !valid(&input.name, 512)
            || !valid(&input.group_name, 512)
            || !valid(&input.description, 2048)
            || input.command_template.trim().is_empty()
            || !valid(&input.command_template, 16_384)
            || input.tags.len() > 32
            || input
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || !valid(tag, 256))
        {
            return Err("TERMINAL_SNIPPET_INVALID".into());
        }
        let tags = serde_json::to_string(&input.tags).map_err(|error| error.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let conn = self.conn.lock().map_err(|_| "database lock unavailable")?;
        let editing = id.is_some();
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let statement = if editing {
            "UPDATE command_snippets SET name=?2,group_name=?3,tags_json=?4,command_template=?5,description=?6,updated_at=?7
             WHERE id=?1 RETURNING created_at"
        } else {
            "INSERT INTO command_snippets (id,name,group_name,tags_json,command_template,description,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?7) RETURNING created_at"
        };
        let created_at = conn
            .query_row(
                statement,
                params![
                    id,
                    input.name,
                    input.group_name,
                    tags,
                    input.command_template,
                    input.description,
                    now
                ],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(CommandSnippet {
            id,
            input,
            created_at,
            updated_at: now,
        })
    }

    pub(crate) fn delete_command_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "database lock unavailable")?;
        conn.execute("DELETE FROM command_snippets WHERE id=?1", [id])
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_can_be_created_listed_edited_and_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(&directory.path().join("snippets.db")).unwrap();
        let input = SnippetInput {
            name: "Check directory".into(),
            group_name: "Terminal".into(),
            tags: vec!["shell".into()],
            command_template: "ls -la {{directory:.}}".into(),
            description: String::new(),
        };
        let saved = db.save_command_snippet(None, input).unwrap();
        let id = saved.id;
        let mut input = db.list_command_snippets().unwrap().pop().unwrap().input;
        assert_eq!(input.tags, ["shell"]);
        input.name = "List directory".into();
        let updated = db.save_command_snippet(Some(id.clone()), input).unwrap();
        assert_eq!(updated.created_at, saved.created_at);
        assert_eq!(
            db.list_command_snippets().unwrap()[0].input.name,
            "List directory"
        );
        db.delete_command_snippet(&id).unwrap();
        assert!(db.list_command_snippets().unwrap().is_empty());
    }
}
