use crate::llm::{
    adapter::{ModelAdapter, ModelStreamSink, ReplayCodec},
    config::AiProviderKind,
    errors::{NormalizedModelError, NormalizedModelErrorKind},
    types::{ModelRequest, ModelResponse},
};
use async_trait::async_trait;
use reqwest::header::HeaderMap;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(in crate::llm) const DEFAULT_REMOTE_CONCURRENCY: usize = 4;
pub(in crate::llm) const DEFAULT_LOCAL_CONCURRENCY: usize = 2;
pub(in crate::llm) const MAX_SHARED_COOLDOWN_MS: u64 = 30_000;

/// Per-route concurrency cap and shared cooldown window across parallel turns,
/// subagents, and background title generation targeting the same provider route.
pub(in crate::llm) struct RouteLimiter {
    semaphore: Arc<Semaphore>,
    max_concurrent: usize,
    cooldown_until: Mutex<Option<Instant>>,
    max_cooldown_ms: u64,
}

impl RouteLimiter {
    pub(in crate::llm) fn new(max_concurrent: usize, max_cooldown_ms: u64) -> Self {
        let max_concurrent = max_concurrent.max(1);
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            cooldown_until: Mutex::new(None),
            max_cooldown_ms: max_cooldown_ms.min(MAX_SHARED_COOLDOWN_MS),
        }
    }

    pub(in crate::llm) fn for_route(
        route_id: &str,
        kind: AiProviderKind,
        max_server_delay_ms: u64,
    ) -> Arc<Self> {
        static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<RouteLimiter>>>> = OnceLock::new();
        let max_concurrent = if kind == AiProviderKind::Ollama {
            DEFAULT_LOCAL_CONCURRENCY
        } else {
            DEFAULT_REMOTE_CONCURRENCY
        };
        let cap = max_server_delay_ms.min(MAX_SHARED_COOLDOWN_MS);
        let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
        let mut map = registry.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(existing) = map.get(route_id) {
            if existing.max_concurrent == max_concurrent && existing.max_cooldown_ms == cap {
                return existing.clone();
            }
        }
        let limiter = Arc::new(Self::new(max_concurrent, cap));
        map.insert(route_id.to_string(), limiter.clone());
        limiter
    }

    fn active_cooldown(&self) -> Option<Instant> {
        let now = Instant::now();
        let guard = self
            .cooldown_until
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.filter(|deadline| *deadline > now)
    }

    pub(in crate::llm) fn record_cooldown(&self, delay_ms: u64) {
        if delay_ms == 0 || self.max_cooldown_ms == 0 {
            return;
        }
        let bounded = delay_ms.min(self.max_cooldown_ms);
        let target = Instant::now() + Duration::from_millis(bounded);
        let mut guard = self
            .cooldown_until
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(guard.map_or(target, |existing| existing.max(target)));
    }

    pub(in crate::llm) fn observe_error(&self, error: &NormalizedModelError) {
        if !matches!(
            error.kind,
            NormalizedModelErrorKind::RateLimited | NormalizedModelErrorKind::Retryable
        ) {
            return;
        }
        if let Some(delay_ms) = error.retry_after_ms.filter(|delay| *delay > 0) {
            self.record_cooldown(delay_ms);
        }
    }

    pub(in crate::llm) fn observe_success_headers(&self, headers: &HeaderMap) {
        if let Some(delay_ms) = rate_limit_cooldown_ms(headers, SystemTime::now()) {
            self.record_cooldown(delay_ms);
        }
    }

    pub(in crate::llm) async fn acquire(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit, NormalizedModelError> {
        loop {
            if cancellation.is_cancelled() {
                return Err(NormalizedModelError::cancelled());
            }
            if let Some(deadline) = self.active_cooldown() {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
                    _ = tokio::time::sleep_until(deadline) => continue,
                }
            }
            let permit = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(NormalizedModelError::cancelled()),
                acquired = self.semaphore.clone().acquire_owned() => {
                    acquired.map_err(|_| NormalizedModelError::new(
                        NormalizedModelErrorKind::Terminal,
                        "LLM route limiter is closed",
                    ))?
                }
            };
            // Never hold a concurrency slot while sleeping for a cooldown set by a sibling.
            if self.active_cooldown().is_some() {
                drop(permit);
                continue;
            }
            return Ok(permit);
        }
    }
}

