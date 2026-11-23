//! Inspect statically resolvable destructive commands without executing shell code.
//! Tree-sitter owns syntax and control flow; shlex owns quote/escape decoding.
use std::path::{Component, Path, PathBuf};
use tree_sitter::{Node, Parser};

type Cwds = Vec<Option<PathBuf>>;
struct Flow {
    success: Cwds,
    failure: Cwds,
}

pub(crate) fn reject_destructive(script: &str, cwd: Option<&str>) -> Result<(), String> {
    if script.len() > 8192 {
        return Err("native command exceeds the inspection limit".into());
    }
    if sudo_policy_reference(script) {
        return Err(SUDO_POLICY_DENIED.into());
    }
    let tree = parse_shell(script)?;
    let initial = vec![cwd.and_then(|path| resolve_path(path, None))];
    inspect(tree.root_node(), script, initial, 0)?;
    Ok(())
}

pub(crate) const SUDO_POLICY_DENIED: &str =
    "AGENT_SUDO_POLICY_DENIED: sudoers and visudo are reserved for the host administrator; do not change or request changes to sudo policy as a workaround";

pub(crate) fn sudo_policy_reference(value: &str) -> bool {
    value
        .split(|c: char| !(c.is_alphanumeric() || matches!(c, '.' | '_' | '-')))
        .any(|part| {
            part.eq_ignore_ascii_case("sudoers")
                || part.eq_ignore_ascii_case("sudoers.d")
                || part.eq_ignore_ascii_case("visudo")
        })
}

fn subshell_script_argument<'a>(borrowed: &[&'a str], index: usize) -> Option<&'a str> {
    if !borrowed.get(index).is_some_and(|word| {
        matches!(
            word.rsplit('/').next(),
            Some("sh" | "bash" | "zsh" | "dash" | "ksh")
        )
    }) {
        return None;
    }
    let args = &borrowed[index + 1..];
    let mut pos = 0;
    let mut saw_c = false;
    while let Some(arg) = args.get(pos) {
        if *arg == "--" || *arg == "-" {
            pos += 1;
            break;
        }
        if matches!(*arg, "-o" | "+o" | "-O" | "+O" | "--rcfile" | "--init-file") {
            pos += 2;
            continue;
        }
        if arg.starts_with("--") {
            pos += 1;
            continue;
        }
        if (arg.starts_with('-') || arg.starts_with('+'))
            && arg.len() > 1
            && arg[1..].bytes().all(|byte| byte.is_ascii_alphabetic())
        {
            if arg.starts_with('-') && arg[1..].contains('c') {
                saw_c = true;
            }
            if arg.ends_with('o') || arg.ends_with('O') {
                pos += 2;
            } else {
                pos += 1;
            }
            continue;
        }
        break;
    }
    if !saw_c {
        return None;
    }
    args.get(pos)
        .copied()
        .filter(|candidate| *candidate != "<dynamic>")
}

fn env_split_string_scripts(borrowed: &[&str]) -> Vec<String> {
    let mut scripts = Vec::new();
    let mut pos = 0;
    while pos < borrowed.len() {
        let base = borrowed[pos].rsplit('/').next().unwrap_or_default();
        if base == "env" {
            let mut cursor = pos + 1;
            while let Some(arg) = borrowed.get(cursor) {
                if *arg == "--" {
                    break;
                }
                if *arg == "-S" || arg.eq_ignore_ascii_case("--split-string") {
                    if let Some(value) = borrowed
                        .get(cursor + 1)
                        .copied()
                        .filter(|candidate| *candidate != "<dynamic>")
                    {
                        scripts.push(value.to_string());
                    }
                    cursor += 2;
                } else if let Some(value) = arg
                    .strip_prefix("-S")
                    .filter(|rest| !rest.is_empty() && *rest != "<dynamic>")
                {
                    scripts.push(value.to_string());
                    cursor += 1;
                } else if let Some(value) = arg
                    .strip_prefix("--split-string=")
                    .filter(|rest| !rest.is_empty() && *rest != "<dynamic>")
                {
                    scripts.push(value.to_string());
                    cursor += 1;
                } else if matches!(*arg, "-C" | "-u")
                    || arg.eq_ignore_ascii_case("--chdir")
                    || arg.eq_ignore_ascii_case("--unset")
                {
                    cursor += 2;
                } else if arg.starts_with('-') || arg.contains('=') {
                    cursor += 1;
                } else {
                    break;
                }
            }
            pos = cursor;
        } else {
            pos += 1;
        }
    }
    scripts
}

