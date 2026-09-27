//! Inspect statically resolvable destructive commands without executing shell code.
//! Tree-sitter owns syntax and control flow; shlex owns quote/escape decoding.
use std::path::{Component, Path, PathBuf};
use tree_sitter::{Node, Parser};

type Cwds = Vec<Option<PathBuf>>;
struct Flow {
    success: Cwds,
    failure: Cwds,
}

pub(super) fn reject_destructive(script: &str, cwd: Option<&str>) -> Result<(), String> {
    if script.len() > 8192 {
        return Err("native command exceeds the inspection limit".into());
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|_| "native command parser is unavailable".to_string())?;
    let tree = parser
        .parse(script, None)
        .ok_or("native command parser is unavailable")?;
    let initial = vec![cwd.and_then(|path| resolve_path(path, None))];
    inspect(tree.root_node(), script, initial, 0)?;
    Ok(())
}

fn inspect(node: Node<'_>, script: &str, input: Cwds, depth: usize) -> Result<Flow, String> {
    check_depth(depth)?;
    let children: Vec<_> = node.named_children(&mut node.walk()).collect();
    match node.kind() {
        "program" | "compound_statement" | "do_group" => {
            sequence(&children, script, input, depth + 1)
        }
        "redirected_statement" => {
            if let Some(body) = node.child_by_field_name("body") {
                let result = inspect(body, script, input.clone(), depth + 1)?;
                Ok(Flow {
                    success: result.success,
                    failure: union(result.failure, input)?,
                })
            } else {
                Ok(Flow {
                    success: input.clone(),
                    failure: input,
                })
            }
        }
        "if_statement" | "elif_clause" => {
            let mut cursor = node.walk();
            let condition: Vec<_> = node
                .children(&mut cursor)
                .enumerate()
                .filter_map(|(index, child)| {
                    (node.field_name_for_child(index as u32) == Some("condition")).then_some(child)
                })
                .collect();
            let condition_flow = sequence(&condition, script, input, depth + 1)?;
            let body: Vec<_> = children
                .iter()
                .copied()
                .filter(|child| {
                    !condition.contains(child)
                        && !matches!(child.kind(), "else_clause" | "elif_clause")
                })
                .collect();
            let branch = sequence(&body, script, condition_flow.success, depth + 1)?;
            let alternative = children
                .iter()
                .find(|child| matches!(child.kind(), "else_clause" | "elif_clause"));
            let other = if let Some(alternative) = alternative {
                if alternative.kind() == "else_clause" {
                    let body: Vec<_> = alternative
                        .named_children(&mut alternative.walk())
                        .collect();
                    sequence(&body, script, condition_flow.failure, depth + 1)?
                } else {
                    inspect(*alternative, script, condition_flow.failure, depth + 1)?
                }
            } else {
                Flow {
                    success: condition_flow.failure,
                    failure: Vec::new(),
                }
            };
            Ok(Flow {
                success: union(branch.success, other.success)?,
                failure: union(branch.failure, other.failure)?,
            })
        }
        "list" if children.len() == 2 => {
            let left = inspect(children[0], script, input, depth + 1)?;
            let operator = node
                .children(&mut node.walk())
                .find(|child| matches!(child.kind(), "&&" | "||"));
            match operator.map(|operator| operator.kind()) {
                Some("&&") => {
                    let right = inspect(children[1], script, left.success, depth + 1)?;
                    Ok(Flow {
                        success: right.success,
                        failure: union(left.failure, right.failure)?,
                    })
                }
                Some("||") => {
                    let right = inspect(children[1], script, left.failure, depth + 1)?;
                    Ok(Flow {
                        success: union(left.success, right.success)?,
                        failure: right.failure,
                    })
                }
                _ => inspect(
                    children[1],
                    script,
                    union(left.success, left.failure)?,
                    depth + 1,
                ),
            }
        }
        "subshell" => {
            sequence(&children, script, input.clone(), depth + 1)?;
            Ok(Flow {
                success: input.clone(),
                failure: input,
            })
        }
        "pipeline" => {
            for child in children {
                inspect(child, script, input.clone(), depth + 1)?;
            }
            Ok(Flow {
                success: input.clone(),
                failure: input,
            })
        }
        "command" => {
            let words: Vec<_> = children
                .iter()
                .filter(|child| child.kind() != "variable_assignment")
                .map(|child| static_word(*child, script))
                .collect();
            let borrowed: Vec<_> = words
                .iter()
                .map(|word| word.as_deref().unwrap_or("<dynamic>"))
                .collect();
            if let Some(index) = super::effect::segment_executable_index(&borrowed) {
                let executable = borrowed[index].rsplit('/').next().unwrap_or_default();
                if executable == "mkfs" || executable.starts_with("mkfs.") || executable == "wipefs"
                {
                    return Err("AGENT_CRITICAL_OPERATION_DENIED: disk formatting and filesystem wiping are not available to the Agent".into());
                }
                if matches!(executable, "rm" | "rmdir" | "unlink") {
                    for path in words[index + 1..]
                        .iter()
                        .flatten()
                        .filter(|arg| !arg.starts_with('-'))
                    {
                        for cwd in &input {
                            if resolve_path(path, cwd.as_deref()).is_some_and(|path| {
                                super::protected_delete_path_native(&path.to_string_lossy())
                            }) {
                                return Err("AGENT_CRITICAL_OPERATION_DENIED: deleting a system resource is blocked; do not retry through a different tool or script".into());
                            }
                        }
                    }
                }
                // Only a shell builtin can change this shell's cwd. sudo/env
                // wrappers execute another process and must not change it here.
                if executable == "cd" && (index == 0 || borrowed.first() == Some(&"command")) {
                    let destination = match &borrowed[index + 1..] {
                        [path] if !path.starts_with('-') && *path != "<dynamic>" => Some(*path),
                        ["--", path] if *path != "<dynamic>" => Some(*path),
                        _ => None,
                    };
                    let success = input
                        .iter()
                        .map(|cwd| destination.and_then(|path| resolve_path(path, cwd.as_deref())))
                        .collect();
                    return Ok(Flow {
                        success,
                        failure: input,
                    });
                }
            }
            // Inspect substitutions too, but their cwd never propagates out.
            for child in children {
                inspect_nested(child, script, &input, depth + 1)?;
            }
            Ok(Flow {
                success: input.clone(),
                failure: input,
            })
        }
        "comment" => Ok(Flow {
            success: input.clone(),
            failure: input,
        }),
        _ => {
            // Unknown control flow must not hide absolute destructive commands.
            // Do not infer a cwd transition between mutually exclusive branches.
            for child in children {
                inspect(child, script, input.clone(), depth + 1)?;
            }
            Ok(Flow {
                success: union(input.clone(), vec![None])?,
                failure: input,
            })
        }
    }
}