/// Enforces per-route concurrency and shared cooldown around an underlying `ModelAdapter`.
pub(in crate::llm) struct ThrottledModelAdapter {
    inner: Arc<dyn ModelAdapter>,
    limiter: Arc<RouteLimiter>,
}

impl ThrottledModelAdapter {
    pub(in crate::llm) fn new(inner: Arc<dyn ModelAdapter>, limiter: Arc<RouteLimiter>) -> Self {
        Self { inner, limiter }
    }
}

#[async_trait]
impl ModelAdapter for ThrottledModelAdapter {
    fn replay_codec(&self) -> &'static dyn ReplayCodec {
        self.inner.replay_codec()
    }

    fn compaction_model(
        &self,
    ) -> Option<(Arc<dyn ModelAdapter>, crate::llm::config::AiProviderConfig)> {
        self.inner.compaction_model().map(|(adapter, provider)| {
            (
                Arc::new(Self::new(adapter, self.limiter.clone())) as Arc<dyn ModelAdapter>,
                provider,
            )
        })
    }

    async fn stream(
        &self,
        request: ModelRequest,
        cancellation: CancellationToken,
        sink: Arc<dyn ModelStreamSink>,
    ) -> Result<ModelResponse, NormalizedModelError> {
        let _permit = self.limiter.acquire(&cancellation).await?;
        let result = self.inner.stream(request, cancellation, sink).await;
        if let Err(error) = &result {
            self.limiter.observe_error(error);
        }
        result
    }
}

const OPENAI_RATE_LIMIT_HEADERS: [(&str, &str); 2] = [
    (
        "x-ratelimit-remaining-requests",
        "x-ratelimit-reset-requests",
    ),
    ("x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"),
];

const ANTHROPIC_RATE_LIMIT_HEADERS: [(&str, &str); 3] = [
    (
        "anthropic-ratelimit-requests-remaining",
        "anthropic-ratelimit-requests-reset",
    ),
    (
        "anthropic-ratelimit-input-tokens-remaining",
        "anthropic-ratelimit-input-tokens-reset",
    ),
    (
        "anthropic-ratelimit-output-tokens-remaining",
        "anthropic-ratelimit-output-tokens-reset",
    ),
];

/// Returns a cooldown delay when any upstream bucket explicitly reports `0` remaining
/// alongside a valid reset window. Non-exhausted buckets never block requests.
pub(in crate::llm) fn rate_limit_cooldown_ms(headers: &HeaderMap, now: SystemTime) -> Option<u64> {
    let mut max_delay: Option<u64> = None;

    for (remaining_key, reset_key) in OPENAI_RATE_LIMIT_HEADERS {
        if header_is_zero(headers, remaining_key) {
            if let Some(delay) = headers
                .get(reset_key)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_reset_duration_ms)
            {
                max_delay = Some(max_delay.map_or(delay, |current| current.max(delay)));
            }
        }
    }

    for (remaining_key, reset_key) in ANTHROPIC_RATE_LIMIT_HEADERS {
        if header_is_zero(headers, remaining_key) {
            if let Some(delay) = headers
                .get(reset_key)
                .and_then(|value| value.to_str().ok())
                .and_then(|raw| parse_rfc3339_delay_ms(raw, now))
            {
                max_delay = Some(max_delay.map_or(delay, |current| current.max(delay)));
            }
        }
    }

    max_delay
}

fn header_is_zero(headers: &HeaderMap, key: &str) -> bool {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == "0")
}

