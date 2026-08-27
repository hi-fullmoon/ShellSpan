use super::orchestrator::{AgentToolOutputStatusV1, AgentToolOutputV1};
use super::protocol::{
    AgentEvidenceSourceV1, AgentEvidenceV1, AgentFinalReportV1, AgentFindingConfidenceV1,
};
use super::redaction::AgentGenericRedactorV1;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_AGENT_OBSERVATION_SUMMARY_CHARACTERS_V1: usize = 1_000;
const MAX_AGENT_STDOUT_EXCERPT_CHARACTERS_V1: usize = 3_000;
const MAX_AGENT_STDERR_EXCERPT_CHARACTERS_V1: usize = 1_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentObservationContentV1 {
    pub(crate) summary: String,
    pub(crate) stdout_excerpt: String,
    pub(crate) stderr_excerpt: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) truncated: bool,
    pub(crate) observation_digest: String,
}

impl AgentObservationContentV1 {
    pub(crate) fn from_tool_output(
        output: &AgentToolOutputV1,
        redactor: &AgentGenericRedactorV1,
    ) -> Self {
        // Redact the complete reassembled value before Agent-level context
        // compression so truncation cannot retain only one side of a secret.
        let redacted_summary = redactor.redact(&output.summary);
        let redacted_stdout = redactor.redact(&output.stdout_excerpt);
        let redacted_stderr = redactor.redact(&output.stderr_excerpt);
        let (summary, summary_truncated) = truncate_characters_v1(
            &redacted_summary,
            MAX_AGENT_OBSERVATION_SUMMARY_CHARACTERS_V1,
        );
        let (stdout_excerpt, stdout_truncated) =
            truncate_characters_v1(&redacted_stdout, MAX_AGENT_STDOUT_EXCERPT_CHARACTERS_V1);
        let (stderr_excerpt, stderr_truncated) =
            truncate_characters_v1(&redacted_stderr, MAX_AGENT_STDERR_EXCERPT_CHARACTERS_V1);
        let truncated =
            output.truncated || summary_truncated || stdout_truncated || stderr_truncated;
        let canonical = serde_json::to_vec(&(
            &summary,
            &stdout_excerpt,
            &stderr_excerpt,
            output.exit_code,
            truncated,
        ))
        .unwrap_or_default();
        let digest = Sha256::digest(canonical);
        let digest_hex = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Self {
            summary,
            stdout_excerpt,
            stderr_excerpt,
            exit_code: output.exit_code,
            truncated,
            observation_digest: format!("sha256-v1:{digest_hex}"),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentObservationFanoutV1 {
    content: Arc<AgentObservationContentV1>,
    pub(crate) evidence: AgentEvidenceV1,
}

impl AgentObservationFanoutV1 {
    pub(crate) fn model_content(&self) -> Arc<AgentObservationContentV1> {
        self.content.clone()
    }

    pub(crate) fn ui_content(&self) -> Arc<AgentObservationContentV1> {
        self.content.clone()
    }

    pub(crate) fn event_content(&self) -> Arc<AgentObservationContentV1> {
        self.content.clone()
    }

    pub(crate) fn evidence_content(&self) -> AgentObservationContentV1 {
        observation_content_from_evidence_v1(&self.evidence)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentEvidenceRecordV1 {
    pub(crate) evidence: AgentEvidenceV1,
    pub(crate) successful: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentEvidenceErrorKindV1 {
    RunMismatch,
    TargetMismatch,
    InvalidSource,
    DuplicateToolCall,
    InvalidReport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentEvidenceErrorV1 {
    pub(crate) kind: AgentEvidenceErrorKindV1,
    pub(crate) message: String,
}

impl AgentEvidenceErrorV1 {
    fn new(kind: AgentEvidenceErrorKindV1, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentEvidenceLedgerV1 {
    run_id: String,
    target_digest: String,
    records: Vec<AgentEvidenceRecordV1>,
    tool_call_ids: HashSet<String>,
}

pub(crate) struct AgentEvidenceCandidateV1<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) target_digest: &'a str,
    pub(crate) source: AgentEvidenceSourceV1,
    pub(crate) tool_call_id: Option<&'a str>,
    pub(crate) output_status: AgentToolOutputStatusV1,
    pub(crate) content: AgentObservationContentV1,
}

impl AgentEvidenceLedgerV1 {
    pub(crate) fn new(run_id: impl Into<String>, target_digest: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            target_digest: target_digest.into(),
            records: Vec::new(),
            tool_call_ids: HashSet::new(),
        }
    }

    pub(crate) fn record(
        &mut self,
        candidate: AgentEvidenceCandidateV1<'_>,
    ) -> Result<AgentObservationFanoutV1, AgentEvidenceErrorV1> {
        if candidate.run_id != self.run_id {
            return Err(AgentEvidenceErrorV1::new(
                AgentEvidenceErrorKindV1::RunMismatch,
                "Evidence belongs to a different Agent run.",
            ));
        }
        if candidate.target_digest != self.target_digest {
            return Err(AgentEvidenceErrorV1::new(
                AgentEvidenceErrorKindV1::TargetMismatch,
                "Evidence belongs to a different frozen target.",
            ));
        }
        match candidate.source {
            AgentEvidenceSourceV1::TerminalSnapshot if candidate.tool_call_id.is_some() => {
                return Err(AgentEvidenceErrorV1::new(
                    AgentEvidenceErrorKindV1::InvalidSource,
                    "Terminal snapshot evidence cannot claim a tool call.",
                ));
            }
            AgentEvidenceSourceV1::HostInspect | AgentEvidenceSourceV1::ShellExecReadOnly
                if candidate.tool_call_id.is_none() =>
            {
                return Err(AgentEvidenceErrorV1::new(
                    AgentEvidenceErrorKindV1::InvalidSource,
                    "Tool evidence must identify its backend-assigned tool call.",
                ));
            }
            _ => {}
        }
        if let Some(tool_call_id) = candidate.tool_call_id {
            if !self.tool_call_ids.insert(tool_call_id.to_string()) {
                return Err(AgentEvidenceErrorV1::new(
                    AgentEvidenceErrorKindV1::DuplicateToolCall,
                    "A tool call can create at most one evidence record.",
                ));
            }
        }

        let evidence_id = format!("{}-evidence-{}", self.run_id, self.records.len() + 1);
        let content = Arc::new(candidate.content);
        let evidence = AgentEvidenceV1 {
            evidence_id,
            run_id: self.run_id.clone(),
            target_digest: self.target_digest.clone(),
            source: candidate.source,
            tool_call_id: candidate.tool_call_id.map(str::to_string),
            observed_at: now_millis_v1(),
            summary: content.summary.clone(),
            stdout_excerpt: (!content.stdout_excerpt.is_empty())
                .then(|| content.stdout_excerpt.clone()),
            stderr_excerpt: (!content.stderr_excerpt.is_empty())
                .then(|| content.stderr_excerpt.clone()),
            exit_code: content.exit_code,
            truncated: content.truncated,
            observation_digest: content.observation_digest.clone(),
        };
        self.records.push(AgentEvidenceRecordV1 {
            evidence: evidence.clone(),
            successful: candidate.output_status == AgentToolOutputStatusV1::Completed,
        });
        Ok(AgentObservationFanoutV1 { content, evidence })
    }

    pub(crate) fn evidence(&self) -> Vec<AgentEvidenceV1> {
        self.records
            .iter()
            .map(|record| record.evidence.clone())
            .collect()
    }

    pub(crate) fn validate_final_report(
        &self,
        report: &AgentFinalReportV1,
        redactor: &AgentGenericRedactorV1,
    ) -> Result<(), AgentEvidenceErrorV1> {
        validate_final_report_v1(
            &self.run_id,
            &self.target_digest,
            &self.records,
            report,
            redactor,
        )
    }
}

pub(crate) fn validate_final_report_v1(
    run_id: &str,
    target_digest: &str,
    records: &[AgentEvidenceRecordV1],
    report: &AgentFinalReportV1,
    redactor: &AgentGenericRedactorV1,
) -> Result<(), AgentEvidenceErrorV1> {
    if !report.changes.is_empty() {
        return Err(invalid_report(
            "P1 final report changes must always be empty.",
        ));
    }
    let serialized = serde_json::to_string(report)
        .map_err(|_| invalid_report("The final report cannot be serialized safely."))?;
    if redactor.redact(&serialized) != serialized {
        return Err(invalid_report(
            "The final report contains a value that must be redacted.",
        ));
    }
    if records
        .iter()
        .any(|record| record.evidence.run_id != run_id)
    {
        return Err(AgentEvidenceErrorV1::new(
            AgentEvidenceErrorKindV1::RunMismatch,
            "The evidence ledger contains an entry owned by another run.",
        ));
    }
    if records
        .iter()
        .any(|record| record.evidence.target_digest != target_digest)
    {
        return Err(AgentEvidenceErrorV1::new(
            AgentEvidenceErrorKindV1::TargetMismatch,
            "The evidence ledger contains an entry for another frozen target.",
        ));
    }

    for finding in &report.findings {
        let mut referenced = HashSet::new();
        let mut matching = Vec::new();
        for evidence_id in &finding.evidence_ids {
            if !referenced.insert(evidence_id) {
                return Err(invalid_report(
                    "A final report finding contains a duplicate evidence reference.",
                ));
            }
            let record = records
                .iter()
                .find(|record| record.evidence.evidence_id == *evidence_id)
                .ok_or_else(|| {
                    invalid_report("A final report finding references unknown evidence.")
                })?;
            matching.push(record);
        }
        if finding.confidence != AgentFindingConfidenceV1::Uncertain && matching.is_empty() {
            return Err(invalid_report(
                "Only uncertain findings may omit evidence references.",
            ));
        }
        if finding.confidence == AgentFindingConfidenceV1::Verified
            && !matching.iter().any(|record| record.successful)
        {
            return Err(invalid_report(
                "Verified findings require at least one successful same-run observation.",
            ));
        }
    }
    Ok(())
}

fn observation_content_from_evidence_v1(evidence: &AgentEvidenceV1) -> AgentObservationContentV1 {
    AgentObservationContentV1 {
        summary: evidence.summary.clone(),
        stdout_excerpt: evidence.stdout_excerpt.clone().unwrap_or_default(),
        stderr_excerpt: evidence.stderr_excerpt.clone().unwrap_or_default(),
        exit_code: evidence.exit_code,
        truncated: evidence.truncated,
        observation_digest: evidence.observation_digest.clone(),
    }
}

fn invalid_report(message: impl Into<String>) -> AgentEvidenceErrorV1 {
    AgentEvidenceErrorV1::new(AgentEvidenceErrorKindV1::InvalidReport, message)
}

fn truncate_characters_v1(value: &str, maximum: usize) -> (String, bool) {
    if value.chars().count() <= maximum {
        return (value.to_string(), false);
    }
    (value.chars().take(maximum).collect(), true)
}

fn now_millis_v1() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::protocol::{
        AgentFinalReportFindingV1, AgentFindingConfidenceV1, AgentReportOutcomeV1,
    };

    fn output(status: AgentToolOutputStatusV1) -> AgentToolOutputV1 {
        AgentToolOutputV1 {
            status,
            summary: "password=hunter2 service is healthy".to_string(),
            stdout_excerpt: "Authorization: Bearer abcdefghijklmnop\nstate=active".to_string(),
            stderr_excerpt: "postgres://user:secret-pass@db/app".to_string(),
            exit_code: (status == AgentToolOutputStatusV1::Completed).then_some(0),
            truncated: false,
        }
    }

    fn report(
        confidence: AgentFindingConfidenceV1,
        evidence_ids: Vec<String>,
    ) -> AgentFinalReportV1 {
        AgentFinalReportV1 {
            outcome: AgentReportOutcomeV1::Diagnosed,
            summary: "The bounded observation supports the finding.".to_string(),
            findings: vec![AgentFinalReportFindingV1 {
                title: "Fixture finding".to_string(),
                detail: "A same-run observation supports this statement.".to_string(),
                confidence,
                evidence_ids,
            }],
            changes: [],
            warnings: Vec::new(),
            next_actions: Vec::new(),
        }
    }

    #[test]
    fn one_redacted_observation_is_the_identical_model_ui_event_and_evidence_source() {
        let redactor = AgentGenericRedactorV1::default();
        let content = AgentObservationContentV1::from_tool_output(
            &output(AgentToolOutputStatusV1::Completed),
            &redactor,
        );
        let mut ledger = AgentEvidenceLedgerV1::new("run-1", "target-1");
        let fanout = ledger
            .record(AgentEvidenceCandidateV1 {
                run_id: "run-1",
                target_digest: "target-1",
                source: AgentEvidenceSourceV1::ShellExecReadOnly,
                tool_call_id: Some("run-1-tool-1"),
                output_status: AgentToolOutputStatusV1::Completed,
                content,
            })
            .unwrap();
        assert!(Arc::ptr_eq(&fanout.model_content(), &fanout.ui_content()));
        assert!(Arc::ptr_eq(&fanout.ui_content(), &fanout.event_content()));
        assert_eq!(*fanout.model_content(), fanout.evidence_content());
        let serialized = serde_json::to_string(&*fanout.model_content()).unwrap();
        assert!(!serialized.contains("hunter2"));
        assert!(!serialized.contains("abcdefghijklmnop"));
        assert!(!serialized.contains("secret-pass"));
    }

    #[test]
    fn ledger_rejects_other_run_target_and_duplicate_tool_ownership() {
        let redactor = AgentGenericRedactorV1::default();
        let content = || {
            AgentObservationContentV1::from_tool_output(
                &output(AgentToolOutputStatusV1::Completed),
                &redactor,
            )
        };
        let mut ledger = AgentEvidenceLedgerV1::new("run-1", "target-1");
        assert_eq!(
            ledger
                .record(AgentEvidenceCandidateV1 {
                    run_id: "run-2",
                    target_digest: "target-1",
                    source: AgentEvidenceSourceV1::HostInspect,
                    tool_call_id: Some("tool-1"),
                    output_status: AgentToolOutputStatusV1::Completed,
                    content: content(),
                })
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV1::RunMismatch
        );
        assert_eq!(
            ledger
                .record(AgentEvidenceCandidateV1 {
                    run_id: "run-1",
                    target_digest: "target-2",
                    source: AgentEvidenceSourceV1::HostInspect,
                    tool_call_id: Some("tool-1"),
                    output_status: AgentToolOutputStatusV1::Completed,
                    content: content(),
                })
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV1::TargetMismatch
        );
        ledger
            .record(AgentEvidenceCandidateV1 {
                run_id: "run-1",
                target_digest: "target-1",
                source: AgentEvidenceSourceV1::HostInspect,
                tool_call_id: Some("tool-1"),
                output_status: AgentToolOutputStatusV1::Completed,
                content: content(),
            })
            .unwrap();
        assert_eq!(
            ledger
                .record(AgentEvidenceCandidateV1 {
                    run_id: "run-1",
                    target_digest: "target-1",
                    source: AgentEvidenceSourceV1::HostInspect,
                    tool_call_id: Some("tool-1"),
                    output_status: AgentToolOutputStatusV1::Completed,
                    content: content(),
                })
                .unwrap_err()
                .kind,
            AgentEvidenceErrorKindV1::DuplicateToolCall
        );
    }

    #[test]
    fn final_validator_rejects_foreign_ownership_failed_verified_and_secret_text() {
        let redactor = AgentGenericRedactorV1::default();
        let successful_evidence = AgentEvidenceV1 {
            evidence_id: "run-2-evidence-1".to_string(),
            run_id: "run-2".to_string(),
            target_digest: "target-1".to_string(),
            source: AgentEvidenceSourceV1::HostInspect,
            tool_call_id: Some("run-2-tool-1".to_string()),
            observed_at: 1,
            summary: "ok".to_string(),
            stdout_excerpt: None,
            stderr_excerpt: None,
            exit_code: Some(0),
            truncated: false,
            observation_digest: "sha256-v1:fixture".to_string(),
        };
        let foreign_run = vec![AgentEvidenceRecordV1 {
            evidence: successful_evidence.clone(),
            successful: true,
        }];
        assert_eq!(
            validate_final_report_v1(
                "run-1",
                "target-1",
                &foreign_run,
                &report(
                    AgentFindingConfidenceV1::Verified,
                    vec![successful_evidence.evidence_id.clone()]
                ),
                &redactor,
            )
            .unwrap_err()
            .kind,
            AgentEvidenceErrorKindV1::RunMismatch
        );

        let mut foreign_target_record = foreign_run[0].clone();
        foreign_target_record.evidence.run_id = "run-1".to_string();
        foreign_target_record.evidence.target_digest = "target-2".to_string();
        assert_eq!(
            validate_final_report_v1(
                "run-1",
                "target-1",
                &[foreign_target_record],
                &report(AgentFindingConfidenceV1::Uncertain, Vec::new()),
                &redactor,
            )
            .unwrap_err()
            .kind,
            AgentEvidenceErrorKindV1::TargetMismatch
        );

        let mut ledger = AgentEvidenceLedgerV1::new("run-1", "target-1");
        let fanout = ledger
            .record(AgentEvidenceCandidateV1 {
                run_id: "run-1",
                target_digest: "target-1",
                source: AgentEvidenceSourceV1::ShellExecReadOnly,
                tool_call_id: Some("run-1-tool-1"),
                output_status: AgentToolOutputStatusV1::Failed,
                content: AgentObservationContentV1::from_tool_output(
                    &output(AgentToolOutputStatusV1::Failed),
                    &redactor,
                ),
            })
            .unwrap();
        assert!(ledger
            .validate_final_report(
                &report(
                    AgentFindingConfidenceV1::Verified,
                    vec![fanout.evidence.evidence_id]
                ),
                &redactor,
            )
            .is_err());

        let mut secret_report = report(AgentFindingConfidenceV1::Uncertain, Vec::new());
        secret_report.summary = "password=hunter2".to_string();
        assert!(ledger
            .validate_final_report(&secret_report, &redactor)
            .is_err());
    }

    #[test]
    fn likely_requires_evidence_uncertain_may_be_explicitly_unverified_and_changes_are_unrepresentable(
    ) {
        let ledger = AgentEvidenceLedgerV1::new("run-1", "target-1");
        let redactor = AgentGenericRedactorV1::default();
        assert!(ledger
            .validate_final_report(
                &report(AgentFindingConfidenceV1::Likely, Vec::new()),
                &redactor,
            )
            .is_err());
        let uncertain = report(AgentFindingConfidenceV1::Uncertain, Vec::new());
        assert!(uncertain.changes.is_empty());
        assert!(ledger.validate_final_report(&uncertain, &redactor).is_ok());
    }
}