fn nested_command_scripts(borrowed: &[&str], index: Option<usize>) -> Vec<String> {
    let mut scripts = env_split_string_scripts(borrowed);
    if let Some(index) = index {
        if let Some(sub_script) = subshell_script_argument(borrowed, index) {
            scripts.push(sub_script.to_string());
        }
        if borrowed
            .get(index)
            .is_some_and(|word| word.rsplit('/').next() == Some("eval"))
        {
            let mut args = &borrowed[index + 1..];
            if args.first() == Some(&"--") {
                args = &args[1..];
            }
            let joined = args
                .iter()
                .copied()
                .filter(|arg| *arg != "<dynamic>")
                .collect::<Vec<_>>()
                .join(" ");
            if !joined.trim().is_empty() {
                scripts.push(joined);
            }
        }
    }
    scripts
}

fn redirect_references_sudo_policy(node: Node<'_>, script: &str) -> bool {
    if static_word(node, script).is_some_and(|word| sudo_policy_reference(&word)) {
        return true;
    }
    for child in node.named_children(&mut node.walk()) {
        if redirect_references_sudo_policy(child, script) {
            return true;
        }
    }
    false
}

fn parse_shell(script: &str) -> Result<tree_sitter::Tree, String> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|_| "native command parser is unavailable".to_string())?;
    parser
        .parse(script, None)
        .ok_or_else(|| "native command parser is unavailable".into())
}

pub(crate) fn literal_sudo_command(script: &str) -> Result<String, String> {
    const INVALID: &str =
        "AGENT_SUDO_INVALID_COMMAND: use one absolute executable path with literal arguments";
    if script.len() > 2048 || script.chars().any(char::is_control) {
        return Err(INVALID.into());
    }
    let tree = parse_shell(script)?;
    let root = tree.root_node();
    let command = root
        .child(0)
        .filter(|node| !root.has_error() && root.child_count() == 1 && node.kind() == "command")
        .ok_or(INVALID)?;
    let words = command
        .children(&mut command.walk())
        .map(|node| static_word(node, script).ok_or(INVALID))
        .collect::<Result<Vec<_>, _>>()?;
    let executable = words.first().ok_or(INVALID)?;
    if !executable
        .strip_prefix('/')
        .is_some_and(|path| path.split('/').all(|part| !matches!(part, "" | "." | "..")))
        || privilege_program(executable)
    {
        return Err(INVALID.into());
    }
    let canonical = shlex::try_join(words.iter().map(String::as_str)).map_err(|_| INVALID)?;
    if canonical.len() > 2048 {
        return Err(INVALID.into());
    }
    reject_destructive(&canonical, None)?;
    reject_remote_privilege_command(&canonical)?;
    Ok(canonical)
}

pub(crate) const REMOTE_PRIVILEGE_DENIED: &str =
    "AGENT_REMOTE_PRIVILEGE_DENIED: use a sudoOperationId configured for this SSH profile; ordinary Agent shell calls and input cannot start privilege tools";

fn privilege_program(word: &str) -> bool {
    matches!(
        word.rsplit('/').next(),
        Some("sudo" | "sudoedit" | "su" | "doas" | "pkexec" | "runuser")
    )
}

