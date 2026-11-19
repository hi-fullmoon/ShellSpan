use std::io::{self, Read};

fn main() {
    let mut source = String::new();
    io::stdin().take(8193).read_to_string(&mut source).unwrap();
    assert!(source.len() <= 8192);
    let quoted = shlex::try_quote(&source).unwrap();
    println!(
        "{}",
        serde_json::json!({"plan":format!("p0_begin \"$?\"; builtin eval -- {quoted}")})
    );
}