/// Parses Go-style duration tokens used by OpenAI rate-limit reset headers
/// (e.g. `"500ms"`, `"1.5s"`, `"1m30s"`, `"6m0s"`).
fn parse_reset_duration_ms(raw: &str) -> Option<u64> {
    let input = raw.trim();
    if input.is_empty() || input.starts_with('-') {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = 0;
    let mut total_ms = 0.0_f64;
    let mut parsed_any = false;

    while index < bytes.len() {
        let num_start = index;
        let mut seen_digit = false;
        let mut seen_dot = false;
        while index < bytes.len() {
            let b = bytes[index];
            if b.is_ascii_digit() {
                seen_digit = true;
                index += 1;
            } else if b == b'.' && !seen_dot {
                seen_dot = true;
                index += 1;
            } else {
                break;
            }
        }
        if !seen_digit {
            return None;
        }
        let number: f64 = input[num_start..index].parse().ok()?;
        if !number.is_finite() || number < 0.0 {
            return None;
        }
        let unit_start = index;
        while index < bytes.len() && !bytes[index].is_ascii_digit() {
            index += 1;
        }
        let unit = &input[unit_start..index];
        let factor_ms = match unit {
            "ms" => 1.0,
            "s" => 1_000.0,
            "m" => 60_000.0,
            "h" => 3_600_000.0,
            _ => return None,
        };
        total_ms += number * factor_ms;
        parsed_any = true;
    }

    if !parsed_any || !total_ms.is_finite() {
        return None;
    }
    let rounded = total_ms.round();
    if rounded <= 0.0 || rounded > (u64::MAX as f64) {
        return None;
    }
    Some(rounded as u64)
}

/// Parses an RFC 3339 timestamp (`YYYY-MM-DDTHH:MM:SS(.frac)?(Z|[+-]HH:MM)`)
/// and returns milliseconds remaining until that instant relative to `now`.
fn parse_rfc3339_delay_ms(raw: &str, now: SystemTime) -> Option<u64> {
    let s = raw.trim();
    let b = s.as_bytes();
    if b.len() < 20 {
        return None;
    }
    if b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: u32 = s[5..7].parse().ok()?;
    let day: u32 = s[8..10].parse().ok()?;
    let hour: u32 = s[11..13].parse().ok()?;
    let minute: u32 = s[14..16].parse().ok()?;
    let second: u32 = s[17..19].parse().ok()?;

    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let mut idx = 19;
    let mut subsec_nanos: u32 = 0;
    if idx < b.len() && b[idx] == b'.' {
        idx += 1;
        let frac_start = idx;
        while idx < b.len() && b[idx].is_ascii_digit() {
            idx += 1;
        }
        let frac_len = idx - frac_start;
        if frac_len == 0 {
            return None;
        }
        let take = frac_len.min(9);
        let mut scaled: u32 = s[frac_start..frac_start + take].parse().ok()?;
        for _ in take..9 {
            scaled *= 10;
        }
        subsec_nanos = scaled;
    }

    let tz = &s[idx..];
    let offset_seconds: i64 = if tz.eq_ignore_ascii_case("z") {
        0
    } else if tz.len() == 6 && matches!(tz.as_bytes()[0], b'+' | b'-') && tz.as_bytes()[3] == b':' {
        let sign: i64 = if tz.as_bytes()[0] == b'+' { 1 } else { -1 };
        let tz_hour: i64 = tz[1..3].parse().ok()?;
        let tz_minute: i64 = tz[4..6].parse().ok()?;
        if !(0..=23).contains(&tz_hour) || !(0..=59).contains(&tz_minute) {
            return None;
        }
        sign * (tz_hour * 3_600 + tz_minute * 60)
    } else {
        return None;
    };

    let days = days_from_civil(year, month, day);
    let unix_seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second))?
        .checked_sub(offset_seconds)?;
    if unix_seconds < 0 {
        return None;
    }
    let target = UNIX_EPOCH
        .checked_add(Duration::from_secs(unix_seconds as u64))?
        .checked_add(Duration::from_nanos(u64::from(subsec_nanos)))?;
    let delay = target.duration_since(now).ok()?;
    u64::try_from(delay.as_millis()).ok().filter(|ms| *ms > 0)
}