pub(crate) fn reject_remote_privilege_command(script: &str) -> Result<(), String> {
    fn inspect(node: Node<'_>, script: &str, depth: usize) -> Result<(), String> {
        check_depth(depth)?;
        if node.kind() == "command" {
            let words: Vec<_> = node
                .named_children(&mut node.walk())
                .filter(|child| child.kind() != "variable_assignment")
                .map(|child| static_word(child, script))
                .collect();
            let borrowed: Vec<_> = words
                .iter()
                .map(|word| word.as_deref().unwrap_or("<dynamic>"))
                .collect();
            let exec_index = super::effect::segment_executable_index(&borrowed);
            let index = exec_index.unwrap_or(borrowed.len());
            if borrowed
                .iter()
                .take(index.saturating_add(1))
                .any(|word| privilege_program(word))
            {
                return Err(REMOTE_PRIVILEGE_DENIED.into());
            }
            for sub_script in nested_command_scripts(&borrowed, exec_index) {
                let tree = parse_shell(&sub_script)?;
                inspect(tree.root_node(), &sub_script, depth + 1)?;
            }
        }
        for child in node.named_children(&mut node.walk()) {
            inspect(child, script, depth + 1)?;
        }
        Ok(())
    }
    let tree = parse_shell(script)?;
    inspect(tree.root_node(), script, 0)
}

