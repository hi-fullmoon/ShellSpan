pub(crate) fn strip_ansi(value: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Ground,
        Escape,
        Csi,
        Osc,
        OscEscape,
    }

    let mut state = State::Ground;
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        state = match state {
            State::Ground if character == '\u{1b}' => State::Escape,
            State::Ground => {
                output.push(character);
                State::Ground
            }
            State::Escape if character == '[' => State::Csi,
            State::Escape if character == ']' => State::Osc,
            State::Escape => State::Ground,
            State::Csi if ('@'..='~').contains(&character) => State::Ground,
            State::Csi => State::Csi,
            State::Osc if character == '\u{7}' => State::Ground,
            State::Osc if character == '\u{1b}' => State::OscEscape,
            State::Osc => State::Osc,
            State::OscEscape if character == '\\' => State::Ground,
            State::OscEscape if character == '\u{1b}' => State::OscEscape,
            State::OscEscape => State::Osc,
        };
    }
    output
}

pub(crate) fn strip_shell_control_osc(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b']' {
            let body_start = index + 2;
            let mut cursor = body_start;
            let mut end_index = None;
            while cursor < bytes.len() {
                if bytes[cursor] == 0x07 {
                    end_index = Some(cursor + 1);
                    break;
                }
                if bytes[cursor] == 0x1b && cursor + 1 < bytes.len() && bytes[cursor + 1] == b'\\' {
                    end_index = Some(cursor + 2);
                    break;
                }
                cursor += 1;
            }
            if let Some(seq_end) = end_index {
                let body = &bytes[body_start..cursor];
                let code_end = body
                    .iter()
                    .position(|byte| *byte == b';')
                    .unwrap_or(body.len());
                let code = &body[..code_end];
                if matches!(code, b"0" | b"1" | b"2" | b"7" | b"133" | b"1337") {
                    index = seq_end;
                    continue;
                }
                output.push_str(&value[index..seq_end]);
                index = seq_end;
                continue;
            }
        }
        let ch = value[index..].chars().next().expect("valid utf-8 char");
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{strip_ansi, strip_shell_control_osc};

    #[test]
    fn removes_csi_and_osc_sequences_without_changing_plain_text() {
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}body"), "body");
    }

    #[test]
    fn strips_shell_control_osc_while_preserving_program_controls() {
        assert_eq!(
            strip_shell_control_osc("== .log files ==\n\u{1b}]0;root@host:~\u{7}"),
            "== .log files ==\n"
        );
        assert_eq!(
            strip_shell_control_osc(
                "\u{1b}[31mred\u{1b}[0m\u{1b}]133;D;0;ShellSpan=3\u{7}\u{1b}]2;title\u{1b}\\\u{1b}]1337;ShellSpanCapture=tok\u{7}"
            ),
            "\u{1b}[31mred\u{1b}[0m"
        );
        assert_eq!(
            strip_shell_control_osc("\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7}"),
            "\u{1b}]8;;https://example.com\u{7}link\u{1b}]8;;\u{7}"
        );
    }
}
