//! Canonicalize explicit diagnostic environments without reading ambient variables.
pub fn canonicalize(block: &[u16]) -> Result<Vec<u16>, String> {
    // Diagnostic budget, not a claim about the OS maximum.
    if block.len() > 32768 || !block.ends_with(&[0, 0]) {
        return Err("fixed environment budget or terminator invalid".into());
    }
    let text = String::from_utf16(&block[..block.len() - 2])
        .map_err(|_| "fixed environment UTF-16 invalid")?;
    if text.is_empty() {
        return Err("fixed environment must contain explicit entries".into());
    }
    let mut entries = Vec::new();
    for entry in text.split('\0') {
        let (name, _) = entry
            .split_once('=')
            .ok_or("fixed environment entry invalid")?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || name.as_bytes()[0].is_ascii_digit()
        {
            return Err("fixed environment name invalid".into());
        }
        entries.push((name.to_ascii_uppercase(), entry));
    }
    entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
    if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err("fixed environment duplicate name".into());
    }
    let mut output = Vec::with_capacity(block.len());
    for (_, entry) in entries {
        output.extend(entry.encode_utf16());
        output.push(0);
    }
    output.push(0);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sorts_names_without_changing_unicode_values_or_empty_values() {
        let raw: Vec<_> = "WINDIR=C:\\Windows\0home=中文😀=value\0EMPTY=\0\0"
            .encode_utf16()
            .collect();
        let sorted = canonicalize(&raw).unwrap();
        assert_eq!(
            String::from_utf16(&sorted).unwrap(),
            "EMPTY=\0home=中文😀=value\0WINDIR=C:\\Windows\0\0"
        );
        assert_eq!(canonicalize(&sorted).unwrap(), sorted);
    }
    #[test]
    fn rejects_ambiguous_names_truncated_blocks_and_budget_overflow() {
        for text in [
            "HOME=x\0home=y\0\0",
            "A=x\0\0B=y\0\0",
            "=C:=x\0\0",
            "中文=x\0\0",
            "A=x\0",
            "\0\0",
            "1A=x\0\0",
        ] {
            assert!(canonicalize(&text.encode_utf16().collect::<Vec<_>>()).is_err());
        }
        assert!(canonicalize(&[b'A' as u16, b'=' as u16, 0xd800, 0, 0]).is_err());
        let oversized = format!("A={}\0\0", "x".repeat(32768));
        assert!(canonicalize(&oversized.encode_utf16().collect::<Vec<_>>()).is_err());
    }
}