fn is_leap_year(year: i64) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{
        config::AiProviderConfig,
        registry::replay_codec,
        types::{ModelFinishReason, ModelUsage},
    };
    use reqwest::header::{HeaderName, HeaderValue};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RecordingAdapter {
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        total: Arc<AtomicUsize>,
        delay: Duration,
        next_error: Mutex<Option<NormalizedModelError>>,
        with_compaction: bool,
    }

    impl RecordingAdapter {
        fn new(delay: Duration) -> Self {
            Self {
                active: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
                total: Arc::new(AtomicUsize::new(0)),
                delay,
                next_error: Mutex::new(None),
                with_compaction: false,
            }
        }

        fn with_error(error: NormalizedModelError) -> Self {
            let adapter = Self::new(Duration::ZERO);
            *adapter.next_error.lock().unwrap() = Some(error);
            adapter
        }
    }

    #[async_trait]
    impl ModelAdapter for RecordingAdapter {
        fn replay_codec(&self) -> &'static dyn ReplayCodec {
            replay_codec("chat-completions").unwrap()
        }

        fn compaction_model(&self) -> Option<(Arc<dyn ModelAdapter>, AiProviderConfig)> {
            if !self.with_compaction {
                return None;
            }
            let child = Arc::new(Self {
                active: self.active.clone(),
                peak: self.peak.clone(),
                total: self.total.clone(),
                delay: self.delay,
                next_error: Mutex::new(None),
                with_compaction: false,
            });
            let provider = AiProviderConfig {
                id: "route".into(),
                kind: AiProviderKind::OpenAiCompatible,
                base_url: "https://example.invalid".into(),
                model: "compact".into(),
                requires_api_key: false,
                api_key: None,
                reasoning_effort: None,
                profile: "generic".into(),
                model_definition: None,
                retry_policy: None,
            };
            Some((child, provider))
        }

        async fn stream(
            &self,
            _request: ModelRequest,
            cancellation: CancellationToken,
            _sink: Arc<dyn ModelStreamSink>,
        ) -> Result<ModelResponse, NormalizedModelError> {
            let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(current, Ordering::SeqCst);
            self.total.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        self.active.fetch_sub(1, Ordering::SeqCst);
                        return Err(NormalizedModelError::cancelled());
                    }
                    _ = tokio::time::sleep(self.delay) => {}
                }
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
            if let Some(error) = self.next_error.lock().unwrap().take() {
                return Err(error);
            }
            Ok(ModelResponse {
                content: vec![],
                usage: ModelUsage::default(),
                finish_reason: ModelFinishReason::Stop,
                replay: None,
                replay_envelope: None,
            })
        }
    }

    struct NoopSink;
    impl ModelStreamSink for NoopSink {
        fn emit(&self, _: crate::llm::types::StreamDelta) -> Result<(), NormalizedModelError> {
            Ok(())
        }
    }

    fn dummy_request(id: &str) -> ModelRequest {
        ModelRequest {
            request_id: id.into(),
            surface_generation: 0,
            system_prompt: String::new(),
            messages: vec![],
            tools: vec![],
            tool_choice: Default::default(),
        }
    }

    #[tokio::test]
    async fn route_limiter_caps_concurrent_requests() {
        let inner = Arc::new(RecordingAdapter::new(Duration::from_millis(25)));
        let limiter = Arc::new(RouteLimiter::new(2, MAX_SHARED_COOLDOWN_MS));
        let adapter = Arc::new(ThrottledModelAdapter::new(inner.clone(), limiter));
        let sink: Arc<dyn ModelStreamSink> = Arc::new(NoopSink);

        let mut handles = Vec::new();
        for index in 0..6 {
            let adapter = adapter.clone();
            let sink = sink.clone();
            handles.push(tokio::spawn(async move {
                adapter
                    .stream(
                        dummy_request(&format!("req-{index}")),
                        CancellationToken::new(),
                        sink,
                    )
                    .await
            }));
        }
        for handle in handles {
            assert!(handle.await.unwrap().is_ok());
        }
        assert!(inner.peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(inner.total.load(Ordering::SeqCst), 6);
    }

    #[tokio::test]
    async fn cancellation_while_queued_for_permit_aborts_promptly() {
        let inner = Arc::new(RecordingAdapter::new(Duration::from_millis(120)));
        let limiter = Arc::new(RouteLimiter::new(1, MAX_SHARED_COOLDOWN_MS));
        let adapter = Arc::new(ThrottledModelAdapter::new(inner.clone(), limiter));
        let sink: Arc<dyn ModelStreamSink> = Arc::new(NoopSink);

        let holder = {
            let adapter = adapter.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                adapter
                    .stream(dummy_request("holder"), CancellationToken::new(), sink)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;

        let waiter_cancel = CancellationToken::new();
        let waiter = {
            let adapter = adapter.clone();
            let sink = sink.clone();
            let cancel = waiter_cancel.clone();
            tokio::spawn(async move { adapter.stream(dummy_request("waiter"), cancel, sink).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        waiter_cancel.cancel();

        let error = waiter.await.unwrap().unwrap_err();
        assert_eq!(error.kind, NormalizedModelErrorKind::Cancelled);
        assert!(holder.await.unwrap().is_ok());
        // Permit remains available for subsequent work.
        assert!(adapter
            .stream(dummy_request("after"), CancellationToken::new(), sink)
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn shared_cooldown_blocks_subsequent_calls_and_ignores_terminal_errors() {
        let mut rate_limited =
            NormalizedModelError::new(NormalizedModelErrorKind::RateLimited, "slow down");
        rate_limited.retry_after_ms = Some(2_000);
        let inner = Arc::new(RecordingAdapter::with_error(rate_limited));
        let limiter = Arc::new(RouteLimiter::new(2, MAX_SHARED_COOLDOWN_MS));
        let adapter = Arc::new(ThrottledModelAdapter::new(inner.clone(), limiter.clone()));
        let sink: Arc<dyn ModelStreamSink> = Arc::new(NoopSink);

        let err = adapter
            .stream(
                dummy_request("first"),
                CancellationToken::new(),
                sink.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, NormalizedModelErrorKind::RateLimited);
        assert_eq!(inner.total.load(Ordering::SeqCst), 1);

        let second = {
            let adapter = adapter.clone();
            let sink = sink.clone();
            tokio::spawn(async move {
                adapter
                    .stream(dummy_request("second"), CancellationToken::new(), sink)
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(1_999)).await;
        assert_eq!(
            inner.total.load(Ordering::SeqCst),
            1,
            "second request must wait for shared cooldown"
        );
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(second.await.unwrap().is_ok());
        assert_eq!(inner.total.load(Ordering::SeqCst), 2);

        // Non-throttling Terminal errors must not start a cooldown even with retry_after_ms.
        let mut terminal =
            NormalizedModelError::new(NormalizedModelErrorKind::Terminal, "insufficient_quota");
        terminal.retry_after_ms = Some(5_000);
        limiter.observe_error(&terminal);
        assert!(limiter.active_cooldown().is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_during_cooldown_returns_immediately() {
        let limiter = Arc::new(RouteLimiter::new(2, MAX_SHARED_COOLDOWN_MS));
        limiter.record_cooldown(10_000);
        let cancel = CancellationToken::new();
        let acquire_cancel = cancel.clone();
        let waiter = tokio::spawn(async move { limiter.acquire(&acquire_cancel).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let err = waiter.await.unwrap().unwrap_err();
        assert_eq!(err.kind, NormalizedModelErrorKind::Cancelled);
    }

    #[tokio::test]
    async fn compaction_model_inherits_parent_route_limiter() {
        let mut base = RecordingAdapter::new(Duration::from_millis(30));
        base.with_compaction = true;
        let inner = Arc::new(base);
        let limiter = Arc::new(RouteLimiter::new(1, MAX_SHARED_COOLDOWN_MS));
        let adapter = Arc::new(ThrottledModelAdapter::new(inner.clone(), limiter));
        let (compaction, _) = adapter.compaction_model().expect("compaction model");
        let sink: Arc<dyn ModelStreamSink> = Arc::new(NoopSink);

        let a = tokio::spawn({
            let adapter = adapter.clone();
            let sink = sink.clone();
            async move {
                adapter
                    .stream(dummy_request("parent"), CancellationToken::new(), sink)
                    .await
            }
        });
        let b = tokio::spawn({
            let sink = sink.clone();
            async move {
                compaction
                    .stream(dummy_request("compact"), CancellationToken::new(), sink)
                    .await
            }
        });
        assert!(a.await.unwrap().is_ok());
        assert!(b.await.unwrap().is_ok());
        assert_eq!(inner.peak.load(Ordering::SeqCst), 1);
        assert_eq!(inner.total.load(Ordering::SeqCst), 2);
    }

    fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    #[test]
    fn parses_openai_and_anthropic_rate_limit_headers() {
        let now = UNIX_EPOCH + Duration::from_secs(1_795_159_800); // 2026-11-20T07:30:00Z

        let openai_exhausted = header_map(&[
            ("x-ratelimit-remaining-requests", "0"),
            ("x-ratelimit-reset-requests", "1m30s"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&openai_exhausted, now), Some(90_000));

        let openai_ms = header_map(&[
            ("x-ratelimit-remaining-tokens", "0"),
            ("x-ratelimit-reset-tokens", "500ms"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&openai_ms, now), Some(500));

        let openai_frac = header_map(&[
            ("x-ratelimit-remaining-requests", "0"),
            ("x-ratelimit-reset-requests", "1.5s"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&openai_frac, now), Some(1_500));

        let openai_remaining = header_map(&[
            ("x-ratelimit-remaining-requests", "4"),
            ("x-ratelimit-reset-requests", "10s"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&openai_remaining, now), None);

        let openai_malformed = header_map(&[
            ("x-ratelimit-remaining-requests", "0"),
            ("x-ratelimit-reset-requests", "soon"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&openai_malformed, now), None);

        let anthropic_exhausted = header_map(&[
            ("anthropic-ratelimit-input-tokens-remaining", "0"),
            (
                "anthropic-ratelimit-input-tokens-reset",
                "2026-11-20T07:30:05Z",
            ),
        ]);
        assert_eq!(
            rate_limit_cooldown_ms(&anthropic_exhausted, now),
            Some(5_000)
        );

        let anthropic_offset = header_map(&[
            ("anthropic-ratelimit-requests-remaining", "0"),
            (
                "anthropic-ratelimit-requests-reset",
                "2026-11-20T09:30:04.250+02:00",
            ),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&anthropic_offset, now), Some(4_250));

        let anthropic_past = header_map(&[
            ("anthropic-ratelimit-requests-remaining", "0"),
            ("anthropic-ratelimit-requests-reset", "2026-11-20T07:29:59Z"),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&anthropic_past, now), None);

        let anthropic_remaining = header_map(&[
            ("anthropic-ratelimit-input-tokens-remaining", "1000"),
            (
                "anthropic-ratelimit-input-tokens-reset",
                "2026-11-20T07:30:05Z",
            ),
        ]);
        assert_eq!(rate_limit_cooldown_ms(&anthropic_remaining, now), None);
    }
}