fn inspect_nested(node: Node<'_>, script: &str, input: &Cwds, depth: usize) -> Result<(), String> {
    check_depth(depth)?;
    if matches!(
        node.kind(),
        "command" | "command_substitution" | "process_substitution" | "subshell"
    ) {
        inspect(node, script, input.clone(), depth + 1)?;
    } else {
        for child in node.named_children(&mut node.walk()) {
            inspect_nested(child, script, input, depth + 1)?;
        }
    }
    Ok(())
}

fn sequence(
    nodes: &[Node<'_>],
    script: &str,
    mut input: Cwds,
    depth: usize,
) -> Result<Flow, String> {
    check_depth(depth)?;
    let mut last = Flow {
        success: input.clone(),
        failure: input.clone(),
    };
    for node in nodes {
        last = inspect(*node, script, input, depth + 1)?;
        input = union(last.success.clone(), last.failure.clone())?;
    }
    Ok(last)
}

fn check_depth(depth: usize) -> Result<(), String> {
    if depth > 128 {
        Err("AGENT_CRITICAL_OPERATION_DENIED: command inspection depth exceeded".into())
    } else {
        Ok(())
    }
}

fn union(mut left: Cwds, right: Cwds) -> Result<Cwds, String> {
    for cwd in right {
        if !left.contains(&cwd) {
            left.push(cwd);
        }
    }
    if left.len() > 64 {
        return Err("AGENT_CRITICAL_OPERATION_DENIED: command directory scope exceeds the native inspection limit".into());
    }
    Ok(left)
}

fn static_word(node: Node<'_>, script: &str) -> Option<String> {
    fn literal(node: Node<'_>, script: &str) -> bool {
        match node.kind() {
            "raw_string" | "number" | "string_content" => true,
            "word" => {
                !script[node.byte_range()].contains(['$', '`', '*', '?', '[', ']', '{', '}', '~'])
            }
            "command_name" | "string" | "concatenation" => node
                .named_children(&mut node.walk())
                .all(|child| literal(child, script)),
            _ => false,
        }
    }
    if !literal(node, script) {
        return None;
    }
    let mut words = shlex::split(&script[node.byte_range()])?;
    if words.len() != 1 {
        return None;
    }
    words.pop()
}

fn resolve_path(value: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let path = Path::new(value);
    let joined = if path.has_root() {
        path.to_path_buf()
    } else {
        cwd?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            _ => resolved.push(component.as_os_str()),
        }
    }
    resolved.has_root().then_some(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_escaped_and_relative_protected_paths_are_rejected_without_execution() {
        for command in [
            "rm -rf \"/etc\"",
            "rm -rf '/etc'",
            "rm /et\"c\"/hosts",
            "rm /etc\\/hosts",
            "cd /etc && rm -rf ./ssh",
            "cd '/etc' && rm ssh",
            "cd /tmp && rm ../etc/hosts",
            "sudo rm -rf \"/etc\"",
            "echo \"$VALUE\"; rm /etc/hosts",
            "rm \"$DYNAMIC\" '/etc/hosts'",
            "(cd /etc && rm ssh)",
            "rm /tmp/../etc/hosts",
            "mkfs.ext4 /dev/sda",
            "LC_ALL=C rm -rf '/etc'",
            "cd /etc >/dev/null && rm ./hosts",
            "if true; then cd /etc; rm hosts; fi",
            "for item in one; do cd /etc && rm hosts; done",
        ] {
            assert!(
                reject_destructive(command, Some("/workspace")).is_err(),
                "{command}"
            );
        }
        assert!(reject_destructive("rm ./hosts", Some("/etc")).is_err());
        assert!(reject_destructive("cd /etc && rm hosts", None).is_err());
    }

    #[test]
    fn control_flow_and_quoted_data_do_not_create_false_deletion_targets() {
        for (command, cwd) in [
            ("echo 'rm -rf /etc'", "/workspace"),
            ("rm './old file.txt'", "/workspace"),
            ("cd /tmp && rm ./old", "/etc"),
            ("cd /etc || rm ./old", "/workspace"),
            ("(cd /etc); rm ./old", "/workspace"),
            ("cd /etc | rm ./old", "/workspace"),
            ("cat '/etc/hosts'", "/workspace"),
            (
                "if test -f marker; then cd /etc; else rm ./old; fi",
                "/workspace",
            ),
        ] {
            assert!(reject_destructive(command, Some(cwd)).is_ok(), "{command}");
        }
    }

    #[test]
    fn deeply_nested_input_is_bounded() {
        let script = format!("{}pwd{}", "(".repeat(200), ")".repeat(200));
        assert!(reject_destructive(&script, Some("/workspace"))
            .unwrap_err()
            .contains("inspection depth"));
    }
}
