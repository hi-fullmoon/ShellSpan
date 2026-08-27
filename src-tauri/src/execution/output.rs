use super::redaction::redact_known_secrets;
use super::request::{ExecutionOutputPolicy, ExecutionValidationError};
use super::result::ExecutionErrorCategory;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutputLimitExceeded {
    pub(crate) category: ExecutionErrorCategory,
    pub(crate) total_bytes_read: u64,
    pub(crate) hard_limit_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapturedOutputStream {
    pub(crate) text: String,
    pub(crate) bytes_captured: u64,
    pub(crate) bytes_read: u64,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CollectedExecutionOutput {
    pub(crate) stdout: CapturedOutputStream,
    pub(crate) stderr: CapturedOutputStream,
    pub(crate) total_bytes_read: u64,
}

#[derive(Debug, Clone)]
struct FrontTailCapture {
    capture_limit: usize,
    head_limit: usize,
    tail_limit: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    bytes_read: u64,
}

impl FrontTailCapture {
    fn stdout(capture_limit: usize) -> Self {
        Self::new(capture_limit, 3, 4)
    }

    fn stderr(capture_limit: usize) -> Self {
        Self::new(capture_limit, 1, 2)
    }

    fn new(capture_limit: usize, head_parts: usize, total_parts: usize) -> Self {
        let head_limit = capture_limit.saturating_mul(head_parts) / total_parts;
        let tail_limit = capture_limit - head_limit;
        Self {
            capture_limit,
            head_limit,
            tail_limit,
            head: Vec::with_capacity(head_limit),
            tail: Vec::with_capacity(tail_limit),
            bytes_read: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.bytes_read = self
            .bytes_read
            .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));

        let head_remaining = self.head_limit - self.head.len();
        let head_count = head_remaining.min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_count]);
        self.push_tail(&bytes[head_count..]);
    }

    fn push_tail(&mut self, bytes: &[u8]) {
        if self.tail_limit == 0 || bytes.is_empty() {
            return;
        }
        if bytes.len() >= self.tail_limit {
            self.tail.clear();
            self.tail
                .extend_from_slice(&bytes[bytes.len() - self.tail_limit..]);
            return;
        }
        let excess = self
            .tail
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(self.tail_limit);
        if excess > 0 {
            self.tail.drain(..excess);
        }
        self.tail.extend_from_slice(bytes);
    }

    fn finish(self, secrets: &[String]) -> CapturedOutputStream {
        let truncated = self.bytes_read > self.capture_limit as u64;
        let bytes_captured =
            u64::try_from(self.head.len().saturating_add(self.tail.len())).unwrap_or(u64::MAX);
        let decoded = if truncated {
            let head_end = utf8_prefix_without_incomplete_tail(&self.head);
            let tail_start = self
                .tail
                .iter()
                .position(|byte| !is_utf8_continuation(*byte))
                .unwrap_or(self.tail.len());
            let mut value = String::from_utf8_lossy(&self.head[..head_end]).into_owned();
            value.push_str(&String::from_utf8_lossy(&self.tail[tail_start..]));
            value
        } else {
            let mut bytes = self.head;
            bytes.extend_from_slice(&self.tail);
            String::from_utf8_lossy(&bytes).into_owned()
        };
        CapturedOutputStream {
            text: redact_known_secrets(&decoded, secrets),
            bytes_captured,
            bytes_read: self.bytes_read,
            truncated,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BoundedOutputCollector {
    stdout: FrontTailCapture,
    stderr: FrontTailCapture,
    total_read_hard_limit_bytes: u64,
    total_bytes_read: u64,
    hard_limit_exceeded: bool,
}

impl BoundedOutputCollector {
    pub(crate) fn new(policy: ExecutionOutputPolicy) -> Result<Self, ExecutionValidationError> {
        policy.validate()?;
        Ok(Self {
            stdout: FrontTailCapture::stdout(policy.stdout_capture_bytes),
            stderr: FrontTailCapture::stderr(policy.stderr_capture_bytes),
            total_read_hard_limit_bytes: policy.total_read_hard_limit_bytes as u64,
            total_bytes_read: 0,
            hard_limit_exceeded: false,
        })
    }

    pub(crate) fn push_stdout(&mut self, bytes: &[u8]) -> Result<(), OutputLimitExceeded> {
        self.push(bytes, true)
    }

    pub(crate) fn push_stderr(&mut self, bytes: &[u8]) -> Result<(), OutputLimitExceeded> {
        self.push(bytes, false)
    }

    pub(crate) fn total_bytes_read(&self) -> u64 {
        self.total_bytes_read
    }

    pub(crate) fn hard_limit_exceeded(&self) -> bool {
        self.hard_limit_exceeded
    }

    pub(crate) fn finish(
        self,
        secrets: &[String],
    ) -> Result<CollectedExecutionOutput, OutputLimitExceeded> {
        if self.hard_limit_exceeded {
            return Err(self.limit_error());
        }
        Ok(CollectedExecutionOutput {
            stdout: self.stdout.finish(secrets),
            stderr: self.stderr.finish(secrets),
            total_bytes_read: self.total_bytes_read,
        })
    }

    fn push(&mut self, bytes: &[u8], stdout: bool) -> Result<(), OutputLimitExceeded> {
        if self.hard_limit_exceeded {
            return Err(self.limit_error());
        }
        if stdout {
            self.stdout.push(bytes);
        } else {
            self.stderr.push(bytes);
        }
        self.total_bytes_read = self
            .total_bytes_read
            .saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        if self.total_bytes_read > self.total_read_hard_limit_bytes {
            self.hard_limit_exceeded = true;
            return Err(self.limit_error());
        }
        Ok(())
    }

    fn limit_error(&self) -> OutputLimitExceeded {
        OutputLimitExceeded {
            category: ExecutionErrorCategory::OutputLimitExceeded,
            total_bytes_read: self.total_bytes_read,
            hard_limit_bytes: self.total_read_hard_limit_bytes,
        }
    }
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

fn utf8_prefix_without_incomplete_tail(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let minimum = bytes.len().saturating_sub(4);
    let mut start = bytes.len() - 1;
    while start > minimum && is_utf8_continuation(bytes[start]) {
        start -= 1;
    }
    let expected_width = match bytes[start] {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 1,
    };
    let available = bytes.len() - start;
    if expected_width > available
        && bytes[start + 1..]
            .iter()
            .all(|byte| is_utf8_continuation(*byte))
    {
        start
    } else {
        bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(stdout: usize, stderr: usize, total: usize) -> ExecutionOutputPolicy {
        ExecutionOutputPolicy::new(stdout, stderr, total).expect("valid output policy")
    }

    #[test]
    fn capture_limit_keeps_front_and_tail_while_later_chunks_are_drained() {
        let mut collector = BoundedOutputCollector::new(policy(8, 6, 64)).unwrap();
        collector.push_stdout(b"abcd").unwrap();
        collector.push_stdout(b"efgh").unwrap();
        collector.push_stdout(b"ijkl").unwrap();
        collector.push_stderr(b"123").unwrap();
        collector.push_stderr(b"456").unwrap();
        collector.push_stderr(b"789").unwrap();

        let output = collector.finish(&[]).expect("finish bounded output");
        assert_eq!(output.stdout.text, "abcdefkl");
        assert_eq!(output.stdout.bytes_captured, 8);
        assert_eq!(output.stdout.bytes_read, 12);
        assert!(output.stdout.truncated);
        assert_eq!(output.stderr.text, "123789");
        assert_eq!(output.stderr.bytes_captured, 6);
        assert_eq!(output.stderr.bytes_read, 9);
        assert!(output.stderr.truncated);
        assert_eq!(output.total_bytes_read, 21);
    }

    #[test]
    fn exact_capture_and_total_limits_are_allowed_but_excess_is_sticky() {
        let mut collector = BoundedOutputCollector::new(policy(4, 4, 8)).unwrap();
        collector.push_stdout(b"1234").unwrap();
        collector.push_stderr(b"5678").unwrap();
        assert_eq!(collector.total_bytes_read(), 8);
        assert!(!collector.hard_limit_exceeded());

        let error = collector
            .push_stdout(b"9")
            .expect_err("one byte over the total hard limit fails");
        assert_eq!(error.category, ExecutionErrorCategory::OutputLimitExceeded);
        assert_eq!(error.total_bytes_read, 9);
        assert_eq!(error.hard_limit_bytes, 8);
        assert!(collector.hard_limit_exceeded());
        assert_eq!(
            collector
                .push_stderr(b"ignored")
                .expect_err("hard-limit state remains failed")
                .total_bytes_read,
            9
        );
        assert_eq!(
            collector
                .finish(&[])
                .expect_err("hard-limit output cannot be packaged as completed")
                .category,
            ExecutionErrorCategory::OutputLimitExceeded
        );
    }

    #[test]
    fn invalid_utf8_is_lossy_and_truncation_boundaries_do_not_panic() {
        let mut untruncated = BoundedOutputCollector::new(policy(16, 0, 64)).unwrap();
        untruncated.push_stdout(b"ok\xffdone").unwrap();
        assert_eq!(
            untruncated.finish(&[]).unwrap().stdout.text,
            "ok\u{fffd}done"
        );

        let mut truncated = BoundedOutputCollector::new(policy(9, 0, 64)).unwrap();
        truncated.push_stdout("12345€".as_bytes()).unwrap();
        truncated.push_stdout("--尾".as_bytes()).unwrap();
        let output = truncated.finish(&[]).unwrap().stdout;
        assert!(output.truncated);
        assert!(!output.text.contains('\u{fffd}'));
        assert!(output.text.starts_with("12345"));
        assert!(output.text.ends_with('尾'));
    }

    #[test]
    fn redaction_runs_after_cross_chunk_and_truncated_reassembly() {
        let secrets = vec!["top-secret".to_string(), "secret".to_string()];
        let mut cross_chunk = BoundedOutputCollector::new(policy(32, 0, 64)).unwrap();
        cross_chunk.push_stdout(b"value=top-").unwrap();
        cross_chunk.push_stdout(b"secret").unwrap();
        assert_eq!(
            cross_chunk.finish(&secrets).unwrap().stdout.text,
            "value=[REDACTED]"
        );

        let mut truncated = BoundedOutputCollector::new(policy(12, 0, 64)).unwrap();
        truncated.push_stdout(b"token=sec").unwrap();
        truncated.push_stdout(b"ret-middle-data-ret").unwrap();
        let output = truncated.finish(&secrets).unwrap().stdout;
        assert!(output.truncated);
        assert_eq!(output.text, "token=[REDACTED]");
        assert!(!output.text.contains("secret"));
    }
}