fn inspect(node: Node<'_>, script: &str, input: Cwds, depth: usize) -> Result<Flow, String> {
    check_depth(depth)?;
    let children: Vec<_> = node.named_children(&mut node.walk()).collect();
    match node.kind() {
        "program" | "compound_statement" | "do_group" => {
            sequence(&children, script, input, depth + 1)
        }
        "redirected_statement" => {
            let body = node.child_by_field_name("body");
            for child in &children {
                if body.is_some_and(|body| body.id() == child.id()) {
                    continue;
                }
                if redirect_references_sudo_policy(*child, script) {
                    return Err(SUDO_POLICY_DENIED.into());
                }
                inspect_nested(*child, script, &input, depth + 1)?;
            }
            if let Some(body) = body {
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
            if words
                .iter()
                .flatten()
                .any(|word| sudo_policy_reference(word))
            {
                return Err(SUDO_POLICY_DENIED.into());
            }
            let borrowed: Vec<_> = words
                .iter()
                .map(|word| word.as_deref().unwrap_or("<dynamic>"))
                .collect();
            let exec_index = super::effect::segment_executable_index(&borrowed);
            for sub_script in nested_command_scripts(&borrowed, exec_index) {
                if sudo_policy_reference(&sub_script) {
                    return Err(SUDO_POLICY_DENIED.into());
                }
                let tree = parse_shell(&sub_script)?;
                inspect(tree.root_node(), &sub_script, input.clone(), depth + 1)?;
            }
            if let Some(index) = exec_index {
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
                                super::call_policy::hard_delete_path_native(&path.to_string_lossy())
                            }) {
                                return Err("AGENT_CRITICAL_OPERATION_DENIED: deleting a whole protected system tree or kernel resource is blocked; do not retry through a different tool or script".into());
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
    fn administrator_can_configure_an_absolute_program_with_literal_arguments() {
        let command = "/usr/local/sbin/check-backup 'weekly primary'";
        let canonical = literal_sudo_command(command).unwrap();
        assert_eq!(
            shlex::split(&canonical).unwrap(),
            ["/usr/local/sbin/check-backup", "weekly primary"]
        );
        for command in [
            "check-backup weekly",
            "/usr/bin/sudo /usr/local/sbin/check-backup",
            "/usr/local/sbin/check-backup && /bin/pwd",
            "/usr/local/sbin/check-backup >test.log",
            "/usr/local/sbin/check-backup $(pwd)",
            "/usr/local/sbin/check-backup /var/backups/*",
            "LANG=C /usr/local/sbin/check-backup",
            "/usr/local/sbin/check-backup &",
            "/usr/local/../bin/check-backup",
            "/usr/bin/install /tmp/rule /etc/sudoers.d/rule",
        ] {
            assert!(literal_sudo_command(command).is_err(), "{command}");
        }
    }

    #[test]
    fn ordinary_remote_commands_cannot_invoke_privilege_programs() {
        for command in [
            "sudo -n systemctl restart nginx",
            "/usr/bin/sudo nginx -t",
            "env LC_ALL=C sudo nginx -t",
            "sh -c 'sudo nginx -t'",
            "bash -ec 'sudo nginx -t'",
            "echo ok; doas nginx -t",
        ] {
            assert_eq!(
                reject_remote_privilege_command(command).unwrap_err(),
                REMOTE_PRIVILEGE_DENIED
            );
        }
        assert!(reject_remote_privilege_command("rg sudo /var/log/messages").is_ok());
        assert!(reject_remote_privilege_command("systemctl is-active nginx").is_ok());
    }

    #[test]
    fn explicit_sudo_policy_edits_are_rejected() {
        for command in [
            "sudo /usr/sbin/visudo",
            "printf 'rule' | sudo tee /etc/sudoers.d/temporary",
            "rm /etc/su\"do\"ers",
            "sudo sh -c 'printf rule >> /etc/sudoers'",
        ] {
            assert_eq!(
                reject_destructive(command, None).unwrap_err(),
                SUDO_POLICY_DENIED
            );
        }
        assert!(reject_destructive("sudo -n systemctl restart nginx", None).is_ok());
    }

    #[test]
    fn quoted_escaped_and_relative_resources_follow_normal_approval() {
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
            let hard_denied = matches!(
                command,
                "rm -rf \"/etc\""
                    | "rm -rf '/etc'"
                    | "sudo rm -rf \"/etc\""
                    | "LC_ALL=C rm -rf '/etc'"
                    | "mkfs.ext4 /dev/sda"
            );
            assert_eq!(
                reject_destructive(command, Some("/workspace")).is_err(),
                hard_denied,
                "{command}"
            );
        }
        assert!(reject_destructive("rm ./hosts", Some("/etc")).is_ok());
        assert!(reject_destructive("cd /etc && rm hosts", None).is_ok());
        for command in [
            "cd /usr && rm -rf local",
            "rm /tmp/../etc",
            "rm -rf /proc/1",
            "rm -rf /usr/local/bin",
        ] {
            assert!(reject_destructive(command, None).is_err(), "{command}");
        }
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

    #[test]
    fn subshell_scripts_and_case_variants_cannot_bypass_guards() {
        for command in [
            "sh -c 'rm -rf /'",
            "bash -lc 'mkfs.ext4 /dev/sda'",
            "zsh -c -- 'rm -rf /etc'",
            "cat /etc/SUDOERS",
            "sh -c 'cat /etc/sudoers'",
        ] {
            assert!(
                reject_destructive(command, Some("/workspace")).is_err(),
                "{command}"
            );
        }
        for command in ["sh -c -- 'sudo id'", "bash -lc -- 'doas id'"] {
            assert!(
                reject_remote_privilege_command(command).is_err(),
                "{command}"
            );
        }
    }

    #[test]
    fn wrapper_subshell_eval_env_and_redirect_bypasses_are_rejected() {
        for command in [
            "exec -a ls rm -rf /",
            "sh -c -e 'rm -rf /'",
            "bash -c -l 'mkfs.ext4 /dev/sda'",
            "zsh -c -f 'rm -rf /etc'",
            "bash -c -o errexit 'rm -rf /'",
            "env -S 'rm -rf /'",
            "env --split-string='rm -rf /etc'",
            "eval 'rm -rf /'",
            "builtin eval 'rm -rf /etc'",
            "printf rule >> /etc/su\"do\"ers",
            "echo ok > $(rm -rf /)",
            "cat < <(mkfs.ext4 /dev/sda)",
        ] {
            assert!(
                reject_destructive(command, Some("/workspace")).is_err(),
                "{command}"
            );
        }
        for command in [
            "exec -a ls sudo id",
            "sh -c -e 'sudo id'",
            "bash -c -l 'doas id'",
            "zsh -c -f 'sudo id'",
            "env -S 'sudo id'",
            "eval 'sudo id'",
            "builtin eval 'sudo id'",
        ] {
            assert_eq!(
                reject_remote_privilege_command(command).unwrap_err(),
                REMOTE_PRIVILEGE_DENIED,
                "{command}"
            );
        }
        assert_eq!(
            super::super::effect::classify_command_effect("exec -a ls rm -rf /"),
            crate::agent_runtime::AgentEffectKindNative::Destructive
        );
        assert_eq!(
            super::super::effect::classify_command_effect("env -S 'rm -rf /'"),
            crate::agent_runtime::AgentEffectKindNative::Destructive
        );
    }
}
