//! Only split a shell program when every command is a literal, linear command.
//! Parsing is for policy inspection only: execution always receives the original
//! script, preserving pipelines, short-circuiting and the shell's own semantics.
use tree_sitter::Parser;

pub(super) fn literal_command_chain(script: &str) -> Option<Vec<&str>> {
    // Bound parser work even when a caller reaches classification before validation.
    if script.len() > 8192 {
        return None;
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .ok()?;
    let tree = parser.parse(script, None)?;
    let root = tree.root_node();
    if root.has_error() {
        return None;
    }
    let mut stack = vec![root];
    let mut commands = Vec::new();
    while let Some(node) = stack.pop() {
        match node.kind() {
            "program" | "list" | "pipeline" => {
                let mut cursor = node.walk();
                let children: Vec<_> = node.children(&mut cursor).collect();
                for child in children.into_iter().rev() {
                    if child.is_named() {
                        stack.push(child);
                    } else if !matches!(child.kind(), ";" | "&&" | "||" | "|") {
                        return None;
                    }
                }
            }
            "command" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    let word = if child.kind() == "command_name" {
                        if child.named_child_count() != 1 {
                            return None;
                        }
                        child.named_child(0)?
                    } else {
                        child
                    };
                    if !matches!(word.kind(), "word" | "number") {
                        return None;
                    }
                    let text = &script[word.byte_range()];
                    // Exclude shell expansion, quoting, escape syntax and globs,
                    // even if the grammar represents one of them as a word.
                    if text.is_empty()
                        || !text
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_./-:=@,%+".contains(&c))
                    {
                        return None;
                    }
                }
                commands.push(&script[node.byte_range()]);
            }
            _ => return None,
        }
    }
    (!commands.is_empty()).then_some(commands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_every_literal_command_without_changing_execution_order() {
        assert_eq!(
            literal_command_chain("pwd\nls -la && printf ok | cat; rm ./old"),
            Some(vec!["pwd", "ls -la", "printf ok", "cat", "rm ./old"])
        );
    }

    #[test]
    fn complex_or_incomplete_shell_programs_are_never_split() {
        for script in [
            "echo $(pwd)",
            "echo $HOME",
            "echo *",
            "echo 'a; rm x'",
            "A=1 pwd",
            "pwd > output",
            "pwd & ls",
            "if true; then pwd; fi",
            "cat <<'EOF'\ntext\nEOF",
            "printf ok\n# comment\npwd",
            "echo \"unterminated",
            "echo \\x",
            "echo {a,b}",
        ] {
            assert_eq!(literal_command_chain(script), None, "{script}");
        }
    }
}
