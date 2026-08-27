use crate::agent::policy::ValidatedShellCommandV1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovedPosixCommandV1 {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) timeout_seconds: u16,
    pub(crate) rendered_command: String,
}

pub(crate) fn prepare_posix_command_v1(
    validated: ValidatedShellCommandV1,
) -> ApprovedPosixCommandV1 {
    let rendered_command = render_posix_command_v1(&validated.program, &validated.args);
    ApprovedPosixCommandV1 {
        program: validated.program,
        args: validated.args,
        timeout_seconds: validated.timeout_seconds,
        rendered_command,
    }
}

/// The only P1 POSIX renderer. Every word is single-quoted, including the
/// allowlisted executable, and embedded quotes use the portable close/quote/
/// reopen sequence. Policy validation still rejects shell structures before
/// this renderer can be reached.
pub(crate) fn render_posix_command_v1(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quote_posix_word_v1)
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_posix_word_v1(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_single_posix_renderer_quotes_empty_space_unicode_and_single_quotes() {
        assert_eq!(
            render_posix_command_v1(
                "date",
                &[
                    String::new(),
                    "space value".to_string(),
                    "it's".to_string(),
                    "上海🙂".to_string(),
                ],
            ),
            "'date' '' 'space value' 'it'\"'\"'s' '上海🙂'"
        );
    }
}
